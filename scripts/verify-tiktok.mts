import * as XLSX from "xlsx";
import * as fs from "node:fs";

import TiktokModRaw from "../lib/reports/tiktok-pnl.ts";
const TiktokMod = TiktokModRaw as unknown as typeof import("../lib/reports/tiktok-pnl.ts");
const { runTiktok } = TiktokMod;

const file =
  process.argv[2] ?? "/Users/hamzaaziz/Downloads/All order-2026-06-04-22_10 (1).xlsx";
const buf = fs.readFileSync(file);
const wb = XLSX.read(buf, { type: "buffer" });
const aoa = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[wb.SheetNames[0]], {
  header: 1,
  defval: "",
}) as unknown[][];

const { pnl, totals, lines } = runTiktok(aoa, {
  vatRatePct: 20,
  defaultDateIso: "2026-05-01",
});

console.log("=== Parse ===");
console.log("rowsProcessed:", pnl.rowsProcessed, "rowsSkipped:", pnl.rowsSkipped);
console.log("kept orders:", pnl.keptOrderCount, "cancelled:", pnl.cancelledOrderCount);
console.log("status counts:", JSON.stringify(pnl.statusCounts));

console.log("\n=== Account totals (vat 20%) ===");
console.log("grossOrderAmount (incl VAT):", totals.grossOrderAmountInclVat.toFixed(2));
console.log("refunds (incl VAT):", totals.refundsInclVat.toFixed(2));
console.log("netRevenue (incl VAT):", totals.netRevenueInclVat.toFixed(2));
console.log("netSales (ex-VAT):", totals.netSales.toFixed(2));
console.log("commission (incl VAT):", totals.commissionInclVat.toFixed(2));
console.log("commission (ex-VAT):", totals.commissionExvat.toFixed(2));
console.log("COGS (ex-VAT):", totals.cogs.toFixed(2));
console.log("grossProfit:", totals.grossProfit.toFixed(2));
console.log("operatingProfit:", totals.operatingProfit.toFixed(2));
console.log("outputVat:", totals.outputVat.toFixed(2));
console.log("inputVatCommission:", totals.inputVatCommission.toFixed(2));
console.log("vatPayable:", totals.vatPayable.toFixed(2));
console.log("settlementValue (incl VAT):", totals.settlementValue.toFixed(2));
console.log("matched/unmatched SKUs:", totals.matchedSkus, "/", totals.unmatchedSkus);
console.log("matched/unmatched units:", totals.matchedUnits, "/", totals.unmatchedUnits);

// Independent reconciliation of commission: 12% * grossOrderAmount + 0.5 * keptOrders
const expectedCommission =
  0.12 * totals.grossOrderAmountInclVat + 0.5 * pnl.keptOrderCount;
console.log("\n=== Reconciliation ===");
console.log("expected commission (12%*gross + 0.5*orders):", expectedCommission.toFixed(2));
console.log("per-SKU lines:", lines.length);
const sumNetProfit = lines.reduce((a, l) => a + l.netProfit, 0);
console.log("sum per-SKU netProfit (marketplace):", sumNetProfit.toFixed(2));
console.log("(should match operatingProfit):", totals.operatingProfit.toFixed(2));
const sumNetSales = lines.reduce((a, l) => a + l.netSales, 0);
console.log("sum per-SKU netSales (ex-VAT):", sumNetSales.toFixed(2), "vs", totals.netSales.toFixed(2));

console.log("\n=== Top 8 SKU lines ===");
lines
  .slice()
  .sort((a, b) => b.netSales - a.netSales)
  .slice(0, 8)
  .forEach((l) => {
    console.log(
      `${l.sku.padEnd(18)} units=${String(l.units).padStart(3)} netSales=${l.netSales
        .toFixed(2)
        .padStart(9)} commission=${l.sellingFeesExvat.toFixed(2).padStart(8)} cogs=${l.cogs
        .toFixed(2)
        .padStart(8)} netProfit=${l.netProfit.toFixed(2).padStart(9)} cost?${l.costKnown}`
    );
  });
