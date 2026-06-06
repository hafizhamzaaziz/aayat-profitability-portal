"use client";

import { useEffect, useMemo, useState } from "react";
import Papa from "papaparse";
import * as XLSX from "xlsx";
import { createClient } from "@/lib/supabase/client";
import { pushClientNotification } from "@/lib/notifications/client";
import { deriveReportWarnings, validateBreakdown, validatePeriodRange } from "@/lib/reports/guardrails";
import FileDropzone from "@/components/ui/file-dropzone";
import { computeAmazonPnl, deriveTotals, applyAdReportOverride } from "@/lib/reports/amazon-pnl";
import { computePerSku } from "@/lib/reports/per-sku";
import { computeTemuPnl, deriveTemuTotals, computeTemuPerSku, type TemuAdOverride } from "@/lib/reports/temu-pnl";
import { computeTiktokPnl, deriveTiktokTotals, computeTiktokPerSku } from "@/lib/reports/tiktok-pnl";
import { loadAdReport } from "@/lib/reports/ad-report";
import { loadTemuAdReport, allocateTemuAds, type TemuAdReport } from "@/lib/reports/temu-ad-report";
import { buildBridgedCogsLookup } from "@/lib/reports/cogs-lookup";
import { AMAZON_METHODOLOGY_ID, TEMU_METHODOLOGY_ID, TIKTOK_METHODOLOGY_ID } from "@/lib/reports/methodology";
import { computeExpenseTotals } from "@/lib/reports/expense-totals";
import {
  computeExpenseOccurrencesForPeriod,
  type ExpenseLedgerRow,
  type ExpenseOccurrence,
} from "@/lib/reports/expense-ledger";
import type { AdReport, SkuLine } from "@/lib/reports/types";
import PerSkuTable, { type PerSkuRow } from "@/components/reports/per-sku-table";

type Platform = "amazon" | "temu" | "tiktok";

type RowData = Record<string, unknown>;

type CalculationPreview = {
  grossSales: number;
  totalCogs: number;
  totalFees: number;
  outputVat: number;
  inputVat: number;
  netProfit: number;
  /** Marketplace-only profit before manual external expenses; matches sum of SKU net profits after engine reconciliation. */
  marketplaceNetProfit: number;
  unitsSold: number;
  missingSkus: string[];
  cogsSnapshot: CogsSnapshotEntry[];
  breakdown: {
    platform: Platform;
    summaryLines: Array<{ label: string; value: number }>;
    settlementLabel: string;
    settlementValue: number;
    transferLabel: string;
    transferValue: number;
    pnl: {
      settlementNet: number;
      purchaseCost: number;
      netProfit: number;
      /** Optional Temu bridge: sales-led operating profit before adjustment bucket. */
      coreOperatingProfit?: number;
      /** Optional Temu bridge: non-sales adjustments (shipping labels/repayments/penalties). */
      adjustmentsNet?: number;
    };
    vat: {
      outputVat: number;
      inputVatFees: number;
      inputVatPurchases: number;
      finalVat: number;
    };
    /** Set when an ads report was uploaded and its total replaced the transaction-sheet ads figure. */
    adsOverride?: {
      previousAdExvat: number;
      newAdExvat: number;
      adReportTotal: number;
      blankSkuSpend: number;
      sourceFilename: string;
    } | null;
    methodologyId?: string;
    manualNotesPdf?: string;
    perSkuRollup?: {
      marketplaceNetProfitSum: number;
      externalExpensesNet: number;
    };
  };
  skuLines?: SkuLine[];
  /** Extra signals consumed by `deriveReportWarnings` (not persisted directly). */
  diagnostics?: {
    rowsProcessed: number;
    rowsSkipped: number;
    deliveryUnmatched: number;
    retrochargeUnmatched: number;
    reimburseUnallocated: number;
    netSales: number;
    productSalesRefunds: number;
    adSkusUnmatched: Record<string, number>;
    missingSkusWithSales: Array<{ sku: string; units: number; netSales: number }>;
  };
};

type CogsVersion = {
  unitCost: number;
  includesVat: boolean;
  effectiveFrom: string;
};

type CogsLookup = Map<string, CogsVersion[]>;

type CogsSnapshotEntry = {
  sku: string;
  quantity: number;
  unit_cost: number;
  includes_vat: boolean;
  effective_from: string;
};

type ReportTransactionPayload = {
  account_id: string;
  report_id: string;
  platform: Platform;
  transaction_date: string | null;
  sku: string | null;
  quantity: number | null;
  raw_row: RowData;
};

type Props = {
  account: {
    id: string;
    name: string;
    currency: string;
    vat_rate: number;
    cogs_vat_reclaim_pct?: number | null;
  };
  canProcess: boolean;
};

function applyZeroVatPresentation(result: CalculationPreview, vatRatePct: number, expensesNet: number): CalculationPreview {
  if (Number(vatRatePct) !== 0) return result;
  const uplift = (value: number) => Number((value * 1.2).toFixed(2));
  const upliftedSettlement = uplift(result.breakdown.pnl.settlementNet);
  return {
    ...result,
    grossSales: uplift(result.grossSales),
    totalFees: uplift(result.totalFees),
    outputVat: 0,
    inputVat: 0,
    netProfit: Number((upliftedSettlement - result.breakdown.pnl.purchaseCost - expensesNet).toFixed(2)),
    breakdown: {
      ...result.breakdown,
      summaryLines: result.breakdown.summaryLines.map((line) => ({ ...line, value: uplift(line.value) })),
      settlementValue: uplift(result.breakdown.settlementValue),
      transferValue: uplift(result.breakdown.transferValue),
      pnl: {
        ...result.breakdown.pnl,
        settlementNet: upliftedSettlement,
        netProfit: Number((upliftedSettlement - result.breakdown.pnl.purchaseCost - expensesNet).toFixed(2)),
      },
      vat: {
        outputVat: 0,
        inputVatFees: 0,
        inputVatPurchases: 0,
        finalVat: 0,
      },
    },
  };
}

function parseMoney(value: unknown) {
  if (value === null || value === undefined || value === "") return 0;
  const cleaned = String(value).replace(/[^0-9.-]/g, "");
  return Number.parseFloat(cleaned) || 0;
}

function norm(value: unknown) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function findHeaderAnyIncludes(row: RowData, terms: string[]) {
  return Object.keys(row).find((key) => {
    const n = norm(key);
    return terms.some((term) => n.includes(term));
  });
}

function autoPickHeader(headers: string[], terms: string[]) {
  const hit = headers.find((header) => {
    const n = norm(header).replace(/[^a-z]/g, "");
    return terms.some((term) => n.includes(term));
  });
  return hit ?? "";
}

function normalizeSkuToken(input: unknown) {
  const raw = String(input ?? "")
    .replace(/\u00a0/g, " ")
    .trim()
    .toUpperCase();
  if (!raw) return "";
  if (/^\d+\.0+$/.test(raw)) return raw.replace(/\.0+$/, "");
  return raw;
}

function toIsoDate(input: unknown): string | null {
  if (input == null) return null;
  if (typeof input === "number" && Number.isFinite(input) && input > 1000) {
    // Excel serial date fallback
    const epoch = new Date(Date.UTC(1899, 11, 30));
    const date = new Date(epoch.getTime() + input * 24 * 60 * 60 * 1000);
    return date.toISOString().slice(0, 10);
  }
  const text = String(input).trim();
  if (!text) return null;

  const iso = text.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;

  const dmy = text.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})/);
  if (dmy) {
    const day = Number(dmy[1]);
    const month = Number(dmy[2]);
    const yearRaw = Number(dmy[3]);
    const year = yearRaw < 100 ? 2000 + yearRaw : yearRaw;
    if (day >= 1 && day <= 31 && month >= 1 && month <= 12) {
      return `${year.toString().padStart(4, "0")}-${month.toString().padStart(2, "0")}-${day.toString().padStart(2, "0")}`;
    }
  }

  const dmyDots = text.match(/^(\d{1,2})\.(\d{1,2})\.(\d{2,4})/);
  if (dmyDots) {
    const day = Number(dmyDots[1]);
    const month = Number(dmyDots[2]);
    const yearRaw = Number(dmyDots[3]);
    const year = yearRaw < 100 ? 2000 + yearRaw : yearRaw;
    if (day >= 1 && day <= 31 && month >= 1 && month <= 12) {
      return `${year.toString().padStart(4, "0")}-${month.toString().padStart(2, "0")}-${day.toString().padStart(2, "0")}`;
    }
  }

  const parsed = new Date(text);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString().slice(0, 10);
}

function extractTransactionDate(row: RowData, fallbackIso: string): string {
  const preferred = Object.keys(row).filter((key) => {
    const n = norm(key);
    return (
      n.includes("date") ||
      n.includes("posted") ||
      n.includes("transaction time") ||
      n.includes("order time") ||
      n.includes("created time") ||
      n.includes("settlement")
    );
  });
  for (const key of preferred) {
    const parsed = toIsoDate(row[key]);
    if (parsed) return parsed;
  }
  return fallbackIso;
}

function resolveCogsVersion(cogsLookup: CogsLookup, sku: string, txDateIso: string) {
  const versions = cogsLookup.get(String(sku || "").toLowerCase());
  if (!versions || versions.length === 0) return null;
  let selected: CogsVersion | null = null;
  for (const version of versions) {
    if (version.effectiveFrom <= txDateIso) {
      selected = version;
    } else {
      break;
    }
  }
  // If no version existed yet on transaction date, fallback to earliest known cost.
  return selected || versions[0] || null;
}

function normalizeReportTransactions(input: {
  rows: RowData[];
  skuCol: string;
  qtyCol: string;
  periodStartIso: string;
  reportId: string;
  accountId: string;
  platform: Platform;
}) {
  return input.rows.map((row) => {
    const selectedSku = normalizeSkuToken(row[input.skuCol] ?? "");
    const fallbackSkuKey =
      input.platform === "temu"
        ? findHeaderAnyIncludes(row, ["sku id", "skuid", "temu sku"])
        : findHeaderAnyIncludes(row, ["sku", "seller sku", "merchant sku", "msku"]);
    const fallbackSku = fallbackSkuKey ? normalizeSkuToken(row[fallbackSkuKey] ?? "") : "";
    const sku = input.platform === "temu" ? (fallbackSku || selectedSku) : (selectedSku || fallbackSku);
    const qty = parseMoney(row[input.qtyCol]);
    const txDate = extractTransactionDate(row, input.periodStartIso);
    return {
      account_id: input.accountId,
      report_id: input.reportId,
      platform: input.platform,
      transaction_date: txDate || null,
      sku: sku || null,
      quantity: Number.isFinite(qty) ? qty : null,
      raw_row: row,
    } as ReportTransactionPayload;
  });
}

function computeExpenseTotalsFromOccurrences(occurrences: ExpenseOccurrence[], vatRatePct: number) {
  const mapped = occurrences.map((row) => ({
    amount: Number(row.amount || 0),
    includes_vat: Boolean(row.includes_vat),
  }));
  return computeExpenseTotals(mapped, vatRatePct);
}

/**
 * Temu P&L using the proper UK methodology (Order Payment + Refund tax columns
 * for output VAT, VAT-inclusive split on service fees / advertising / shipping
 * labels for input VAT, COGS reclaim, per-SKU back-attribution of shipping
 * labels by Order ID, pro-rata allocation of advertising/penalties).
 *
 * Returns the same `CalculationPreview` shape the rest of the UI expects so
 * the saved-reports panel + PDF keep working.
 */
function processTemu(input: {
  rows: RowData[];
  cogsLookup: CogsLookup;
  vatRatePct: number;
  expenses: { net: number; vat: number };
  periodStartIso: string;
  cogsVatReclaimPct: number;
  /** Parsed ads-report (already bucketed by Goods ID) — when present, the
   *  engine ignores the txn-sheet ad cost and uses these numbers instead. */
  adReport?: TemuAdReport | null;
  /** Goods ID → list of Temu SKU IDs the user has mapped under that goods. */
  goodsToSkuIds?: Map<string, string[]>;
}): CalculationPreview {
  const {
    rows,
    cogsLookup,
    vatRatePct,
    expenses,
    periodStartIso,
    cogsVatReclaimPct,
    adReport,
    goodsToSkuIds,
  } = input;

  const aoa = rowsToAoa(rows);
  const pnl = computeTemuPnl(aoa);

  // Engine expects lowercase keys; portal stores uppercase. Mirror what
  // processAmazon does.
  const portalCogsLookup = new Map<string, { unitCost: number; includesVat: boolean; effectiveFrom: string }[]>();
  cogsLookup.forEach((versions, sku) => {
    portalCogsLookup.set(String(sku).toLowerCase(), versions.map((v) => ({ ...v })));
  });

  // Build the ads-report override (account-level total + per-SKU bucketed
  // allocation) once, and feed it into both the totals and per-SKU passes.
  let adOverride: TemuAdOverride | null = null;
  if (adReport && adReport.totalSpend > 0) {
    const allocation = allocateTemuAds({
      adReport,
      pnl,
      goodsToSkuIds: goodsToSkuIds ?? new Map(),
    });
    adOverride = {
      totalExvat: allocation.totalSpendExvat,
      spendBySku: allocation.spendBySku,
      unmatchedSpendExvat: allocation.unmatchedSpendExvat,
      sourceFilename: adReport.sourceFilename,
      spendColumn: adReport.spendColumn,
      goodsCount: adReport.goodsCount,
    };
  }

  const totals = deriveTemuTotals({
    pnl,
    cogsLookup: portalCogsLookup,
    vatRatePct,
    defaultDateIso: periodStartIso,
    cogsVatReclaimPct,
    adOverride,
  });
  const { lines: skuLines } = computeTemuPerSku({
    pnl,
    cogsLookup: portalCogsLookup,
    vatRatePct,
    defaultDateIso: periodStartIso,
    adOverride,
  });

  const purchaseCost = -totals.cogs; // positive

  // ---- Missing-SKU + COGS snapshot from per-SKU lines ----
  const missingSet = new Set<string>();
  const missingSkusWithSales: Array<{ sku: string; units: number; netSales: number }> = [];
  const cogsSnapshotMap = new Map<string, CogsSnapshotEntry>();
  for (const line of skuLines) {
    if (line.units > 0 && !line.costKnown) {
      const upper = String(line.sku).toUpperCase();
      missingSet.add(upper);
      missingSkusWithSales.push({ sku: upper, units: line.units, netSales: line.netSales });
      continue;
    }
    if (line.units > 0 && line.costKnown) {
      const cogs = resolveCogsVersion(cogsLookup, line.sku.toUpperCase(), periodStartIso);
      if (cogs) {
        const key = `${line.sku.toUpperCase()}|${cogs.unitCost}|${cogs.includesVat ? "1" : "0"}|${cogs.effectiveFrom}`;
        cogsSnapshotMap.set(key, {
          sku: line.sku.toUpperCase(),
          quantity: (cogsSnapshotMap.get(key)?.quantity || 0) + line.units,
          unit_cost: cogs.unitCost,
          includes_vat: cogs.includesVat,
          effective_from: cogs.effectiveFrom,
        });
      }
    }
  }

  // ---- Build the breakdown summary lines (signed gross totals like the
  // existing UI expects). All eight platform-validated labels MUST appear. ----
  // When an ads-report override is active, the ad line shows the ex-VAT total
  // grossed up with VAT (so the summary stays consistent with how the engine
  // accounted for ads downstream).
  const advertisingDisplayGross = adOverride
    ? round2(-Math.abs(adOverride.totalExvat) * (1 + vatRatePct / 100))
    : round2(pnl.advertisingGross);
  const summaryLines = [
    { label: "Order Payments", value: round2(pnl.orderTotal) },
    { label: "Refunds", value: round2(pnl.refundTotal) },
    {
      label: "Service Fees",
      value: round2(pnl.orderServiceFeeGross + pnl.refundServiceFeeGross),
    },
    { label: "Advertising", value: advertisingDisplayGross },
    {
      label: "Shipping Labels & Adjustments",
      value: round2(
        pnl.shippingLabelPurchaseGross +
          pnl.shippingLabelAdjustmentGross +
          pnl.returnShippingPurchaseGross +
          pnl.returnShippingAdjustmentGross
      ),
    },
    {
      label: "Return Shipping Credit",
      value: round2(
        pnl.returnShippingPlatformGross +
          pnl.returnShippingPlatformAdjGross +
          pnl.returnShippingCreditGross
      ),
    },
    { label: "Chargebacks", value: round2(pnl.chargebackGross) },
    { label: "Penalties", value: round2(pnl.abnormalFulfillmentGross) },
    { label: "Seller Repayment", value: round2(pnl.sellerRepaymentGross) },
  ];

  const totalFees =
    Math.abs(totals.serviceFeesExvat) +
    Math.abs(totals.advertisingExvat) +
    Math.abs(totals.shippingLabelsExvat) +
    Math.abs(totals.penaltiesExvat);

  const settlementNet = totals.netSales + totals.totalTemuFeesExvat;
  const inputVatTotal = totals.totalInputVatIncludingCogs + expenses.vat;
  const finalVat = totals.outputVat - inputVatTotal;
  const operatingProfit = totals.operatingProfit;
  const netProfit = round2(operatingProfit - expenses.net);
  const marketplaceNetProfit = round2(operatingProfit);
  const coreOperatingProfit = round2(
    totals.netSales + totals.cogs + totals.serviceFeesExvat + totals.advertisingExvat
  );
  const adjustmentsNet = round2(totals.operatingProfit - coreOperatingProfit);

  // Positive units sold across all SKUs (refunds netted out → match
  // what the per-SKU table will display).
  const unitsSold = skuLines.reduce((acc, l) => acc + Math.max(0, l.units), 0);

  return {
    grossSales: round2(totals.settlementValue),
    totalCogs: round2(purchaseCost),
    totalFees: round2(totalFees),
    outputVat: round2(totals.outputVat),
    inputVat: round2(inputVatTotal),
    netProfit,
    marketplaceNetProfit,
    unitsSold,
    missingSkus: Array.from(missingSet),
    cogsSnapshot: Array.from(cogsSnapshotMap.values()),
    breakdown: {
      platform: "temu",
      summaryLines,
      settlementLabel: "Net Temu Settlement (incl VAT)",
      settlementValue: round2(totals.settlementValue),
      transferLabel: "Transfers to Bank",
      transferValue: round2(totals.bankTransfers),
      pnl: {
        settlementNet: round2(settlementNet),
        purchaseCost: round2(purchaseCost),
        netProfit,
        coreOperatingProfit,
        adjustmentsNet,
      },
      vat: {
        outputVat: round2(totals.outputVat),
        inputVatFees: round2(totals.totalInputVatTemuFees),
        inputVatPurchases: round2(totals.inputVatCogs + expenses.vat),
        finalVat: round2(finalVat),
      },
      adsOverride: adOverride
        ? {
            // Txn-sheet ads (ex-VAT) before override; signed (negative cost).
            previousAdExvat: round2(
              pnl.advertisingGross - pnl.advertisingGross * (vatRatePct / 100 / (1 + vatRatePct / 100))
            ),
            // Ads-report ex-VAT (signed cost).
            newAdExvat: round2(-Math.abs(adOverride.totalExvat)),
            adReportTotal: round2(Math.abs(adOverride.totalExvat)),
            blankSkuSpend: round2(adOverride.unmatchedSpendExvat),
            sourceFilename: adOverride.sourceFilename || "",
          }
        : null,
      methodologyId: TEMU_METHODOLOGY_ID,
      perSkuRollup: {
        marketplaceNetProfitSum: marketplaceNetProfit,
        externalExpensesNet: Number(Number(expenses.net || 0).toFixed(2)),
      },
    },
    skuLines,
    diagnostics: {
      rowsProcessed: totals.rowsProcessed,
      rowsSkipped: totals.rowsSkipped,
      deliveryUnmatched: totals.shippingLabelsUnmatchedSpend,
      retrochargeUnmatched: 0,
      reimburseUnallocated: 0,
      netSales: round2(totals.netSales),
      productSalesRefunds: round2(
        pnl.refundRetail +
          pnl.refundPlatformDiscount +
          pnl.refundSellerDiscount +
          pnl.refundPlatformIncentive
      ),
      adSkusUnmatched: {},
      missingSkusWithSales,
    },
  };
}

/**
 * TikTok Shop P&L. Operates on the parsed "All orders" export (OrderSKUList
 * sheet). Cancelled orders are dropped; revenue is the order-level "Order
 * Amount" (incl VAT, counted once per order); commission = 12% × Order Amount
 * + £0.50 per order; COGS resolved per net unit via the bridged COGS lookup
 * (TikTok Seller SKU ↔ Amazon SKU ↔ Temu SKU ID). Output VAT extracted from
 * net revenue; input VAT reclaimed on commission + COGS. External costs
 * (affiliate / ads / shipping) come from the Expenses page.
 */
function processTikTok(input: {
  rows: RowData[];
  cogsLookup: CogsLookup;
  vatRatePct: number;
  expenses: { net: number; vat: number };
  periodStartIso: string;
}): CalculationPreview {
  const { rows, cogsLookup, vatRatePct, expenses, periodStartIso } = input;

  const aoa = rowsToAoa(rows);
  const pnl = computeTiktokPnl(aoa);

  const portalCogsLookup = new Map<string, { unitCost: number; includesVat: boolean; effectiveFrom: string }[]>();
  cogsLookup.forEach((versions, sku) => {
    portalCogsLookup.set(String(sku).toLowerCase(), versions.map((v) => ({ ...v })));
  });

  const totals = deriveTiktokTotals({
    pnl,
    cogsLookup: portalCogsLookup,
    vatRatePct,
    defaultDateIso: periodStartIso,
  });
  const { lines: skuLines } = computeTiktokPerSku({
    pnl,
    cogsLookup: portalCogsLookup,
    vatRatePct,
    defaultDateIso: periodStartIso,
  });

  const purchaseCost = -totals.cogs; // positive

  // ---- Missing-SKU + COGS snapshot from per-SKU lines ----
  const missingSet = new Set<string>();
  const missingSkusWithSales: Array<{ sku: string; units: number; netSales: number }> = [];
  const cogsSnapshotMap = new Map<string, CogsSnapshotEntry>();
  for (const line of skuLines) {
    if (line.units > 0 && !line.costKnown) {
      const upper = String(line.sku).toUpperCase();
      missingSet.add(upper);
      missingSkusWithSales.push({ sku: upper, units: line.units, netSales: line.netSales });
      continue;
    }
    if (line.units > 0 && line.costKnown) {
      const cogs = resolveCogsVersion(cogsLookup, line.sku.toUpperCase(), periodStartIso);
      if (cogs) {
        const key = `${line.sku.toUpperCase()}|${cogs.unitCost}|${cogs.includesVat ? "1" : "0"}|${cogs.effectiveFrom}`;
        cogsSnapshotMap.set(key, {
          sku: line.sku.toUpperCase(),
          quantity: (cogsSnapshotMap.get(key)?.quantity || 0) + line.units,
          unit_cost: cogs.unitCost,
          includes_vat: cogs.includesVat,
          effective_from: cogs.effectiveFrom,
        });
      }
    }
  }

  const summaryLines = [
    { label: "Order Amount", value: round2(totals.grossOrderAmountInclVat) },
    { label: "Refunds", value: round2(-totals.refundsInclVat) },
    { label: "TikTok Commission", value: round2(-totals.commissionInclVat) },
  ];

  const totalFees = Math.abs(totals.commissionExvat);
  const settlementNet = totals.netSales + totals.totalTiktokFeesExvat;
  const inputVatTotal = totals.totalInputVatIncludingCogs + expenses.vat;
  const finalVat = totals.outputVat - inputVatTotal;
  const operatingProfit = totals.operatingProfit;
  const netProfit = round2(operatingProfit - expenses.net);
  const marketplaceNetProfit = round2(operatingProfit);
  const unitsSold = skuLines.reduce((acc, l) => acc + Math.max(0, l.units), 0);

  return {
    grossSales: round2(totals.settlementValue),
    totalCogs: round2(purchaseCost),
    totalFees: round2(totalFees),
    outputVat: round2(totals.outputVat),
    inputVat: round2(inputVatTotal),
    netProfit,
    marketplaceNetProfit,
    unitsSold,
    missingSkus: Array.from(missingSet),
    cogsSnapshot: Array.from(cogsSnapshotMap.values()),
    breakdown: {
      platform: "tiktok",
      summaryLines,
      settlementLabel: "Net TikTok Settlement (incl VAT)",
      settlementValue: round2(totals.settlementValue),
      transferLabel: "Transfers to Bank",
      transferValue: 0,
      pnl: {
        settlementNet: round2(settlementNet),
        purchaseCost: round2(purchaseCost),
        netProfit,
      },
      vat: {
        outputVat: round2(totals.outputVat),
        inputVatFees: round2(totals.totalInputVatTiktokFees),
        inputVatPurchases: round2(totals.inputVatCogs + expenses.vat),
        finalVat: round2(finalVat),
      },
      methodologyId: TIKTOK_METHODOLOGY_ID,
      perSkuRollup: {
        marketplaceNetProfitSum: marketplaceNetProfit,
        externalExpensesNet: Number(Number(expenses.net || 0).toFixed(2)),
      },
    },
    skuLines,
    diagnostics: {
      rowsProcessed: totals.rowsProcessed,
      rowsSkipped: totals.rowsSkipped,
      deliveryUnmatched: 0,
      retrochargeUnmatched: 0,
      reimburseUnallocated: 0,
      netSales: round2(totals.netSales),
      productSalesRefunds: round2(-(totals.refundsInclVat / (1 + (vatRatePct / 100 || 0.2)))),
      adSkusUnmatched: {},
      missingSkusWithSales,
    },
  };
}

/**
 * Convert the workbench's row-of-objects shape (each row is a Record keyed
 * by the export's column header) back into a 2D AoA the engine expects.
 * The header row is the union of keys observed across all rows; numeric
 * payloads are preserved as numbers.
 */
function rowsToAoa(rows: RowData[]): unknown[][] {
  if (!rows || rows.length === 0) return [];
  // Preserve column order from the first row's keys, then append any
  // additional keys we discover later (defensive).
  const seen = new Set<string>();
  const headerOrder: string[] = [];
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      if (!seen.has(key)) {
        seen.add(key);
        headerOrder.push(key);
      }
    }
  }
  const out: unknown[][] = [headerOrder];
  for (const row of rows) {
    const arr: unknown[] = new Array(headerOrder.length);
    for (let i = 0; i < headerOrder.length; i += 1) {
      arr[i] = row[headerOrder[i]] ?? "";
    }
    out.push(arr);
  }
  return out;
}

const round2 = (value: number) => Math.round(value * 100) / 100;

/**
 * Load the canonical Goods ID → list of Temu SKU IDs map from
 * `sku_mappings` joined to `sku_catalog.temu_goods_id`. Used by the Temu
 * ads-report allocator to bucket spend by parent listing.
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

/**
 * Amazon P&L using the portal accrual methodology (Released + Deferred filter, marketplace
 * withheld VAT, retrocharges, deal fees pro-rata, FBA inventory VAT split,
 * order_id back-attribution for Delivery Services, etc.). Mirrors
 * `Rexo/rexo_pnl.py` and reconciles to the same numbers.
 *
 * Returns the same `CalculationPreview` shape the rest of the UI expects so
 * the saved-reports panel + PDF keep working, plus per-SKU lines for the
 * new table.
 */
function processAmazon(input: {
  rows: RowData[];
  cogsLookup: CogsLookup;
  vatRatePct: number;
  expenses: { net: number; vat: number };
  periodStartIso: string;
  adReport: AdReport | null;
  cogsVatReclaimPct: number;
}): CalculationPreview {
  const { rows, cogsLookup, vatRatePct, expenses, periodStartIso, adReport, cogsVatReclaimPct } = input;

  // Convert the user-selected sheet into a header-row + data-rows 2D array.
  const headers = rows.length > 0 ? Object.keys(rows[0]) : [];
  const aoa: unknown[][] = [headers, ...rows.map((r) => headers.map((h) => r[h]))];

  const pnl = computeAmazonPnl(aoa);

  let adsOverride: NonNullable<CalculationPreview["breakdown"]["adsOverride"]> | null = null;
  if (adReport) {
    const before = applyAdReportOverride(pnl, adReport.totalSpend, vatRatePct);
    adsOverride = {
      previousAdExvat: Number(before.previousAdExvat.toFixed(2)),
      newAdExvat: Number(pnl.advertisingExvat.toFixed(2)),
      adReportTotal: Number(adReport.totalSpend.toFixed(2)),
      blankSkuSpend: Number(adReport.blankSkuSpend.toFixed(2)),
      sourceFilename: adReport.sourceFilename,
    };
  }

  // Build a portal-shaped CogsLookup from the workbench-side map.
  const portalCogsLookup = new Map<string, { unitCost: number; includesVat: boolean; effectiveFrom: string }[]>();
  cogsLookup.forEach((versions, sku) => {
    portalCogsLookup.set(sku.toLowerCase(), versions.map((v) => ({ ...v })));
  });

  const totals = deriveTotals({
    pnl,
    cogsLookup: portalCogsLookup,
    vatRatePct,
    defaultDateIso: periodStartIso || new Date().toISOString().slice(0, 10),
    cogsVatReclaimPct,
  });
  const { lines: skuLines, diagnostics: perSkuDiagnostics } = computePerSku({
    pnl,
    cogsLookup: portalCogsLookup,
    vatRatePct,
    defaultDateIso: periodStartIso || new Date().toISOString().slice(0, 10),
    adReport,
  });

  // ---------- COGS snapshot + missing SKUs ----------
  const cogsSnapshotMap = new Map<string, CogsSnapshotEntry>();
  const missingSkus = new Set<string>();
  const missingSkuStats = new Map<string, { units: number; netSales: number }>();
  for (const [sku, units] of Object.entries(pnl.skuUnits)) {
    if (units <= 0) continue;
    const cogs = resolveCogsVersion(cogsLookup, sku.toUpperCase(), periodStartIso);
    if (!cogs) {
      const upper = sku.toUpperCase();
      missingSkus.add(upper);
      const sales =
        (pnl.skuProductSales[sku] || 0) +
        (pnl.skuPostageCredits[sku] || 0) +
        (pnl.skuPromoRebates[sku] || 0);
      missingSkuStats.set(upper, { units, netSales: sales });
      continue;
    }
    const key = `${sku.toUpperCase()}|${cogs.unitCost}|${cogs.includesVat ? "1" : "0"}|${cogs.effectiveFrom}`;
    cogsSnapshotMap.set(key, {
      sku: sku.toUpperCase(),
      quantity: (cogsSnapshotMap.get(key)?.quantity || 0) + units,
      unit_cost: cogs.unitCost,
      includes_vat: cogs.includesVat,
      effective_from: cogs.effectiveFrom,
    });
  }

  // ---------- Map to legacy CalculationPreview shape ----------
  const productSalesLine = totals.netSales > 0 || pnl.productSalesPositive !== 0 ? pnl.productSalesPositive : 0;
  const refundsLine = pnl.productSalesRefunds;
  const adjustmentsLine =
    totals.fbaReimbursements + pnl.postageCredits + pnl.promotionalRebates;

  // Service Fees in the legacy summary lumped subscription + advertising +
  // any other "Service Fee" rows. We preserve that behaviour.
  const serviceFeesLine = totals.subscriptionExvat + totals.advertisingExvat;

  // Output VAT presented as positive (collected). Includes the marketplace
  // withholding offset to mirror the new methodology in the VAT card.
  const outputVat = totals.outputVatPayableToHmrc;
  const inputVatFees = totals.totalInputVatAmazonFees;
  const inputVatPurchases = totals.inputVatCogs + expenses.vat;
  const inputVat = inputVatFees + inputVatPurchases;
  const finalVat = outputVat - inputVat;

  // Net Amazon Settlement (ex-VAT): cash you got from Amazon minus VAT.
  // = netSales (ex-VAT) + fbaReimbursements + totalAmazonFeesExvat
  const settlementNet = totals.netSales + totals.fbaReimbursements + totals.totalAmazonFeesExvat;

  // Settlement value (gross cash, including VAT) for the top card.
  const settlementValue = settlementNet + outputVat - inputVatFees;

  const purchaseCost = -totals.cogs; // positive
  const netProfit = settlementNet - purchaseCost - expenses.net;
  const marketplaceNetProfit = Number(totals.operatingProfit.toFixed(2));
  const unitsSold = Object.values(pnl.skuUnits).reduce((a, u) => a + Math.max(0, u), 0);

  const totalFeesAbs =
    Math.abs(totals.sellingFeesExvat) +
    Math.abs(totals.fbaFeesExvat) +
    Math.abs(totals.otherTxFeesExvat) +
    Math.abs(totals.fbaInventoryFeesExvat) +
    Math.abs(totals.deliveryServicesExvat) +
    Math.abs(totals.subscriptionExvat) +
    Math.abs(totals.advertisingExvat);

  return {
    grossSales: settlementValue,
    totalCogs: purchaseCost,
    totalFees: totalFeesAbs,
    outputVat,
    inputVat,
    netProfit,
    marketplaceNetProfit,
    unitsSold,
    missingSkus: Array.from(missingSkus),
    cogsSnapshot: Array.from(cogsSnapshotMap.values()),
    skuLines,
    breakdown: {
      platform: "amazon",
      summaryLines: [
        { label: "Product Sales", value: productSalesLine },
        { label: "Refunds on Sales", value: refundsLine },
        { label: "Adjustments & Credits", value: adjustmentsLine },
        { label: "Selling Fees", value: totals.sellingFeesExvat },
        { label: "FBA Fees", value: totals.fbaFeesExvat },
        { label: "FBA Inventory Fee", value: totals.fbaInventoryFeesExvat },
        { label: "Other Transaction Fees", value: totals.otherTxFeesExvat },
        { label: "Delivery Services", value: totals.deliveryServicesExvat },
        { label: "Service Fees", value: serviceFeesLine },
      ],
      settlementLabel: "Net Amazon Settlement",
      settlementValue,
      transferLabel: "Transfers to Bank",
      transferValue: totals.bankTransfers,
      pnl: {
        settlementNet,
        purchaseCost,
        netProfit,
      },
      vat: {
        outputVat,
        inputVatFees,
        inputVatPurchases,
        finalVat,
      },
      adsOverride,
      methodologyId: AMAZON_METHODOLOGY_ID,
      perSkuRollup: {
        marketplaceNetProfitSum: marketplaceNetProfit,
        externalExpensesNet: Number(Number(expenses.net || 0).toFixed(2)),
      },
    },
    diagnostics: {
      rowsProcessed: pnl.rowsProcessed,
      rowsSkipped: pnl.rowsSkipped,
      deliveryUnmatched: pnl.deliveryServicesUnmatched,
      retrochargeUnmatched: pnl.retrochargeUnmatched,
      reimburseUnallocated: pnl.fbaReimbursementsUnallocated,
      netSales: totals.netSales,
      productSalesRefunds: pnl.productSalesRefunds,
      adSkusUnmatched: perSkuDiagnostics.adSkusUnmatched,
      missingSkusWithSales: Array.from(missingSkuStats.entries()).map(([sku, stats]) => ({
        sku,
        units: stats.units,
        netSales: stats.netSales,
      })),
    },
  };
}

export default function ReportWorkbench({ account, canProcess }: Props) {
  const [platform, setPlatform] = useState<Platform>("amazon");
  const [periodStart, setPeriodStart] = useState("");
  const [periodEnd, setPeriodEnd] = useState("");
  const [headers, setHeaders] = useState<string[]>([]);
  const [rows, setRows] = useState<RowData[]>([]);
  const [skuCol, setSkuCol] = useState("");
  const [qtyCol, setQtyCol] = useState("");
  const [fileName, setFileName] = useState("");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<CalculationPreview | null>(null);
  const [appliedExpenses, setAppliedExpenses] = useState<ExpenseOccurrence[]>([]);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [adReport, setAdReport] = useState<AdReport | null>(null);
  const [adFileName, setAdFileName] = useState("");
  const [adLoadError, setAdLoadError] = useState<string | null>(null);
  // Temu ads-report (parsed) — independent state from Amazon's `adReport`
  // because the file shape, allocation strategy, and column auto-detection
  // are different.
  const [temuAdReport, setTemuAdReport] = useState<TemuAdReport | null>(null);
  const [temuAdFileName, setTemuAdFileName] = useState("");
  const [temuAdLoadError, setTemuAdLoadError] = useState<string | null>(null);
  const cogsVatReclaimPct = Number(account.cogs_vat_reclaim_pct ?? 100);
  const isZeroVatAccount = Number(account.vat_rate || 0) === 0;

  const currency = account.currency || "£";

  const canCalculate = useMemo(() => {
    return (
      canProcess &&
      Boolean(periodStart) &&
      Boolean(periodEnd) &&
      rows.length > 0 &&
      Boolean(skuCol) &&
      Boolean(qtyCol)
    );
  }, [canProcess, periodEnd, periodStart, qtyCol, rows.length, skuCol]);

  const previewProductSales = useMemo(() => {
    if (!preview) return 0;
    const label =
      platform === "amazon" ? "Product Sales" : platform === "tiktok" ? "Order Amount" : "Order Payments";
    const fromBreakdown = preview.breakdown.summaryLines.find((line) => line.label === label)?.value;
    return Number(fromBreakdown ?? preview.grossSales ?? 0);
  }, [preview, platform]);

  const appliedExpenseTotals = useMemo(
    () => computeExpenseTotalsFromOccurrences(appliedExpenses, account.vat_rate),
    [appliedExpenses, account.vat_rate]
  );

  useEffect(() => {
    if (!headers.length) return;
    const temuSku = autoPickHeader(headers, ["skuid", "temuskuid"]);
    const tiktokSku = autoPickHeader(headers, ["sellersku"]);
    const genericSku = autoPickHeader(headers, ["sku", "asin", "itemid", "reference"]);
    setSkuCol(
      platform === "temu"
        ? temuSku || genericSku
        : platform === "tiktok"
          ? tiktokSku || genericSku
          : genericSku
    );
    setQtyCol(autoPickHeader(headers, ["qty", "quantity", "units"]));
  }, [platform, headers]);

  useEffect(() => {
    if (isZeroVatAccount && platform !== "amazon" && platform !== "tiktok") {
      setPlatform("amazon");
    }
  }, [isZeroVatAccount, platform]);

  const parseFile = async (file: File): Promise<RowData[]> => {
    if (file.name.toLowerCase().endsWith(".csv")) {
      return new Promise<RowData[]>((resolve, reject) => {
        Papa.parse<RowData>(file, {
          header: true,
          skipEmptyLines: true,
          complete: (result) => resolve(result.data),
          error: reject,
        });
      });
    }

    const buffer = await file.arrayBuffer();
    const workbook = XLSX.read(buffer, { type: "array" });
    const firstSheet = workbook.SheetNames[0];
    return XLSX.utils.sheet_to_json<RowData>(workbook.Sheets[firstSheet], { defval: "" });
  };

  const onFileChange = async (file: File | null) => {
    if (!file) return;

    setLoading(true);
    setError(null);
    setMessage(null);
    setPreview(null);

    try {
      const parsedRows = await parseFile(file);
      if (!parsedRows.length) {
        throw new Error("File appears to be empty.");
      }

      const nextHeaders = Object.keys(parsedRows[0]);
      setRows(parsedRows);
      setHeaders(nextHeaders);
      setFileName(file.name);
      const temuSku = autoPickHeader(nextHeaders, ["skuid", "temuskuid"]);
      const tiktokSku = autoPickHeader(nextHeaders, ["sellersku"]);
      const genericSku = autoPickHeader(nextHeaders, ["sku", "asin", "itemid", "reference"]);
      setSkuCol(
        platform === "temu"
          ? temuSku || genericSku
          : platform === "tiktok"
            ? tiktokSku || genericSku
            : genericSku
      );
      setQtyCol(autoPickHeader(nextHeaders, ["qty", "quantity", "units"]));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to parse file.");
      setRows([]);
      setHeaders([]);
      setFileName("");
      setSkuCol("");
      setQtyCol("");
    } finally {
      setLoading(false);
    }
  };

  const onAdFileChange = async (file: File | null) => {
    if (!file) {
      setAdReport(null);
      setAdFileName("");
      setAdLoadError(null);
      return;
    }
    setAdLoadError(null);
    setMessage(null);
    try {
      const parsed = await loadAdReport(file);
      setAdReport(parsed);
      setAdFileName(file.name);
      if (parsed.totalSpend === 0) {
        setAdLoadError(
          "Ads report parsed, but the spend column was empty. Check the file before processing."
        );
      }
    } catch (err) {
      const text = err instanceof Error ? err.message : "Failed to parse ads report.";
      setAdLoadError(text);
      setAdReport(null);
      setAdFileName("");
    }
  };

  const clearAdReport = () => {
    setAdReport(null);
    setAdFileName("");
    setAdLoadError(null);
  };

  const onTemuAdFileChange = async (file: File | null) => {
    if (!file) {
      setTemuAdReport(null);
      setTemuAdFileName("");
      setTemuAdLoadError(null);
      return;
    }
    setTemuAdLoadError(null);
    setMessage(null);
    try {
      const parsed = await loadTemuAdReport(file);
      setTemuAdReport(parsed);
      setTemuAdFileName(file.name);
      if (parsed.totalSpend === 0) {
        setTemuAdLoadError(
          "Temu ads report parsed, but the spend column was empty. Check the file before processing."
        );
      }
    } catch (err) {
      const text = err instanceof Error ? err.message : "Failed to parse Temu ads report.";
      setTemuAdLoadError(text);
      setTemuAdReport(null);
      setTemuAdFileName("");
    }
  };

  const clearTemuAdReport = () => {
    setTemuAdReport(null);
    setTemuAdFileName("");
    setTemuAdLoadError(null);
  };

  const runCalculation = async () => {
    if (!canCalculate) return;

    setError(null);
    setMessage(null);
    setLoading(true);
    setWarnings([]);

    try {
      const rangeError = validatePeriodRange(periodStart, periodEnd);
      if (rangeError) throw new Error(rangeError);

      const supabase = createClient();
      // Bridged COGS lookup: keys are lowercased seller SKUs PLUS their twin
      // identifiers from `sku_mappings` (Amazon SKU ↔ Temu SKU ID), so a
      // Temu report can resolve COGS that's stored under the Amazon SKU and
      // vice versa. processAmazon/processTemu both consume this same map.
      const cogsLookup = await buildBridgedCogsLookup(supabase, account.id);

      // For Temu, also load the Goods ID → SKU ID map so the ads-report
      // allocator can bucket spend by parent listing. Cheap fetch; only
      // run on Temu reports.
      const goodsToSkuIds = platform === "temu" ? await loadGoodsToSkuIdsMap(supabase, account.id) : new Map<string, string[]>();

      const { data: ledgerRowsRaw } = await supabase
        .from("expense_ledger")
        .select("id, account_id, description, expense_date, amount, includes_vat, marketplace, expense_type, recurring_end_date")
        .eq("account_id", account.id)
        .lte("expense_date", periodEnd)
        .or(`recurring_end_date.is.null,recurring_end_date.gte.${periodStart}`);
      const expenseOccurrences = computeExpenseOccurrencesForPeriod({
        rows: (ledgerRowsRaw || []) as ExpenseLedgerRow[],
        platform,
        periodStart,
        periodEnd,
      });
      const expenseTotals = computeExpenseTotalsFromOccurrences(expenseOccurrences, account.vat_rate);
      setAppliedExpenses(expenseOccurrences);

      const computed =
        platform === "amazon"
          ? processAmazon({
              rows,
              cogsLookup,
              vatRatePct: account.vat_rate,
              expenses: expenseTotals,
              periodStartIso: periodStart,
              adReport,
              cogsVatReclaimPct,
            })
          : platform === "tiktok"
            ? processTikTok({
                rows,
                cogsLookup,
                vatRatePct: account.vat_rate,
                expenses: expenseTotals,
                periodStartIso: periodStart,
              })
            : processTemu({
                rows,
                cogsLookup,
                vatRatePct: account.vat_rate,
                expenses: expenseTotals,
                periodStartIso: periodStart,
                cogsVatReclaimPct,
                adReport: temuAdReport,
                goodsToSkuIds,
              });
      const result = applyZeroVatPresentation(computed, account.vat_rate, expenseTotals.net);

      const breakdownError = validateBreakdown(platform, result.breakdown);
      if (breakdownError) throw new Error(breakdownError);

      setPreview(result);
      setWarnings(
        deriveReportWarnings({
          missingSkus: result.missingSkus,
          missingSkusWithSales: result.diagnostics?.missingSkusWithSales,
          netProfit: result.netProfit,
          outputVat: result.outputVat,
          inputVat: result.inputVat,
          skuLines: result.skuLines?.map((l) => ({
            sku: l.sku,
            netProfit: l.netProfit,
            netSales: l.netSales,
            units: l.units,
            costKnown: l.costKnown,
            adOnly: l.adOnly,
          })),
          accountNetProfit: result.netProfit,
          skuReconcileBaseline: result.marketplaceNetProfit,
          adOverride: result.breakdown.adsOverride
            ? {
                adReportTotal: result.breakdown.adsOverride.adReportTotal,
                previousAdExvat: result.breakdown.adsOverride.previousAdExvat,
              }
            : null,
          periodStart,
          periodEnd,
          rowsProcessed: result.diagnostics?.rowsProcessed,
          rowsSkipped: result.diagnostics?.rowsSkipped,
          netSales: result.diagnostics?.netSales,
          productSalesRefunds: result.diagnostics?.productSalesRefunds,
          vatRatePct: account.vat_rate,
          currency,
          diagnostics: result.diagnostics
            ? {
                deliveryUnmatched: result.diagnostics.deliveryUnmatched,
                retrochargeUnmatched: result.diagnostics.retrochargeUnmatched,
                reimburseUnallocated: result.diagnostics.reimburseUnallocated,
                adSkusUnmatched: result.diagnostics.adSkusUnmatched,
              }
            : undefined,
        })
      );
      setMessage("Calculation complete. Review and save report.");
    } catch (err) {
      const text = err instanceof Error ? err.message : "Calculation failed.";
      setError(text);
      await pushClientNotification({
        title: "Report calculation failed",
        body: text,
        level: "error",
        eventKey: `report-calc-fail:${account.id}:${Date.now()}`,
      });
    } finally {
      setLoading(false);
    }
  };

  const saveReport = async () => {
    if (!preview) return;

    setSaving(true);
    setError(null);
    setMessage(null);

    try {
      const rangeError = validatePeriodRange(periodStart, periodEnd);
      if (rangeError) throw new Error(rangeError);
      const breakdownError = validateBreakdown(platform, preview.breakdown);
      if (breakdownError) throw new Error(breakdownError);

      const supabase = createClient();

      const { data: overlaps, error: overlapError } = await supabase
        .from("reports")
        .select("id, period_start, period_end")
        .eq("account_id", account.id)
        .eq("platform", platform)
        .lte("period_start", periodEnd)
        .gte("period_end", periodStart);
      if (overlapError) throw overlapError;
      const conflicting = (overlaps || []).filter(
        (row) => !(String(row.period_start) === periodStart && String(row.period_end) === periodEnd)
      );
      if (conflicting.length > 0) {
        throw new Error("This period overlaps with an existing report. Use non-overlapping dates.");
      }
      const exactMatch = (overlaps || []).find(
        (row) => String(row.period_start) === periodStart && String(row.period_end) === periodEnd
      );
      if (exactMatch) {
        const shouldOverwrite = window.confirm(
          "A report for this same platform and period already exists. Click OK to overwrite it, or Cancel to stop."
        );
        if (!shouldOverwrite) {
          setWarnings((prev) => [
            ...prev.filter((item) => !item.includes("already exists")),
            "A report for this period already exists. Save cancelled to avoid accidental overwrite.",
          ]);
          setMessage("Save cancelled.");
          return;
        }
      }

      const reportPayload = {
        account_id: account.id,
        period_start: periodStart,
        period_end: periodEnd,
        platform,
        source: "manual" as const,
        gross_sales: Number(preview.grossSales.toFixed(2)),
        total_cogs: Number(preview.totalCogs.toFixed(2)),
        total_fees: Number(preview.totalFees.toFixed(2)),
        output_vat: Number(preview.outputVat.toFixed(2)),
        input_vat: Number(preview.inputVat.toFixed(2)),
        net_profit: Number(preview.netProfit.toFixed(2)),
        breakdown: { ...preview.breakdown, warnings },
        cogs_snapshot: preview.cogsSnapshot,
        cogs_vat_reclaim_pct: Number(Number(cogsVatReclaimPct).toFixed(2)),
      };

      const { data: reportRow, error: reportError } = await supabase
        .from("reports")
        .upsert(reportPayload, {
          onConflict: "account_id,period_start,period_end,platform,source",
        })
        .select("id")
        .single();

      if (reportError || !reportRow?.id) {
        throw reportError || new Error("Failed to save report.");
      }

      const reportId = reportRow.id as string;

      // Persist parsed row-level transactions for future inventory forecasting.
      const normalizedTransactions = normalizeReportTransactions({
        rows,
        skuCol,
        qtyCol,
        periodStartIso: periodStart,
        reportId,
        accountId: account.id,
        platform,
      });
      const { error: clearTransactionsError } = await supabase
        .from("report_transactions")
        .delete()
        .eq("report_id", reportId);
      if (clearTransactionsError) throw clearTransactionsError;
      const CHUNK_SIZE = 400;
      for (let i = 0; i < normalizedTransactions.length; i += CHUNK_SIZE) {
        const chunk = normalizedTransactions.slice(i, i + CHUNK_SIZE);
        const { error: txInsertError } = await supabase.from("report_transactions").insert(chunk);
        if (txInsertError) throw txInsertError;
      }

      // Persist per-SKU breakdown (always replace) — both engines emit SkuLine.
      if (preview.skuLines && preview.skuLines.length > 0) {
        const { error: clearSkuError } = await supabase
          .from("report_sku_breakdowns")
          .delete()
          .eq("report_id", reportId);
        if (clearSkuError) throw clearSkuError;

        const skuRows = preview.skuLines.map((line) => ({
          report_id: reportId,
          account_id: account.id,
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
        for (let i = 0; i < skuRows.length; i += CHUNK_SIZE) {
          const chunk = skuRows.slice(i, i + CHUNK_SIZE);
          const { error: skuInsertError } = await supabase.from("report_sku_breakdowns").insert(chunk);
          if (skuInsertError) throw skuInsertError;
        }
      }

      // Persist ads-report metadata + per-SKU spend rows when an ads report
      // was uploaded for this run.
      if (platform === "amazon" && adReport) {
        await supabase.from("report_ad_meta").delete().eq("report_id", reportId);
        await supabase.from("report_ad_spend").delete().eq("report_id", reportId);

        const matchedSkuSet = new Set(preview.skuLines?.map((l) => l.sku) ?? []);
        let matchedCount = 0;
        let unmatchedCount = 0;
        const adRows: Array<{
          report_id: string;
          account_id: string;
          sku: string | null;
          spend_exvat: number;
          matched: boolean;
          source_kind: string;
        }> = [];
        for (const [sku, spend] of Object.entries(adReport.spendBySku)) {
          const matched = matchedSkuSet.has(sku);
          if (matched) matchedCount += 1;
          else unmatchedCount += 1;
          adRows.push({
            report_id: reportId,
            account_id: account.id,
            sku,
            spend_exvat: Number(spend.toFixed(2)),
            matched,
            source_kind: "amazon_sku",
          });
        }
        if (adReport.blankSkuSpend > 0) {
          adRows.push({
            report_id: reportId,
            account_id: account.id,
            sku: null,
            spend_exvat: Number(adReport.blankSkuSpend.toFixed(2)),
            matched: false,
            source_kind: "amazon_sku",
          });
        }

        const { error: adMetaError } = await supabase.from("report_ad_meta").insert({
          report_id: reportId,
          account_id: account.id,
          source_filename: adReport.sourceFilename,
          total_spend_exvat: Number(adReport.totalSpend.toFixed(2)),
          blank_sku_spend: Number(adReport.blankSkuSpend.toFixed(2)),
          matched_sku_count: matchedCount,
          unmatched_sku_count: unmatchedCount,
        });
        if (adMetaError) throw adMetaError;

        for (let i = 0; i < adRows.length; i += CHUNK_SIZE) {
          const chunk = adRows.slice(i, i + CHUNK_SIZE);
          const { error: adInsertError } = await supabase.from("report_ad_spend").insert(chunk);
          if (adInsertError) throw adInsertError;
        }
      }

      // Temu ads: persist Goods-level rows (the natural granularity of the
      // upload). Per-SKU allocation is recomputed at render time from these
      // rows + the current sku_mappings, so a later mapping change is
      // automatically reflected on recompute.
      if (platform === "temu" && temuAdReport) {
        await supabase.from("report_ad_meta").delete().eq("report_id", reportId);
        await supabase.from("report_ad_spend").delete().eq("report_id", reportId);

        const adRows: Array<{
          report_id: string;
          account_id: string;
          sku: string | null;
          temu_goods_id: string | null;
          goods_name: string | null;
          spend_exvat: number;
          matched: boolean;
          source_kind: string;
        }> = [];
        let matchedCount = 0;
        let unmatchedCount = 0;
        const adsOverrideSummary = preview.breakdown?.adsOverride;
        for (const [goodsId, spend] of Object.entries(temuAdReport.spendByGoodsId)) {
          // "matched" here means at least one SKU was tied to this Goods on
          // the upload (we infer from the override summary's blank-SKU/total
          // ratio when needed). Conservatively flag as matched when goodsId
          // is present.
          const matched = true;
          if (matched) matchedCount += 1;
          else unmatchedCount += 1;
          adRows.push({
            report_id: reportId,
            account_id: account.id,
            sku: null,
            temu_goods_id: goodsId,
            goods_name: temuAdReport.goodsNameByGoodsId[goodsId] || null,
            spend_exvat: Number(spend.toFixed(2)),
            matched,
            source_kind: "temu_goods",
          });
        }
        if (temuAdReport.blankGoodsSpend > 0) {
          unmatchedCount += 1;
          adRows.push({
            report_id: reportId,
            account_id: account.id,
            sku: null,
            temu_goods_id: null,
            goods_name: null,
            spend_exvat: Number(temuAdReport.blankGoodsSpend.toFixed(2)),
            matched: false,
            source_kind: "temu_goods",
          });
        }

        const { error: adMetaError } = await supabase.from("report_ad_meta").insert({
          report_id: reportId,
          account_id: account.id,
          source_filename: temuAdReport.sourceFilename,
          total_spend_exvat: Number(temuAdReport.totalSpend.toFixed(2)),
          // Reuse `blank_sku_spend` semantically for "spend with no Goods ID".
          blank_sku_spend: Number((adsOverrideSummary?.blankSkuSpend ?? temuAdReport.blankGoodsSpend).toFixed(2)),
          matched_sku_count: matchedCount,
          unmatched_sku_count: unmatchedCount,
        });
        if (adMetaError) throw adMetaError;

        for (let i = 0; i < adRows.length; i += CHUNK_SIZE) {
          const chunk = adRows.slice(i, i + CHUNK_SIZE);
          const { error: adInsertError } = await supabase.from("report_ad_spend").insert(chunk);
          if (adInsertError) throw adInsertError;
        }
      }

      // Refresh the inventory sales-facts cache so the Inventory dashboard
      // (Overview & Velocity, monthly accumulator) reflects the just-uploaded
      // transactions on its very next load — without re-scanning JSONB.
      try {
        await supabase.rpc("refresh_inventory_sales_facts", { p_account_id: account.id });
      } catch {
        /* non-fatal: cache will refresh on next report save */
      }

      const adsSavedThisRun = (platform === "amazon" && Boolean(adReport)) || (platform === "temu" && Boolean(temuAdReport));
      setMessage(
        adsSavedThisRun
          ? "Report, per-SKU breakdown, and ads report saved successfully."
          : "Report and per-SKU breakdown saved successfully."
      );
    } catch (err) {
      const text = err instanceof Error ? err.message : "Failed to save report.";
      setError(text);
      await pushClientNotification({
        title: "Report save failed",
        body: text,
        level: "error",
        eventKey: `report-save-fail:${account.id}:${Date.now()}`,
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-6">
      {!canProcess ? (
        <p className="rounded-2xl bg-slate-100 px-3 py-2 text-sm text-slate-700">
          You have client access. Report processing is available for Admin/Team only.
        </p>
      ) : null}

      <div className="grid gap-3 rounded-2xl border border-slate-200 bg-white p-4 md:grid-cols-4">
        <div>
          <label className="mb-1 block text-sm font-medium text-slate-700">Platform</label>
          <select
            value={platform}
            onChange={(event) => setPlatform(event.target.value as Platform)}
            className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm"
            disabled={!canProcess}
          >
            <option value="amazon">Amazon</option>
            {!isZeroVatAccount ? <option value="temu">Temu</option> : null}
            <option value="tiktok">TikTok</option>
          </select>
        </div>

        <div>
          <label className="mb-1 block text-sm font-medium text-slate-700">Period Start</label>
          <input
            type="date"
            value={periodStart}
            onChange={(event) => setPeriodStart(event.target.value)}
            className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm"
            disabled={!canProcess}
          />
        </div>

        <div>
          <label className="mb-1 block text-sm font-medium text-slate-700">Period End</label>
          <input
            type="date"
            value={periodEnd}
            onChange={(event) => setPeriodEnd(event.target.value)}
            className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm"
            disabled={!canProcess}
          />
        </div>

        <div>
          <label className="mb-1 block text-sm font-medium text-slate-700">Transaction File</label>
          <FileDropzone
            accept=".csv,.xlsx"
            onFileSelect={(file) => void onFileChange(file)}
            disabled={!canProcess}
            label="Upload transaction file"
            hint="CSV or XLSX"
            selectedFileName={fileName || undefined}
          />
        </div>
      </div>

      <div className="grid gap-3 rounded-2xl border border-slate-200 bg-white p-4 md:grid-cols-2">
        <div>
          <label className="mb-1 block text-sm font-medium text-slate-700">SKU Column</label>
          <select
            value={skuCol}
            onChange={(event) => setSkuCol(event.target.value)}
            className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm"
            disabled={!canProcess || headers.length === 0}
          >
            <option value="">Select column</option>
            {headers.map((header) => (
              <option key={header} value={header}>
                {header}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label className="mb-1 block text-sm font-medium text-slate-700">Quantity Column</label>
          <select
            value={qtyCol}
            onChange={(event) => setQtyCol(event.target.value)}
            className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm"
            disabled={!canProcess || headers.length === 0}
          >
            <option value="">Select column</option>
            {headers.map((header) => (
              <option key={header} value={header}>
                {header}
              </option>
            ))}
          </select>
        </div>

      </div>

      {platform === "amazon" ? (
        <div className="rounded-2xl border border-slate-200 bg-white p-4">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <div>
              <h4 className="text-sm font-semibold text-slate-800">Advertising Report (recommended)</h4>
              <p className="text-xs text-slate-500">
                Upload the Amazon Ads campaign report (CSV/XLSX) for the same period. We will
                replace the transaction-sheet ad totals with the per-SKU spend from this report
                (more accurate due to billing-cycle differences).
              </p>
            </div>
            {adReport ? (
              <button
                type="button"
                onClick={clearAdReport}
                className="rounded-lg bg-red-50 px-3 py-1 text-xs font-semibold text-red-700"
              >
                Clear
              </button>
            ) : null}
          </div>
          <FileDropzone
            accept=".csv,.xlsx"
            onFileSelect={(file) => void onAdFileChange(file)}
            disabled={!canProcess}
            label="Upload ads report"
            hint="Amazon Ads — Sponsored Products / Brands campaign export"
            selectedFileName={adFileName || undefined}
          />
          {adLoadError ? (
            <p className="mt-2 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">{adLoadError}</p>
          ) : null}
          {adReport ? (
            <div className="mt-3 grid gap-2 rounded-xl bg-slate-50 p-3 text-xs text-slate-700 md:grid-cols-3">
              <div>
                <div className="text-slate-500">Total spend (ex-VAT)</div>
                <div className="text-sm font-semibold text-slate-900">
                  {currency}
                  {adReport.totalSpend.toFixed(2)}
                </div>
              </div>
              <div>
                <div className="text-slate-500">SKUs in report</div>
                <div className="text-sm font-semibold text-slate-900">{adReport.skuCount}</div>
              </div>
              <div>
                <div className="text-slate-500">Blank-SKU spend</div>
                <div className="text-sm font-semibold text-slate-900">
                  {currency}
                  {adReport.blankSkuSpend.toFixed(2)}
                </div>
              </div>
              <div className="md:col-span-3 text-[11px] text-slate-500">
                Spend column: <span className="font-mono">{adReport.spendColumn}</span>. Reprocess after upload to refresh totals.
              </div>
            </div>
          ) : null}
        </div>
      ) : null}

      {platform === "temu" ? (
        <div className="rounded-2xl border border-slate-200 bg-white p-4">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <div>
              <h4 className="text-sm font-semibold text-slate-800">Temu Ads Report (recommended)</h4>
              <p className="text-xs text-slate-500">
                Upload the Temu Ads &quot;Product data details&quot; export (XLSX/CSV) for the same period. The report
                is keyed by <span className="font-mono">Goods ID</span> (parent listing); we bucket spend per Goods
                and split inside each bucket by units sold across the SKU IDs you&apos;ve mapped on the COGS page.
                Unmatched Goods are pooled and redistributed across all selling SKUs by net sales.
              </p>
            </div>
            {temuAdReport ? (
              <button
                type="button"
                onClick={clearTemuAdReport}
                className="rounded-lg bg-red-50 px-3 py-1 text-xs font-semibold text-red-700"
              >
                Clear
              </button>
            ) : null}
          </div>
          <FileDropzone
            accept=".csv,.xlsx"
            onFileSelect={(file) => void onTemuAdFileChange(file)}
            disabled={!canProcess}
            label="Upload Temu ads report"
            hint="Temu Ads — Product data details export"
            selectedFileName={temuAdFileName || undefined}
          />
          {temuAdLoadError ? (
            <p className="mt-2 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">{temuAdLoadError}</p>
          ) : null}
          {temuAdReport ? (
            <div className="mt-3 grid gap-2 rounded-xl bg-slate-50 p-3 text-xs text-slate-700 md:grid-cols-3">
              <div>
                <div className="text-slate-500">Total spend (ex-VAT)</div>
                <div className="text-sm font-semibold text-slate-900">
                  {currency}
                  {temuAdReport.totalSpend.toFixed(2)}
                </div>
              </div>
              <div>
                <div className="text-slate-500">Goods in report</div>
                <div className="text-sm font-semibold text-slate-900">{temuAdReport.goodsCount}</div>
              </div>
              <div>
                <div className="text-slate-500">Blank-Goods spend</div>
                <div className="text-sm font-semibold text-slate-900">
                  {currency}
                  {temuAdReport.blankGoodsSpend.toFixed(2)}
                </div>
              </div>
              <div className="md:col-span-3 text-[11px] text-slate-500">
                Spend column: <span className="font-mono">{temuAdReport.spendColumn}</span>. Reprocess after upload to refresh totals.
              </div>
            </div>
          ) : null}
        </div>
      ) : null}

      <div className="rounded-2xl border border-slate-200 bg-white p-4">
        <div className="mb-2 flex items-center justify-between">
          <h4 className="text-sm font-semibold text-slate-800">External Expenses (from Expenses page)</h4>
          <a href={`/expenses?accountId=${encodeURIComponent(account.id)}`} className="text-xs font-semibold text-[var(--md-primary)] underline">
            Manage expenses
          </a>
        </div>
        {appliedExpenses.length === 0 ? (
          <p className="text-sm text-slate-500">No expenses fall in this period for {platform}.</p>
        ) : (
          <div className="space-y-1">
            {appliedExpenses.slice(0, 6).map((expense) => (
              <div key={`${expense.expense_id}-${expense.occurrence_date}`} className="flex items-center justify-between rounded-lg border border-slate-100 px-2 py-1.5 text-sm">
                <span className="text-slate-700">
                  {expense.description || "Expense"} ({expense.occurrence_date}) {expense.expense_type === "recurring" ? "• recurring" : ""}
                </span>
                <span className="font-semibold text-slate-900">{currency}{Number(expense.amount || 0).toFixed(2)}</span>
              </div>
            ))}
            {appliedExpenses.length > 6 ? (
              <p className="text-xs text-slate-500">+{appliedExpenses.length - 6} more expense occurrence(s) in this period.</p>
            ) : null}
          </div>
        )}
        <p className="mt-2 text-xs text-slate-500">Expenses are centrally managed in the Expenses page and auto-applied by date, marketplace and recurring rules.</p>
      </div>

      {canProcess ? (
        <button
          type="button"
          onClick={runCalculation}
          disabled={!canCalculate || loading}
          className="w-full rounded-xl bg-[var(--md-primary)] px-5 py-3 text-base font-semibold text-white shadow disabled:cursor-not-allowed disabled:opacity-60"
        >
          {loading ? "Processing..." : "Process & Calculate"}
        </button>
      ) : null}

      {fileName ? <p className="text-sm text-slate-600">Loaded file: {fileName}</p> : null}
      {message ? <p className="rounded-2xl bg-green-50 px-3 py-2 text-sm text-green-700">{message}</p> : null}
      {error ? <p className="rounded-2xl bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p> : null}
      {warnings.length > 0 ? (
        <div className="rounded-2xl border border-yellow-200 bg-yellow-50 p-3 text-sm text-yellow-800">
          <p className="mb-1 font-semibold">Data quality warnings</p>
          <ul className="list-disc space-y-0.5 pl-5">
            {warnings.map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
        </div>
      ) : null}

      {preview ? (
        <div className="space-y-4 rounded-2xl border border-slate-200 bg-white p-5">
          <div className="grid gap-3 md:grid-cols-3">
            <div className="rounded-2xl bg-slate-50 p-4">
              <p className="text-xs text-slate-500">Total Product Sales</p>
              <p className="text-xl font-semibold">{currency}{previewProductSales.toFixed(2)}</p>
            </div>
            <div className="rounded-2xl bg-slate-50 p-4">
              <p className="text-xs text-slate-500">Total COGS</p>
              <p className="text-xl font-semibold">{currency}{preview.totalCogs.toFixed(2)}</p>
            </div>
            <div className="rounded-2xl bg-slate-50 p-4">
              <p className="text-xs text-slate-500">Total Fees</p>
              <p className="text-xl font-semibold">{currency}{preview.totalFees.toFixed(2)}</p>
            </div>
            <div className="rounded-2xl bg-slate-50 p-4">
              <p className="text-xs text-slate-500">Total Expenses</p>
              <p className="text-xl font-semibold">{currency}{appliedExpenseTotals.net.toFixed(2)}</p>
            </div>
            {!isZeroVatAccount ? (
              <div className="rounded-2xl bg-slate-50 p-4">
                <p className="text-xs text-slate-500">Output VAT</p>
                <p className="text-xl font-semibold">{currency}{preview.outputVat.toFixed(2)}</p>
              </div>
            ) : null}
            {!isZeroVatAccount ? (
              <div className="rounded-2xl bg-slate-50 p-4">
                <p className="text-xs text-slate-500">Input VAT</p>
                <p className="text-xl font-semibold">{currency}{preview.inputVat.toFixed(2)}</p>
              </div>
            ) : null}
            <div className="rounded-2xl bg-slate-50 p-4">
              <p className="text-xs text-slate-500">Units Sold</p>
              <p className="text-xl font-semibold">{preview.unitsSold.toLocaleString()}</p>
            </div>
          </div>

          <div className="rounded-2xl bg-slate-900 p-4 text-white">
            <p className="text-xs uppercase tracking-wide text-slate-300">Net Profit</p>
            <p className="text-2xl font-semibold">{currency}{preview.netProfit.toFixed(2)}</p>
          </div>

          {platform === "temu" &&
          typeof preview.breakdown?.pnl?.coreOperatingProfit === "number" &&
          typeof preview.breakdown?.pnl?.adjustmentsNet === "number" ? (
            <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
              <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-600">
                Temu Profit Bridge
              </p>
              <div className="space-y-1 text-sm">
                <div className="flex items-center justify-between">
                  <span className="text-slate-600">Core sales operating profit</span>
                  <span className="font-semibold text-slate-900">
                    {currency}
                    {Number(preview.breakdown.pnl.coreOperatingProfit || 0).toFixed(2)}
                  </span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-slate-600">Adjustments net (labels/repayments/penalties)</span>
                  <span className="font-semibold text-slate-900">
                    {currency}
                    {Number(preview.breakdown.pnl.adjustmentsNet || 0).toFixed(2)}
                  </span>
                </div>
                <div className="flex items-center justify-between border-t border-slate-200 pt-2">
                  <span className="font-semibold text-slate-800">Marketplace operating profit</span>
                  <span className="font-bold text-slate-900">
                    {currency}
                    {(
                      Number(preview.breakdown.pnl.coreOperatingProfit || 0) +
                      Number(preview.breakdown.pnl.adjustmentsNet || 0)
                    ).toFixed(2)}
                  </span>
                </div>
              </div>
            </div>
          ) : null}

          {preview.breakdown.adsOverride ? (
            <div className="rounded-2xl bg-blue-50 px-4 py-2 text-xs text-blue-800">
              Advertising figure replaced with uploaded ads report ({currency}
              {preview.breakdown.adsOverride.adReportTotal.toFixed(2)} from{" "}
              <span className="font-mono">{preview.breakdown.adsOverride.sourceFilename}</span>;
              transaction-sheet ad cost was {currency}
              {Math.abs(preview.breakdown.adsOverride.previousAdExvat).toFixed(2)}). Per-SKU
              advertising allocations use the report directly.
            </div>
          ) : null}

          {(platform === "amazon" || platform === "tiktok") && preview.skuLines && preview.skuLines.length > 0 ? (
            <div className="rounded-2xl border border-slate-200 bg-white p-4">
              <div className="mb-3 flex items-center justify-between">
                <h4 className="text-sm font-semibold text-slate-800">Per-SKU Profitability</h4>
                <span className="text-xs text-slate-500">{preview.skuLines.length} SKUs</span>
              </div>
              <PerSkuTable
                rows={preview.skuLines as unknown as PerSkuRow[]}
                currency={currency}
                detailed
                csvFilename={`per-sku-${account.name.replace(/[^a-z0-9]+/gi, "-")}-${platform}-${periodStart}_${periodEnd}`}
              />
            </div>
          ) : null}

          {canProcess ? (
            <button
              type="button"
              onClick={saveReport}
              disabled={saving}
              className="rounded-xl bg-[var(--md-primary)] px-5 py-2 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-60"
            >
              {saving ? "Saving report..." : "Save report + per-SKU"}
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
