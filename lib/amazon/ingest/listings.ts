import { gunzipSync } from "node:zlib";
import type { SupabaseClient } from "@supabase/supabase-js";
import { loadSpApiClient } from "@/lib/amazon/credentials";
import { SpApiError, type SpApiClient } from "@/lib/amazon/spapi";
import { normalizeProductName } from "@/lib/cogs/apply-cogs-version";

/**
 * Amazon listings catalog — every seller SKU / ASIN the account has listed,
 * straight from the SP-API "All Listings" report (GET_MERCHANT_LISTINGS_ALL_DATA).
 *
 * Works with the roles the app already has (Inventory and Order Tracking or
 * Pricing). One report per marketplace; the home marketplace goes first so the
 * UK catalog is always refreshed even if EU marketplaces time out.
 *
 * After storing the raw rows we make sure every seller SKU has a
 * `sku_mappings` row (creating a product in `sku_catalog` named after the
 * listing title when needed) and fill in `amazon_asin` / `amazon_title`.
 * COGS are never invented — the COGS page shows these SKUs as "cost missing".
 */

export type ListingRow = {
  marketplaceId: string;
  sellerSku: string;
  asin: string | null;
  listingId: string | null;
  title: string | null;
  price: number | null;
  quantity: number | null;
  fulfillmentChannel: "fba" | "fbm";
  status: string | null;
  condition: string | null;
  openDate: string | null;
  imageUrl: string | null;
};

export type ListingsSyncResult = {
  ok: boolean;
  marketplaces: Array<{ marketplaceId: string; ok: boolean; rows: number; error?: string }>;
  listings: number;
  distinctSkus: number;
  newMappings: number;
  updatedMappings: number;
  warnings: string[];
};

const HOME_MARKETPLACES = ["A1F83G8C2ARO7P", "ATVPDKIKX0DER"]; // UK, US first

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function num(v: string | undefined): number | null {
  if (v == null || v.trim() === "") return null;
  const n = Number(v.replace(/[^\d.,-]/g, "").replace(",", "."));
  return Number.isFinite(n) ? n : null;
}

/** Amazon dates arrive like "08/03/2024 10:58:26 MET" or "2024-03-08 10:58:26 GMT". */
function parseOpenDate(v: string | undefined): string | null {
  if (!v) return null;
  const iso = v.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const dmy = v.match(/^(\d{2})\/(\d{2})\/(\d{4})/);
  if (dmy) return `${dmy[3]}-${dmy[2]}-${dmy[1]}`;
  return null;
}

function parseTsv(text: string): Array<Record<string, string>> {
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/).filter((l) => l.length > 0);
  if (lines.length < 2) return [];
  const header = lines[0].split("\t").map((h) => h.trim().toLowerCase());
  return lines.slice(1).map((line) => {
    const cells = line.split("\t");
    const row: Record<string, string> = {};
    header.forEach((h, i) => {
      row[h] = (cells[i] ?? "").trim();
    });
    return row;
  });
}

function pick(row: Record<string, string>, ...keys: string[]) {
  for (const k of keys) {
    const v = row[k];
    if (v != null && v !== "") return v;
  }
  return undefined;
}

function toListing(marketplaceId: string, row: Record<string, string>): ListingRow | null {
  const sellerSku = pick(row, "seller-sku", "sku");
  if (!sellerSku) return null;
  const productIdType = pick(row, "product-id-type");
  const productId = pick(row, "product-id");
  const asin = pick(row, "asin1", "asin") || (productIdType === "1" && productId ? productId : null) || (productId && /^B0[A-Z0-9]{8}$/i.test(productId) ? productId : null);
  const channelRaw = (pick(row, "fulfillment-channel", "fulfilment-channel") || "DEFAULT").toUpperCase();
  return {
    marketplaceId,
    sellerSku,
    asin: asin ? asin.toUpperCase() : null,
    listingId: pick(row, "listing-id") || null,
    title: pick(row, "item-name", "title") || null,
    price: num(pick(row, "price")),
    quantity: num(pick(row, "quantity")) == null ? null : Math.round(num(pick(row, "quantity"))!),
    fulfillmentChannel: channelRaw.startsWith("AMAZON") ? "fba" : "fbm",
    status: pick(row, "status") || null,
    condition: pick(row, "item-condition") || null,
    openDate: parseOpenDate(pick(row, "open-date")),
    imageUrl: pick(row, "image-url") || null,
  };
}

async function fetchListingsReport(client: SpApiClient, marketplaceId: string): Promise<ListingRow[]> {
  const created = await client.createReport({
    reportType: "GET_MERCHANT_LISTINGS_ALL_DATA",
    marketplaceIds: [marketplaceId],
  });
  let documentId = "";
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await sleep(attempt === 0 ? 4000 : 6000);
    const status = await client.getReport(created.reportId);
    if (status.processingStatus === "DONE" && status.reportDocumentId) {
      documentId = status.reportDocumentId;
      break;
    }
    if (status.processingStatus === "FATAL" || status.processingStatus === "CANCELLED") {
      throw new Error(`Listings report ${status.processingStatus}`);
    }
  }
  if (!documentId) throw new Error("Listings report timed out");
  const doc = await client.getReportDocument(documentId);
  const response = await fetch(doc.url);
  if (!response.ok) throw new Error(`Could not download listings report (${response.status})`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const raw = doc.compressionAlgorithm === "GZIP" ? gunzipSync(bytes) : bytes;
  return parseTsv(raw.toString("utf8"))
    .map((row) => toListing(marketplaceId, row))
    .filter((r): r is ListingRow => !!r);
}

/**
 * Pull the listings catalog for every marketplace on the connection (or the
 * subset given), store it, and make sure each SKU has a mapping row.
 */
export async function syncAmazonListings(input: {
  supabase: SupabaseClient;
  accountId: string;
  marketplaceIds?: string[];
  /** Stop requesting further marketplaces after this many ms (function budget). */
  budgetMs?: number;
}): Promise<ListingsSyncResult> {
  const startedAt = Date.now();
  const budget = input.budgetMs ?? 200_000;
  const { supabase, accountId } = input;
  const warnings: string[] = [];
  const { client, marketplaceIds: connected } = await loadSpApiClient(accountId);

  const wanted = (input.marketplaceIds?.length ? input.marketplaceIds : connected).filter(Boolean);

  // Home marketplaces first, then the stalest ones, so a run that hits the
  // time budget still rotates through every marketplace over a few runs.
  const { data: staleness } = await supabase.from("amazon_listings").select("marketplace_id, synced_at").eq("account_id", accountId);
  const lastSynced = new Map<string, string>();
  for (const r of staleness || []) {
    const prev = lastSynced.get(String(r.marketplace_id));
    if (!prev || String(r.synced_at) > prev) lastSynced.set(String(r.marketplace_id), String(r.synced_at));
  }
  const freshCutoff = new Date(Date.now() - 20 * 60 * 60 * 1000).toISOString();
  const homeIsStale = (id: string) => HOME_MARKETPLACES.includes(id) && (lastSynced.get(id) || "") < freshCutoff;
  const ordered = [...wanted].sort((a, b) => {
    const homeDiff = Number(homeIsStale(b)) - Number(homeIsStale(a));
    if (homeDiff !== 0) return homeDiff;
    return (lastSynced.get(a) || "").localeCompare(lastSynced.get(b) || "");
  });

  const marketplaces: ListingsSyncResult["marketplaces"] = [];
  const all: ListingRow[] = [];
  let complete = true;
  for (const marketplaceId of ordered) {
    if (Date.now() - startedAt > budget) {
      complete = false;
      warnings.push(`Stopped before ${marketplaceId}: time budget reached. Remaining marketplaces refresh on the next run.`);
      break;
    }
    try {
      const rows = await fetchListingsReport(client, marketplaceId);
      all.push(...rows);
      marketplaces.push({ marketplaceId, ok: true, rows: rows.length });
    } catch (err) {
      const message = err instanceof SpApiError ? `SP-API ${err.status}: ${err.message}` : err instanceof Error ? err.message : String(err);
      marketplaces.push({ marketplaceId, ok: false, rows: 0, error: message });
      if (err instanceof SpApiError && err.status === 403) {
        warnings.push("Amazon refused the listings report (403). The app needs the Inventory and Order Tracking or Pricing role.");
        break;
      }
      if (err instanceof SpApiError && err.status === 429) {
        complete = false;
        warnings.push("Amazon rate-limited report requests; remaining marketplaces refresh on the next run.");
        break;
      }
    }
  }

  // ---- Store raw listings (replace per marketplace that succeeded) ----
  const okMarketplaces = marketplaces.filter((m) => m.ok).map((m) => m.marketplaceId);
  const syncedAt = new Date().toISOString();
  if (okMarketplaces.length > 0) {
    const rows = all.map((r) => ({
      account_id: accountId,
      marketplace_id: r.marketplaceId,
      seller_sku: r.sellerSku,
      asin: r.asin,
      listing_id: r.listingId,
      title: r.title,
      price: r.price,
      quantity: r.quantity,
      fulfillment_channel: r.fulfillmentChannel,
      status: r.status,
      condition: r.condition,
      open_date: r.openDate,
      image_url: r.imageUrl,
      synced_at: syncedAt,
    }));
    for (let i = 0; i < rows.length; i += 500) {
      const { error } = await supabase.from("amazon_listings").upsert(rows.slice(i, i + 500), { onConflict: "account_id,marketplace_id,seller_sku" });
      if (error) throw new Error(`Could not store listings: ${error.message}`);
    }
    // Listings that disappeared from a refreshed marketplace.
    const { error: delError } = await supabase
      .from("amazon_listings")
      .delete()
      .eq("account_id", accountId)
      .in("marketplace_id", okMarketplaces)
      .lt("synced_at", syncedAt);
    if (delError) warnings.push(`Could not prune removed listings: ${delError.message}`);
  }

  // ---- Ensure every SKU has a mapping (never invents a cost) ----
  const bySku = new Map<string, ListingRow>();
  const activeSkus = new Set<string>();
  for (const r of all) {
    const key = r.sellerSku.trim().toUpperCase();
    if (r.status === "Active") activeSkus.add(key);
    const prev = bySku.get(key);
    // Prefer the home marketplace / active listing as the representative row.
    const better = !prev || (HOME_MARKETPLACES.includes(r.marketplaceId) && !HOME_MARKETPLACES.includes(prev.marketplaceId)) || (prev.status !== "Active" && r.status === "Active");
    if (better) bySku.set(key, r);
  }

  let newMappings = 0;
  let updatedMappings = 0;
  if (bySku.size > 0) {
    const { data: mappings, error: mapError } = await supabase
      .from("sku_mappings")
      .select("id, amazon_sku, amazon_asin, amazon_title, sku_catalog_id")
      .eq("account_id", accountId)
      .not("amazon_sku", "is", null);
    if (mapError) throw new Error(`Could not read SKU mappings: ${mapError.message}`);
    const mappingBySku = new Map((mappings || []).map((m) => [String(m.amazon_sku).trim().toUpperCase(), m]));

    const { data: catalog, error: catError } = await supabase.from("sku_catalog").select("id, product_name").eq("account_id", accountId);
    if (catError) throw new Error(`Could not read product catalog: ${catError.message}`);
    const catalogByName = new Map((catalog || []).map((c) => [normalizeProductName(c.product_name).toLowerCase(), String(c.id)]));

    for (const [key, listing] of bySku) {
      const existing = mappingBySku.get(key);
      if (existing) {
        const patch: Record<string, unknown> = {};
        if (!existing.amazon_asin && listing.asin) patch.amazon_asin = listing.asin;
        if (listing.title && listing.title !== existing.amazon_title) patch.amazon_title = listing.title;
        if (Object.keys(patch).length > 0) {
          patch.updated_at = new Date().toISOString();
          const { error } = await supabase.from("sku_mappings").update(patch).eq("id", existing.id);
          if (!error) updatedMappings += 1;
        }
        continue;
      }

      // New SKU: find or create the product by listing title (fallback: the SKU itself).
      const productName = normalizeProductName(listing.title || listing.sellerSku).slice(0, 200) || listing.sellerSku;
      let catalogId = catalogByName.get(productName.toLowerCase());
      if (!catalogId) {
        const { data: created, error } = await supabase
          .from("sku_catalog")
          .insert({ account_id: accountId, product_name: productName })
          .select("id")
          .single();
        if (error || !created) {
          warnings.push(`Could not create product for ${listing.sellerSku}: ${error?.message || "unknown"}`);
          continue;
        }
        catalogId = String(created.id);
        catalogByName.set(productName.toLowerCase(), catalogId);
      }
      const { error: insError } = await supabase.from("sku_mappings").insert({
        account_id: accountId,
        sku_catalog_id: catalogId,
        amazon_sku: listing.sellerSku,
        amazon_asin: listing.asin,
        amazon_title: listing.title,
        source: "amazon_listings",
        // Inactive / incomplete listings stay out of the inventory planner
        // until someone switches them on under Inventory → Settings → SKU planning.
        is_planned: activeSkus.has(key),
      });
      if (insError) {
        warnings.push(`Could not map ${listing.sellerSku}: ${insError.message}`);
        continue;
      }
      newMappings += 1;
    }
  }

  const anyOk = okMarketplaces.length > 0;
  // Only stamp the account-level watermark once every marketplace was
  // attempted; a budget-cut run leaves it alone so the next run continues.
  const patch: Record<string, unknown> = {
    listings_sync_error: anyOk ? null : marketplaces.find((m) => m.error)?.error || "No marketplace could be refreshed.",
  };
  if (anyOk && complete) patch.listings_synced_at = syncedAt;
  await supabase
    .from("account_amazon_credentials")
    .update(patch)
    .eq("account_id", accountId)
    .eq("provider", "sp-api");

  return {
    ok: anyOk,
    marketplaces,
    listings: all.length,
    distinctSkus: bySku.size,
    newMappings,
    updatedMappings,
    warnings,
  };
}
