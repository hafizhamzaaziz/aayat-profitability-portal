import type { Metadata } from "next";
import { requireAuth } from "@/lib/auth/guards";
import type { UserRole } from "@/lib/types/auth";
import { getAccountByIdForRole } from "@/lib/data/accounts";
import { preferCanonicalReports } from "@/lib/reports/prefer-canonical-reports";
import { fetchAllRows } from "@/lib/supabase/fetch-all";
import {
  computeAmazonRangeMetrics,
  scaleMetrics,
  type AmazonRangeMetrics,
} from "@/lib/dashboard/amazon-range-metrics";
import { parsePeriodPreset, priorPeriod, resolvePeriod } from "@/lib/utils/period-presets";
import DashboardFilters from "./dashboard-filters";
import DashboardCharts from "./dashboard-charts";
import DashboardKpis from "./dashboard-kpis";
import DashboardTopSkus from "./dashboard-top-skus";
import { formatUkDate } from "@/lib/utils/date";

type Search = {
  accountId?: string;
  period?: string;
  periodStart?: string;
  periodEnd?: string;
  platform?: string;
};

export const metadata: Metadata = {
  title: "Dashboard",
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
  const salesLabel = row.platform === "amazon" ? "Product Sales" : "Order Payments";
  const fromBreakdown = row.breakdown?.summaryLines?.find((line) => line.label === salesLabel)?.value;
  return Number(fromBreakdown ?? row.gross_sales ?? 0);
}

export default async function DashboardPage({ searchParams }: { searchParams: Search }) {
  const { supabase, user } = await requireAuth();

  const { data: userRow } = await supabase.from("users").select("role").eq("id", user.id).single();
  const role = ((userRow?.role as UserRole) || "client") as UserRole;

  const accountId = searchParams.accountId;
  const account = accountId ? await getAccountByIdForRole(supabase, accountId, role, user.id) : null;
  const period = resolvePeriod({
    preset: searchParams.period || "mtd",
    from: searchParams.periodStart,
    to: searchParams.periodEnd,
  });
  const prior = priorPeriod(period);
  const platform = searchParams.platform && searchParams.platform !== "all" ? searchParams.platform : "all";
  const preset = parsePeriodPreset(searchParams.period || "mtd");

  let reports: ReportRow[] = [];
  let topSkus: Array<{ sku: string; description: string | null; units: number; net_sales: number; net_profit: number }> = [];
  let amazonConnected = false;
  let amazonMetrics: AmazonRangeMetrics | null = null;
  let amazonPrior: AmazonRangeMetrics | null = null;
  let snapshotAge: string | null = null;

  if (account) {
    const { data: spCred } = await supabase
      .from("account_amazon_credentials")
      .select("account_id")
      .eq("account_id", account.id)
      .eq("provider", "sp-api")
      .not("refresh_token_encrypted", "is", null)
      .maybeSingle();
    amazonConnected = Boolean(spCred);

    let query = supabase
      .from("reports")
      .select(
        "id, platform, period_start, period_end, source, gross_sales, breakdown, total_cogs, total_fees, output_vat, input_vat, net_profit"
      )
      .eq("account_id", account.id)
      .lte("period_start", period.to)
      .gte("period_end", period.from)
      .order("period_start", { ascending: false });
    if (platform !== "all") query = query.eq("platform", platform);
    const { data } = await query;
    reports = preferCanonicalReports((data || []) as ReportRow[]);

    if (amazonConnected && (platform === "all" || platform === "amazon")) {
      if (preset !== "custom") {
        const { data: snap } = await supabase
          .from("amazon_dashboard_snapshots")
          .select("metrics, computed_at, period_start, period_end")
          .eq("account_id", account.id)
          .eq("preset", preset)
          .maybeSingle();
        if (snap?.metrics) {
          amazonMetrics = snap.metrics as AmazonRangeMetrics;
          snapshotAge = String(snap.computed_at || "");
        }
      }
      if (!amazonMetrics) {
        if (preset === "this_month_forecast" && period.paceFrom && period.paceTo && period.forecastFactor) {
          const mtd = await computeAmazonRangeMetrics(supabase, account.id, period.paceFrom, period.paceTo);
          amazonMetrics = { ...scaleMetrics(mtd, period.forecastFactor), from: period.from, to: period.to };
        } else {
          amazonMetrics = await computeAmazonRangeMetrics(supabase, account.id, period.from, period.to);
        }
      }
      amazonPrior = await computeAmazonRangeMetrics(supabase, account.id, prior.from, prior.to);
    }

    if (reports.length > 0) {
      const ids = reports.map((r) => r.id);
      const { data: skuRows } = await fetchAllRows<{
        sku: string;
        description: string | null;
        units: number;
        net_sales: number;
        net_profit: number;
      }>((from, to) =>
        supabase
          .from("report_sku_breakdowns")
          .select("sku, description, units, net_sales, net_profit")
          .in("report_id", ids)
          .order("sku", { ascending: true })
          .range(from, to)
      );
      const agg = new Map<string, { sku: string; description: string | null; units: number; net_sales: number; net_profit: number }>();
      (skuRows || []).forEach((row) => {
        const key = String(row.sku || "").trim().toUpperCase();
        if (!key) return;
        const cur = agg.get(key) || { sku: key, description: row.description ?? null, units: 0, net_sales: 0, net_profit: 0 };
        cur.units += Number(row.units || 0);
        cur.net_sales += Number(row.net_sales || 0);
        cur.net_profit += Number(row.net_profit || 0);
        if (!cur.description && row.description) cur.description = row.description;
        agg.set(key, cur);
      });
      topSkus = Array.from(agg.values()).sort((a, b) => b.net_profit - a.net_profit);
    }

    if (amazonConnected && (platform === "all" || platform === "amazon") && amazonMetrics) {
      const { data: factSkuRows } = await fetchAllRows<{
        sku: string | null;
        qty: number | string | null;
      }>((from, to) =>
        supabase
          .from("inventory_sales_facts_cache")
          .select("sku, qty")
          .eq("account_id", account.id)
          .ilike("platform", "amazon%")
          .gte("sale_date", period.from)
          .lte("sale_date", period.to)
          .order("sku", { ascending: true })
          .range(from, to)
      );
      const unitAgg = new Map<string, number>();
      for (const row of factSkuRows || []) {
        const key = String(row.sku || "").trim().toUpperCase();
        if (!key) continue;
        unitAgg.set(key, (unitAgg.get(key) || 0) + Number(row.qty || 0));
      }
      if (unitAgg.size > 0) {
        const descBySku = new Map(topSkus.map((r) => [r.sku, r]));
        topSkus = Array.from(unitAgg.entries())
          .map(([sku, units]) => {
            const existing = descBySku.get(sku);
            return {
              sku,
              description: existing?.description ?? null,
              units,
              net_sales: existing ? existing.net_sales : 0,
              net_profit: existing ? existing.net_profit : 0,
            };
          })
          .sort((a, b) => b.units - a.units);
      }
    }
  }

  const reportTotals = reports.reduce(
    (acc, row) => {
      acc.netProfit += Number(row.net_profit || 0);
      acc.vatPosition += Number((row.output_vat || 0) - (row.input_vat || 0));
      acc.totalSales += salesFromReport(row);
      acc.totalCogs += Number(row.total_cogs || 0);
      acc.totalFees += Number(row.total_fees || 0);
      acc.units += 0;
      return acc;
    },
    { netProfit: 0, vatPosition: 0, totalSales: 0, totalCogs: 0, totalFees: 0, units: 0, adsSpend: 0, acos: null as number | null }
  );

  const kpis = amazonMetrics
    ? {
        totalSales: amazonMetrics.totalSales,
        netProfit: amazonMetrics.netProfit,
        vatPosition: amazonMetrics.vatPosition,
        totalCogs: amazonMetrics.totalCogs,
        totalFees: amazonMetrics.totalFees,
        units: amazonMetrics.units,
        adsSpend: amazonMetrics.adsSpend,
        acos: amazonMetrics.acos,
      }
    : reportTotals;

  const priorKpis = amazonPrior
    ? {
        totalSales: amazonPrior.totalSales,
        netProfit: amazonPrior.netProfit,
        vatPosition: amazonPrior.vatPosition,
        totalCogs: amazonPrior.totalCogs,
        totalFees: amazonPrior.totalFees,
        units: amazonPrior.units,
        adsSpend: amazonPrior.adsSpend,
        acos: amazonPrior.acos,
      }
    : { netProfit: 0, vatPosition: 0, totalSales: 0, totalCogs: 0, totalFees: 0, units: 0, adsSpend: 0, acos: null as number | null };

  return (
    <div className="space-y-4">
      <div className="rounded-2xl bg-white p-4 text-sm text-slate-700">
        <span>
          Signed in as: <span className="font-semibold">{user.email}</span>
        </span>
        <span className="mx-2 text-slate-400">|</span>
        <span>
          Selected account: <span className="font-semibold">{account?.name ?? "None selected"}</span>
        </span>
        {amazonConnected ? (
          <>
            <span className="mx-2 text-slate-400">|</span>
            <span className="font-medium text-emerald-700">Amazon API primary</span>
          </>
        ) : null}
      </div>

      <DashboardFilters />

      {amazonConnected && amazonMetrics ? (
        <p className="text-xs text-slate-500">
          Amazon {formatUkDate(period.from)} – {formatUkDate(period.to)}
          {preset === "this_month_forecast"
            ? ` · forecast = MTD × ${period.forecastFactor?.toFixed(2)} (days in month / day of month, UTC)`
            : ""}
          {snapshotAge ? ` · preset cache ${new Date(snapshotAge).toLocaleString()}` : " · live range"}
          {amazonMetrics.source === "sp_api" ? " · SP-API" : amazonMetrics.source === "facts_only" ? " · units from orders (P&L month not saved yet)" : ""}
        </p>
      ) : null}

      <DashboardKpis
        currency={account?.currency || "£"}
        current={kpis}
        prior={priorKpis}
        hasPrior={Boolean(amazonPrior) || reports.length > 0}
        forecast={preset === "this_month_forecast"}
      />

      <DashboardCharts
        currency={account?.currency || "£"}
        reports={reports.map((row) => ({
          id: row.id,
          platform: row.platform,
          period_start: row.period_start,
          period_end: row.period_end,
          gross_sales: salesFromReport(row),
          net_profit: Number(row.net_profit || 0),
        }))}
      />

      <DashboardTopSkus
        currency={account?.currency || "£"}
        rows={topSkus.slice(0, 5)}
      />

      <div className="rounded-2xl border border-slate-200 bg-white p-4">
        <h4 className="mb-3 text-sm font-semibold text-slate-800">Saved Reports overlapping this period</h4>
        {reports.length === 0 ? (
          <p className="text-sm text-slate-500">No saved reports overlap the selected dates.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead className="text-left text-xs uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="py-2 pr-4">Platform</th>
                  <th className="py-2 pr-4">Source</th>
                  <th className="py-2 pr-4">Start</th>
                  <th className="py-2 pr-4">End</th>
                  <th className="py-2 pr-4">Net Profit</th>
                </tr>
              </thead>
              <tbody>
                {reports.map((report) => (
                  <tr key={report.id} className="border-t border-slate-100">
                    <td className="py-2 pr-4 capitalize">{report.platform}</td>
                    <td className="py-2 pr-4">{report.source === "sp_api" ? "SP-API" : "Upload"}</td>
                    <td className="py-2 pr-4">{formatUkDate(report.period_start)}</td>
                    <td className="py-2 pr-4">{formatUkDate(report.period_end)}</td>
                    <td className="py-2 pr-4">{Number(report.net_profit).toFixed(2)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
