type Totals = {
  netProfit: number;
  vatPosition: number;
  totalSales: number;
  totalCogs?: number;
  totalFees?: number;
  units?: number;
  adsSpend?: number;
  acos?: number | null;
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
  display,
  current,
  prior,
  hasPrior,
  inverseTone = false,
}: {
  label: string;
  display: string;
  current: number;
  prior: number;
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
      <p className="mt-1 text-xl font-semibold text-slate-900">{display}</p>
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
  forecast = false,
}: {
  currency: string;
  current: Totals;
  prior: Totals;
  hasPrior: boolean;
  forecast?: boolean;
}) {
  const acos = current.acos == null ? "—" : `${(current.acos * 100).toFixed(1)}%`;
  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-4">
      <Kpi
        label={forecast ? "Sales (forecast)" : "Total Sales"}
        display={formatMoney(current.totalSales, currency)}
        current={current.totalSales}
        prior={prior.totalSales}
        hasPrior={hasPrior}
      />
      <Kpi
        label="Units"
        display={Number(current.units || 0).toLocaleString(undefined, { maximumFractionDigits: 0 })}
        current={Number(current.units || 0)}
        prior={Number(prior.units || 0)}
        hasPrior={hasPrior}
      />
      <Kpi
        label={forecast ? "Net Profit (forecast)" : "Net Profit"}
        display={formatMoney(current.netProfit, currency)}
        current={current.netProfit}
        prior={prior.netProfit}
        hasPrior={hasPrior}
      />
      <Kpi
        label="VAT Position"
        display={formatMoney(current.vatPosition, currency)}
        current={current.vatPosition}
        prior={prior.vatPosition}
        hasPrior={hasPrior}
        inverseTone
      />
      <Kpi
        label="COGS + Fees"
        display={formatMoney((current.totalCogs || 0) + (current.totalFees || 0), currency)}
        current={(current.totalCogs || 0) + (current.totalFees || 0)}
        prior={(prior.totalCogs || 0) + (prior.totalFees || 0)}
        hasPrior={hasPrior}
        inverseTone
      />
      <Kpi
        label="Ads spend"
        display={formatMoney(current.adsSpend || 0, currency)}
        current={Number(current.adsSpend || 0)}
        prior={Number(prior.adsSpend || 0)}
        hasPrior={hasPrior}
        inverseTone
      />
      <Kpi
        label="ACOS"
        display={acos}
        current={Number(current.acos || 0)}
        prior={Number(prior.acos || 0)}
        hasPrior={hasPrior}
        inverseTone
      />
      <Kpi
        label="Margin"
        display={
          current.totalSales > 0 ? `${((current.netProfit / current.totalSales) * 100).toFixed(1)}%` : "—"
        }
        current={current.totalSales > 0 ? current.netProfit / current.totalSales : 0}
        prior={prior.totalSales > 0 ? prior.netProfit / prior.totalSales : 0}
        hasPrior={hasPrior}
      />
    </div>
  );
}
