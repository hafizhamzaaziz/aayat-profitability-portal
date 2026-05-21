/**
 * Shared types for the Amazon profitability engine.
 *
 * Mirrors the Python reference implementation in `Rexo/rexo_pnl.py` so the
 * portal and the script produce identical numbers.
 *
 * Sign conventions (P&L view, ex-VAT):
 *   - Income / sales: positive
 *   - Costs (COGS, fees, advertising, etc.): negative
 *   - Refunds: negative on the sales side, positive on the fees side (Amazon
 *     refunds part of the original fees back to you)
 *   - Output VAT: positive (collected from customers)
 *   - Input VAT: positive (reclaimable from HMRC)
 *   - marketplace_withheld_tax: negative (Amazon already paid HMRC for you →
 *     reduces what you owe HMRC at the bottom of the VAT calc)
 */

export type PerSkuFloatMap = Record<string, number>;

/**
 * Aggregated account-level + per-SKU figures from one Amazon transaction file.
 * All numeric fields default to 0; per-SKU dicts default to {}.
 */
export type PnL = {
  // ----- Account-level aggregates -----
  productSales: number;
  /** Positive product_sales lines (Order rows only). */
  productSalesPositive: number;
  /** Negative product_sales lines (Refund rows only; signed). */
  productSalesRefunds: number;
  postageCredits: number;
  promotionalRebates: number;

  outputVatProduct: number;
  outputVatShipping: number;
  outputVatGiftwrap: number;
  outputVatPromoRebates: number;
  outputVatRetrocharge: number;
  marketplaceWithheldTax: number;

  /** Order/Refund 'selling fees' + 'Amazon Fees' deal participation/performance, gross of VAT. */
  sellingFeesGross: number;
  /** Subset of sellingFeesGross that came from Order/Refund rows (have a SKU). */
  sellingFeesGrossSkued: number;
  /** Amazon Fees rows (no SKU) — allocated to SKUs by net sales pro-rata. */
  dealFeesGross: number;
  fbaFeesGross: number;
  otherTxFeesGross: number;
  fbaInventoryFeesGross: number;
  deliveryServicesGross: number;
  subscriptionGross: number;

  /** Cost of Advertising service-fee lines from the transaction sheet (ex-VAT, negative). */
  advertisingExvat: number;
  /** Cost of Advertising VAT (negative — what you paid). Will be negated on output as reclaimable input VAT. */
  advertisingVat: number;

  fbaReimbursements: number;
  /** Adjustment rows without an SKU; stays in account-level only. */
  fbaReimbursementsUnallocated: number;

  transfers: number;

  // ----- Per-SKU dicts (signs match the account-level aggregates) -----
  skuUnits: PerSkuFloatMap;            // Order qty − Refund qty
  skuRefundUnits: PerSkuFloatMap;      // Refund qty (positive)
  skuProductSales: PerSkuFloatMap;
  skuPostageCredits: PerSkuFloatMap;
  skuPromoRebates: PerSkuFloatMap;
  skuOutputVatProduct: PerSkuFloatMap;
  skuOutputVatShipping: PerSkuFloatMap;
  skuOutputVatGiftwrap: PerSkuFloatMap;
  skuOutputVatPromo: PerSkuFloatMap;
  skuMarketplaceWithheld: PerSkuFloatMap;
  skuSellingFeesGross: PerSkuFloatMap;
  skuFbaFeesGross: PerSkuFloatMap;
  skuOtherTxFeesGross: PerSkuFloatMap;
  skuFbaReimbursements: PerSkuFloatMap;
  skuDeliveryServicesGross: PerSkuFloatMap;
  skuRetrochargeVat: PerSkuFloatMap;

  skuDescriptions: Record<string, string>;

  /** Order_id → list of (sku, qty) for back-attribution of Delivery Services & Retrocharges. */
  orderIdToSkus: Record<string, Array<{ sku: string; qty: number }>>;

  // ----- Diagnostics -----
  sheetTotalSum: number;
  rowsProcessed: number;
  rowsSkipped: number;
  deliveryServicesUnmatched: number;
  retrochargeUnmatched: number;
};

/**
 * Account-level derived figures, all rounded to 2dp.
 * `vatPayable` = `outputVatPayableToHmrc` − `totalInputVat` (negative ⇒ HMRC owes you).
 */
export type DerivedTotals = {
  netSales: number;
  fbaReimbursements: number;
  cogs: number;                          // negative
  grossProfit: number;
  totalAmazonFeesExvat: number;          // negative
  operatingProfit: number;

  outputVatProduct: number;
  outputVatShipping: number;
  outputVatGiftwrap: number;
  outputVatPromoRebates: number;
  outputVatRetrocharge: number;
  totalOutputVat: number;
  marketplaceWithheldTax: number;        // negative
  outputVatPayableToHmrc: number;

  inputVatSelling: number;               // positive (reclaimable)
  inputVatFba: number;
  inputVatOtherTx: number;
  inputVatFbaInventory: number;
  inputVatDelivery: number;
  inputVatSubscription: number;
  inputVatAdvertising: number;
  inputVatCogs: number;                  // from cogs lookup (positive)
  totalInputVatAmazonFees: number;
  totalInputVatIncludingCogs: number;

  vatPayable: number;

  sellingFeesExvat: number;              // ex-VAT, negative; INCLUDES dealFeesExvat
  sellingFeesExvatSkued: number;         // Order/Refund rows only
  dealFeesExvat: number;                 // Amazon Fees deal participation, ex-VAT, negative
  fbaFeesExvat: number;
  otherTxFeesExvat: number;
  fbaInventoryFeesExvat: number;
  deliveryServicesExvat: number;
  subscriptionExvat: number;
  advertisingExvat: number;

  bankTransfers: number;

  // Diagnostics
  matchedSkus: number;
  unmatchedSkus: number;
  matchedUnits: number;
  unmatchedUnits: number;
  matchedCogsPositive: number;
  rowsProcessed: number;
  rowsSkipped: number;
  sheetTotalSum: number;
  deliveryUnmatched: number;
  retrochargeUnmatched: number;
  reimburseUnallocated: number;
};

/** One per-SKU row of the profit table. All amounts ex-VAT. */
export type SkuLine = {
  sku: string;
  description: string;
  units: number;
  refundUnits: number;

  // Sales side
  netSales: number;
  productSales: number;
  postageCredits: number;
  promoRebates: number;

  // Direct costs (negative)
  cogs: number;
  sellingFeesExvat: number;
  fbaFeesExvat: number;
  otherTxFeesExvat: number;
  deliveryServicesExvat: number;

  // Allocated shared costs (negative)
  advertisingAlloc: number;
  fbaInventoryAlloc: number;
  subscriptionAlloc: number;
  dealFeesAlloc: number;

  // Other income
  fbaReimbursements: number;

  // Output VAT components (informational; positive)
  outputVatProduct: number;
  outputVatShipping: number;
  outputVatGiftwrap: number;
  outputVatPromo: number;
  marketplaceWithheldVat: number;
  retrochargeVat: number;

  // Derived
  grossProfit: number;
  grossMargin: number;
  totalAmazonFeesExvat: number;
  netProfit: number;
  netMargin: number;

  // Flags
  costKnown: boolean;
  adOnly: boolean;
};

/** Result of parsing an Amazon Ads campaign report. */
export type AdReport = {
  /** {normalised SKU → spend ex-VAT, positive £}. Excludes blank-SKU rows. */
  spendBySku: Record<string, number>;
  /** Sum of rows with no SKU (e.g. SB keyword campaigns). */
  blankSkuSpend: number;
  /** Total spend across all rows (matches blankSkuSpend + sum of spendBySku). */
  totalSpend: number;
  /** Original filename (for the audit trail). */
  sourceFilename: string;
  /** Diagnostics for the user (which spend column was used, etc.). */
  spendColumn: string;
  /** Number of distinct SKUs in the report (excludes blanks). */
  skuCount: number;
};

/** Per-SKU diagnostics returned alongside the SKU lines. */
export type PerSkuDiagnostics = {
  adMethod: "report (per-SKU, no scaling)" | "sales-pro-rata" | "none";
  adReportTotal: number;
  adBlankSkuSpend: number;
  adSkusUnmatched: Record<string, number>;
  adOnlySkus: string[];
  adOverridden: boolean;
  txSheetAdExvat: number;
  txSheetAdVat: number;
  totalUnitsBasis: number;
  totalNetSalesBasis: number;
};

/** Per-SKU unit cost lookup, time-versioned (matches the existing `cogs_history` table). */
export type CogsVersion = {
  unitCost: number;
  /** When true, unitCost is gross of VAT and we split out VAT for input-VAT reclaim. */
  includesVat: boolean;
  effectiveFrom: string; // YYYY-MM-DD
};
export type CogsLookup = Map<string, CogsVersion[]>;

export const VAT_RATE_DEFAULT = 0.2;
