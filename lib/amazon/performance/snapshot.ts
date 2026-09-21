import type { SupabaseClient } from "@supabase/supabase-js";
import { fetchAllRows } from "@/lib/supabase/fetch-all";
import { loadSpApiClient } from "@/lib/amazon/credentials";
import { lastCompletedWeekMondayIsoUtc, addDays } from "@/lib/utils/date";

/**
 * Weekly parent-ASIN performance snapshot.
 *
 * SP-API Catalog Items can supply title, parent ASIN, and sometimes BSR.
 * Review count and star rating are not in SP-API — those stay null and the
 * UI documents Keepa (or similar) as the fill if Ops needs them.
 */
export async function snapshotAmazonPerformance(
  supabase: SupabaseClient,
  accountId: string
): Promise<{ ok: boolean; weekStart: string; upserted: number; catalogLookup: number; warnings: string[] }> {
  const weekStart = lastCompletedWeekMondayIsoUtc();
  const weekEnd = addDays(weekStart, 6);
  const warnings: string[] = [
    "SP-API Catalog Items does not return review count or star rating. Use Keepa (or similar) if those columns must be filled automatically.",
  ];

  const { data: mappingRows } = await fetchAllRows<{
    id: string;
    amazon_sku: string | null;
    parent_asin: string | null;
    amazon_asin: string | null;
    sku_catalog: unknown;
  }>((from, to) =>
    supabase
      .from("sku_mappings")
      .select("id, amazon_sku, parent_asin, amazon_asin, sku_catalog:sku_catalog_id(product_name)")
      .eq("account_id", accountId)
      .not("amazon_sku", "is", null)
      .order("id", { ascending: true })
      .range(from, to)
  );

  const { data: factRows } = await fetchAllRows<{ sku: string | null; qty: number | string | null }>((from, to) =>
    supabase
      .from("inventory_sales_facts_cache")
      .select("sku, qty")
      .eq("account_id", accountId)
      .ilike("platform", "amazon%")
      .gte("sale_date", weekStart)
      .lte("sale_date", weekEnd)
      .order("sku", { ascending: true })
      .range(from, to)
  );

  const unitsBySku = new Map<string, number>();
  for (const row of factRows || []) {
    const sku = String(row.sku || "").trim().toUpperCase();
    if (!sku) continue;
    unitsBySku.set(sku, (unitsBySku.get(sku) || 0) + Number(row.qty || 0));
  }

  const { data: monthReports } = await supabase
    .from("reports")
    .select("id, period_start, period_end, gross_sales, breakdown")
    .eq("account_id", accountId)
    .eq("platform", "amazon")
    .lte("period_start", weekEnd)
    .gte("period_end", weekStart)
    .eq("source", "sp_api");
  const overlappingIds = (monthReports || []).map((r) => String(r.id));
  const adsBySku = new Map<string, number>();
  if (overlappingIds.length > 0) {
    const { data: adRows } = await fetchAllRows<{ sku: string | null; spend_exvat: number }>((from, to) =>
      supabase
        .from("report_ad_spend")
        .select("sku, spend_exvat")
        .in("report_id", overlappingIds)
        .order("sku", { ascending: true })
        .range(from, to)
    );
    const weekDays = 7;
    const reportDays = Math.max(
      1,
      ...(monthReports || []).map((r) => {
        const a = Date.parse(`${r.period_start}T00:00:00Z`);
        const b = Date.parse(`${r.period_end}T00:00:00Z`);
        return Math.round((b - a) / 86400000) + 1;
      })
    );
    const adsScale = weekDays / reportDays;
    for (const row of adRows || []) {
      const sku = String(row.sku || "").trim().toUpperCase();
      if (!sku) continue;
      adsBySku.set(sku, (adsBySku.get(sku) || 0) + Number(row.spend_exvat || 0) * adsScale);
    }
  }

  type ParentAgg = {
    name: string;
    parent: string;
    units: number;
    ads: number;
    childSkus: string[];
    mappingIds: string[];
    bsr: number | null;
  };
  const byParent = new Map<string, ParentAgg>();
  for (const row of mappingRows || []) {
    const sku = String(row.amazon_sku || "").trim().toUpperCase();
    if (!sku) continue;
    const catalog = row.sku_catalog as { product_name?: string } | { product_name?: string }[] | null;
    const name = Array.isArray(catalog)
      ? String(catalog[0]?.product_name || sku)
      : String(catalog?.product_name || sku);
    const parent = String(row.parent_asin || row.amazon_asin || sku).trim().toUpperCase();
    const cur = byParent.get(parent) || { name, parent, units: 0, ads: 0, childSkus: [], mappingIds: [], bsr: null };
    cur.units += unitsBySku.get(sku) || 0;
    cur.ads += adsBySku.get(sku) || 0;
    cur.childSkus.push(sku);
    if (row.id) cur.mappingIds.push(String(row.id));
    if (!cur.name || cur.name === parent) cur.name = name;
    byParent.set(parent, cur);
  }

  let catalogLookup = 0;
  try {
    const { client, marketplaceIds } = await loadSpApiClient(accountId);
    const marketplaceId = marketplaceIds[0];
    if (marketplaceId) {
      const remaps: Array<{ from: string; to: string; name?: string; bsr?: number }> = [];
      for (const agg of byParent.values()) {
        if (!/^[A-Z0-9]{10}$/.test(agg.parent)) continue;
        try {
          const item = await client.getCatalogItem(agg.parent, marketplaceId);
          const summary = item.summaries?.[0];
          if (summary?.itemName) agg.name = summary.itemName;
          const parentFromRel = String(item.relationships?.[0]?.parentAsins?.[0] || "").trim().toUpperCase();
          if (parentFromRel && parentFromRel !== agg.parent) {
            remaps.push({ from: agg.parent, to: parentFromRel, name: summary?.itemName, bsr: item.salesRanks?.[0]?.displayGroupRanks?.[0]?.rank });
            warnings.push(`${agg.parent} rolls up to parent ${parentFromRel}`);
          }
          const rank = item.salesRanks?.[0]?.displayGroupRanks?.[0]?.rank;
          if (typeof rank === "number") agg.bsr = rank;
          catalogLookup += 1;
        } catch {
          // Catalog miss is non-fatal — keep mapping name.
        }
      }
      for (const remap of remaps) {
        const child = byParent.get(remap.from);
        if (!child) continue;
        const parent = byParent.get(remap.to) || {
          name: remap.name || child.name,
          parent: remap.to,
          units: 0,
          ads: 0,
          childSkus: [],
          mappingIds: [],
          bsr: remap.bsr ?? null,
        };
        parent.units += child.units;
        parent.ads += child.ads;
        parent.childSkus.push(...child.childSkus);
        parent.mappingIds.push(...child.mappingIds);
        if (remap.name) parent.name = remap.name;
        if (remap.bsr != null) parent.bsr = remap.bsr;
        byParent.set(remap.to, parent);
        byParent.delete(remap.from);
      }
    }
  } catch (err) {
    warnings.push(`Catalog lookup skipped: ${err instanceof Error ? err.message : String(err)}`);
  }

  for (const agg of byParent.values()) {
    if (agg.mappingIds.length === 0) continue;
    await supabase
      .from("sku_mappings")
      .update({ parent_asin: agg.parent })
      .in("id", agg.mappingIds);
  }

  const monthSales = (monthReports || []).reduce((acc, r) => {
    const breakdown = (r.breakdown || {}) as { summaryLines?: Array<{ label: string; value: number }> };
    const sales = breakdown.summaryLines?.find((l) => l.label === "Product Sales")?.value;
    return acc + Number(sales ?? r.gross_sales ?? 0);
  }, 0);
  const weekUnits = Array.from(unitsBySku.values()).reduce((a, b) => a + b, 0);
  const reportDays = Math.max(
    1,
    ...(monthReports || []).map((r) => {
      const a = Date.parse(`${r.period_start}T00:00:00Z`);
      const b = Date.parse(`${r.period_end}T00:00:00Z`);
      return Math.round((b - a) / 86400000) + 1;
    })
  );
  const weekSalesPool = monthSales * (7 / reportDays);

  await supabase
    .from("performance_metrics")
    .delete()
    .eq("account_id", accountId)
    .eq("recorded_date", weekStart)
    .eq("source", "sp_api");

  let upserted = 0;
  for (const agg of byParent.values()) {
    if (agg.units <= 0 && agg.ads <= 0) continue;
    const share = weekUnits > 0 ? agg.units / weekUnits : 0;
    const payload = {
      account_id: accountId,
      recorded_date: weekStart,
      product_name: agg.name.slice(0, 200),
      asin: agg.parent,
      bsr: agg.bsr,
      review_count: null as number | null,
      rating: null as number | null,
      ppc_spend: Number(agg.ads.toFixed(2)),
      ppc_sales: Number((weekSalesPool * share).toFixed(2)),
      total_sales: Number((weekSalesPool * share).toFixed(2)),
      source: "sp_api",
      updated_at: new Date().toISOString(),
    };
    const { error: insertError } = await supabase.from("performance_metrics").insert(payload);
    if (insertError) warnings.push(`${agg.parent}: ${insertError.message}`);
    else upserted += 1;
  }

  return { ok: true, weekStart, upserted, catalogLookup, warnings };
}
