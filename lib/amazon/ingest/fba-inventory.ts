/**
 * Live FBA stock snapshot via the FBA Inventory API.
 *
 * Writes one row per seller SKU into `amazon_fba_inventory`. The planner uses
 * it (when fresh) as the FBA on-hand and in-transit source instead of the
 * manual stock take. Needs the "Amazon Fulfillment" role on the SP-API app;
 * until Amazon grants it the call returns 403 and we report `roleMissing`.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { loadSpApiClient } from "../credentials";
import { SpApiError } from "../spapi";

export type FbaInventorySyncResult =
  | { ok: true; skus: number; snapshotAt: string }
  | { ok: false; roleMissing: boolean; error: string };

export async function syncFbaInventory(input: {
  supabase: SupabaseClient;
  accountId: string;
}): Promise<FbaInventorySyncResult> {
  const { supabase, accountId } = input;
  let client;
  let marketplaceIds: string[];
  try {
    ({ client, marketplaceIds } = await loadSpApiClient(accountId));
  } catch (err) {
    return { ok: false, roleMissing: false, error: err instanceof Error ? err.message : String(err) };
  }
  const marketplaceId = marketplaceIds[0] || "A1F83G8C2ARO7P";
  const snapshotAt = new Date().toISOString();

  const rows: Array<{
    account_id: string;
    sku: string;
    asin: string | null;
    fnsku: string | null;
    fulfillable: number;
    inbound_working: number;
    inbound_shipped: number;
    inbound_receiving: number;
    reserved: number;
    unfulfillable: number;
    snapshot_at: string;
  }> = [];

  let nextToken: string | undefined;
  try {
    do {
      const resp = await client.getInventorySummaries({ marketplaceId, nextToken });
      for (const s of resp.payload?.inventorySummaries || []) {
        const sku = String(s.sellerSku || "").trim();
        if (!sku) continue;
        const d = s.inventoryDetails || {};
        rows.push({
          account_id: accountId,
          sku,
          asin: s.asin ? String(s.asin).toUpperCase() : null,
          fnsku: s.fnSku || null,
          fulfillable: Number(d.fulfillableQuantity ?? 0),
          inbound_working: Number(d.inboundWorkingQuantity ?? 0),
          inbound_shipped: Number(d.inboundShippedQuantity ?? 0),
          inbound_receiving: Number(d.inboundReceivingQuantity ?? 0),
          reserved: Number(d.reservedQuantity?.totalReservedQuantity ?? 0),
          unfulfillable: Number(d.unfulfillableQuantity?.totalUnfulfillableQuantity ?? 0),
          snapshot_at: snapshotAt,
        });
      }
      nextToken = resp.pagination?.nextToken;
      if (nextToken) await new Promise((r) => setTimeout(r, 600));
    } while (nextToken);
  } catch (err) {
    if (err instanceof SpApiError) {
      return {
        ok: false,
        roleMissing: err.status === 403,
        error:
          err.status === 403
            ? "Amazon has not granted the Amazon Fulfillment role to this app yet (403). FBA stock stays manual until then."
            : `${err.status}: ${err.message}`,
      };
    }
    return { ok: false, roleMissing: false, error: err instanceof Error ? err.message : String(err) };
  }

  if (rows.length > 0) {
    for (let i = 0; i < rows.length; i += 500) {
      const { error } = await supabase
        .from("amazon_fba_inventory")
        .upsert(rows.slice(i, i + 500), { onConflict: "account_id,sku" });
      if (error) return { ok: false, roleMissing: false, error: error.message };
    }
    // Drop SKUs Amazon no longer reports so stale stock does not linger.
    await supabase
      .from("amazon_fba_inventory")
      .delete()
      .eq("account_id", accountId)
      .lt("snapshot_at", snapshotAt);
  }

  return { ok: true, skus: rows.length, snapshotAt };
}
