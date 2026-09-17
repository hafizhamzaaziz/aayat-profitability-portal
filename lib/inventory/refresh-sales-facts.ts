import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Rebuild `inventory_sales_facts_cache` for one account from
 * `report_transactions` (manual + sp_api). Overview and Daily Sales both read
 * this cache, so it must run after any path that inserts/replaces/deletes txs.
 * Pass `from`/`to` to rebuild one inclusive date window (used after each
 * ingested month so a later timeout cannot leave new txs out of the cache).
 *
 * Non-throwing: a cache miss is recoverable on the next successful refresh.
 */
export async function refreshInventorySalesFacts(
  supabase: SupabaseClient,
  accountId: string,
  range?: { from?: string | null; to?: string | null },
): Promise<{ ok: true; rows: number | null } | { ok: false; error: string }> {
  const args: { p_account_id: string; p_from?: string; p_to?: string } = {
    p_account_id: accountId,
  };
  if (range?.from) args.p_from = range.from;
  if (range?.to) args.p_to = range.to;
  const { data, error } = await supabase.rpc("refresh_inventory_sales_facts", args);
  if (error) {
    return { ok: false, error: error.message };
  }
  const rows = typeof data === "number" ? data : data == null ? null : Number(data);
  return { ok: true, rows: Number.isFinite(rows as number) ? (rows as number) : null };
}
