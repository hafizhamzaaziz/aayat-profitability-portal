/**
 * TikTok Shop Profit & Loss engine.
 *
 * Operates on the parsed rows of a TikTok "All orders" export (the
 * `OrderSKUList` sheet). The export is order-line granular: a multi-SKU order
 * produces one row per SKU, and several columns are repeated at the ORDER
 * level (notably "Order Amount", col V) while others are per-line ("Seller
 * SKU", "Quantity", "Order Refund Amount", etc.). The engine therefore groups
 * rows by Order ID before doing any money maths.
 *
 * Methodology (agreed with the business, UK 20% standard-rate VAT):
 *   • Drop orders whose "Order Status" (col B) is Canceled. Keep everything
 *     else (Shipped, Completed, …).
 *   • Revenue: "Order Amount" (col V, incl VAT) is the order-level total the
 *     buyer paid. It is counted ONCE per order (not per SKU line).
 *   • Refunds: "Order Refund Amount" (col W, incl VAT) is per SKU line; the
 *     order's refund is the sum of its lines. Net revenue = Order Amount −
 *     refunds.
 *   • TikTok commission (incl VAT) = 12% × Order Amount (gross) + £0.50, once
 *     per order.
 *   • COGS: per net unit (Quantity − Returns) at the seller-SKU's unit cost,
 *     resolved through the bridged COGS lookup (TikTok Seller SKU ↔ Amazon
 *     SKU ↔ Temu SKU ID).
 *   • VAT (full treatment): output VAT is extracted from net revenue at
 *     rate/(1+rate). Input VAT is reclaimed on the commission and on COGS.
 *   • Per-SKU split: order-level Order Amount and commission are allocated to
 *     SKU lines by each line's "SKU Subtotal After Discount" (col P) share
 *     (falling back to unit count when the order's subtotals are all zero).
 *
 * External expenses (affiliate, ads, shipping) are NOT in this sheet — they
 * are entered manually on the Expenses page (marketplace = "tiktok") and
 * subtracted at the account level by the workbench, exactly like Temu.
 */

import type { CogsLookup, CogsVersion, SkuLine } from "./types";
import { VAT_RATE_DEFAULT } from "./types";

// ---------------------------------------------------------------------------
// COGS resolution (inlined to avoid a runtime value-import from amazon-pnl)
// ---------------------------------------------------------------------------

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
  return resolveCogsVersionLocal(cogsLookup, sku, txDateIso);
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

/** Parse a money cell such as "GBP 21.41", "£21.41", "21.41" or a number. */
function toFloat(value: unknown): number {
  if (value === null || value === undefined || value === "") return 0;
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  const cleaned = String(value).replace(/[^0-9.\-]/g, "").trim();
  const parsed = Number.parseFloat(cleaned);
  return Number.isFinite(parsed) ? parsed : 0;
}

function normalizeSku(value: unknown): string {
  return String(value ?? "").replace(/\u00a0/g, " ").trim().toLowerCase();
}

const round2 = (value: number): number => Math.round(value * 100) / 100;

function bumpSku(map: PerSkuFloatMap, sku: string, amount: number): void {
  if (!sku || !amount) return;
  map[sku] = (map[sku] || 0) + amount;
}

// ---------------------------------------------------------------------------
// Header / column resolution
// ---------------------------------------------------------------------------

const FIELD_ALIASES: Record<string, string[][]> = {
  order_id: [["order id"]],
  order_status: [["order status"]],
  seller_sku: [["seller sku"]],
  sku_id: [["sku id"]],
  product_name: [["product name"]],
  variation: [["variation"]],
  quantity: [["quantity"]],
  returns: [["quantity of return"], ["return"]],
  subtotal_after_discount: [["subtotal after discount"]],
  order_amount: [["order amount"]],
  order_refund_amount: [["refund amount"]],
  created_time: [["created time"]],
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

/** Find the header row inside the first few rows (banner/metadata tolerant). */
function findHeaderRowIndex(rows: unknown[][]): number {
  const limit = Math.min(15, rows.length);
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
  return bestScore >= 4 ? bestIdx : 0;
}

/**
 * Build a positional column map. Resolves very-specific aliases before generic
 * ones so e.g. "Sku Quantity of return" doesn't get stolen by "Quantity", and
 * "Order Refund Amount" doesn't steal "Order Amount".
 */
function buildFieldIndex(headerRow: unknown[]): FieldIndex {
  const headers = headerRow.map((h) => norm(h));
  const taken = new Set<number>();
  const idx: Record<string, number> = {};

  const order = [
    "order_id",
    "order_status",
    "seller_sku",
    "sku_id",
    "product_name",
    "variation",
    "returns", // before "quantity"
    "quantity",
    "subtotal_after_discount",
    "order_refund_amount", // before "order_amount"
    "order_amount",
    "created_time",
  ];

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

  for (const field of order) resolve(field);
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

/** TikTok order IDs are long numeric strings. The description sub-header row
 *  (where Order ID = "Platform unique order ID.") is rejected by this test,
 *  so the engine tolerates the export's two-row header automatically. */
function isOrderRow(orderId: string): boolean {
  return /^\d{6,}$/.test(orderId.trim());
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const TIKTOK_COMMISSION_RATE = 0.12;
export const TIKTOK_FIXED_FEE_PER_ORDER = 0.5;

// ---------------------------------------------------------------------------
// Pass 1: parse + group by order
// ---------------------------------------------------------------------------

type TiktokLine = {
  /** Seller SKU (col G), lowercased. Empty when the seller never set one. */
  sku: string;
  /** TikTok internal "SKU ID" (col F). Used as the fallback line key. */
  skuId: string;
  description: string;
  qty: number;
  returns: number;
  refundInclVat: number;
  subtotalAfterDiscount: number;
};

/**
 * Line key used for COGS lookup and per-SKU grouping. Prefer the Seller SKU
 * (what the COGS mappings bridge on). When TikTok exported the line without a
 * Seller SKU, fall back to the internal numeric SKU ID so the line still shows
 * up (as an unmatched, no-cost line) and revenue reconciles to account totals.
 */
function lineKey(line: TiktokLine): string {
  if (line.sku) return line.sku;
  if (line.skuId) return `skuid:${line.skuId.toLowerCase()}`;
  return "";
}

type TiktokOrder = {
  orderId: string;
  status: string;
  orderAmountInclVat: number; // order-level (col V), taken once
  createdTime: string;
  lines: TiktokLine[];
};

export type TiktokPnL = {
  orders: TiktokOrder[];
  /** Orders kept after dropping Canceled. */
  keptOrderCount: number;
  cancelledOrderCount: number;
  rowsProcessed: number;
  rowsSkipped: number;
  statusCounts: Record<string, number>;
};

/** Parse TikTok export rows (2D AoA; auto-detects the header row). */
export function computeTiktokPnl(rows: RawRow[]): TiktokPnL {
  const empty: TiktokPnL = {
    orders: [],
    keptOrderCount: 0,
    cancelledOrderCount: 0,
    rowsProcessed: 0,
    rowsSkipped: 0,
    statusCounts: {},
  };
  if (!rows.length) return empty;

  const headerIdx = findHeaderRowIndex(rows as unknown[][]);
  const headerRow = rows[headerIdx];
  const idx = buildFieldIndex(headerRow);
  const dataRows = rows.slice(headerIdx + 1);

  const orderMap = new Map<string, TiktokOrder>();
  let rowsProcessed = 0;
  let rowsSkipped = 0;

  for (const row of dataRows) {
    if (!row) {
      rowsSkipped += 1;
      continue;
    }
    const orderId = getStr(row, idx, "order_id");
    if (!isOrderRow(orderId)) {
      rowsSkipped += 1;
      continue;
    }
    rowsProcessed += 1;

    const status = norm(getCell(row, idx, "order_status"));
    const productName = getStr(row, idx, "product_name");
    const variation = getStr(row, idx, "variation");
    const line: TiktokLine = {
      sku: normalizeSku(getCell(row, idx, "seller_sku")),
      skuId: getStr(row, idx, "sku_id"),
      description: variation ? `${productName} – ${variation}`.trim() : productName,
      qty: Math.abs(getNum(row, idx, "quantity")),
      returns: Math.abs(getNum(row, idx, "returns")),
      refundInclVat: getNum(row, idx, "order_refund_amount"),
      subtotalAfterDiscount: getNum(row, idx, "subtotal_after_discount"),
    };

    const existing = orderMap.get(orderId);
    if (existing) {
      existing.lines.push(line);
      // Order Amount repeats across lines; keep the max (defensive against
      // blanks on continuation lines).
      const amt = getNum(row, idx, "order_amount");
      if (amt > existing.orderAmountInclVat) existing.orderAmountInclVat = amt;
      if (!existing.status && status) existing.status = status;
    } else {
      orderMap.set(orderId, {
        orderId,
        status,
        orderAmountInclVat: getNum(row, idx, "order_amount"),
        createdTime: getStr(row, idx, "created_time"),
        lines: [line],
      });
    }
  }

  const orders: TiktokOrder[] = [];
  const statusCounts: Record<string, number> = {};
  let kept = 0;
  let cancelled = 0;
  orderMap.forEach((order) => {
    statusCounts[order.status || "(blank)"] = (statusCounts[order.status || "(blank)"] || 0) + 1;
    if (isCancelled(order.status)) {
      cancelled += 1;
      return;
    }
    kept += 1;
    orders.push(order);
  });

  return {
    orders,
    keptOrderCount: kept,
    cancelledOrderCount: cancelled,
    rowsProcessed,
    rowsSkipped,
    statusCounts,
  };
}

function isCancelled(status: string): boolean {
  const s = norm(status);
  return s === "canceled" || s === "cancelled";
}

// ---------------------------------------------------------------------------
// Pass 2: derive account-level totals
// ---------------------------------------------------------------------------

export type TiktokDerivedTotals = {
  // Revenue (ex-VAT)
  grossOrderAmountInclVat: number;
  refundsInclVat: number;
  netRevenueInclVat: number;
  netSales: number; // ex-VAT
  cogs: number; // negative, ex-VAT
  grossProfit: number; // netSales + cogs

  commissionInclVat: number; // positive total
  commissionExvat: number; // negative (cost)
  totalTiktokFeesExvat: number; // = commissionExvat (signed)
  operatingProfit: number; // grossProfit + commissionExvat

  // VAT
  outputVat: number;
  inputVatCommission: number;
  inputVatCogs: number;
  totalInputVatTiktokFees: number; // = inputVatCommission
  totalInputVatIncludingCogs: number;
  vatPayable: number;

  // Cash
  settlementValue: number; // net revenue incl VAT − commission incl VAT

  // Diagnostics
  matchedSkus: number;
  unmatchedSkus: number;
  matchedUnits: number;
  unmatchedUnits: number;
  keptOrderCount: number;
  cancelledOrderCount: number;
  rowsProcessed: number;
  rowsSkipped: number;
};

export function deriveTiktokTotals(input: {
  pnl: TiktokPnL;
  cogsLookup: CogsLookup;
  vatRatePct: number;
  defaultDateIso: string;
}): TiktokDerivedTotals {
  const { pnl, cogsLookup, vatRatePct, defaultDateIso } = input;
  const vatRate = vatRatePct / 100 || VAT_RATE_DEFAULT;
  const vatFraction = vatRate / (1 + vatRate);

  let grossOrderAmountInclVat = 0;
  let refundsInclVat = 0;
  let commissionInclVat = 0;
  const skuNetUnits: PerSkuFloatMap = {};

  for (const order of pnl.orders) {
    grossOrderAmountInclVat += order.orderAmountInclVat;
    const orderRefund = order.lines.reduce((acc, l) => acc + l.refundInclVat, 0);
    refundsInclVat += orderRefund;
    commissionInclVat += TIKTOK_COMMISSION_RATE * order.orderAmountInclVat + TIKTOK_FIXED_FEE_PER_ORDER;
    for (const line of order.lines) {
      const net = line.qty - line.returns;
      bumpSku(skuNetUnits, lineKey(line), net);
    }
  }

  const netRevenueInclVat = grossOrderAmountInclVat - refundsInclVat;
  const netSales = netRevenueInclVat / (1 + vatRate);
  const outputVat = netRevenueInclVat * vatFraction;

  const commissionExvatPos = commissionInclVat / (1 + vatRate);
  const commissionExvat = -commissionExvatPos;
  const inputVatCommission = commissionInclVat * vatFraction;

  // COGS
  let cogsExVat = 0;
  let cogsVat = 0;
  let matchedSkus = 0;
  let unmatchedSkus = 0;
  let matchedUnits = 0;
  let unmatchedUnits = 0;

  for (const [sku, units] of Object.entries(skuNetUnits)) {
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
    } else {
      cogsExVat += -cv.unitCost * units;
      // COGS stored ex-VAT: no automatic input-VAT reclaim (matches the
      // conservative default; purchases input VAT is captured where the cost
      // already includes VAT).
    }
  }

  const grossProfit = netSales + cogsExVat;
  const totalTiktokFeesExvat = commissionExvat;
  const operatingProfit = grossProfit + totalTiktokFeesExvat;

  const totalInputVatTiktokFees = inputVatCommission;
  const totalInputVatIncludingCogs = totalInputVatTiktokFees + cogsVat;
  const vatPayable = outputVat - totalInputVatIncludingCogs;

  const settlementValue = netRevenueInclVat - commissionInclVat;

  return {
    grossOrderAmountInclVat: round2(grossOrderAmountInclVat),
    refundsInclVat: round2(refundsInclVat),
    netRevenueInclVat: round2(netRevenueInclVat),
    netSales: round2(netSales),
    cogs: round2(cogsExVat),
    grossProfit: round2(grossProfit),

    commissionInclVat: round2(commissionInclVat),
    commissionExvat: round2(commissionExvat),
    totalTiktokFeesExvat: round2(totalTiktokFeesExvat),
    operatingProfit: round2(operatingProfit),

    outputVat: round2(outputVat),
    inputVatCommission: round2(inputVatCommission),
    inputVatCogs: round2(cogsVat),
    totalInputVatTiktokFees: round2(totalInputVatTiktokFees),
    totalInputVatIncludingCogs: round2(totalInputVatIncludingCogs),
    vatPayable: round2(vatPayable),

    settlementValue: round2(settlementValue),

    matchedSkus,
    unmatchedSkus,
    matchedUnits: round2(matchedUnits),
    unmatchedUnits: round2(unmatchedUnits),
    keptOrderCount: pnl.keptOrderCount,
    cancelledOrderCount: pnl.cancelledOrderCount,
    rowsProcessed: pnl.rowsProcessed,
    rowsSkipped: pnl.rowsSkipped,
  };
}

// ---------------------------------------------------------------------------
// Pass 3: per-SKU lines (reuse Amazon SkuLine shape for UI re-use)
// ---------------------------------------------------------------------------

export function computeTiktokPerSku(input: {
  pnl: TiktokPnL;
  cogsLookup: CogsLookup;
  vatRatePct: number;
  defaultDateIso: string;
}): { lines: SkuLine[] } {
  const { pnl, cogsLookup, vatRatePct, defaultDateIso } = input;
  const vatRate = vatRatePct / 100 || VAT_RATE_DEFAULT;
  const vatFraction = vatRate / (1 + vatRate);

  // Per-SKU accumulators (incl VAT where noted).
  const skuOrderAmountInclVat: PerSkuFloatMap = {}; // allocated gross revenue
  const skuRefundInclVat: PerSkuFloatMap = {}; // direct per-line refund
  const skuCommissionInclVat: PerSkuFloatMap = {}; // allocated commission
  const skuNetUnits: PerSkuFloatMap = {};
  const skuReturnUnits: PerSkuFloatMap = {};
  const skuDescriptions: Record<string, string> = {};

  for (const order of pnl.orders) {
    const commissionOrderInclVat =
      TIKTOK_COMMISSION_RATE * order.orderAmountInclVat + TIKTOK_FIXED_FEE_PER_ORDER;

    const subtotalSum = order.lines.reduce((acc, l) => acc + Math.max(0, l.subtotalAfterDiscount), 0);
    const qtySum = order.lines.reduce((acc, l) => acc + Math.max(0, l.qty), 0);

    for (const line of order.lines) {
      const sku = lineKey(line);
      if (!sku) continue;
      // Allocation share within the order.
      let share: number;
      if (subtotalSum > 0) share = Math.max(0, line.subtotalAfterDiscount) / subtotalSum;
      else if (qtySum > 0) share = Math.max(0, line.qty) / qtySum;
      else share = 1 / order.lines.length;

      bumpSku(skuOrderAmountInclVat, sku, order.orderAmountInclVat * share);
      bumpSku(skuCommissionInclVat, sku, commissionOrderInclVat * share);
      bumpSku(skuRefundInclVat, sku, line.refundInclVat);
      bumpSku(skuNetUnits, sku, line.qty - line.returns);
      bumpSku(skuReturnUnits, sku, line.returns);
      if (line.description && !skuDescriptions[sku]) skuDescriptions[sku] = line.description;
    }
  }

  const skuSet = new Set<string>([
    ...Object.keys(skuOrderAmountInclVat),
    ...Object.keys(skuNetUnits),
  ]);

  const lines: SkuLine[] = [];
  skuSet.forEach((sku) => {
    const units = skuNetUnits[sku] || 0;
    const refundUnits = skuReturnUnits[sku] || 0;

    const netRevenueInclVat = (skuOrderAmountInclVat[sku] || 0) - (skuRefundInclVat[sku] || 0);
    const netSales = netRevenueInclVat / (1 + vatRate); // ex-VAT
    const outputVat = netRevenueInclVat * vatFraction;

    const commissionInclVat = skuCommissionInclVat[sku] || 0;
    const commissionExvat = -(commissionInclVat / (1 + vatRate)); // negative cost

    // COGS
    const cv = costForSku(cogsLookup, sku, defaultDateIso);
    let cogs = 0;
    let costKnown = false;
    if (cv && units > 0) {
      costKnown = true;
      const unitNet = cv.includesVat && vatRate > 0 ? cv.unitCost / (1 + vatRate) : cv.unitCost;
      cogs = -unitNet * units;
    }

    const grossProfit = netSales + cogs;
    const grossMargin = netSales !== 0 ? grossProfit / netSales : 0;
    const totalAmazonFeesExvat = commissionExvat; // only the TikTok commission
    const netProfit = grossProfit + totalAmazonFeesExvat;
    const netMargin = netSales !== 0 ? netProfit / netSales : 0;

    lines.push({
      sku,
      description: skuDescriptions[sku] || "",
      units,
      refundUnits,

      netSales: round2(netSales),
      productSales: round2(netSales),
      postageCredits: 0,
      promoRebates: 0,

      cogs: round2(cogs),
      sellingFeesExvat: round2(commissionExvat),
      fbaFeesExvat: 0,
      otherTxFeesExvat: 0,
      deliveryServicesExvat: 0,

      advertisingAlloc: 0,
      fbaInventoryAlloc: 0,
      subscriptionAlloc: 0,
      dealFeesAlloc: 0,

      fbaReimbursements: 0,

      outputVatProduct: round2(outputVat),
      outputVatShipping: 0,
      outputVatGiftwrap: 0,
      outputVatPromo: 0,
      marketplaceWithheldVat: 0,
      retrochargeVat: 0,

      grossProfit: round2(grossProfit),
      grossMargin: round2(grossMargin),
      totalAmazonFeesExvat: round2(totalAmazonFeesExvat),
      netProfit: round2(netProfit),
      netMargin: round2(netMargin),

      costKnown,
      adOnly: false,
    });
  });

  return { lines };
}

/** Convenience helper for verification scripts. */
export function runTiktok(
  rows: RawRow[],
  opts: {
    cogsLookup?: CogsLookup;
    vatRatePct?: number;
    defaultDateIso?: string;
  }
) {
  const pnl = computeTiktokPnl(rows);
  const totals = deriveTiktokTotals({
    pnl,
    cogsLookup: opts.cogsLookup ?? new Map(),
    vatRatePct: opts.vatRatePct ?? 20,
    defaultDateIso: opts.defaultDateIso ?? new Date().toISOString().slice(0, 10),
  });
  const { lines } = computeTiktokPerSku({
    pnl,
    cogsLookup: opts.cogsLookup ?? new Map(),
    vatRatePct: opts.vatRatePct ?? 20,
    defaultDateIso: opts.defaultDateIso ?? new Date().toISOString().slice(0, 10),
  });
  return { pnl, totals, lines };
}

export { normalizeSku as normalizeTiktokSku };
