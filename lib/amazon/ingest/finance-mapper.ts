/**
 * SP-API Finance event → Amazon Seller Central transaction CSV row mapper.
 *
 * This file's ONE job is to produce row objects whose keys match what the
 * downloadable Amazon Transaction Report CSV uses, so the existing
 * `computeAmazonPnl` engine consumes SP-API-sourced data without changes.
 *
 * Key column conventions enforced here (per `rexo_pnl.py` methodology):
 *   - "product sales", "shipping credits", "promotional rebates": EX-VAT
 *   - "product sales tax", "shipping credits tax", "promotional rebates tax",
 *     "gift wrap credits tax": OUTPUT VAT
 *   - "marketplace withheld tax": negative — Amazon already remitted on our behalf
 *   - "selling fees", "fba fees", "other transaction fees": VAT-INCLUSIVE
 *   - "other": catch-all column where Subscription / FBA Inventory Fee /
 *     Service Fee VAT / Delivery Services / Adjustment amounts live (CSV-style)
 *   - "total": sum of all monetary components on the row (sanity check)
 *
 * For "Cost of Advertising" ServiceFeeEvents we DELIBERATELY skip — ad spend
 * is sourced from the separate Advertising report upload to keep the existing
 * methodology unchanged.
 *
 * Output rows are tagged with `__amazon_event_id` so the orchestrator can
 * dedupe idempotently when the same date window is synced multiple times.
 */

import type {
  AdjustmentEvent,
  AdjustmentItem,
  ChargeComponent,
  CurrencyAmount,
  FeeComponent,
  FinancialEvents,
  PromotionComponent,
  RetrochargeEvent,
  ServiceFeeEvent,
  ShipmentEvent,
  ShipmentItem,
  TaxWithheldComponent,
} from "../finance-types";

export type CsvRow = Record<string, string | number | null> & {
  __amazon_event_id: string;
  __posted_date: string | null;
  __sku: string | null;
  __quantity: number | null;
};

// Canonical Amazon Transaction Report column names. Same casing/spacing as
// the downloadable CSV so the P&L engine's substring-based header detection
// recognises them identically.
const COL = {
  date: "date/time",
  settlementId: "settlement id",
  type: "type",
  orderId: "order id",
  sku: "sku",
  description: "description",
  quantity: "quantity",
  marketplace: "marketplace",
  fulfillment: "fulfillment",
  productSales: "product sales",
  productSalesTax: "product sales tax",
  shippingCredits: "shipping credits",
  shippingCreditsTax: "shipping credits tax",
  giftWrapCredits: "gift wrap credits",
  giftWrapCreditsTax: "gift wrap credits tax",
  promoRebates: "promotional rebates",
  promoRebatesTax: "promotional rebates tax",
  withheldTax: "marketplace withheld tax",
  sellingFees: "selling fees",
  fbaFees: "fba fees",
  otherTxFees: "other transaction fees",
  other: "other",
  total: "total",
  status: "transaction status",
} as const;

/**
 * Single source of truth for the column order. The orchestrator prepends a
 * synthetic "header row" with these keys at index 0 so the existing P&L
 * engine's `findHeaderRowIndex` will lock onto it on the first pass.
 */
export const CSV_HEADER_ORDER: string[] = [
  COL.date,
  COL.settlementId,
  COL.type,
  COL.orderId,
  COL.sku,
  COL.description,
  COL.quantity,
  COL.marketplace,
  COL.fulfillment,
  COL.productSales,
  COL.productSalesTax,
  COL.shippingCredits,
  COL.shippingCreditsTax,
  COL.giftWrapCredits,
  COL.giftWrapCreditsTax,
  COL.promoRebates,
  COL.promoRebatesTax,
  COL.withheldTax,
  COL.sellingFees,
  COL.fbaFees,
  COL.otherTxFees,
  COL.other,
  COL.total,
  COL.status,
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Some SP-API endpoints (Finance especially) return text fields that came
 * from an underlying XML response, with `&`, `<`, `>`, `'`, `"` still
 * HTML-entity-encoded — e.g. SellerSKU `K&A-COT-PNK` arrives as
 * `K&amp;A-COT-PNK`. Decoding it here keeps SKUs consistent with what the
 * COGS/mappings tables (and the manual CSV upload path) expect.
 */
function decodeHtmlEntities(value: string | null | undefined): string {
  if (!value) return "";
  return String(value)
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, dec) => {
      const n = Number(dec);
      return Number.isFinite(n) ? String.fromCodePoint(n) : "";
    })
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => {
      const n = parseInt(hex, 16);
      return Number.isFinite(n) ? String.fromCodePoint(n) : "";
    });
}

function amount(value: CurrencyAmount | undefined | null): number {
  if (!value) return 0;
  const n = Number(value.CurrencyAmount);
  return Number.isFinite(n) ? n : 0;
}

function sumCharges(
  list: ChargeComponent[] | undefined | null,
  predicate: (chargeType: string) => boolean
): number {
  if (!list?.length) return 0;
  let sum = 0;
  for (const entry of list) {
    if (predicate(String(entry.ChargeType || ""))) sum += amount(entry.ChargeAmount);
  }
  return sum;
}

function sumFees(
  list: FeeComponent[] | undefined | null,
  predicate: (feeType: string) => boolean
): number {
  if (!list?.length) return 0;
  let sum = 0;
  for (const entry of list) {
    if (predicate(String(entry.FeeType || ""))) sum += amount(entry.FeeAmount);
  }
  return sum;
}

function sumTaxesWithheld(list: TaxWithheldComponent[] | undefined | null): number {
  if (!list?.length) return 0;
  let sum = 0;
  for (const entry of list) {
    for (const w of entry.TaxesWithheld || []) sum += amount(w.ChargeAmount);
  }
  return sum;
}

function sumPromotionAmounts(list: PromotionComponent[] | undefined | null): number {
  if (!list?.length) return 0;
  let sum = 0;
  for (const p of list) sum += amount(p.PromotionAmount);
  return sum;
}

function rowTotal(row: Omit<CsvRow, "__amazon_event_id" | "__posted_date" | "__sku" | "__quantity" | typeof COL.total>): number {
  // Sum every numeric value other than 'quantity' / 'total' itself.
  const skip = new Set<string>([COL.quantity, COL.total]);
  let sum = 0;
  for (const [k, v] of Object.entries(row)) {
    if (skip.has(k)) continue;
    const n = typeof v === "number" ? v : Number(v);
    if (Number.isFinite(n)) sum += n;
  }
  return Number(sum.toFixed(4));
}

function postedDateOnly(iso: string | undefined | null): string | null {
  if (!iso) return null;
  // Amazon returns "2026-03-15T14:22:11Z" — keep the date portion only so it
  // slots into report_transactions.transaction_date cleanly.
  return iso.slice(0, 10);
}

function blankCsvRow(): Record<string, string | number | null> {
  const o: Record<string, string | number | null> = {};
  for (const k of CSV_HEADER_ORDER) o[k] = k === COL.quantity ? null : 0;
  o[COL.date] = "";
  o[COL.settlementId] = "";
  o[COL.type] = "";
  o[COL.orderId] = "";
  o[COL.sku] = "";
  o[COL.description] = "";
  o[COL.marketplace] = "";
  o[COL.fulfillment] = "";
  o[COL.status] = "Released";
  return o;
}

/**
 * For a ShipmentItem (or its adjustment-list counterpart) tally up the
 * canonical column buckets. Sign of charges/fees is preserved as Amazon
 * returns it (e.g. forward fees are negative; refund commissions positive).
 *
 * CRITICAL: refund events place their per-item amounts in the
 * ItemChargeAdjustmentList / ItemFeeAdjustmentList / PromotionAdjustmentList
 * fields — NOT the forward *List fields. We sum both so the same routine
 * works for ShipmentEvent (forward orders) and RefundEvent (returns).
 */
function tallyShipmentItem(item: ShipmentItem) {
  const charges = [...(item.ItemChargeList || []), ...(item.ItemChargeAdjustmentList || [])];
  const fees = [...(item.ItemFeeList || []), ...(item.ItemFeeAdjustmentList || [])];
  const promotions = [...(item.PromotionList || []), ...(item.PromotionAdjustmentList || [])];

  const productSalesExvat =
    sumCharges(charges, (t) => t === "Principal") +
    sumCharges(charges, (t) => t === "GoodwillAdjustment");
  const productSalesTax = sumCharges(charges, (t) => t === "Tax");
  const shippingExvat =
    sumCharges(charges, (t) => t === "Shipping") +
    sumCharges(charges, (t) => t === "ShippingChargeback");
  const shippingTax = sumCharges(charges, (t) => t === "ShippingTax");
  const giftWrapExvat = sumCharges(charges, (t) => t === "GiftWrap");
  const giftWrapTax = sumCharges(charges, (t) => t === "GiftWrapTax");
  const promoRebates = sumPromotionAmounts(promotions);
  const withheldTax = sumTaxesWithheld(item.ItemTaxWithheldList);
  const sellingFees = sumFees(
    fees,
    (t) => t === "Commission" || t === "FixedClosingFee" || t === "VariableClosingFee" || t === "RefundCommission"
  );
  const fbaFees = sumFees(fees, (t) => t.startsWith("FBA"));
  const otherTxFees = sumFees(fees, (t) => {
    if (
      t === "Commission" ||
      t === "FixedClosingFee" ||
      t === "VariableClosingFee" ||
      t === "RefundCommission"
    ) {
      return false;
    }
    if (t.startsWith("FBA")) return false;
    return true;
  });
  return {
    productSalesExvat,
    productSalesTax,
    shippingExvat,
    shippingTax,
    giftWrapExvat,
    giftWrapTax,
    promoRebates,
    withheldTax,
    sellingFees,
    fbaFees,
    otherTxFees,
  };
}

// ---------------------------------------------------------------------------
// Per-event-type mappers
// ---------------------------------------------------------------------------

function mapShipmentEvent(ev: ShipmentEvent, kind: "Order" | "Refund"): CsvRow[] {
  const orderId = decodeHtmlEntities(ev.AmazonOrderId);
  const marketplace = decodeHtmlEntities(ev.MarketplaceName);
  const posted = postedDateOnly(ev.PostedDate);
  const eventIdBase = `${kind}:${orderId}:${ev.PostedDate || ""}`;
  const out: CsvRow[] = [];

  // Combine shipped items + their adjustment list (Amazon sometimes splits
  // partial returns into ShipmentItemAdjustmentList on RefundEvents).
  const items: ShipmentItem[] = [
    ...(ev.ShipmentItemList || []),
    ...(ev.ShipmentItemAdjustmentList || []),
  ];

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const tally = tallyShipmentItem(item);
    const sku = decodeHtmlEntities(item.SellerSKU);
    const row = blankCsvRow();
    row[COL.date] = ev.PostedDate || "";
    row[COL.type] = kind;
    row[COL.orderId] = orderId;
    row[COL.sku] = sku;
    row[COL.quantity] = Number(item.QuantityShipped || 0);
    row[COL.marketplace] = marketplace;
    row[COL.productSales] = tally.productSalesExvat;
    row[COL.productSalesTax] = tally.productSalesTax;
    row[COL.shippingCredits] = tally.shippingExvat;
    row[COL.shippingCreditsTax] = tally.shippingTax;
    row[COL.giftWrapCredits] = tally.giftWrapExvat;
    row[COL.giftWrapCreditsTax] = tally.giftWrapTax;
    row[COL.promoRebates] = tally.promoRebates;
    row[COL.withheldTax] = tally.withheldTax;
    row[COL.sellingFees] = tally.sellingFees;
    row[COL.fbaFees] = tally.fbaFees;
    row[COL.otherTxFees] = tally.otherTxFees;
    row[COL.other] = 0;
    row[COL.total] = rowTotal(row);
    out.push({
      ...row,
      __amazon_event_id: `${eventIdBase}:item:${item.OrderItemId || i}`,
      __posted_date: posted,
      __sku: sku || null,
      __quantity: Number(item.QuantityShipped || 0) || null,
    });
  }

  // Order-level charges/fees not tied to a specific item (e.g. order-level
  // gift wrap). Bundle into one no-SKU row so totals balance.
  const orderCharges = [
    ...(ev.OrderChargeList || []),
    ...(ev.OrderChargeAdjustmentList || []),
  ];
  const orderFees = [
    ...(ev.OrderFeeList || []),
    ...(ev.OrderFeeAdjustmentList || []),
  ];
  if (orderCharges.length || orderFees.length) {
    const row = blankCsvRow();
    row[COL.date] = ev.PostedDate || "";
    row[COL.type] = kind;
    row[COL.orderId] = orderId;
    row[COL.marketplace] = marketplace;
    row[COL.productSales] = sumCharges(orderCharges, (t) => t === "Principal");
    row[COL.productSalesTax] = sumCharges(orderCharges, (t) => t === "Tax");
    row[COL.shippingCredits] = sumCharges(orderCharges, (t) => t === "Shipping" || t === "ShippingChargeback");
    row[COL.shippingCreditsTax] = sumCharges(orderCharges, (t) => t === "ShippingTax");
    row[COL.giftWrapCredits] = sumCharges(orderCharges, (t) => t === "GiftWrap");
    row[COL.giftWrapCreditsTax] = sumCharges(orderCharges, (t) => t === "GiftWrapTax");
    row[COL.sellingFees] = sumFees(orderFees, (t) => t === "Commission" || t === "FixedClosingFee" || t === "VariableClosingFee");
    row[COL.fbaFees] = sumFees(orderFees, (t) => t.startsWith("FBA"));
    row[COL.otherTxFees] = sumFees(orderFees, (t) => !["Commission", "FixedClosingFee", "VariableClosingFee"].includes(t) && !t.startsWith("FBA"));
    row[COL.total] = rowTotal(row);
    out.push({
      ...row,
      __amazon_event_id: `${eventIdBase}:order-level`,
      __posted_date: posted,
      __sku: null,
      __quantity: null,
    });
  }

  return out;
}

/**
 * ServiceFeeEvent → P&L row.
 *
 * The downstream engine recognises THREE distinct row types here:
 *   - type="FBA Inventory Fee"   → goes into fbaInventoryFeesGross
 *   - type="Service Fee" + desc not containing 'advertising' → subscription
 *   - type="Service Fee" + desc containing 'advertising' → ad spend (SKIPPED;
 *     PPC comes from the separate Ads report so we don't double-count)
 *
 * Amazon's FeeReason values are inconsistent across marketplaces — match by
 * substring rather than equality.
 */
function mapServiceFeeEvent(ev: ServiceFeeEvent): CsvRow | null {
  const reason = String(ev.FeeReason || "").toLowerCase();
  // Cost of Advertising comes from the separate Ads report.
  if (reason.includes("advertising") || reason.includes("ppc") || reason.includes("sponsored")) {
    return null;
  }

  const totalFees = (ev.FeeList || []).reduce((acc, f) => acc + amount(f.FeeAmount), 0);
  if (Math.abs(totalFees) < 0.001) return null;

  const sku = decodeHtmlEntities(ev.SellerSKU);
  const orderIdDecoded = decodeHtmlEntities(ev.AmazonOrderId);
  const description = decodeHtmlEntities(ev.FeeReason || ev.FeeDescription);

  // Decide which engine bucket this fee belongs to.
  let rowType: string = "Service Fee";
  if (
    reason.includes("fba inventory") ||
    reason.includes("fba storage") ||
    reason.includes("long term storage") ||
    reason.includes("monthly inventory") ||
    reason.includes("storage fee") ||
    reason.includes("aged inventory") ||
    reason.includes("removal fee") ||
    reason.includes("disposal fee")
  ) {
    rowType = "FBA Inventory Fee";
  }

  const row = blankCsvRow();
  row[COL.date] = ev.PostedDate || "";
  row[COL.type] = rowType;
  row[COL.orderId] = orderIdDecoded;
  row[COL.sku] = sku;
  row[COL.description] = description;
  // VAT-inclusive amount lands in "other" — engine splits at 20%.
  row[COL.other] = totalFees;
  row[COL.total] = rowTotal(row);

  return {
    ...row,
    __amazon_event_id: `ServiceFee:${ev.PostedDate || ""}:${ev.FeeReason || ""}:${sku}:${orderIdDecoded}:${totalFees.toFixed(4)}`,
    __posted_date: postedDateOnly(ev.PostedDate),
    __sku: sku || null,
    __quantity: null,
  };
}

/**
 * Classify an Amazon AdjustmentEvent.AdjustmentType into the engine's row
 * type vocabulary. This is critical because Amazon bundles three completely
 * different things into `AdjustmentEvent`:
 *
 *   1. FBA inventory reimbursements (REVERSAL_REIMBURSEMENT, WAREHOUSE_LOST,
 *      WAREHOUSE_DAMAGE, etc.) — credits coming back to the seller.
 *      → engine bucket: "adjustment" (fbaReimbursements)
 *
 *   2. Postage billing for SFP/FBM (PostageBilling_*, ReturnPostageBilling_*)
 *      — VAT-inclusive shipping label costs that the engine treats as a
 *      separate line and VAT-splits at 20%.
 *      → engine bucket: "delivery services"
 *
 *   3. Cash reserve movements (ReserveCredit / ReserveDebit) — informational
 *      ledger entries, no P&L impact (they net to zero over time).
 *      → SKIPPED
 *
 * Unknown adjustment types fall through to "adjustment" (the safer default —
 * better to surface an unrecognised amount than silently drop it).
 */
type AdjustmentRouting = "adjustment" | "delivery_services" | "skip";

function classifyAdjustmentType(type: string): AdjustmentRouting {
  const t = type.toLowerCase();
  if (t.startsWith("postagebilling") || t.startsWith("returnpostagebilling")) {
    return "delivery_services";
  }
  if (t === "reservecredit" || t === "reservedebit") {
    return "skip";
  }
  return "adjustment";
}

function mapAdjustmentEvent(ev: AdjustmentEvent): CsvRow[] {
  const items: AdjustmentItem[] = ev.AdjustmentItemList || [];
  const out: CsvRow[] = [];
  const adjType = decodeHtmlEntities(ev.AdjustmentType);
  const routing = classifyAdjustmentType(adjType);
  if (routing === "skip") return out;

  // Engine bucket name + how to describe the row for the per-SKU PDF.
  const rowType = routing === "delivery_services" ? "Delivery Services" : "Adjustment";
  const description = routing === "delivery_services"
    ? `Delivery Services (${adjType})`
    : `FBA Inventory Reimbursement - ${adjType}`;
  const eventIdBase = `Adjustment:${adjType}:${ev.PostedDate || ""}`;

  if (items.length === 0) {
    const summary = amount(ev.AdjustmentAmount);
    if (Math.abs(summary) < 0.001) return out;
    const row = blankCsvRow();
    row[COL.date] = ev.PostedDate || "";
    row[COL.type] = rowType;
    row[COL.description] = description;
    row[COL.other] = summary;
    row[COL.total] = rowTotal(row);
    out.push({
      ...row,
      __amazon_event_id: `${eventIdBase}:summary`,
      __posted_date: postedDateOnly(ev.PostedDate),
      __sku: null,
      __quantity: null,
    });
    return out;
  }

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const itemAmount = amount(item.TotalAmount);
    if (Math.abs(itemAmount) < 0.001) continue;
    const qty = Number(item.Quantity || 0);
    const sku = decodeHtmlEntities(item.SellerSKU);
    const row = blankCsvRow();
    row[COL.date] = ev.PostedDate || "";
    row[COL.type] = rowType;
    row[COL.sku] = sku;
    row[COL.description] = description || decodeHtmlEntities(item.ProductDescription);
    row[COL.quantity] = Number.isFinite(qty) && qty !== 0 ? qty : null;
    row[COL.other] = itemAmount;
    row[COL.total] = rowTotal(row);
    out.push({
      ...row,
      __amazon_event_id: `${eventIdBase}:item:${sku || i}:${itemAmount.toFixed(4)}`,
      __posted_date: postedDateOnly(ev.PostedDate),
      __sku: sku || null,
      __quantity: Number.isFinite(qty) && qty !== 0 ? qty : null,
    });
  }
  return out;
}

function mapRetrochargeEvent(ev: RetrochargeEvent): CsvRow | null {
  const isRefund = String(ev.RetrochargeEventType || "").toLowerCase().includes("reversal");
  const taxSum =
    amount(ev.BaseTax) +
    amount(ev.ShippingTax) +
    sumTaxesWithheld(ev.MarketplaceWithheldTaxList) +
    sumTaxesWithheld(ev.RetrochargeTaxWithheldList);
  if (Math.abs(taxSum) < 0.001) return null;

  const orderIdDecoded = decodeHtmlEntities(ev.AmazonOrderId);
  const row = blankCsvRow();
  row[COL.date] = ev.PostedDate || "";
  row[COL.type] = isRefund ? "Refund_Retrocharge" : "Order_Retrocharge";
  row[COL.orderId] = orderIdDecoded;
  row[COL.other] = taxSum;
  row[COL.total] = rowTotal(row);

  return {
    ...row,
    __amazon_event_id: `Retrocharge:${orderIdDecoded}:${ev.PostedDate || ""}:${isRefund ? "rev" : "fwd"}`,
    __posted_date: postedDateOnly(ev.PostedDate),
    __sku: null,
    __quantity: null,
  };
}

// ---------------------------------------------------------------------------
// Top-level: walk a FinancialEvents payload, return all CSV rows
// ---------------------------------------------------------------------------

export type MapStats = {
  shipment: number;
  refund: number;
  guaranteeClaim: number;
  chargeback: number;
  serviceFee: number;
  serviceFeeSkipped: number;
  adjustment: number;
  retrocharge: number;
  productAdsSkipped: number;
  unknownLists: string[];
};

export function mapFinancialEvents(events: FinancialEvents | undefined | null): {
  rows: CsvRow[];
  stats: MapStats;
} {
  const rows: CsvRow[] = [];
  const stats: MapStats = {
    shipment: 0,
    refund: 0,
    guaranteeClaim: 0,
    chargeback: 0,
    serviceFee: 0,
    serviceFeeSkipped: 0,
    adjustment: 0,
    retrocharge: 0,
    productAdsSkipped: 0,
    unknownLists: [],
  };
  if (!events) return { rows, stats };

  for (const ev of events.ShipmentEventList || []) {
    const out = mapShipmentEvent(ev, "Order");
    if (out.length) {
      stats.shipment += 1;
      rows.push(...out);
    }
  }
  for (const ev of events.RefundEventList || []) {
    const out = mapShipmentEvent(ev, "Refund");
    if (out.length) {
      stats.refund += 1;
      rows.push(...out);
    }
  }
  for (const ev of events.GuaranteeClaimEventList || []) {
    const out = mapShipmentEvent(ev, "Refund");
    if (out.length) {
      stats.guaranteeClaim += 1;
      rows.push(...out);
    }
  }
  for (const ev of events.ChargebackEventList || []) {
    const out = mapShipmentEvent(ev, "Refund");
    if (out.length) {
      stats.chargeback += 1;
      rows.push(...out);
    }
  }
  for (const ev of events.ServiceFeeEventList || []) {
    const row = mapServiceFeeEvent(ev);
    if (row) {
      stats.serviceFee += 1;
      rows.push(row);
    } else {
      stats.serviceFeeSkipped += 1;
    }
  }
  for (const ev of events.AdjustmentEventList || []) {
    const out = mapAdjustmentEvent(ev);
    if (out.length) {
      stats.adjustment += out.length;
      rows.push(...out);
    }
  }
  for (const ev of events.RetrochargeEventList || []) {
    const row = mapRetrochargeEvent(ev);
    if (row) {
      stats.retrocharge += 1;
      rows.push(row);
    }
  }
  if (events.ProductAdsPaymentEventList && events.ProductAdsPaymentEventList.length > 0) {
    stats.productAdsSkipped = events.ProductAdsPaymentEventList.length;
  }

  // Surface any event-list keys we don't explicitly handle, so we can extend
  // the mapper as more event types appear.
  const handled = new Set([
    "ShipmentEventList",
    "RefundEventList",
    "GuaranteeClaimEventList",
    "ChargebackEventList",
    "ServiceFeeEventList",
    "AdjustmentEventList",
    "RetrochargeEventList",
    "ProductAdsPaymentEventList",
  ]);
  for (const key of Object.keys(events)) {
    if (handled.has(key)) continue;
    const list = (events as Record<string, unknown>)[key];
    if (Array.isArray(list) && list.length > 0) {
      stats.unknownLists.push(`${key} (${list.length})`);
    }
  }

  return { rows, stats };
}
