/**
 * Pull Amazon unit sales by customer PurchaseDate via the Orders API and
 * write them into `inventory_sales_facts_cache`.
 *
 * Why this exists: Finance `listFinancialEvents` is settlement-dated. Stamping
 * PurchaseDate onto those rows only moves settled history. Recent order days
 * (not yet in Finance) stay empty unless we read Orders directly.
 *
 * For the given [from, to] window this replaces Amazon rows in the cache so
 * Overview velocity is API-authoritative by order date.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { loadSpApiClient } from "../credentials";
import type { SpApiClient } from "../spapi";

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function addDaysIso(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

async function listOrderIdsForDay(
  client: SpApiClient,
  marketplaceIds: string[],
  dayIso: string
): Promise<Array<{ orderId: string; purchaseDate: string }>> {
  const createdAfter = `${dayIso}T00:00:00Z`;
  let createdBeforeMs = new Date(`${addDaysIso(dayIso, 1)}T00:00:00Z`).getTime();
  // Amazon rejects CreatedBefore later than ~now-2m.
  const safeMax = Date.now() - 3 * 60 * 1000;
  if (createdBeforeMs > safeMax) createdBeforeMs = safeMax;
  const afterMs = new Date(createdAfter).getTime();
  if (createdBeforeMs <= afterMs) return [];
  const createdBefore = new Date(createdBeforeMs).toISOString();
  const out: Array<{ orderId: string; purchaseDate: string }> = [];
  let nextToken: string | undefined;
  do {
    let attempt = 0;
    for (;;) {
      attempt += 1;
      try {
        const resp = await client.listOrders({
          marketplaceIds,
          createdAfter,
          createdBefore,
          maxResultsPerPage: 100,
          nextToken,
        });
        for (const o of resp.payload?.Orders || []) {
          const status = String(o.OrderStatus || "").toLowerCase();
          if (status === "canceled" || status === "cancelled") continue;
          const orderId = String(o.AmazonOrderId || "").trim();
          const purchaseDate = String(o.PurchaseDate || "").slice(0, 10);
          if (orderId && purchaseDate) out.push({ orderId, purchaseDate });
        }
        nextToken = resp.payload?.NextToken;
        break;
      } catch (err) {
        if (attempt >= 5) throw err;
        await sleep(Math.min(20000, 2000 * attempt * attempt));
      }
    }
    if (nextToken) await sleep(2000);
  } while (nextToken);
  return out;
}

async function sumItemsForOrder(
  client: SpApiClient,
  orderId: string
): Promise<Array<{ sku: string; qty: number }>> {
  const bySku = new Map<string, number>();
  let nextToken: string | undefined;
  do {
    let attempt = 0;
    for (;;) {
      attempt += 1;
      try {
        const resp = await client.getOrderItems(orderId, nextToken);
        for (const item of resp.payload?.OrderItems || []) {
          const sku = String(item.SellerSKU || "").trim();
          const qty = Number(item.QuantityOrdered ?? item.QuantityShipped ?? 0);
          if (!sku || !Number.isFinite(qty) || qty <= 0) continue;
          bySku.set(sku, (bySku.get(sku) || 0) + qty);
        }
        nextToken = resp.payload?.NextToken;
        break;
      } catch (err) {
        if (attempt >= 5) throw err;
        await sleep(Math.min(20000, 2000 * attempt * attempt));
      }
    }
    if (nextToken) await sleep(700);
  } while (nextToken);
  return Array.from(bySku.entries()).map(([sku, qty]) => ({ sku, qty }));
}

export type OrdersSalesSyncResult = {
  from: string;
  to: string;
  days: number;
  orders: number;
  factRows: number;
  unitsByDay: Record<string, number>;
};

export async function syncAmazonInventorySalesFromOrders(input: {
  supabase: SupabaseClient;
  accountId: string;
  from: string;
  to: string;
}): Promise<OrdersSalesSyncResult> {
  const { supabase, accountId, from, to } = input;
  if (from > to) throw new Error("from must be on or before to");

  const { client, marketplaceIds } = await loadSpApiClient(accountId);
  const mids = marketplaceIds.length > 0 ? marketplaceIds : ["A1F83G8C2ARO7P"];

  const aggregate = new Map<string, number>(); // `${saleDate}|${sku}` → qty
  const unitsByDay: Record<string, number> = {};
  let orders = 0;

  for (let day = from; day <= to; day = addDaysIso(day, 1)) {
    const dayOrders = await listOrderIdsForDay(client, mids, day);
    for (const { orderId, purchaseDate } of dayOrders) {
      orders += 1;
      const items = await sumItemsForOrder(client, orderId);
      await sleep(700);
      for (const { sku, qty } of items) {
        const key = `${purchaseDate}|${sku}`;
        aggregate.set(key, (aggregate.get(key) || 0) + qty);
        unitsByDay[purchaseDate] = (unitsByDay[purchaseDate] || 0) + qty;
      }
    }
    await sleep(1500);
  }

  // Replace Amazon facts for the window with Orders-API truth.
  const { error: delError } = await supabase
    .from("inventory_sales_facts_cache")
    .delete()
    .eq("account_id", accountId)
    .ilike("platform", "amazon%")
    .gte("sale_date", from)
    .lte("sale_date", to);
  if (delError) throw new Error(delError.message);

  const rows = Array.from(aggregate.entries()).map(([key, qty]) => {
    const [sale_date, sku] = key.split("|");
    return {
      account_id: accountId,
      platform: "amazon",
      sku,
      sale_date,
      qty,
    };
  });

  const CHUNK = 500;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    if (!chunk.length) continue;
    const { error } = await supabase.from("inventory_sales_facts_cache").insert(chunk);
    if (error) throw new Error(error.message);
  }

  try {
    const { syncAmazonDailySalesFromFacts } = await import("@/lib/inventory/sync-amazon-daily-sales");
    await syncAmazonDailySalesFromFacts(supabase, accountId, { from, to });
  } catch {
    // Daily Sales warehouse log is best-effort; Overview facts already wrote.
  }

  return {
    from,
    to,
    days: Math.round((new Date(`${to}T00:00:00Z`).getTime() - new Date(`${from}T00:00:00Z`).getTime()) / 86400000) + 1,
    orders,
    factRows: rows.length,
    unitsByDay,
  };
}
