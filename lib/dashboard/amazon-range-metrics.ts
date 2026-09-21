import type { SupabaseClient } from "@supabase/supabase-js";
import { fetchAllRows } from "@/lib/supabase/fetch-all";
import { preferCanonicalReports } from "@/lib/reports/prefer-canonical-reports";
import { resolvePeriod, type PeriodPreset } from "@/lib/utils/period-presets";

export type AmazonRangeMetrics = {
  from: string;
  to: string;
  units: number;
  totalSales: number;
  netProfit: number;
  totalCogs: number;
  totalFees: number;
  vatPosition: number;
  adsSpend: number;
  acos: number | null;
  source: "sp_api" | "mixed" | "facts_only";
  reportIds: string[];
};

type ReportRow = {
  id: string;
  platform: string;
  period_start: string;
  period_end: string;
  source?: string | null;
  gross_sales: number;
  breakdown: { summaryLines?: Array<{ label: string; value: number }> } | null;
  total_cogs: number;
  total_fees: number;
  output_vat: number;
  input_vat: number;
  net_profit: number;
};

function salesFromReport(row: ReportRow): number {
  const fromBreakdown = row.breakdown?.summaryLines?.find((line) => line.label === "Product Sales")?.value;
  return Number(fromBreakdown ?? row.gross_sales ?? 0);
}

function maxIso(a: string, b: string) {
  return a >= b ? a : b;
}

function minIso(a: string, b: string) {
  return a <= b ? a : b;
}

function daysInclusive(from: string, to: string) {
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b) || b < a) return 1;
  return Math.round((b - a) / 86400000) + 1;
}

async function amazonUnitsInRange(
  supabase: SupabaseClient,
  accountId: string,
  from: string,
  to: string
): Promise<number> {
  const { data } = await fetchAllRows<{ qty: number | string | null }>((start, end) =>
    supabase
      .from("inventory_sales_facts_cache")
      .select("qty")
      .eq("account_id", accountId)
      .ilike("platform", "amazon%")
      .gte("sale_date", from)
      .lte("sale_date", to)
      .order("sale_date", { ascending: true })
      .range(start, end)
  );
  return (data || []).reduce((acc, row) => acc + Number(row.qty || 0), 0);
}

function emptyMetrics(from: string, to: string): AmazonRangeMetrics {
  return {
    from,
    to,
    units: 0,
    totalSales: 0,
    netProfit: 0,
    totalCogs: 0,
    totalFees: 0,
    vatPosition: 0,
    adsSpend: 0,
    acos: null,
    source: "facts_only",
    reportIds: [],
  };
}

/**
 * Amazon dashboard / saved-report figures for an arbitrary date window.
 * Units come from order-dated facts. Money is taken from canonical monthly
 * SP-API reports and scaled by (units in overlap / units in month), falling
 * back to calendar-day share when the month has no units yet.
 */
export async function computeAmazonRangeMetrics(
  supabase: SupabaseClient,
  accountId: string,
  from: string,
  to: string
): Promise<AmazonRangeMetrics> {
  const units = await amazonUnitsInRange(supabase, accountId, from, to);

  const { data: reportRows } = await supabase
    .from("reports")
    .select(
      "id, platform, period_start, period_end, source, gross_sales, breakdown, total_cogs, total_fees, output_vat, input_vat, net_profit"
    )
    .eq("account_id", accountId)
    .eq("platform", "amazon")
    .lte("period_start", to)
    .gte("period_end", from);

  const reports = preferCanonicalReports((reportRows || []) as ReportRow[]);
  if (reports.length === 0) {
    return { ...emptyMetrics(from, to), units, source: "facts_only" };
  }

  const exact = reports.find((r) => r.period_start === from && r.period_end === to);
  const adsByReport = new Map<string, number>();
  const ids = reports.map((r) => r.id);
  const { data: adRows } = await fetchAllRows<{ report_id: string; spend_exvat: number }>((start, end) =>
    supabase
      .from("report_ad_spend")
      .select("report_id, spend_exvat")
      .in("report_id", ids)
      .order("sku", { ascending: true })
      .range(start, end)
  );
  for (const row of adRows || []) {
    adsByReport.set(row.report_id, (adsByReport.get(row.report_id) || 0) + Number(row.spend_exvat || 0));
  }

  if (exact) {
    const adsSpend = adsByReport.get(exact.id) || 0;
    const totalSales = salesFromReport(exact);
    return {
      from,
      to,
      units,
      totalSales,
      netProfit: Number(exact.net_profit || 0),
      totalCogs: Number(exact.total_cogs || 0),
      totalFees: Number(exact.total_fees || 0),
      vatPosition: Number(exact.output_vat || 0) - Number(exact.input_vat || 0),
      adsSpend,
      acos: totalSales > 0 ? adsSpend / totalSales : null,
      source: exact.source === "sp_api" ? "sp_api" : "mixed",
      reportIds: [exact.id],
    };
  }

  let totalSales = 0;
  let netProfit = 0;
  let totalCogs = 0;
  let totalFees = 0;
  let vatPosition = 0;
  let adsSpend = 0;
  let anySp = false;
  let anyManual = false;

  for (const report of reports) {
    const overlapFrom = maxIso(report.period_start, from);
    const overlapTo = minIso(report.period_end, to);
    if (overlapFrom > overlapTo) continue;
    const monthUnits = await amazonUnitsInRange(supabase, accountId, report.period_start, report.period_end);
    const overlapUnits = await amazonUnitsInRange(supabase, accountId, overlapFrom, overlapTo);
    const dayRatio =
      daysInclusive(overlapFrom, overlapTo) / Math.max(1, daysInclusive(report.period_start, report.period_end));
    const ratio = monthUnits > 0 ? overlapUnits / monthUnits : dayRatio;
    totalSales += salesFromReport(report) * ratio;
    netProfit += Number(report.net_profit || 0) * ratio;
    totalCogs += Number(report.total_cogs || 0) * ratio;
    totalFees += Number(report.total_fees || 0) * ratio;
    vatPosition += (Number(report.output_vat || 0) - Number(report.input_vat || 0)) * ratio;
    adsSpend += (adsByReport.get(report.id) || 0) * ratio;
    if (report.source === "sp_api") anySp = true;
    else anyManual = true;
  }

  const round2 = (n: number) => Number(n.toFixed(2));
  return {
    from,
    to,
    units,
    totalSales: round2(totalSales),
    netProfit: round2(netProfit),
    totalCogs: round2(totalCogs),
    totalFees: round2(totalFees),
    vatPosition: round2(vatPosition),
    adsSpend: round2(adsSpend),
    acos: totalSales > 0 ? adsSpend / totalSales : null,
    source: anySp && !anyManual ? "sp_api" : anySp ? "mixed" : "mixed",
    reportIds: ids,
  };
}

export function scaleMetrics(metrics: AmazonRangeMetrics, factor: number): AmazonRangeMetrics {
  const mul = (n: number) => Number((n * factor).toFixed(2));
  const totalSales = mul(metrics.totalSales);
  const adsSpend = mul(metrics.adsSpend);
  return {
    ...metrics,
    units: Number((metrics.units * factor).toFixed(1)),
    totalSales,
    netProfit: mul(metrics.netProfit),
    totalCogs: mul(metrics.totalCogs),
    totalFees: mul(metrics.totalFees),
    vatPosition: mul(metrics.vatPosition),
    adsSpend,
    acos: totalSales > 0 ? adsSpend / totalSales : null,
  };
}

export async function saveAmazonRangeReport(
  supabase: SupabaseClient,
  accountId: string,
  from: string,
  to: string
): Promise<{ id: string | null; metrics: AmazonRangeMetrics; error?: string }> {
  const metrics = await computeAmazonRangeMetrics(supabase, accountId, from, to);
  const breakdown = {
    summaryLines: [
      { label: "Product Sales", value: metrics.totalSales },
      { label: "Units", value: metrics.units },
      { label: "Ads Spend", value: metrics.adsSpend },
    ],
    methodologyId: "amazon-range-snapshot",
    sourceMeta: {
      source: "sp_api_range",
      kind: "range_snapshot",
      syncedAt: new Date().toISOString(),
      reportIds: metrics.reportIds,
    },
  };
  const payload = {
    account_id: accountId,
    period_start: from,
    period_end: to,
    platform: "amazon" as const,
    source: "sp_api_range" as const,
    gross_sales: metrics.totalSales,
    total_cogs: metrics.totalCogs,
    total_fees: metrics.totalFees,
    output_vat: metrics.vatPosition > 0 ? metrics.vatPosition : 0,
    input_vat: metrics.vatPosition < 0 ? Math.abs(metrics.vatPosition) : 0,
    net_profit: metrics.netProfit,
    breakdown,
    updated_at: new Date().toISOString(),
  };
  const { data, error } = await supabase
    .from("reports")
    .upsert(payload, { onConflict: "account_id,period_start,period_end,platform,source" })
    .select("id")
    .single();
  return { id: data?.id ?? null, metrics, error: error?.message };
}

export async function refreshAmazonDashboardSnapshots(
  supabase: SupabaseClient,
  accountId: string
): Promise<void> {
  const presets: PeriodPreset[] = ["today", "yesterday", "mtd", "this_month_forecast", "last_month"];
  for (const preset of presets) {
    const period = resolvePeriod({ preset });
    let metrics: AmazonRangeMetrics;
    if (preset === "this_month_forecast" && period.paceFrom && period.paceTo && period.forecastFactor) {
      const mtd = await computeAmazonRangeMetrics(supabase, accountId, period.paceFrom, period.paceTo);
      metrics = { ...scaleMetrics(mtd, period.forecastFactor), from: period.from, to: period.to };
    } else {
      metrics = await computeAmazonRangeMetrics(supabase, accountId, period.from, period.to);
    }
    await supabase.from("amazon_dashboard_snapshots").upsert(
      {
        account_id: accountId,
        preset,
        period_start: period.from,
        period_end: period.to,
        metrics,
        computed_at: new Date().toISOString(),
      },
      { onConflict: "account_id,preset" }
    );
  }
}
