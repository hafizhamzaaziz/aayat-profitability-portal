/**
 * Resolve Amazon PurchaseDate via Orders API and stamp it onto finance rows /
 * existing report_transactions so inventory_sales_facts_cache matches Seller
 * Central "Units ordered".
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { fetchAllRows } from "@/lib/supabase/fetch-all-rows";
import { refreshInventorySalesFacts } from "@/lib/inventory/refresh-sales-facts";
import { loadSpApiClient, updateMarketplaceIds } from "../credentials";
import type { SpApiClient } from "../spapi";
import type { CsvRow } from "./finance-mapper";
import {
  applyOrderDateMap,
  calendarDateFromIso,
  postedDateFromRaw,
  purchaseDateFromRaw,
  PURCHASE_DATE_RAW_KEY,
} from "./order-date-utils";

const ORDER_ID_BATCH = 50;

async function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export type PurchaseDateLookup = {
  dates: Map<string, string>;
  missing: string[];
};

export async function fetchPurchaseDatesByOrderId(
  client: SpApiClient,
  marketplaceIds: string[],
  orderIds: string[],
): Promise<PurchaseDateLookup> {
  const unique = [...new Set(orderIds.map((id) => id.trim()).filter(Boolean))];
  const dates = new Map<string, string>();

  async function lookupOne(orderId: string) {
    const resp = await client.getOrder(orderId);
    const date = calendarDateFromIso(resp.payload?.PurchaseDate, resp.payload?.MarketplaceId);
    if (date) dates.set(orderId, date);
  }

  for (let i = 0; i < unique.length; i += ORDER_ID_BATCH) {
    const batch = unique.slice(i, i + ORDER_ID_BATCH);
    if (marketplaceIds.length > 0) {
      try {
        const resp = await client.listOrders({
          marketplaceIds,
          amazonOrderIds: batch,
          maxResultsPerPage: 50,
        });
        for (const order of resp.payload?.Orders || []) {
          const id = String(order.AmazonOrderId || "").trim();
          const date = calendarDateFromIso(order.PurchaseDate, order.MarketplaceId);
          if (id && date) dates.set(id, date);
        }
      } catch {
        for (const id of batch) {
          if (dates.has(id)) continue;
          try {
            await lookupOne(id);
          } catch {
            // counted as missing below
          }
        }
      }
    } else {
      for (const id of batch) {
        try {
          await lookupOne(id);
        } catch {
          // counted as missing below
        }
      }
    }
    if (i + ORDER_ID_BATCH < unique.length) await sleep(600);
  }

  const missing = unique.filter((id) => !dates.has(id));
  return { dates, missing };
}

export async function stampFinanceRowsWithOrderDates(input: {
  client: SpApiClient;
  marketplaceIds: string[];
  rows: CsvRow[];
}): Promise<{ rows: CsvRow[]; lookedUp: number; missing: number }> {
  const needed = [
    ...new Set(
      input.rows
        .filter((row) => String(row.type || "").toLowerCase() === "order" && !row.__order_date)
        .map((row) => String(row["order id"] || "").trim())
        .filter(Boolean),
    ),
  ];
  if (needed.length === 0) return { rows: input.rows, lookedUp: 0, missing: 0 };

  let marketplaceIds = input.marketplaceIds;
  if (!marketplaceIds.length) {
    try {
      const parts = await input.client.getMarketplaceParticipations();
      marketplaceIds = (parts.payload || [])
        .filter((p) => p.participation?.isParticipating)
        .map((p) => p.marketplace.id);
    } catch {
      marketplaceIds = [];
    }
  }

  const { dates, missing } = await fetchPurchaseDatesByOrderId(input.client, marketplaceIds, needed);
  applyOrderDateMap(input.rows, dates);
  return { rows: input.rows, lookedUp: dates.size, missing: missing.length };
}

export type BackfillOrderDatesResult = {
  ok: true;
  accountId: string;
  scanned: number;
  uniqueOrders: number;
  updated: number;
  missing: number;
  factsRefresh: { ok: true; rows: number | null } | { ok: false; error: string };
};

/**
 * Stamp purchase dates onto existing SP-API Amazon Order txs and rebuild the
 * facts cache. Use this when finance rows are already ingested but
 * transaction_date is still the posted/settlement day (Rexo 2026-09-16: 81).
 */
export async function backfillAmazonOrderDates(input: {
  supabase: SupabaseClient;
  accountId: string;
  from?: string | null;
  to?: string | null;
}): Promise<BackfillOrderDatesResult> {
  const { supabase, accountId, from, to } = input;

  const fetched = await fetchAllRows<{
    id: string;
    transaction_date: string | null;
    raw_row: Record<string, unknown>;
  }>((fromIdx, toIdx) => {
    let query = supabase
      .from("report_transactions")
      .select("id, transaction_date, raw_row")
      .eq("account_id", accountId)
      .eq("source", "sp_api")
      .eq("platform", "amazon")
      .range(fromIdx, toIdx);
    if (from) query = query.gte("transaction_date", from);
    if (to) query = query.lte("transaction_date", to);
    return query;
  });
  if (fetched.error) throw new Error(fetched.error.message);

  const orderTxs = fetched.data.filter((tx) => String(tx.raw_row?.type || "").toLowerCase() === "order");
  const need = orderTxs.filter((tx) => !purchaseDateFromRaw(tx.raw_row));
  const orderIds = [
    ...new Set(need.map((tx) => String(tx.raw_row?.["order id"] || "").trim()).filter(Boolean)),
  ];
  if (orderIds.length === 0) {
    return {
      ok: true,
      accountId,
      scanned: orderTxs.length,
      uniqueOrders: 0,
      updated: 0,
      missing: 0,
      factsRefresh: { ok: true, rows: null },
    };
  }

  const { client, marketplaceIds } = await loadSpApiClient(accountId);
  let mids = marketplaceIds;
  if (!mids.length) {
    const parts = await client.getMarketplaceParticipations();
    mids = (parts.payload || [])
      .filter((p) => p.participation?.isParticipating)
      .map((p) => p.marketplace.id);
    if (mids.length) await updateMarketplaceIds(accountId, mids);
  }

  const { dates, missing } = await fetchPurchaseDatesByOrderId(client, mids, orderIds);

  let updated = 0;
  const saleDates: string[] = [];
  const UPDATE_CHUNK = 40;
  for (let i = 0; i < need.length; i += UPDATE_CHUNK) {
    const chunk = need.slice(i, i + UPDATE_CHUNK);
    await Promise.all(
      chunk.map(async (tx) => {
        const orderId = String(tx.raw_row?.["order id"] || "").trim();
        const orderDate = dates.get(orderId);
        if (!orderDate) return;
        const nextRaw = { ...tx.raw_row, [PURCHASE_DATE_RAW_KEY]: orderDate };
        const { error } = await supabase
          .from("report_transactions")
          .update({ transaction_date: orderDate, raw_row: nextRaw })
          .eq("id", tx.id);
        if (error) throw new Error(error.message);
        updated += 1;
        saleDates.push(orderDate);
        const posted = postedDateFromRaw(tx.raw_row);
        if (posted) saleDates.push(posted);
        const previous = String(tx.transaction_date || "").slice(0, 10);
        if (previous) saleDates.push(previous);
      }),
    );
  }

  const refreshFrom = saleDates.length ? saleDates.reduce((a, b) => (a < b ? a : b)) : from || undefined;
  const refreshTo = saleDates.length ? saleDates.reduce((a, b) => (a > b ? a : b)) : to || undefined;
  if (refreshFrom && refreshTo) {
    await refreshInventorySalesFacts(supabase, accountId, { from: refreshFrom, to: refreshTo });
  }
  const full = await refreshInventorySalesFacts(supabase, accountId);

  return {
    ok: true,
    accountId,
    scanned: orderTxs.length,
    uniqueOrders: orderIds.length,
    updated,
    missing: missing.length,
    factsRefresh: full.ok ? { ok: true, rows: full.rows } : { ok: false, error: full.error },
  };
}
