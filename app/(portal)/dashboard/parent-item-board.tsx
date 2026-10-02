"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { formatUkDate } from "@/lib/utils/date";
import type { ParentItemCard, ParentProductRow } from "@/lib/dashboard/parent-item";
import type { PeriodPreset } from "@/lib/utils/period-presets";

const ORDER: PeriodPreset[] = ["today", "yesterday", "mtd", "this_month_forecast", "last_month"];

const LABELS: Record<string, string> = {
  today: "Today",
  yesterday: "Yesterday",
  mtd: "Month to date",
  this_month_forecast: "This month (forecast)",
  last_month: "Last month",
};

const TONES: Record<string, string> = {
  today: "border-blue-600",
  yesterday: "border-teal-600",
  mtd: "border-sky-500",
  this_month_forecast: "border-emerald-400",
  last_month: "border-green-700",
};

function money(value: number, currency: string) {
  return `${currency}${value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export default function ParentItemBoard({
  accountId,
  currency,
  cards,
}: {
  accountId: string;
  currency: string;
  cards: ParentItemCard[];
}) {
  const router = useRouter();
  const [selected, setSelected] = useState<PeriodPreset>("mtd");
  const [open, setOpen] = useState<PeriodPreset | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const byPreset = useMemo(() => {
    const map = new Map<string, ParentItemCard>();
    for (const card of cards) map.set(card.preset, card);
    return map;
  }, [cards]);
  const active = byPreset.get(selected) || cards[0] || null;

  const refresh = async () => {
    setRefreshing(true);
    setMessage(null);
    try {
      const response = await fetch("/api/amazon/sales-traffic", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ accountId }),
      });
      const body = (await response.json()) as { ok?: boolean; error?: string };
      if (!response.ok || !body.ok) throw new Error(body.error || "Amazon report failed");
      setMessage("Parent-item report loaded. Performance rows for the latest completed week now use those parent ASINs.");
      router.refresh();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Amazon report failed");
    } finally {
      setRefreshing(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-xs text-slate-500">
          Sales, units, orders and refunds are ordered-product figures from Amazon’s parent-item business report. VAT sits beside sales and is not taken off profit.
        </p>
        <button
          type="button"
          onClick={() => void refresh()}
          disabled={refreshing}
          className="rounded-lg bg-slate-900 px-3 py-2 text-sm font-semibold text-white disabled:opacity-60"
        >
          {refreshing ? "Loading Amazon report…" : "Refresh parent-item report"}
        </button>
      </div>
      {message ? <p className="rounded-xl bg-slate-50 px-3 py-2 text-sm text-slate-700">{message}</p> : null}
      {cards.length === 0 ? (
        <p className="rounded-2xl border border-slate-200 bg-white p-4 text-sm text-slate-600">
          No parent-item report is stored yet. Refresh to pull Today, Yesterday, Month to date and Last month from Amazon.
        </p>
      ) : null}
      <div className="grid gap-3 xl:grid-cols-5 md:grid-cols-2">
        {ORDER.map((preset) => {
          const card = byPreset.get(preset);
          const expanded = open === preset;
          return (
            <button
              key={preset}
              type="button"
              onClick={() => setSelected(preset)}
              className={`rounded-2xl border-t-4 bg-white p-4 text-left shadow-sm ${TONES[preset] || "border-slate-300"} ${
                selected === preset ? "ring-2 ring-slate-900" : ""
              }`}
            >
              <p className="text-sm font-semibold text-slate-900">{LABELS[preset]}</p>
              <p className="text-xs text-slate-500">
                {card ? `${formatUkDate(card.from)} – ${formatUkDate(card.to)}` : "Not loaded"}
              </p>
              <p className="mt-3 text-xs uppercase tracking-wide text-slate-500">Sales</p>
              <p className="text-2xl font-semibold text-slate-900">{card ? money(card.sales, currency) : "—"}</p>
              <p className="mt-1 text-xs text-slate-500">VAT {card ? money(card.vat, currency) : "—"} · not in profit</p>
              <div className="mt-3 grid grid-cols-2 gap-2 text-sm">
                <div>
                  <p className="text-xs text-slate-500">Orders / Units</p>
                  <p className="font-medium">{card ? `${card.orders.toLocaleString()} / ${card.units.toLocaleString()}` : "—"}</p>
                </div>
                <div>
                  <p className="text-xs text-slate-500">Refunds</p>
                  <p className="font-medium">{card ? card.refunds.toLocaleString() : "—"}</p>
                </div>
              </div>
              <p className="mt-3 text-xs text-slate-500">Ads, fees and cost of goods are not on this Amazon report.</p>
              {expanded && card ? (
                <p className="mt-2 text-xs text-slate-600">
                  {card.products.length} parent ASINs. VAT {money(card.vat, currency)} is {card.sales > 0 ? `${((card.vat / card.sales) * 100).toFixed(0)}% of sales` : "—"}.
                </p>
              ) : null}
              <span
                className="mt-3 inline-block text-xs font-semibold text-blue-700"
                onClick={(event) => {
                  event.stopPropagation();
                  setSelected(preset);
                  setOpen(expanded ? null : preset);
                }}
              >
                {expanded ? "Hide" : "More"}
              </span>
            </button>
          );
        })}
      </div>
      <ParentTable currency={currency} card={active} />
    </div>
  );
}

function ParentTable({ currency, card }: { currency: string; card: ParentItemCard | null }) {
  const rows: ParentProductRow[] = card?.products || [];
  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-4">
      <h3 className="text-sm font-semibold text-slate-900">
        {card ? LABELS[card.preset] : "Parent items"} · parent ASINs
      </h3>
      <p className="mt-1 text-xs text-slate-500">Same (Parent) ASIN column as Seller Central’s detail page sales and traffic by parent item.</p>
      {rows.length === 0 ? (
        <p className="mt-3 text-sm text-slate-500">No parent rows for this period yet.</p>
      ) : (
        <div className="mt-3 overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead className="text-left text-xs uppercase tracking-wide text-slate-500">
              <tr>
                <th className="py-2 pr-4">Parent ASIN</th>
                <th className="py-2 pr-4">Units</th>
                <th className="py-2 pr-4">Orders</th>
                <th className="py-2 pr-4">Refunds</th>
                <th className="py-2 pr-4">Ordered product sales</th>
                <th className="py-2 pr-4">VAT</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.parentAsin} className="border-t border-slate-100">
                  <td className="py-2 pr-4 font-mono text-xs">{row.parentAsin}</td>
                  <td className="py-2 pr-4">{row.units.toLocaleString()}</td>
                  <td className="py-2 pr-4">{row.orders.toLocaleString()}</td>
                  <td className="py-2 pr-4">{row.refunds.toLocaleString()}</td>
                  <td className="py-2 pr-4">{money(row.sales, currency)}</td>
                  <td className="py-2 pr-4">{money(row.vat, currency)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
