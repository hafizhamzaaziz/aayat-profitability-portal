import * as XLSX from "xlsx";
import * as fs from "node:fs";

import TemuModRaw from "../lib/reports/temu-pnl.ts";
const TemuMod = TemuModRaw as unknown as typeof import("../lib/reports/temu-pnl.ts");
const { runTemu } = TemuMod;

const file = process.argv[2] ?? "/Users/hamzaaziz/Downloads/UK-Rexo-Reports-2026_03_01-2026_03_31.xlsx";
const buf = fs.readFileSync(file);
const wb = XLSX.read(buf, { type: "buffer" });
const aoa = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[wb.SheetNames[0]], { header: 1, defval: "" }) as unknown[][];

const { pnl, totals, lines, diagnostics } = runTemu(aoa, {
  vatRatePct: 20,
  defaultDateIso: "2026-03-01",
});

console.log("=== Engine totals ===");
console.log("netSales (ex-VAT):", totals.netSales.toFixed(2));
console.log("serviceFeesExvat:", totals.serviceFeesExvat.toFixed(2));
console.log("advertisingExvat:", totals.advertisingExvat.toFixed(2));
console.log("shippingLabelsExvat:", totals.shippingLabelsExvat.toFixed(2));
console.log("penaltiesExvat:", totals.penaltiesExvat.toFixed(2));
console.log("returnCreditsExvat:", totals.returnCreditsExvat.toFixed(2));
console.log("totalTemuFeesExvat:", totals.totalTemuFeesExvat.toFixed(2));
console.log("operatingProfit (ex-VAT, COGS=0):", totals.operatingProfit.toFixed(2));
console.log("outputVat:", totals.outputVat.toFixed(2));
console.log("inputVatServiceFees:", totals.inputVatServiceFees.toFixed(2));
console.log("inputVatAdvertising:", totals.inputVatAdvertising.toFixed(2));
console.log("inputVatShippingLabels:", totals.inputVatShippingLabels.toFixed(2));
console.log("totalInputVatTemuFees:", totals.totalInputVatTemuFees.toFixed(2));
console.log("vatPayable (excl COGS reclaim):", totals.vatPayable.toFixed(2));
console.log("settlementValue (cash, incl VAT):", totals.settlementValue.toFixed(2));
console.log("bankTransfers:", totals.bankTransfers.toFixed(2));
console.log("rowsProcessed:", totals.rowsProcessed, "rowsSkipped:", totals.rowsSkipped);
console.log("shippingLabelsUnmatched:", totals.shippingLabelsUnmatched);
console.log("matched/unmatched SKUs:", totals.matchedSkus, "/", totals.unmatchedSkus);
console.log("matched/unmatched units:", totals.matchedUnits, "/", totals.unmatchedUnits);
console.log("unknownTypes:", JSON.stringify(totals.unknownTypes));

console.log("\n=== Raw column reconciliation ===");
const orderRevenueExvat =
  pnl.orderRetail + pnl.orderPlatformDiscount + pnl.orderSellerDiscount +
  pnl.orderPlatformIncentive + pnl.orderShipping;
const refundRevenueExvat =
  pnl.refundRetail + pnl.refundPlatformDiscount + pnl.refundSellerDiscount +
  pnl.refundPlatformIncentive + pnl.refundShipping;
console.log("ex-VAT revenue from Order rows :", orderRevenueExvat.toFixed(2));
console.log("ex-VAT revenue from Refund rows:", refundRevenueExvat.toFixed(2));
console.log("Sum                               :", (orderRevenueExvat + refundRevenueExvat).toFixed(2), "← should match netSales");

console.log("\n=== Per-SKU reconciliation ===");
const sumNetSales = lines.reduce((a, l) => a + l.netSales, 0);
const sumNetProfit = lines.reduce((a, l) => a + l.netProfit, 0);
console.log("Σ per-SKU netSales :", sumNetSales.toFixed(2), "vs totals.netSales :", totals.netSales.toFixed(2));
console.log("Σ per-SKU netProfit:", sumNetProfit.toFixed(2), "vs totals.operating:", totals.operatingProfit.toFixed(2));
console.log("SKUs:", lines.length, "ad-only:", diagnostics.adOnlySkus.length);

console.log("\n=== Top 5 by net profit ===");
for (const l of [...lines].sort((a, b) => b.netProfit - a.netProfit).slice(0, 5)) {
  console.log(`${(l.sku || "?").padEnd(18)}  units=${String(l.units).padStart(4)}  netSales=${l.netSales.toFixed(2).padStart(9)}  netProfit=${l.netProfit.toFixed(2).padStart(9)}`);
}
console.log("\n=== Bottom 3 by net profit ===");
for (const l of [...lines].sort((a, b) => a.netProfit - b.netProfit).slice(0, 3)) {
  console.log(`${(l.sku || "?").padEnd(18)}  units=${String(l.units).padStart(4)}  netSales=${l.netSales.toFixed(2).padStart(9)}  netProfit=${l.netProfit.toFixed(2).padStart(9)}`);
}
