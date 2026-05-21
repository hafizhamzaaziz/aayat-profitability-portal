/**
 * End-to-end verification for the Temu ads-report flow.
 *
 * 1. Parse the txn file with `runTemu` (no override) → baseline figures.
 * 2. Parse the ads file with the ads-report parser.
 * 3. Build a mock goods→SKU map from observed orderIdToSkus and the ads
 *    Goods names (so we exercise both ID-tier matching and name-tier).
 * 4. Allocate ads via `allocateTemuAds` → per-SKU spend.
 * 5. Re-run `runTemu` with the override → compare account-level + per-SKU.
 *
 * Usage:
 *   npx --yes tsx@latest scripts/verify-temu-ads.mts
 */

import * as XLSX from "xlsx";
import { readFileSync } from "node:fs";
import TemuModRaw from "../lib/reports/temu-pnl.ts";
import TemuAdModRaw from "../lib/reports/temu-ad-report.ts";
const TemuMod = TemuModRaw as unknown as typeof import("../lib/reports/temu-pnl.ts");
const TemuAdMod = TemuAdModRaw as unknown as typeof import("../lib/reports/temu-ad-report.ts");
const { runTemu, computeTemuPnl } = TemuMod;
const { loadTemuAdReport, allocateTemuAds, temuAdReportFromRows } = TemuAdMod;

const TXN_PATH = "/Users/hamzaaziz/Downloads/UK-Rexo-Reports-2026_03_01-2026_03_31.xlsx";
const ADS_PATH = "/Users/hamzaaziz/Downloads/Product Ads_Product data details2026-04-29 11_23_All store product data_2026-03-01-2026-03-31.xlsx";

function readSheetAsAoa(path: string): unknown[][] {
  const buf = readFileSync(path);
  const wb = XLSX.read(buf, { type: "buffer" });
  const ws = wb.Sheets[wb.SheetNames[0]];
  return XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, defval: "" }) as unknown[][];
}

function adsAsBlobLikeFile(path: string): File {
  const buf = readFileSync(path);
  // Node has Blob/File globally on 22+, fall back to a minimal duck type.
  // The parser only needs `arrayBuffer()` + `name` + `type`.
  return {
    name: path.split("/").pop() || "file.xlsx",
    type: "",
    arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
  } as unknown as File;
}

const fmt = (n: number) => `£${(Math.round(n * 100) / 100).toFixed(2)}`;

async function main() {
  console.log("\n=== Temu ads-flow verification ===\n");

  // 1) Baseline: txn-only
  const txnRows = readSheetAsAoa(TXN_PATH);
  const baseline = runTemu(txnRows, { vatRatePct: 20, defaultDateIso: "2026-03-01" });
  console.log("Txn rows:", baseline.totals.rowsProcessed);
  console.log("Net sales (ex-VAT):           ", fmt(baseline.totals.netSales));
  console.log("Advertising ex-VAT (txn):     ", fmt(baseline.totals.advertisingExvat));
  console.log("Operating profit (no ads):    ", fmt(baseline.totals.operatingProfit));
  console.log("Settlement value (txn):       ", fmt(baseline.totals.settlementValue));

  // 2) Parse the ads report
  const adReport = await loadTemuAdReport(adsAsBlobLikeFile(ADS_PATH));
  console.log("\n--- Ads report ---");
  console.log("Goods entries:", adReport.goodsCount, " | total spend (ex-VAT):", fmt(adReport.totalSpend));
  console.log("Blank-Goods spend:", fmt(adReport.blankGoodsSpend));
  console.log("Spend column label:", adReport.spendColumn);

  // 3) Build a mock goods→SKU map (empty, so allocator falls back to name-prefix)
  const goodsToSkuIds = new Map<string, string[]>();
  const pnl = computeTemuPnl(txnRows);
  console.log("\n--- Allocator (ID-tier empty → name fallback) ---");
  const allocation = allocateTemuAds({ adReport, pnl, goodsToSkuIds });
  let perSkuSum = 0;
  for (const [, v] of Object.entries(allocation.spendBySku)) perSkuSum += v;
  console.log("Per-SKU spend keys:", Object.keys(allocation.spendBySku).length);
  console.log("Σ spendBySku:                 ", fmt(perSkuSum));
  console.log("Unmatched (redistributed):    ", fmt(allocation.unmatchedSpendExvat));
  console.log(
    "Recon: spendBySum + unmatched =",
    fmt(perSkuSum + (perSkuSum > 0 ? 0 : allocation.unmatchedSpendExvat)),
    " | adReport.total =",
    fmt(adReport.totalSpend)
  );

  console.log("\nBucket stats:");
  for (const b of allocation.bucketStats) {
    console.log(
      `  [${b.matchedKind}] ${b.goodsId ?? "(blank)"} :: ${fmt(b.spendExvat)} :: matched=${b.matchedSkus.length}` +
        (b.goodsName ? ` :: ${b.goodsName.slice(0, 60)}` : "")
    );
  }

  // 4) Now re-run the engine with the override.
  console.log("\n--- Engine with ads-report override ---");
  const adOverride = {
    totalExvat: allocation.totalSpendExvat,
    spendBySku: allocation.spendBySku,
    unmatchedSpendExvat: allocation.unmatchedSpendExvat,
    sourceFilename: adReport.sourceFilename,
    spendColumn: adReport.spendColumn,
    goodsCount: adReport.goodsCount,
  };
  const after = runTemu(txnRows, {
    vatRatePct: 20,
    defaultDateIso: "2026-03-01",
    adOverride,
  });
  console.log("Net sales (unchanged):        ", fmt(after.totals.netSales));
  console.log("Advertising ex-VAT (override):", fmt(after.totals.advertisingExvat));
  console.log("Input VAT — advertising:      ", fmt(after.totals.inputVatAdvertising));
  console.log("Operating profit (override):  ", fmt(after.totals.operatingProfit));
  console.log("Settlement value (override):  ", fmt(after.totals.settlementValue));
  console.log("Δ operating profit vs baseline:", fmt(after.totals.operatingProfit - baseline.totals.operatingProfit));
  console.log("Δ settlement vs baseline:     ", fmt(after.totals.settlementValue - baseline.totals.settlementValue));

  // Per-SKU: sanity checks
  const skuLines = after.lines;
  let perSkuAdvSum = 0;
  for (const line of skuLines) perSkuAdvSum += Math.abs(line.advertisingAlloc || 0);
  console.log("\nPer-SKU Σ |advertisingAlloc|: ", fmt(perSkuAdvSum));
  console.log("Account ad ex-VAT (abs):       ", fmt(Math.abs(after.totals.advertisingExvat)));
  console.log(
    "Per-SKU vs account-level diff: ",
    fmt(perSkuAdvSum - Math.abs(after.totals.advertisingExvat))
  );

  // Round-trip the report-from-rows shape
  const goodsRows = Object.entries(adReport.spendByGoodsId).map(([gid, v]) => ({
    temu_goods_id: gid,
    goods_name: adReport.goodsNameByGoodsId[gid] || null,
    spend_exvat: v,
  }));
  if (adReport.blankGoodsSpend > 0) {
    goodsRows.push({ temu_goods_id: null, goods_name: null, spend_exvat: adReport.blankGoodsSpend });
  }
  const reconstituted = temuAdReportFromRows({
    rows: goodsRows,
    totalSpendExvat: adReport.totalSpend,
    blankGoodsSpend: adReport.blankGoodsSpend,
    sourceFilename: adReport.sourceFilename,
    spendColumn: adReport.spendColumn,
  });
  console.log("\n--- Round-trip via temuAdReportFromRows ---");
  console.log("Reconstituted total:", fmt(reconstituted.totalSpend));
  console.log("Reconstituted goods:", reconstituted.goodsCount);

  console.log("\n✓ Verification complete\n");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
