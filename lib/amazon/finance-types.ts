/**
 * Minimal type surface for the Amazon SP-API Finance v0 API responses.
 *
 * We only declare the fields we actually consume in the mapper. Amazon
 * documents many more sub-fields, but inlining everything would just be noise.
 * Anything we don't explicitly type stays as `unknown` so callers must be
 * explicit if they want to read it.
 */

export type CurrencyAmount = {
  CurrencyCode?: string;
  CurrencyAmount?: number;
};

/** Generic charge / fee entry used across several event types. */
export type ChargeComponent = {
  ChargeType?: string; // "Principal" | "Tax" | "Shipping" | "ShippingTax" | "GiftWrap" | ...
  ChargeAmount?: CurrencyAmount;
};

export type FeeComponent = {
  FeeType?: string; // "Commission" | "FBAPerUnitFulfillmentFee" | "FBAWeightBasedFee" | ...
  FeeAmount?: CurrencyAmount;
};

export type PromotionComponent = {
  PromotionType?: string;
  PromotionId?: string;
  PromotionAmount?: CurrencyAmount;
};

export type TaxWithheldComponent = {
  TaxCollectionModel?: string;
  TaxesWithheld?: ChargeComponent[];
};

export type ShipmentItem = {
  SellerSKU?: string;
  OrderItemId?: string;
  QuantityShipped?: number;
  ItemChargeList?: ChargeComponent[];
  ItemFeeList?: FeeComponent[];
  ItemTaxWithheldList?: TaxWithheldComponent[];
  PromotionList?: PromotionComponent[];
};

export type ShipmentEvent = {
  AmazonOrderId?: string;
  SellerOrderId?: string;
  MarketplaceName?: string;
  PostedDate?: string;
  ShipmentItemList?: ShipmentItem[];
  ShipmentItemAdjustmentList?: ShipmentItem[];
  OrderChargeList?: ChargeComponent[];
  OrderChargeAdjustmentList?: ChargeComponent[];
  OrderFeeList?: FeeComponent[];
  OrderFeeAdjustmentList?: FeeComponent[];
};

export type RefundEvent = ShipmentEvent;

export type ServiceFeeEvent = {
  AmazonOrderId?: string;
  FeeReason?: string;
  FeeList?: FeeComponent[];
  SellerSKU?: string;
  FnSKU?: string;
  FeeDescription?: string;
  ASIN?: string;
  PostedDate?: string;
};

export type AdjustmentItem = {
  Quantity?: string;
  PerUnitAmount?: CurrencyAmount;
  TotalAmount?: CurrencyAmount;
  SellerSKU?: string;
  FnSKU?: string;
  ProductDescription?: string;
  ASIN?: string;
};

export type AdjustmentEvent = {
  AdjustmentType?: string;
  PostedDate?: string;
  AdjustmentAmount?: CurrencyAmount;
  AdjustmentItemList?: AdjustmentItem[];
};

export type RetrochargeEvent = {
  RetrochargeEventType?: string; // "Retrocharge" | "RetrochargeReversal"
  AmazonOrderId?: string;
  PostedDate?: string;
  BaseTax?: CurrencyAmount;
  ShippingTax?: CurrencyAmount;
  MarketplaceWithheldTaxList?: TaxWithheldComponent[];
  RetrochargeTaxWithheldList?: TaxWithheldComponent[];
};

export type ProductAdsPaymentEvent = {
  PostedDate?: string;
  TransactionType?: string;
  InvoiceId?: string;
  BaseValue?: CurrencyAmount;
  TaxValue?: CurrencyAmount;
  TransactionValue?: CurrencyAmount;
};

export type FinancialEventGroup = {
  FinancialEventGroupId?: string;
  ProcessingStatus?: string;
  FundTransferStatus?: string;
  OriginalTotal?: CurrencyAmount;
  ConvertedTotal?: CurrencyAmount;
  FundTransferDate?: string;
  TraceId?: string;
  AccountTail?: string;
  BeginningBalance?: CurrencyAmount;
  FinancialEventGroupStart?: string;
  FinancialEventGroupEnd?: string;
};

export type FinancialEvents = {
  ShipmentEventList?: ShipmentEvent[];
  RefundEventList?: RefundEvent[];
  GuaranteeClaimEventList?: RefundEvent[];
  ChargebackEventList?: RefundEvent[];
  ServiceFeeEventList?: ServiceFeeEvent[];
  AdjustmentEventList?: AdjustmentEvent[];
  RetrochargeEventList?: RetrochargeEvent[];
  ProductAdsPaymentEventList?: ProductAdsPaymentEvent[];
  // …many more event lists exist on the SP-API; left untyped on purpose
  [otherEventList: string]: unknown;
};

export type ListFinancialEventGroupsResponse = {
  payload?: {
    FinancialEventGroupList?: FinancialEventGroup[];
    NextToken?: string;
  };
};

export type ListFinancialEventsResponse = {
  payload?: {
    FinancialEvents?: FinancialEvents;
    NextToken?: string;
  };
};
