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

export type AdsSyncResult = {
  ok: true;
  range: { from: string; to: string };
  profilesSynced: Array<{
    profileId: number;
    countryCode: string;
    rowsDownloaded: number;
  }>;
  reports: AdsSyncReportResult[];
  warnings: string[];
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

/**
 * Bucket the raw Ads API rows into months, summing spend per (month, SKU).
 * SKUs are lower-cased to align with the per-SKU breakdown table.
 */
function aggregateRows(rows: SpAdvertisedProductRow[]): Map<string, MonthlySpend> {
  const out = new Map<string, MonthlySpend>();
  for (const r of rows) {
    if (!r.date) continue;
    const bucket = monthBucket(r.date);
    if (!out.has(bucket.key)) {
      out.set(bucket.key, {
        start: bucket.start,
        end: bucket.end,
        spendBySku: {},
        blankSkuSpend: 0,
        totalSpend: 0,
      });
    }
    const entry = out.get(bucket.key)!;
    const cost = Number(r.cost) || 0;
    if (cost === 0) continue;
    entry.totalSpend += cost;
    const skuKey = normalizeSku(r.advertisedSku);
    if (!skuKey) {
      entry.blankSkuSpend += cost;
    } else {
      entry.spendBySku[skuKey] = (entry.spendBySku[skuKey] || 0) + cost;
    }
  }
  return out;
}

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
// Top-level entry point
// ---------------------------------------------------------------------------

export async function syncAmazonAdsData(input: {
  supabase: SupabaseClient;
  accountId: string;
  vatRatePct: number;
  cogsVatReclaimPct: number;
  options: AdsSyncOptions;
}): Promise<AdsSyncResult> {
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

  const wantedCountries = options.countryCodes && options.countryCodes.length > 0
    ? new Set(options.countryCodes.map((c) => c.toUpperCase()))
    : null;

  // 1. Pull rows from every relevant profile. The Ads Reports v3 API caps
  //    each report request at 31 days, so split the requested window into
  //    ≤31-day chunks. With up to 9 profiles × 3 chunks = 27 reports, polling
  //    each one sequentially (30–90s of server-side generation apiece) would
  //    blow past the 300s function budget. So we use two phases:
  //      Phase A — fire off every report request (fast POSTs); Amazon
  //                generates them concurrently on their side.
  //      Phase B — poll + download them all in parallel.
  const windows = chunkDateRange(options.from, options.to, 31);
  const allRows: SpAdvertisedProductRow[] = [];
  const profilesSynced: AdsSyncResult["profilesSynced"] = [];

  type PendingReport = {
    profileId: number;
    countryCode: string;
    startDate: string;
    endDate: string;
    reportId: string;
  };

  // Phase A — request all reports.
  const pending: PendingReport[] = [];
  const rowsByProfile = new Map<string, number>();
  for (const [countryCode, profileId] of Object.entries(profileIds)) {
    if (wantedCountries && !wantedCountries.has(countryCode.toUpperCase())) continue;
    rowsByProfile.set(countryCode, 0);
    for (const [startDate, endDate] of windows) {
      try {
        const { reportId } = await client.requestSpAdvertisedProductReport({
          profileId,
          startDate,
          endDate,
        });
        pending.push({ profileId, countryCode, startDate, endDate, reportId });
      } catch (err) {
        warnings.push(
          `Profile ${countryCode} (${profileId}) ${startDate}..${endDate} request failed: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }
  }

  // Phase B — poll + download every pending report in parallel.
  await Promise.all(
    pending.map(async (p) => {
      try {
        const url = await client.waitForReport(p.profileId, p.reportId);
        const rows = await client.downloadReport(url);
        allRows.push(...rows);
        rowsByProfile.set(p.countryCode, (rowsByProfile.get(p.countryCode) || 0) + rows.length);
      } catch (err) {
        warnings.push(
          `Profile ${p.countryCode} (${p.profileId}) ${p.startDate}..${p.endDate} download failed: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    })
  );

  for (const [countryCode, count] of rowsByProfile) {
    const profileId = profileIds[countryCode];
    profilesSynced.push({ profileId, countryCode, rowsDownloaded: count });
  }

  if (profilesSynced.length === 0) {
    await updateAdsSyncStatus(accountId, {
      ok: false,
      error: warnings.join(" | ") || "All profiles failed during sync.",
    });
    return {
      ok: true,
      range: { from: options.from, to: options.to },
      profilesSynced: [],
      reports: [],
      warnings: warnings.length > 0 ? warnings : ["No profiles returned any rows."],
    };
  }

  // 2. Bucket rows by month + SKU.
  const monthly = aggregateRows(allRows);
  if (monthly.size === 0) {
    await updateAdsSyncStatus(accountId, { ok: true });
    return {
      ok: true,
      range: { from: options.from, to: options.to },
      profilesSynced,
      reports: [],
      warnings: [...warnings, "No ad spend found in the requested date range."],
    };
  }

  // 3. For each month: find/create the report, replace ad data, recompute.
  const reportResults: AdsSyncReportResult[] = [];
  for (const [, bucket] of monthly) {
    const report = await findOrCreateReport(supabase, accountId, bucket.start, bucket.end);

    // Build the matched-SKU set from the report's current per-SKU breakdown
    // so we can flag matched vs unmatched correctly.
    const { data: skuRows } = await supabase
      .from("report_sku_breakdowns")
      .select("sku")
      .eq("report_id", report.id);
    const matchedSkuSet = new Set<string>((skuRows || []).map((r) => normalizeSku(r.sku)));

    const sourceFilename = `amazon-ads-api:${options.from}..${options.to}`;
    const { matched, unmatched } = await replaceAdData(
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

    reportResults.push({
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
    void matched;
  }

  await updateAdsSyncStatus(accountId, { ok: true });
  return {
    ok: true,
    range: { from: options.from, to: options.to },
    profilesSynced,
    reports: reportResults,
    warnings,
  };
}
