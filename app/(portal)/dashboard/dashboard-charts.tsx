"use client";

import { useMemo } from "react";
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

function monthLabel(iso: string) {
  if (!iso) return "";
  const d = new Date(`${iso}T00:00:00Z`);
  return d.toLocaleString("en-GB", { month: "short", year: "2-digit", timeZone: "UTC" });
}

export default function DashboardCharts({ reports, currency }: Props) {
  const recent = reports.slice(0, 8).reverse();
  const maxAbsProfit = Math.max(...recent.map((row) => Math.abs(row.net_profit)), 1);

  const platformTotals = reports.reduce(
    (acc, row) => {
      if (row.platform === "amazon") acc.amazon += row.net_profit;
      if (row.platform === "temu") acc.temu += row.net_profit;
      if (row.platform === "tiktok") acc.tiktok += row.net_profit;
      return acc;
    },
    { amazon: 0, temu: 0, tiktok: 0 }
  );
  const totalAbs = Math.max(
    Math.abs(platformTotals.amazon) + Math.abs(platformTotals.temu) + Math.abs(platformTotals.tiktok),
    1
  );

  // Build monthly aggregated sales vs net-profit timeline (latest 12 months).
  const monthly = useMemo(() => {
    const byMonth = new Map<string, { sales: number; profit: number }>();
    for (const row of reports) {
      const key = row.period_start?.slice(0, 7) || "";
      if (!key) continue;
      const cur = byMonth.get(key) || { sales: 0, profit: 0 };
      cur.sales += row.gross_sales;
      cur.profit += row.net_profit;
      byMonth.set(key, cur);
    }
    const sorted = Array.from(byMonth.entries())
      .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
      .slice(-12);
    return sorted.map(([periodStart, value]) => ({
      periodStart: `${periodStart}-01`,
      sales: value.sales,
      profit: value.profit,
    }));
  }, [reports]);

  return (
    <div className="space-y-4">
      <SalesVsProfitChart currency={currency} months={monthly} />

      <div className="grid gap-4 lg:grid-cols-2">
        <div className="rounded-2xl border border-slate-200 bg-white p-4">
          <h4 className="mb-3 text-sm font-semibold text-slate-800">Net Profit Trend (recent reports)</h4>
          {recent.length === 0 ? (
            <p className="text-sm text-slate-500">No report data available yet.</p>
          ) : (
            <div className="space-y-2">
              {recent.map((row) => {
                const widthPct = Math.max((Math.abs(row.net_profit) / maxAbsProfit) * 100, 4);
                const positive = row.net_profit >= 0;
                const barColor =
                  row.platform === "amazon"
                    ? "bg-[#146eb4]"
                    : row.platform === "tiktok"
                      ? "bg-[#ee1d52]"
                      : "bg-[#ff9900]";
                const textColor =
                  row.platform === "amazon"
                    ? "text-[#146eb4]"
                    : row.platform === "tiktok"
                      ? "text-[#ee1d52]"
                      : "text-[#ff9900]";
                const platformLabel =
                  row.platform === "amazon" ? "Amazon" : row.platform === "tiktok" ? "TikTok" : "Temu";
                return (
                  <div key={row.id} className="space-y-1">
                    <div className="flex items-center justify-between text-xs text-slate-600">
                      <span>
                        {shortPeriod(row.period_start, row.period_end)}{" "}
                        <span className={textColor}>({platformLabel})</span>
                      </span>
                      <span className={positive ? "text-emerald-700" : "text-rose-700"}>
                        {currency}
                        {row.net_profit.toFixed(2)}
                      </span>
                    </div>
                    <div className="h-2 rounded-full bg-slate-100">
                      <div className={`h-2 rounded-full ${barColor}`} style={{ width: `${widthPct}%` }} />
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
              <PlatformBar
                label="TikTok"
                value={platformTotals.tiktok}
                widthPct={(Math.abs(platformTotals.tiktok) / totalAbs) * 100}
                currency={currency}
                colorClass="bg-[#ee1d52]"
                labelClass="text-[#ee1d52]"
              />
            </div>
          )}
        </div>
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
        <div className={`h-3 rounded-full ${colorClass}`} style={{ width: `${Math.max(widthPct, 6)}%` }} />
      </div>
    </div>
  );
}

function SalesVsProfitChart({
  currency,
  months,
}: {
  currency: string;
  months: Array<{ periodStart: string; sales: number; profit: number }>;
}) {
  const VIEW_W = 720;
  const VIEW_H = 220;
  const PAD_L = 40;
  const PAD_R = 16;
  const PAD_T = 16;
  const PAD_B = 32;

  if (months.length === 0) {
    return (
      <div className="rounded-2xl border border-slate-200 bg-white p-4">
        <h4 className="mb-3 text-sm font-semibold text-slate-800">Monthly Sales vs Net Profit</h4>
        <p className="text-sm text-slate-500">No report data available yet.</p>
      </div>
    );
  }

  const innerW = VIEW_W - PAD_L - PAD_R;
  const innerH = VIEW_H - PAD_T - PAD_B;
  const xStep = months.length > 1 ? innerW / (months.length - 1) : 0;
  const allValues = months.flatMap((m) => [m.sales, m.profit]);
  const yMax = Math.max(...allValues, 1);
  const yMin = Math.min(...allValues, 0);
  const yRange = Math.max(yMax - yMin, 1);

  const yFor = (value: number) => PAD_T + innerH - ((value - yMin) / yRange) * innerH;
  const xFor = (idx: number) => PAD_L + idx * xStep;

  const salesPath = months
    .map((m, idx) => `${idx === 0 ? "M" : "L"} ${xFor(idx).toFixed(1)} ${yFor(m.sales).toFixed(1)}`)
    .join(" ");
  const profitPath = months
    .map((m, idx) => `${idx === 0 ? "M" : "L"} ${xFor(idx).toFixed(1)} ${yFor(m.profit).toFixed(1)}`)
    .join(" ");

  const salesArea = `${salesPath} L ${xFor(months.length - 1).toFixed(1)} ${yFor(yMin).toFixed(1)} L ${xFor(0).toFixed(1)} ${yFor(yMin).toFixed(1)} Z`;

  const yLabels = [yMax, (yMax + yMin) / 2, yMin];

  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-4">
      <div className="mb-2 flex items-center justify-between">
        <h4 className="text-sm font-semibold text-slate-800">Monthly Sales vs Net Profit</h4>
        <div className="flex items-center gap-3 text-xs text-slate-600">
          <span className="flex items-center gap-1">
            <span className="inline-block h-2 w-3 rounded-sm bg-sky-500" />
            Sales
          </span>
          <span className="flex items-center gap-1">
            <span className="inline-block h-2 w-3 rounded-sm bg-emerald-600" />
            Net Profit
          </span>
        </div>
      </div>
      <div className="overflow-x-auto">
        <svg viewBox={`0 0 ${VIEW_W} ${VIEW_H}`} className="w-full" preserveAspectRatio="xMidYMid meet">
          <rect x={0} y={0} width={VIEW_W} height={VIEW_H} fill="white" />
          {yLabels.map((value, idx) => (
            <g key={`y-${idx}`}>
              <line
                x1={PAD_L}
                x2={VIEW_W - PAD_R}
                y1={yFor(value)}
                y2={yFor(value)}
                stroke="#e2e8f0"
                strokeDasharray="2 3"
              />
              <text x={4} y={yFor(value) + 3} fontSize={9} fill="#64748b">
                {currency}
                {Math.round(value)}
              </text>
            </g>
          ))}
          <path d={salesArea} fill="rgba(14,165,233,0.15)" />
          <path d={salesPath} stroke="#0ea5e9" strokeWidth={1.5} fill="none" />
          <path d={profitPath} stroke="#059669" strokeWidth={1.5} fill="none" />
          {months.map((m, idx) => (
            <g key={`pt-${idx}`}>
              <circle cx={xFor(idx)} cy={yFor(m.sales)} r={2.5} fill="#0ea5e9" />
              <circle cx={xFor(idx)} cy={yFor(m.profit)} r={2.5} fill="#059669" />
              <text
                x={xFor(idx)}
                y={VIEW_H - 12}
                fontSize={9}
                textAnchor="middle"
                fill="#64748b"
              >
                {monthLabel(m.periodStart)}
              </text>
            </g>
          ))}
        </svg>
      </div>
    </div>
  );
}
