type Totals = {
  netProfit: number;
  vatPosition: number;
  totalSales: number;
  totalCogs?: number;
  totalFees?: number;
};

function formatMoney(value: number, currency: string): string {
  const abs = Math.abs(value);
  const sign = value < 0 ? "-" : "";
  return `${sign}${currency}${abs.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function pctDelta(current: number, prior: number): { label: string; tone: "up" | "down" | "flat" } {
  if (!Number.isFinite(prior) || prior === 0) return { label: "—", tone: "flat" };
  const delta = ((current - prior) / Math.abs(prior)) * 100;
  if (Math.abs(delta) < 0.05) return { label: "0.0%", tone: "flat" };
  return {
    label: `${delta > 0 ? "+" : ""}${delta.toFixed(1)}%`,
    tone: delta > 0 ? "up" : "down",
  };
}

function Kpi({
  label,
  current,
  prior,
  currency,
  hasPrior,
  inverseTone = false,
}: {
  label: string;
  current: number;
  prior: number;
  currency: string;
  hasPrior: boolean;
  inverseTone?: boolean;
}) {
  const d = pctDelta(current, prior);
  const visualTone =
    d.tone === "flat"
      ? "text-slate-500"
      : inverseTone
      ? d.tone === "up"
        ? "text-red-700"
        : "text-emerald-700"
      : d.tone === "up"
      ? "text-emerald-700"
      : "text-red-700";
  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-4">
      <p className="text-xs uppercase tracking-wide text-slate-500">{label}</p>
      <p className="mt-1 text-xl font-semibold text-slate-900">{formatMoney(current, currency)}</p>
      <p className={`mt-1 text-xs font-medium ${visualTone}`}>
        {hasPrior ? `${d.label} vs prior period` : "no prior period"}
      </p>
    </div>
  );
}

export default function DashboardKpis({
  currency,
  current,
  prior,
  hasPrior,
}: {
  currency: string;
  current: Totals;
  prior: Totals;
  hasPrior: boolean;
}) {
  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      <Kpi label="Total Sales" current={current.totalSales} prior={prior.totalSales} currency={currency} hasPrior={hasPrior} />
      <Kpi label="Net Profit" current={current.netProfit} prior={prior.netProfit} currency={currency} hasPrior={hasPrior} />
      <Kpi
        label="VAT Position"
        current={current.vatPosition}
        prior={prior.vatPosition}
        currency={currency}
        hasPrior={hasPrior}
        inverseTone
      />
      <Kpi
        label="COGS + Fees"
        current={(current.totalCogs || 0) + (current.totalFees || 0)}
        prior={(prior.totalCogs || 0) + (prior.totalFees || 0)}
        currency={currency}
        hasPrior={hasPrior}
        inverseTone
      />
    </div>
  );
}
