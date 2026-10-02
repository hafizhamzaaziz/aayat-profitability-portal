"use client";

import Link from "next/link";
import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { InventoryWorkspace } from "@/lib/inventory/workspace";
import { formatUkDate } from "@/lib/utils/date";
import { deleteMovement, recordAdjustment, recordStockTake, refreshFbaStock, type AdjustmentType } from "../actions";
import { inventoryHref } from "../_components/inventory-shell";
import { Card, EmptyState, Field, Kpi, Modal, Notice, SkuPicker, btn, fmtInt, input, inputSm, td, th, useMoney } from "../_components/ui";

export type LedgerEvent = {
  id: string;
  kind: "movement" | "stock_take";
  mappingId: string;
  date: string;
  createdAt: string;
  type: string;
  location: string;
  delta: number;
  fba?: number;
  warehouseUnits?: number;
  warehouse: string | null;
  reference: { label: string; href: string } | null;
  notes: string | null;
  deletable: boolean;
};

const TYPE_LABEL: Record<string, string> = {
  po_receipt: "PO received at 3PL",
  fba_shipment_out: "Shipped to FBA",
  fba_received: "Amazon checked in",
  customer_return: "Customer return",
  b2b_outbound: "B2B / wholesale out",
  damaged: "Damaged / written off",
  adjustment: "Manual correction",
  stock_take: "Stock take",
  // legacy types
  inbound: "Inbound (legacy)",
  outbound: "Outbound (legacy)",
  transfer: "Transfer (legacy)",
  reconciliation: "Reconciliation (legacy)",
};

const ADJUSTMENT_OPTIONS: Array<{ value: AdjustmentType; label: string; hint: string }> = [
  { value: "customer_return", label: "Customer return (adds stock)", hint: "A sellable unit came back to the 3PL." },
  { value: "b2b_outbound", label: "B2B / wholesale order (removes stock)", hint: "Units sold outside Amazon, Temu and TikTok." },
  { value: "damaged", label: "Damaged / written off (removes stock)", hint: "Units that can no longer be sold." },
  { value: "adjustment", label: "Manual correction (+ / −)", hint: "Enter a negative number to reduce stock." },
];

type Mode = "view" | "count";

export default function StockWorkspace({ workspace, accountId, canEdit, events }: { workspace: InventoryWorkspace; accountId: string; canEdit: boolean; events: LedgerEvent[] }) {
  const router = useRouter();
  const money = useMoney(workspace.currency);
  const [pending, startTransition] = useTransition();
  const [notice, setNotice] = useState<{ kind: "ok" | "error" | "info"; text: string } | null>(null);
  const [mode, setMode] = useState<Mode>("view");
  const [search, setSearch] = useState("");
  const [onlyDrift, setOnlyDrift] = useState(false);
  const [countDate, setCountDate] = useState(workspace.today);
  const [countNotes, setCountNotes] = useState("");
  const [counts, setCounts] = useState<Record<string, { fba: string; wh: string }>>({});
  const [adjusting, setAdjusting] = useState(false);
  const [ledgerSku, setLedgerSku] = useState("");
  const [ledgerType, setLedgerType] = useState("");

  const skuById = useMemo(() => new Map(workspace.skus.map((s) => [s.mappingId, s])), [workspace.skus]);
  const rowById = useMemo(() => new Map(workspace.rows.map((r) => [r.mappingId, r])), [workspace.rows]);

  const stockRows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return workspace.skus
      .filter((s) => {
        if (q && !`${s.productName} ${s.amazonSku || ""} ${s.asin || ""} ${s.temuSkuId || ""} ${s.tiktokSku || ""}`.toLowerCase().includes(q)) return false;
        if (onlyDrift) {
          const drift = (s.warehouseRaw != null && s.warehouseRaw < 0) || (s.fbaRaw != null && s.fbaRaw < 0 && s.fbaSource !== "live");
          if (!drift) return false;
        }
        return true;
      })
      .map((s) => ({ sku: s, row: rowById.get(s.mappingId)! }))
      .sort((a, b) => a.sku.productName.localeCompare(b.sku.productName));
  }, [workspace.skus, rowById, search, onlyDrift]);

  const totals = useMemo(() => {
    let fba = 0, transit = 0, wh = 0, onOrder = 0, value = 0, uncounted = 0, drift = 0;
    for (const r of workspace.rows) {
      fba += r.fbaOnHand || 0;
      transit += r.fbaInTransit;
      wh += r.warehouseOnHand || 0;
      onOrder += r.onOrder;
      value += r.stockValue;
      const s = skuById.get(r.mappingId);
      if (s && s.isPlanned && s.fbaSource === "none" && s.warehouseSource === "none") uncounted += 1;
      if (s && ((s.warehouseRaw != null && s.warehouseRaw < 0) || (s.fbaRaw != null && s.fbaRaw < 0 && s.fbaSource !== "live"))) drift += 1;
    }
    return { fba, transit, wh, onOrder, value, uncounted, drift };
  }, [workspace.rows, skuById]);

  const ledger = useMemo(() => {
    return events.filter((e) => (!ledgerSku || e.mappingId === ledgerSku) && (!ledgerType || e.type === ledgerType)).slice(0, 400);
  }, [events, ledgerSku, ledgerType]);

  function startCount() {
    const init: Record<string, { fba: string; wh: string }> = {};
    for (const s of workspace.skus) {
      const r = rowById.get(s.mappingId);
      init[s.mappingId] = { fba: r?.fbaOnHand == null ? "" : String(r.fbaOnHand), wh: r?.warehouseOnHand == null ? "" : String(r.warehouseOnHand) };
    }
    setCounts(init);
    setMode("count");
  }

  function saveCount() {
    const entries = workspace.skus
      .map((s) => {
        const c = counts[s.mappingId];
        if (!c) return null;
        const r = rowById.get(s.mappingId);
        const fbaChanged = c.fba !== (r?.fbaOnHand == null ? "" : String(r.fbaOnHand));
        const whChanged = c.wh !== (r?.warehouseOnHand == null ? "" : String(r.warehouseOnHand));
        if (!fbaChanged && !whChanged) return null;
        if (c.fba === "" && c.wh === "") return null;
        return { mappingId: s.mappingId, fbaUnits: Number(c.fba) || (fbaChanged ? 0 : r?.fbaOnHand || 0), warehouseUnits: Number(c.wh) || (whChanged ? 0 : r?.warehouseOnHand || 0) };
      })
      .filter((e): e is { mappingId: string; fbaUnits: number; warehouseUnits: number } => !!e);
    if (entries.length === 0) {
      setNotice({ kind: "info", text: "No counts were changed." });
      setMode("view");
      return;
    }
    startTransition(async () => {
      const res = await recordStockTake(accountId, { date: countDate, entries, notes: countNotes || null });
      if (!res.ok) setNotice({ kind: "error", text: res.error });
      else {
        setNotice({ kind: "ok", text: `Stock take saved for ${res.data?.saved} SKU${res.data?.saved === 1 ? "" : "s"}. The planner now works forward from these counts.` });
        setMode("view");
        setCountNotes("");
      }
      router.refresh();
    });
  }

  function refreshFba() {
    startTransition(async () => {
      const res = await refreshFbaStock(accountId);
      if (!res.ok) setNotice({ kind: "error", text: res.error });
      else setNotice({ kind: "ok", text: `Live FBA stock refreshed for ${"skus" in (res.data || {}) ? (res.data as { skus: number }).skus : 0} SKUs.` });
      router.refresh();
    });
  }

  function removeMovement(id: string) {
    if (!confirm("Delete this ledger entry? Stock will be recalculated without it.")) return;
    startTransition(async () => {
      const res = await deleteMovement(accountId, id);
      if (!res.ok) setNotice({ kind: "error", text: res.error });
      router.refresh();
    });
  }

  function exportCsv() {
    const head = ["Product", "Amazon SKU", "ASIN", "FBA on hand", "FBA source", "In transit to FBA", "3PL on hand", "On order", "Stock value", "Last count"];
    const lines = stockRows.map(({ sku, row }) => [sku.productName, sku.amazonSku || "", sku.asin || "", row.fbaOnHand ?? "", sku.fbaSource, row.fbaInTransit, row.warehouseOnHand ?? "", row.onOrder, row.stockValue.toFixed(2), sku.baselineDate || ""]);
    const csv = [head, ...lines].map((r) => r.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(",")).join("\n");
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
    a.download = `stock-${workspace.today}.csv`;
    a.click();
  }

  return (
    <div className="space-y-4">
      {notice ? <Notice kind={notice.kind}>{notice.text}</Notice> : null}

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <Kpi label="FBA on hand" value={fmtInt(totals.fba)} hint={workspace.fbaLive.fresh ? `live · ${workspace.fbaLive.snapshotAt ? new Date(workspace.fbaLive.snapshotAt).toLocaleString("en-GB", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }) : ""}` : "from stock takes + logged sales"} />
        <Kpi label="In transit to FBA" value={fmtInt(totals.transit)} hint="shipped, not yet checked in" href={inventoryHref("/inventory/fba-shipments", accountId)} />
        <Kpi label="3PL on hand" value={fmtInt(totals.wh)} hint={workspace.warehouses.map((w) => w.name).join(", ") || "no warehouse yet"} />
        <Kpi label="On order" value={fmtInt(totals.onOrder)} hint="open purchase orders" href={inventoryHref("/inventory/purchase-orders", accountId)} />
        <Kpi label="Stock value" value={money(totals.value)} hint="at current COGS, excl. VAT" />
        <Kpi label="Needs attention" value={fmtInt(totals.uncounted + totals.drift)} hint={`${totals.uncounted} never counted · ${totals.drift} drifted below zero`} tone={totals.uncounted + totals.drift > 0 ? "warn" : "good"} />
      </div>

      <Card
        title={mode === "count" ? "Stock take" : "Stock by location"}
        subtitle={
          mode === "count"
            ? "Type the physical counts. Only rows you change are saved; leave the rest alone."
            : "FBA = Amazon's fulfillable units (live when connected). 3PL = units at the warehouse available to ship or sell FBM. Negative drift means more was sold or shipped than the last count allowed — do a stock take to fix it."
        }
        actions={
          mode === "count" ? (
            <>
              <input type="date" value={countDate} onChange={(e) => setCountDate(e.target.value)} className={inputSm} style={{ width: 150 }} />
              <input value={countNotes} onChange={(e) => setCountNotes(e.target.value)} placeholder="Note (optional)" className={inputSm} style={{ width: 180 }} />
              <button type="button" className={btn.small} onClick={() => setMode("view")} disabled={pending}>Cancel</button>
              <button type="button" className={btn.smallPrimary} onClick={saveCount} disabled={pending}>{pending ? "Saving…" : "Save stock take"}</button>
            </>
          ) : (
            <>
              <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search…" className={inputSm} style={{ width: 180 }} />
              <label className="flex items-center gap-1 text-xs text-slate-600"><input type="checkbox" checked={onlyDrift} onChange={(e) => setOnlyDrift(e.target.checked)} /> drifted only</label>
              <button type="button" className={btn.small} onClick={exportCsv}>CSV</button>
              {canEdit ? <button type="button" className={btn.small} onClick={refreshFba} disabled={pending}>Refresh FBA</button> : null}
              {canEdit ? <button type="button" className={btn.small} onClick={() => setAdjusting(true)}>Return / adjustment</button> : null}
              {canEdit ? <button type="button" className={btn.smallPrimary} onClick={startCount}>Stock take</button> : null}
            </>
          )
        }
      >
        {stockRows.length === 0 ? (
          <EmptyState>No SKUs match.</EmptyState>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead>
                <tr className="bg-slate-50">
                  <th className={th()}>Product</th>
                  <th className={th("text-right")}>FBA</th>
                  <th className={th("text-right")}>In transit</th>
                  <th className={th("text-right")}>3PL</th>
                  <th className={th("text-right")}>On order</th>
                  <th className={th("text-right")}>Draft to FBA</th>
                  <th className={th("text-right")}>Value</th>
                  <th className={th()}>Last count</th>
                </tr>
              </thead>
              <tbody>
                {stockRows.map(({ sku, row }) => {
                  const whDrift = sku.warehouseRaw != null && sku.warehouseRaw < 0;
                  const fbaDrift = sku.fbaRaw != null && sku.fbaRaw < 0 && sku.fbaSource !== "live";
                  const c = counts[sku.mappingId];
                  return (
                    <tr key={sku.mappingId} className={`border-t border-slate-100 ${!sku.isPlanned ? "opacity-60" : ""}`}>
                      <td className={td()}>
                        <span className="block font-medium text-slate-900">{sku.productName}</span>
                        <span className="block text-xs text-slate-500">{sku.amazonSku || sku.temuSkuId || sku.tiktokSku || ""}{sku.asin ? ` · ${sku.asin}` : ""}{!sku.isPlanned ? " · excluded from planning" : ""}</span>
                      </td>
                      <td className={td("text-right")}>
                        {mode === "count" ? (
                          <input value={c?.fba ?? ""} onChange={(e) => setCounts({ ...counts, [sku.mappingId]: { ...c, fba: e.target.value, wh: c?.wh ?? "" } })} className={`${inputSm} w-24 text-right`} inputMode="numeric" disabled={sku.fbaSource === "live"} title={sku.fbaSource === "live" ? "Live from Amazon — not editable" : ""} />
                        ) : (
                          <>
                            <span className={fbaDrift ? "font-semibold text-rose-700" : ""}>{row.fbaOnHand == null ? <span className="text-slate-400">—</span> : fmtInt(row.fbaOnHand)}</span>
                            <span className="block text-[11px] text-slate-400">{sku.fbaSource === "live" ? "live" : sku.fbaSource === "count" ? (fbaDrift ? `drift ${sku.fbaRaw}` : "count") : "no count"}</span>
                          </>
                        )}
                      </td>
                      <td className={td("text-right")}>{row.fbaInTransit ? fmtInt(row.fbaInTransit) : <span className="text-slate-300">0</span>}</td>
                      <td className={td("text-right")}>
                        {mode === "count" ? (
                          <input value={c?.wh ?? ""} onChange={(e) => setCounts({ ...counts, [sku.mappingId]: { ...c, wh: e.target.value, fba: c?.fba ?? "" } })} className={`${inputSm} w-24 text-right`} inputMode="numeric" />
                        ) : (
                          <>
                            <span className={whDrift ? "font-semibold text-rose-700" : ""}>{row.warehouseOnHand == null ? <span className="text-slate-400">—</span> : fmtInt(row.warehouseOnHand)}</span>
                            {whDrift ? <span className="block text-[11px] text-rose-600">drift {sku.warehouseRaw}</span> : null}
                          </>
                        )}
                      </td>
                      <td className={td("text-right")}>{row.onOrder ? fmtInt(row.onOrder) : <span className="text-slate-300">0</span>}</td>
                      <td className={td("text-right")}>{row.plannedToFba ? fmtInt(row.plannedToFba) : <span className="text-slate-300">0</span>}</td>
                      <td className={td("text-right")}>{money(row.stockValue)}</td>
                      <td className={td("text-xs text-slate-500")}>{sku.baselineDate ? formatUkDate(sku.baselineDate) : "never"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card
        title="Ledger"
        subtitle="Every stock-changing event, newest first. Receipts, FBA shipments and stock takes are created from their own pages; manual entries can be deleted here."
        actions={
          <>
            <div style={{ width: 240 }}><SkuPicker options={workspace.skus} value={ledgerSku} onChange={setLedgerSku} placeholder="All SKUs" /></div>
            <select value={ledgerType} onChange={(e) => setLedgerType(e.target.value)} className={inputSm} style={{ width: 190 }}>
              <option value="">All types</option>
              {Object.entries(TYPE_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
          </>
        }
      >
        {ledger.length === 0 ? (
          <EmptyState>No ledger entries yet. Receive a purchase order, ship to FBA or record a stock take to get started.</EmptyState>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead>
                <tr className="bg-slate-50">
                  <th className={th()}>Date</th>
                  <th className={th()}>Product</th>
                  <th className={th()}>Event</th>
                  <th className={th()}>Location</th>
                  <th className={th("text-right")}>Units</th>
                  <th className={th()}>Reference</th>
                  <th className={th()}>Notes</th>
                  <th className={th()}></th>
                </tr>
              </thead>
              <tbody>
                {ledger.map((e) => {
                  const sku = skuById.get(e.mappingId);
                  return (
                    <tr key={`${e.kind}-${e.id}`} className="border-t border-slate-100">
                      <td className={td("whitespace-nowrap")}>{formatUkDate(e.date)}</td>
                      <td className={td()}><span className="font-medium">{sku?.productName || "Unknown SKU"}</span><span className="block text-xs text-slate-500">{sku?.amazonSku || ""}</span></td>
                      <td className={td()}>{TYPE_LABEL[e.type] || e.type}</td>
                      <td className={td("text-xs text-slate-600")}>{e.kind === "stock_take" ? "FBA + 3PL" : e.location === "amazon" ? "Amazon FBA" : e.warehouse || "3PL"}</td>
                      <td className={td("text-right")}>
                        {e.kind === "stock_take" ? (
                          <span className="text-xs">FBA {fmtInt(e.fba)} · 3PL {fmtInt(e.warehouseUnits)}</span>
                        ) : (
                          <span className={e.delta > 0 ? "text-emerald-700" : "text-rose-700"}>{e.delta > 0 ? "+" : ""}{fmtInt(e.delta)}</span>
                        )}
                      </td>
                      <td className={td("text-xs")}>{e.reference ? <Link href={inventoryHref(e.reference.href, accountId)} className="text-plum-700 hover:underline">{e.reference.label}</Link> : ""}</td>
                      <td className={td("text-xs text-slate-500")}>{e.notes || ""}</td>
                      <td className={td("text-right")}>{canEdit && e.deletable ? <button type="button" onClick={() => removeMovement(e.id)} className="text-xs text-rose-600 hover:underline" disabled={pending}>delete</button> : null}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {adjusting ? (
        <AdjustmentModal
          workspace={workspace}
          accountId={accountId}
          onClose={() => setAdjusting(false)}
          onDone={(t) => { setAdjusting(false); setNotice({ kind: "ok", text: t }); router.refresh(); }}
          onError={(t) => setNotice({ kind: "error", text: t })}
        />
      ) : null}
    </div>
  );
}

function AdjustmentModal({ workspace, accountId, onClose, onDone, onError }: { workspace: InventoryWorkspace; accountId: string; onClose: () => void; onDone: (t: string) => void; onError: (t: string) => void }) {
  const [pending, startTransition] = useTransition();
  const [mappingId, setMappingId] = useState("");
  const [type, setType] = useState<AdjustmentType>("customer_return");
  const [location, setLocation] = useState<"warehouse" | "amazon">("warehouse");
  const [units, setUnits] = useState("");
  const [date, setDate] = useState(workspace.today);
  const [warehouseId, setWarehouseId] = useState(workspace.defaultWarehouseId || "");
  const [notes, setNotes] = useState("");
  const opt = ADJUSTMENT_OPTIONS.find((o) => o.value === type)!;

  function submit() {
    if (!mappingId) return onError("Pick a SKU first.");
    if (!Number(units)) return onError("Enter the number of units.");
    startTransition(async () => {
      const res = await recordAdjustment(accountId, { mappingId, type, location, units: Number(units), date, warehouseId: location === "warehouse" ? warehouseId || null : null, notes: notes || null });
      if (!res.ok) onError(res.error);
      else onDone("Adjustment recorded.");
    });
  }

  return (
    <Modal title="Return / adjustment" onClose={onClose}>
      <div className="grid gap-3">
        <Field label="SKU"><SkuPicker options={workspace.skus} value={mappingId} onChange={setMappingId} autoFocus /></Field>
        <Field label="What happened" hint={opt.hint}>
          <select value={type} onChange={(e) => setType(e.target.value as AdjustmentType)} className={input}>
            {ADJUSTMENT_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Location">
            <select value={location} onChange={(e) => setLocation(e.target.value as "warehouse" | "amazon")} className={input}>
              <option value="warehouse">3PL warehouse</option>
              <option value="amazon">Amazon FBA</option>
            </select>
          </Field>
          {location === "warehouse" ? (
            <Field label="Warehouse">
              <select value={warehouseId} onChange={(e) => setWarehouseId(e.target.value)} className={input}>
                <option value="">—</option>
                {workspace.warehouses.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
              </select>
            </Field>
          ) : <div />}
          <Field label="Units"><input value={units} onChange={(e) => setUnits(e.target.value)} className={input} inputMode="numeric" placeholder={type === "adjustment" ? "e.g. -3 or 12" : "e.g. 5"} /></Field>
          <Field label="Date"><input type="date" value={date} onChange={(e) => setDate(e.target.value)} className={input} /></Field>
        </div>
        <Field label="Notes"><input value={notes} onChange={(e) => setNotes(e.target.value)} className={input} placeholder="Order number, reason…" /></Field>
      </div>
      <div className="mt-4 flex justify-end gap-2">
        <button type="button" className={btn.secondary} onClick={onClose} disabled={pending}>Cancel</button>
        <button type="button" className={btn.primary} onClick={submit} disabled={pending}>{pending ? "Saving…" : "Record"}</button>
      </div>
    </Modal>
  );
}
