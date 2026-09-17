import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Rebuild `inventory_sales_facts_cache` for one account from
 * `report_transactions` (manual + sp_api). Overview and Daily Sales both read
 * this cache, so it must run after any path that inserts/replaces/deletes txs.
 *
 * Non-throwing: a cache miss is recoverable on the next successful refresh.
 */
export async function refreshInventorySalesFacts(
  supabase: SupabaseClient,
  accountId: string,
): Promise<{ ok: true; rows: number | null } | { ok: false; error: string }> {
  const { data, error } = await supabase.rpc("refresh_inventory_sales_facts", {
    p_account_id: accountId,
  });
  if (error) {
    return { ok: false, error: error.message };
  }
  const rows = typeof data === "number" ? data : data == null ? null : Number(data);
  return { ok: true, rows: Number.isFinite(rows as number) ? (rows as number) : null };
}
