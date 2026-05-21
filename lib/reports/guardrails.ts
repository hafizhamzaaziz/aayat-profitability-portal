type Platform = "amazon" | "temu";

const expectedBreakdownLabels: Record<Platform, string[]> = {
  amazon: [
    "Product Sales",
    "Refunds on Sales",
    "Adjustments & Credits",
    "Selling Fees",
    "FBA Fees",
    "FBA Inventory Fee",
    "Other Transaction Fees",
    "Delivery Services",
    "Service Fees",
  ],
  temu: [
    "Order Payments",
    "Return Shipping Credit",
    "Refunds",
    "Service Fees",
    "Shipping Labels & Adjustments",
    "Chargebacks",
    "Penalties",
    "Seller Repayment",
  ],
};

export function validatePeriodRange(periodStart: string, periodEnd: string) {
  if (!periodStart || !periodEnd) return "Period start and end are required.";
  if (periodStart > periodEnd) return "Period start cannot be after period end.";
  return null;
}

export function validateBreakdown(platform: Platform, breakdown: unknown) {
  if (!breakdown || typeof breakdown !== "object") return "Breakdown is missing.";
  const summaryLines = (breakdown as { summaryLines?: Array<{ label?: string }> }).summaryLines;
  if (!Array.isArray(summaryLines)) return "Breakdown summary lines are invalid.";
  const labels = new Set(summaryLines.map((line) => String(line.label || "")));
  const missing = expectedBreakdownLabels[platform].filter((label) => !labels.has(label));
  if (missing.length > 0) return `Breakdown is incomplete. Missing: ${missing.join(", ")}`;
  return null;
}

const MAX_SKU_LIST = 30;

function fmtCount(n: number, singular: string, plural?: string) {
  return `${n} ${n === 1 ? singular : plural || singular + "s"}`;
}

function fmtMoney(value: number, currency = "£") {
  const sign = value < 0 ? "-" : "";
  return `${sign}${currency}${Math.abs(value).toFixed(2)}`;
}

function truncatedSkuList(skus: string[]) {
  if (skus.length <= MAX_SKU_LIST) return skus.join(", ");
  const head = skus.slice(0, MAX_SKU_LIST).join(", ");
  return `${head}, … +${skus.length - MAX_SKU_LIST} more`;
}

export type ReportWarningInput = {
  /** SKUs from the transactions that have no entry in the COGS lookup. */
  missingSkus: string[];
  /** Per-SKU map for noting which missing-COGS SKUs actually moved units this period. */
  missingSkusWithSales?: Array<{ sku: string; units: number; netSales: number }>;
  netProfit: number;
  outputVat: number;
  inputVat: number;
  /** Optional: per-SKU lines from the new engine. */
  skuLines?: Array<{
    sku: string;
    netProfit: number;
    netSales: number;
    units?: number;
    costKnown: boolean;
    adOnly: boolean;
  }>;
  /** Optional: account-level operating profit (sum of skuLines.netProfit should match within £1). */
  accountNetProfit?: number;
  /**
   * When set, per-SKU `netProfit` rows are expected to sum to this marketplace-level
   * figure (before manual external expenses). If omitted, reconciliation falls back to
   * `accountNetProfit` (legacy behaviour).
   */
  skuReconcileBaseline?: number;
  adOverride?: {
    adReportTotal: number;
    /** ex-VAT (negative) advertising figure replaced. */
    previousAdExvat: number;
  } | null;

  /** ---------- Optional account-level totals for richer checks. ---------- */
  /** Period boundaries (YYYY-MM-DD) for date-range checks. */
  periodStart?: string;
  periodEnd?: string;
  /** Number of raw transaction rows actually consumed by the engine. */
  rowsProcessed?: number;
  /** Total rows skipped (unsupported statuses, blank rows etc.). */
  rowsSkipped?: number;
  /** Account-level net sales (positive) and refund magnitudes. */
  netSales?: number;
  productSalesRefunds?: number; // signed (negative)
  /** Account VAT rate as a percentage (e.g. 20 or 0). */
  vatRatePct?: number;
  /** Currency symbol. */
  currency?: string;
  /** Diagnostics from the engine (delivery services / retrocharge unmatched, etc.). */
  diagnostics?: {
    deliveryUnmatched?: number;
    retrochargeUnmatched?: number;
    reimburseUnallocated?: number;
    adSkusUnmatched?: Record<string, number>;
  };
};

/**
 * Produce a comprehensive, human-readable list of data-quality warnings
 * suitable for the on-screen panel and persistence into the saved report.
 *
 * Severity is implicit in ordering: structural issues first, attention
 * items next, soft signals last.
 */
export function deriveReportWarnings(input: ReportWarningInput): string[] {
  const warnings: string[] = [];
  const currency = input.currency || "£";

  // --- 1. Structural / completeness checks ------------------------------------
  if (typeof input.rowsProcessed === "number" && input.rowsProcessed === 0) {
    warnings.push(
        "No rows were processed from the transaction file. Confirm the column headers and that transaction status rows are supported."
    );
  }
  if (
    typeof input.rowsProcessed === "number" &&
    typeof input.rowsSkipped === "number" &&
    input.rowsProcessed > 0 &&
    input.rowsSkipped > input.rowsProcessed
  ) {
    warnings.push(
      `${input.rowsSkipped.toLocaleString()} of ${(input.rowsProcessed + input.rowsSkipped).toLocaleString()} rows were skipped (unsupported status or unrecognised row type). Verify the export covers the right period.`
    );
  }

  // --- 2. Period sanity check -------------------------------------------------
  if (input.periodStart && input.periodEnd) {
    const start = new Date(`${input.periodStart}T00:00:00Z`).getTime();
    const end = new Date(`${input.periodEnd}T00:00:00Z`).getTime();
    const days = Math.round((end - start) / 86400000) + 1;
    if (Number.isFinite(days)) {
      if (days < 7) warnings.push(`Period spans only ${days} day(s). Most monthly comparisons assume a 28–31 day window.`);
      if (days > 92) warnings.push(`Period spans ${days} days. Combined long periods can hide month-on-month signals.`);
    }
  }

  // --- 3. Missing-COGS handling (combined here, instead of a separate block) --
  if (input.missingSkus && input.missingSkus.length > 0) {
    const sold = (input.missingSkusWithSales || []).filter((s) => s.units > 0 || Math.abs(s.netSales) > 0);
    const list = truncatedSkuList([...input.missingSkus].sort());
    if (sold.length > 0) {
      const totalSold = sold.reduce((acc, s) => acc + (s.units || 0), 0);
      warnings.push(
        `Missing COGS for ${fmtCount(input.missingSkus.length, "SKU")} (${totalSold.toLocaleString()} unit(s) sold this period — per-SKU profit treats those as ${currency}0 cost): ${list}`
      );
    } else {
      warnings.push(
        `Missing COGS for ${fmtCount(input.missingSkus.length, "SKU")}: ${list}`
      );
    }
  }

  // --- 4. Engine diagnostics --------------------------------------------------
  const diag = input.diagnostics || {};
  if (typeof diag.deliveryUnmatched === "number" && Math.abs(diag.deliveryUnmatched) > 0.01) {
    warnings.push(
      `${fmtMoney(diag.deliveryUnmatched, currency)} of 'Delivery Services' could not be matched to an order/SKU; fallback allocation was applied where possible.`
    );
  }
  if (typeof diag.retrochargeUnmatched === "number" && diag.retrochargeUnmatched > 0) {
    warnings.push(
      `${diag.retrochargeUnmatched} 'Retrocharge' row(s) could not be matched to an order/SKU; the VAT impact stays at account level.`
    );
  }
  if (typeof diag.reimburseUnallocated === "number" && Math.abs(diag.reimburseUnallocated) > 0.01) {
    warnings.push(
      `${fmtMoney(diag.reimburseUnallocated, currency)} of FBA reimbursements have no SKU and stay at the account level.`
    );
  }
  if (diag.adSkusUnmatched && Object.keys(diag.adSkusUnmatched).length > 0) {
    const skus = Object.keys(diag.adSkusUnmatched).sort();
    const total = Object.values(diag.adSkusUnmatched).reduce((a, b) => a + Number(b || 0), 0);
    warnings.push(
      `${skus.length} SKU(s) in the ads report do not appear in the transactions (${fmtMoney(total, currency)} spend redistributed pro-rata): ${truncatedSkuList(skus)}`
    );
  }

  // --- 5. Per-SKU signals -----------------------------------------------------
  if (input.skuLines && input.skuLines.length > 0) {
    const adOnly = input.skuLines.filter((l) => l.adOnly);
    if (adOnly.length > 0) {
      const list = truncatedSkuList(adOnly.map((l) => l.sku).sort());
      warnings.push(
        `${fmtCount(adOnly.length, "SKU")} have advertising spend but no sales this period (loss-leader): ${list}`
      );
    }
    const losers = input.skuLines.filter((l) => l.netProfit < 0 && Math.abs(l.netSales) > 1);
    if (losers.length > 0 && losers.length >= input.skuLines.length / 3) {
      const top = [...losers]
        .sort((a, b) => a.netProfit - b.netProfit)
        .slice(0, 5)
        .map((l) => `${l.sku} (${fmtMoney(l.netProfit, currency)})`);
      warnings.push(
        `${losers.length} of ${input.skuLines.length} SKUs are unprofitable this period. Worst: ${top.join(", ")}.`
      );
    }
    // High advertising-to-sales ratio — only when sales basis is meaningful.
    const totalSales = input.skuLines.reduce((acc, l) => acc + Math.max(0, l.netSales), 0);
    if (input.adOverride && totalSales > 0) {
      const ratio = (input.adOverride.adReportTotal / totalSales) * 100;
      if (ratio > 30) {
        warnings.push(
          `Advertising spend (${fmtMoney(input.adOverride.adReportTotal, currency)}) is ${ratio.toFixed(1)}% of net sales — verify TACOS is intentional.`
        );
      }
    }
  }

  // --- 6. Refund-rate signal --------------------------------------------------
  if (typeof input.netSales === "number" && typeof input.productSalesRefunds === "number" && input.netSales > 0) {
    const refundAbs = Math.abs(input.productSalesRefunds);
    const ratio = (refundAbs / (input.netSales + refundAbs)) * 100;
    if (ratio > 15) {
      warnings.push(
        `Refunds are ${ratio.toFixed(1)}% of gross product sales (${fmtMoney(refundAbs, currency)}). Investigate listings with high return rates.`
      );
    }
  }

  // --- 7. Financial sanity ----------------------------------------------------
  if (Math.abs(input.netProfit) > 1_000_000) warnings.push("Net profit is unusually large. Please verify the source file.");
  if (Math.abs(input.outputVat - input.inputVat) > 500_000) warnings.push("VAT payable / reclaim value is unusually high.");
  if (typeof input.vatRatePct === "number" && input.vatRatePct === 0 && (input.outputVat > 0.01 || input.inputVat > 0.01)) {
    warnings.push("Account is set to 0% VAT, but the report still contains VAT figures. Check the account VAT rate.");
  }

  // --- 8. Ad-override swing ---------------------------------------------------
  if (input.adOverride) {
    const swing = Math.abs(input.adOverride.adReportTotal - Math.abs(input.adOverride.previousAdExvat));
    if (swing > Math.max(50, Math.abs(input.adOverride.previousAdExvat) * 0.4)) {
      warnings.push(
        `Ads report (${fmtMoney(input.adOverride.adReportTotal, currency)}) differs significantly from the transaction-sheet ad cost (${fmtMoney(Math.abs(input.adOverride.previousAdExvat), currency)}). Verify the period and report align.`
      );
    }
  }

  // --- 9. Reconciliation ------------------------------------------------------
  if (input.skuLines && input.skuLines.length > 0) {
    const sum = input.skuLines.reduce((acc, l) => acc + Number(l.netProfit || 0), 0);
    const baseline =
      typeof input.skuReconcileBaseline === "number"
        ? input.skuReconcileBaseline
        : typeof input.accountNetProfit === "number"
          ? input.accountNetProfit
          : null;
    if (typeof baseline === "number") {
      const diff = Math.abs(sum - baseline);
      if (diff > 5) {
        warnings.push(
          typeof input.skuReconcileBaseline === "number"
            ? `Per-SKU net-profit sum (${fmtMoney(sum, currency)}) does not reconcile to marketplace operating profit (${fmtMoney(baseline, currency)}). Diff ${fmtMoney(diff, currency)}.`
            : `Per-SKU net-profit sum (${fmtMoney(sum, currency)}) does not reconcile to account net profit (${fmtMoney(baseline, currency)}). Diff ${fmtMoney(diff, currency)}.`
        );
      }
    }
  }

  return warnings;
}
