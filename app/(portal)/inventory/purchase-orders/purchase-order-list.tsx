"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import type { PurchaseOrderListRow } from "@/lib/inventory/documents";
import { formatUkDate } from "@/lib/utils/date";
import { inventoryHref } from "../_components/inventory-shell";
import { Card, DocStatus, EmptyState, Kpi, fmtInt, input, td, th, useMoney } from "../_components/ui";

const OPEN = new Set(["ordered", "in_production", "shipped", "partially_received"]);

export default function PurchaseOrderList({ orders, accountId, currency }: { orders: PurchaseOrderListRow[]; accountId: string; currency: string }) {
  const money = useMoney(currency);
  const [filter, setFilter] = useState<"open" | "all" | "draft" | "closed">("open");
  const [search, setSearch] = useState("");

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    return orders.filter((o) => {
      if (filter === "open" && !OPEN.has(o.status)) return false;
      if (filter === "draft" && o.status !== "draft") return false;
      if (filter === "closed" && !["received", "closed", "cancelled"].includes(o.status)) return false;
      if (q && ![o.poNumber, o.supplierName, o.destinationWarehouse].some((v) => String(v || "").toLowerCase().includes(q))) return false;
      return true;
    });
  }, [orders, filter, search]);

  const open = orders.filter((o) => OPEN.has(o.status));
  const outstanding = open.reduce((a, o) => a + Math.max(0, o.orderedUnits - o.receivedUnits), 0);
  const committed = open.reduce((a, o) => a + o.goodsValue + o.extraCosts, 0);
  const overdue = open.filter((o) => o.expectedArrivalDate && o.expectedArrivalDate < new Date().toISOString().slice(0, 10)).length;

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Kpi label="Open POs" value={open.length} />
        <Kpi label="Units outstanding" value={fmtInt(outstanding)} hint="Ordered, not yet received" />
        <Kpi label="Committed spend" value={money(committed)} hint="Goods + freight/duty on open POs" />
        <Kpi label="Overdue" value={overdue} tone={overdue ? "warn" : "default"} hint="Past expected arrival" />
      </div>
      <Card
        title="All purchase orders"
        actions={
          <>
            <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search PO, supplier…" className={`${input} sm:w-60`} />
            <select value={filter} onChange={(e) => setFilter(e.target.value as typeof filter)} className={`${input} sm:w-40`}>
              <option value="open">Open</option>
              <option value="draft">Drafts</option>
              <option value="closed">Received / closed</option>
              <option value="all">All</option>
            </select>
          </>
        }
      >
        {visible.length === 0 ? (
          <EmptyState>No purchase orders here yet. Select SKUs on the Planner and click “Create PO”, or start a new one above.</EmptyState>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full">
              <thead>
                <tr className="bg-slate-50">
                  <th className={th()}>PO</th>
                  <th className={th()}>Supplier</th>
                  <th className={th()}>Status</th>
                  <th className={th()}>Ordered</th>
                  <th className={th()}>Ready</th>
                  <th className={th()}>Arrives</th>
                  <th className={th("text-right")}>Units</th>
                  <th className={th("text-right")}>Received</th>
                  <th className={th("text-right")}>Goods</th>
                  <th className={th("text-right")}>Freight etc.</th>
                  <th className={th()}>COGS</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((o) => {
                  const pct = o.orderedUnits > 0 ? Math.round((o.receivedUnits / o.orderedUnits) * 100) : 0;
                  return (
                    <tr key={o.id} className="border-t border-slate-100 hover:bg-slate-50">
                      <td className={td()}>
                        <Link href={inventoryHref(`/inventory/purchase-orders/${o.id}`, accountId)} className="font-semibold text-plum-700 hover:underline">
                          {o.poNumber}
                        </Link>
                        {o.isLegacy ? <span className="ml-2 rounded bg-slate-100 px-1.5 py-0.5 text-[10px] uppercase text-slate-500">migrated plan</span> : null}
                        <span className="block text-xs text-slate-500">{o.lines} line{o.lines === 1 ? "" : "s"} · to {o.destinationWarehouse || "—"}</span>
                      </td>
                      <td className={td()}>{o.supplierName || <span className="text-slate-400">—</span>}</td>
                      <td className={td()}><DocStatus status={o.status} /></td>
                      <td className={td("whitespace-nowrap")}>{o.orderDate ? formatUkDate(o.orderDate) : "—"}</td>
                      <td className={td("whitespace-nowrap")}>{o.expectedReadyDate ? formatUkDate(o.expectedReadyDate) : "—"}</td>
                      <td className={td("whitespace-nowrap")}>{o.expectedArrivalDate ? formatUkDate(o.expectedArrivalDate) : "—"}</td>
                      <td className={td("text-right")}>{fmtInt(o.orderedUnits)}</td>
                      <td className={td("text-right")}>
                        {fmtInt(o.receivedUnits)}
                        {o.orderedUnits > 0 ? (
                          <span className="mt-1 block h-1.5 w-20 overflow-hidden rounded bg-slate-100">
                            <span className="block h-full bg-emerald-500" style={{ width: `${Math.min(100, pct)}%` }} />
                          </span>
                        ) : null}
                      </td>
                      <td className={td("text-right")}>{money(o.goodsValue)}</td>
                      <td className={td("text-right")}>{o.extraCosts ? money(o.extraCosts) : <span className="text-slate-400">—</span>}</td>
                      <td className={td()}>{o.cogsAppliedAt ? <span className="text-xs text-emerald-700">applied</span> : <span className="text-xs text-slate-400">—</span>}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
