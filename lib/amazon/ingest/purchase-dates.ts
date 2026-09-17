/**
 * Stamp Amazon Order PurchaseDate onto Finance-mapped transaction rows.
 *
 * Finance `listFinancialEvents` only returns PostedDate (settlement). Inventory
 * velocity / Daily Sales need the customer order date. We look PurchaseDate up
 * via the Orders API and write it onto each Order row as `purchase date`
 * (YYYY-MM-DD). P&L continues to use PostedDate / transaction_date.
 */

import type { SpApiClient } from "../spapi";
import type { CsvRow } from "./finance-mapper";

const ORDER_ID_BATCH = 50;
const BATCH_PAUSE_MS = 2500;

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function toDateOnly(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const m = String(iso).match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : null;
}

function orderIdFromRow(row: CsvRow): string | null {
  const id = String(row["order id"] || "").trim();
  return id || null;
}

function isOrderRow(row: CsvRow): boolean {
  return String(row.type || "")
    .trim()
    .toLowerCase() === "order";
}

/**
 * Fetch PurchaseDate for a set of Amazon order IDs (batched, throttled).
 * Returns a map of orderId → YYYY-MM-DD.
 */
export async function fetchPurchaseDatesByOrderId(input: {
  client: SpApiClient;
  marketplaceIds: string[];
  orderIds: string[];
}): Promise<Map<string, string>> {
  const { client, marketplaceIds, orderIds } = input;
  const unique = Array.from(new Set(orderIds.map((id) => id.trim()).filter(Boolean)));
  const out = new Map<string, string>();
  if (unique.length === 0) return out;

  const marketplaces =
    marketplaceIds.length > 0 ? marketplaceIds : ["A1F83G8C2ARO7P"]; // UK fallback

  for (let i = 0; i < unique.length; i += ORDER_ID_BATCH) {
    const batch = unique.slice(i, i + ORDER_ID_BATCH);
    let attempt = 0;
    for (;;) {
      attempt += 1;
      try {
        const resp = await client.getOrdersByIds({
          marketplaceIds: marketplaces,
          amazonOrderIds: batch,
        });
        for (const order of resp.payload?.Orders || []) {
          const id = String(order.AmazonOrderId || "").trim();
          const purchase = toDateOnly(order.PurchaseDate);
          if (id && purchase) out.set(id, purchase);
        }
        break;
      } catch (err) {
        if (attempt >= 4) throw err;
        await sleep(Math.min(15000, 2000 * attempt * attempt));
      }
    }
    if (i + ORDER_ID_BATCH < unique.length) await sleep(BATCH_PAUSE_MS);
  }

  return out;
}

/**
 * Mutates Order rows in place: sets `purchase date` when Orders API returns it.
 */
export async function stampPurchaseDatesOnRows(input: {
  client: SpApiClient;
  marketplaceIds: string[];
  rows: CsvRow[];
}): Promise<{ orderRows: number; uniqueOrders: number; stamped: number; missing: number }> {
  const { client, marketplaceIds, rows } = input;
  const orderRows = rows.filter(isOrderRow);
  const orderIds = orderRows.map(orderIdFromRow).filter((id): id is string => Boolean(id));
  const uniqueOrders = new Set(orderIds).size;
  if (uniqueOrders === 0) {
    return { orderRows: orderRows.length, uniqueOrders: 0, stamped: 0, missing: 0 };
  }

  const dates = await fetchPurchaseDatesByOrderId({ client, marketplaceIds, orderIds });
  let stamped = 0;
  let missing = 0;
  for (const row of orderRows) {
    const id = orderIdFromRow(row);
    if (!id) {
      missing += 1;
      continue;
    }
    const purchase = dates.get(id);
    if (!purchase) {
      missing += 1;
      continue;
    }
    row["purchase date"] = purchase;
    stamped += 1;
  }

  return { orderRows: orderRows.length, uniqueOrders, stamped, missing };
}
