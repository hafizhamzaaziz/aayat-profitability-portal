import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Rebuild `inventory_sales_facts_cache` for one account from
 * `report_transactions` (manual + sp_api). Overview and Daily Sales both read
 * this cache, so it must run after any path that inserts/replaces/deletes txs.
 * Pass `from`/`to` to rebuild one inclusive date window (used after each
 * ingested month so a later timeout cannot leave new txs out of the cache).
 *
 * Platform filters (do not silently widen):
 * - Amazon: raw_row.type = 'order'. sale_date is report_transactions.transaction_date,
 *   which SP-API ingest sets from Orders API PurchaseDate (Seller Central
 *   "Units ordered"), not Finances PostedDate. raw_row["date/time"] stays posted.
 * - Temu: raw_row "Transaction type" = 'order payment' (stricter than temu-pnl,
 *   which also accepts 'order'). TikTok is not in this cache; Overview has no
 *   TikTok sold column. Manual Daily Sales may still record TikTok returns/notes.
 *
 * Call sites that write report_transactions:
 * - lib/amazon/ingest/orchestrate.ts ingestMonth (per ingested month)
 * - app/api/amazon/sync/route.ts after syncAmazonFinanceData (full rebuild)
 * - app/(portal)/reports/report-workbench.tsx after manual upload insert
 * - app/(portal)/reports/saved-reports-panel.tsx after report delete
 * Recompute reads txs and rewrites report totals only — it does not insert
 * report_transactions, so it does not refresh this cache.
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
