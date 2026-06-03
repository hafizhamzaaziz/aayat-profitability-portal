import { NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { collectAdsSync } from "@/lib/amazon/ads/ingest";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * Poll + download + ingest outstanding Amazon Ads report jobs.
 *
 * Two callers:
 *   - The UI auto-polls POST /api/amazon/ads/collect { accountId } every few
 *     seconds after starting a sync, scoped to that account. Requires an
 *     admin/team portal session.
 *   - A Vercel cron hits GET /api/amazon/ads/collect (no accountId) to drain
 *     any pending jobs globally. Authenticated via the CRON_SECRET bearer
 *     token that Vercel injects, so it doesn't need a portal session.
 *
 * Idempotent and safe to call repeatedly — only advances 'requested' jobs.
 */
async function runForAccount(accountId: string) {
  const admin = createAdminClient();
  return collectAdsSync({ supabase: admin, accountId });
}

export async function POST(request: NextRequest) {
  const userClient = createClient();
  const { data: { user } } = await userClient.auth.getUser();
  if (!user) return Response.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  const { data: userRow } = await userClient.from("users").select("role").eq("id", user.id).single();
  const role = String(userRow?.role || "client");
  if (role !== "admin" && role !== "team") {
    return Response.json({ ok: false, error: "Forbidden" }, { status: 403 });
  }

  let body: { accountId?: string };
  try {
    body = (await request.json()) as { accountId?: string };
  } catch {
    return Response.json({ ok: false, error: "Invalid JSON body" }, { status: 400 });
  }
  const accountId = String(body.accountId || "").trim();
  if (!accountId) return Response.json({ ok: false, error: "Missing accountId" }, { status: 400 });

  try {
    const result = await runForAccount(accountId);
    return Response.json(result);
  } catch (err) {
    return Response.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 502 }
    );
  }
}

/**
 * Cron entry point. Vercel cron requests carry
 * `Authorization: Bearer ${CRON_SECRET}`. If CRON_SECRET isn't set we still
 * allow the call (no secret configured = best-effort), but log a warning.
 */
export async function GET(request: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret) {
    const auth = request.headers.get("authorization");
    if (auth !== `Bearer ${cronSecret}`) {
      return Response.json({ ok: false, error: "Unauthorized" }, { status: 401 });
    }
  }

  const admin = createAdminClient();
  try {
    // Drain the oldest pending jobs across all accounts/batches. One cron
    // tick processes up to maxToProcess reports; the next tick continues.
    const result = await collectAdsSync({ supabase: admin, maxToProcess: 40 });
    return Response.json(result);
  } catch (err) {
    return Response.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 502 }
    );
  }
}
