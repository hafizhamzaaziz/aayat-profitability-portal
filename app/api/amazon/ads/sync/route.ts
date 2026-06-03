import { NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { startAdsSync } from "@/lib/amazon/ads/ingest";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Ads reports take 30–90s per profile to generate + download. Allow up to
// 5 minutes so a multi-marketplace sync over 90 days has headroom.
export const maxDuration = 300;

type SyncBody = {
  accountId?: string;
  from?: string;
  to?: string;
  countryCodes?: string[]; // optional: limit to specific marketplaces
};

function toIsoDate(value: unknown): string | null {
  if (typeof value !== "string") return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  return value;
}

function defaultRange(): { from: string; to: string } {
  const today = new Date();
  const to = today.toISOString().slice(0, 10);
  const past = new Date(today.getTime() - 90 * 24 * 60 * 60 * 1000);
  const from = past.toISOString().slice(0, 10);
  return { from, to };
}

/**
 * POST /api/amazon/ads/sync
 *   body: { accountId, from?, to?, countryCodes? }
 *
 * Pulls Amazon Ads-API Sponsored Products spend for the given window and
 * folds it into per-month report_ad_spend rows. Existing manually-uploaded
 * Ads CSV data is REPLACED for any month an API sync produces data for.
 *
 * Admin/team only.
 */
export async function POST(request: NextRequest) {
  const userClient = createClient();
  const { data: { user } } = await userClient.auth.getUser();
  if (!user) return Response.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  const { data: userRow } = await userClient.from("users").select("role").eq("id", user.id).single();
  const role = String(userRow?.role || "client");
  if (role !== "admin" && role !== "team") {
    return Response.json({ ok: false, error: "Forbidden" }, { status: 403 });
  }

  let body: SyncBody;
  try {
    body = (await request.json()) as SyncBody;
  } catch {
    return Response.json({ ok: false, error: "Invalid JSON body" }, { status: 400 });
  }
  const accountId = String(body.accountId || "").trim();
  if (!accountId) return Response.json({ ok: false, error: "Missing accountId" }, { status: 400 });

  const defaults = defaultRange();
  const from = toIsoDate(body.from) || defaults.from;
  const to = toIsoDate(body.to) || defaults.to;
  if (from > to) return Response.json({ ok: false, error: "from must be on or before to" }, { status: 400 });

  const admin = createAdminClient();
  const { data: account, error: acctError } = await admin
    .from("accounts")
    .select("id, name, vat_rate, cogs_vat_reclaim_pct")
    .eq("id", accountId)
    .single();
  if (acctError || !account) {
    return Response.json({ ok: false, error: "Account not found" }, { status: 404 });
  }

  const vatRatePct = Number(account.vat_rate ?? 20);
  const cogsVatReclaimPct = Number(account.cogs_vat_reclaim_pct ?? 100);

  try {
    // Requests the reports and persists them as jobs — returns fast. The
    // /api/amazon/ads/collect endpoint (auto-polled by the UI + a cron)
    // downloads and ingests them as Amazon finishes generating each one.
    const result = await startAdsSync({
      supabase: admin,
      accountId,
      vatRatePct,
      cogsVatReclaimPct,
      options: {
        from,
        to,
        countryCodes: Array.isArray(body.countryCodes) ? body.countryCodes : undefined,
      },
    });
    return Response.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return Response.json({ ok: false, error: message }, { status: 502 });
  }
}
