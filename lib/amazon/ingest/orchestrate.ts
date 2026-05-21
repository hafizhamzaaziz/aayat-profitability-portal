/**
 * Amazon SP-API → portal report ingestion orchestrator.
 *
 * Flow:
 *   1. Pull every FinancialEvent posted between `from` and `to` via SP-API.
 *   2. Map each event into Amazon-CSV-shaped row objects (`finance-mapper`).
 *   3. Group rows by the calendar month their PostedDate falls in.
 *   4. For each month with data:
 *        a. UPSERT a `reports` row tagged source='sp_api'
 *        b. Replace its transactions (idempotent re-sync)
 *        c. Run the same pure-function P&L pipeline the manual upload uses
 *           (computeAmazonPnl → deriveTotals → computePerSku)
 *        d. Persist summary totals + breakdown + per-SKU rows
 *
 *   Coexistence: manual + sp_api reports for the same (account, period) live
 *   side-by-side thanks to the relaxed unique constraint
 *   `(account_id, period_start, period_end, platform, source)`. The reports
 *   list shows a source badge so users can pick which one to download/email.
 *
 *   We deliberately DO NOT touch ads_meta/ad_spend here — advertising is a
 *   separate report upload, and SP-API's ProductAdsPaymentEvent only carries
 *   account-level totals (no per-SKU breakdown). Users can still attach an
 *   ads CSV to a sp_api report from the Reports workbench.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { loadSpApiClient, updateSyncStatus } from "../credentials";
import { mapFinancialEvents, CSV_HEADER_ORDER, type CsvRow, type MapStats } from "./finance-mapper";
import { buildBridgedCogsLookup } from "@/lib/reports/cogs-lookup";
import { computeAmazonPnl, deriveTotals } from "@/lib/reports/amazon-pnl";
import { AMAZON_METHODOLOGY_ID } from "@/lib/reports/methodology";
import { computePerSku } from "@/lib/reports/per-sku";
import { computeExpenseTotals } from "@/lib/reports/expense-totals";
import {
  computeExpenseOccurrencesForPeriod,
  type ExpenseLedgerRow,
} from "@/lib/reports/expense-ledger";
import type { SkuLine } from "@/lib/reports/types";

const TX_INSERT_CHUNK = 400;

export type SyncOptions = {
  from: string; // YYYY-MM-DD (inclusive)
  to: string;   // YYYY-MM-DD (inclusive)
  marketplaceIds?: string[];
};

export type SyncReportResult = {
  reportId: string;
  periodStart: string; // YYYY-MM-DD
  periodEnd: string;
  rowsInserted: number;
  netProfit: number;
  outputVat: number;
  inputVat: number;
};

export type SyncResult = {
  ok: true;
  range: { from: string; to: string };
  totalEvents: number;
  totalRows: number;
  reports: SyncReportResult[];
  mapStats: MapStats;
  unmappedEventListNote?: string;
  warnings: string[];
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function monthBucket(dateIso: string): { key: string; start: string; end: string } {
  const [y, m] = dateIso.split("-");
  const year = Number(y);
  const month = Number(m);
  const start = `${y}-${m}-01`;
  // Last day of month: day 0 of next month is the last day of current
  const lastDate = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const end = `${y}-${m}-${String(lastDate).padStart(2, "0")}`;
  return { key: `${y}-${m}`, start, end };
}

function chunkDateRange(fromIso: string, toIso: string, days: number): Array<[string, string]> {
  const chunks: Array<[string, string]> = [];
  const start = new Date(`${fromIso}T00:00:00Z`).getTime();
  // Amazon rejects any postedBefore that is later than ~"now". Cap our window
  // at 5 minutes ago to give the API clock-skew headroom; otherwise picking
  // today as the "to" date will fail with "Date is not valid, should be no
  // later than 2 minutes from now".
  const requested = new Date(`${toIso}T23:59:59Z`).getTime();
  const safeMax = Date.now() - 5 * 60 * 1000;
  const end = Math.min(requested, safeMax);
  if (end < start) return chunks;
  const stepMs = days * 24 * 60 * 60 * 1000;
  for (let cursor = start; cursor <= end; cursor += stepMs) {
    const chunkStart = new Date(cursor).toISOString();
    const chunkEnd = new Date(Math.min(cursor + stepMs - 1000, end)).toISOString();
    chunks.push([chunkStart, chunkEnd]);
  }
  return chunks;
}

async function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// Step 1: pull all financial events from SP-API (paginated, chunked, throttled)
// ---------------------------------------------------------------------------

async function pullAllEvents(
  accountId: string,
  opts: SyncOptions
): Promise<{ rows: CsvRow[]; stats: MapStats; totalApiCalls: number }> {
  const { client } = await loadSpApiClient(accountId);
  const allRows: CsvRow[] = [];
  const aggStats: MapStats = {
    shipment: 0,
    refund: 0,
    guaranteeClaim: 0,
    chargeback: 0,
    serviceFee: 0,
    serviceFeeSkipped: 0,
    adjustment: 0,
    retrocharge: 0,
    productAdsIngested: 0,
    unknownLists: [],
  };
  let totalApiCalls = 0;

  // Chunk into 14-day windows. listFinancialEvents accepts up to 60 days but
  // smaller windows keep individual responses snappy and let us stream
  // progress in future. Vercel function timeout is the real constraint.
  const chunks = chunkDateRange(opts.from, opts.to, 14);

  for (const [postedAfter, postedBefore] of chunks) {
    let nextToken: string | undefined;
    do {
      totalApiCalls += 1;
      const resp = await client.listFinancialEvents({
        postedAfter,
        postedBefore,
        maxResultsPerPage: 100,
        nextToken,
      });
      const { rows, stats } = mapFinancialEvents(resp.payload?.FinancialEvents);
      allRows.push(...rows);
      aggStats.shipment += stats.shipment;
      aggStats.refund += stats.refund;
      aggStats.guaranteeClaim += stats.guaranteeClaim;
      aggStats.chargeback += stats.chargeback;
      aggStats.serviceFee += stats.serviceFee;
      aggStats.serviceFeeSkipped += stats.serviceFeeSkipped;
      aggStats.adjustment += stats.adjustment;
      aggStats.retrocharge += stats.retrocharge;
      aggStats.productAdsIngested += stats.productAdsIngested;
      for (const u of stats.unknownLists) {
        if (!aggStats.unknownLists.includes(u)) aggStats.unknownLists.push(u);
      }
      nextToken = resp.payload?.NextToken;
      // Token-bucket throttle: SP-API Finance is 0.5 req/sec burst 30. A
      // 600ms pause between paged calls keeps us safely under the limit.
      if (nextToken) await sleep(600);
    } while (nextToken);
  }

  return { rows: allRows, stats: aggStats, totalApiCalls };
}

// ---------------------------------------------------------------------------
// Step 2: build AOA (array-of-arrays) the P&L engine expects
// ---------------------------------------------------------------------------

function buildAoaForMonth(monthRows: CsvRow[]): unknown[][] {
  // Header row as the first row, then one row per CsvRow with values in the
  // canonical column order. Matches the shape `computeAmazonPnl` produces
  // when reading a downloadable Amazon CSV.
  const header = CSV_HEADER_ORDER as string[];
  const data = monthRows.map((r) => header.map((col) => (r as Record<string, unknown>)[col] ?? ""));
  return [header, ...data];
}

// ---------------------------------------------------------------------------
// Step 3: ingest one month — upsert report, replace transactions, write P&L
// ---------------------------------------------------------------------------

async function ingestMonth(input: {
  supabase: SupabaseClient;
  accountId: string;
  vatRatePct: number;
  cogsVatReclaimPct: number;
  bucketStart: string;
  bucketEnd: string;
  rows: CsvRow[];
  cogsLookup: Awaited<ReturnType<typeof buildBridgedCogsLookup>>;
}): Promise<SyncReportResult> {
  const { supabase, accountId, vatRatePct, cogsVatReclaimPct, bucketStart, bucketEnd, rows, cogsLookup } = input;

  // ---- Run the P&L pipeline against the freshly-mapped rows --------------
  const aoa = buildAoaForMonth(rows);
  const pnl = computeAmazonPnl(aoa);

  const totals = deriveTotals({
    pnl,
    cogsLookup,
    vatRatePct,
    defaultDateIso: bucketStart,
    cogsVatReclaimPct,
  });

  const { lines: skuLines } = computePerSku({
    pnl,
    cogsLookup,
    vatRatePct,
    defaultDateIso: bucketStart,
    adReport: null, // Ads spend isn't sourced from SP-API
  });

  // ---- Upsert the report row ---------------------------------------------
  // We need to check whether a sp_api report already exists for this period
  // so we can reuse its id (preserves user edits, attached ads files, etc).
  const { data: existing } = await supabase
    .from("reports")
    .select("id, breakdown, cogs_vat_reclaim_pct")
    .eq("account_id", accountId)
    .eq("period_start", bucketStart)
    .eq("period_end", bucketEnd)
    .eq("platform", "amazon")
    .eq("source", "sp_api")
    .maybeSingle();

  // Compute summary fields the existing UI/PDF code already reads from.
  const settlementNet = totals.netSales + totals.fbaReimbursements + totals.totalAmazonFeesExvat;
  const outputVat = totals.outputVatPayableToHmrc;
  const inputVatFees = totals.totalInputVatAmazonFees;
  const purchaseCost = -totals.cogs;

  // External expenses: load any recurring/one-time expenses that fall in
  // this period and net them off so the totals match the manual flow.
  // (We load these regardless of whether the report already existed, so a
  // fresh sp_api report still includes them.)
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

  const productSalesLine = pnl.productSalesPositive;
  const refundsLine = pnl.productSalesRefunds;
  const adjustmentsLine = totals.fbaReimbursements + pnl.postageCredits + pnl.promotionalRebates;
  const serviceFeesLine = totals.subscriptionExvat + totals.advertisingExvat;

  const breakdown = {
    ...((existing?.breakdown as Record<string, unknown>) || {}),
    platform: "amazon" as const,
    summaryLines: [
      { label: "Product Sales", value: Number(productSalesLine.toFixed(2)) },
      { label: "Refunds on Sales", value: Number(refundsLine.toFixed(2)) },
      { label: "Adjustments & Credits", value: Number(adjustmentsLine.toFixed(2)) },
      { label: "Selling Fees", value: totals.sellingFeesExvat },
      { label: "FBA Fees", value: totals.fbaFeesExvat },
      { label: "FBA Inventory Fee", value: totals.fbaInventoryFeesExvat },
      { label: "Other Transaction Fees", value: totals.otherTxFeesExvat },
      { label: "Delivery Services", value: totals.deliveryServicesExvat },
      { label: "Service Fees", value: Number(serviceFeesLine.toFixed(2)) },
    ],
    settlementLabel: "Net Amazon Settlement",
    settlementValue: Number(settlementValue.toFixed(2)),
    transferLabel: "Transfers to Bank",
    transferValue: totals.bankTransfers,
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
    sourceMeta: {
      source: "sp_api",
      syncedAt: new Date().toISOString(),
      rowsIngested: rows.length,
    },
    perSkuRollup: {
      marketplaceNetProfitSum: Number(totals.operatingProfit.toFixed(2)),
      externalExpensesNet: Number(expensesNet.toFixed(2)),
    },
  };

  const reportPayload = {
    account_id: accountId,
    period_start: bucketStart,
    period_end: bucketEnd,
    platform: "amazon" as const,
    source: "sp_api" as const,
    gross_sales: Number(settlementValue.toFixed(2)),
    total_cogs: Number(purchaseCost.toFixed(2)),
    total_fees: Number(totalFeesAbs.toFixed(2)),
    output_vat: Number(outputVat.toFixed(2)),
    input_vat: Number(inputVat.toFixed(2)),
    net_profit: Number(netProfit.toFixed(2)),
    breakdown,
    cogs_vat_reclaim_pct: Number(cogsVatReclaimPct.toFixed(2)),
    updated_at: new Date().toISOString(),
  };

  const upsertResult = await supabase
    .from("reports")
    .upsert(reportPayload, {
      onConflict: "account_id,period_start,period_end,platform,source",
    })
    .select("id")
    .single();
  if (upsertResult.error) throw upsertResult.error;
  const reportId = upsertResult.data.id as string;

  // ---- Replace transactions (idempotent re-sync) -------------------------
  // Wipe everything for this report, then insert fresh. Keeping the old rows
  // and merging on amazon_event_id would be marginally faster but adds a lot
  // of edge cases — clean replace is much easier to reason about.
  const { error: clearTxError } = await supabase
    .from("report_transactions")
    .delete()
    .eq("report_id", reportId);
  if (clearTxError) throw clearTxError;

  const txPayload = rows.map((r) => {
    const { __amazon_event_id, __posted_date, __sku, __quantity, ...rawRow } = r;
    return {
      report_id: reportId,
      account_id: accountId,
      platform: "amazon" as const,
      transaction_date: __posted_date,
      sku: __sku,
      quantity: __quantity,
      raw_row: rawRow,
      source: "sp_api" as const,
      amazon_event_id: __amazon_event_id,
    };
  });

  for (let i = 0; i < txPayload.length; i += TX_INSERT_CHUNK) {
    const chunk = txPayload.slice(i, i + TX_INSERT_CHUNK);
    const { error: txError } = await supabase.from("report_transactions").insert(chunk);
    if (txError) throw txError;
  }

  // ---- Replace per-SKU breakdown ------------------------------------------
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
  const SKU_CHUNK = 400;
  for (let i = 0; i < skuPayload.length; i += SKU_CHUNK) {
    const chunk = skuPayload.slice(i, i + SKU_CHUNK);
    if (chunk.length) {
      const { error: skuError } = await supabase.from("report_sku_breakdowns").insert(chunk);
      if (skuError) throw skuError;
    }
  }

  return {
    reportId,
    periodStart: bucketStart,
    periodEnd: bucketEnd,
    rowsInserted: rows.length,
    netProfit: Number(netProfit.toFixed(2)),
    outputVat: Number(outputVat.toFixed(2)),
    inputVat: Number(inputVat.toFixed(2)),
  };
}

// ---------------------------------------------------------------------------
// Top-level entry point
// ---------------------------------------------------------------------------

export async function syncAmazonFinanceData(input: {
  supabase: SupabaseClient;
  accountId: string;
  vatRatePct: number;
  cogsVatReclaimPct: number;
  options: SyncOptions;
}): Promise<SyncResult> {
  const { supabase, accountId, vatRatePct, cogsVatReclaimPct, options } = input;
  const warnings: string[] = [];

  let rows: CsvRow[] = [];
  let mapStats: MapStats;
  try {
    const pulled = await pullAllEvents(accountId, options);
    rows = pulled.rows;
    mapStats = pulled.stats;
  } catch (err) {
    await updateSyncStatus(accountId, {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }

  if (rows.length === 0) {
    await updateSyncStatus(accountId, { ok: true });
    return {
      ok: true,
      range: { from: options.from, to: options.to },
      totalEvents: 0,
      totalRows: 0,
      reports: [],
      mapStats,
      warnings: ["No financial events were returned by SP-API in this date range."],
    };
  }

  // Bucket rows by calendar month based on PostedDate. Some events (e.g.
  // order-level fee adjustments without a posted date, certain service-fee
  // events) come back with no PostedDate at all; we attribute those to the
  // last day of the requested window so they aren't silently dropped — they
  // still belong to the period the user asked about.
  const buckets = new Map<string, { start: string; end: string; rows: CsvRow[] }>();
  const fallbackDate = options.to;
  let undated = 0;
  for (const r of rows) {
    let date = r.__posted_date;
    if (!date) {
      undated += 1;
      date = fallbackDate;
      r.__posted_date = fallbackDate;
      // Also stamp the date/time column so the engine can attribute it.
      (r as Record<string, unknown>)["date/time"] = `${fallbackDate}T00:00:00Z`;
    }
    const b = monthBucket(date);
    if (!buckets.has(b.key)) buckets.set(b.key, { start: b.start, end: b.end, rows: [] });
    buckets.get(b.key)!.rows.push(r);
  }
  if (undated > 0) {
    warnings.push(
      `${undated} event(s) had no PostedDate from Amazon — attributed to ${fallbackDate} (end of requested window).`
    );
  }

  const cogsLookup = await buildBridgedCogsLookup(supabase, accountId);

  const reportResults: SyncReportResult[] = [];
  for (const [, bucket] of Array.from(buckets.entries()).sort(([a], [b]) => a.localeCompare(b))) {
    const result = await ingestMonth({
      supabase,
      accountId,
      vatRatePct,
      cogsVatReclaimPct,
      bucketStart: bucket.start,
      bucketEnd: bucket.end,
      rows: bucket.rows,
      cogsLookup,
    });
    reportResults.push(result);
  }

  if (mapStats.unknownLists.length > 0) {
    warnings.push(`Unmapped event lists encountered (events skipped): ${mapStats.unknownLists.join(", ")}`);
  }
  if (mapStats.productAdsIngested > 0) {
    warnings.push(
      `Ingested ${mapStats.productAdsIngested} ad-payment event(s) as placeholder PPC spend — upload the Ads CSV to replace with per-SKU detail.`
    );
  }

  await updateSyncStatus(accountId, { ok: true });

  return {
    ok: true,
    range: { from: options.from, to: options.to },
    totalEvents:
      mapStats.shipment +
      mapStats.refund +
      mapStats.guaranteeClaim +
      mapStats.chargeback +
      mapStats.serviceFee +
      mapStats.adjustment +
      mapStats.retrocharge,
    totalRows: rows.length,
    reports: reportResults,
    mapStats,
    warnings,
  };
}
