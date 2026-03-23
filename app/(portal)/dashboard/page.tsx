import type { Metadata } from "next";
import { requireAuth } from "@/lib/auth/guards";
import type { UserRole } from "@/lib/types/auth";
import { getAccountByIdForRole } from "@/lib/data/accounts";
import DashboardFilters from "./dashboard-filters";
import DashboardCharts from "./dashboard-charts";
import { formatUkDate } from "@/lib/utils/date";
import { createNotification, sendNotificationEmailIfConfigured } from "@/lib/notifications/server";

type Search = {
  accountId?: string;
  periodStart?: string;
  periodEnd?: string;
  platform?: string;
};

export const metadata: Metadata = {
  title: "Dashboard",
};

export default async function DashboardPage({ searchParams }: { searchParams: Search }) {
  const { supabase, user } = await requireAuth();

  const { data: userRow } = await supabase.from("users").select("role").eq("id", user.id).single();
  const role = ((userRow?.role as UserRole) || "client") as UserRole;

  const accountId = searchParams.accountId;
  const account = accountId ? await getAccountByIdForRole(supabase, accountId, role, user.id) : null;

  let reports: Array<{
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
  }> = [];

  let missingForSelectedPeriod = false;

  if (account) {
    let query = supabase
      .from("reports")
      .select(
        "id, platform, period_start, period_end, gross_sales, breakdown, total_cogs, total_fees, output_vat, input_vat, net_profit"
      )
      .eq("account_id", account.id)
      .order("period_start", { ascending: false });

    if (searchParams.periodStart) {
      query = query.eq("period_start", searchParams.periodStart);
    }
    if (searchParams.periodEnd) {
      query = query.eq("period_end", searchParams.periodEnd);
    }
    if (searchParams.platform && searchParams.platform !== "all") {
      query = query.eq("platform", searchParams.platform);
    }

    const { data } = await query;
    reports = (data || []) as typeof reports;

    const selectedPeriod = Boolean(searchParams.periodStart && searchParams.periodEnd);
    missingForSelectedPeriod = selectedPeriod && reports.length === 0;

    if (missingForSelectedPeriod && searchParams.periodStart && searchParams.periodEnd) {
      try {
        const eventKey = `missing-report:${user.id}:${account.id}:${searchParams.periodStart}:${searchParams.periodEnd}:${searchParams.platform || "all"}`;
        const title = "Report missing for selected period";
        const body = `No ${searchParams.platform && searchParams.platform !== "all" ? searchParams.platform : "platform"} report found from ${formatUkDate(
          searchParams.periodStart
        )} to ${formatUkDate(searchParams.periodEnd)} for ${account.name}.`;
        const created = await createNotification(supabase, {
          userId: user.id,
          title,
          body,
          level: "warning",
          eventKey,
          link: `/reports?accountId=${account.id}`,
          email: user.email,
        });
        if (created.inserted) {
          await sendNotificationEmailIfConfigured({
            to: user.email,
            subject: title,
            text: `${body}\n\nOpen portal: /reports?accountId=${account.id}`,
          });
        }
      } catch {
        // non-blocking notification path
      }
    }
  }

  const totals = reports.reduce(
    (acc, row) => {
      const salesLabel = row.platform === "amazon" ? "Product Sales" : "Order Payments";
      const salesFromBreakdown = row.breakdown?.summaryLines?.find((line) => line.label === salesLabel)?.value;
      acc.netProfit += Number(row.net_profit || 0);
      acc.vatPosition += Number((row.output_vat || 0) - (row.input_vat || 0));
      acc.totalSales += Number(salesFromBreakdown ?? row.gross_sales ?? 0);
      return acc;
    },
    { netProfit: 0, vatPosition: 0, totalSales: 0 }
  );

  return (
    <div className="space-y-4">
      <div className="rounded-2xl bg-white p-4 text-sm text-slate-700">
        Signed in as: <span className="font-semibold">{user.email}</span>
      </div>

      <div className="rounded-2xl bg-white p-4 text-sm text-slate-700">
        Selected account: <span className="font-semibold">{account?.name ?? "None selected"}</span>
      </div>

      <DashboardFilters />

      {account && missingForSelectedPeriod ? (
        <div className="rounded-2xl border border-yellow-200 bg-yellow-50 p-4 text-sm text-yellow-800">
          Report missing for this period. Upload and generate a report from the Reports tab.
        </div>
      ) : null}

      <div className="grid gap-3 sm:grid-cols-3">
        <div className="rounded-2xl bg-white p-4">
          <p className="text-xs text-slate-500">Total Net Profit</p>
          <p className="text-xl font-semibold">{totals.netProfit.toFixed(2)}</p>
        </div>
        <div className="rounded-2xl bg-white p-4">
          <p className="text-xs text-slate-500">VAT Position</p>
          <p className="text-xl font-semibold">{totals.vatPosition.toFixed(2)}</p>
        </div>
        <div className="rounded-2xl bg-white p-4">
          <p className="text-xs text-slate-500">Total Sales</p>
          <p className="text-xl font-semibold">{totals.totalSales.toFixed(2)}</p>
        </div>
      </div>

      <DashboardCharts
        currency={account?.currency || "£"}
        reports={reports.map((row) => ({
          id: row.id,
          platform: row.platform,
          period_start: row.period_start,
          period_end: row.period_end,
          gross_sales: Number(row.gross_sales || 0),
          net_profit: Number(row.net_profit || 0),
        }))}
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
