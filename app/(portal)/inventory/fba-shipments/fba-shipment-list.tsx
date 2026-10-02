"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import type { FbaShipmentListRow } from "@/lib/inventory/documents";
import { formatUkDate } from "@/lib/utils/date";
import { inventoryHref } from "../_components/inventory-shell";
import { Card, DocStatus, EmptyState, Kpi, fmtInt, input, td, th } from "../_components/ui";

export default function FbaShipmentList({ shipments, accountId }: { shipments: FbaShipmentListRow[]; accountId: string }) {
  const [filter, setFilter] = useState<"open" | "all" | "closed">("open");
  const [search, setSearch] = useState("");

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    return shipments.filter((s) => {
      if (filter === "open" && !["draft", "shipped", "receiving"].includes(s.status)) return false;
      if (filter === "closed" && !["closed", "cancelled"].includes(s.status)) return false;
      if (q && ![s.name, s.amazonShipmentId, s.poNumber, s.sourceWarehouse].some((v) => String(v || "").toLowerCase().includes(q))) return false;
      return true;
    });
  }, [shipments, filter, search]);

  const inTransit = shipments.filter((s) => s.status === "shipped" || s.status === "receiving");
  const transitUnits = inTransit.reduce((a, s) => a + Math.max(0, s.sentUnits - s.receivedUnits), 0);
  const drafts = shipments.filter((s) => s.status === "draft");
  const discrepancies = shipments.filter((s) => s.status === "closed" && s.receivedUnits !== s.sentUnits).length;

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Kpi label="In transit" value={inTransit.length} hint={`${fmtInt(transitUnits)} units not yet checked in`} />
        <Kpi label="Drafts" value={drafts.length} hint={`${fmtInt(drafts.reduce((a, s) => a + s.plannedUnits, 0))} units planned`} />
        <Kpi label="Closed with discrepancy" value={discrepancies} tone={discrepancies ? "warn" : "default"} hint="Received ≠ sent" />
        <Kpi label="Total shipments" value={shipments.length} />
      </div>
      <Card
        title="All shipments"
        actions={
          <>
            <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search name, FBA ID, PO…" className={`${input} sm:w-60`} />
            <select value={filter} onChange={(e) => setFilter(e.target.value as typeof filter)} className={`${input} sm:w-40`}>
              <option value="open">Open</option>
              <option value="closed">Closed / cancelled</option>
              <option value="all">All</option>
            </select>
          </>
        }
      >
        {visible.length === 0 ? (
          <EmptyState>No shipments here. Select SKUs on the Planner and click “Create FBA shipment”, or start a new one above.</EmptyState>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full">
              <thead>
                <tr className="bg-slate-50">
                  <th className={th()}>Shipment</th>
                  <th className={th()}>Amazon ID</th>
                  <th className={th()}>Status</th>
                  <th className={th()}>From</th>
                  <th className={th()}>Shipped</th>
                  <th className={th()}>Expected</th>
                  <th className={th("text-right")}>Planned</th>
                  <th className={th("text-right")}>Sent</th>
                  <th className={th("text-right")}>Received</th>
                  <th className={th("text-right")}>Cartons</th>
                  <th className={th()}>PO</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((s) => {
                  const diff = s.sentUnits - s.receivedUnits;
                  return (
                    <tr key={s.id} className="border-t border-slate-100 hover:bg-slate-50">
                      <td className={td()}>
                        <Link href={inventoryHref(`/inventory/fba-shipments/${s.id}`, accountId)} className="font-semibold text-plum-700 hover:underline">{s.name}</Link>
                        {s.isLegacy ? <span className="ml-2 rounded bg-slate-100 px-1.5 py-0.5 text-[10px] uppercase text-slate-500">migrated plan</span> : null}
                        <span className="block text-xs text-slate-500">{s.lines} line{s.lines === 1 ? "" : "s"}</span>
                      </td>
                      <td className={td("font-mono text-xs")}>{s.amazonShipmentId || <span className="text-slate-400">—</span>}</td>
                      <td className={td()}><DocStatus status={s.status} /></td>
                      <td className={td()}>{s.sourceWarehouse || "—"}</td>
                      <td className={td("whitespace-nowrap")}>{s.shipDate ? formatUkDate(s.shipDate) : "—"}</td>
                      <td className={td("whitespace-nowrap")}>{s.expectedArrivalDate ? formatUkDate(s.expectedArrivalDate) : "—"}</td>
                      <td className={td("text-right")}>{fmtInt(s.plannedUnits)}</td>
                      <td className={td("text-right")}>{s.status === "draft" ? "—" : fmtInt(s.sentUnits)}</td>
                      <td className={td("text-right")}>
                        {s.status === "draft" ? "—" : fmtInt(s.receivedUnits)}
                        {s.status === "closed" && diff !== 0 ? <span className="block text-[11px] text-amber-700">{diff > 0 ? `${diff} short` : `${-diff} over`}</span> : null}
                      </td>
                      <td className={td("text-right")}>{s.boxes ? fmtInt(s.boxes) : "—"}</td>
                      <td className={td("text-xs")}>{s.poNumber || <span className="text-slate-400">—</span>}</td>
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
