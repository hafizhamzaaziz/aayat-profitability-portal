import { NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { syncAmazonFinanceData } from "@/lib/amazon/ingest/orchestrate";
import { expandToCoveredMonths, nextFinanceWindow } from "@/lib/amazon/ingest/sync-window";
import { SpApiError } from "@/lib/amazon/spapi";
import { todayIsoUtc } from "@/lib/utils/date";

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
  const today = todayIsoUtc();
  const past = new Date(`${today}T00:00:00Z`);
  past.setUTCDate(past.getUTCDate() - 90);
  const from = past.toISOString().slice(0, 10);
  return { from, to: today };
}

async function latestSpApiSaleDate(admin: ReturnType<typeof createAdminClient>, accountId: string) {
  const { data, error } = await admin
    .from("report_transactions")
    .select("transaction_date")
    .eq("account_id", accountId)
    .eq("source", "sp_api")
    .not("transaction_date", "is", null)
    .order("transaction_date", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) return null;
  const value = data?.transaction_date ? String(data.transaction_date).slice(0, 10) : null;
  return value && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null;
}

async function runFinanceSync(input: {
  accountId: string;
  from: string;
  to: string;
}) {
  const admin = createAdminClient();
  const { data: account, error: acctError } = await admin
    .from("accounts")
    .select("id, name, vat_rate, cogs_vat_reclaim_pct")
    .eq("id", input.accountId)
    .single();
  if (acctError || !account) {
    return { status: 404 as const, body: { ok: false as const, error: "Account not found" } };
  }

  const vatRatePct = Number(account.vat_rate ?? 20);
  const cogsVatReclaimPct = Number(account.cogs_vat_reclaim_pct ?? 100);

  try {
    const result = await syncAmazonFinanceData({
      supabase: admin,
      accountId: input.accountId,
      vatRatePct,
      cogsVatReclaimPct,
      options: { from: input.from, to: input.to },
    });
    return { status: 200 as const, body: result };
  } catch (err) {
    const message =
      err instanceof SpApiError
        ? `SP-API ${err.status}: ${err.message} :: ${err.body.slice(0, 500)}`
        : err instanceof Error
        ? err.message
        : String(err);
    return { status: 502 as const, body: { ok: false as const, error: message } };
  }
}

/**
 * POST /api/amazon/sync
 *   body: { accountId, from?, to? }
 *
 * Pulls Amazon SP-API financial events for the given window and folds them
 * into one `reports` row per calendar month (tagged source='sp_api'). Existing
 * manual + sp_api reports for the same period coexist; the orchestrator only
 * touches sp_api rows. The requested range is expanded to covering calendar
 * months so a short window cannot blank out the rest of a month.
 *
 * Admin/team only. Uses an admin Supabase client for writes so RLS policies
 * don't block the orchestrator's bulk insert/upsert traffic.
 */
export async function POST(request: NextRequest) {
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

  let body: SyncBody;
  try {
    body = (await request.json()) as SyncBody;
  } catch {
    return Response.json({ ok: false, error: "Invalid JSON body" }, { status: 400 });
  }
  const accountId = String(body.accountId || "").trim();
  if (!accountId) return Response.json({ ok: false, error: "Missing accountId" }, { status: 400 });

  const today = todayIsoUtc();
  const defaults = defaultRange();
  const rawFrom = toIsoDate(body.from) || defaults.from;
  const rawTo = toIsoDate(body.to) || defaults.to;
  if (rawFrom > rawTo) return Response.json({ ok: false, error: "from must be on or before to" }, { status: 400 });
  const range = expandToCoveredMonths(rawFrom, rawTo, today);

  const result = await runFinanceSync({ accountId, from: range.from, to: range.to });
  return Response.json(result.body, { status: result.status });
}

/**
 * GET /api/amazon/sync
 *
 * Daily cron: incremental Finance ingest for every connected SP-API account.
 * Walks one calendar month per account per tick (oldest cursor first) so a
 * 300s budget can catch accounts up from a stuck May/June watermark without
 * timing out. Authenticated via CRON_SECRET, same as ads collect / keepalive.
 */
export async function GET(request: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret) {
    const auth = request.headers.get("authorization");
    if (auth !== `Bearer ${cronSecret}`) {
      return Response.json({ ok: false, error: "Unauthorized" }, { status: 401 });
    }
  }

  const today = todayIsoUtc();
  const currentMonthStart = today.slice(0, 8) + "01";
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("account_amazon_credentials")
    .select("account_id, finance_synced_through, last_synced_at")
    .eq("provider", "sp-api")
    .not("refresh_token_encrypted", "is", null);

  if (error) {
    return Response.json({ ok: false, error: error.message }, { status: 502 });
  }

  const accounts = (data || [])
    .map((row) => ({
      accountId: String(row.account_id),
      financeSyncedThrough: row.finance_synced_through
        ? String(row.finance_synced_through).slice(0, 10)
        : null,
    }))
    .filter((row) => row.accountId);

  const results: Array<{
    accountId: string;
    ok: boolean;
    from?: string;
    to?: string;
    totalRows?: number;
    error?: string;
  }> = [];

  const resolved: Array<{
    accountId: string;
    financeSyncedThrough: string | null;
    through: string | null;
    priority: number;
  }> = [];
  for (const account of accounts) {
    const through = account.financeSyncedThrough || (await latestSpApiSaleDate(admin, account.accountId));
    const priority = through && through < currentMonthStart ? 0 : through ? 2 : 1;
    resolved.push({ ...account, through, priority });
  }
  resolved.sort((a, b) => {
    if (a.priority !== b.priority) return a.priority - b.priority;
    const aThrough = a.through || "0000-01-01";
    const bThrough = b.through || "0000-01-01";
    if (aThrough !== bThrough) return aThrough.localeCompare(bThrough);
    return a.accountId.localeCompare(b.accountId);
  });

  // Two months across accounts keeps us inside the 300s budget while still
  // walking stuck sellers (Rexo / AE Linen) forward every day.
  const maxWindows = 2;
  let processed = 0;

  for (const account of resolved) {
    if (processed >= maxWindows) break;
    const window = nextFinanceWindow({ through: account.through, today });
    if (!window) continue;

    const result = await runFinanceSync({
      accountId: account.accountId,
      from: window.from,
      to: window.to,
    });
    processed += 1;
    if (result.body.ok === true) {
      results.push({
        accountId: account.accountId,
        ok: true,
        from: window.from,
        to: window.to,
        totalRows: result.body.totalRows,
      });
    } else {
      results.push({
        accountId: account.accountId,
        ok: false,
        from: window.from,
        to: window.to,
        error: result.body.error,
      });
    }
  }

  return Response.json({
    ok: results.length === 0 || results.some((r) => r.ok),
    today,
    checked: accounts.length,
    processed,
    results,
  });
}
