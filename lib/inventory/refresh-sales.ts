import type { SupabaseClient } from "@supabase/supabase-js";
import { syncAmazonDailySalesFromFacts } from "@/lib/inventory/sync-amazon-daily-sales";

/**
 * Rebuild Overview velocity cache, then copy Amazon units into Daily Sales
 * so warehouse dispatch reports stay aligned with SP-API order dates.
 */
export async function refreshInventorySalesAndDailySales(
  supabase: SupabaseClient,
  accountId: string,
  range?: { from?: string | null; to?: string | null },
): Promise<void> {
  const { error } = await supabase.rpc("refresh_inventory_sales_facts", {
    p_account_id: accountId,
  });
  if (error) throw new Error(error.message);
  await syncAmazonDailySalesFromFacts(supabase, accountId, range);
}
