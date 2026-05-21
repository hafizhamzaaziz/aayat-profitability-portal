/**
 * Temu Profit & Loss engine.
 *
 * Operates on parsed Temu transaction-export rows ("Reports → Transaction
 * report" XLSX) and produces:
 *   - Account-level totals reconciled to the cash actually paid out by Temu
 *   - Per-SKU lines (SkuLine, same shape used by the Amazon engine and the
 *     existing UI / persistence layer)
 *
 * Methodology (UK Temu, 20% standard-rate VAT):
 *   • Column semantics, verified against real reports:
 *       - Retail price, Platform discount, Seller discount, Platform incentive,
 *         Shipping  → ex-VAT
 *       - Service fee (tax incl.) → VAT-inclusive (header explicitly says so)
 *       - Product Tax, Shipping Tax, Platform incentive Tax → output VAT
 *         actually charged to the customer
 *       - Subtotal = Retail + Platform discount + Seller discount + Service fee
 *         + Platform incentive  (mixes ex-VAT items with VAT-incl service fee)
 *       - Total = Subtotal + Shipping + Product Tax + Platform incentive Tax
 *         + Shipping Tax + Others  (= cash credited to seller for that row)
 *
 *   • Order Payment + Refund rows give us:
 *       - ex-VAT revenue   = Retail + Platform discount + Seller discount
 *                            + Platform incentive + Shipping
 *       - output VAT       = Product Tax + Shipping Tax + Platform incentive Tax
 *       - service fee gross (VAT-inclusive) → ex-VAT cost = gross / 1.2,
 *         input VAT reclaim = gross × 0.2 / 1.2
 *
 *   • Ads, shipping-label rows, and their adjustments are VAT-inclusive UK
 *     supplies. Their `Total` (in the "Others" column) is split into ex-VAT
 *     cost + reclaimable input VAT. Penalties / abnormal-fulfilment / return
 *     shipping credits are NOT VATable — full amount flows through ex-VAT.
 *
 *   • Transfer rows are bank pay-outs. Excluded from P&L (informational only).
 *
 *   • Per-SKU back-attribution for shipping labels: Temu shipping-label rows
 *     carry the original Order ID. We back-attribute label costs to the SKUs
 *     of that order (split by qty when an order has multiple SKUs). Rows with
 *     no Order ID, plus all advertising spend, are allocated pro-rata by ex-VAT
 *     net sales.
 */

import type { CogsLookup, CogsVersion, SkuLine } from "./types";
import { VAT_RATE_DEFAULT } from "./types";

// Inlined to avoid a runtime value-import from "./amazon-pnl" (which breaks
// strict-ESM Node script execution; cross-file `import type` is fine but
// `costForSku` is a value).
function resolveCogsVersionLocal(
  cogsLookup: CogsLookup,
  sku: string,
  txDateIso: string
): CogsVersion | null {
  const key = sku.toLowerCase();
  const versions = cogsLookup.get(key);
  if (!versions || versions.length === 0) return null;
  let selected: CogsVersion | null = null;
  for (const version of versions) {
    if (version.effectiveFrom <= txDateIso) selected = version;
    else break;
  }
  return selected || versions[0] || null;
}
function costForSku(
  cogsLookup: CogsLookup,
  sku: string,
  txDateIso: string
): CogsVersion | null {
  const direct = resolveCogsVersionLocal(cogsLookup, sku, txDateIso);
  if (direct) return direct;
  if (sku.toLowerCase().startsWith("amzn.gr.")) {
    const rest = sku.slice("amzn.gr.".length);
    const parent = rest.split("-")[0];
    if (parent) return resolveCogsVersionLocal(cogsLookup, parent, txDateIso);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type RawRow = unknown[];
type PerSkuFloatMap = Record<string, number>;

function norm(value: unknown): string {
  return String(value ?? "")
    .replace(/\u00a0/g, " ")
    .replace(/\ufeff/g, "")
    .trim()
    .toLowerCase();
}

function normalizeSku(value: unknown): string {
  return String(value ?? "").replace(/\u00a0/g, " ").trim().toLowerCase();
}

function toFloat(value: unknown): number {
  if (value === null || value === undefined || value === "") return 0;
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  const cleaned = String(value).replace(/[,£$€\s]/g, "").trim();
  const parsed = Number.parseFloat(cleaned);
  return Number.isFinite(parsed) ? parsed : 0;
}

const round2 = (value: number): number => Math.round(value * 100) / 100;

function bumpSku(map: PerSkuFloatMap, sku: string, amount: number): void {
  if (!sku || !amount) return;
  map[sku] = (map[sku] || 0) + amount;
}

/**
 * Map of canonical field name → list of header substring groups (priority
 * ordered). The first header whose normalised text contains every substring
 * in any group wins.
 */
const FIELD_ALIASES: Record<string, string[][]> = {
  date: [["date/time"], ["date", "time"], ["date"]],
  type: [["transaction type"], ["type"]],
  related_id: [["related id"]],
  order_id: [["order id"]],
  order_item_id: [["order item id"]],
  sku_text: [["sku"]], // descriptive SKU column ("SKU"); resolved before sku_id so it doesn't steal "SKU ID"
  sku_id: [["sku id"]],
  quantity: [["quantity"]],
  retail: [["retail price"]],
  platform_discount: [["platform discount"]],
  seller_discount: [["seller discount"]],
  service_fee: [["service fee"]],
  platform_incentive_shipping: [["platform incentive", "shipping"]],
  platform_incentive: [["platform incentive"]],
  subtotal: [["subtotal"]],
  shipping: [["shipping"]],
  product_tax: [["product tax"]],
  platform_incentive_tax: [["platform incentive tax"]],
  shipping_tax: [["shipping tax"]],
  others: [["others"]],
  total: [["total"]],
  currency: [["currency"]],
};

type FieldIndex = Record<keyof typeof FIELD_ALIASES, number>;

function scoreHeaderRow(headerRow: unknown[]): number {
  const headers = headerRow.map((h) => norm(h));
  if (headers.every((h) => !h)) return 0;
  let score = 0;
  for (const field of Object.keys(FIELD_ALIASES)) {
    for (const group of FIELD_ALIASES[field]) {
      const hit = headers.some((h) => h && group.every((sub) => h.includes(sub)));
      if (hit) {
        score += 1;
        break;
      }
    }
  }
  return score;
}

function findHeaderRowIndex(rows: unknown[][]): number {
  const limit = Math.min(25, rows.length);
  let bestIdx = 0;
  let bestScore = -1;
  for (let i = 0; i < limit; i += 1) {
    const candidate = rows[i];
    if (!Array.isArray(candidate)) continue;
    const score = scoreHeaderRow(candidate);
    if (score > bestScore) {
      bestScore = score;
      bestIdx = i;
    }
  }
  // Need at least 4 confidently-matched fields to consider it the header.
  return bestScore >= 4 ? bestIdx : 0;
}

/**
 * Build a positional column map. Resolves "SKU ID" before "SKU" so the more
 * specific column doesn't get stolen by the bare "sku" substring match —
 * "platform_incentive_shipping" is similarly resolved before "platform
 * incentive" and "shipping".
 */
function buildFieldIndex(headerRow: unknown[]): FieldIndex {
  const headers = headerRow.map((h) => norm(h));
  const taken = new Set<number>();
  const idx: Record<string, number> = {};

  // Two passes: very-specific aliases first, generic last.
  const specific = [
    "platform_incentive_shipping",
    "platform_incentive_tax",
    "platform_incentive",
    "platform_discount",
    "seller_discount",
    "product_tax",
    "shipping_tax",
    "service_fee",
    "sku_id",
    "order_item_id",
    "related_id",
    "order_id",
    "subtotal",
    "shipping",
    "retail",
    "quantity",
    "type",
    "date",
    "others",
    "total",
    "currency",
  ];
  const generic = ["sku_text"]; // matched last so "SKU ID" / others don't get stolen

  const resolve = (field: string) => {
    for (const group of FIELD_ALIASES[field]) {
      for (let j = 0; j < headers.length; j += 1) {
        if (taken.has(j)) continue;
        const h = headers[j];
        if (!h) continue;
        if (group.every((sub) => h.includes(sub))) {
          idx[field] = j;
          taken.add(j);
          return;
        }
      }
    }
    if (!(field in idx)) idx[field] = -1;
  };

  for (const field of specific) resolve(field);
  for (const field of generic) resolve(field);

  return idx as unknown as FieldIndex;
}

function getCell(row: RawRow, idx: FieldIndex, field: keyof typeof FIELD_ALIASES): unknown {
  const j = idx[field];
  if (j < 0) return undefined;
  return row[j];
}
function getNum(row: RawRow, idx: FieldIndex, field: keyof typeof FIELD_ALIASES): number {
  return toFloat(getCell(row, idx, field));
}
function getStr(row: RawRow, idx: FieldIndex, field: keyof typeof FIELD_ALIASES): string {
  return String(getCell(row, idx, field) ?? "").trim();
}

/**
 * Choose which column contains the seller-managed SKU. Temu reports have BOTH
 * "SKU" (descriptive text — usually the listing title) and "SKU ID" (numeric
 * platform identifier). The seller's COGS table is keyed by their own seller
 * SKU; whichever the user mapped to in the COGS page is the right one. We try
 * "SKU" first (which often holds the seller SKU on older accounts) and fall
 * back to "SKU ID". Both values are recorded for diagnostics.
 */
function resolveSkuFromRow(row: RawRow, idx: FieldIndex): { sku: string; skuId: string; skuText: string } {
  const text = getStr(row, idx, "sku_text");
  const id = getStr(row, idx, "sku_id");
  // Prefer the textual SKU when it looks like a seller code (no spaces, all
  // alphanumeric / dashes / underscores). Otherwise fall back to SKU ID.
  if (text && /^[A-Za-z0-9_\-./]+$/.test(text)) return { sku: text.toLowerCase(), skuId: id, skuText: text };
  return { sku: (id || text).toLowerCase(), skuId: id, skuText: text };
}

// ---------------------------------------------------------------------------
// Type definitions
// ---------------------------------------------------------------------------

/** Aggregated raw figures from a Temu transaction file. Signs preserved. */
export type TemuPnL = {
  // ---------- Account-level (signed; refunds are negative) ----------
  // Order Payment + Refund rows
  orderRetail: number;          // Σ Retail price (ex-VAT, signed)
  orderPlatformDiscount: number; // Σ Platform discount (ex-VAT, signed; usually negative on Order, positive on Refund)
  orderSellerDiscount: number;  // Σ Seller discount (ex-VAT, signed)
  orderPlatformIncentive: number; // Σ Platform incentive (ex-VAT, signed; usually positive)
  orderShipping: number;        // Σ Shipping revenue (ex-VAT, signed)
  orderServiceFeeGross: number; // Σ Service fee (VAT-incl, signed; usually negative on Order, positive on Refund)
  orderProductTax: number;      // Σ Product Tax (output VAT, signed)
  orderShippingTax: number;     // Σ Shipping Tax (output VAT, signed)
  orderPlatformIncentiveTax: number; // Σ Platform incentive Tax (output VAT, signed)
  orderTotal: number;           // Σ Total (cash credited, VAT-incl, signed)

  refundRetail: number;
  refundPlatformDiscount: number;
  refundSellerDiscount: number;
  refundPlatformIncentive: number;
  refundShipping: number;
  refundServiceFeeGross: number;
  refundProductTax: number;
  refundShippingTax: number;
  refundPlatformIncentiveTax: number;
  refundTotal: number;

  // VAT-inclusive cost / income lines
  advertisingGross: number;          // Σ Advertising service fee Total (signed; usually negative)
  shippingLabelPurchaseGross: number; // outbound shipping labels
  shippingLabelAdjustmentGross: number; // outbound adjustments
  returnShippingPurchaseGross: number;  // shipping label for return purchase
  returnShippingAdjustmentGross: number; // adjustment thereof
  returnShippingPlatformGross: number;   // covered by platform (positive credit)
  returnShippingPlatformAdjGross: number; // platform-covered adjustment
  // Non-VATable
  abnormalFulfillmentGross: number;
  returnShippingCreditGross: number;
  chargebackGross: number;
  sellerRepaymentGross: number;
  otherUnknownGross: number;     // catch-all unrecognised types

  bankTransfers: number;         // Transfer rows; excluded from P&L

  // ---------- Per-SKU dicts ----------
  skuUnits: PerSkuFloatMap;            // Order qty − Refund qty (positive normal)
  skuRefundUnits: PerSkuFloatMap;      // Refund qty (positive)
  skuRetail: PerSkuFloatMap;
  skuPlatformDiscount: PerSkuFloatMap;
  skuSellerDiscount: PerSkuFloatMap;
  skuPlatformIncentive: PerSkuFloatMap;
  skuShipping: PerSkuFloatMap;
  skuServiceFeeGross: PerSkuFloatMap;
  skuProductTax: PerSkuFloatMap;
  skuShippingTax: PerSkuFloatMap;
  skuPlatformIncentiveTax: PerSkuFloatMap;
  /** Shipping-label costs back-attributed by Order ID. */
  skuShippingLabelGross: PerSkuFloatMap;

  skuDescriptions: Record<string, string>;
  /** Order_id → list of (sku, qty) for shipping-label back-attribution. */
  orderIdToSkus: Record<string, Array<{ sku: string; qty: number }>>;

  // ---------- Diagnostics ----------
  rowsProcessed: number;
  rowsSkipped: number;
  shippingLabelsUnmatched: number;
  shippingLabelsUnmatchedSpend: number;
  unknownTypeCount: number;
  unknownTypes: Record<string, number>; // type → count
};

/**
 * Override fed in by the Temu Ads-report flow. When present, the engine
 * ignores the transaction-sheet `advertisingGross` and uses the values
 * here instead.
 *
 *   - `totalExvat` is the sum from the ads report (positive ex-VAT cost,
 *     stored as a positive number; engine treats it as a cost = negative).
 *   - `spendBySku` is the post-allocation per-SKU spend (positive numbers).
 *   - `sourceFilename` etc. are echoed through for diagnostics.
 *
 * VAT: Temu invoices VAT on top of the report total, so reclaimable input
 * VAT = `totalExvat * vatRate`.
 */
export type TemuAdOverride = {
  totalExvat: number;
  spendBySku: Record<string, number>;
  /** Spend that couldn't be tied to a specific SKU and was redistributed. */
  unmatchedSpendExvat: number;
  /** Optional metadata, surfaced to the UI. */
  sourceFilename?: string;
  spendColumn?: string;
  goodsCount?: number;
};

/** Account-level derived figures, all rounded to 2dp. */
export type TemuDerivedTotals = {
  // Revenue (ex-VAT, signed; refunds netted)
  netSales: number;          // Order + Refund product+shipping ex-VAT
  cogs: number;              // negative
  grossProfit: number;

  // Ex-VAT costs (signed, negative)
  serviceFeesExvat: number;
  advertisingExvat: number;
  shippingLabelsExvat: number; // outbound + return + platform-covered (signed)
  penaltiesExvat: number;      // abnormal fulfilment + chargeback (signed)
  returnCreditsExvat: number;  // return shipping credit + seller repayment (income)
  totalTemuFeesExvat: number;  // sum of all the above (signed)
  operatingProfit: number;     // netSales + cogs + totalTemuFeesExvat

  // VAT
  outputVat: number;           // Product+Shipping+Plat-incentive Tax (signed)
  inputVatServiceFees: number;
  inputVatAdvertising: number;
  inputVatShippingLabels: number;
  inputVatCogs: number;
  totalInputVatTemuFees: number; // service + ads + shipping labels
  totalInputVatIncludingCogs: number;
  vatPayable: number;            // outputVat − totalInputVatIncludingCogs

  // Cash
  bankTransfers: number;
  settlementValue: number;       // total cash credited (Order+Refund+all P&L line totals)

  // Diagnostics
  matchedSkus: number;
  unmatchedSkus: number;
  matchedUnits: number;
  unmatchedUnits: number;
  matchedCogsPositive: number;
  rowsProcessed: number;
  rowsSkipped: number;
  shippingLabelsUnmatched: number;
  shippingLabelsUnmatchedSpend: number;
  unknownTypes: Record<string, number>;
  unknownTypeTotal: number;
};

// ---------------------------------------------------------------------------
// Pass 1: parse + aggregate
// ---------------------------------------------------------------------------

function emptyPnl(): TemuPnL {
  return {
    orderRetail: 0,
    orderPlatformDiscount: 0,
    orderSellerDiscount: 0,
    orderPlatformIncentive: 0,
    orderShipping: 0,
    orderServiceFeeGross: 0,
    orderProductTax: 0,
    orderShippingTax: 0,
    orderPlatformIncentiveTax: 0,
    orderTotal: 0,

    refundRetail: 0,
    refundPlatformDiscount: 0,
    refundSellerDiscount: 0,
    refundPlatformIncentive: 0,
    refundShipping: 0,
    refundServiceFeeGross: 0,
    refundProductTax: 0,
    refundShippingTax: 0,
    refundPlatformIncentiveTax: 0,
    refundTotal: 0,

    advertisingGross: 0,
    shippingLabelPurchaseGross: 0,
    shippingLabelAdjustmentGross: 0,
    returnShippingPurchaseGross: 0,
    returnShippingAdjustmentGross: 0,
    returnShippingPlatformGross: 0,
    returnShippingPlatformAdjGross: 0,
    abnormalFulfillmentGross: 0,
    returnShippingCreditGross: 0,
    chargebackGross: 0,
    sellerRepaymentGross: 0,
    otherUnknownGross: 0,

    bankTransfers: 0,

    skuUnits: {},
    skuRefundUnits: {},
    skuRetail: {},
    skuPlatformDiscount: {},
    skuSellerDiscount: {},
    skuPlatformIncentive: {},
    skuShipping: {},
    skuServiceFeeGross: {},
    skuProductTax: {},
    skuShippingTax: {},
    skuPlatformIncentiveTax: {},
    skuShippingLabelGross: {},

    skuDescriptions: {},
    orderIdToSkus: {},

    rowsProcessed: 0,
    rowsSkipped: 0,
    shippingLabelsUnmatched: 0,
    shippingLabelsUnmatchedSpend: 0,
    unknownTypeCount: 0,
    unknownTypes: {},
  };
}

type PendingShippingLabel = { kind: ShippingLabelKind; orderId: string; amount: number };

type ShippingLabelKind =
  | "outbound"
  | "outbound_adj"
  | "return_buyer"
  | "return_buyer_adj"
  | "return_platform"
  | "return_platform_adj";

function classifyType(typeRaw: string): { kind: TemuRowKind; shippingKind?: ShippingLabelKind } {
  const t = typeRaw;
  // Order line types — matched on full-string equality with tolerance for
  // case + whitespace. Substring `includes` is too greedy (e.g. "shipping"
  // would catch shipping label rows).
  if (t === "order payment" || t === "order") return { kind: "order_payment" };
  if (t === "refund") return { kind: "refund" };
  if (t === "advertising service fee") return { kind: "advertising" };
  if (t === "transfer" || t === "transfer of funds unsuccessful") return { kind: "transfer" };
  if (
    t === "abnormal fulfillment deduction" ||
    t === "abnormal fulfilment deduction" ||
    t === "out of stock deduction" ||
    t === "delayed fulfillment deduction" ||
    t === "delayed fulfilment deduction"
  ) {
    return { kind: "abnormal_fulfillment" };
  }
  if (t === "return shipping credit") return { kind: "return_shipping_credit" };
  if (t === "platform reimbursement") return { kind: "return_shipping_credit" };
  if (t === "chargeback" || t === "chargeback processing fee") return { kind: "chargeback" };
  // Seller repayment on Temu statements is a cash settlement movement tied to
  // label funding/adjustments, not operating-period revenue. Exclude from P&L.
  if (t === "seller repayment") return { kind: "transfer" };

  // Shipping-label family — most specific first.
  if (t === "shipping label for return purchase covered by platform") {
    return { kind: "shipping_label", shippingKind: "return_platform" };
  }
  if (t === "shipping label for return purchase adjustment covered by platform") {
    return { kind: "shipping_label", shippingKind: "return_platform_adj" };
  }
  if (t === "shipping label for return purchase adjustment") {
    return { kind: "shipping_label", shippingKind: "return_buyer_adj" };
  }
  if (t === "shipping label for return purchase") {
    return { kind: "shipping_label", shippingKind: "return_buyer" };
  }
  if (t === "shipping label purchase adjustment") {
    return { kind: "shipping_label", shippingKind: "outbound_adj" };
  }
  if (t === "shipping label purchase") return { kind: "shipping_label", shippingKind: "outbound" };

  return { kind: "unknown" };
}

type TemuRowKind =
  | "order_payment"
  | "refund"
  | "advertising"
  | "shipping_label"
  | "abnormal_fulfillment"
  | "return_shipping_credit"
  | "chargeback"
  | "seller_repayment"
  | "transfer"
  | "unknown";

/**
 * Parse a Temu transaction file (rows = 2D AoA where row[0] is the header).
 * Auto-detects the header row inside the first 25 rows so banner/metadata
 * rows are tolerated.
 */
export function computeTemuPnl(rows: RawRow[]): TemuPnL {
  const p = emptyPnl();
  if (!rows.length) return p;

  const headerIdx = findHeaderRowIndex(rows as unknown[][]);
  const headerRow = rows[headerIdx];
  const idx = buildFieldIndex(headerRow);
  const dataRows = rows.slice(headerIdx + 1);

  const pendingLabels: PendingShippingLabel[] = [];

  for (const row of dataRows) {
    if (!row) continue;

    const typeVal = norm(getCell(row, idx, "type"));
    if (!typeVal) {
      p.rowsSkipped += 1;
      continue;
    }

    p.rowsProcessed += 1;
    const total = getNum(row, idx, "total");
    const cls = classifyType(typeVal);

    if (cls.kind === "order_payment" || cls.kind === "refund") {
      const retail = getNum(row, idx, "retail");
      const pd = getNum(row, idx, "platform_discount");
      const sd = getNum(row, idx, "seller_discount");
      const pi = getNum(row, idx, "platform_incentive");
      const sf = getNum(row, idx, "service_fee");
      const ship = getNum(row, idx, "shipping");
      const pt = getNum(row, idx, "product_tax");
      const st = getNum(row, idx, "shipping_tax");
      const pit = getNum(row, idx, "platform_incentive_tax");

      const isRefund = cls.kind === "refund";
      if (isRefund) {
        p.refundRetail += retail;
        p.refundPlatformDiscount += pd;
        p.refundSellerDiscount += sd;
        p.refundPlatformIncentive += pi;
        p.refundShipping += ship;
        p.refundServiceFeeGross += sf;
        p.refundProductTax += pt;
        p.refundShippingTax += st;
        p.refundPlatformIncentiveTax += pit;
        p.refundTotal += total;
      } else {
        p.orderRetail += retail;
        p.orderPlatformDiscount += pd;
        p.orderSellerDiscount += sd;
        p.orderPlatformIncentive += pi;
        p.orderShipping += ship;
        p.orderServiceFeeGross += sf;
        p.orderProductTax += pt;
        p.orderShippingTax += st;
        p.orderPlatformIncentiveTax += pit;
        p.orderTotal += total;
      }

      const { sku, skuText } = resolveSkuFromRow(row, idx);
      const qty = Math.abs(getNum(row, idx, "quantity"));
      if (sku) {
        const orderId = getStr(row, idx, "order_id");
        if (orderId) {
          const list = p.orderIdToSkus[orderId] || [];
          list.push({ sku, qty });
          p.orderIdToSkus[orderId] = list;
        }
        const signedUnits = isRefund ? -qty : qty;
        bumpSku(p.skuUnits, sku, signedUnits);
        if (isRefund) bumpSku(p.skuRefundUnits, sku, qty);
        bumpSku(p.skuRetail, sku, retail);
        bumpSku(p.skuPlatformDiscount, sku, pd);
        bumpSku(p.skuSellerDiscount, sku, sd);
        bumpSku(p.skuPlatformIncentive, sku, pi);
        bumpSku(p.skuShipping, sku, ship);
        bumpSku(p.skuServiceFeeGross, sku, sf);
        bumpSku(p.skuProductTax, sku, pt);
        bumpSku(p.skuShippingTax, sku, st);
        bumpSku(p.skuPlatformIncentiveTax, sku, pit);
        if (skuText && !p.skuDescriptions[sku]) p.skuDescriptions[sku] = skuText;
      }
      continue;
    }

    if (cls.kind === "advertising") {
      p.advertisingGross += total;
      continue;
    }

    if (cls.kind === "shipping_label") {
      const orderId = getStr(row, idx, "order_id");
      switch (cls.shippingKind) {
        case "outbound":
          p.shippingLabelPurchaseGross += total;
          break;
        case "outbound_adj":
          p.shippingLabelAdjustmentGross += total;
          break;
        case "return_buyer":
          p.returnShippingPurchaseGross += total;
          break;
        case "return_buyer_adj":
          p.returnShippingAdjustmentGross += total;
          break;
        case "return_platform":
          p.returnShippingPlatformGross += total;
          break;
        case "return_platform_adj":
          p.returnShippingPlatformAdjGross += total;
          break;
      }
      // Defer per-SKU back-attribution until we've seen all order rows.
      if (orderId) {
        pendingLabels.push({ kind: cls.shippingKind!, orderId, amount: total });
      } else {
        p.shippingLabelsUnmatched += 1;
        p.shippingLabelsUnmatchedSpend += total;
      }
      continue;
    }

    if (cls.kind === "abnormal_fulfillment") {
      p.abnormalFulfillmentGross += total;
      continue;
    }
    if (cls.kind === "return_shipping_credit") {
      p.returnShippingCreditGross += total;
      continue;
    }
    if (cls.kind === "chargeback") {
      p.chargebackGross += total;
      continue;
    }
    if (cls.kind === "seller_repayment") {
      p.sellerRepaymentGross += total;
      continue;
    }
    if (cls.kind === "transfer") {
      p.bankTransfers += total;
      p.rowsProcessed -= 1; // transfers are not P&L; don't count toward processed
      continue;
    }

    // Unknown type — keep totals visible for diagnostics.
    p.otherUnknownGross += total;
    p.unknownTypeCount += 1;
    const key = String(getCell(row, idx, "type") ?? "").trim();
    p.unknownTypes[key] = (p.unknownTypes[key] || 0) + 1;
  }

  // Pass 2: back-attribute shipping-label rows to SKUs by Order ID.
  for (const pending of pendingLabels) {
    const skus = p.orderIdToSkus[pending.orderId];
    if (!skus || skus.length === 0) {
      p.shippingLabelsUnmatched += 1;
      p.shippingLabelsUnmatchedSpend += pending.amount;
      continue;
    }
    const totalQty = skus.reduce((acc, s) => acc + (s.qty || 0), 0);
    if (totalQty <= 0) {
      // Equal split when qty is missing.
      const share = pending.amount / skus.length;
      for (const s of skus) bumpSku(p.skuShippingLabelGross, s.sku, share);
      continue;
    }
    for (const s of skus) {
      bumpSku(p.skuShippingLabelGross, s.sku, pending.amount * (s.qty / totalQty));
    }
  }

  return p;
}

// ---------------------------------------------------------------------------
// Pass 3: derive ex-VAT totals + VAT
// ---------------------------------------------------------------------------

/**
 * Derive ex-VAT totals + VAT figures from a TemuPnL.
 *
 * `cogsVatReclaimPct` controls how aggressively we reclaim input VAT on
 * ex-VAT COGS lines (matches the Amazon engine semantics).
 */
export function deriveTemuTotals(input: {
  pnl: TemuPnL;
  cogsLookup: CogsLookup;
  vatRatePct: number;
  defaultDateIso: string;
  cogsVatReclaimPct?: number;
  /** When provided, replaces transaction-sheet ads with the upload total. */
  adOverride?: TemuAdOverride | null;
}): TemuDerivedTotals {
  const { pnl: p, cogsLookup, vatRatePct, defaultDateIso, adOverride } = input;
  const vatRate = vatRatePct / 100 || VAT_RATE_DEFAULT;
  const cogsVatReclaimFraction = Math.max(
    0,
    Math.min(1, (input.cogsVatReclaimPct ?? 100) / 100)
  );
  const vatFraction = vatRate / (1 + vatRate); // gross → VAT extraction

  // ---- ex-VAT revenue (Order Payment + Refund) ----
  const orderRevenueExvat =
    p.orderRetail +
    p.orderPlatformDiscount +
    p.orderSellerDiscount +
    p.orderPlatformIncentive +
    p.orderShipping;
  const refundRevenueExvat =
    p.refundRetail +
    p.refundPlatformDiscount +
    p.refundSellerDiscount +
    p.refundPlatformIncentive +
    p.refundShipping;
  const netSales = orderRevenueExvat + refundRevenueExvat;

  // ---- output VAT ----
  const outputVat =
    p.orderProductTax +
    p.orderShippingTax +
    p.orderPlatformIncentiveTax +
    p.refundProductTax +
    p.refundShippingTax +
    p.refundPlatformIncentiveTax;

  // ---- VAT-inclusive cost lines → ex-VAT + input VAT ----
  // A signed gross figure of -X (cost) yields ex-VAT cost -X/1.2 and
  // reclaimable input VAT +X×0.2/1.2. A positive credit yields the reverse.
  const split = (gross: number): { exvat: number; vat: number } => {
    const vat = gross * vatFraction;
    const exvat = gross - vat;
    return { exvat, vat: -vat }; // input-VAT side: negative-of-gross-vat
  };

  const serviceFeeGross = p.orderServiceFeeGross + p.refundServiceFeeGross;
  const serviceFeeSplit = split(serviceFeeGross);

  // Advertising: when an upload override is present, the report value is
  // ex-VAT and authoritative. Mirror split()'s sign convention so downstream
  // doesn't need a special case (exvat is negative for a cost; vat is the
  // positive reclaimable input-VAT amount).
  const advertisingSplit = adOverride
    ? {
        exvat: -Math.abs(adOverride.totalExvat),
        vat: Math.abs(adOverride.totalExvat) * vatRate,
      }
    : split(p.advertisingGross);

  const shippingLabelTotalGross =
    p.shippingLabelPurchaseGross +
    p.shippingLabelAdjustmentGross +
    p.returnShippingPurchaseGross +
    p.returnShippingAdjustmentGross +
    p.returnShippingPlatformGross +
    p.returnShippingPlatformAdjGross;
  const shippingLabelSplit = split(shippingLabelTotalGross);

  // Non-VATable
  const penaltiesGross = p.abnormalFulfillmentGross + p.chargebackGross;
  const returnCreditsGross =
    p.returnShippingCreditGross + p.sellerRepaymentGross + p.otherUnknownGross;

  // ---- COGS ----
  let cogsExVat = 0;
  let cogsVat = 0;
  let matchedSkus = 0;
  let unmatchedSkus = 0;
  let matchedUnits = 0;
  let unmatchedUnits = 0;
  let matchedCogsPositive = 0;

  const skuList = Array.from(
    new Set([
      ...Object.keys(p.skuUnits),
      ...Object.keys(p.skuRetail),
    ])
  );
  for (const sku of skuList) {
    const units = p.skuUnits[sku] || 0;
    if (units <= 0) continue;
    const cv = costForSku(cogsLookup, sku, defaultDateIso);
    if (!cv) {
      unmatchedSkus += 1;
      unmatchedUnits += units;
      continue;
    }
    matchedSkus += 1;
    matchedUnits += units;

    if (cv.includesVat && vatRate > 0) {
      const unitNet = cv.unitCost / (1 + vatRate);
      const unitVat = cv.unitCost - unitNet;
      cogsExVat += -unitNet * units;
      cogsVat += unitVat * units;
      matchedCogsPositive += unitNet * units;
    } else {
      cogsExVat += -cv.unitCost * units;
      matchedCogsPositive += cv.unitCost * units;
      if (vatRate > 0 && cogsVatReclaimFraction > 0) {
        cogsVat += cv.unitCost * units * cogsVatReclaimFraction * vatRate;
      }
    }
  }

  // ---- Roll-up ex-VAT costs ----
  const serviceFeesExvat = serviceFeeSplit.exvat; // signed
  const advertisingExvat = advertisingSplit.exvat;
  const shippingLabelsExvat = shippingLabelSplit.exvat;
  const penaltiesExvat = penaltiesGross;       // no VAT
  const returnCreditsExvat = returnCreditsGross; // no VAT

  const totalTemuFeesExvat =
    serviceFeesExvat +
    advertisingExvat +
    shippingLabelsExvat +
    penaltiesExvat +
    returnCreditsExvat;

  const grossProfit = netSales + cogsExVat;
  const operatingProfit = grossProfit + totalTemuFeesExvat;

  // ---- Input VAT roll-up ----
  // split() returns input-VAT with sign flipped already. For costs (negative
  // gross) this yields a positive reclaimable amount. For positive credits
  // it yields a negative figure that reduces our reclaim.
  const inputVatServiceFees = serviceFeeSplit.vat;
  const inputVatAdvertising = advertisingSplit.vat;
  const inputVatShippingLabels = shippingLabelSplit.vat;
  const totalInputVatTemuFees =
    inputVatServiceFees + inputVatAdvertising + inputVatShippingLabels;
  const totalInputVatIncludingCogs = totalInputVatTemuFees + cogsVat;
  const vatPayable = outputVat - totalInputVatIncludingCogs;

  // ---- Settlement value (cash credited to seller) ----
  // When an ads-report override is active, the override IS the authoritative
  // ad cost for the period — mirror Amazon's behaviour and use the override
  // gross here too so the summary lines reconcile to the settlement value.
  // (Without this swap the txn-sheet's gross flows into settlement while the
  // P&L uses the override, producing inconsistent numbers in the report.)
  const advertisingGrossEffective = adOverride
    ? -Math.abs(adOverride.totalExvat) * (1 + vatRate)
    : p.advertisingGross;
  const settlementValue =
    p.orderTotal +
    p.refundTotal +
    advertisingGrossEffective +
    p.shippingLabelPurchaseGross +
    p.shippingLabelAdjustmentGross +
    p.returnShippingPurchaseGross +
    p.returnShippingAdjustmentGross +
    p.returnShippingPlatformGross +
    p.returnShippingPlatformAdjGross +
    penaltiesGross +
    returnCreditsGross;

  return {
    netSales: round2(netSales),
    cogs: round2(cogsExVat),
    grossProfit: round2(grossProfit),

    serviceFeesExvat: round2(serviceFeesExvat),
    advertisingExvat: round2(advertisingExvat),
    shippingLabelsExvat: round2(shippingLabelsExvat),
    penaltiesExvat: round2(penaltiesExvat),
    returnCreditsExvat: round2(returnCreditsExvat),
    totalTemuFeesExvat: round2(totalTemuFeesExvat),
    operatingProfit: round2(operatingProfit),

    outputVat: round2(outputVat),
    inputVatServiceFees: round2(inputVatServiceFees),
    inputVatAdvertising: round2(inputVatAdvertising),
    inputVatShippingLabels: round2(inputVatShippingLabels),
    inputVatCogs: round2(cogsVat),
    totalInputVatTemuFees: round2(totalInputVatTemuFees),
    totalInputVatIncludingCogs: round2(totalInputVatIncludingCogs),
    vatPayable: round2(vatPayable),

    bankTransfers: round2(p.bankTransfers),
    settlementValue: round2(settlementValue),

    matchedSkus,
    unmatchedSkus,
    matchedUnits: round2(matchedUnits),
    unmatchedUnits: round2(unmatchedUnits),
    matchedCogsPositive: round2(matchedCogsPositive),
    rowsProcessed: p.rowsProcessed,
    rowsSkipped: p.rowsSkipped,
    shippingLabelsUnmatched: p.shippingLabelsUnmatched,
    shippingLabelsUnmatchedSpend: round2(p.shippingLabelsUnmatchedSpend),
    unknownTypes: p.unknownTypes,
    unknownTypeTotal: round2(p.otherUnknownGross),
  };
}

// ---------------------------------------------------------------------------
// Pass 4: per-SKU lines (same shape as Amazon SkuLine for UI re-use)
// ---------------------------------------------------------------------------

/**
 * Reuse the Amazon `SkuLine` shape so the existing per-SKU table, CSV export,
 * and persisted `report_sku_breakdowns` keep working. Fields that don't apply
 * to Temu (FBA Inventory Fee, Delivery Services, deal-fee allocations) are
 * left at 0; ad spend lands in `advertisingAlloc` and Temu's shipping-label
 * costs are folded into `deliveryServicesExvat`.
 */
export function computeTemuPerSku(input: {
  pnl: TemuPnL;
  cogsLookup: CogsLookup;
  vatRatePct: number;
  defaultDateIso: string;
  adOverride?: TemuAdOverride | null;
}): {
  lines: SkuLine[];
  diagnostics: {
    totalUnitsBasis: number;
    totalNetSalesBasis: number;
    adOnlySkus: string[];
  };
} {
  const { pnl: p, cogsLookup, vatRatePct, defaultDateIso, adOverride } = input;
  const vatRate = vatRatePct / 100 || VAT_RATE_DEFAULT;
  const vatFraction = vatRate / (1 + vatRate);

  // Universe of SKUs: any SKU we've seen in transactions.
  const skuSet = new Set<string>([
    ...Object.keys(p.skuUnits),
    ...Object.keys(p.skuRetail),
    ...Object.keys(p.skuShippingLabelGross),
  ]);

  // Pro-rata allocation basis = positive ex-VAT net sales per SKU (matches
  // the Amazon engine's positive-sales basis).
  const positiveSalesBySku: PerSkuFloatMap = {};
  let totalPositiveSales = 0;
  skuSet.forEach((sku) => {
    const productSalesNet =
      (p.skuRetail[sku] || 0) +
      (p.skuPlatformDiscount[sku] || 0) +
      (p.skuSellerDiscount[sku] || 0) +
      (p.skuPlatformIncentive[sku] || 0) +
      (p.skuShipping[sku] || 0);
    const positive = Math.max(0, productSalesNet);
    positiveSalesBySku[sku] = positive;
    totalPositiveSales += positive;
  });

  // Total units (positive only) — for ads-by-units fallback if no positive
  // sales basis (corner case: all returns).
  const totalPositiveUnits = Object.values(p.skuUnits).reduce(
    (acc, u) => acc + Math.max(0, u),
    0
  );

  // Account-level pots (signed) to allocate.
  // When an ads-report override is provided, the ads-report is ex-VAT and
  // authoritative — `advertisingAlloc` is sourced from `override.spendBySku`
  // directly, so the txn-sheet pot is unused.
  const advertisingTotalGross = p.advertisingGross; // negative
  const advertisingTotalExvat = adOverride
    ? -Math.abs(adOverride.totalExvat)
    : advertisingTotalGross - advertisingTotalGross * vatFraction; // negative

  // Penalties + non-VATable lines we treat as account-level allocations too.
  const penaltiesTotal = p.abnormalFulfillmentGross + p.chargebackGross;
  const returnCreditsTotal =
    p.returnShippingCreditGross + p.sellerRepaymentGross;

  // Unmatched shipping labels (no Order ID linkage) — pro-rata by sales.
  const unmatchedShippingLabelsGross = p.shippingLabelsUnmatchedSpend;
  const unmatchedShippingLabelsExvat =
    unmatchedShippingLabelsGross - unmatchedShippingLabelsGross * vatFraction;

  const adOnlySkus: string[] = [];
  const lines: SkuLine[] = [];

  skuSet.forEach((sku) => {
    const units = p.skuUnits[sku] || 0;
    const refundUnits = p.skuRefundUnits[sku] || 0;
    const retail = p.skuRetail[sku] || 0;
    const pd = p.skuPlatformDiscount[sku] || 0;
    const sd = p.skuSellerDiscount[sku] || 0;
    const pi = p.skuPlatformIncentive[sku] || 0;
    const ship = p.skuShipping[sku] || 0;
    const sfGross = p.skuServiceFeeGross[sku] || 0;
    const productTax = p.skuProductTax[sku] || 0;
    const shipTax = p.skuShippingTax[sku] || 0;
    const piTax = p.skuPlatformIncentiveTax[sku] || 0;
    const labelGross = p.skuShippingLabelGross[sku] || 0;

    const productSalesNet = retail + pd + sd + pi;
    const netSales = productSalesNet + ship; // ex-VAT

    // COGS
    const cv = costForSku(cogsLookup, sku, defaultDateIso);
    let cogs = 0;
    let costKnown = false;
    if (cv && units > 0) {
      costKnown = true;
      const unitNet = cv.includesVat && vatRate > 0 ? cv.unitCost / (1 + vatRate) : cv.unitCost;
      cogs = -unitNet * units; // negative
    }

    // Service fee → ex-VAT
    const sfExvat = sfGross - sfGross * vatFraction; // signed (cost negative)

    // Shipping labels (back-attributed via Order ID) → ex-VAT
    const labelExvat = labelGross - labelGross * vatFraction;

    // Pro-rata pots:
    const sharePositive = totalPositiveSales > 0 ? positiveSalesBySku[sku] / totalPositiveSales : 0;
    const shareUnits = totalPositiveUnits > 0 ? Math.max(0, units) / totalPositiveUnits : 0;
    const shareFallback = totalPositiveSales > 0 ? sharePositive : shareUnits;

    // Ads: prefer the ads-report's bucketed per-SKU value (negative cost);
    // fall back to pro-rata allocation of the txn-sheet ads pot.
    const advertisingAlloc = adOverride
      ? -((adOverride.spendBySku[sku] || 0))
      : advertisingTotalExvat * shareFallback;
    const unmatchedShipAlloc = unmatchedShippingLabelsExvat * shareFallback;
    const penaltiesAlloc = penaltiesTotal * shareFallback;
    const returnCreditAlloc = returnCreditsTotal * shareFallback;

    // Ad-only SKU = no sales but allocated ad spend (only happens when
    // totalPositiveSales == 0 and we fall back to units, which won't trigger
    // either; this branch is mostly defensive).
    if (Math.abs(productSalesNet) < 0.005 && units <= 0 && Math.abs(advertisingAlloc) > 0.005) {
      adOnlySkus.push(sku);
    }

    // Combined "delivery services" bucket for the per-SKU table re-use:
    // back-attributed shipping label costs + the SKU's share of unmatched
    // shipping labels (ex-VAT, signed).
    const deliveryServicesExvat = labelExvat + unmatchedShipAlloc;

    const totalAmazonFeesExvat =
      sfExvat + deliveryServicesExvat + advertisingAlloc + penaltiesAlloc + returnCreditAlloc;

    const grossProfit = netSales + cogs;
    const grossMargin = netSales !== 0 ? grossProfit / netSales : 0;
    const netProfit = grossProfit + totalAmazonFeesExvat;
    const netMargin = netSales !== 0 ? netProfit / netSales : 0;

    lines.push({
      sku,
      description: p.skuDescriptions[sku] || "",
      units,
      refundUnits,

      netSales: round2(netSales),
      productSales: round2(retail + pd + sd + pi),
      postageCredits: round2(ship),
      promoRebates: 0,

      cogs: round2(cogs),
      sellingFeesExvat: round2(sfExvat),
      fbaFeesExvat: 0,
      otherTxFeesExvat: 0,
      deliveryServicesExvat: round2(deliveryServicesExvat),

      advertisingAlloc: round2(advertisingAlloc),
      fbaInventoryAlloc: 0,
      subscriptionAlloc: 0,
      // Re-use dealFeesAlloc as the catch-all for penalties + return credits
      // (signed) so they show up in the per-SKU table without a schema change.
      dealFeesAlloc: round2(penaltiesAlloc + returnCreditAlloc),

      fbaReimbursements: 0,

      outputVatProduct: round2(productTax),
      outputVatShipping: round2(shipTax),
      outputVatGiftwrap: 0,
      outputVatPromo: round2(piTax),
      marketplaceWithheldVat: 0,
      retrochargeVat: 0,

      grossProfit: round2(grossProfit),
      grossMargin: round2(grossMargin),
      totalAmazonFeesExvat: round2(totalAmazonFeesExvat),
      netProfit: round2(netProfit),
      netMargin: round2(netMargin),

      costKnown,
      adOnly: Math.abs(productSalesNet) < 0.005 && units <= 0,
    });
  });

  return {
    lines,
    diagnostics: {
      totalUnitsBasis: round2(totalPositiveUnits),
      totalNetSalesBasis: round2(totalPositiveSales),
      adOnlySkus,
    },
  };
}

/**
 * Convenience helper exported for the verification script. Given parsed
 * 2D-AoA rows, returns everything you need to reconcile against raw
 * column sums.
 */
export function runTemu(rows: RawRow[], opts: {
  cogsLookup?: CogsLookup;
  vatRatePct?: number;
  defaultDateIso?: string;
  cogsVatReclaimPct?: number;
  adOverride?: TemuAdOverride | null;
}) {
  const pnl = computeTemuPnl(rows);
  const totals = deriveTemuTotals({
    pnl,
    cogsLookup: opts.cogsLookup ?? new Map(),
    vatRatePct: opts.vatRatePct ?? 20,
    defaultDateIso: opts.defaultDateIso ?? new Date().toISOString().slice(0, 10),
    cogsVatReclaimPct: opts.cogsVatReclaimPct,
    adOverride: opts.adOverride ?? null,
  });
  const { lines, diagnostics } = computeTemuPerSku({
    pnl,
    cogsLookup: opts.cogsLookup ?? new Map(),
    vatRatePct: opts.vatRatePct ?? 20,
    defaultDateIso: opts.defaultDateIso ?? new Date().toISOString().slice(0, 10),
    adOverride: opts.adOverride ?? null,
  });
  return { pnl, totals, lines, diagnostics };
}

// Helpers for downstream callers.
export { normalizeSku as normalizeTemuSku };
