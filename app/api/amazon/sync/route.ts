import { NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { syncAmazonFinanceData } from "@/lib/amazon/ingest/orchestrate";
import { SpApiError } from "@/lib/amazon/spapi";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Amazon Finance API + multi-month ingestion can take a while on the first
// 90-day backfill (multiple paginated calls + ~600ms throttle between pages).
// Use the Pro plan max so we don't time out on real seller datasets.
export const maxDuration = 300;

type SyncBody = {
  accountId?: string;
  from?: string; // YYYY-MM-DD
  to?: string;   // YYYY-MM-DD
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
 * POST /api/amazon/sync
 *   body: { accountId, from?, to? }
 *
 * Pulls Amazon SP-API financial events for the given window and folds them
 * into one `reports` row per calendar month (tagged source='sp_api'). Existing
 * manual + sp_api reports for the same period coexist; the orchestrator only
 * touches sp_api rows.
 *
 * Admin/team only. Uses an admin Supabase client for writes so RLS policies
 * don't block the orchestrator's bulk insert/upsert traffic.
 */
export async function POST(request: NextRequest) {
  // ---- Auth ----
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

  // ---- Body ----
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

  // ---- Load account settings (vat_rate, cogs_vat_reclaim_pct) ----
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

  // ---- Run the orchestrator ----
  try {
    const result = await syncAmazonFinanceData({
      supabase: admin,
      accountId,
      vatRatePct,
      cogsVatReclaimPct,
      options: { from, to },
    });
    return Response.json(result);
  } catch (err) {
    const message =
      err instanceof SpApiError
        ? `SP-API ${err.status}: ${err.message} :: ${err.body.slice(0, 500)}`
        : err instanceof Error
        ? err.message
        : String(err);
    return Response.json({ ok: false, error: message }, { status: 502 });
  }
}
