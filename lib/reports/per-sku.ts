/**
 * Per-SKU profit computation. Direct attribution where possible; allocation
 * for shared costs (advertising, FBA inventory fees, subscription, deal fees).
 *
 * Mirrors `compute_per_sku` in `Rexo/rexo_pnl.py`. Sum across all SkuLines ties
 * to marketplace operating profit (`deriveTotals` … `operatingProfit`). Manual
 * external expenses are applied only at account level — see PDF/UI roll-up row.
 */

import { costForSku, deriveTotals, splitVatInclusive } from "./amazon-pnl";
import type {
  AdReport,
  CogsLookup,
  PerSkuDiagnostics,
  PnL,
  SkuLine,
} from "./types";
import { VAT_RATE_DEFAULT } from "./types";

const round2 = (value: number) => Math.round(value * 100) / 100;

function positiveSales(p: PnL, sku: string): number {
  return Math.max(
    0,
    (p.skuProductSales[sku] || 0) +
      (p.skuPostageCredits[sku] || 0) +
      (p.skuPromoRebates[sku] || 0)
  );
}

export function computePerSku(input: {
  pnl: PnL;
  cogsLookup: CogsLookup;
  vatRatePct: number;
  defaultDateIso: string;
  adReport?: AdReport | null;
}): { lines: SkuLine[]; diagnostics: PerSkuDiagnostics } {
  const { pnl: p, cogsLookup, vatRatePct, defaultDateIso, adReport } = input;
  const vatRate = vatRatePct / 100 || VAT_RATE_DEFAULT;

  // FBA Inventory Fee: Amazon does not provide HMRC-compliant VAT invoices for
  // storage charges in the UK, so the full gross flows through as a cost
  // (no VAT reclaim, allocated across SKUs by units sold).
  const fbaInvExTotal = p.fbaInventoryFeesGross;
  const [subExTotal] = splitVatInclusive(p.subscriptionGross, vatRate);
  const [dealExTotal] = splitVatInclusive(p.dealFeesGross, vatRate);

  // Universe of SKUs: those with units in transactions OR that appeared as
  // FBA reimbursements with a SKU.
  const allSkus = new Set<string>();
  for (const sku of Object.keys(p.skuUnits)) allSkus.add(sku);
  for (const sku of Object.keys(p.skuFbaReimbursements)) allSkus.add(sku);

  // If we have an ads report, also include report-only SKUs (advertised but
  // didn't sell this period) so their loss-leader cost shows up.
  const adOnlySkus = new Set<string>();
  if (adReport) {
    for (const reportSku of Object.keys(adReport.spendBySku)) {
      if (allSkus.has(reportSku)) continue;
      // Try parent fallback for amzn.gr children
      if (reportSku.startsWith("amzn.gr.")) {
        const parent = reportSku.slice("amzn.gr.".length).split("-")[0];
        if (parent && allSkus.has(parent)) continue;
      }
      adOnlySkus.add(reportSku);
      allSkus.add(reportSku);
    }
  }

  let totalUnits = 0;
  for (const u of Object.values(p.skuUnits)) {
    if (u > 0) totalUnits += u;
  }

  let totalNetSalesBasis = 0;
  for (const sku of allSkus) totalNetSalesBasis += positiveSales(p, sku);

  // ------- Advertising allocation -------
  const adAlloc: Record<string, number> = {};
  let adMethod: PerSkuDiagnostics["adMethod"];
  let adReportTotal = 0;
  let adBlankSkuSpend = 0;
  const adSkusUnmatched: Record<string, number> = {};

  if (adReport && Object.keys(adReport.spendBySku).length > 0) {
    adMethod = "report (per-SKU, no scaling)";
    adReportTotal = adReport.totalSpend;
    adBlankSkuSpend = adReport.blankSkuSpend;

    const matchedSpend: Record<string, number> = {};
    for (const [reportSku, spend] of Object.entries(adReport.spendBySku)) {
      let txSku: string | null = null;
      if (allSkus.has(reportSku)) {
        txSku = reportSku;
      } else if (reportSku.startsWith("amzn.gr.")) {
        const parent = reportSku.slice("amzn.gr.".length).split("-")[0];
        if (parent && allSkus.has(parent)) txSku = parent;
      }
      if (!txSku) {
        // Should not normally happen since adOnlySkus added them; safety net.
        adSkusUnmatched[reportSku] = spend;
        txSku = reportSku;
        allSkus.add(txSku);
        adOnlySkus.add(txSku);
      }
      matchedSpend[txSku] = (matchedSpend[txSku] || 0) + spend;
    }

    // Distribute blank-SKU spend (e.g. SB keyword campaigns) across matched
    // SKUs proportionally to their report share.
    const totalMatched = Object.values(matchedSpend).reduce((a, b) => a + b, 0);
    for (const [sku, spend] of Object.entries(matchedSpend)) {
      const extra = totalMatched > 0 ? adBlankSkuSpend * (spend / totalMatched) : 0;
      adAlloc[sku] = -(spend + extra);
    }
  } else {
    // Sales pro-rata fallback.
    adMethod = adReport ? "none" : "sales-pro-rata";
    const totalAdExvat = p.advertisingExvat; // already negative
    if (totalNetSalesBasis > 0) {
      for (const sku of allSkus) {
        const sales = positiveSales(p, sku);
        adAlloc[sku] = totalAdExvat * (sales / totalNetSalesBasis);
      }
    } else {
      for (const sku of allSkus) adAlloc[sku] = 0;
    }
  }

  // ------- FBA inventory fees: pro-rata to units sold -------
  const fbaInvAlloc: Record<string, number> = {};
  for (const sku of allSkus) {
    const u = Math.max(0, p.skuUnits[sku] || 0);
    fbaInvAlloc[sku] = totalUnits > 0 ? fbaInvExTotal * (u / totalUnits) : 0;
  }

  // ------- Subscription + deal fees: pro-rata to net sales -------
  const subAlloc: Record<string, number> = {};
  const dealAlloc: Record<string, number> = {};
  for (const sku of allSkus) {
    const sales = positiveSales(p, sku);
    if (totalNetSalesBasis > 0) {
      subAlloc[sku] = subExTotal * (sales / totalNetSalesBasis);
      dealAlloc[sku] = dealExTotal * (sales / totalNetSalesBasis);
    } else {
      subAlloc[sku] = 0;
      dealAlloc[sku] = 0;
    }
  }

  // ------- Account-level unmatched balances -------
  // Keep per-SKU sum tied to account-level operating profit by allocating
  // unmatched delivery-service costs and reimbursements across SKUs.
  const deliveryUnmatchedAlloc: Record<string, number> = {};
  const reimburseUnallocatedAlloc: Record<string, number> = {};
  // `deliveryServicesUnmatched` is tracked as gross (VAT-inclusive) in PnL,
  // but per-SKU profit is ex-VAT. Split first, then allocate the ex-VAT share.
  const [deliveryUnmatchedExTotal] = splitVatInclusive(p.deliveryServicesUnmatched, vatRate);
  for (const sku of allSkus) {
    const sales = positiveSales(p, sku);
    if (totalNetSalesBasis > 0) {
      deliveryUnmatchedAlloc[sku] = deliveryUnmatchedExTotal * (sales / totalNetSalesBasis);
      reimburseUnallocatedAlloc[sku] = p.fbaReimbursementsUnallocated * (sales / totalNetSalesBasis);
    } else {
      deliveryUnmatchedAlloc[sku] = 0;
      reimburseUnallocatedAlloc[sku] = 0;
    }
  }

  // ------- Build SkuLine rows -------
  const lines: SkuLine[] = [];
  for (const sku of allSkus) {
    const units = p.skuUnits[sku] || 0;
    const refundUnits = p.skuRefundUnits[sku] || 0;
    const productSales = p.skuProductSales[sku] || 0;
    const postageCredits = p.skuPostageCredits[sku] || 0;
    const promoRebates = p.skuPromoRebates[sku] || 0;
    const netSales = productSales + postageCredits + promoRebates;

    const cv = costForSku(cogsLookup, sku, defaultDateIso);
    let cogs = 0; // negative
    let costKnown = false;
    if (cv) {
      costKnown = true;
      // For per-SKU display we use the ex-VAT cost (matches account-level COGS line).
      const unitNet = cv.includesVat && vatRate > 0 ? cv.unitCost / (1 + vatRate) : cv.unitCost;
      cogs = -unitNet * units;
    }

    const [sellingEx] = splitVatInclusive(p.skuSellingFeesGross[sku] || 0, vatRate);
    const [fbaEx] = splitVatInclusive(p.skuFbaFeesGross[sku] || 0, vatRate);
    const [otherTxEx] = splitVatInclusive(p.skuOtherTxFeesGross[sku] || 0, vatRate);
    const [deliveryEx] = splitVatInclusive(p.skuDeliveryServicesGross[sku] || 0, vatRate);

    const advertisingAllocVal = adAlloc[sku] || 0;
    const fbaInventoryAllocVal = fbaInvAlloc[sku] || 0;
    const subscriptionAllocVal = subAlloc[sku] || 0;
    const dealFeesAllocVal = dealAlloc[sku] || 0;
    const fbaReimbursements = (p.skuFbaReimbursements[sku] || 0) + (reimburseUnallocatedAlloc[sku] || 0);

    const totalAmazonFeesExvat =
      sellingEx +
      fbaEx +
      otherTxEx +
      deliveryEx +
      (deliveryUnmatchedAlloc[sku] || 0) +
      advertisingAllocVal +
      fbaInventoryAllocVal +
      subscriptionAllocVal +
      dealFeesAllocVal;

    const grossProfit = netSales + cogs;
    const grossMargin = netSales !== 0 ? grossProfit / netSales : 0;
    const netProfit = netSales + fbaReimbursements + cogs + totalAmazonFeesExvat;
    const netMargin = netSales !== 0 ? netProfit / netSales : 0;

    lines.push({
      sku,
      description: (p.skuDescriptions[sku] || "").slice(0, 240),
      units,
      refundUnits,
      netSales: round2(netSales),
      productSales: round2(productSales),
      postageCredits: round2(postageCredits),
      promoRebates: round2(promoRebates),
      cogs: round2(cogs),
      sellingFeesExvat: round2(sellingEx),
      fbaFeesExvat: round2(fbaEx),
      otherTxFeesExvat: round2(otherTxEx),
      deliveryServicesExvat: round2(deliveryEx),
      advertisingAlloc: round2(advertisingAllocVal),
      fbaInventoryAlloc: round2(fbaInventoryAllocVal),
      subscriptionAlloc: round2(subscriptionAllocVal),
      dealFeesAlloc: round2(dealFeesAllocVal),
      fbaReimbursements: round2(fbaReimbursements),
      outputVatProduct: round2(p.skuOutputVatProduct[sku] || 0),
      outputVatShipping: round2(p.skuOutputVatShipping[sku] || 0),
      outputVatGiftwrap: round2(p.skuOutputVatGiftwrap[sku] || 0),
      outputVatPromo: round2(p.skuOutputVatPromo[sku] || 0),
      marketplaceWithheldVat: round2(p.skuMarketplaceWithheld[sku] || 0),
      retrochargeVat: round2(p.skuRetrochargeVat[sku] || 0),
      grossProfit: round2(grossProfit),
      grossMargin,
      totalAmazonFeesExvat: round2(totalAmazonFeesExvat),
      netProfit: round2(netProfit),
      netMargin,
      costKnown,
      adOnly: adOnlySkus.has(sku),
    });
  }

  // Default sort: Net Profit descending (winners first, losers at bottom).
  // Final reconciliation guardrail: distribute any residual delta between
  // account-level operating profit and per-SKU sum into deal-fee allocation
  // (pro-rata by positive net sales, then units, then equal split).
  const accountOperatingProfit = deriveTotals({
    pnl: p,
    cogsLookup,
    vatRatePct,
    defaultDateIso,
  }).operatingProfit;
  const skuNetProfitSum = round2(lines.reduce((acc, line) => acc + Number(line.netProfit || 0), 0));
  const residual = round2(accountOperatingProfit - skuNetProfitSum);
  if (Math.abs(residual) >= 0.01 && lines.length > 0) {
    const salesBasis = lines.map((line) => Math.max(0, Number(line.netSales || 0)));
    const totalSalesBasis = salesBasis.reduce((acc, value) => acc + value, 0);
    const unitsBasis = lines.map((line) => Math.max(0, Number(line.units || 0)));
    const totalUnitsBasis = unitsBasis.reduce((acc, value) => acc + value, 0);

    let allocated = 0;
    for (let i = 0; i < lines.length; i += 1) {
      const isLast = i === lines.length - 1;
      let share = 1 / lines.length;
      if (totalSalesBasis > 0) {
        share = salesBasis[i] / totalSalesBasis;
      } else if (totalUnitsBasis > 0) {
        share = unitsBasis[i] / totalUnitsBasis;
      }
      const adj = isLast ? round2(residual - allocated) : round2(residual * share);
      allocated = round2(allocated + adj);
      if (adj === 0) continue;
      lines[i].dealFeesAlloc = round2((lines[i].dealFeesAlloc || 0) + adj);
      lines[i].totalAmazonFeesExvat = round2((lines[i].totalAmazonFeesExvat || 0) + adj);
      lines[i].netProfit = round2((lines[i].netProfit || 0) + adj);
      lines[i].netMargin =
        Math.abs(lines[i].netSales || 0) > 0.000001
          ? (lines[i].netProfit || 0) / (lines[i].netSales || 1)
          : 0;
    }
  }

  lines.sort((a, b) => b.netProfit - a.netProfit);

  return {
    lines,
    diagnostics: {
      adMethod,
      adReportTotal: round2(adReportTotal),
      adBlankSkuSpend: round2(adBlankSkuSpend),
      adSkusUnmatched,
      adOnlySkus: Array.from(adOnlySkus),
      adOverridden: Boolean(adReport && Object.keys(adReport.spendBySku).length > 0),
      txSheetAdExvat: 0,
      txSheetAdVat: 0,
      totalUnitsBasis: totalUnits,
      totalNetSalesBasis: round2(totalNetSalesBasis),
    },
  };
}
