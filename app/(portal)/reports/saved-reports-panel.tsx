"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { addDays, formatUkDate } from "@/lib/utils/date";
import { pushClientNotification } from "@/lib/notifications/client";
import PerSkuTable, { type PerSkuRow } from "@/components/reports/per-sku-table";
import { computeAmazonPnl, deriveTotals, applyAdReportOverride } from "@/lib/reports/amazon-pnl";
import { computePerSku } from "@/lib/reports/per-sku";
import {
  computeTemuPnl,
  deriveTemuTotals,
  computeTemuPerSku,
  type TemuAdOverride,
} from "@/lib/reports/temu-pnl";
import { buildBridgedCogsLookup } from "@/lib/reports/cogs-lookup";
import { adReportFromRows, loadAdReport } from "@/lib/reports/ad-report";
import {
  loadTemuAdReport,
  temuAdReportFromRows,
  allocateTemuAds,
  type TemuAdReport,
} from "@/lib/reports/temu-ad-report";
import { AMAZON_METHODOLOGY_ID, TEMU_METHODOLOGY_ID } from "@/lib/reports/methodology";
import { computeExpenseTotals } from "@/lib/reports/expense-totals";
import {
  computeExpenseOccurrencesForPeriod,
  type ExpenseLedgerRow,
  type ExpenseOccurrence,
} from "@/lib/reports/expense-ledger";
import { deriveReportWarnings } from "@/lib/reports/guardrails";
import type { AdReport } from "@/lib/reports/types";

type SavedReport = {
  id: string;
  account_id: string;
  platform: "amazon" | "temu";
  period_start: string;
  period_end: string;
  gross_sales: number;
  total_cogs: number;
  total_fees: number;
  output_vat: number;
  input_vat: number;
  net_profit: number;
  cogs_vat_reclaim_pct: number | null;
  source?: "manual" | "sp_api" | null;
  breakdown: {
    summaryLines?: Array<{ label: string; value: number }>;
    warnings?: string[];
    adsOverride?: {
      previousAdExvat: number;
      newAdExvat: number;
      adReportTotal: number;
      blankSkuSpend: number;
      sourceFilename: string;
    } | null;
    methodologyId?: string;
    /** Saved with "Save edits" — included in PDF when no one-off query override is passed. */
    manualNotesPdf?: string;
    /** Marketplace per-SKU subtotal vs manual external expenses (not allocated to SKUs). */
    perSkuRollup?: {
      marketplaceNetProfitSum: number;
      externalExpensesNet: number;
    };
  } | null;
};

type SavedSkuRow = {
  sku: string;
  description: string | null;
  units: number;
  refund_units: number;
  net_sales: number;
  product_sales: number;
  postage_credits: number;
  promo_rebates: number;
  cogs: number;
  selling_fees_exvat: number;
  fba_fees_exvat: number;
  other_tx_fees_exvat: number;
  delivery_services_exvat: number;
  advertising_alloc: number;
  fba_inventory_alloc: number;
  subscription_alloc: number;
  deal_fees_alloc: number;
  fba_reimbursements: number;
  output_vat: number;
  marketplace_withheld_vat: number;
  retrocharge_vat: number;
  net_profit: number;
  cost_known: boolean;
  ad_only: boolean;
};

type SavedAdMeta = {
  source_filename: string | null;
  total_spend_exvat: number;
  blank_sku_spend: number;
  matched_sku_count: number;
  unmatched_sku_count: number;
  uploaded_at: string;
};

function savedSkuRowToTableRow(row: SavedSkuRow): PerSkuRow {
  const netSales = Number(row.net_sales) || 0;
  const cogs = Number(row.cogs) || 0;
  return {
    sku: row.sku,
    description: row.description || undefined,
    units: Number(row.units) || 0,
    netSales,
    cogs,
    sellingFeesExvat: Number(row.selling_fees_exvat) || 0,
    fbaFeesExvat: Number(row.fba_fees_exvat) || 0,
    otherTxFeesExvat: Number(row.other_tx_fees_exvat) || 0,
    deliveryServicesExvat: Number(row.delivery_services_exvat) || 0,
    advertisingAlloc: Number(row.advertising_alloc) || 0,
    fbaInventoryAlloc: Number(row.fba_inventory_alloc) || 0,
    subscriptionAlloc: Number(row.subscription_alloc) || 0,
    dealFeesAlloc: Number(row.deal_fees_alloc) || 0,
    fbaReimbursements: Number(row.fba_reimbursements) || 0,
    grossProfit: Number((netSales + cogs).toFixed(2)),
    netProfit: Number(row.net_profit) || 0,
    netMargin: netSales !== 0 ? (Number(row.net_profit) || 0) / netSales : 0,
    costKnown: Boolean(row.cost_known),
    adOnly: Boolean(row.ad_only),
  };
}

type Expense = {
  id: string;
  description: string;
  amount: number;
  includes_vat: boolean;
  occurrence_date?: string;
  expense_type?: string;
};

type Props = {
  accountId: string;
  accountName: string;
  canEdit: boolean;
  currency: string;
  vatRate: number;
};

function money(value: number) {
  return Number((value || 0).toFixed(2));
}

function primarySalesLabel(platform: SavedReport["platform"]) {
  return platform === "amazon" ? "Product Sales" : "Order Payments";
}

function isReportMethodologyCurrent(report: SavedReport) {
  const marker = report.breakdown?.methodologyId;
  if (report.platform === "amazon") return marker === AMAZON_METHODOLOGY_ID;
  if (report.platform === "temu") return marker === TEMU_METHODOLOGY_ID;
  return true;
}

/**
 * Load Goods ID → list of Temu SKU IDs from `sku_mappings` (joined to
 * `sku_catalog.temu_goods_id`). Used by the Temu ads-report allocator
 * during recompute so the bucketing reflects the *current* mapping state
 * rather than whatever was in place when the report was originally saved.
 */
async function loadGoodsToSkuIdsMap(
  supabase: ReturnType<typeof createClient>,
  accountId: string
): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  const { data, error } = await supabase
    .from("sku_mappings")
    .select("temu_sku_id, sku_catalog:sku_catalog_id(temu_goods_id)")
    .eq("account_id", accountId);
  if (error) return out;
  (data || []).forEach((row) => {
    const rec = row as unknown as {
      temu_sku_id: string | null;
      sku_catalog?: { temu_goods_id?: string | null } | null;
    };
    const skuId = String(rec.temu_sku_id || "").trim().toLowerCase();
    const goodsId = String(rec.sku_catalog?.temu_goods_id || "").trim();
    if (!skuId || !goodsId) return;
    const list = out.get(goodsId) || [];
    if (!list.includes(skuId)) list.push(skuId);
    out.set(goodsId, list);
  });
  return out;
}

function getPrimarySales(report: SavedReport) {
  const targetLabel = primarySalesLabel(report.platform);
  const line = report.breakdown?.summaryLines?.find((item) => item.label === targetLabel);
  return Number(line?.value ?? report.gross_sales ?? 0);
}

async function loadExpenseOccurrencesForReport(
  supabase: ReturnType<typeof createClient>,
  report: Pick<SavedReport, "account_id" | "platform" | "period_start" | "period_end">
): Promise<ExpenseOccurrence[]> {
  const { data } = await supabase
    .from("expense_ledger")
    .select("id, account_id, description, expense_date, amount, includes_vat, marketplace, expense_type, recurring_end_date")
    .eq("account_id", report.account_id)
    .lte("expense_date", report.period_end)
    .or(`recurring_end_date.is.null,recurring_end_date.gte.${report.period_start}`);
  return computeExpenseOccurrencesForPeriod({
    rows: (data || []) as ExpenseLedgerRow[],
    platform: report.platform,
    periodStart: report.period_start,
    periodEnd: report.period_end,
  });
}

export default function SavedReportsPanel({ accountId, accountName, canEdit, currency, vatRate }: Props) {
  const PAGE_SIZE = 20;
  const [reports, setReports] = useState<SavedReport[]>([]);
  const [selectedForCombine, setSelectedForCombine] = useState<string[]>([]);
  const [selectedId, setSelectedId] = useState<string>("");
  const [currentNetByReportId, setCurrentNetByReportId] = useState<Record<string, number>>({});
  const [expenses, setExpenses] = useState<Expense[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [emailing, setEmailing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const [filterStart, setFilterStart] = useState("");
  const [filterEnd, setFilterEnd] = useState("");
  const [exportNotes, setExportNotes] = useState("");
  const [pageOffset, setPageOffset] = useState(0);
  const [totalCount, setTotalCount] = useState(0);

  const [skuRows, setSkuRows] = useState<SavedSkuRow[]>([]);
  const [adMeta, setAdMeta] = useState<SavedAdMeta | null>(null);
  const [recomputing, setRecomputing] = useState(false);
  const [adUpdating, setAdUpdating] = useState(false);
  const [cogsVatPctDraft, setCogsVatPctDraft] = useState<number>(100);
  const adFileInputRef = useRef<HTMLInputElement | null>(null);
  const autoMigrationRunningRef = useRef(false);
  const autoMigrationAttemptedRef = useRef<Set<string>>(new Set());

  const totalPages = Math.max(1, Math.ceil(totalCount / PAGE_SIZE));
  const currentPage = Math.floor(pageOffset / PAGE_SIZE) + 1;

  const selected = useMemo(() => reports.find((r) => r.id === selectedId) || null, [reports, selectedId]);
  const getMarketplaceOperatingProfit = (report: SavedReport) => {
    if (
      typeof (report.breakdown as { perSkuRollup?: { marketplaceNetProfitSum?: unknown } } | null)?.perSkuRollup
        ?.marketplaceNetProfitSum === "number"
    ) {
      return Number(
        (report.breakdown as { perSkuRollup: { marketplaceNetProfitSum: number } }).perSkuRollup.marketplaceNetProfitSum
      );
    }
    const legacyExternal =
      typeof (report.breakdown as { perSkuRollup?: { externalExpensesNet?: unknown } } | null)?.perSkuRollup
        ?.externalExpensesNet === "number"
        ? Number((report.breakdown as { perSkuRollup: { externalExpensesNet: number } }).perSkuRollup.externalExpensesNet)
        : 0;
    return Number(report.net_profit || 0) + legacyExternal;
  };


  const isZeroVatAccount = Number(vatRate || 0) === 0;

  const liveExpenseTotals = useMemo(() => computeExpenseTotals(expenses, vatRate), [expenses, vatRate]);

  const liveValues = useMemo(() => {
    if (!selected) {
      return {
        productSales: 0,
        totalCogs: 0,
        totalFees: 0,
        outputVat: 0,
        inputVat: 0,
        netProfit: 0,
        totalExpenses: 0,
        unitsSold: 0,
      };
    }
    const marketplaceOperatingProfit =
      typeof (selected.breakdown as { perSkuRollup?: { marketplaceNetProfitSum?: unknown } } | null)?.perSkuRollup
        ?.marketplaceNetProfitSum === "number"
        ? Number(
            (selected.breakdown as { perSkuRollup: { marketplaceNetProfitSum: number } }).perSkuRollup
              .marketplaceNetProfitSum
          )
        : Number(selected.net_profit || 0) +
          (typeof (selected.breakdown as { perSkuRollup?: { externalExpensesNet?: unknown } } | null)?.perSkuRollup
            ?.externalExpensesNet === "number"
            ? Number(
                (selected.breakdown as { perSkuRollup: { externalExpensesNet: number } }).perSkuRollup
                  .externalExpensesNet
              )
            : 0);
    return {
      marketplaceOperatingProfit,
      productSales: getPrimarySales(selected),
      totalCogs: Math.abs(Number(selected.total_cogs || 0)),
      totalFees: Math.abs(Number(selected.total_fees || 0)),
      outputVat: isZeroVatAccount ? 0 : Number(selected.output_vat || 0),
      inputVat: isZeroVatAccount ? 0 : Number(selected.input_vat || 0),
      netProfit:
        typeof currentNetByReportId[selected.id] === "number"
          ? Number(currentNetByReportId[selected.id])
          : money(marketplaceOperatingProfit - liveExpenseTotals.net),
      totalExpenses: liveExpenseTotals.net,
      unitsSold: skuRows.reduce((acc, r) => acc + Number(r.units || 0), 0),
    };
  }, [selected, skuRows, liveExpenseTotals.net, isZeroVatAccount, currentNetByReportId]);

  const savedWarnings = useMemo<string[]>(() => {
    const list = (selected?.breakdown as { warnings?: unknown } | null)?.warnings;
    if (!Array.isArray(list)) return [];
    return list.map((w) => String(w)).filter((w) => w.trim().length > 0);
  }, [selected]);

  const skuRollupLive = useMemo(() => {
    const marketplaceSubtotal = skuRows.reduce((acc, r) => acc + Number(r.net_profit || 0), 0);
    const ext = computeExpenseTotals(expenses, vatRate);
    return {
      marketplaceSubtotal: money(marketplaceSubtotal),
      externalExpensesNet: money(ext.net),
    };
  }, [skuRows, expenses, vatRate]);

  useEffect(() => {
    if (!message && !error) return;
    const t = window.setTimeout(() => {
      setMessage(null);
      setError(null);
    }, 9000);
    return () => window.clearTimeout(t);
  }, [message, error]);

  const loadReports = async (offset = pageOffset) => {
    setLoading(true);
    setError(null);
    const supabase = createClient();

    let query = supabase
      .from("reports")
      .select(
        "id, account_id, platform, period_start, period_end, gross_sales, total_cogs, total_fees, output_vat, input_vat, net_profit, cogs_vat_reclaim_pct, source, breakdown"
      )
      .eq("account_id", accountId)
      .order("period_start", { ascending: false })
      .range(offset, offset + PAGE_SIZE - 1);
    let countQuery = supabase.from("reports").select("id", { count: "exact", head: true }).eq("account_id", accountId);

    if (filterStart) query = query.gte("period_start", filterStart);
    if (filterStart) countQuery = countQuery.gte("period_start", filterStart);
    if (filterEnd) query = query.lte("period_end", filterEnd);
    if (filterEnd) countQuery = countQuery.lte("period_end", filterEnd);

    const [{ data, error: fetchError }, { count }] = await Promise.all([query, countQuery]);

    if (fetchError) {
      setError(fetchError.message);
      setLoading(false);
      return;
    }

    const nextReports = (data || []) as SavedReport[];
    if (nextReports.length > 0) {
      const minStart = nextReports.reduce((a, r) => (r.period_start < a ? r.period_start : a), nextReports[0].period_start);
      const maxEnd = nextReports.reduce((a, r) => (r.period_end > a ? r.period_end : a), nextReports[0].period_end);
      const { data: ledgerRows } = await supabase
        .from("expense_ledger")
        .select("id, account_id, description, expense_date, amount, includes_vat, marketplace, expense_type, recurring_end_date")
        .eq("account_id", accountId)
        .lte("expense_date", maxEnd)
        .or(`recurring_end_date.is.null,recurring_end_date.gte.${minStart}`);
      const allLedger = (ledgerRows || []) as ExpenseLedgerRow[];
      const computed: Record<string, number> = {};
      for (const report of nextReports) {
        const occ = computeExpenseOccurrencesForPeriod({
          rows: allLedger,
          platform: report.platform,
          periodStart: report.period_start,
          periodEnd: report.period_end,
        });
        const expenseNet = computeExpenseTotals(
          occ.map((o) => ({ amount: Number(o.amount || 0), includes_vat: Boolean(o.includes_vat) })),
          vatRate
        ).net;
        computed[report.id] = money(getMarketplaceOperatingProfit(report) - expenseNet);
      }
      setCurrentNetByReportId(computed);
    } else {
      setCurrentNetByReportId({});
    }
    setReports(nextReports);
    setTotalCount(Number(count || 0));

    if (nextReports.length > 0) {
      const current = nextReports.find((r) => r.id === selectedId) || nextReports[0];
      setSelectedId(current.id);
    } else {
      setSelectedId("");
      setExpenses([]);
    }

    setLoading(false);
  };

  const loadExpenses = async (report: SavedReport) => {
    const supabase = createClient();
    const occurrences = await loadExpenseOccurrencesForReport(supabase, report);
    const next = occurrences.map((o) => ({
      id: `${o.expense_id}:${o.occurrence_date}`,
      description: o.description,
      amount: Number(o.amount || 0),
      includes_vat: Boolean(o.includes_vat),
      occurrence_date: o.occurrence_date,
      expense_type: o.expense_type,
    })) as Expense[];
    setExpenses(next);
  };

  const loadPerSkuAndAds = async (reportId: string) => {
    const supabase = createClient();
    const [{ data: skuData }, { data: metaData }] = await Promise.all([
      supabase
        .from("report_sku_breakdowns")
        .select("*")
        .eq("report_id", reportId)
        .order("net_profit", { ascending: false }),
      supabase
        .from("report_ad_meta")
        .select("source_filename, total_spend_exvat, blank_sku_spend, matched_sku_count, unmatched_sku_count, uploaded_at")
        .eq("report_id", reportId)
        .maybeSingle(),
    ]);
    setSkuRows((skuData || []) as SavedSkuRow[]);
    setAdMeta((metaData as SavedAdMeta | null) ?? null);
  };

  // ------- Recompute saved report with current methodology -------
  // Loads the original transaction rows from `report_transactions.raw_row`
  // (saved at upload time), optionally overrides the ads with a freshly
  // uploaded report or the persisted spend rows, then writes the new
  // account-level + per-SKU + ad-meta rows back to the DB.
  const recomputeReport = async (
    options: {
      adOverride?: AdReport | null;
      temuAdOverride?: TemuAdReport | null;
      statusMessage?: string;
      cogsVatReclaimPct?: number | null;
      targetReport?: SavedReport;
      expenseRowsOverride?: Expense[];
      silent?: boolean;
      refreshUiAfter?: boolean;
    } = {}
  ) => {
    const target = options.targetReport ?? selected;
    if (!target) return;
    const isForeground = !options.silent;
    if (isForeground) {
      setRecomputing(true);
      setError(null);
      setMessage(null);
    }

    try {
      const supabase = createClient();

      // 1) Pull every persisted raw row for the period (paginate ourselves
      //    since Supabase caps single-query rows at ~1000).
      const allRows: Record<string, unknown>[] = [];
      const PAGE = 1000;
      for (let from = 0; ; from += PAGE) {
        const { data: txPage, error: txError } = await supabase
          .from("report_transactions")
          .select("raw_row")
          .eq("report_id", target.id)
          .range(from, from + PAGE - 1);
        if (txError) throw txError;
        if (!txPage || txPage.length === 0) break;
        for (const r of txPage) {
          if (r.raw_row && typeof r.raw_row === "object") {
            allRows.push(r.raw_row as Record<string, unknown>);
          }
        }
        if (txPage.length < PAGE) break;
      }
      if (allRows.length === 0) {
        throw new Error(
          "No raw transactions found for this report. Recompute requires the original transaction file to have been saved with the report."
        );
      }

      // 2) Bridged COGS lookup (Amazon SKU ↔ Temu SKU ID via sku_mappings).
      const cogsLookup = await buildBridgedCogsLookup(supabase, target.account_id);

      // 3) Ads report: prefer freshly uploaded → persisted rows → none.
      // Amazon and Temu use the same `report_ad_spend` + `report_ad_meta`
      // tables; rows are distinguished by `source_kind`. For Amazon we
      // expect SKU-level rows; for Temu we expect Goods-level rows.
      let adReport: AdReport | null = options.adOverride ?? null;
      let temuAdReport: TemuAdReport | null = options.temuAdOverride ?? null;
      if (!adReport && !temuAdReport) {
        const { data: adRows } = await supabase
          .from("report_ad_spend")
          .select("sku, spend_exvat, temu_goods_id, goods_name, source_kind")
          .eq("report_id", target.id);
        const { data: meta } = await supabase
          .from("report_ad_meta")
          .select("source_filename, total_spend_exvat, blank_sku_spend")
          .eq("report_id", target.id)
          .maybeSingle();
        if (adRows && adRows.length > 0) {
          if (target.platform === "temu") {
            // Goods-level rows. Temu rows always have `source_kind = 'temu_goods'`
            // (or `temu_goods_id` set when the ads-report has been re-saved
            // in this format). Older rows might be Amazon-shape; ignore them.
            const goodsRows = (adRows as Array<{
              sku: string | null;
              spend_exvat: number;
              temu_goods_id: string | null;
              goods_name: string | null;
              source_kind: string | null;
            }>).filter(
              (r) => r.source_kind === "temu_goods" || r.temu_goods_id !== null || r.sku === null
            );
            if (goodsRows.length > 0) {
              temuAdReport = temuAdReportFromRows({
                rows: goodsRows.map((r) => ({
                  temu_goods_id: r.temu_goods_id,
                  goods_name: r.goods_name,
                  spend_exvat: Number(r.spend_exvat) || 0,
                })),
                totalSpendExvat: meta?.total_spend_exvat ?? null,
                blankGoodsSpend: meta?.blank_sku_spend ?? null,
                sourceFilename: meta?.source_filename ?? null,
              });
            }
          } else {
            adReport = adReportFromRows({
              rows: adRows as Array<{ sku: string | null; spend_exvat: number }>,
              totalSpendExvat: meta?.total_spend_exvat,
              blankSkuSpend: meta?.blank_sku_spend,
              sourceFilename: meta?.source_filename ?? null,
            });
          }
        }
      }

      // 4) Run the engine.
      // Build a 2D array from the saved JSONB rows. The persisted `raw_row`
      // objects use the original Excel headers as keys; `Object.keys(rows[0])`
      // recovers them. Both engines auto-detect the real header row inside
      // the first ~25 rows so banner/metadata rows are tolerated.
      const keys = Object.keys(allRows[0]);
      const aoa: unknown[][] = [keys, ...allRows.map((r) => keys.map((h) => r[h]))];

      // Shared outputs each platform branch must populate.
      let skuLines: import("@/lib/reports/types").SkuLine[];
      let recomputedWarnings: string[];
      let newBreakdown: Record<string, unknown>;
      let newAdsOverride:
        | {
            previousAdExvat: number;
            newAdExvat: number;
            adReportTotal: number;
            blankSkuSpend: number;
            sourceFilename: string;
          }
        | null;
      let reportPatch: Record<string, unknown>;
      const effectiveCogsVatPct = Number(
        options.cogsVatReclaimPct ?? target.cogs_vat_reclaim_pct ?? 100
      );
      let expensesForRecompute = options.expenseRowsOverride;
      if (!expensesForRecompute) {
        if (selected && target.id === selected.id) {
          expensesForRecompute = expenses;
        } else {
          const occurrences = await loadExpenseOccurrencesForReport(supabase, target);
          expensesForRecompute = occurrences.map((o) => ({
            id: `${o.expense_id}:${o.occurrence_date}`,
            description: o.description,
            amount: Number(o.amount || 0),
            includes_vat: Boolean(o.includes_vat),
            occurrence_date: o.occurrence_date,
            expense_type: o.expense_type,
          })) as Expense[];
        }
      }
      const expensesNow = computeExpenseTotals(expensesForRecompute || [], vatRate);

      if (target.platform === "amazon") {
        const pnl = computeAmazonPnl(aoa);
        if (pnl.rowsProcessed === 0) {
          throw new Error(
            `Recompute could not locate a recognisable Amazon header row in the saved transactions (${allRows.length} rows scanned). Re-upload the original transaction sheet via "New Report" to refresh the saved data.`
          );
        }
        let previousAdExvat = 0;
        if (adReport) {
          const before = applyAdReportOverride(pnl, adReport.totalSpend, vatRate);
          previousAdExvat = Number(before.previousAdExvat || 0);
        }
        const totals = deriveTotals({
          pnl,
          cogsLookup,
          vatRatePct: vatRate,
            defaultDateIso: target.period_start,
          cogsVatReclaimPct: effectiveCogsVatPct,
        });
        const { lines, diagnostics: perSkuDiag } = computePerSku({
          pnl,
          cogsLookup,
          vatRatePct: vatRate,
            defaultDateIso: target.period_start,
          adReport,
        });
        skuLines = lines;

        const missingSkus: string[] = [];
        const missingSkusWithSales: Array<{ sku: string; units: number; netSales: number }> = [];
        for (const [sku, units] of Object.entries(pnl.skuUnits)) {
          if (Number(units || 0) <= 0) continue;
          if (!cogsLookup.has(String(sku).toLowerCase())) {
            const upper = String(sku).toUpperCase();
            missingSkus.push(upper);
            const netSales =
              (pnl.skuProductSales[sku] || 0) +
              (pnl.skuPostageCredits[sku] || 0) +
              (pnl.skuPromoRebates[sku] || 0);
            missingSkusWithSales.push({ sku: upper, units: Number(units || 0), netSales });
          }
        }

        const settlementNet = totals.netSales + totals.fbaReimbursements + totals.totalAmazonFeesExvat;
        const marketplaceNetProfit = Number(totals.operatingProfit.toFixed(2));
        const outputVat = totals.outputVatPayableToHmrc;
        const inputVatFees = totals.totalInputVatAmazonFees;
        const inputVatPurchases = totals.inputVatCogs + expensesNow.vat;
        const inputVat = inputVatFees + inputVatPurchases;
        const purchaseCost = -totals.cogs;
        const netProfit = settlementNet - purchaseCost - expensesNow.net;
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

        newAdsOverride = adReport
          ? {
              previousAdExvat: Number(previousAdExvat.toFixed(2)),
              newAdExvat: -Math.abs(adReport.totalSpend),
              adReportTotal: Number(adReport.totalSpend.toFixed(2)),
              blankSkuSpend: Number(adReport.blankSkuSpend.toFixed(2)),
              sourceFilename: adReport.sourceFilename,
            }
          : null;

        recomputedWarnings = deriveReportWarnings({
          missingSkus,
          missingSkusWithSales,
          netProfit: Number(netProfit.toFixed(2)),
          outputVat: Number(outputVat.toFixed(2)),
          inputVat: Number(inputVat.toFixed(2)),
          skuLines: skuLines.map((l) => ({
            sku: l.sku,
            netProfit: l.netProfit,
            netSales: l.netSales,
            units: l.units,
            costKnown: l.costKnown,
            adOnly: l.adOnly,
          })),
          accountNetProfit: Number(netProfit.toFixed(2)),
          skuReconcileBaseline: marketplaceNetProfit,
          adOverride: newAdsOverride
            ? {
                adReportTotal: newAdsOverride.adReportTotal,
                previousAdExvat: newAdsOverride.previousAdExvat,
              }
            : null,
          periodStart: target.period_start,
          periodEnd: target.period_end,
          rowsProcessed: pnl.rowsProcessed,
          rowsSkipped: pnl.rowsSkipped,
          netSales: totals.netSales,
          productSalesRefunds: pnl.productSalesRefunds,
          vatRatePct: vatRate,
          currency,
          diagnostics: {
            deliveryUnmatched: pnl.deliveryServicesUnmatched,
            retrochargeUnmatched: pnl.retrochargeUnmatched,
            reimburseUnallocated: pnl.fbaReimbursementsUnallocated,
            adSkusUnmatched: perSkuDiag.adSkusUnmatched,
          },
        });

        newBreakdown = {
          ...((target.breakdown as Record<string, unknown>) || {}),
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
          adsOverride: newAdsOverride,
          methodologyId: AMAZON_METHODOLOGY_ID,
          warnings: recomputedWarnings,
          perSkuRollup: {
            marketplaceNetProfitSum: marketplaceNetProfit,
            externalExpensesNet: money(expensesNow.net),
          },
        };

        reportPatch = {
          gross_sales: Number(settlementValue.toFixed(2)),
          total_cogs: Number(purchaseCost.toFixed(2)),
          total_fees: Number(totalFeesAbs.toFixed(2)),
          output_vat: Number(outputVat.toFixed(2)),
          input_vat: Number(inputVat.toFixed(2)),
          net_profit: Number(netProfit.toFixed(2)),
          breakdown: newBreakdown,
          cogs_vat_reclaim_pct: Number(Number(effectiveCogsVatPct).toFixed(2)),
        };
      } else {
        // -------- Temu recompute --------
        if (options.adOverride) {
          throw new Error(
            "Amazon-format ads uploads aren't supported for Temu reports. Use the Temu ads-report flow instead."
          );
        }
        const pnl = computeTemuPnl(aoa);
        if (pnl.rowsProcessed === 0) {
          throw new Error(
            `Recompute could not locate a recognisable Temu header row in the saved transactions (${allRows.length} rows scanned). Re-upload the original transaction sheet via "New Report" to refresh the saved data.`
          );
        }

        // Build the ads-report override from either the freshly uploaded
        // Temu ads file or the persisted Goods-level rows. Allocation is
        // computed live from the current `sku_mappings` so a later mapping
        // change is automatically reflected on recompute.
        let adOverride: TemuAdOverride | null = null;
        if (temuAdReport && temuAdReport.totalSpend > 0) {
          const goodsToSkuIds = await loadGoodsToSkuIdsMap(supabase, target.account_id);
          const allocation = allocateTemuAds({
            adReport: temuAdReport,
            pnl,
            goodsToSkuIds,
          });
          adOverride = {
            totalExvat: allocation.totalSpendExvat,
            spendBySku: allocation.spendBySku,
            unmatchedSpendExvat: allocation.unmatchedSpendExvat,
            sourceFilename: temuAdReport.sourceFilename,
            spendColumn: temuAdReport.spendColumn,
            goodsCount: temuAdReport.goodsCount,
          };
        }

        const totals = deriveTemuTotals({
          pnl,
          cogsLookup,
          vatRatePct: vatRate,
          defaultDateIso: target.period_start,
          cogsVatReclaimPct: effectiveCogsVatPct,
          adOverride,
        });
        const { lines, diagnostics: perSkuDiag } = computeTemuPerSku({
          pnl,
          cogsLookup,
          vatRatePct: vatRate,
          defaultDateIso: target.period_start,
          adOverride,
        });
        skuLines = lines;

        const missingSkus: string[] = [];
        const missingSkusWithSales: Array<{ sku: string; units: number; netSales: number }> = [];
        for (const line of skuLines) {
          if (line.units > 0 && !line.costKnown) {
            const upper = String(line.sku).toUpperCase();
            missingSkus.push(upper);
            missingSkusWithSales.push({ sku: upper, units: line.units, netSales: line.netSales });
          }
        }

        const purchaseCost = -totals.cogs;
        const settlementNet = totals.netSales + totals.totalTemuFeesExvat;
        const coreOperatingProfit = Number(
          (totals.netSales + totals.cogs + totals.serviceFeesExvat + totals.advertisingExvat).toFixed(2)
        );
        const adjustmentsNet = Number((totals.operatingProfit - coreOperatingProfit).toFixed(2));
        const outputVat = totals.outputVat;
        const inputVatFees = totals.totalInputVatTemuFees;
        const inputVatPurchases = totals.inputVatCogs + expensesNow.vat;
        const inputVat = inputVatFees + inputVatPurchases;
        const netProfit = settlementNet - purchaseCost - expensesNow.net;
        const marketplaceNetProfit = Number(totals.operatingProfit.toFixed(2));
        const settlementValue = totals.settlementValue;
        const totalFeesAbs =
          Math.abs(totals.serviceFeesExvat) +
          Math.abs(totals.advertisingExvat) +
          Math.abs(totals.shippingLabelsExvat) +
          Math.abs(totals.penaltiesExvat);

        // Mirror the workbench: when an ads-report override is active,
        // surface its before/after on the breakdown so the saved-report
        // UI can display a callout (re-uses the existing Amazon shape).
        const advertisingExvatTxn =
          pnl.advertisingGross - pnl.advertisingGross * (vatRate / 100 / (1 + vatRate / 100));
        newAdsOverride = adOverride
          ? {
              previousAdExvat: Number(advertisingExvatTxn.toFixed(2)),
              newAdExvat: Number((-Math.abs(adOverride.totalExvat)).toFixed(2)),
              adReportTotal: Number(adOverride.totalExvat.toFixed(2)),
              blankSkuSpend: Number(adOverride.unmatchedSpendExvat.toFixed(2)),
              sourceFilename: adOverride.sourceFilename || "",
            }
          : null;

        recomputedWarnings = deriveReportWarnings({
          missingSkus,
          missingSkusWithSales,
          netProfit: Number(netProfit.toFixed(2)),
          outputVat: Number(outputVat.toFixed(2)),
          inputVat: Number(inputVat.toFixed(2)),
          skuLines: skuLines.map((l) => ({
            sku: l.sku,
            netProfit: l.netProfit,
            netSales: l.netSales,
            units: l.units,
            costKnown: l.costKnown,
            adOnly: l.adOnly,
          })),
          accountNetProfit: Number(netProfit.toFixed(2)),
          skuReconcileBaseline: marketplaceNetProfit,
          adOverride: newAdsOverride
            ? {
                adReportTotal: newAdsOverride.adReportTotal,
                previousAdExvat: newAdsOverride.previousAdExvat,
              }
            : null,
          periodStart: target.period_start,
          periodEnd: target.period_end,
          rowsProcessed: pnl.rowsProcessed,
          rowsSkipped: pnl.rowsSkipped,
          netSales: totals.netSales,
          productSalesRefunds:
            pnl.refundRetail +
            pnl.refundPlatformDiscount +
            pnl.refundSellerDiscount +
            pnl.refundPlatformIncentive,
          vatRatePct: vatRate,
          currency,
          diagnostics: {
            deliveryUnmatched: totals.shippingLabelsUnmatchedSpend,
            retrochargeUnmatched: 0,
            reimburseUnallocated: 0,
            adSkusUnmatched: perSkuDiag.adOnlySkus.reduce<Record<string, number>>(
              (acc, sku) => ({ ...acc, [sku]: 0 }),
              {}
            ),
          },
        });

        newBreakdown = {
          ...((target.breakdown as Record<string, unknown>) || {}),
          platform: "temu" as const,
          summaryLines: [
            { label: "Order Payments", value: Number(pnl.orderTotal.toFixed(2)) },
            { label: "Refunds", value: Number(pnl.refundTotal.toFixed(2)) },
            {
              label: "Service Fees",
              value: Number((pnl.orderServiceFeeGross + pnl.refundServiceFeeGross).toFixed(2)),
            },
            {
              label: "Advertising",
              value: adOverride
                ? Number((-Math.abs(adOverride.totalExvat) * (1 + vatRate / 100)).toFixed(2))
                : Number(pnl.advertisingGross.toFixed(2)),
            },
            {
              label: "Shipping Labels & Adjustments",
              value: Number(
                (
                  pnl.shippingLabelPurchaseGross +
                  pnl.shippingLabelAdjustmentGross +
                  pnl.returnShippingPurchaseGross +
                  pnl.returnShippingAdjustmentGross
                ).toFixed(2)
              ),
            },
            {
              label: "Return Shipping Credit",
              value: Number(
                (
                  pnl.returnShippingPlatformGross +
                  pnl.returnShippingPlatformAdjGross +
                  pnl.returnShippingCreditGross
                ).toFixed(2)
              ),
            },
            { label: "Chargebacks", value: Number(pnl.chargebackGross.toFixed(2)) },
            { label: "Penalties", value: Number(pnl.abnormalFulfillmentGross.toFixed(2)) },
            { label: "Seller Repayment", value: Number(pnl.sellerRepaymentGross.toFixed(2)) },
          ],
          settlementLabel: "Net Temu Settlement (incl VAT)",
          settlementValue: Number(settlementValue.toFixed(2)),
          transferLabel: "Transfers to Bank",
          transferValue: Number(totals.bankTransfers.toFixed(2)),
          pnl: {
            settlementNet: Number(settlementNet.toFixed(2)),
            purchaseCost: Number(purchaseCost.toFixed(2)),
            netProfit: Number(netProfit.toFixed(2)),
            coreOperatingProfit,
            adjustmentsNet,
          },
          vat: {
            outputVat: Number(outputVat.toFixed(2)),
            inputVatFees: Number(inputVatFees.toFixed(2)),
            inputVatPurchases: Number(inputVatPurchases.toFixed(2)),
            finalVat: Number((outputVat - inputVat).toFixed(2)),
          },
          adsOverride: newAdsOverride,
          methodologyId: TEMU_METHODOLOGY_ID,
          warnings: recomputedWarnings,
          perSkuRollup: {
            marketplaceNetProfitSum: marketplaceNetProfit,
            externalExpensesNet: money(expensesNow.net),
          },
        };

        reportPatch = {
          gross_sales: Number(settlementValue.toFixed(2)),
          total_cogs: Number(purchaseCost.toFixed(2)),
          total_fees: Number(totalFeesAbs.toFixed(2)),
          output_vat: Number(outputVat.toFixed(2)),
          input_vat: Number(inputVat.toFixed(2)),
          net_profit: Number(netProfit.toFixed(2)),
          breakdown: newBreakdown,
          cogs_vat_reclaim_pct: Number(Number(effectiveCogsVatPct).toFixed(2)),
        };
      }

      const { error: reportError } = await supabase.from("reports").update(reportPatch).eq("id", target.id);
      if (reportError) throw reportError;

      // 6) Replace per-SKU breakdown
      const { error: clearSkuError } = await supabase
        .from("report_sku_breakdowns")
        .delete()
        .eq("report_id", target.id);
      if (clearSkuError) throw clearSkuError;
      const skuPayload = skuLines.map((line) => ({
        report_id: target.id,
        account_id: target.account_id,
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
      const CHUNK = 400;
      for (let i = 0; i < skuPayload.length; i += CHUNK) {
        const chunk = skuPayload.slice(i, i + CHUNK);
        const { error: insErr } = await supabase.from("report_sku_breakdowns").insert(chunk);
        if (insErr) throw insErr;
      }

      // 7) If the caller supplied a fresh ads report, replace ad_meta + ad_spend.
      if (options.adOverride) {
        // Amazon SKU-level rows.
        await supabase.from("report_ad_meta").delete().eq("report_id", target.id);
        await supabase.from("report_ad_spend").delete().eq("report_id", target.id);
        const matchedSkuSet = new Set(skuLines.map((l) => l.sku));
        let matchedCount = 0;
        let unmatchedCount = 0;
        const adPayload: Array<{
          report_id: string;
          account_id: string;
          sku: string | null;
          spend_exvat: number;
          matched: boolean;
          source_kind: string;
        }> = [];
        for (const [sku, spend] of Object.entries(options.adOverride.spendBySku)) {
          const matched = matchedSkuSet.has(sku);
          if (matched) matchedCount += 1;
          else unmatchedCount += 1;
          adPayload.push({
            report_id: target.id,
            account_id: target.account_id,
            sku,
            spend_exvat: Number(spend.toFixed(2)),
            matched,
            source_kind: "amazon_sku",
          });
        }
        if (options.adOverride.blankSkuSpend > 0) {
          adPayload.push({
            report_id: target.id,
            account_id: target.account_id,
            sku: null,
            spend_exvat: Number(options.adOverride.blankSkuSpend.toFixed(2)),
            matched: false,
            source_kind: "amazon_sku",
          });
        }
        await supabase.from("report_ad_meta").insert({
          report_id: target.id,
          account_id: target.account_id,
          source_filename: options.adOverride.sourceFilename,
          total_spend_exvat: Number(options.adOverride.totalSpend.toFixed(2)),
          blank_sku_spend: Number(options.adOverride.blankSkuSpend.toFixed(2)),
          matched_sku_count: matchedCount,
          unmatched_sku_count: unmatchedCount,
        });
        for (let i = 0; i < adPayload.length; i += CHUNK) {
          const chunk = adPayload.slice(i, i + CHUNK);
          const { error: insErr } = await supabase.from("report_ad_spend").insert(chunk);
          if (insErr) throw insErr;
        }
      }

      if (options.temuAdOverride) {
        // Temu Goods-level rows. Per-SKU allocation isn't persisted; it's
        // recomputed at render-time against the current sku_mappings.
        const adReport = options.temuAdOverride;
        await supabase.from("report_ad_meta").delete().eq("report_id", target.id);
        await supabase.from("report_ad_spend").delete().eq("report_id", target.id);
        let matchedCount = 0;
        let unmatchedCount = 0;
        const adPayload: Array<{
          report_id: string;
          account_id: string;
          sku: string | null;
          temu_goods_id: string | null;
          goods_name: string | null;
          spend_exvat: number;
          matched: boolean;
          source_kind: string;
        }> = [];
        for (const [goodsId, spend] of Object.entries(adReport.spendByGoodsId)) {
          matchedCount += 1;
          adPayload.push({
            report_id: target.id,
            account_id: target.account_id,
            sku: null,
            temu_goods_id: goodsId,
            goods_name: adReport.goodsNameByGoodsId[goodsId] || null,
            spend_exvat: Number(spend.toFixed(2)),
            matched: true,
            source_kind: "temu_goods",
          });
        }
        if (adReport.blankGoodsSpend > 0) {
          unmatchedCount += 1;
          adPayload.push({
            report_id: target.id,
            account_id: target.account_id,
            sku: null,
            temu_goods_id: null,
            goods_name: null,
            spend_exvat: Number(adReport.blankGoodsSpend.toFixed(2)),
            matched: false,
            source_kind: "temu_goods",
          });
        }
        await supabase.from("report_ad_meta").insert({
          report_id: target.id,
          account_id: target.account_id,
          source_filename: adReport.sourceFilename,
          total_spend_exvat: Number(adReport.totalSpend.toFixed(2)),
          blank_sku_spend: Number(adReport.blankGoodsSpend.toFixed(2)),
          matched_sku_count: matchedCount,
          unmatched_sku_count: unmatchedCount,
        });
        for (let i = 0; i < adPayload.length; i += CHUNK) {
          const chunk = adPayload.slice(i, i + CHUNK);
          const { error: insErr } = await supabase.from("report_ad_spend").insert(chunk);
          if (insErr) throw insErr;
        }
      }

      if (isForeground) {
        setMessage(options.statusMessage ?? "Recomputed with current methodology.");
      }
      if (options.refreshUiAfter !== false) {
        await loadReports(pageOffset);
        if (selected && target.id === selected.id) {
          await loadPerSkuAndAds(target.id);
        }
      }
      return true;
    } catch (err) {
      const text = err instanceof Error ? err.message : "Recompute failed.";
      if (isForeground) {
        setError(text);
        await pushClientNotification({
          title: "Recompute failed",
          body: text,
          level: "error",
          eventKey: `report-recompute-fail:${target.id}:${Date.now()}`,
        });
      }
      return false;
    } finally {
      if (isForeground) setRecomputing(false);
    }
  };

  const autoUpgradeOutdatedReports = async () => {
    if (autoMigrationRunningRef.current) return;
    const supabase = createClient();
    const allReports: SavedReport[] = [];
    const PAGE = 500;
    for (let from = 0; ; from += PAGE) {
      const { data, error: scanError } = await supabase
        .from("reports")
        .select(
          "id, account_id, platform, period_start, period_end, gross_sales, total_cogs, total_fees, output_vat, input_vat, net_profit, cogs_vat_reclaim_pct, source, breakdown"
        )
        .eq("account_id", accountId)
        .order("period_start", { ascending: false })
        .range(from, from + PAGE - 1);
      if (scanError || !data) break;
      allReports.push(...(data as SavedReport[]));
      if (data.length < PAGE) break;
    }
    const outdated = allReports.filter(
      (report) =>
        !isReportMethodologyCurrent(report) &&
        !autoMigrationAttemptedRef.current.has(report.id)
    );
    if (outdated.length === 0) return;

    autoMigrationRunningRef.current = true;
    let upgradedAmazon = 0;
    let upgradedTemu = 0;
    for (const report of outdated) {
      autoMigrationAttemptedRef.current.add(report.id);
      const ok = await recomputeReport({
        targetReport: report,
        silent: true,
        refreshUiAfter: false,
      });
      if (ok) {
        if (report.platform === "amazon") upgradedAmazon += 1;
        if (report.platform === "temu") upgradedTemu += 1;
      }
    }

    await loadReports(pageOffset);
    if (selectedId) await loadPerSkuAndAds(selectedId);
    const upgraded = upgradedAmazon + upgradedTemu;
    if (upgraded > 0) {
      const parts: string[] = [];
      if (upgradedAmazon > 0) {
        parts.push(
          `${upgradedAmazon} Amazon report${upgradedAmazon === 1 ? "" : "s"} (accrual Released + Deferred)`
        );
      }
      if (upgradedTemu > 0) {
        parts.push(
          `${upgradedTemu} Temu report${upgradedTemu === 1 ? "" : "s"} (transfer/unknown alignment)`
        );
      }
      setMessage(`Auto-updated ${parts.join(" and ")} to the current methodology.`);
    }
    autoMigrationRunningRef.current = false;
  };

  const onUpdateAdsClick = () => {
    if (!selected) return;
    adFileInputRef.current?.click();
  };

  const onAdsFilePicked = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file || !selected) return;
    setAdUpdating(true);
    setError(null);
    setMessage(null);
    try {
      if (selected.platform === "temu") {
        const parsed = await loadTemuAdReport(file);
        await recomputeReport({
          temuAdOverride: parsed,
          statusMessage: `Temu ads report uploaded — ${parsed.goodsCount} Goods, ${currency}${parsed.totalSpend.toFixed(2)} total. Report recomputed.`,
        });
      } else {
        const parsed = await loadAdReport(file);
        await recomputeReport({
          adOverride: parsed,
          statusMessage: `Ads report uploaded — ${parsed.skuCount} SKUs, ${currency}${parsed.totalSpend.toFixed(2)} total. Report recomputed.`,
        });
      }
    } catch (err) {
      const text = err instanceof Error ? err.message : "Failed to upload ads report.";
      setError(text);
    } finally {
      setAdUpdating(false);
    }
  };

  useEffect(() => {
    setPageOffset(0);
    autoMigrationAttemptedRef.current = new Set();
    void loadReports(0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accountId]);

  useEffect(() => {
    if (loading) return;
    void autoUpgradeOutdatedReports();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, reports]);

  useEffect(() => {
    if (!selected) return;
    const persisted =
      selected.breakdown && typeof (selected.breakdown as { manualNotesPdf?: unknown }).manualNotesPdf === "string"
        ? String((selected.breakdown as { manualNotesPdf: string }).manualNotesPdf)
        : "";
    setExportNotes(persisted);
    setExpenses([]);
    setSkuRows([]);
    setAdMeta(null);
    setCogsVatPctDraft(Number(selected.cogs_vat_reclaim_pct ?? 100));
    void loadExpenses(selected);
    void loadPerSkuAndAds(selected.id);
  }, [selected]);

  const saveChanges = async () => {
    if (!selected) return;

    setSaving(true);
    setError(null);
    setMessage(null);

    try {
      const supabase = createClient();

      const newTotals = computeExpenseTotals(expenses, vatRate);
      const reportPatch = {
        gross_sales: money(Number(selected.gross_sales || 0)),
        total_cogs: money(Number(selected.total_cogs || 0)),
        total_fees: money(Number(selected.total_fees || 0)),
        output_vat: isZeroVatAccount ? 0 : money(Number(selected.output_vat || 0)),
        input_vat: isZeroVatAccount ? 0 : money(Number(selected.input_vat || 0)),
        net_profit: money(Number(selected.net_profit || 0)),
      };

      const skuMarketplaceSubtotal = skuRows.reduce((acc, r) => acc + Number(r.net_profit || 0), 0);

      const nextBreakdown =
        selected.breakdown && typeof selected.breakdown === "object"
          ? {
              ...selected.breakdown,
              manualNotesPdf: exportNotes.trim(),
              perSkuRollup: {
                marketplaceNetProfitSum: money(skuMarketplaceSubtotal),
                externalExpensesNet: money(newTotals.net),
              },
              pnl: {
                ...((selected.breakdown as { pnl?: Record<string, unknown> }).pnl || {}),
                purchaseCost: reportPatch.total_cogs,
                netProfit: reportPatch.net_profit,
              },
              vat: {
                ...((selected.breakdown as { vat?: Record<string, unknown> }).vat || {}),
                outputVat: reportPatch.output_vat,
                finalVat: money(reportPatch.output_vat - reportPatch.input_vat),
              },
            }
          : selected.breakdown;

      const { error: reportError } = await supabase
        .from("reports")
        .update({ ...reportPatch, breakdown: nextBreakdown })
        .eq("id", selected.id);
      if (reportError) throw reportError;

      setMessage("Saved report notes.");
      await loadReports(pageOffset);
    } catch (err) {
      const text = err instanceof Error ? err.message : "Failed to save changes.";
      setError(text);
      await pushClientNotification({
        title: "Report edit failed",
        body: text,
        level: "error",
        eventKey: `saved-report-edit-fail:${selected.id}:${Date.now()}`,
      });
    } finally {
      setSaving(false);
    }
  };

  const deleteSelectedReport = async () => {
    if (!selected) return;
    if (!window.confirm("Delete this saved report period?")) return;
    setSaving(true);
    setError(null);
    setMessage(null);
    try {
      const supabase = createClient();
      const accountIdForRefresh = selected.account_id;
      const { error: deleteError } = await supabase.from("reports").delete().eq("id", selected.id);
      if (deleteError) throw deleteError;
      // Keep the inventory sales-facts cache in sync so removed transactions
      // disappear from Overview & Velocity immediately.
      try {
        await supabase.rpc("refresh_inventory_sales_facts", { p_account_id: accountIdForRefresh });
      } catch {
        /* non-fatal */
      }
      setMessage("Report deleted.");
      await loadReports(pageOffset);
    } catch (err) {
      const text = err instanceof Error ? err.message : "Failed to delete report.";
      setError(text);
      await pushClientNotification({
        title: "Report delete failed",
        body: text,
        level: "error",
        eventKey: `saved-report-delete-fail:${selected.id}:${Date.now()}`,
      });
    } finally {
      setSaving(false);
    }
  };

  const downloadPdf = async () => {
    if (!selected) return;

    setDownloading(true);
    setError(null);

    try {
      const query = new URLSearchParams();
      if (exportNotes.trim()) query.set("notes", exportNotes.trim());
      const url = `/api/reports/${selected.id}/pdf${query.toString() ? `?${query.toString()}` : ""}`;

      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`PDF export failed (${response.status})`);
      }

      const blob = await response.blob();
      const objectUrl = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = objectUrl;
      const safeAccount = accountName.replace(/[^a-zA-Z0-9-]/g, "-");
      a.download = `${safeAccount}-profitability-${selected.platform}-${selected.period_start}.pdf`;
      a.click();
      URL.revokeObjectURL(objectUrl);
      setMessage("PDF exported.");
    } catch (err) {
      const text = err instanceof Error ? err.message : "Failed to export PDF.";
      setError(text);
      await pushClientNotification({
        title: "PDF export failed",
        body: text,
        level: "error",
        eventKey: `report-pdf-fail:${selected.id}:${Date.now()}`,
      });
    } finally {
      setDownloading(false);
    }
  };

  const emailPdfToClient = async () => {
    if (!selected) return;
    if (!window.confirm("Send this report PDF by email to all assigned clients of this account?")) return;

    setEmailing(true);
    setError(null);
    try {
      const query = new URLSearchParams({ email: "1" });
      if (exportNotes.trim()) query.set("notes", exportNotes.trim());
      const response = await fetch(`/api/reports/${selected.id}/pdf?${query.toString()}`);
      const payload = (await response.json().catch(() => ({}))) as {
        ok?: boolean;
        sent?: boolean;
        recipients?: string[];
        error?: string;
        skipped?: string;
      };
      if (!response.ok || payload.ok === false) {
        throw new Error(payload.error || `Email send failed (${response.status})`);
      }
      if (payload.skipped) {
        throw new Error(payload.skipped);
      }
      const list = (payload.recipients || []).join(", ");
      setMessage(`Report emailed to ${payload.recipients?.length || 0} recipient${(payload.recipients?.length || 0) === 1 ? "" : "s"}${list ? `: ${list}` : ""}.`);
    } catch (err) {
      const text = err instanceof Error ? err.message : "Failed to send report by email.";
      setError(text);
      await pushClientNotification({
        title: "Email send failed",
        body: text,
        level: "error",
        eventKey: `report-email-fail:${selected.id}:${Date.now()}`,
      });
    } finally {
      setEmailing(false);
    }
  };

  const toggleReportForCombine = (id: string) => {
    setSelectedForCombine((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  };

  const validateContinuousSelection = () => {
    const selectedRows = reports.filter((r) => selectedForCombine.includes(r.id));
    if (selectedRows.length < 2) return "Select at least 2 reports.";
    const platform = selectedRows[0].platform;
    if (selectedRows.some((r) => r.platform !== platform)) return "You cannot mix Amazon and Temu in one combined file.";
    const sorted = [...selectedRows].sort((a, b) => (a.period_start < b.period_start ? -1 : 1));
    for (let i = 1; i < sorted.length; i++) {
      const expectedStart = addDays(sorted[i - 1].period_end, 1);
      if (sorted[i].period_start !== expectedStart) {
        return `Date gap found between ${formatUkDate(sorted[i - 1].period_end)} and ${formatUkDate(sorted[i].period_start)}.`;
      }
    }
    return null;
  };

  const downloadCombinedPdf = async () => {
    const validation = validateContinuousSelection();
    if (validation) {
      setError(validation);
      return;
    }
    setDownloading(true);
    setError(null);
    try {
      const response = await fetch("/api/reports/combined/pdf", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reportIds: selectedForCombine, notes: exportNotes.trim() || undefined }),
      });
      if (!response.ok) throw new Error(`Combined PDF failed (${response.status})`);
      const blob = await response.blob();
      const objectUrl = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = objectUrl;
      const safeAccount = accountName.replace(/[^a-zA-Z0-9-]/g, "-");
      a.download = `${safeAccount}-combined-profitability-report.pdf`;
      a.click();
      URL.revokeObjectURL(objectUrl);
      setMessage("Combined PDF exported.");
    } catch (err) {
      const text = err instanceof Error ? err.message : "Failed to export combined PDF.";
      setError(text);
      await pushClientNotification({
        title: "Combined PDF export failed",
        body: text,
        level: "error",
        eventKey: `combined-pdf-fail:${accountId}:${Date.now()}`,
      });
    } finally {
      setDownloading(false);
    }
  };

  const emailCombinedPdfToClient = async () => {
    const validation = validateContinuousSelection();
    if (validation) {
      setError(validation);
      return;
    }
    if (!window.confirm("Send the combined PDF by email to all assigned clients of this account?")) return;
    setEmailing(true);
    setError(null);
    try {
      const response = await fetch("/api/reports/combined/pdf", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          reportIds: selectedForCombine,
          notes: exportNotes.trim() || undefined,
          mode: "email",
        }),
      });
      const payload = (await response.json().catch(() => ({}))) as {
        ok?: boolean;
        recipients?: string[];
        error?: string;
        skipped?: string;
      };
      if (!response.ok || payload.ok === false) {
        throw new Error(payload.error || `Combined email send failed (${response.status})`);
      }
      if (payload.skipped) {
        throw new Error(payload.skipped);
      }
      const list = (payload.recipients || []).join(", ");
      setMessage(`Combined report emailed to ${payload.recipients?.length || 0} recipient${(payload.recipients?.length || 0) === 1 ? "" : "s"}${list ? `: ${list}` : ""}.`);
    } catch (err) {
      const text = err instanceof Error ? err.message : "Failed to send combined report by email.";
      setError(text);
      await pushClientNotification({
        title: "Combined email send failed",
        body: text,
        level: "error",
        eventKey: `combined-email-fail:${accountId}:${Date.now()}`,
      });
    } finally {
      setEmailing(false);
    }
  };

  const missingForSelectedPeriod = Boolean(filterStart && filterEnd && reports.length === 0);

  return (
    <div className="space-y-4 rounded-2xl border border-slate-200 bg-white p-4">
      {message || error ? (
        <div
          className={`fixed left-1/2 top-6 z-[120] w-[min(100%,28rem)] -translate-x-1/2 px-4 shadow-2xl transition-transform ${
            error
              ? "rounded-2xl border-2 border-red-300 bg-red-50 text-red-900"
              : "rounded-2xl border-2 border-emerald-300 bg-emerald-50 text-emerald-900"
          }`}
          role="alert"
          aria-live="assertive"
        >
          <div className="flex items-start gap-3 py-3">
            <span className="text-2xl leading-none">{error ? "⚠" : "✓"}</span>
            <p className="flex-1 pt-0.5 text-sm font-semibold leading-snug">{error || message}</p>
            <button
              type="button"
              onClick={() => {
                setMessage(null);
                setError(null);
              }}
              className="rounded-lg px-2 py-1 text-xs font-bold text-slate-600 hover:bg-black/5"
            >
              ✕
            </button>
          </div>
        </div>
      ) : null}

      <div className="flex flex-wrap items-end gap-2">
        <div>
          <label className="mb-1 block text-xs font-medium uppercase tracking-wide text-slate-500">History Start</label>
          <input
            type="date"
            value={filterStart}
            onChange={(e) => setFilterStart(e.target.value)}
            className="rounded-xl border border-slate-300 px-3 py-2 text-sm"
          />
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium uppercase tracking-wide text-slate-500">History End</label>
          <input
            type="date"
            value={filterEnd}
            onChange={(e) => setFilterEnd(e.target.value)}
            className="rounded-xl border border-slate-300 px-3 py-2 text-sm"
          />
        </div>
        <button onClick={() => void loadReports(pageOffset)} className="rounded-xl bg-slate-100 px-4 py-2 text-sm font-semibold text-slate-700">
          Refresh
        </button>
        <button
          onClick={downloadCombinedPdf}
          disabled={downloading || selectedForCombine.length < 2}
          className="rounded-xl bg-slate-900 px-4 py-2 text-sm font-semibold text-white disabled:opacity-60"
        >
          {downloading ? "Generating..." : "Download Combined PDF"}
        </button>
        {canEdit ? (
          <button
            onClick={emailCombinedPdfToClient}
            disabled={emailing || selectedForCombine.length < 2}
            title="Email the combined PDF to all assigned clients of this account"
            className="rounded-xl bg-[var(--md-primary)] px-4 py-2 text-sm font-semibold text-white disabled:opacity-60"
          >
            {emailing ? "Emailing..." : "Email Combined to Client"}
          </button>
        ) : null}
      </div>
      <div className="flex flex-wrap items-center justify-end gap-2">
        <span className="text-xs text-slate-500">
          Page {currentPage} of {totalPages} ({totalCount} items)
        </span>
        <select
          value={currentPage}
          onChange={(e) => {
            const targetPage = Number(e.target.value);
            const next = Math.max(0, (targetPage - 1) * PAGE_SIZE);
            setPageOffset(next);
            void loadReports(next);
          }}
          className="rounded-lg border border-slate-300 px-2 py-1.5 text-xs"
        >
          {Array.from({ length: totalPages }, (_, i) => i + 1).map((page) => (
            <option key={page} value={page}>
              {page}
            </option>
          ))}
        </select>
        <button
          type="button"
          onClick={() => {
            const next = Math.max(0, pageOffset - PAGE_SIZE);
            setPageOffset(next);
            void loadReports(next);
          }}
          disabled={pageOffset === 0 || loading}
          className="rounded-lg bg-slate-100 px-3 py-1.5 text-xs font-semibold text-slate-700 disabled:opacity-50"
        >
          Previous
        </button>
        <button
          type="button"
          onClick={() => {
            const next = pageOffset + PAGE_SIZE;
            setPageOffset(next);
            void loadReports(next);
          }}
          disabled={currentPage >= totalPages || loading}
          className="rounded-lg bg-slate-100 px-3 py-1.5 text-xs font-semibold text-slate-700 disabled:opacity-50"
        >
          Next
        </button>
      </div>

      {missingForSelectedPeriod ? (
        <div className="rounded-2xl border border-yellow-200 bg-yellow-50 p-3 text-sm text-yellow-800">
          Report missing for this period.
        </div>
      ) : null}

      {loading ? (
        <p className="text-sm text-slate-500">Loading saved reports...</p>
      ) : reports.length === 0 ? (
        <p className="text-sm text-slate-500">No saved reports found for this account/filter.</p>
      ) : (
        <div className="grid gap-3 md:grid-cols-[260px_1fr]">
          <div className="space-y-2">
            {reports.map((report) => (
              <button
                key={report.id}
                onClick={() => setSelectedId(report.id)}
                className={`w-full rounded-xl border px-3 py-2 text-left text-sm ${
                  selectedId === report.id
                    ? "border-[var(--md-primary)] bg-[var(--md-primary-container)]"
                    : "border-slate-200 bg-white"
                }`}
              >
                <div className="mb-1 flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={selectedForCombine.includes(report.id)}
                    onClick={(e) => e.stopPropagation()}
                    onChange={() => toggleReportForCombine(report.id)}
                  />
                  <p className="font-semibold capitalize">{report.platform}</p>
                  {report.source === "sp_api" ? (
                    <span
                      className="rounded-full bg-[var(--md-primary-container)] px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-[var(--md-secondary)]"
                      title="Auto-synced from Amazon SP-API"
                    >
                      SP-API
                    </span>
                  ) : (
                    <span
                      className="rounded-full bg-slate-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-slate-600"
                      title="Uploaded manually via CSV"
                    >
                      Manual
                    </span>
                  )}
                </div>
                <p className="text-xs text-slate-500">
                  {formatUkDate(report.period_start)} to {formatUkDate(report.period_end)}
                </p>
                <p className="mt-1 text-xs text-slate-600">
                  Net: {currency}
                  {Number(
                    typeof currentNetByReportId[report.id] === "number"
                      ? currentNetByReportId[report.id]
                      : Number(report.net_profit || 0)
                  ).toFixed(2)}
                </p>
              </button>
            ))}
          </div>

          {selected ? (
            <div className="space-y-4 rounded-2xl border border-slate-200 bg-white p-4">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div>
                  <h5 className="text-sm font-semibold text-slate-800">Report Detail</h5>
                  <p className="mt-1 text-xs text-slate-500">
                    {canEdit ? (
                      <>
                        Calculated values are read-only. Expenses are pulled from the Expenses page. Use{" "}
                        <span className="font-semibold">Save edits</span> to store PDF notes.
                      </>
                    ) : (
                      <>Read-only access: you can download PDFs; ask your administrator to change expenses or notes.</>
                    )}
                  </p>
                </div>
                <div className="flex flex-shrink-0 flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={downloadPdf}
                    disabled={downloading}
                    className="rounded-xl bg-slate-900 px-4 py-2 text-sm font-semibold text-white disabled:opacity-60"
                  >
                    {downloading ? "PDF…" : "Download PDF"}
                  </button>
                  {canEdit ? (
                    <button
                      type="button"
                      onClick={emailPdfToClient}
                      disabled={emailing}
                      title="Email this report PDF to all assigned clients of this account"
                      className="rounded-xl bg-[var(--md-primary)] px-4 py-2 text-sm font-semibold text-white disabled:opacity-60"
                    >
                      {emailing ? "Emailing…" : "Email to Client"}
                    </button>
                  ) : null}
                  {canEdit ? (
                    <>
                      <button
                        type="button"
                        onClick={saveChanges}
                        disabled={saving}
                        className="rounded-xl bg-[var(--md-primary)] px-4 py-2 text-sm font-semibold text-white disabled:opacity-60"
                      >
                        {saving ? "Saving…" : "Save edits"}
                      </button>
                      <button
                        type="button"
                        onClick={deleteSelectedReport}
                        disabled={saving}
                        className="rounded-xl bg-red-50 px-4 py-2 text-sm font-semibold text-red-700 disabled:opacity-60"
                      >
                        Delete report
                      </button>
                    </>
                  ) : null}
                </div>
              </div>

              {savedWarnings.length > 0 ? (
                <div className="rounded-2xl border border-yellow-200 bg-yellow-50 p-3 text-sm text-yellow-800">
                  <p className="mb-1 font-semibold">Data quality warnings</p>
                  <ul className="list-disc space-y-0.5 pl-5">
                    {savedWarnings.map((warning, idx) => (
                      <li key={`${idx}-${warning.slice(0, 40)}`}>{warning}</li>
                    ))}
                  </ul>
                </div>
              ) : null}

              <div className="grid gap-3 md:grid-cols-3">
                <div className="rounded-2xl bg-slate-50 p-4">
                  <p className="text-xs text-slate-500">Total Product Sales</p>
                  <p className="text-xl font-semibold">{currency}{liveValues.productSales.toFixed(2)}</p>
                </div>
                <div className="rounded-2xl bg-slate-50 p-4">
                  <p className="text-xs text-slate-500">Total COGS</p>
                  <p className="text-xl font-semibold">{currency}{liveValues.totalCogs.toFixed(2)}</p>
                </div>
                <div className="rounded-2xl bg-slate-50 p-4">
                  <p className="text-xs text-slate-500">Total Fees</p>
                  <p className="text-xl font-semibold">{currency}{liveValues.totalFees.toFixed(2)}</p>
                </div>
                <div className="rounded-2xl bg-slate-50 p-4">
                  <p className="text-xs text-slate-500">Total Expenses</p>
                  <p className="text-xl font-semibold">{currency}{liveValues.totalExpenses.toFixed(2)}</p>
                </div>
                {!isZeroVatAccount ? (
                  <div className="rounded-2xl bg-slate-50 p-4">
                    <p className="text-xs text-slate-500">Output VAT</p>
                    <p className="text-xl font-semibold">{currency}{liveValues.outputVat.toFixed(2)}</p>
                  </div>
                ) : null}
                {!isZeroVatAccount ? (
                  <div className="rounded-2xl bg-slate-50 p-4">
                    <p className="text-xs text-slate-500">Input VAT</p>
                    <p className="text-xl font-semibold">{currency}{liveValues.inputVat.toFixed(2)}</p>
                  </div>
                ) : null}
                <div className="rounded-2xl bg-slate-50 p-4">
                  <p className="text-xs text-slate-500">Units Sold</p>
                  <p className="text-xl font-semibold">{liveValues.unitsSold.toLocaleString()}</p>
                </div>
              </div>

              <div className="rounded-2xl bg-slate-900 p-4 text-white">
                <p className="text-xs uppercase tracking-wide text-slate-300">Net Profit</p>
                <p className="text-2xl font-semibold">{currency}{liveValues.netProfit.toFixed(2)}</p>
              </div>

              {selected.platform === "temu" &&
              typeof (selected.breakdown as { pnl?: { coreOperatingProfit?: unknown; adjustmentsNet?: unknown } } | null)
                ?.pnl?.coreOperatingProfit === "number" &&
              typeof (selected.breakdown as { pnl?: { coreOperatingProfit?: unknown; adjustmentsNet?: unknown } } | null)
                ?.pnl?.adjustmentsNet === "number" ? (
                <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
                  <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-600">
                    Temu Profit Bridge
                  </p>
                  <div className="space-y-1 text-sm">
                    <div className="flex items-center justify-between">
                      <span className="text-slate-600">Core sales operating profit</span>
                      <span className="font-semibold text-slate-900">
                        {currency}
                        {Number(
                          (
                            selected.breakdown as {
                              pnl?: { coreOperatingProfit?: number; adjustmentsNet?: number };
                            }
                          )?.pnl?.coreOperatingProfit || 0
                        ).toFixed(2)}
                      </span>
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="text-slate-600">Adjustments net (labels/repayments/penalties)</span>
                      <span className="font-semibold text-slate-900">
                        {currency}
                        {Number(
                          (
                            selected.breakdown as {
                              pnl?: { coreOperatingProfit?: number; adjustmentsNet?: number };
                            }
                          )?.pnl?.adjustmentsNet || 0
                        ).toFixed(2)}
                      </span>
                    </div>
                    <div className="flex items-center justify-between border-t border-slate-200 pt-2">
                      <span className="font-semibold text-slate-800">Marketplace operating profit</span>
                      <span className="font-bold text-slate-900">
                        {currency}
                        {(
                          Number(
                            (
                              selected.breakdown as {
                                pnl?: { coreOperatingProfit?: number; adjustmentsNet?: number };
                              }
                            )?.pnl?.coreOperatingProfit || 0
                          ) +
                          Number(
                            (
                              selected.breakdown as {
                                pnl?: { coreOperatingProfit?: number; adjustmentsNet?: number };
                              }
                            )?.pnl?.adjustmentsNet || 0
                          )
                        ).toFixed(2)}
                      </span>
                    </div>
                  </div>
                </div>
              ) : null}

              {selected.breakdown?.adsOverride ? (
                <div className="rounded-2xl bg-blue-50 px-4 py-2 text-xs text-blue-800">
                  Advertising figure replaced with uploaded ads report ({currency}
                  {Number(selected.breakdown.adsOverride.adReportTotal || 0).toFixed(2)} from{" "}
                  <span className="font-mono">{selected.breakdown.adsOverride.sourceFilename || "—"}</span>
                  ).
                </div>
              ) : null}

              <div className="space-y-2 rounded-xl border border-slate-200 p-3">
                <div className="flex items-center justify-between">
                  <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">External Expenses</p>
                  <a href={`/expenses?accountId=${encodeURIComponent(accountId)}`} className="text-xs font-semibold text-[var(--md-primary)] underline">
                    Manage expenses
                  </a>
                </div>
                <p className="text-xs text-slate-500">
                  Applied automatically from the Expenses page for this report period and marketplace.
                </p>
                {expenses.length === 0 ? <p className="text-sm text-slate-500">No expenses in this period.</p> : null}
                {expenses.map((expense) => (
                  <div key={expense.id} className="grid gap-2 rounded-lg border border-slate-100 p-2 text-sm md:grid-cols-[1fr_120px_140px_90px]">
                    <span className="text-slate-700">
                      {expense.description}
                      {expense.expense_type ? (
                        <span className="text-xs text-slate-500"> ({expense.expense_type === "recurring" ? "recurring" : "one time"})</span>
                      ) : null}
                      {expense.occurrence_date ? (
                        <span className="text-xs text-slate-500"> • {expense.occurrence_date}</span>
                      ) : null}
                    </span>
                    <span className="font-semibold text-slate-900">{currency}{Number(expense.amount || 0).toFixed(2)}</span>
                    <span className="text-slate-600">{expense.includes_vat ? "Inc VAT" : "Ex VAT"}</span>
                    <span />
                  </div>
                ))}
              </div>

              <div className="space-y-2 rounded-xl border border-slate-200 p-3">
                <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Manual notes (PDF)</p>
                <p className="text-xs text-slate-500">
                  Saved when you click <span className="font-semibold">Save edits</span>. Included in the PDF unless you
                  temporarily override via the optional query when downloading.
                </p>
                <textarea
                  value={exportNotes}
                  onChange={(e) => setExportNotes(e.target.value)}
                  rows={4}
                  disabled={!canEdit}
                  className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm disabled:bg-slate-100"
                  placeholder="Optional notes shown on the PDF after External Expenses..."
                />
              </div>

              <div className="space-y-2 rounded-xl border border-slate-200 p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                    Advertising Report
                  </p>
                  {canEdit ? (
                    <div className="flex gap-2">
                      <button
                        onClick={onUpdateAdsClick}
                        disabled={adUpdating || recomputing}
                        className="rounded-lg bg-slate-100 px-3 py-1 text-xs font-semibold text-slate-700 disabled:opacity-60"
                      >
                        {adUpdating ? "Uploading..." : adMeta ? "Replace ads report" : "Upload ads report"}
                      </button>
                      <button
                        onClick={() => void recomputeReport({ cogsVatReclaimPct: cogsVatPctDraft })}
                        disabled={recomputing || adUpdating}
                        className="rounded-lg bg-slate-900 px-3 py-1 text-xs font-semibold text-white disabled:opacity-60"
                        title="Re-runs the engine using the current methodology and any persisted ads-report data. Useful after uploading new COGS or upgrading the calculation logic."
                      >
                        {recomputing ? "Recomputing..." : "Recompute"}
                      </button>
                    </div>
                  ) : null}
                </div>
                <input
                  ref={adFileInputRef}
                  type="file"
                  accept=".csv,.xlsx"
                  onChange={(e) => void onAdsFilePicked(e)}
                  className="hidden"
                />
                {adMeta ? (
                  <div className="grid gap-2 text-xs text-slate-600 md:grid-cols-3">
                    <div>
                      <div className="text-slate-500">Source</div>
                      <div className="font-mono text-[11px]">{adMeta.source_filename || "—"}</div>
                    </div>
                    <div>
                      <div className="text-slate-500">Total spend (ex-VAT)</div>
                      <div className="font-semibold text-slate-900">
                        {currency}
                        {Number(adMeta.total_spend_exvat || 0).toFixed(2)}
                      </div>
                    </div>
                    <div>
                      <div className="text-slate-500">
                        {selected.platform === "temu" ? "Goods matched / unmatched" : "SKUs matched / unmatched"}
                      </div>
                      <div className="font-semibold text-slate-900">
                        {adMeta.matched_sku_count} / {adMeta.unmatched_sku_count}
                      </div>
                    </div>
                    <div className="md:col-span-3 text-[11px] text-slate-500">
                      Uploaded {formatUkDate(adMeta.uploaded_at?.slice(0, 10) || "")}.
                      {selected.platform === "temu"
                        ? ` Spend without a Goods ID redistributed across all selling SKUs by net sales: ${currency}${Number(adMeta.blank_sku_spend || 0).toFixed(2)}.`
                        : ` Blank-SKU spend redistributed to matched SKUs by report share: ${currency}${Number(adMeta.blank_sku_spend || 0).toFixed(2)}.`}
                    </div>
                  </div>
                ) : (
                  <p className="text-xs text-slate-500">
                    {selected.platform === "temu"
                      ? "No Temu ads report saved for this period yet. Without one, advertising costs are taken from the transaction sheet (account-level total, not per-SKU)."
                      : "No ads report saved for this period yet. Without one, advertising costs are allocated to SKUs pro-rata by net sales."}
                  </p>
                )}
              </div>

              {skuRows.length > 0 ? (
                <div className="space-y-2 rounded-xl border border-slate-200 p-3">
                  <div className="flex items-center justify-between">
                    <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                      Per-SKU Profitability ({skuRows.length} SKUs)
                    </p>
                  </div>
                  <p className="text-xs text-slate-600">
                    Per-SKU net profit covers marketplace activity only. External expenses are{" "}
                    <span className="font-semibold">not</span> allocated to individual SKUs; the roll-up below reconciles
                    to account net profit.
                  </p>
                  <PerSkuTable
                    rows={skuRows.map(savedSkuRowToTableRow)}
                    currency={currency}
                    detailed
                    csvFilename={`per-sku-${accountName.replace(/[^a-z0-9]+/gi, "-")}-${selected.platform}-${selected.period_start}_${selected.period_end}`}
                  />
                  <div className="mt-3 space-y-1 rounded-lg border border-slate-200 bg-slate-50 p-3 text-sm">
                    <div className="flex justify-between gap-2">
                      <span className="text-slate-600">Subtotal — sum of SKU net profits (marketplace)</span>
                      <span className="font-semibold tabular-nums text-slate-900">
                        {currency}
                        {skuRollupLive.marketplaceSubtotal.toFixed(2)}
                      </span>
                    </div>
                    <div className="flex justify-between gap-2">
                      <span className="text-slate-600">External expenses (net)</span>
                      <span className="font-semibold tabular-nums text-red-700">
                        −{currency}
                        {skuRollupLive.externalExpensesNet.toFixed(2)}
                      </span>
                    </div>
                    <div className="flex justify-between gap-2 border-t border-slate-200 pt-2">
                      <span className="font-semibold text-slate-800">Final net profit (matches summary above)</span>
                      <span className="font-bold tabular-nums text-slate-900">
                        {currency}
                        {liveValues.netProfit.toFixed(2)}
                      </span>
                    </div>
                  </div>
                </div>
              ) : (
                <div className="rounded-xl border border-slate-200 p-3 text-xs text-slate-500">
                  No per-SKU breakdown stored. Click <span className="font-semibold">Recompute</span>{" "}
                  to generate one using the current methodology.
                </div>
              )}

            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}
