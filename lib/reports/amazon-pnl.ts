/**
 * Amazon Profit & Loss engine — TypeScript port of `Rexo/rexo_pnl.py`.
 *
 * Operates on parsed transaction rows (from Amazon Seller Central
 * "Transaction" exports) and produces:
 *   - Account-level totals matching the Python script to the penny
 *   - Per-SKU dicts ready for the per-SKU profit calculation
 *   - An order_id → SKUs map used in pass 2 to back-attribute Delivery
 *     Services and Order/Refund Retrocharges to the originating SKU(s)
 *
 * Methodology (must stay aligned with the portal's Amazon accrual model):
 *   • Include Released + Deferred transactions.
 *   • product_sales / postage_credits / promotional_rebates are EX-VAT.
 *   • product_sales_tax / shipping_credits_tax / giftwrap_credits_tax /
 *     promotional_rebates_tax are OUTPUT VAT.
 *   • marketplace_withheld_tax (negative) → reduces output VAT remitted to HMRC.
 *   • selling_fees / fba_fees / other_transaction_fees on Order/Refund are
 *     VAT-inclusive (ex-VAT = gross × 5/6, VAT = gross × 1/6).
 *   • Service Fee 'Cost of Advertising': ex-VAT in 'other transaction fees'
 *     and VAT in 'other' (already separated by Amazon).
 *   • Service Fee 'Subscription' in 'other': VAT-inclusive.
 *   • FBA Inventory Fee in 'other': VAT-inclusive.
 *   • Delivery Services in 'other': VAT-inclusive.
 *   • Adjustment (FBA Inventory Reimbursement): outside scope of VAT.
 *   • Amazon Fees deal participation/performance: VAT-inclusive in selling_fees,
 *     no SKU on the row → allocated to SKUs by net-sales pro-rata.
 *   • Order_Retrocharge / Refund_Retrocharge: pure VAT correction, attributed
 *     back to original Order's SKU(s) by qty.
 *   • Transfers: cash payouts; informational only.
 */

import type { CogsLookup, CogsVersion, DerivedTotals, PnL } from "./types";
import { VAT_RATE_DEFAULT } from "./types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type RawRow = unknown[];

function norm(value: unknown): string {
  return String(value ?? "")
    .replace(/\u00a0/g, " ")
    .replace(/\ufeff/g, "")
    .trim()
    .toLowerCase();
}

function normalizeSku(value: unknown): string {
  const raw = String(value ?? "")
    .replace(/\u00a0/g, " ")
    .trim();
  return raw.toLowerCase();
}

function toFloat(value: unknown): number {
  if (value === null || value === undefined || value === "") return 0;
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  const cleaned = String(value).replace(/[,£$€]/g, "").trim();
  const parsed = Number.parseFloat(cleaned);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Map of canonical field name → list of header substrings (in priority order).
 * The first header whose normalized text contains ALL of the substrings is
 * matched. Mirrors the Python script's positional indices but resolves them
 * dynamically so we tolerate different export shapes.
 */
const FIELD_ALIASES: Record<string, string[][]> = {
  type: [["type"]],
  order_id: [["order id"]],
  sku: [["sku"]],
  description: [["description"]],
  quantity: [["quantity"]],
  product_sales: [["product sales"], ["product", "sales"]],
  product_sales_tax: [["product sales tax"], ["product", "sales", "tax"]],
  postage_credits: [["shipping credits"], ["postage credits"]],
  shipping_credits_tax: [["shipping credits tax"], ["postage credits tax"]],
  giftwrap_credits_tax: [["gift wrap credits tax"], ["giftwrap credits tax"]],
  promotional_rebates: [["promotional rebates"], ["promotional", "rebate"]],
  promotional_rebates_tax: [["promotional rebates tax"]],
  marketplace_withheld_tax: [["marketplace withheld tax"]],
  selling_fees: [["selling fees"]],
  fba_fees: [["fba fees"]],
  other_tx_fees: [["other transaction fees"]],
  other: [["other"]], // matched last; resolveFieldIndex enforces "exact" preference
  total: [["total"]],
  status: [["transaction status"], ["status"]],
};

type FieldIndex = Record<keyof typeof FIELD_ALIASES, number>;

/**
 * Build a positional column map for a header row. Only built once per file.
 * For "other" we want the bare "other" column (not "other transaction fees"),
 * so we filter out columns that already match a more specific field.
 */
/**
 * Score a candidate header row by counting how many of the canonical
 * Amazon settlement fields it matches. Used to find the real header row
 * when an Excel sheet has banner/metadata rows above it.
 */
function scoreHeaderRow(headerRow: unknown[]): number {
  const headers = headerRow.map((h) => norm(h));
  if (headers.every((h) => !h)) return 0;
  const fields = Object.keys(FIELD_ALIASES);
  let score = 0;
  for (const field of fields) {
    for (const aliasGroup of FIELD_ALIASES[field]) {
      const hit = headers.some((h) => h && aliasGroup.every((sub) => h.includes(sub)));
      if (hit) {
        score += 1;
        break;
      }
    }
  }
  return score;
}

/**
 * Find the index of the first row that looks like the real header row.
 * Scans the first 25 rows and picks the highest-scoring one (must beat a
 * minimum threshold of 4 known fields). Falls back to row 0 if none match.
 */
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
  return bestScore >= 4 ? bestIdx : 0;
}

function buildFieldIndex(headerRow: unknown[]): FieldIndex {
  const headers = headerRow.map((h) => norm(h));
  const taken = new Set<number>();
  const idx: Record<string, number> = {};

  // Pass 1: resolve every field except "other" (which is too generic).
  const ordered = Object.keys(FIELD_ALIASES).filter((k) => k !== "other");
  for (const field of ordered) {
    for (const aliasGroup of FIELD_ALIASES[field]) {
      let found = -1;
      for (let j = 0; j < headers.length; j += 1) {
        if (taken.has(j)) continue;
        const h = headers[j];
        if (!h) continue;
        if (aliasGroup.every((sub) => h.includes(sub))) {
          found = j;
          break;
        }
      }
      if (found >= 0) {
        idx[field] = found;
        taken.add(found);
        break;
      }
    }
    if (!(field in idx)) idx[field] = -1;
  }

  // Pass 2: "other" — the bare column not yet taken.
  let otherIdx = -1;
  for (let j = 0; j < headers.length; j += 1) {
    if (taken.has(j)) continue;
    if (headers[j] === "other") {
      otherIdx = j;
      break;
    }
  }
  idx.other = otherIdx;

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

/** Split a VAT-inclusive amount at 20% into [exVat, vat]. */
export function splitVatInclusive(
  amountIncVat: number,
  vatRate: number = VAT_RATE_DEFAULT
): [number, number] {
  const vat = amountIncVat * (vatRate / (1 + vatRate));
  const exVat = amountIncVat - vat;
  return [exVat, vat];
}

function emptyPnl(): PnL {
  return {
    productSales: 0,
    productSalesPositive: 0,
    productSalesRefunds: 0,
    postageCredits: 0,
    promotionalRebates: 0,

    outputVatProduct: 0,
    outputVatShipping: 0,
    outputVatGiftwrap: 0,
    outputVatPromoRebates: 0,
    outputVatRetrocharge: 0,
    marketplaceWithheldTax: 0,

    sellingFeesGross: 0,
    sellingFeesGrossSkued: 0,
    dealFeesGross: 0,
    fbaFeesGross: 0,
    otherTxFeesGross: 0,
    fbaInventoryFeesGross: 0,
    deliveryServicesGross: 0,
    subscriptionGross: 0,

    advertisingExvat: 0,
    advertisingVat: 0,

    fbaReimbursements: 0,
    fbaReimbursementsUnallocated: 0,

    transfers: 0,

    skuUnits: {},
    skuRefundUnits: {},
    skuProductSales: {},
    skuPostageCredits: {},
    skuPromoRebates: {},
    skuOutputVatProduct: {},
    skuOutputVatShipping: {},
    skuOutputVatGiftwrap: {},
    skuOutputVatPromo: {},
    skuMarketplaceWithheld: {},
    skuSellingFeesGross: {},
    skuFbaFeesGross: {},
    skuOtherTxFeesGross: {},
    skuFbaReimbursements: {},
    skuDeliveryServicesGross: {},
    skuRetrochargeVat: {},

    skuDescriptions: {},
    orderIdToSkus: {},

    sheetTotalSum: 0,
    rowsProcessed: 0,
    rowsSkipped: 0,
    deliveryServicesUnmatched: 0,
    retrochargeUnmatched: 0,
  };
}

function bumpSku(map: Record<string, number>, sku: string, amount: number): void {
  if (!sku) return;
  map[sku] = (map[sku] || 0) + amount;
}

// ---------------------------------------------------------------------------
// Pass 1 + 2: build the PnL object
// ---------------------------------------------------------------------------

type DeferredRow =
  | { kind: "delivery"; orderId: string; amount: number }
  | { kind: "retrocharge"; orderId: string; vatAmount: number };

/**
 * Compute the account-level + per-SKU PnL from raw transaction rows.
 *
 * Input format: 2D array where the first row is the header. Use
 * `XLSX.utils.sheet_to_json(ws, { header: 1, defval: "" })` to produce it,
 * or for CSV use `papaparse` with `header: false`. Headers are matched by
 * substring so different Amazon export variants work.
 */
export function computeAmazonPnl(rows: RawRow[]): PnL {
  const p = emptyPnl();
  if (!rows.length) return p;

  // Find the actual header row — Amazon exports sometimes have banner/metadata
  // rows above the real headers, and saved JSONB raw_row data may have used
  // those banner cells as object keys.
  const headerIdx = findHeaderRowIndex(rows as unknown[][]);
  const headerRow = rows[headerIdx];
  const idx = buildFieldIndex(headerRow);
  const dataRows = rows.slice(headerIdx + 1);
  const deferred: DeferredRow[] = [];

  for (const row of dataRows) {
    if (!row) continue;

    const statusVal = norm(getCell(row, idx, "status"));
    // Accrual view: include both Released + Deferred so ad spend and order
    // economics are measured on the same operating period basis.
    if (statusVal && statusVal !== "released" && statusVal !== "deferred") {
      p.rowsSkipped += 1;
      continue;
    }

    const typeVal = norm(getCell(row, idx, "type"));
    if (!typeVal) continue;

    const desc = String(getCell(row, idx, "description") ?? "");
    const total = getNum(row, idx, "total");

    p.sheetTotalSum += total;
    p.rowsProcessed += 1;

    if (typeVal === "order" || typeVal === "refund") {
      const ps = getNum(row, idx, "product_sales");
      const pc = getNum(row, idx, "postage_credits");
      const pr = getNum(row, idx, "promotional_rebates");

      p.productSales += ps;
      if (typeVal === "order") p.productSalesPositive += ps;
      else p.productSalesRefunds += ps;
      p.postageCredits += pc;
      p.promotionalRebates += pr;

      const ovp = getNum(row, idx, "product_sales_tax");
      const ovs = getNum(row, idx, "shipping_credits_tax");
      const ovg = getNum(row, idx, "giftwrap_credits_tax");
      const ovpr = getNum(row, idx, "promotional_rebates_tax");
      const mw = getNum(row, idx, "marketplace_withheld_tax");

      p.outputVatProduct += ovp;
      p.outputVatShipping += ovs;
      p.outputVatGiftwrap += ovg;
      p.outputVatPromoRebates += ovpr;
      p.marketplaceWithheldTax += mw;

      const sf = getNum(row, idx, "selling_fees");
      const ff = getNum(row, idx, "fba_fees");
      const otf = getNum(row, idx, "other_tx_fees");

      p.sellingFeesGross += sf;
      p.sellingFeesGrossSkued += sf;
      p.fbaFeesGross += ff;
      p.otherTxFeesGross += otf;

      const sku = normalizeSku(getCell(row, idx, "sku"));
      const orderId = String(getCell(row, idx, "order_id") ?? "").trim();
      const qty = toFloat(getCell(row, idx, "quantity"));

      if (sku) {
        const signedQty = typeVal === "order" ? qty : -qty;
        bumpSku(p.skuUnits, sku, signedQty);
        if (typeVal === "refund") bumpSku(p.skuRefundUnits, sku, qty);
        bumpSku(p.skuProductSales, sku, ps);
        bumpSku(p.skuPostageCredits, sku, pc);
        bumpSku(p.skuPromoRebates, sku, pr);
        bumpSku(p.skuOutputVatProduct, sku, ovp);
        bumpSku(p.skuOutputVatShipping, sku, ovs);
        bumpSku(p.skuOutputVatGiftwrap, sku, ovg);
        bumpSku(p.skuOutputVatPromo, sku, ovpr);
        bumpSku(p.skuMarketplaceWithheld, sku, mw);
        bumpSku(p.skuSellingFeesGross, sku, sf);
        bumpSku(p.skuFbaFeesGross, sku, ff);
        bumpSku(p.skuOtherTxFeesGross, sku, otf);
        if (!p.skuDescriptions[sku] && desc) p.skuDescriptions[sku] = desc;
        if (typeVal === "order" && orderId && qty > 0) {
          if (!p.orderIdToSkus[orderId]) p.orderIdToSkus[orderId] = [];
          p.orderIdToSkus[orderId].push({ sku, qty });
        }
      }
    } else if (typeVal === "service fee") {
      if (desc.toLowerCase().includes("advertising")) {
        p.advertisingExvat += getNum(row, idx, "other_tx_fees");
        p.advertisingVat += getNum(row, idx, "other");
      } else {
        p.subscriptionGross += getNum(row, idx, "other");
      }
    } else if (typeVal === "fba inventory fee") {
      p.fbaInventoryFeesGross += getNum(row, idx, "other");
    } else if (typeVal === "delivery services") {
      const orderId = String(getCell(row, idx, "order_id") ?? "").trim();
      const amount = getNum(row, idx, "other");
      p.deliveryServicesGross += amount;
      deferred.push({ kind: "delivery", orderId, amount });
    } else if (typeVal === "adjustment") {
      const amount = getNum(row, idx, "other");
      p.fbaReimbursements += amount;
      const sku = normalizeSku(getCell(row, idx, "sku"));
      if (sku) {
        bumpSku(p.skuFbaReimbursements, sku, amount);
        if (!p.skuDescriptions[sku] && desc) p.skuDescriptions[sku] = desc;
      } else {
        p.fbaReimbursementsUnallocated += amount;
      }
    } else if (typeVal === "amazon fees") {
      const sf = getNum(row, idx, "selling_fees");
      p.sellingFeesGross += sf;
      p.dealFeesGross += sf;
    } else if (typeVal === "order_retrocharge" || typeVal === "refund_retrocharge") {
      const orderId = String(getCell(row, idx, "order_id") ?? "").trim();
      const vatAmount =
        getNum(row, idx, "product_sales_tax") +
        getNum(row, idx, "shipping_credits_tax") +
        getNum(row, idx, "giftwrap_credits_tax");
      p.outputVatRetrocharge += vatAmount;
      deferred.push({ kind: "retrocharge", orderId, vatAmount });
    } else if (typeVal === "transfer") {
      p.transfers += total;
    }
  }

  // Pass 2: back-attribute Delivery Services & Retrocharges to SKU(s) via order_id,
  // splitting proportionally to qty when the original order had multiple SKUs.
  for (const d of deferred) {
    const skuList = d.orderId ? p.orderIdToSkus[d.orderId] : undefined;
    if (!skuList || skuList.length === 0) {
      if (d.kind === "delivery") p.deliveryServicesUnmatched += d.amount;
      else p.retrochargeUnmatched += d.vatAmount;
      continue;
    }
    const totalQty = skuList.reduce((acc, s) => acc + s.qty, 0) || 1;
    for (const { sku, qty } of skuList) {
      const share = (d.kind === "delivery" ? d.amount : d.vatAmount) * (qty / totalQty);
      if (d.kind === "delivery") {
        bumpSku(p.skuDeliveryServicesGross, sku, share);
      } else {
        bumpSku(p.skuRetrochargeVat, sku, share);
      }
    }
  }

  return p;
}

// ---------------------------------------------------------------------------
// Account-level derived figures
// ---------------------------------------------------------------------------

export function resolveCogsVersion(
  cogsLookup: CogsLookup,
  sku: string,
  txDateIso: string
): CogsVersion | null {
  const key = sku.toLowerCase();
  const versions = cogsLookup.get(key);
  if (!versions || versions.length === 0) return null;
  let selected: CogsVersion | null = null;
  for (const version of versions) {
    if (version.effectiveFrom <= txDateIso) {
      selected = version;
    } else {
      break;
    }
  }
  return selected || versions[0] || null;
}

/**
 * Look up COGS for a SKU. Falls back to the parent SKU for Amazon-grouped
 * children of the form `amzn.gr.<parent>-<hash>`.
 */
export function costForSku(
  cogsLookup: CogsLookup,
  sku: string,
  txDateIso: string
): CogsVersion | null {
  const direct = resolveCogsVersion(cogsLookup, sku, txDateIso);
  if (direct) return direct;
  if (sku.toLowerCase().startsWith("amzn.gr.")) {
    const rest = sku.slice("amzn.gr.".length);
    const parent = rest.split("-")[0];
    if (parent) return resolveCogsVersion(cogsLookup, parent, txDateIso);
  }
  return null;
}

const round2 = (value: number) => Math.round(value * 100) / 100;

/**
 * Compute account-level derived figures (net sales, COGS, gross profit,
 * VAT components, etc.) from a PnL aggregate. Costs are returned negative.
 *
 * COGS-VAT model: matches the portal's existing behaviour — when a SKU's
 * unit cost has `includesVat = true`, we treat the cost as gross and pull
 * the VAT portion into reclaimable input VAT. This is more accurate than
 * a flat percentage applied at the account level.
 */
export function deriveTotals(input: {
  pnl: PnL;
  cogsLookup: CogsLookup;
  vatRatePct: number;
  /** ISO date used for COGS time-versioning lookups (typically period start). */
  defaultDateIso: string;
  /**
   * Percentage of inventory purchased from UK VAT-registered suppliers (0–100).
   * Applied on top of ex-VAT COGS as reclaimable Input VAT (matches the
   * Python script's `--cogs-vat-pct` flag). Defaults to 100.
   * Ignored for SKUs whose COGS row already has `includesVat=true` (those use
   * the explicit gross/net split instead).
   */
  cogsVatReclaimPct?: number;
}): DerivedTotals {
  const { pnl: p, cogsLookup, vatRatePct, defaultDateIso } = input;
  const vatRate = vatRatePct / 100;
  const cogsVatReclaimFraction = Math.max(0, Math.min(100, input.cogsVatReclaimPct ?? 100)) / 100;

  const netSales = p.productSales + p.postageCredits + p.promotionalRebates;

  const totalOutputVat =
    p.outputVatProduct +
    p.outputVatShipping +
    p.outputVatGiftwrap +
    p.outputVatPromoRebates +
    p.outputVatRetrocharge;

  const outputVatPayableToHmrc = totalOutputVat + p.marketplaceWithheldTax;

  const splitAt = (g: number) => splitVatInclusive(g, vatRate);

  const [sellingExSigned, sellingVatNeg] = splitAt(p.sellingFeesGross);
  const [sellingExSkuedSigned, ] = splitAt(p.sellingFeesGrossSkued);
  const [dealExSigned, ] = splitAt(p.dealFeesGross);
  const [fbaExSigned, fbaVatNeg] = splitAt(p.fbaFeesGross);
  const [otherTxExSigned, otherTxVatNeg] = splitAt(p.otherTxFeesGross);
  const [deliveryExSigned, deliveryVatNeg] = splitAt(p.deliveryServicesGross);
  const [subExSigned, subVatNeg] = splitAt(p.subscriptionGross);

  // FBA Inventory Fee: Amazon does not issue HMRC-compliant VAT invoices for
  // storage / FBA inventory charges in the UK, so we treat the full gross as
  // a cost and do not reclaim any input VAT on it.
  const fbaInvExSigned = p.fbaInventoryFeesGross;
  const inputVatFbaInventory = 0;

  // Negate the VAT portions so input VAT is presented as positive (reclaimable).
  const inputVatSelling = -sellingVatNeg;
  const inputVatFba = -fbaVatNeg;
  const inputVatOtherTx = -otherTxVatNeg;
  const inputVatDelivery = -deliveryVatNeg;
  const inputVatSubscription = -subVatNeg;

  const advertisingEx = p.advertisingExvat; // negative
  const inputVatAdvertising = -p.advertisingVat;

  // COGS: time-versioned, with per-SKU includes-VAT split out for input VAT.
  let cogsExVat = 0;     // negative
  let cogsVat = 0;       // positive (input VAT reclaim)
  let matchedCogsPositive = 0;
  let matchedSkus = 0;
  let unmatchedSkus = 0;
  let matchedUnits = 0;
  let unmatchedUnits = 0;

  for (const [sku, units] of Object.entries(p.skuUnits)) {
    const u = units;
    const cv = costForSku(cogsLookup, sku, defaultDateIso);
    if (!cv) {
      unmatchedSkus += 1;
      unmatchedUnits += u;
      continue;
    }
    matchedSkus += 1;
    matchedUnits += u;
    if (cv.includesVat && vatRate > 0) {
      const unitNet = cv.unitCost / (1 + vatRate);
      const unitVat = cv.unitCost - unitNet;
      cogsExVat += -unitNet * u;
      cogsVat += unitVat * u;
      matchedCogsPositive += unitNet * u;
    } else {
      cogsExVat += -cv.unitCost * u;
      matchedCogsPositive += cv.unitCost * u;
      if (vatRate > 0 && cogsVatReclaimFraction > 0) {
        cogsVat += cv.unitCost * u * cogsVatReclaimFraction * vatRate;
      }
    }
  }

  const totalAmazonFeesExvat =
    sellingExSigned +
    fbaExSigned +
    otherTxExSigned +
    fbaInvExSigned +
    deliveryExSigned +
    subExSigned +
    advertisingEx;

  const totalInputVatAmazonFees =
    inputVatSelling +
    inputVatFba +
    inputVatOtherTx +
    inputVatFbaInventory +
    inputVatDelivery +
    inputVatSubscription +
    inputVatAdvertising;

  const totalInputVatIncludingCogs = totalInputVatAmazonFees + cogsVat;

  const grossProfit = netSales + cogsExVat;
  const operatingProfit = netSales + p.fbaReimbursements + cogsExVat + totalAmazonFeesExvat;
  const vatPayable = outputVatPayableToHmrc - totalInputVatIncludingCogs;

  return {
    netSales: round2(netSales),
    fbaReimbursements: round2(p.fbaReimbursements),
    cogs: round2(cogsExVat),
    grossProfit: round2(grossProfit),
    totalAmazonFeesExvat: round2(totalAmazonFeesExvat),
    operatingProfit: round2(operatingProfit),

    outputVatProduct: round2(p.outputVatProduct),
    outputVatShipping: round2(p.outputVatShipping),
    outputVatGiftwrap: round2(p.outputVatGiftwrap),
    outputVatPromoRebates: round2(p.outputVatPromoRebates),
    outputVatRetrocharge: round2(p.outputVatRetrocharge),
    totalOutputVat: round2(totalOutputVat),
    marketplaceWithheldTax: round2(p.marketplaceWithheldTax),
    outputVatPayableToHmrc: round2(outputVatPayableToHmrc),

    inputVatSelling: round2(inputVatSelling),
    inputVatFba: round2(inputVatFba),
    inputVatOtherTx: round2(inputVatOtherTx),
    inputVatFbaInventory: round2(inputVatFbaInventory),
    inputVatDelivery: round2(inputVatDelivery),
    inputVatSubscription: round2(inputVatSubscription),
    inputVatAdvertising: round2(inputVatAdvertising),
    inputVatCogs: round2(cogsVat),
    totalInputVatAmazonFees: round2(totalInputVatAmazonFees),
    totalInputVatIncludingCogs: round2(totalInputVatIncludingCogs),

    vatPayable: round2(vatPayable),

    sellingFeesExvat: round2(sellingExSigned),
    sellingFeesExvatSkued: round2(sellingExSkuedSigned),
    dealFeesExvat: round2(dealExSigned),
    fbaFeesExvat: round2(fbaExSigned),
    otherTxFeesExvat: round2(otherTxExSigned),
    fbaInventoryFeesExvat: round2(fbaInvExSigned),
    deliveryServicesExvat: round2(deliveryExSigned),
    subscriptionExvat: round2(subExSigned),
    advertisingExvat: round2(advertisingEx),

    bankTransfers: round2(p.transfers),

    matchedSkus,
    unmatchedSkus,
    matchedUnits,
    unmatchedUnits,
    matchedCogsPositive: round2(matchedCogsPositive),
    rowsProcessed: p.rowsProcessed,
    rowsSkipped: p.rowsSkipped,
    sheetTotalSum: round2(p.sheetTotalSum),
    deliveryUnmatched: round2(p.deliveryServicesUnmatched),
    retrochargeUnmatched: round2(p.retrochargeUnmatched),
    reimburseUnallocated: round2(p.fbaReimbursementsUnallocated),
  };
}

/**
 * Override the advertising figures with an external ads-report total. Treats
 * the report total as ex-VAT (Amazon Ads UK invoices charge VAT on top), so
 * input VAT becomes report_total × vatRate.
 *
 * Mutates the PnL in place so subsequent `deriveTotals` calls see the new
 * numbers.
 */
export function applyAdReportOverride(
  p: PnL,
  adReportTotalExvat: number,
  vatRatePct: number
): { previousAdExvat: number; previousAdVat: number } {
  const previousAdExvat = p.advertisingExvat;
  const previousAdVat = p.advertisingVat;
  const vatRate = vatRatePct / 100;
  p.advertisingExvat = -adReportTotalExvat; // ex-VAT, negative
  p.advertisingVat = -(adReportTotalExvat * vatRate); // VAT paid (negative)
  return { previousAdExvat, previousAdVat };
}
