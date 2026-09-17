import type { SupabaseClient } from "@supabase/supabase-js";

export type AmazonDailySalesSyncResult = {
  account_id?: string;
  from?: string | null;
  to?: string | null;
  inserted?: number;
  updated?: number;
  warehouses_filled?: number;
  default_warehouse_id?: string | null;
};

/**
 * Copy Amazon SP-API unit totals from `inventory_sales_facts_cache` into
 * `inventory_daily_sales` so warehouse dispatch reports include Amazon.
 *
 * Inserts missing (SKU, date) rows with the Sportive warehouse (or the first
 * warehouse). Updates sold_units on single existing rows; never overwrites a
 * warehouse the user already set, and never merges split warehouse rows.
 */
export async function syncAmazonDailySalesFromFacts(
  supabase: SupabaseClient,
  accountId: string,
  range?: { from?: string | null; to?: string | null },
): Promise<AmazonDailySalesSyncResult | null> {
  const { data, error } = await supabase.rpc("sync_amazon_daily_sales_from_facts", {
    p_account_id: accountId,
    p_from: range?.from || null,
    p_to: range?.to || null,
  });
  if (error) throw new Error(error.message);
  return (data as AmazonDailySalesSyncResult) || null;
}
