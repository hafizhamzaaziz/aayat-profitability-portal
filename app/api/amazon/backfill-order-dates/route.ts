import { NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { loadSpApiClient } from "@/lib/amazon/credentials";
import { fetchPurchaseDatesByOrderId } from "@/lib/amazon/ingest/purchase-dates";
import { syncAmazonInventorySalesFromOrders } from "@/lib/amazon/ingest/orders-sales";
import { SpApiError } from "@/lib/amazon/spapi";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

type Body = {
  accountId?: string;
  from?: string;
  to?: string;
  /** stamp = Finance purchase-date only; orders = Orders API facts; both = default */
  mode?: "stamp" | "orders" | "both";
};

function toIsoDate(value: unknown): string | null {
  if (typeof value !== "string") return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  return value;
}

/**
 * POST /api/amazon/backfill-order-dates
 *
 * Makes Amazon Inventory velocity API-authoritative by customer order date:
 *   1. Stamp `purchase date` onto existing SP-API Finance Order rows (settled history).
 *   2. Refresh inventory_sales_facts_cache (Temu + Amazon-from-Finance with purchase date).
 *   3. Overlay Orders API unit sales for [from, to] (fills recent unsettled days).
 *
 * Auth: admin/team portal session (same as /api/amazon/sync).
 */
export async function POST(request: NextRequest) {
  const userClient = createClient();
  const {
    data: { user },
  } = await userClient.auth.getUser();
  if (!user) return Response.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  const { data: userRow } = await userClient.from("users").select("role").eq("id", user.id).single();
  const role = String(userRow?.role || "client");
  if (role !== "admin" && role !== "team") {
    return Response.json({ ok: false, error: "Forbidden" }, { status: 403 });
  }

  let body: Body;
  try {
    body = (await request.json()) as Body;
  } catch {
    return Response.json({ ok: false, error: "Invalid JSON body" }, { status: 400 });
  }
  const accountId = String(body.accountId || "").trim();
  if (!accountId) return Response.json({ ok: false, error: "Missing accountId" }, { status: 400 });
  const from = toIsoDate(body.from);
  const to = toIsoDate(body.to);
  if (from && to && from > to) {
    return Response.json({ ok: false, error: "from must be on or before to" }, { status: 400 });
  }
  const mode = body.mode === "stamp" || body.mode === "orders" ? body.mode : "both";

  const admin = createAdminClient();

  try {
    const result: Record<string, unknown> = {
      ok: true,
      accountId,
      mode,
      range: { from: from || null, to: to || null },
    };

    if (mode === "stamp" || mode === "both") {
      let query = admin
        .from("report_transactions")
        .select("id, raw_row")
        .eq("account_id", accountId)
        .eq("source", "sp_api")
        .eq("platform", "amazon");
      if (from) query = query.gte("transaction_date", from);
      if (to) query = query.lte("transaction_date", to);
      const { data: rows, error } = await query.limit(50000);
      if (error) throw new Error(error.message);

      const orderRows = (rows || []).filter((r) => {
        const raw = (r.raw_row || {}) as Record<string, unknown>;
        return String(raw.type || "")
          .trim()
          .toLowerCase() === "order";
      });
      const orderIds = orderRows
        .map((r) => String(((r.raw_row || {}) as Record<string, unknown>)["order id"] || "").trim())
        .filter(Boolean);

      const { client, marketplaceIds } = await loadSpApiClient(accountId);
      const dates = await fetchPurchaseDatesByOrderId({ client, marketplaceIds, orderIds });

      let stamped = 0;
      let alreadyHad = 0;
      let missing = 0;
      const updates: Array<{ id: string; raw_row: Record<string, unknown> }> = [];
      for (const row of orderRows) {
        const raw = { ...((row.raw_row || {}) as Record<string, unknown>) };
        const orderId = String(raw["order id"] || "").trim();
        const existing = String(raw["purchase date"] || "").slice(0, 10);
        if (/^\d{4}-\d{2}-\d{2}$/.test(existing)) {
          alreadyHad += 1;
          continue;
        }
        const purchase = orderId ? dates.get(orderId) : null;
        if (!purchase) {
          missing += 1;
          continue;
        }
        raw["purchase date"] = purchase;
        updates.push({ id: String(row.id), raw_row: raw });
        stamped += 1;
      }
      for (let i = 0; i < updates.length; i += 100) {
        const chunk = updates.slice(i, i + 100);
        await Promise.all(
          chunk.map((u) => admin.from("report_transactions").update({ raw_row: u.raw_row }).eq("id", u.id))
        );
      }

      const { data: refreshed, error: refreshError } = await admin.rpc("refresh_inventory_sales_facts", {
        p_account_id: accountId,
      });
      if (refreshError) throw new Error(`Facts refresh failed: ${refreshError.message}`);

      result.stamp = {
        orderRows: orderRows.length,
        uniqueOrders: new Set(orderIds).size,
        stamped,
        alreadyHad,
        missing,
        factsRows: refreshed,
      };
    }

    if ((mode === "orders" || mode === "both") && from && to) {
      const spanDays =
        Math.round(
          (new Date(`${to}T00:00:00Z`).getTime() - new Date(`${from}T00:00:00Z`).getTime()) / 86400000
        ) + 1;
      if (spanDays > 7) {
        return Response.json(
          {
            ok: false,
            error: `Orders sync window too large (${spanDays} days). Call mode=orders with at most 7 days per request.`,
            partial: result,
          },
          { status: 400 }
        );
      }
      const ordersSync = await syncAmazonInventorySalesFromOrders({
        supabase: admin,
        accountId,
        from,
        to,
      });
      result.orders = ordersSync;
    }

    const checkDate = to || new Date().toISOString().slice(0, 10);
    const { data: dayFacts } = await admin
      .from("inventory_sales_facts_cache")
      .select("qty, platform")
      .eq("account_id", accountId)
      .eq("sale_date", checkDate);
    const amazonQtyOnCheckDate = (dayFacts || [])
      .filter((r) => String(r.platform || "").toLowerCase().startsWith("amazon"))
      .reduce((acc, r) => acc + Number(r.qty || 0), 0);
    result.checkDate = checkDate;
    result.amazonQtyOnCheckDate = amazonQtyOnCheckDate;

    return Response.json(result);
  } catch (err) {
    const message =
      err instanceof SpApiError
        ? `${err.status}: ${err.message}`
        : err instanceof Error
          ? err.message
          : String(err);
    return Response.json({ ok: false, error: message }, { status: 502 });
  }
}
