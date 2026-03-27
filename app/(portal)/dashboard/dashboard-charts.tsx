"use client";

import { formatUkDate } from "@/lib/utils/date";

type ChartReport = {
  id: string;
  platform: string;
  period_start: string;
  period_end: string;
  gross_sales: number;
  net_profit: number;
};

type Props = {
  reports: ChartReport[];
  currency: string;
};

function shortPeriod(periodStart: string, periodEnd: string) {
  if (!periodStart && !periodEnd) return "Period";
  return `${periodStart ? formatUkDate(periodStart) : "?"} - ${periodEnd ? formatUkDate(periodEnd) : "?"}`;
}

export default function DashboardCharts({ reports, currency }: Props) {
  const recent = reports.slice(0, 8).reverse();
  const maxAbsProfit = Math.max(...recent.map((row) => Math.abs(row.net_profit)), 1);

  const platformTotals = reports.reduce(
    (acc, row) => {
      if (row.platform === "amazon") acc.amazon += row.net_profit;
      if (row.platform === "temu") acc.temu += row.net_profit;
      return acc;
    },
    { amazon: 0, temu: 0 }
  );

  const totalAbs = Math.max(Math.abs(platformTotals.amazon) + Math.abs(platformTotals.temu), 1);

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <div className="rounded-2xl border border-slate-200 bg-white p-4">
        <h4 className="mb-3 text-sm font-semibold text-slate-800">Net Profit Trend</h4>
        {recent.length === 0 ? (
          <p className="text-sm text-slate-500">No report data available yet.</p>
        ) : (
          <div className="space-y-2">
            {recent.map((row) => {
              const widthPct = Math.max((Math.abs(row.net_profit) / maxAbsProfit) * 100, 4);
              const positive = row.net_profit >= 0;
              const isAmazon = row.platform === "amazon";
              const barColor = isAmazon ? "bg-[#146eb4]" : "bg-[#ff9900]";
              const textColor = isAmazon ? "text-[#146eb4]" : "text-[#ff9900]";
              return (
                <div key={row.id} className="space-y-1">
                  <div className="flex items-center justify-between text-xs text-slate-600">
                    <span>
                      {shortPeriod(row.period_start, row.period_end)}{" "}
                      <span className={textColor}>({isAmazon ? "Amazon" : "Temu"})</span>
                    </span>
                    <span className={positive ? "text-emerald-700" : "text-rose-700"}>
                      {currency}
                      {row.net_profit.toFixed(2)}
                    </span>
                  </div>
                  <div className="h-2 rounded-full bg-slate-100">
                    <div
                      className={`h-2 rounded-full ${barColor}`}
                      style={{ width: `${widthPct}%` }}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <div className="rounded-2xl border border-slate-200 bg-white p-4">
        <h4 className="mb-3 text-sm font-semibold text-slate-800">Net Profit by Platform</h4>
        {reports.length === 0 ? (
          <p className="text-sm text-slate-500">No report data available yet.</p>
        ) : (
          <div className="space-y-4">
            <PlatformBar
              label="Amazon"
              value={platformTotals.amazon}
              widthPct={(Math.abs(platformTotals.amazon) / totalAbs) * 100}
              currency={currency}
              colorClass="bg-[#146eb4]"
              labelClass="text-[#146eb4]"
            />
            <PlatformBar
              label="Temu"
              value={platformTotals.temu}
              widthPct={(Math.abs(platformTotals.temu) / totalAbs) * 100}
              currency={currency}
              colorClass="bg-[#ff9900]"
              labelClass="text-[#ff9900]"
            />
          </div>
        )}
      </div>
    </div>
  );
}

function PlatformBar({
  label,
  value,
  widthPct,
  currency,
  colorClass,
  labelClass,
}: {
  label: string;
  value: number;
  widthPct: number;
  currency: string;
  colorClass: string;
  labelClass: string;
}) {
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between text-xs text-slate-600">
        <span className={labelClass}>{label}</span>
        <span className={labelClass}>
          {currency}
          {value.toFixed(2)}
        </span>
      </div>
      <div className="h-3 rounded-full bg-slate-100">
        <div
          className={`h-3 rounded-full ${colorClass}`}
          style={{ width: `${Math.max(widthPct, 6)}%` }}
        />
      </div>
    </div>
  );
}
