// Verification harness: parses the March 2026 Rexo transaction xlsx + ads CSV
// using the same code the portal uses, and checks per-SKU totals reconcile
// to the account-level numbers (and to the Python script).
//
// Run with:
//   node --experimental-strip-types --experimental-transform-types scripts/verify-pnl.mts

import * as XLSX from "xlsx";
import { readFileSync } from "node:fs";
import Papa from "papaparse";

import PnlModRaw from "../lib/reports/amazon-pnl.ts";
import SkuModRaw from "../lib/reports/per-sku.ts";
import type { AdReport, CogsLookup } from "../lib/reports/types.ts";

const PnlMod = PnlModRaw as unknown as typeof import("../lib/reports/amazon-pnl.ts");
const SkuMod = SkuModRaw as unknown as typeof import("../lib/reports/per-sku.ts");
const { computeAmazonPnl, deriveTotals, applyAdReportOverride, splitVatInclusive } = PnlMod;
const { computePerSku } = SkuMod;

const TX_PATH = "/Users/hamzaaziz/Downloads/2026 Mar Monthly Transaction (Rexo).xlsx";
const AD_PATH = "/Users/hamzaaziz/Downloads/Campaign_-_04_27_2026T18_14_44.csv";
const COSTS_AMZ = "/Users/hamzaaziz/Library/CloudStorage/GoogleDrive-hafizhamzaaziz@gmail.com/My Drive/Amazon/Calculator/Rexo/AMZ SKUs.xlsx";
const COSTS_KA = "/Users/hamzaaziz/Library/CloudStorage/GoogleDrive-hafizhamzaaziz@gmail.com/My Drive/Amazon/Calculator/Rexo/K&A - Adam Duvet Cover Skus (1).xlsx";

function readXlsxRows(path: string): unknown[][] {
  const wb = XLSX.read(readFileSync(path), { type: "buffer" });
  const ws = wb.Sheets[wb.SheetNames[0]];
  return XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, defval: "", blankrows: false });
}

function buildCogsLookup(): CogsLookup {
  const lookup: CogsLookup = new Map();
  // AMZ SKUs.xlsx: col 0 = sku, col 1 = price (ex-VAT)
  const amzWb = XLSX.read(readFileSync(COSTS_AMZ), { type: "buffer" });
  const amzAoa = XLSX.utils.sheet_to_json<unknown[]>(amzWb.Sheets[amzWb.SheetNames[0]], { header: 1, defval: "" });
  for (let i = 1; i < amzAoa.length; i += 1) {
    const row = amzAoa[i];
    const sku = String(row?.[0] ?? "").trim().toLowerCase();
    const price = Number(row?.[1]);
    if (!sku || !Number.isFinite(price)) continue;
    lookup.set(sku, [{ unitCost: price, includesVat: false, effectiveFrom: "1970-01-01" }]);
  }
  // K&A: col 4 = sku, col 3 = price
  const kaWb = XLSX.read(readFileSync(COSTS_KA), { type: "buffer" });
  const kaAoa = XLSX.utils.sheet_to_json<unknown[]>(kaWb.Sheets[kaWb.SheetNames[0]], { header: 1, defval: "" });
  for (let i = 1; i < kaAoa.length; i += 1) {
    const row = kaAoa[i];
    const sku = String(row?.[4] ?? "").trim().toLowerCase();
    const price = Number(row?.[3]);
    if (!sku || !Number.isFinite(price)) continue;
    lookup.set(sku, [{ unitCost: price, includesVat: false, effectiveFrom: "1970-01-01" }]);
  }
  return lookup;
}

function loadAdReportSync(path: string): AdReport {
  const text = readFileSync(path, "utf-8");
  const parsed = Papa.parse<string[]>(text, { header: false, skipEmptyLines: true });
  const rows = parsed.data;
  const header = (rows[0] || []).map((h) => String(h).replace(/\ufeff/g, "").trim().toLowerCase());
  const skuCol = header.findIndex((h) => h.includes("sku"));
  const totalCol = header.findIndex((h) => h.includes("total cost") && !h.includes("reconciled"));
  const fallbackCol = header.findIndex((h) => h.includes("supply cost"));
  const spendCol = totalCol >= 0 ? totalCol : fallbackCol;
  const spendBySku: Record<string, number> = {};
  let blank = 0;
  let total = 0;
  for (let i = 1; i < rows.length; i += 1) {
    const r = rows[i];
    if (!r) continue;
    const sku = String(r[skuCol] ?? "").trim().toLowerCase();
    const amt = Math.abs(Number(String(r[spendCol] ?? "").replace(/[,£$€]/g, "")));
    if (!Number.isFinite(amt) || amt === 0) continue;
    total += amt;
    if (!sku) blank += amt;
    else spendBySku[sku] = (spendBySku[sku] || 0) + amt;
  }
  return { spendBySku, blankSkuSpend: blank, totalSpend: total, sourceFilename: "Campaign.csv", spendColumn: "Total cost", skuCount: Object.keys(spendBySku).length };
}

const txRows = readXlsxRows(TX_PATH);
const cogs = buildCogsLookup();
const ad = loadAdReportSync(AD_PATH);

const pnl = computeAmazonPnl(txRows);
const before = applyAdReportOverride(pnl, ad.totalSpend, 20);
const totals = deriveTotals({ pnl, cogsLookup: cogs, vatRatePct: 20, defaultDateIso: "2026-03-01" });
const { lines, diagnostics } = computePerSku({ pnl, cogsLookup: cogs, vatRatePct: 20, defaultDateIso: "2026-03-01", adReport: ad });

console.log("\n=== Account totals (with ads override) ===");
console.log(`Net Sales (ex-VAT)        £${totals.netSales.toFixed(2)}`);
console.log(`COGS                      £${totals.cogs.toFixed(2)}`);
console.log(`Gross Profit              £${totals.grossProfit.toFixed(2)}`);
console.log(`Total Amazon Fees ex-VAT  £${totals.totalAmazonFeesExvat.toFixed(2)}`);
console.log(`FBA Reimbursements        £${totals.fbaReimbursements.toFixed(2)}`);
console.log(`Operating / Net Profit    £${totals.operatingProfit.toFixed(2)}`);
console.log(`Output VAT (collected)    £${totals.totalOutputVat.toFixed(2)}`);
console.log(`Marketplace withheld VAT  £${totals.marketplaceWithheldTax.toFixed(2)}`);
console.log(`Output VAT to HMRC        £${totals.outputVatPayableToHmrc.toFixed(2)}`);
console.log(`Total Input VAT (Amazon)  £${totals.totalInputVatAmazonFees.toFixed(2)}`);
console.log(`Input VAT — COGS          £${totals.inputVatCogs.toFixed(2)}`);
console.log(`Total Input VAT (incl)    £${totals.totalInputVatIncludingCogs.toFixed(2)}`);
console.log(`VAT Payable               £${totals.vatPayable.toFixed(2)}`);
console.log(`Bank Transfers            £${totals.bankTransfers.toFixed(2)}`);

console.log(`\nDiagnostics: rows ${totals.rowsProcessed}/${totals.rowsProcessed + totals.rowsSkipped}, matched SKUs ${totals.matchedSkus}, unmatched ${totals.unmatchedSkus}`);
console.log(`Ads: was £${(-before.previousAdExvat).toFixed(2)} → report £${ad.totalSpend.toFixed(2)} (${ad.skuCount} SKUs + £${ad.blankSkuSpend.toFixed(2)} blank)`);
console.log(`Ad-only SKUs: ${diagnostics.adOnlySkus.length}`);

console.log("\n=== Per-SKU reconciliation ===");
const sums = {
  "Net Sales": lines.reduce((a, l) => a + l.netSales, 0),
  "COGS": lines.reduce((a, l) => a + l.cogs, 0),
  "Selling fees": lines.reduce((a, l) => a + l.sellingFeesExvat, 0),
  "Deal fees alloc": lines.reduce((a, l) => a + l.dealFeesAlloc, 0),
  "FBA fees": lines.reduce((a, l) => a + l.fbaFeesExvat, 0),
  "Other tx fees": lines.reduce((a, l) => a + l.otherTxFeesExvat, 0),
  "Delivery svcs": lines.reduce((a, l) => a + l.deliveryServicesExvat, 0),
  "Advertising": lines.reduce((a, l) => a + l.advertisingAlloc, 0),
  "FBA inv alloc": lines.reduce((a, l) => a + l.fbaInventoryAlloc, 0),
  "Subscription": lines.reduce((a, l) => a + l.subscriptionAlloc, 0),
  "FBA reimburse": lines.reduce((a, l) => a + l.fbaReimbursements, 0),
  "Net Profit": lines.reduce((a, l) => a + l.netProfit, 0),
};

const [sellingExSkued] = splitVatInclusive(pnl.sellingFeesGrossSkued, 0.2);
const [dealEx] = splitVatInclusive(pnl.dealFeesGross, 0.2);

const acct: Record<string, number> = {
  "Net Sales": totals.netSales,
  "COGS": totals.cogs,
  "Selling fees": sellingExSkued,
  "Deal fees alloc": dealEx,
  "FBA fees": totals.fbaFeesExvat,
  "Other tx fees": totals.otherTxFeesExvat,
  "Delivery svcs": totals.deliveryServicesExvat,
  "Advertising": totals.advertisingExvat,
  "FBA inv alloc": totals.fbaInventoryFeesExvat,
  "Subscription": totals.subscriptionExvat,
  "FBA reimburse": totals.fbaReimbursements,
  "Net Profit": totals.operatingProfit,
};

let ok = true;
for (const k of Object.keys(sums)) {
  const a = sums[k as keyof typeof sums];
  const b = acct[k];
  const diff = a - b;
  // 0.10 tolerance — per-SKU 2dp rounding accumulates a few pence over 80+ SKUs.
  const flag = Math.abs(diff) > 0.1 ? " ⚠" : "";
  if (Math.abs(diff) > 0.1) ok = false;
  console.log(`  ${k.padEnd(18)}  per-SKU £${a.toFixed(2).padStart(12)}  account £${b.toFixed(2).padStart(12)}  diff £${diff.toFixed(4).padStart(10)}${flag}`);
}
console.log(`\n${ok ? "✅ All components reconcile to within £0.10" : "❌ Reconciliation failed"}`);

console.log("\n=== Top 5 by Net Profit ===");
for (const l of [...lines].slice(0, 5)) {
  console.log(`  ${l.sku.padEnd(28)}  units ${String(l.units).padStart(4)}  sales £${l.netSales.toFixed(2).padStart(9)}  ad £${l.advertisingAlloc.toFixed(2).padStart(9)}  net £${l.netProfit.toFixed(2).padStart(9)}  margin ${(l.netMargin * 100).toFixed(1).padStart(6)}%`);
}
console.log("\n=== Bottom 5 by Net Profit ===");
for (const l of [...lines].sort((a, b) => a.netProfit - b.netProfit).slice(0, 5)) {
  console.log(`  ${l.sku.padEnd(28)}  units ${String(l.units).padStart(4)}  sales £${l.netSales.toFixed(2).padStart(9)}  ad £${l.advertisingAlloc.toFixed(2).padStart(9)}  net £${l.netProfit.toFixed(2).padStart(9)}  margin ${(l.netMargin * 100).toFixed(1).padStart(7)}%`);
}
