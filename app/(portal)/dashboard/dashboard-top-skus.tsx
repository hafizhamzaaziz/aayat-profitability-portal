type TopSkuRow = {
  sku: string;
  description: string | null;
  units: number;
  net_sales: number;
  net_profit: number;
};

function formatMoney(value: number, currency: string): string {
  const abs = Math.abs(value);
  const sign = value < 0 ? "-" : "";
  return `${sign}${currency}${abs.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export default function DashboardTopSkus({
  currency,
  rows,
}: {
  currency: string;
  rows: TopSkuRow[];
}) {
  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-4">
      <h4 className="mb-3 text-sm font-semibold text-slate-800">Top SKUs by Net Profit</h4>
      {rows.length === 0 ? (
        <p className="text-sm text-slate-500">
          No per-SKU profitability data available for the selected period. Generate a report to populate.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead className="text-left text-xs uppercase tracking-wide text-slate-500">
              <tr>
                <th className="py-2 pr-4">SKU</th>
                <th className="py-2 pr-4">Product</th>
                <th className="py-2 pr-4 text-right">Units</th>
                <th className="py-2 pr-4 text-right">Net Sales</th>
                <th className="py-2 pr-4 text-right">Net Profit</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.sku} className="border-t border-slate-100">
                  <td className="py-2 pr-4 font-mono text-xs">{row.sku}</td>
                  <td className="py-2 pr-4 text-slate-700" title={row.description || "—"}>
                    <span className="line-clamp-1 inline-block max-w-[260px] align-middle">
                      {row.description || "—"}
                    </span>
                  </td>
                  <td className="py-2 pr-4 text-right">{row.units.toLocaleString()}</td>
                  <td className="py-2 pr-4 text-right">{formatMoney(row.net_sales, currency)}</td>
                  <td
                    className={`py-2 pr-4 text-right font-semibold ${
                      row.net_profit < 0 ? "text-red-700" : "text-emerald-700"
                    }`}
                  >
                    {formatMoney(row.net_profit, currency)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
