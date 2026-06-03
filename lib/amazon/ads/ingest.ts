/**
 * Amazon Ads-API → ad_meta / ad_spend ingestion orchestrator.
 *
 * Flow per sync:
 *   1. For each profile (one per country/marketplace) the account has access to:
 *        a. Request a Sponsored Products "Advertised Product" report for
 *           [from, to] (daily granularity, SKU column).
 *        b. Poll until COMPLETED, download the gzipped JSON, parse rows.
 *   2. Aggregate rows by calendar month + SKU → { month: { sku: spendExvat } }.
 *   3. For each (account, month) bucket:
 *        a. Find OR create the matching `reports` row (preferring source='sp_api'
 *           if one exists, else 'manual', else create a new minimal 'sp_api' shell
 *           that the next sync will fill in).
 *        b. Replace `report_ad_meta` + `report_ad_spend` for that report.
 *        c. Trigger a server-side recompute (computeAmazonPnl + applyAdReportOverride
 *           + computePerSku) so the report's net_profit, breakdown.advertising and
 *           per-SKU rows reflect the new ads data immediately — no manual
 *           "recompute" click needed.
 *
 * Coexistence: when both a manual ad CSV and an Ads-API sync exist for the
 * same month, Ads-API wins (it's more granular and always up-to-date). The
 * `report_ad_meta.source_filename` is set to "amazon-ads-api:{startDate}…
 * {endDate}" so the UI can show the provenance.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { loadAdsApiClient, updateAdsSyncStatus } from "./credentials";
import type { SpAdvertisedProductRow } from "./client";
import { buildBridgedCogsLookup } from "@/lib/reports/cogs-lookup";
import {
  computeAmazonPnl,
  applyAdReportOverride,
  deriveTotals,
} from "@/lib/reports/amazon-pnl";
import { computePerSku } from "@/lib/reports/per-sku";
import { adReportFromRows } from "@/lib/reports/ad-report";
import {
  computeExpenseOccurrencesForPeriod,
  type ExpenseLedgerRow,
} from "@/lib/reports/expense-ledger";
import { computeExpenseTotals } from "@/lib/reports/expense-totals";
import { AMAZON_METHODOLOGY_ID } from "@/lib/reports/methodology";
import type { SkuLine } from "@/lib/reports/types";

export type AdsSyncOptions = {
  from: string; // YYYY-MM-DD inclusive
  to: string;   // YYYY-MM-DD inclusive
  /**
   * Optional: limit the sync to specific profile country codes (e.g. ["GB"]).
   * Defaults to every profile the credential has.
   */
  countryCodes?: string[];
};

export type AdsSyncReportResult = {
  reportId: string;
  periodStart: string;
  periodEnd: string;
  reportCreated: boolean;
  skuCount: number;
  totalSpendExvat: number;
};

const AD_INSERT_CHUNK = 400;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function normalizeSku(value: unknown): string {
  return String(value ?? "")
    .replace(/\u00a0/g, " ")
    .trim()
    .toLowerCase();
}

function monthBucket(dateIso: string): { key: string; start: string; end: string } {
  const [y, m] = dateIso.split("-");
  const year = Number(y);
  const month = Number(m);
  const start = `${y}-${m}-01`;
  const lastDate = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const end = `${y}-${m}-${String(lastDate).padStart(2, "0")}`;
  return { key: `${y}-${m}`, start, end };
}

/**
 * Split [fromIso, toIso] into windows no longer than `maxDays` calendar days.
 * The Ads Reports v3 API rejects any single report request whose date range
 * exceeds 31 days, so a 90-day backfill must be requested as 3+ chunks and
 * the downloaded rows merged. Windows are inclusive on both ends and never
 * overlap (each chunk starts the day after the previous chunk ends).
 */
function chunkDateRange(fromIso: string, toIso: string, maxDays = 31): Array<[string, string]> {
  const chunks: Array<[string, string]> = [];
  const dayMs = 24 * 60 * 60 * 1000;
  let cursor = new Date(`${fromIso}T00:00:00Z`).getTime();
  const end = new Date(`${toIso}T00:00:00Z`).getTime();
  if (Number.isNaN(cursor) || Number.isNaN(end) || cursor > end) return chunks;
  while (cursor <= end) {
    // -1 because the window is inclusive: a 31-day window spans the start day
    // plus 30 more days.
    const chunkEnd = Math.min(cursor + (maxDays - 1) * dayMs, end);
    chunks.push([
      new Date(cursor).toISOString().slice(0, 10),
      new Date(chunkEnd).toISOString().slice(0, 10),
    ]);
    cursor = chunkEnd + dayMs;
  }
  return chunks;
}

type MonthlySpend = {
  start: string;
  end: string;
  spendBySku: Record<string, number>;
  blankSkuSpend: number;
  totalSpend: number;
};

// ---------------------------------------------------------------------------
// Per-bucket ingest
// ---------------------------------------------------------------------------

async function findOrCreateReport(
  supabase: SupabaseClient,
  accountId: string,
  bucketStart: string,
  bucketEnd: string
): Promise<{ id: string; account_id: string; created: boolean }> {
  // Prefer an existing report — sp_api first (most authoritative), then any.
  const { data: existing, error } = await supabase
    .from("reports")
    .select("id, account_id, source")
    .eq("account_id", accountId)
    .eq("platform", "amazon")
    .eq("period_start", bucketStart)
    .eq("period_end", bucketEnd);
  if (error) throw error;

  if (existing && existing.length > 0) {
    const sorted = [...existing].sort((a, b) => {
      const aw = a.source === "sp_api" ? 0 : a.source === "manual" ? 1 : 2;
      const bw = b.source === "sp_api" ? 0 : b.source === "manual" ? 1 : 2;
      return aw - bw;
    });
    return { id: sorted[0].id as string, account_id: sorted[0].account_id as string, created: false };
  }

  // No report yet — create a minimal sp_api shell. The next Finance sync
  // (or a manual upload) will overwrite the figures; for now the report
  // exists only to hang ad data off.
  const minimalPayload = {
    account_id: accountId,
    period_start: bucketStart,
    period_end: bucketEnd,
    platform: "amazon" as const,
    source: "sp_api" as const,
    gross_sales: 0,
    total_cogs: 0,
    total_fees: 0,
    output_vat: 0,
    input_vat: 0,
    net_profit: 0,
    breakdown: {
      summary: [],
      vat: { outputVat: 0, inputVatFees: 0, inputVatPurchases: 0, finalVat: 0 },
      sourceMeta: { source: "ads-api-shell", createdAt: new Date().toISOString() },
    },
    cogs_vat_reclaim_pct: 0,
    updated_at: new Date().toISOString(),
  };
  const { data: inserted, error: insertError } = await supabase
    .from("reports")
    .insert(minimalPayload)
    .select("id, account_id")
    .single();
  if (insertError) throw insertError;
  return { id: inserted.id as string, account_id: inserted.account_id as string, created: true };
}

async function replaceAdData(
  supabase: SupabaseClient,
  reportId: string,
  accountId: string,
  bucket: MonthlySpend,
  sourceFilename: string,
  matchedSkuSet: Set<string>
): Promise<{ matched: number; unmatched: number }> {
  await supabase.from("report_ad_meta").delete().eq("report_id", reportId);
  await supabase.from("report_ad_spend").delete().eq("report_id", reportId);

  let matched = 0;
  let unmatched = 0;
  const payload: Array<{
    report_id: string;
    account_id: string;
    sku: string | null;
    spend_exvat: number;
    matched: boolean;
    source_kind: string;
  }> = [];

  for (const [sku, spend] of Object.entries(bucket.spendBySku)) {
    const isMatch = matchedSkuSet.has(sku);
    if (isMatch) matched += 1;
    else unmatched += 1;
    payload.push({
      report_id: reportId,
      account_id: accountId,
      sku,
      spend_exvat: Number(spend.toFixed(2)),
      matched: isMatch,
      source_kind: "amazon_sku",
    });
  }
  if (bucket.blankSkuSpend > 0) {
    payload.push({
      report_id: reportId,
      account_id: accountId,
      sku: null,
      spend_exvat: Number(bucket.blankSkuSpend.toFixed(2)),
      matched: false,
      source_kind: "amazon_sku",
    });
  }

  await supabase.from("report_ad_meta").insert({
    report_id: reportId,
    account_id: accountId,
    source_filename: sourceFilename,
    total_spend_exvat: Number(bucket.totalSpend.toFixed(2)),
    blank_sku_spend: Number(bucket.blankSkuSpend.toFixed(2)),
    matched_sku_count: matched,
    unmatched_sku_count: unmatched,
  });

  for (let i = 0; i < payload.length; i += AD_INSERT_CHUNK) {
    const chunk = payload.slice(i, i + AD_INSERT_CHUNK);
    if (chunk.length) {
      const { error } = await supabase.from("report_ad_spend").insert(chunk);
      if (error) throw error;
    }
  }

  return { matched, unmatched };
}

/**
 * Re-run the full P&L pipeline for a report after ads data changes, so the
 * stored totals (`reports.net_profit`, `breakdown.summary[advertising]`)
 * and per-SKU rows stay in sync with the new ad spend.
 *
 * If the report has no transactions yet (newly-created shell), this is a
 * no-op — the report's existing totals stay at zero until a Finance sync
 * fills them in.
 */
async function recomputeReportTotals(
  supabase: SupabaseClient,
  reportId: string,
  accountId: string,
  bucketStart: string,
  bucketEnd: string,
  vatRatePct: number,
  cogsVatReclaimPct: number
): Promise<void> {
  // 1. Pull raw transactions and rebuild a CSV-style AoA (matches what the
  //    manual recompute flow does in saved-reports-panel.tsx).
  const { data: txRows } = await supabase
    .from("report_transactions")
    .select("raw_row")
    .eq("report_id", reportId);
  if (!txRows || txRows.length === 0) return;

  type RawRow = Record<string, unknown>;
  const raw: RawRow[] = (txRows || [])
    .map((t) => (t.raw_row || {}) as RawRow)
    .filter((r) => Object.keys(r).length > 0);
  if (raw.length === 0) return;

  // Sniff the column order: use whatever columns are present on the first
  // row plus any extra columns from later rows. Maintains insertion order
  // which matches the order computeAmazonPnl expects.
  const colOrder: string[] = [];
  const seen = new Set<string>();
  for (const row of raw) {
    for (const k of Object.keys(row)) {
      if (!seen.has(k)) {
        seen.add(k);
        colOrder.push(k);
      }
    }
  }
  const aoa: unknown[][] = [colOrder, ...raw.map((r) => colOrder.map((c) => r[c] ?? ""))];

  // 2. Load ads data we just persisted, rebuild an AdReport.
  const { data: adSpendRows } = await supabase
    .from("report_ad_spend")
    .select("sku, spend_exvat")
    .eq("report_id", reportId);
  const adReport = adReportFromRows({
    rows: (adSpendRows || []).map((r) => ({
      sku: (r.sku as string | null) || null,
      spend_exvat: Number(r.spend_exvat || 0),
    })),
    sourceFilename: `amazon-ads-api:${bucketStart}..${bucketEnd}`,
  });

  // 3. COGS lookup. (effective-date filtering is applied inside derive/perSku
  // via defaultDateIso; the lookup itself returns the full history.)
  const cogsLookup = await buildBridgedCogsLookup(supabase, accountId);

  // 4. Reuse the same engine: compute PnL → apply ad override → derive totals → per-SKU.
  const pnl = computeAmazonPnl(aoa);
  if (pnl.rowsProcessed === 0) {
    return; // Transactions present but no usable rows — leave as-is.
  }
  applyAdReportOverride(pnl, adReport.totalSpend, vatRatePct);

  // 5. External expenses occurring inside this period (mirrors the SP-API
  //    orchestrator's approach so reports stay reconciliation-consistent
  //    regardless of which sync path produced them).
  let expensesNet = 0;
  let expensesVat = 0;
  const { data: expenseRows } = await supabase
    .from("expense_ledger")
    .select(
      "id, account_id, description, expense_date, amount, includes_vat, marketplace, expense_type, recurring_end_date"
    )
    .eq("account_id", accountId)
    .lte("expense_date", bucketEnd)
    .or(`recurring_end_date.is.null,recurring_end_date.gte.${bucketStart}`);
  const occurrences = computeExpenseOccurrencesForPeriod({
    rows: (expenseRows || []) as ExpenseLedgerRow[],
    platform: "amazon",
    periodStart: bucketStart,
    periodEnd: bucketEnd,
  });
  if (occurrences.length > 0) {
    const e = computeExpenseTotals(
      occurrences.map((o) => ({ amount: Number(o.amount || 0), includes_vat: Boolean(o.includes_vat) })),
      vatRatePct
    );
    expensesNet = e.net;
    expensesVat = e.vat;
  }

  const totals = deriveTotals({
    pnl,
    cogsLookup,
    vatRatePct,
    defaultDateIso: bucketStart,
    cogsVatReclaimPct,
  });

  // 6. Per-SKU rows.
  const { lines: skuLines } = computePerSku({
    pnl,
    cogsLookup,
    vatRatePct,
    defaultDateIso: bucketStart,
    adReport,
  });

  // 7. Recompute headline numbers (mirrors orchestrate.ts ingestMonth).
  const settlementNet = totals.netSales + totals.fbaReimbursements + totals.totalAmazonFeesExvat;
  const purchaseCost = -totals.cogs;
  const outputVat = totals.outputVatPayableToHmrc;
  const inputVatFees = totals.totalInputVatAmazonFees;
  const inputVatPurchases = totals.inputVatCogs + expensesVat;
  const inputVat = inputVatFees + inputVatPurchases;
  const netProfit = settlementNet - purchaseCost - expensesNet;
  const settlementValue = settlementNet + outputVat - inputVatFees;
  const totalFeesAbs =
    Math.abs(totals.sellingFeesExvat) +
    Math.abs(totals.fbaFeesExvat) +
    Math.abs(totals.otherTxFeesExvat) +
    Math.abs(totals.fbaInventoryFeesExvat) +
    Math.abs(totals.deliveryServicesExvat) +
    Math.abs(totals.subscriptionExvat) +
    Math.abs(totals.advertisingExvat);

  // Pull existing breakdown so we don't blow away unrelated fields.
  const { data: existingReport } = await supabase
    .from("reports")
    .select("breakdown")
    .eq("id", reportId)
    .single();
  const existingBreakdown = (existingReport?.breakdown || {}) as Record<string, unknown>;
  const breakdown = {
    ...existingBreakdown,
    pnl: {
      settlementNet: Number(settlementNet.toFixed(2)),
      purchaseCost: Number(purchaseCost.toFixed(2)),
      netProfit: Number(netProfit.toFixed(2)),
    },
    vat: {
      outputVat: Number(outputVat.toFixed(2)),
      inputVatFees: Number(inputVatFees.toFixed(2)),
      inputVatPurchases: Number(inputVatPurchases.toFixed(2)),
      finalVat: Number((outputVat - inputVat).toFixed(2)),
    },
    methodologyId: AMAZON_METHODOLOGY_ID,
    adSource: {
      kind: "ads-api",
      syncedAt: new Date().toISOString(),
      windowStart: bucketStart,
      windowEnd: bucketEnd,
      totalSpendExvat: Number(adReport.totalSpend.toFixed(2)),
    },
  };

  await supabase
    .from("reports")
    .update({
      gross_sales: Number(settlementValue.toFixed(2)),
      total_cogs: Number(purchaseCost.toFixed(2)),
      total_fees: Number(totalFeesAbs.toFixed(2)),
      output_vat: Number(outputVat.toFixed(2)),
      input_vat: Number(inputVat.toFixed(2)),
      net_profit: Number(netProfit.toFixed(2)),
      breakdown,
      updated_at: new Date().toISOString(),
    })
    .eq("id", reportId);

  // Per-SKU rows.
  await supabase.from("report_sku_breakdowns").delete().eq("report_id", reportId);
  const skuPayload = skuLines.map((line: SkuLine) => ({
    report_id: reportId,
    account_id: accountId,
    sku: line.sku,
    description: line.description || null,
    units: line.units,
    refund_units: line.refundUnits,
    product_sales: line.productSales,
    postage_credits: line.postageCredits,
    promo_rebates: line.promoRebates,
    net_sales: line.netSales,
    cogs: line.cogs,
    selling_fees_exvat: line.sellingFeesExvat,
    fba_fees_exvat: line.fbaFeesExvat,
    other_tx_fees_exvat: line.otherTxFeesExvat,
    delivery_services_exvat: line.deliveryServicesExvat,
    advertising_alloc: line.advertisingAlloc,
    fba_inventory_alloc: line.fbaInventoryAlloc,
    subscription_alloc: line.subscriptionAlloc,
    deal_fees_alloc: line.dealFeesAlloc,
    fba_reimbursements: line.fbaReimbursements,
    output_vat:
      line.outputVatProduct + line.outputVatShipping + line.outputVatGiftwrap + line.outputVatPromo,
    marketplace_withheld_vat: line.marketplaceWithheldVat,
    retrocharge_vat: line.retrochargeVat,
    net_profit: line.netProfit,
    cost_known: line.costKnown,
    ad_only: line.adOnly,
  }));
  for (let i = 0; i < skuPayload.length; i += AD_INSERT_CHUNK) {
    const chunk = skuPayload.slice(i, i + AD_INSERT_CHUNK);
    if (chunk.length) {
      const { error: skuError } = await supabase.from("report_sku_breakdowns").insert(chunk);
      if (skuError) throw skuError;
    }
  }
}

// ---------------------------------------------------------------------------
// Async job model
//
// Ads Reports v3 generation is asynchronous and slow, and Amazon throttles
// concurrent generation — submitting ~27 reports at once leaves most queued
// for minutes, so no single function invocation can poll them all to
// completion. We therefore split the work:
//
//   startAdsSync     — request a report per (profile, <=31-day window) and
//                      persist one ads_report_jobs row per report. Fast.
//   collectAdsSync   — poll each 'requested' job's report; download + per-job
//                      aggregate completed ones; mark 'completed'/'failed'.
//                      Called repeatedly (UI auto-poll + cron). When a batch
//                      has no 'requested' jobs left, finalize it.
//   finalizeAdsSync  — merge all completed jobs' aggregates by month and fold
//                      them into report_ad_meta / report_ad_spend, recompute.
// ---------------------------------------------------------------------------

type JobAggregate = Record<
  string, // month key "YYYY-MM"
  { start: string; end: string; spendBySku: Record<string, number>; blankSkuSpend: number; totalSpend: number }
>;

export type StartAdsSyncResult = {
  ok: true;
  batchId: string;
  jobsRequested: number;
  range: { from: string; to: string };
  warnings: string[];
};

/**
 * Phase 1: request all reports and persist them as jobs. Returns quickly so
 * the request never risks the function timeout. Collection happens later.
 */
export async function startAdsSync(input: {
  supabase: SupabaseClient;
  accountId: string;
  vatRatePct: number;
  cogsVatReclaimPct: number;
  options: AdsSyncOptions;
}): Promise<StartAdsSyncResult> {
  const { supabase, accountId, vatRatePct, cogsVatReclaimPct, options } = input;
  const warnings: string[] = [];

  let client;
  let profileIds: Record<string, number>;
  try {
    const loaded = await loadAdsApiClient(accountId);
    client = loaded.client;
    profileIds = loaded.profileIds;
  } catch (err) {
    await updateAdsSyncStatus(accountId, {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }

  if (Object.keys(profileIds).length === 0) {
    throw new Error(
      "No Ads profiles selected for this account. Run a smoke test from the Edit Account modal to auto-discover profiles."
    );
  }

  const wantedCountries =
    options.countryCodes && options.countryCodes.length > 0
      ? new Set(options.countryCodes.map((c) => c.toUpperCase()))
      : null;

  const windows = chunkDateRange(options.from, options.to, 31);
  const batchId =
    typeof globalThis.crypto !== "undefined" && "randomUUID" in globalThis.crypto
      ? globalThis.crypto.randomUUID()
      : `${accountId}-${Date.now()}`;

  const jobRows: Array<Record<string, unknown>> = [];
  for (const [countryCode, profileId] of Object.entries(profileIds)) {
    if (wantedCountries && !wantedCountries.has(countryCode.toUpperCase())) continue;
    for (const [startDate, endDate] of windows) {
      try {
        const { reportId } = await client.requestSpAdvertisedProductReport({
          profileId,
          startDate,
          endDate,
        });
        jobRows.push({
          account_id: accountId,
          batch_id: batchId,
          profile_id: String(profileId),
          country_code: countryCode,
          start_date: startDate,
          end_date: endDate,
          amazon_report_id: reportId,
          status: "requested",
          vat_rate_pct: vatRatePct,
          cogs_vat_reclaim_pct: cogsVatReclaimPct,
        });
      } catch (err) {
        // A request can be rejected (e.g. transient 425 duplicate / throttle).
        // Record it as a failed job so the batch accounting stays correct.
        jobRows.push({
          account_id: accountId,
          batch_id: batchId,
          profile_id: String(profileId),
          country_code: countryCode,
          start_date: startDate,
          end_date: endDate,
          amazon_report_id: null,
          status: "failed",
          error: err instanceof Error ? err.message : String(err),
          vat_rate_pct: vatRatePct,
          cogs_vat_reclaim_pct: cogsVatReclaimPct,
        });
        warnings.push(
          `Profile ${countryCode} (${profileId}) ${startDate}..${endDate} request failed: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }
  }

  if (jobRows.length > 0) {
    const { error: insErr } = await supabase.from("ads_report_jobs").insert(jobRows);
    if (insErr) throw insErr;
  }

  const requested = jobRows.filter((j) => j.status === "requested").length;
  return {
    ok: true,
    batchId,
    jobsRequested: requested,
    range: { from: options.from, to: options.to },
    warnings,
  };
}

export type CollectAdsSyncResult = {
  ok: true;
  batchId: string | null;
  pending: number;
  completed: number;
  failed: number;
  finalized: boolean;
  reports: AdsSyncReportResult[];
  warnings: string[];
};

/**
 * Aggregate one downloaded report's rows by (month, SKU). Stored on the job
 * row as jsonb so finalize can merge across jobs without re-downloading.
 */
function aggregateRowsToJson(rows: SpAdvertisedProductRow[]): JobAggregate {
  const out: JobAggregate = {};
  for (const r of rows) {
    if (!r.date) continue;
    const bucket = monthBucket(r.date);
    if (!out[bucket.key]) {
      out[bucket.key] = { start: bucket.start, end: bucket.end, spendBySku: {}, blankSkuSpend: 0, totalSpend: 0 };
    }
    const entry = out[bucket.key];
    const cost = Number(r.cost) || 0;
    if (cost === 0) continue;
    entry.totalSpend += cost;
    const skuKey = normalizeSku(r.advertisedSku);
    if (!skuKey) entry.blankSkuSpend += cost;
    else entry.spendBySku[skuKey] = (entry.spendBySku[skuKey] || 0) + cost;
  }
  return out;
}

/**
 * Phase 2: poll outstanding jobs, download completed reports, and once a batch
 * is fully resolved, finalize it. Designed to be called repeatedly and to stay
 * well within the function budget by capping how many reports it polls/downloads
 * per invocation.
 *
 * @param accountId  optional — restrict to one account (UI auto-poll). When
 *                   omitted (cron), processes the oldest pending jobs globally.
 */
export async function collectAdsSync(input: {
  supabase: SupabaseClient;
  accountId?: string;
  maxToProcess?: number;
}): Promise<CollectAdsSyncResult> {
  const { supabase, accountId } = input;
  const maxToProcess = input.maxToProcess ?? 30;
  const warnings: string[] = [];

  // Grab outstanding 'requested' jobs (optionally scoped to one account).
  let query = supabase
    .from("ads_report_jobs")
    .select("*")
    .eq("status", "requested")
    .order("requested_at", { ascending: true })
    .limit(maxToProcess);
  if (accountId) query = query.eq("account_id", accountId);
  const { data: jobs, error } = await query;
  if (error) throw error;

  const batchId = accountId
    ? (jobs && jobs[0]?.batch_id) || null
    : (jobs && jobs[0]?.batch_id) || null;

  let completed = 0;
  let failed = 0;

  // Poll + download each job. We need a client per account; cache by account.
  const clientCache = new Map<string, Awaited<ReturnType<typeof loadAdsApiClient>>["client"]>();
  const getClient = async (acct: string) => {
    if (!clientCache.has(acct)) {
      const loaded = await loadAdsApiClient(acct);
      clientCache.set(acct, loaded.client);
    }
    return clientCache.get(acct)!;
  };

  await Promise.all(
    (jobs || []).map(async (job) => {
      try {
        const client = await getClient(job.account_id as string);
        const status = await client.getReport(Number(job.profile_id), job.amazon_report_id as string);
        if (status.status === "COMPLETED" && status.url) {
          const rows = await client.downloadReport(status.url);
          const aggregate = aggregateRowsToJson(rows);
          await supabase
            .from("ads_report_jobs")
            .update({
              status: "completed",
              rows_downloaded: rows.length,
              aggregate,
              error: null,
              updated_at: new Date().toISOString(),
            })
            .eq("id", job.id);
          completed += 1;
        } else if (status.status === "FAILURE") {
          await supabase
            .from("ads_report_jobs")
            .update({
              status: "failed",
              error: status.failureReason || "Amazon reported FAILURE",
              updated_at: new Date().toISOString(),
            })
            .eq("id", job.id);
          failed += 1;
          warnings.push(`${job.country_code} ${job.start_date}..${job.end_date}: ${status.failureReason || "report failed"}`);
        }
        // else PENDING/PROCESSING — leave as 'requested' for the next poll.
      } catch (err) {
        warnings.push(
          `${job.country_code} ${job.start_date}..${job.end_date}: poll error ${err instanceof Error ? err.message : String(err)}`
        );
      }
    })
  );

  // Finalize every batch that now has no 'requested' jobs left but still has
  // 'completed' (not-yet-ingested) jobs. We look across all batches touched —
  // critical for the cron path, which can process jobs from several batches in
  // one tick.
  const { data: completedJobs } = await supabase
    .from("ads_report_jobs")
    .select("batch_id")
    .eq("status", "completed");
  const candidateBatches = Array.from(
    new Set(((completedJobs || []) as Array<{ batch_id: string }>).map((j) => j.batch_id))
  );

  let finalized = false;
  let reports: AdsSyncReportResult[] = [];
  for (const candidate of candidateBatches) {
    const { count: pendingInBatch } = await supabase
      .from("ads_report_jobs")
      .select("id", { count: "exact", head: true })
      .eq("batch_id", candidate)
      .eq("status", "requested");
    if ((pendingInBatch ?? 0) === 0) {
      const result = await finalizeAdsSync({ supabase, batchId: candidate });
      finalized = true;
      reports = reports.concat(result.reports);
      warnings.push(...result.warnings);
    }
  }

  // Pending count for the polling scope (so the UI knows when to stop).
  let pendingQuery = supabase
    .from("ads_report_jobs")
    .select("id", { count: "exact", head: true })
    .eq("status", "requested");
  if (accountId) pendingQuery = pendingQuery.eq("account_id", accountId);
  else if (batchId) pendingQuery = pendingQuery.eq("batch_id", batchId);
  const { count: stillPending } = await pendingQuery;

  return {
    ok: true,
    batchId,
    pending: stillPending ?? 0,
    completed,
    failed,
    finalized,
    reports,
    warnings,
  };
}

/**
 * Phase 3: merge all 'completed' jobs in a batch by month and fold the spend
 * into report_ad_meta / report_ad_spend, recomputing each affected report.
 * Marks the batch's jobs 'ingested' so it isn't reprocessed.
 */
export async function finalizeAdsSync(input: {
  supabase: SupabaseClient;
  batchId: string;
}): Promise<{ reports: AdsSyncReportResult[]; warnings: string[] }> {
  const { supabase, batchId } = input;
  const warnings: string[] = [];

  const { data: jobs, error } = await supabase
    .from("ads_report_jobs")
    .select("*")
    .eq("batch_id", batchId)
    .eq("status", "completed");
  if (error) throw error;
  if (!jobs || jobs.length === 0) {
    return { reports: [], warnings: ["No completed jobs to finalize."] };
  }

  const accountId = jobs[0].account_id as string;
  const vatRatePct = Number(jobs[0].vat_rate_pct ?? 20);
  const cogsVatReclaimPct = Number(jobs[0].cogs_vat_reclaim_pct ?? 100);

  // Merge all jobs' per-month aggregates into one map.
  const merged = new Map<string, MonthlySpend>();
  for (const job of jobs) {
    const agg = (job.aggregate || {}) as JobAggregate;
    for (const [key, m] of Object.entries(agg)) {
      if (!merged.has(key)) {
        merged.set(key, { start: m.start, end: m.end, spendBySku: {}, blankSkuSpend: 0, totalSpend: 0 });
      }
      const target = merged.get(key)!;
      target.totalSpend += m.totalSpend;
      target.blankSkuSpend += m.blankSkuSpend;
      for (const [sku, spend] of Object.entries(m.spendBySku)) {
        target.spendBySku[sku] = (target.spendBySku[sku] || 0) + spend;
      }
    }
  }

  const reports: AdsSyncReportResult[] = [];
  for (const [, bucket] of merged) {
    const report = await findOrCreateReport(supabase, accountId, bucket.start, bucket.end);

    const { data: skuRows } = await supabase
      .from("report_sku_breakdowns")
      .select("sku")
      .eq("report_id", report.id);
    const matchedSkuSet = new Set<string>((skuRows || []).map((r) => normalizeSku(r.sku)));

    const sourceFilename = `amazon-ads-api:${bucket.start}..${bucket.end}`;
    const { unmatched } = await replaceAdData(
      supabase,
      report.id,
      accountId,
      bucket,
      sourceFilename,
      matchedSkuSet
    );

    try {
      await recomputeReportTotals(
        supabase,
        report.id,
        accountId,
        bucket.start,
        bucket.end,
        vatRatePct,
        cogsVatReclaimPct
      );
    } catch (err) {
      warnings.push(
        `Report ${bucket.start}..${bucket.end} ads saved but recompute failed: ${err instanceof Error ? err.message : String(err)}`
      );
    }

    reports.push({
      reportId: report.id,
      periodStart: bucket.start,
      periodEnd: bucket.end,
      reportCreated: report.created,
      skuCount: Object.keys(bucket.spendBySku).length,
      totalSpendExvat: Number(bucket.totalSpend.toFixed(2)),
    });

    if (unmatched > 0) {
      warnings.push(
        `${bucket.start} → ${bucket.end}: ${unmatched} SKU(s) had ad spend but no matching sale — check SKU mapping.`
      );
    }
  }

  // Mark all this batch's jobs ingested so it isn't reprocessed.
  await supabase
    .from("ads_report_jobs")
    .update({ status: "ingested", updated_at: new Date().toISOString() })
    .eq("batch_id", batchId)
    .eq("status", "completed");

  await updateAdsSyncStatus(accountId, { ok: true });
  return { reports, warnings };
}
