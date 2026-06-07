import type { TiktokShopClient, TiktokRawOrder } from "./client";

/**
 * Maps TikTok Shop API orders into the SAME row shape as the "All orders"
 * Excel export, so the existing `tiktok-pnl` engine (and the report workbench's
 * `processTikTok`) consume them unchanged.
 *
 * Each emitted row is one (order × seller-SKU) line, keyed by the export's
 * column headers. The engine groups by Order ID, counts Order Amount once per
 * order, and computes commission/VAT from there.
 *
 * KEY MAPPING NOTES (validate against a live response once the app is approved):
 *   - TikTok `line_items` are PER-UNIT (one entry per unit). We aggregate them
 *     by seller_sku (falling back to sku_id) → Quantity = unit count,
 *     SKU Subtotal After Discount = Σ sale_price.
 *   - `payment.total_amount` is the order-level "Order Amount" (incl VAT),
 *     repeated on every line of the order (engine takes it once).
 *   - Refunds/returns are NOT in the orders endpoint; they come from the
 *     Returns/Reverse API. Until that's wired, "Order Refund Amount" and
 *     "Sku Quantity of return" are 0. (Account totals will therefore ignore
 *     refunds until then — flagged to the user.)
 *   - We drop UNPAID orders (never real sales); CANCELLED orders are kept in
 *     the rows so the engine can report/exclude them exactly like the export.
 */

export const TIKTOK_EXPORT_HEADERS = [
  "Order ID",
  "Order Status",
  "SKU ID",
  "Seller SKU",
  "Product Name",
  "Variation",
  "Quantity",
  "Sku Quantity of return",
  "SKU Subtotal After Discount",
  "Order Amount",
  "Order Refund Amount",
  "Created Time",
] as const;

export type TiktokOrderRow = Record<(typeof TIKTOK_EXPORT_HEADERS)[number], string | number>;

const DROP_STATUSES = new Set(["UNPAID"]);

function toNum(value: string | undefined): number {
  if (!value) return 0;
  const n = Number.parseFloat(String(value).replace(/[^0-9.\-]/g, ""));
  return Number.isFinite(n) ? n : 0;
}

function statusLabel(raw: string): string {
  const s = (raw || "").toUpperCase();
  if (s === "CANCELLED" || s === "CANCELED") return "Cancelled";
  if (s === "COMPLETED" || s === "DELIVERED") return "Completed";
  return "Shipped";
}

/** Build the normalized rows for a single order. */
function mapOrderToRows(order: TiktokRawOrder): TiktokOrderRow[] {
  const lineItems = order.line_items || [];
  if (lineItems.length === 0) return [];

  // Aggregate per-unit line items by seller SKU (fallback to TikTok SKU ID).
  type Agg = {
    sellerSku: string;
    skuId: string;
    productName: string;
    variation: string;
    qty: number;
    subtotal: number;
  };
  const groups = new Map<string, Agg>();
  for (const li of lineItems) {
    const sellerSku = (li.seller_sku || "").trim();
    const skuId = (li.sku_id || "").trim();
    const key = (sellerSku || skuId || li.id).toLowerCase();
    const existing = groups.get(key);
    const salePrice = toNum(li.sale_price);
    if (existing) {
      existing.qty += 1;
      existing.subtotal += salePrice;
    } else {
      groups.set(key, {
        sellerSku,
        skuId,
        productName: (li.product_name || "").trim(),
        variation: (li.sku_name || "").trim(),
        qty: 1,
        subtotal: salePrice,
      });
    }
  }

  const orderAmount = toNum(order.payment?.total_amount);
  const createdIso = new Date(order.create_time * 1000).toISOString();
  const status = statusLabel(order.status);

  const rows: TiktokOrderRow[] = [];
  for (const g of groups.values()) {
    rows.push({
      "Order ID": order.id,
      "Order Status": status,
      "SKU ID": g.skuId,
      "Seller SKU": g.sellerSku,
      "Product Name": g.productName,
      Variation: g.variation,
      Quantity: g.qty,
      "Sku Quantity of return": 0,
      "SKU Subtotal After Discount": Number(g.subtotal.toFixed(2)),
      "Order Amount": Number(orderAmount.toFixed(2)),
      "Order Refund Amount": 0,
      "Created Time": createdIso,
    });
  }
  return rows;
}

/**
 * Pull all orders created within [fromIso, toIso) and return engine-ready rows.
 * Paginates through the TikTok orders search until exhausted.
 */
export async function fetchTiktokOrderRows(
  client: TiktokShopClient,
  fromIso: string,
  toIso: string,
  opts: { maxPages?: number } = {}
): Promise<{ rows: TiktokOrderRow[]; orderCount: number; pages: number }> {
  const createTimeGe = Math.floor(new Date(fromIso).getTime() / 1000);
  const createTimeLt = Math.floor(new Date(toIso).getTime() / 1000);
  if (!Number.isFinite(createTimeGe) || !Number.isFinite(createTimeLt) || createTimeGe >= createTimeLt) {
    throw new Error("Invalid date range for TikTok order sync.");
  }

  const maxPages = opts.maxPages ?? 200;
  const rows: TiktokOrderRow[] = [];
  let pageToken: string | undefined;
  let pages = 0;
  let orderCount = 0;

  do {
    const { orders, nextPageToken } = await client.searchOrders({
      createTimeGe,
      createTimeLt,
      pageSize: 100,
      pageToken,
    });
    for (const order of orders) {
      if (DROP_STATUSES.has((order.status || "").toUpperCase())) continue;
      const orderRows = mapOrderToRows(order);
      if (orderRows.length) {
        orderCount += 1;
        rows.push(...orderRows);
      }
    }
    pageToken = nextPageToken || undefined;
    pages += 1;
  } while (pageToken && pages < maxPages);

  return { rows, orderCount, pages };
}
