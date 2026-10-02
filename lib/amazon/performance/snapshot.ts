import type { SupabaseClient } from "@supabase/supabase-js";
import { fetchAllRows } from "@/lib/supabase/fetch-all";
import { fetchSalesAndTraffic } from "@/lib/amazon/reports/sales-traffic";
import { lastCompletedWeekMondayIsoUtc, addDays } from "@/lib/utils/date";

function isAsin(value: string) {
  return /^[A-Z0-9]{10}$/.test(value);
}

/**
 * Weekly performance rows keyed by the parent ASIN on Amazon's
 * Detail Page Sales and Traffic by Parent Item report.
 * Seller SKUs are never written into the Parent ASIN column.
 * Review count and star rating are not in this report.
 */
export async function snapshotAmazonPerformance(
  supabase: SupabaseClient,
  accountId: string
): Promise<{ ok: boolean; weekStart: string; upserted: number; catalogLookup: number; warnings: string[] }> {
  const weekStart = lastCompletedWeekMondayIsoUtc();
  const weekEnd = addDays(weekStart, 6);
  const warnings: string[] = [
    "Parent ASINs come from Amazon Business Reports (Detail page sales and traffic), not from seller SKUs.",
    "Review count and star rating are not in that report.",
  ];

  const traffic = await fetchSalesAndTraffic({
    accountId,
    from: weekStart,
    to: weekEnd,
    asinGranularity: "SKU",
  });

  const { data: mappingRows } = await fetchAllRows<{
    id: string;
    amazon_sku: string | null;
    sku_catalog: unknown;
  }>((from, to) =>
    supabase
      .from("sku_mappings")
      .select("id, amazon_sku, sku_catalog:sku_catalog_id(product_name)")
      .eq("account_id", accountId)
      .not("amazon_sku", "is", null)
      .order("id", { ascending: true })
      .range(from, to)
  );
  const nameBySku = new Map<string, string>();
  const mappingIdBySku = new Map<string, string>();
  for (const row of mappingRows || []) {
    const sku = String(row.amazon_sku || "").trim().toUpperCase();
    if (!sku) continue;
    const catalog = row.sku_catalog as { product_name?: string } | { product_name?: string }[] | null;
    const name = Array.isArray(catalog) ? catalog[0]?.product_name : catalog?.product_name;
    if (name) nameBySku.set(sku, String(name));
    if (row.id) mappingIdBySku.set(sku, String(row.id));
  }

  const { data: monthReports } = await supabase
    .from("reports")
    .select("id, period_start, period_end")
    .eq("account_id", accountId)
    .eq("platform", "amazon")
    .lte("period_start", weekEnd)
    .gte("period_end", weekStart)
    .eq("source", "sp_api");
  const overlappingIds = (monthReports || []).map((row) => String(row.id));
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
    const reportDays = Math.max(
      1,
      ...(monthReports || []).map((row) => {
        const start = Date.parse(`${row.period_start}T00:00:00Z`);
        const end = Date.parse(`${row.period_end}T00:00:00Z`);
        return Math.round((end - start) / 86400000) + 1;
      })
    );
    const adsScale = 7 / reportDays;
    for (const row of adRows || []) {
      const sku = String(row.sku || "").trim().toUpperCase();
      if (!sku) continue;
      adsBySku.set(sku, (adsBySku.get(sku) || 0) + Number(row.spend_exvat || 0) * adsScale);
    }
  }

  type ParentAgg = {
    parent: string;
    name: string;
    units: number;
    orders: number;
    sales: number;
    ads: number;
    mappingIds: string[];
  };
  const byParent = new Map<string, ParentAgg>();
  for (const row of traffic.byAsin) {
    if (!isAsin(row.parentAsin)) {
      if (row.sku || row.childAsin) warnings.push(`Skipped ${row.sku || row.childAsin}: Amazon did not return a parent ASIN.`);
      continue;
    }
    const current = byParent.get(row.parentAsin) || {
      parent: row.parentAsin,
      name: nameBySku.get(row.sku) || row.parentAsin,
      units: 0,
      orders: 0,
      sales: 0,
      ads: 0,
      mappingIds: [],
    };
    current.units += row.units;
    current.orders += row.orders;
    current.sales += row.sales;
    if (row.sku) {
      current.ads += adsBySku.get(row.sku) || 0;
      const mappedName = nameBySku.get(row.sku);
      if (mappedName && current.name === current.parent) current.name = mappedName;
      const mappingId = mappingIdBySku.get(row.sku);
      if (mappingId) current.mappingIds.push(mappingId);
    }
    byParent.set(row.parentAsin, current);
  }

  if (byParent.size === 0) {
    warnings.push("No parent ASINs were returned, so existing performance rows were left unchanged.");
    return { ok: false, weekStart, upserted: 0, catalogLookup: traffic.byAsin.length, warnings };
  }

  for (const agg of byParent.values()) {
    if (agg.mappingIds.length === 0) continue;
    await supabase.from("sku_mappings").update({ parent_asin: agg.parent }).in("id", agg.mappingIds);
  }

  await supabase
    .from("performance_metrics")
    .delete()
    .eq("account_id", accountId)
    .eq("recorded_date", weekStart)
    .eq("source", "sp_api");

  let upserted = 0;
  for (const agg of byParent.values()) {
    if (agg.units <= 0 && agg.sales <= 0 && agg.ads <= 0) continue;
    const sales = Number(agg.sales.toFixed(2));
    const { error } = await supabase.from("performance_metrics").insert({
      account_id: accountId,
      recorded_date: weekStart,
      product_name: agg.name.slice(0, 200),
      asin: agg.parent,
      bsr: null,
      review_count: null,
      rating: null,
      ppc_spend: Number(agg.ads.toFixed(2)),
      ppc_sales: sales,
      total_sales: sales,
      source: "sp_api",
      updated_at: new Date().toISOString(),
    });
    if (error) warnings.push(`${agg.parent}: ${error.message}`);
    else upserted += 1;
  }

  return { ok: upserted > 0, weekStart, upserted, catalogLookup: traffic.byAsin.length, warnings };
}
