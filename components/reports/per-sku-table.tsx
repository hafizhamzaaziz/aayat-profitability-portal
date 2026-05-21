"use client";

import { useMemo, useState } from "react";

export type PerSkuRow = {
  sku: string;
  description?: string;
  units: number;
  netSales: number;
  cogs: number;
  sellingFeesExvat: number;
  fbaFeesExvat: number;
  otherTxFeesExvat: number;
  deliveryServicesExvat: number;
  advertisingAlloc: number;
  fbaInventoryAlloc: number;
  subscriptionAlloc: number;
  dealFeesAlloc: number;
  fbaReimbursements: number;
  grossProfit: number;
  netProfit: number;
  netMargin: number;
  costKnown: boolean;
  adOnly: boolean;
};

type SortKey = keyof Pick<
  PerSkuRow,
  | "sku"
  | "units"
  | "netSales"
  | "cogs"
  | "advertisingAlloc"
  | "grossProfit"
  | "netProfit"
  | "netMargin"
>;

type Props = {
  rows: PerSkuRow[];
  currency: string;
  /** When true, shows extra columns (FBA inventory alloc, subscription, deal fees). */
  detailed?: boolean;
  /** Filename used for the CSV export (without .csv extension). */
  csvFilename?: string;
};

const CSV_HEADER = [
  "SKU",
  "Description",
  "Units",
  "Net Sales (ex-VAT)",
  "COGS (ex-VAT)",
  "Selling Fees (ex-VAT)",
  "FBA Fees (ex-VAT)",
  "Other Tx Fees (ex-VAT)",
  "Delivery Services (ex-VAT)",
  "Advertising Alloc (ex-VAT)",
  "FBA Inventory Alloc (ex-VAT)",
  "Subscription Alloc (ex-VAT)",
  "Deal Fees Alloc (ex-VAT)",
  "FBA Reimbursements",
  "Gross Profit",
  "Net Profit",
  "Net Margin %",
  "COGS Mapped",
  "Ad-Only",
];

function csvEscape(value: string | number | boolean) {
  const s = String(value ?? "");
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function rowsToCsv(rows: PerSkuRow[]): string {
  const out = [CSV_HEADER.map(csvEscape).join(",")];
  for (const r of rows) {
    out.push(
      [
        r.sku,
        r.description || "",
        r.units,
        r.netSales.toFixed(2),
        r.cogs.toFixed(2),
        r.sellingFeesExvat.toFixed(2),
        r.fbaFeesExvat.toFixed(2),
        r.otherTxFeesExvat.toFixed(2),
        r.deliveryServicesExvat.toFixed(2),
        r.advertisingAlloc.toFixed(2),
        r.fbaInventoryAlloc.toFixed(2),
        r.subscriptionAlloc.toFixed(2),
        r.dealFeesAlloc.toFixed(2),
        r.fbaReimbursements.toFixed(2),
        r.grossProfit.toFixed(2),
        r.netProfit.toFixed(2),
        r.netSales > 0 ? (r.netMargin * 100).toFixed(2) : "",
        r.costKnown ? "yes" : "no",
        r.adOnly ? "yes" : "no",
      ]
        .map(csvEscape)
        .join(",")
    );
  }
  return out.join("\n");
}

function downloadCsv(filename: string, text: string) {
  const blob = new Blob([text], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename.endsWith(".csv") ? filename : `${filename}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

const m = (value: number, currency: string) => {
  const abs = Math.abs(value).toFixed(2);
  return value < 0 ? `-${currency}${abs}` : `${currency}${abs}`;
};

const pct = (value: number) => `${(value * 100).toFixed(1)}%`;

function ProfitCell({ value, currency }: { value: number; currency: string }) {
  const color = value > 0 ? "text-emerald-700" : value < 0 ? "text-red-700" : "text-slate-700";
  return <span className={`font-semibold ${color}`}>{m(value, currency)}</span>;
}

export default function PerSkuTable({ rows, currency, detailed, csvFilename }: Props) {
  const [sortKey, setSortKey] = useState<SortKey>("netProfit");
  const [sortAsc, setSortAsc] = useState(false);
  const [search, setSearch] = useState("");

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    let out = rows;
    if (q) {
      out = rows.filter(
        (r) =>
          r.sku.toLowerCase().includes(q) ||
          (r.description || "").toLowerCase().includes(q)
      );
    }
    const sorted = [...out].sort((a, b) => {
      const av = a[sortKey];
      const bv = b[sortKey];
      if (typeof av === "string" && typeof bv === "string") {
        return sortAsc ? av.localeCompare(bv) : bv.localeCompare(av);
      }
      const an = Number(av) || 0;
      const bn = Number(bv) || 0;
      return sortAsc ? an - bn : bn - an;
    });
    return sorted;
  }, [rows, search, sortKey, sortAsc]);

  const header = (key: SortKey, label: string, alignRight = true) => {
    const isActive = key === sortKey;
    const className = `${alignRight ? "text-right" : "text-left"} px-2 py-2 text-xs font-semibold uppercase tracking-wide cursor-pointer select-none ${
      isActive ? "text-[var(--md-primary)]" : "text-slate-600"
    }`;
    return (
      <th
        scope="col"
        className={className}
        onClick={() => {
          if (key === sortKey) setSortAsc((prev) => !prev);
          else {
            setSortKey(key);
            setSortAsc(false);
          }
        }}
      >
        <span className="inline-flex items-center gap-1">
          {label}
          {isActive ? <span aria-hidden="true">{sortAsc ? "▲" : "▼"}</span> : null}
        </span>
      </th>
    );
  };

  const totals = useMemo(() => {
    const sum = (k: keyof PerSkuRow) =>
      filtered.reduce((acc, r) => acc + Number(r[k] || 0), 0);
    return {
      units: sum("units"),
      netSales: sum("netSales"),
      cogs: sum("cogs"),
      sellingFeesExvat: sum("sellingFeesExvat"),
      fbaFeesExvat: sum("fbaFeesExvat"),
      otherTxFeesExvat: sum("otherTxFeesExvat"),
      deliveryServicesExvat: sum("deliveryServicesExvat"),
      advertisingAlloc: sum("advertisingAlloc"),
      fbaInventoryAlloc: sum("fbaInventoryAlloc"),
      subscriptionAlloc: sum("subscriptionAlloc"),
      dealFeesAlloc: sum("dealFeesAlloc"),
      fbaReimbursements: sum("fbaReimbursements"),
      grossProfit: sum("grossProfit"),
      netProfit: sum("netProfit"),
    };
  }, [filtered]);

  const totalNetMargin =
    totals.netSales > 0 ? totals.netProfit / totals.netSales : 0;

  if (rows.length === 0) {
    return (
      <p className="rounded-2xl bg-slate-50 px-3 py-4 text-sm text-slate-600">
        No per-SKU data for this period.
      </p>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Filter SKU or description"
            className="w-64 rounded-lg border border-slate-300 px-3 py-2 text-sm"
          />
          <span className="text-xs text-slate-500">
            {filtered.length} of {rows.length} SKUs
          </span>
        </div>
        <div className="flex items-center gap-2 text-xs">
          <button
            type="button"
            onClick={() => {
              setSortKey("netProfit");
              setSortAsc(false);
            }}
            className="rounded-lg bg-slate-100 px-2 py-1 font-semibold text-slate-700"
          >
            Sort: Net Profit ↓
          </button>
          <button
            type="button"
            onClick={() => {
              setSortKey("netProfit");
              setSortAsc(true);
            }}
            className="rounded-lg bg-slate-100 px-2 py-1 font-semibold text-slate-700"
          >
            Worst first
          </button>
          <button
            type="button"
            onClick={() => downloadCsv(csvFilename || "per-sku-profitability", rowsToCsv(filtered))}
            className="rounded-lg bg-slate-900 px-2 py-1 font-semibold text-white"
            title={`Download ${filtered.length} rows as CSV`}
          >
            Download CSV
          </button>
        </div>
      </div>

      <div className="max-h-[70vh] overflow-auto rounded-2xl border border-slate-200">
        <table className="min-w-full border-separate border-spacing-0 text-sm [&_tbody_td]:border-t [&_tbody_td]:border-slate-100">
          <thead className="sticky top-0 z-20 bg-slate-50 shadow-[0_1px_0_0_#e2e8f0]">
            <tr>
              {header("sku", "SKU", false)}
              {header("units", "Units")}
              {header("netSales", "Net Sales")}
              {header("cogs", "COGS")}
              {header("advertisingAlloc", "Advertising")}
              {detailed ? (
                <>
                  <th className="px-2 py-2 text-right text-xs font-semibold uppercase tracking-wide text-slate-600">
                    Selling
                  </th>
                  <th className="px-2 py-2 text-right text-xs font-semibold uppercase tracking-wide text-slate-600">
                    FBA
                  </th>
                  <th className="px-2 py-2 text-right text-xs font-semibold uppercase tracking-wide text-slate-600">
                    FBA Inv
                  </th>
                  <th className="px-2 py-2 text-right text-xs font-semibold uppercase tracking-wide text-slate-600">
                    Subscr
                  </th>
                  <th className="px-2 py-2 text-right text-xs font-semibold uppercase tracking-wide text-slate-600">
                    Deal
                  </th>
                  <th className="px-2 py-2 text-right text-xs font-semibold uppercase tracking-wide text-slate-600">
                    Reimburse
                  </th>
                </>
              ) : null}
              {header("grossProfit", "Gross")}
              {header("netProfit", "Net Profit")}
              {header("netMargin", "Margin")}
            </tr>
          </thead>
          <tbody>
            {filtered.map((row) => {
              const flag = !row.costKnown
                ? { tip: "No COGS mapped", className: "bg-yellow-50" }
                : row.adOnly
                  ? { tip: "Ad-only — no sales this period", className: "bg-orange-50" }
                  : null;
              return (
                <tr key={row.sku} className={`${flag?.className || ""}`}>
                  <td className="px-2 py-2">
                    <div className="font-mono text-xs font-semibold text-slate-800">{row.sku}</div>
                    {row.description ? (
                      <div className="line-clamp-1 max-w-[280px] text-[11px] text-slate-500">
                        {row.description}
                      </div>
                    ) : null}
                    {flag ? (
                      <div className="text-[11px] text-amber-700">{flag.tip}</div>
                    ) : null}
                  </td>
                  <td className="px-2 py-2 text-right tabular-nums">{row.units.toLocaleString()}</td>
                  <td className="px-2 py-2 text-right tabular-nums">{m(row.netSales, currency)}</td>
                  <td className="px-2 py-2 text-right tabular-nums">{m(row.cogs, currency)}</td>
                  <td className="px-2 py-2 text-right tabular-nums">{m(row.advertisingAlloc, currency)}</td>
                  {detailed ? (
                    <>
                      <td className="px-2 py-2 text-right tabular-nums">{m(row.sellingFeesExvat, currency)}</td>
                      <td className="px-2 py-2 text-right tabular-nums">{m(row.fbaFeesExvat, currency)}</td>
                      <td className="px-2 py-2 text-right tabular-nums">{m(row.fbaInventoryAlloc, currency)}</td>
                      <td className="px-2 py-2 text-right tabular-nums">{m(row.subscriptionAlloc, currency)}</td>
                      <td className="px-2 py-2 text-right tabular-nums">{m(row.dealFeesAlloc, currency)}</td>
                      <td className="px-2 py-2 text-right tabular-nums">{m(row.fbaReimbursements, currency)}</td>
                    </>
                  ) : null}
                  <td className="px-2 py-2 text-right tabular-nums">{m(row.grossProfit, currency)}</td>
                  <td className="px-2 py-2 text-right tabular-nums">
                    <ProfitCell value={row.netProfit} currency={currency} />
                  </td>
                  <td className="px-2 py-2 text-right tabular-nums text-xs text-slate-600">
                    {row.netSales > 0 ? pct(row.netMargin) : "—"}
                  </td>
                </tr>
              );
            })}
          </tbody>
          <tfoot className="sticky bottom-0 z-20 bg-slate-100 shadow-[0_-1px_0_0_#cbd5e1]">
            <tr className="font-semibold">
              <td className="px-2 py-2">Total ({filtered.length} SKUs)</td>
              <td className="px-2 py-2 text-right tabular-nums">{totals.units.toLocaleString()}</td>
              <td className="px-2 py-2 text-right tabular-nums">{m(totals.netSales, currency)}</td>
              <td className="px-2 py-2 text-right tabular-nums">{m(totals.cogs, currency)}</td>
              <td className="px-2 py-2 text-right tabular-nums">{m(totals.advertisingAlloc, currency)}</td>
              {detailed ? (
                <>
                  <td className="px-2 py-2 text-right tabular-nums">{m(totals.sellingFeesExvat, currency)}</td>
                  <td className="px-2 py-2 text-right tabular-nums">{m(totals.fbaFeesExvat, currency)}</td>
                  <td className="px-2 py-2 text-right tabular-nums">{m(totals.fbaInventoryAlloc, currency)}</td>
                  <td className="px-2 py-2 text-right tabular-nums">{m(totals.subscriptionAlloc, currency)}</td>
                  <td className="px-2 py-2 text-right tabular-nums">{m(totals.dealFeesAlloc, currency)}</td>
                  <td className="px-2 py-2 text-right tabular-nums">{m(totals.fbaReimbursements, currency)}</td>
                </>
              ) : null}
              <td className="px-2 py-2 text-right tabular-nums">{m(totals.grossProfit, currency)}</td>
              <td className="px-2 py-2 text-right tabular-nums">
                <ProfitCell value={totals.netProfit} currency={currency} />
              </td>
              <td className="px-2 py-2 text-right tabular-nums text-xs text-slate-600">
                {totals.netSales > 0 ? pct(totalNetMargin) : "—"}
              </td>
            </tr>
          </tfoot>
        </table>
      </div>

      <p className="text-[11px] text-slate-500">
        Allocations: Advertising — per-SKU from the uploaded ads report when present, otherwise pro-rata to net sales.
        FBA Inventory Fees — pro-rata to units sold. Subscription &amp; Deal Fees — pro-rata to net sales.
      </p>
    </div>
  );
}
