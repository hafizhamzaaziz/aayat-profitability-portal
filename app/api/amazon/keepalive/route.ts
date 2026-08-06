import { NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { loadSpApiClient, updateMarketplaceIds, updateSyncStatus } from "@/lib/amazon/credentials";
import { SpApiError } from "@/lib/amazon/spapi";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

/**
 * SP-API developer-account keep-alive.
 *
 * Amazon baselines Selling Partner API access keys every 90 days: any developer
 * account that makes no successful SP-API call in that window has its keys
 * deleted and must re-apply (see AUP §3.5). The portal's only cron hits the
 * *Ads* API, which is a different service and does NOT reset this clock, so the
 * developer account silently drifts toward deactivation.
 *
 * This endpoint makes the cheapest possible real SP-API call
 * (getMarketplaceParticipations) for every connected account, which is enough
 * to count as a "successful API call" and keep the developer account alive.
 * It's idempotent and best-effort: one failing account never blocks the others.
 *
 * Callers:
 *   - Vercel cron: GET /api/amazon/keepalive (weekly), authed via CRON_SECRET.
 *   - Admins/team can also trigger it manually from a portal session.
 */
async function pingAllConnectedAccounts() {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("account_amazon_credentials")
    .select("account_id")
    .eq("provider", "sp-api")
    .not("refresh_token_encrypted", "is", null);

  if (error) {
    throw new Error(`Failed to list Amazon SP-API connections: ${error.message}`);
  }

  const accountIds = Array.from(
    new Set((data || []).map((r) => String(r.account_id)).filter(Boolean)),
  );

  const results: Array<{ accountId: string; ok: boolean; marketplaces?: number; error?: string }> = [];
  for (const accountId of accountIds) {
    try {
      const { client } = await loadSpApiClient(accountId);
      const parts = await client.getMarketplaceParticipations();
      const active = (parts.payload || [])
        .filter((p) => p.participation.isParticipating)
        .map((p) => p.marketplace.id);
      if (active.length > 0) {
        await updateMarketplaceIds(accountId, active).catch(() => {});
      }
      await updateSyncStatus(accountId, { ok: true }).catch(() => {});
      results.push({ accountId, ok: true, marketplaces: active.length });
    } catch (err) {
      const message =
        err instanceof SpApiError
          ? `${err.status}: ${err.message}`
          : err instanceof Error
          ? err.message
          : String(err);
      await updateSyncStatus(accountId, { ok: false, error: message }).catch(() => {});
      results.push({ accountId, ok: false, error: message });
    }
  }

  return {
    ok: results.some((r) => r.ok),
    checked: results.length,
    succeeded: results.filter((r) => r.ok).length,
    failed: results.filter((r) => !r.ok).length,
    results,
  };
}

export async function GET(request: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret) {
    const auth = request.headers.get("authorization");
    if (auth !== `Bearer ${cronSecret}`) {
      return Response.json({ ok: false, error: "Unauthorized" }, { status: 401 });
    }
  }

  try {
    const result = await pingAllConnectedAccounts();
    return Response.json(result);
  } catch (err) {
    return Response.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 502 },
    );
  }
}

export async function POST() {
  const userClient = createClient();
  const {
    data: { user },
  } = await userClient.auth.getUser();
  if (!user) return Response.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  const { data: userRow } = await userClient.from("users").select("role").eq("id", user.id).single();
  const role = String(userRow?.role || "client");
  if (role !== "admin" && role !== "team") {
    return Response.json({ ok: false, error: "Forbidden" }, { status: 403 });
  }

  try {
    const result = await pingAllConnectedAccounts();
    return Response.json(result);
  } catch (err) {
    return Response.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 502 },
    );
  }
}
