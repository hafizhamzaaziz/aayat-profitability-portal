// Verify Overview/Daily Sales unification helpers and incremental SP-API windows.
//
// Run with:
//   node --experimental-strip-types --experimental-transform-types scripts/verify-inventory-unify.mts

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildUnifiedDailySales, displaySoldUnits, mapSalesFactsToTxFacts, sumReportedSoldUnits, sumTxFactsByPlatform } from "../lib/inventory/sales-facts.ts";
import { clipReplaceRange, expandToCoveredMonths, nextFinanceWindow } from "../lib/amazon/ingest/sync-window.ts";
import { mapFinancialEvents } from "../lib/amazon/ingest/finance-mapper.ts";
import {
  applyOrderDateMap,
  calendarDateFromIso,
  postedDateFromRaw,
  purchaseDateFromRaw,
  transactionDateForSalesFact,
} from "../lib/amazon/ingest/order-date-utils.ts";

let failed = 0;

function assert(name: string, condition: boolean, detail?: unknown) {
  if (condition) {
    console.log(`ok  ${name}`);
    return;
  }
  failed += 1;
  console.error(`FAIL ${name}`, detail ?? "");
}

const mappings = [
  { mappingId: "m-amz", amazonSku: "REX-1", temuSkuId: null },
  { mappingId: "m-temu", amazonSku: null, temuSkuId: "TEMU-9" },
];

const { txFacts, monthlySales } = mapSalesFactsToTxFacts({
  mappings,
  facts: [
    { platform: "amazon", sku: "rex-1", sale_date: "2026-09-10", qty: 10 },
    { platform: "amazon", sku: "REX-1", sale_date: "2026-09-10", qty: 3 },
    { platform: "temu", sku: "TEMU-9", sale_date: "2026-09-11", qty: 2 },
    { platform: "amazon", sku: "UNMAPPED", sale_date: "2026-09-10", qty: 99 },
    { platform: "amazon", sku: "REX-1", sale_date: "2026-09-10", qty: 0 },
  ],
});

assert("maps amazon+temu facts onto mappings", txFacts.length === 3);
assert(
  "aggregates monthly amazon units",
  monthlySales.some((row) => row.mappingId === "m-amz" && row.monthStart === "2026-09-01" && row.amazonUnits === 13),
);
assert(
  "aggregates monthly temu units",
  monthlySales.some((row) => row.mappingId === "m-temu" && row.temuUnits === 2),
);

const unified = buildUnifiedDailySales({
  txFacts,
  manual: [
    {
      id: "manual-1",
      sku_mapping_id: "m-amz",
      sale_date: "2026-09-10",
      platform: "amazon",
      warehouse_id: "wh-1",
      sold_units: 313,
      returns_units: 1,
      collected_units: 0,
      notes: "manual overlay",
      created_at: "2026-09-10T00:00:00.000Z",
    },
    {
      id: "manual-2",
      sku_mapping_id: "m-amz",
      sale_date: "2026-09-15",
      platform: "amazon",
      warehouse_id: null,
      sold_units: 5,
      returns_units: 0,
      collected_units: 2,
      notes: null,
      created_at: "2026-09-15T00:00:00.000Z",
    },
    {
      id: "manual-temu",
      sku_mapping_id: "m-temu",
      sale_date: "2026-09-12",
      platform: "temu",
      warehouse_id: null,
      sold_units: 225,
      returns_units: 0,
      collected_units: 0,
      notes: null,
      created_at: "2026-09-12T00:00:00.000Z",
    },
    {
      id: "manual-tiktok",
      sku_mapping_id: "m-amz",
      sale_date: "2026-09-13",
      platform: "tiktok",
      warehouse_id: null,
      sold_units: 1,
      returns_units: 0,
      collected_units: 0,
      notes: "tiktok",
      created_at: "2026-09-13T00:00:00.000Z",
    },
  ],
});

const reportRow = unified.find((row) => row.source === "reports" && row.sku_mapping_id === "m-amz" && row.sale_date === "2026-09-10");
const manualOnly = unified.find((row) => row.source === "manual" && row.id === "manual-2");
const manualTemu = unified.find((row) => row.id === "manual-temu");
const manualTiktok = unified.find((row) => row.id === "manual-tiktok");
const columnSold = unified.reduce((acc, row) => acc + Number(row.sold_units || 0), 0);
const periodSold = sumTxFactsByPlatform(txFacts, { from: "2026-09-10", to: "2026-09-17" });

assert("reports row uses facts sold, not manual 313", reportRow?.sold_units === 13);
assert("reports row keeps manual returns overlay", reportRow?.returns_units === 1);
assert("reports rows are not editable", reportRow?.editable === false);
assert("manual-only sold is zeroed; returns/collected kept", manualOnly?.sold_units === 0 && manualOnly?.collected_units === 2 && manualOnly.editable === true);
assert("unmatched Temu manual sold is zeroed", manualTemu?.sold_units === 0 && manualTemu?.source === "manual");
assert("TikTok manual sold is zeroed", manualTiktok?.sold_units === 0);
assert("Units Sold column sums facts only (no 313+225+1 mix)", columnSold === 15);
assert("headline sold units ignore manual-only rows", sumReportedSoldUnits(unified) === 15);
assert("Overview period sold matches Daily Sales facts", periodSold.amazon === 13 && periodSold.temu === 2 && periodSold.combined === 15);
assert("displaySoldUnits is cache-only", displaySoldUnits({ source: "manual", sold_units: 87 }) === 0);
assert("displaySoldUnits keeps report sold", displaySoldUnits({ source: "reports", sold_units: 13 }) === 13);

const rexoLike = buildUnifiedDailySales({
  txFacts: [
    { mappingId: "m-amz", date: "2026-09-01", platform: "amazon", quantity: 1096 },
  ],
  manual: [
    {
      id: "m1",
      sku_mapping_id: "m-amz",
      sale_date: "2026-09-02",
      platform: "amazon",
      warehouse_id: null,
      sold_units: 87,
      returns_units: 0,
      collected_units: 0,
      notes: null,
      created_at: "2026-09-02T00:00:00.000Z",
    },
    {
      id: "m2",
      sku_mapping_id: "m-temu",
      sale_date: "2026-09-02",
      platform: "temu",
      warehouse_id: null,
      sold_units: 225,
      returns_units: 0,
      collected_units: 0,
      notes: null,
      created_at: "2026-09-02T00:00:00.000Z",
    },
    {
      id: "m3",
      sku_mapping_id: "m-amz",
      sale_date: "2026-09-02",
      platform: "tiktok",
      warehouse_id: null,
      sold_units: 1,
      returns_units: 0,
      collected_units: 0,
      notes: null,
      created_at: "2026-09-02T00:00:00.000Z",
    },
  ],
});
const rexoColumn = rexoLike.reduce((acc, row) => acc + Number(row.sold_units || 0), 0);
assert("Rexo-shaped mix: column sold is 1096 not 1389", rexoColumn === 1096);
assert("Rexo-shaped mix: Amazon column is facts only", rexoLike.filter((r) => r.platform === "amazon").reduce((a, r) => a + r.sold_units, 0) === 1096);
assert("Rexo-shaped mix: Temu/TikTok sold columns are 0", rexoLike.filter((r) => r.platform !== "amazon").every((r) => r.sold_units === 0));

assert(
  "stuck May watermark walks into June",
  JSON.stringify(nextFinanceWindow({ through: "2026-05-31", today: "2026-09-17" })) ===
    JSON.stringify({ from: "2026-06-01", to: "2026-06-30" }),
);
assert(
  "new account starts 90d lookback at month start",
  JSON.stringify(nextFinanceWindow({ through: null, today: "2026-09-17" })) ===
    JSON.stringify({ from: "2026-06-01", to: "2026-06-30" }),
);
assert(
  "current month refreshes month-start through today",
  JSON.stringify(nextFinanceWindow({ through: "2026-09-16", today: "2026-09-17" })) ===
    JSON.stringify({ from: "2026-09-01", to: "2026-09-17" }),
);
assert(
  "custom 3-day range expands to full month",
  JSON.stringify(expandToCoveredMonths("2026-06-04", "2026-06-06", "2026-09-17")) ===
    JSON.stringify({ from: "2026-06-01", to: "2026-06-30" }),
);

const partial = clipReplaceRange({
  bucketStart: "2026-06-01",
  bucketEnd: "2026-06-30",
  windowFrom: "2026-06-01",
  windowTo: "2026-06-04",
});
assert("short June 1-4 window does not replace the whole month", partial.replaceEntireReport === false);
assert("short window clips replaceTo to June 4", partial.replaceTo === "2026-06-04");

const full = clipReplaceRange({
  bucketStart: "2026-06-01",
  bucketEnd: "2026-06-30",
  windowFrom: "2026-06-01",
  windowTo: "2026-06-30",
});
assert("full-month window replaces the report", full.replaceEntireReport === true);

const here = dirname(fileURLToPath(import.meta.url));
const syncRoute = readFileSync(join(here, "../app/api/amazon/sync/route.ts"), "utf8");
const orchestrate = readFileSync(join(here, "../lib/amazon/ingest/orchestrate.ts"), "utf8");
const workbench = readFileSync(join(here, "../app/(portal)/reports/report-workbench.tsx"), "utf8");
const rpcSql = readFileSync(join(here, "../supabase/migrations/20260917120000_refresh_sales_facts_date_window.sql"), "utf8");
assert(
  "POST/GET amazon sync route calls refreshInventorySalesFacts",
  syncRoute.includes("await refreshInventorySalesFacts(admin, input.accountId)"),
);
assert(
  "ingestMonth refreshes facts after inserting report_transactions",
  orchestrate.includes("from(\"report_transactions\").insert") &&
    orchestrate.includes("refreshInventorySalesFacts(supabase, accountId"),
);
assert(
  "manual report save refreshes facts after tx insert",
  workbench.includes("from(\"report_transactions\").insert") && workbench.includes("refreshInventorySalesFacts"),
);
assert(
  "Temu cache filter stays order payment (not widened to order)",
  rpcSql.includes("like 'temu%' and lower(coalesce(rt.raw_row->>'Transaction type', '')) = 'order payment'"),
);
assert("TikTok is not a facts-cache platform in the RPC", !rpcSql.toLowerCase().includes("tiktok"));
assert(
  "ingest stamps transaction_date from order date helper",
  orchestrate.includes("transactionDateForSalesFact") && orchestrate.includes("stampFinanceRowsWithOrderDates"),
);
assert(
  "daily cron backfills current-month Amazon order dates",
  syncRoute.includes("backfillAmazonOrderDates"),
);

// Posted date ≠ order date: cache sale_date (transaction_date) must use order date.
const postedIso = "2026-09-16T14:46:28Z";
const purchaseIso = "2026-09-14T09:11:00Z";
const { rows: mappedOrderRows } = mapFinancialEvents({
  ShipmentEventList: [
    {
      AmazonOrderId: "026-4086312-1872331",
      MarketplaceName: "Amazon.co.uk",
      PostedDate: postedIso,
      PurchaseDate: purchaseIso,
      ShipmentItemList: [{ SellerSKU: "4feet_topper", QuantityShipped: 1, OrderItemId: "oi-1" }],
    },
  ],
});
const mappedOrder = mappedOrderRows[0];
assert("mapper keeps date/time as PostedDate", mappedOrder?.["date/time"] === postedIso);
assert("mapper __posted_date is posted calendar day", mappedOrder?.__posted_date === "2026-09-16");
assert("mapper __order_date is purchase calendar day when payload has PurchaseDate", mappedOrder?.__order_date === "2026-09-14");
assert("mapper raw purchase date is order date", mappedOrder?.["purchase date"] === "2026-09-14");
assert(
  "sales-fact transaction_date uses order date, not posted",
  transactionDateForSalesFact(mappedOrder) === "2026-09-14",
);

const { rows: postedOnlyRows } = mapFinancialEvents({
  ShipmentEventList: [
    {
      AmazonOrderId: "203-9240286-8225157",
      MarketplaceName: "Amazon.co.uk",
      PostedDate: postedIso,
      ShipmentItemList: [{ SellerSKU: "4feet_topper", QuantityShipped: 2, OrderItemId: "oi-2" }],
    },
  ],
});
const postedOnly = postedOnlyRows[0];
assert("ShipmentEvent without PurchaseDate has no __order_date", postedOnly?.__order_date == null);
assert(
  "Orders API map stamps purchase date while leaving posted date/time",
  (() => {
    applyOrderDateMap(postedOnlyRows, new Map([["203-9240286-8225157", "2026-09-12"]]));
    return (
      postedOnly["date/time"] === postedIso &&
      postedOnly.__posted_date === "2026-09-16" &&
      postedOnly.__order_date === "2026-09-12" &&
      postedOnly["purchase date"] === "2026-09-12" &&
      transactionDateForSalesFact(postedOnly) === "2026-09-12" &&
      postedDateFromRaw(postedOnly) === "2026-09-16" &&
      purchaseDateFromRaw(postedOnly) === "2026-09-12"
    );
  })(),
);

assert(
  "UK marketplace converts late-UTC purchase instant to next local day",
  calendarDateFromIso("2026-09-16T23:30:00Z", "Amazon.co.uk") === "2026-09-17",
);
assert(
  "posted date stays UTC even for UK marketplace timestamps",
  calendarDateFromIso("2026-09-16T23:30:00Z", null) === "2026-09-16",
);

if (failed > 0) {
  console.error(`\n${failed} assertion(s) failed`);
  process.exit(1);
}
console.log("\nAll inventory unify / sync-window assertions passed.");
