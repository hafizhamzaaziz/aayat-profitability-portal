/**
 * Pure helpers for Amazon *order* (purchase) date vs finance *posted* date.
 *
 * Seller Central "Units ordered" is PurchaseDate in the marketplace timezone.
 * SP-API Finances ShipmentEvent only has PostedDate (settlement). Inventory
 * sold qty must use the order date so Daily Sales / Overview match SC.
 *
 * Finance P&L still uses raw_row["date/time"] = PostedDate.
 */

export const PURCHASE_DATE_RAW_KEY = "purchase date";

/** Marketplace name or id → IANA timezone used by Seller Central local dates. */
const MARKETPLACE_TIMEZONES: Record<string, string> = {
  "Amazon.co.uk": "Europe/London",
  A1F83G8C2ARO7P: "Europe/London",
  "Amazon.de": "Europe/Berlin",
  A1PA6795UKMFR9: "Europe/Berlin",
  "Amazon.fr": "Europe/Paris",
  A13V1IB3VIYZZH: "Europe/Paris",
  "Amazon.it": "Europe/Rome",
  APJ6JRA9NG5V4: "Europe/Rome",
  "Amazon.es": "Europe/Madrid",
  A1RKKUPIHCS9HS: "Europe/Madrid",
  "Amazon.nl": "Europe/Amsterdam",
  A1805IZSGTT6HS: "Europe/Amsterdam",
  "Amazon.se": "Europe/Stockholm",
  A2NODRKZP88ZB9: "Europe/Stockholm",
  "Amazon.pl": "Europe/Warsaw",
  A1C3SOZRARQ6R3: "Europe/Warsaw",
  "Amazon.com.be": "Europe/Brussels",
  AMEN7PMS3EDWL: "Europe/Brussels",
  "Amazon.ie": "Europe/Dublin",
  A28R8C7NBKEWEA: "Europe/Dublin",
  "Amazon.com": "America/Los_Angeles",
  ATVPDKIKX0DER: "America/Los_Angeles",
  "Amazon.ca": "America/Los_Angeles",
  A2EUQ1WTGCTBG2: "America/Los_Angeles",
  "Amazon.com.mx": "America/Mexico_City",
  A1AM78C64UM0Y8: "America/Mexico_City",
  "Amazon.co.jp": "Asia/Tokyo",
  A1VC38T7YXB528: "Asia/Tokyo",
  "Amazon.com.au": "Australia/Sydney",
  A39IBJ37TRP1C6: "Australia/Sydney",
  "Amazon.ae": "Asia/Dubai",
  A2VIGQ35RCS4UG: "Asia/Dubai",
  "Amazon.sa": "Asia/Riyadh",
  A17E79C6D8DWNP: "Asia/Riyadh",
  "Amazon.sg": "Asia/Singapore",
  A19VAU5U5O7RUS: "Asia/Singapore",
  "Amazon.com.br": "America/Sao_Paulo",
  A2Q3Y263D00KWC: "America/Sao_Paulo",
  "Amazon.in": "Asia/Kolkata",
  A21TJRUUN4KGV: "Asia/Kolkata",
};

export type OrderDateRow = {
  type?: string | number | null;
  "order id"?: string | number | null;
  "purchase date"?: string | number | null;
  "date/time"?: string | number | null;
  marketplace?: string | number | null;
  __order_date?: string | null;
  __posted_date?: string | null;
  [key: string]: unknown;
};

function resolveTimeZone(marketplace: string | null | undefined): string | null {
  if (!marketplace) return null;
  const key = String(marketplace).trim();
  if (!key) return null;
  return MARKETPLACE_TIMEZONES[key] || MARKETPLACE_TIMEZONES[key.toLowerCase()] || null;
}

/**
 * Calendar day from an Amazon ISO timestamp.
 * With a marketplace, uses Seller Central local time; otherwise UTC (same as
 * the historical `PostedDate.slice(0, 10)` behaviour).
 */
export function calendarDateFromIso(
  iso: string | null | undefined,
  marketplace?: string | null,
): string | null {
  if (iso == null) return null;
  const trimmed = String(iso).trim();
  if (!trimmed) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return trimmed;

  const tz = resolveTimeZone(marketplace);
  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.getTime())) {
    const slice = trimmed.slice(0, 10);
    return /^\d{4}-\d{2}-\d{2}$/.test(slice) ? slice : null;
  }
  if (!tz) {
    return parsed.toISOString().slice(0, 10);
  }
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(parsed);
  const year = parts.find((p) => p.type === "year")?.value;
  const month = parts.find((p) => p.type === "month")?.value;
  const day = parts.find((p) => p.type === "day")?.value;
  if (!year || !month || !day) return parsed.toISOString().slice(0, 10);
  return `${year}-${month}-${day}`;
}

/** Posted/settlement day — UTC date of date/time, never purchase date. */
export function postedDateFromRaw(raw: Record<string, unknown> | null | undefined): string | null {
  if (!raw) return null;
  const value = raw["date/time"] ?? raw.posted_date ?? raw.PostedDate;
  return calendarDateFromIso(value == null ? null : String(value), null);
}

export function purchaseDateFromRaw(raw: Record<string, unknown> | null | undefined): string | null {
  if (!raw) return null;
  const value =
    raw[PURCHASE_DATE_RAW_KEY] ?? raw.PurchaseDate ?? raw["order date"] ?? raw.OrderDate;
  const marketplace = raw.marketplace == null ? null : String(raw.marketplace);
  return calendarDateFromIso(value == null ? null : String(value), marketplace);
}

/**
 * Purchase/order date if the finance event payload actually carries one
 * (ShipmentEvent normally does not — only PostedDate).
 */
export function extractPurchaseDateFromEvent(ev: {
  PurchaseDate?: string;
  PostedDate?: string;
  MarketplaceName?: string;
  MarketplaceId?: string;
  [key: string]: unknown;
}): string | null {
  const marketplace = String(ev.MarketplaceName || ev.MarketplaceId || "");
  const candidates = [ev.PurchaseDate, ev.purchaseDate, ev.OrderDate, ev.orderDate, ev.purchase_date, ev.order_date];
  for (const candidate of candidates) {
    const date = calendarDateFromIso(typeof candidate === "string" ? candidate : null, marketplace);
    if (date) return date;
  }
  return null;
}

/**
 * Date stored on report_transactions.transaction_date for the sales-facts cache.
 * Order lines use purchase date when known; everything else stays on posted date.
 */
export function transactionDateForSalesFact(row: OrderDateRow): string | null {
  const type = String(row.type ?? "").toLowerCase();
  if (type === "order" && row.__order_date) return row.__order_date;
  return row.__posted_date ?? null;
}

export function applyOrderDateMap<T extends OrderDateRow>(rows: T[], dateByOrderId: Map<string, string>): T[] {
  for (const row of rows) {
    if (String(row.type || "").toLowerCase() !== "order") continue;
    const orderId = String(row["order id"] || "").trim();
    if (!orderId) continue;
    const looked = dateByOrderId.get(orderId);
    if (!looked) continue;
    row.__order_date = looked;
    row[PURCHASE_DATE_RAW_KEY] = looked;
  }
  return rows;
}

export function factsRefreshRangeForRows(
  rows: OrderDateRow[],
  bucketStart: string,
  bucketEnd: string,
): { from: string; to: string } {
  let from = bucketStart;
  let to = bucketEnd;
  for (const row of rows) {
    const date = transactionDateForSalesFact(row) || row.__posted_date;
    if (!date) continue;
    if (date < from) from = date;
    if (date > to) to = date;
  }
  return { from, to };
}
