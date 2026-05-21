import type { Metadata } from "next";
import { requireAuth } from "@/lib/auth/guards";
import type { UserRole } from "@/lib/types/auth";
import { getAccountByIdForRole } from "@/lib/data/accounts";
import DashboardFilters from "./dashboard-filters";
import DashboardCharts from "./dashboard-charts";
import DashboardKpis from "./dashboard-kpis";
import DashboardTopSkus from "./dashboard-top-skus";
import { formatUkDate } from "@/lib/utils/date";
import { createNotification } from "@/lib/notifications/server";

type Search = {
  accountId?: string;
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

function shiftMonths(iso: string, months: number): string {
  const date = new Date(`${iso}T00:00:00Z`);
  const next = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + months, date.getUTCDate()));
  return next.toISOString().slice(0, 10);
}

export default async function DashboardPage({ searchParams }: { searchParams: Search }) {
  const { supabase, user } = await requireAuth();

  const { data: userRow } = await supabase.from("users").select("role").eq("id", user.id).single();
  const role = ((userRow?.role as UserRole) || "client") as UserRole;

  const accountId = searchParams.accountId;
  const account = accountId ? await getAccountByIdForRole(supabase, accountId, role, user.id) : null;

  let reports: ReportRow[] = [];
  let priorReports: ReportRow[] = [];
  let topSkus: Array<{ sku: string; description: string | null; units: number; net_sales: number; net_profit: number }> = [];

  let missingForSelectedPeriod = false;

  if (account) {
    let query = supabase
      .from("reports")
      .select(
        "id, platform, period_start, period_end, gross_sales, breakdown, total_cogs, total_fees, output_vat, input_vat, net_profit"
      )
      .eq("account_id", account.id)
      .order("period_start", { ascending: false });

    if (searchParams.periodStart) query = query.eq("period_start", searchParams.periodStart);
    if (searchParams.periodEnd) query = query.eq("period_end", searchParams.periodEnd);
    if (searchParams.platform && searchParams.platform !== "all") query = query.eq("platform", searchParams.platform);

    const { data } = await query;
    reports = (data || []) as ReportRow[];

    const selectedPeriod = Boolean(searchParams.periodStart && searchParams.periodEnd);
    missingForSelectedPeriod = selectedPeriod && reports.length === 0;

    if (missingForSelectedPeriod && searchParams.periodStart && searchParams.periodEnd) {
      try {
        const eventKey = `missing-report:${user.id}:${account.id}:${searchParams.periodStart}:${searchParams.periodEnd}:${searchParams.platform || "all"}`;
        const title = "Report missing for selected period";
        const body = `No ${searchParams.platform && searchParams.platform !== "all" ? searchParams.platform : "platform"} report found from ${formatUkDate(
          searchParams.periodStart
        )} to ${formatUkDate(searchParams.periodEnd)} for ${account.name}.`;
        await createNotification(supabase, {
          userId: user.id,
          title,
          body,
          level: "warning",
          eventKey,
          link: `/reports?accountId=${account.id}`,
        });
      } catch {
        // non-blocking notification path
      }
    }

    // Build prior-period reports for "vs previous month" deltas.
    // We look up the same-platform report whose period_start is exactly 1 month before each visible report.
    if (reports.length > 0) {
      const wantedKeys = new Set<string>();
      for (const r of reports) {
        wantedKeys.add(`${r.platform}|${shiftMonths(r.period_start, -1)}`);
      }
      const priorStarts = Array.from(new Set(reports.map((r) => shiftMonths(r.period_start, -1))));
      const { data: priorData } = await supabase
        .from("reports")
        .select(
          "id, platform, period_start, period_end, gross_sales, breakdown, total_cogs, total_fees, output_vat, input_vat, net_profit"
        )
        .eq("account_id", account.id)
        .in("period_start", priorStarts);
      priorReports = ((priorData || []) as ReportRow[]).filter((r) =>
        wantedKeys.has(`${r.platform}|${r.period_start}`)
      );

      // Top SKUs across selected reports
      const ids = reports.map((r) => r.id);
      const { data: skuRows } = await supabase
        .from("report_sku_breakdowns")
        .select("sku, description, units, net_sales, net_profit")
        .in("report_id", ids);
      const agg = new Map<string, { sku: string; description: string | null; units: number; net_sales: number; net_profit: number }>();
      ((skuRows || []) as Array<{ sku: string; description: string | null; units: number; net_sales: number; net_profit: number }>).forEach((row) => {
        const key = String(row.sku || "").trim();
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
  }

  const totals = reports.reduce(
    (acc, row) => {
      acc.netProfit += Number(row.net_profit || 0);
      acc.vatPosition += Number((row.output_vat || 0) - (row.input_vat || 0));
      acc.totalSales += salesFromReport(row);
      acc.totalCogs += Number(row.total_cogs || 0);
      acc.totalFees += Number(row.total_fees || 0);
      return acc;
    },
    { netProfit: 0, vatPosition: 0, totalSales: 0, totalCogs: 0, totalFees: 0 }
  );

  const priorTotals = priorReports.reduce(
    (acc, row) => {
      acc.netProfit += Number(row.net_profit || 0);
      acc.vatPosition += Number((row.output_vat || 0) - (row.input_vat || 0));
      acc.totalSales += salesFromReport(row);
      return acc;
    },
    { netProfit: 0, vatPosition: 0, totalSales: 0 }
  );

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
      </div>

      <DashboardFilters />

      {account && missingForSelectedPeriod ? (
        <div className="rounded-2xl border border-yellow-200 bg-yellow-50 p-4 text-sm text-yellow-800">
          Report missing for this period. Upload and generate a report from the Reports tab.
        </div>
      ) : null}

      <DashboardKpis
        currency={account?.currency || "£"}
        current={totals}
        prior={priorTotals}
        hasPrior={priorReports.length > 0}
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
        <h4 className="mb-3 text-sm font-semibold text-slate-800">Saved Reports</h4>
        {reports.length === 0 ? (
          <p className="text-sm text-slate-500">No saved reports for current filter.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead className="text-left text-xs uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="py-2 pr-4">Platform</th>
                  <th className="py-2 pr-4">Start</th>
                  <th className="py-2 pr-4">End</th>
                  <th className="py-2 pr-4">Net Profit</th>
                </tr>
              </thead>
              <tbody>
                {reports.map((report) => (
                  <tr key={report.id} className="border-t border-slate-100">
                    <td className="py-2 pr-4 capitalize">{report.platform}</td>
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
