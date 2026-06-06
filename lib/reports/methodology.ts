/**
 * Current report methodology identifiers.
 *
 * Saved reports persist the methodology ID inside `reports.breakdown` so
 * historical rows can be auto-upgraded when engine logic changes.
 */
export const AMAZON_METHODOLOGY_ID = "amazon_accrual_released_plus_deferred_v1";
export const TEMU_METHODOLOGY_ID = "temu_transfer_alignment_v2_seller_repayment_excluded";
export const TIKTOK_METHODOLOGY_ID = "tiktok_order_commission_v1_gross_base_per_order_fee";
