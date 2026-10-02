"use client";

import Link from "next/link";
import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { PurchaseOrderDetail } from "@/lib/inventory/documents";
import type { InventoryWorkspace } from "@/lib/inventory/workspace";
import { formatUkDate } from "@/lib/utils/date";
import {
  applyLandedCostToCogs,
  createFbaShipment,
  deletePurchaseOrder,
  receivePurchaseOrder,
  replacePurchaseOrderItems,
  setPurchaseOrderStatus,
  updatePurchaseOrder,
  type PurchaseOrderStatus,
} from "../actions";
import { inventoryHref } from "../_components/inventory-shell";
import { LineEditor, newLine, type EditableLine } from "../_components/line-editor";
import { Card, DocStatus, Field, Modal, Notice, btn, fmtDec, fmtInt, input, inputSm, td, th, useMoney } from "../_components/ui";

const FLOW: PurchaseOrderStatus[] = ["draft", "ordered", "in_production", "shipped", "partially_received", "received", "closed"];
const EDITABLE_LINES = new Set(["draft", "ordered", "in_production"]);

export default function PurchaseOrderDetailView({ po, workspace, accountId, canEdit }: { po: PurchaseOrderDetail; workspace: InventoryWorkspace; accountId: string; canEdit: boolean }) {
  const router = useRouter();
  const money = useMoney(po.currency);
  const [pending, startTransition] = useTransition();
  const [notice, setNotice] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [receiving, setReceiving] = useState(false);
  const [editingLines, setEditingLines] = useState(false);
  const [lines, setLines] = useState<EditableLine[]>(() =>
    po.items.map((it) => newLine({ id: it.id, mappingId: it.mappingId, units: String(it.orderedUnits), unitCost: String(it.unitCost), packProfileId: it.packProfileId || "", notes: it.notes || "", minUnits: it.receivedUnits }))
  );
  const [header, setHeader] = useState({
    supplierId: po.supplierId || "",
    orderDate: po.orderDate || "",
    expectedReadyDate: po.expectedReadyDate || "",
    expectedArrivalDate: po.expectedArrivalDate || "",
    destinationWarehouseId: po.destinationWarehouseId || "",
    currency: po.currency,
    freightCost: String(po.freightCost || ""),
    dutyCost: String(po.dutyCost || ""),
    otherCost: String(po.otherCost || ""),
    trackingRef: po.trackingRef || "",
    notes: po.notes || "",
  });

  const isTerminal = po.status === "closed" || po.status === "cancelled";
  const canEditLines = canEdit && EDITABLE_LINES.has(po.status);
  const totalOrdered = po.items.reduce((a, i) => a + i.orderedUnits, 0);
  const totalReceived = po.items.reduce((a, i) => a + i.receivedUnits, 0);
  const goodsValue = po.items.reduce((a, i) => a + i.orderedUnits * i.unitCost, 0);
  const extras = po.freightCost + po.dutyCost + po.otherCost;

  const landed = useMemo(() => {
    const units = totalOrdered || 1;
    const perUnitExtra = extras / units;
    return po.items.map((it) => ({ ...it, landedUnitCost: Math.round((it.unitCost + perUnitExtra) * 10000) / 10000, perUnitExtra }));
  }, [po.items, extras, totalOrdered]);

  function run(fn: () => Promise<{ ok: boolean; error?: string } | { ok: true }>, okText?: string) {
    startTransition(async () => {
      const res = await fn();
      if (!res.ok) setNotice({ kind: "error", text: (res as { error: string }).error });
      else if (okText) setNotice({ kind: "ok", text: okText });
      router.refresh();
    });
  }

  function saveHeader() {
    run(
      () =>
        updatePurchaseOrder(accountId, po.id, {
          supplierId: header.supplierId || null,
          orderDate: header.orderDate || null,
          expectedReadyDate: header.expectedReadyDate || null,
          expectedArrivalDate: header.expectedArrivalDate || null,
          destinationWarehouseId: header.destinationWarehouseId || null,
          currency: header.currency,
          freightCost: Number(header.freightCost) || 0,
          dutyCost: Number(header.dutyCost) || 0,
          otherCost: Number(header.otherCost) || 0,
          trackingRef: header.trackingRef || null,
          notes: header.notes || null,
        }),
      "Purchase order updated."
    );
  }

  function saveLines() {
    const items = lines
      .filter((l) => l.mappingId)
      .map((l) => ({
        mappingId: l.mappingId,
        orderedUnits: Number(l.units) || 0,
        unitCost: Number(l.unitCost) || 0,
        packProfileId: l.packProfileId || null,
        unitsPerBox: workspace.packProfiles.find((p) => p.id === l.packProfileId)?.unitsPerBox || null,
        notes: l.notes || null,
      }));
    startTransition(async () => {
      const res = await replacePurchaseOrderItems(accountId, po.id, items);
      if (!res.ok) setNotice({ kind: "error", text: res.error });
      else {
        setNotice({ kind: "ok", text: "Lines saved." });
        setEditingLines(false);
      }
      router.refresh();
    });
  }

  function createShipmentFromPo() {
    const items = po.items
      .filter((i) => i.receivedUnits > 0)
      .map((i) => ({ mappingId: i.mappingId, plannedUnits: i.receivedUnits, packProfileId: i.packProfileId, unitsPerBox: i.unitsPerBox, boxes: i.unitsPerBox ? Math.ceil(i.receivedUnits / i.unitsPerBox) : null }));
    if (items.length === 0) {
      setNotice({ kind: "error", text: "Receive stock first — the shipment is pre-filled with received units." });
      return;
    }
    startTransition(async () => {
      const res = await createFbaShipment(accountId, {
        shipmentName: `FBA from ${po.poNumber}`,
        sourceWarehouseId: po.destinationWarehouseId || workspace.defaultWarehouseId,
        purchaseOrderId: po.id,
        items,
      });
      if (!res.ok) setNotice({ kind: "error", text: res.error });
      else router.push(inventoryHref(`/inventory/fba-shipments/${res.data!.id}`, accountId));
    });
  }

  const stepIndex = FLOW.indexOf(po.status as PurchaseOrderStatus);

  return (
    <div className="space-y-4">
      {notice ? <Notice kind={notice.kind}>{notice.text}</Notice> : null}
      {po.isLegacy ? <Notice kind="info">This purchase order was migrated from an old shipment plan. Review the lines and costs before using it.</Notice> : null}

      {/* Status flow */}
      <Card>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <ol className="flex flex-wrap items-center gap-1 text-xs">
            {FLOW.map((s, i) => {
              const reached = po.status === "cancelled" ? false : i <= stepIndex;
              return (
                <li key={s} className="flex items-center gap-1">
                  <span className={`rounded-full px-2 py-1 font-semibold ${reached ? "bg-plum-700 text-white" : "bg-slate-100 text-slate-500"}`}>{s.replace(/_/g, " ")}</span>
                  {i < FLOW.length - 1 ? <span className="text-slate-300">›</span> : null}
                </li>
              );
            })}
            {po.status === "cancelled" ? <li><DocStatus status="cancelled" /></li> : null}
          </ol>
          {canEdit && !isTerminal ? (
            <div className="flex flex-wrap gap-2">
              {po.status === "draft" ? <button type="button" className={btn.primary} disabled={pending} onClick={() => run(() => setPurchaseOrderStatus(accountId, po.id, "ordered"), "Marked as ordered.")}>Mark ordered</button> : null}
              {po.status === "ordered" ? <button type="button" className={btn.secondary} disabled={pending} onClick={() => run(() => setPurchaseOrderStatus(accountId, po.id, "in_production"), "Marked in production.")}>In production</button> : null}
              {["ordered", "in_production"].includes(po.status) ? <button type="button" className={btn.secondary} disabled={pending} onClick={() => run(() => setPurchaseOrderStatus(accountId, po.id, "shipped"), "Marked shipped by supplier.")}>Shipped by supplier</button> : null}
              {po.status !== "draft" ? <button type="button" className={btn.plum} disabled={pending} onClick={() => setReceiving(true)}>Receive stock</button> : null}
              {po.status === "received" || po.status === "partially_received" ? <button type="button" className={btn.primary} disabled={pending} onClick={() => run(() => setPurchaseOrderStatus(accountId, po.id, "closed"), "Purchase order closed.")}>Close PO</button> : null}
              {po.status === "draft" ? (
                <button type="button" className={btn.danger} disabled={pending} onClick={() => { if (confirm("Delete this draft purchase order?")) run(async () => { const r = await deletePurchaseOrder(accountId, po.id); if (r.ok) router.push(inventoryHref("/inventory/purchase-orders", accountId)); return r; }); }}>Delete draft</button>
              ) : (
                <button type="button" className={btn.danger} disabled={pending} onClick={() => { if (confirm("Cancel this purchase order? Received stock stays in the warehouse.")) run(() => setPurchaseOrderStatus(accountId, po.id, "cancelled"), "Purchase order cancelled."); }}>Cancel PO</button>
              )}
            </div>
          ) : null}
          {canEdit && po.status === "closed" ? (
            <button type="button" className={btn.secondary} disabled={pending} onClick={() => run(() => setPurchaseOrderStatus(accountId, po.id, "received"), "Reopened.")}>Reopen</button>
          ) : null}
        </div>
        <div className="mt-3 grid grid-cols-2 gap-3 text-sm md:grid-cols-5">
          <Stat label="Units ordered" value={fmtInt(totalOrdered)} />
          <Stat label="Units received" value={`${fmtInt(totalReceived)} (${totalOrdered ? Math.round((totalReceived / totalOrdered) * 100) : 0}%)`} />
          <Stat label="Goods value" value={money(goodsValue)} />
          <Stat label="Freight / duty / other" value={money(extras)} />
          <Stat label="Landed total" value={money(goodsValue + extras)} />
        </div>
      </Card>

      {/* Header */}
      <Card title="Details" actions={canEdit && !isTerminal ? <button type="button" onClick={saveHeader} disabled={pending} className={btn.smallPrimary}>Save details</button> : null}>
        <div className="grid gap-3 md:grid-cols-3 lg:grid-cols-6">
          <Field label="Supplier" className="lg:col-span-2">
            <select value={header.supplierId} onChange={(e) => setHeader({ ...header, supplierId: e.target.value })} className={input} disabled={!canEdit || isTerminal}>
              <option value="">— none —</option>
              {workspace.suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </Field>
          <Field label="Order date"><input type="date" value={header.orderDate} onChange={(e) => setHeader({ ...header, orderDate: e.target.value })} className={input} disabled={!canEdit || isTerminal} /></Field>
          <Field label="Expected ready"><input type="date" value={header.expectedReadyDate} onChange={(e) => setHeader({ ...header, expectedReadyDate: e.target.value })} className={input} disabled={!canEdit || isTerminal} /></Field>
          <Field label="Expected arrival"><input type="date" value={header.expectedArrivalDate} onChange={(e) => setHeader({ ...header, expectedArrivalDate: e.target.value })} className={input} disabled={!canEdit || isTerminal} /></Field>
          <Field label="Deliver to">
            <select value={header.destinationWarehouseId} onChange={(e) => setHeader({ ...header, destinationWarehouseId: e.target.value })} className={input} disabled={!canEdit || isTerminal}>
              <option value="">—</option>
              {workspace.warehouses.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
            </select>
          </Field>
          <Field label="Tracking / container ref" className="lg:col-span-2"><input value={header.trackingRef} onChange={(e) => setHeader({ ...header, trackingRef: e.target.value })} className={input} disabled={!canEdit || isTerminal} /></Field>
          <Field label="Currency"><input value={header.currency} onChange={(e) => setHeader({ ...header, currency: e.target.value.toUpperCase() })} className={input} maxLength={3} disabled={!canEdit || isTerminal} /></Field>
          <Field label="Freight"><input value={header.freightCost} onChange={(e) => setHeader({ ...header, freightCost: e.target.value })} className={input} inputMode="decimal" disabled={!canEdit || isTerminal} /></Field>
          <Field label="Duty / VAT on import"><input value={header.dutyCost} onChange={(e) => setHeader({ ...header, dutyCost: e.target.value })} className={input} inputMode="decimal" disabled={!canEdit || isTerminal} /></Field>
          <Field label="Other costs"><input value={header.otherCost} onChange={(e) => setHeader({ ...header, otherCost: e.target.value })} className={input} inputMode="decimal" disabled={!canEdit || isTerminal} /></Field>
          <Field label="Notes" className="md:col-span-3 lg:col-span-6"><input value={header.notes} onChange={(e) => setHeader({ ...header, notes: e.target.value })} className={input} disabled={!canEdit || isTerminal} /></Field>
        </div>
      </Card>

      {/* Lines */}
      <Card
        title="Lines"
        subtitle={canEditLines ? "Editable until the supplier ships. Lines with receipts cannot be removed." : "Lines are locked once goods are in transit."}
        actions={
          canEditLines ? (
            editingLines ? (
              <>
                <button type="button" className={btn.small} onClick={() => { setEditingLines(false); setLines(po.items.map((it) => newLine({ id: it.id, mappingId: it.mappingId, units: String(it.orderedUnits), unitCost: String(it.unitCost), packProfileId: it.packProfileId || "", notes: it.notes || "", minUnits: it.receivedUnits }))); }}>Cancel</button>
                <button type="button" className={btn.smallPrimary} onClick={saveLines} disabled={pending}>Save lines</button>
              </>
            ) : (
              <button type="button" className={btn.small} onClick={() => setEditingLines(true)}>Edit lines</button>
            )
          ) : null
        }
      >
        {editingLines ? (
          <LineEditor mode="po" lines={lines} onChange={setLines} skus={workspace.skus} packProfiles={workspace.packProfiles} rows={workspace.rows} currency={po.currency} />
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full">
              <thead>
                <tr className="bg-slate-50">
                  <th className={th()}>SKU</th>
                  <th className={th("text-right")}>Ordered</th>
                  <th className={th("text-right")}>Received</th>
                  <th className={th("text-right")}>Outstanding</th>
                  <th className={th("text-right")}>Cartons</th>
                  <th className={th("text-right")}>Unit cost</th>
                  <th className={th("text-right")}>Line total</th>
                  <th className={th()}>Notes</th>
                </tr>
              </thead>
              <tbody>
                {po.items.map((it) => (
                  <tr key={it.id} className="border-t border-slate-100">
                    <td className={td()}>
                      <span className="block font-medium">{it.sku}</span>
                      <span className="block text-xs text-slate-500">{it.productName}</span>
                    </td>
                    <td className={td("text-right")}>{fmtInt(it.orderedUnits)}</td>
                    <td className={td("text-right")}>{fmtInt(it.receivedUnits)}</td>
                    <td className={td("text-right")}>{it.orderedUnits - it.receivedUnits > 0 ? <span className="font-medium text-amber-700">{fmtInt(it.orderedUnits - it.receivedUnits)}</span> : <span className="text-emerald-700">0</span>}</td>
                    <td className={td("text-right")}>{it.unitsPerBox ? `${Math.ceil(it.orderedUnits / it.unitsPerBox)} × ${it.unitsPerBox}` : "—"}</td>
                    <td className={td("text-right")}>{money(it.unitCost)}</td>
                    <td className={td("text-right")}>{money(it.orderedUnits * it.unitCost)}</td>
                    <td className={td("text-xs text-slate-500")}>{it.notes || ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {/* Landed cost */}
      {extras > 0 || po.status === "closed" || po.status === "received" ? (
        <Card
          title="Landed cost per unit"
          subtitle={`Freight, duty and other costs (${money(extras)}) spread across ${fmtInt(totalOrdered)} units ordered. Review, then apply to COGS when you are happy.`}
          actions={
            canEdit ? (
              <ApplyCogsButton
                disabled={pending}
                applied={po.cogsAppliedAt}
                onApply={(effectiveFrom) =>
                  run(
                    () => applyLandedCostToCogs(accountId, { poId: po.id, effectiveFrom, lines: landed.map((l) => ({ mappingId: l.mappingId, landedUnitCost: l.landedUnitCost })) }),
                    "Landed cost applied to COGS (a new cost version was recorded)."
                  )
                }
              />
            ) : null
          }
        >
          <div className="overflow-x-auto">
            <table className="min-w-full">
              <thead>
                <tr className="bg-slate-50">
                  <th className={th()}>SKU</th>
                  <th className={th("text-right")}>Supplier unit cost</th>
                  <th className={th("text-right")}>+ Freight/duty per unit</th>
                  <th className={th("text-right")}>Landed unit cost</th>
                  <th className={th("text-right")}>Current COGS</th>
                  <th className={th("text-right")}>Change</th>
                </tr>
              </thead>
              <tbody>
                {landed.map((l) => {
                  const diff = l.currentCogs == null ? null : l.landedUnitCost - l.currentCogs;
                  return (
                    <tr key={l.id} className="border-t border-slate-100">
                      <td className={td()}><span className="font-medium">{l.sku}</span><span className="block text-xs text-slate-500">{l.productName}</span></td>
                      <td className={td("text-right")}>{money(l.unitCost)}</td>
                      <td className={td("text-right")}>{money(l.perUnitExtra)}</td>
                      <td className={td("text-right font-semibold")}>{money(l.landedUnitCost)}</td>
                      <td className={td("text-right")}>{l.currentCogs == null ? <span className="text-slate-400">not set</span> : money(l.currentCogs)}</td>
                      <td className={td("text-right")}>{diff == null ? "—" : <span className={diff > 0 ? "text-red-700" : diff < 0 ? "text-emerald-700" : ""}>{diff > 0 ? "+" : ""}{money(diff)}</span>}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {po.cogsAppliedAt ? <p className="mt-2 text-xs text-emerald-700">Applied to COGS on {new Date(po.cogsAppliedAt).toLocaleString("en-GB")}.</p> : null}
        </Card>
      ) : null}

      {/* Receipts + linked shipments */}
      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Receipts" subtitle="Each delivery into the 3PL adds stock to the warehouse immediately.">
          {po.receipts.length === 0 ? (
            <p className="text-sm text-slate-500">Nothing received yet.</p>
          ) : (
            <table className="min-w-full text-sm">
              <thead>
                <tr className="bg-slate-50">
                  <th className={th()}>Date</th>
                  <th className={th()}>SKU</th>
                  <th className={th("text-right")}>Units</th>
                  <th className={th()}>Warehouse</th>
                  <th className={th()}>Notes</th>
                </tr>
              </thead>
              <tbody>
                {po.receipts.map((r) => (
                  <tr key={r.id} className="border-t border-slate-100">
                    <td className={td("whitespace-nowrap")}>{formatUkDate(r.date)}</td>
                    <td className={td()}>{po.items.find((i) => i.id === r.itemId)?.sku || "—"}</td>
                    <td className={td("text-right")}>{fmtInt(r.units)}</td>
                    <td className={td()}>{r.warehouseName || "—"}</td>
                    <td className={td("text-xs text-slate-500")}>{r.notes || ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
        <Card
          title="FBA shipments from this PO"
          actions={canEdit && totalReceived > 0 ? <button type="button" className={btn.small} onClick={createShipmentFromPo} disabled={pending}>Create FBA shipment from received units</button> : null}
        >
          {po.linkedShipments.length === 0 ? (
            <p className="text-sm text-slate-500">No shipments linked yet.</p>
          ) : (
            <ul className="space-y-1 text-sm">
              {po.linkedShipments.map((s) => (
                <li key={s.id} className="flex items-center justify-between">
                  <Link href={inventoryHref(`/inventory/fba-shipments/${s.id}`, accountId)} className="font-medium text-plum-700 hover:underline">{s.name}</Link>
                  <DocStatus status={s.status} />
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      {receiving ? (
        <ReceiveModal
          po={po}
          workspace={workspace}
          accountId={accountId}
          onClose={() => setReceiving(false)}
          onDone={(text) => {
            setReceiving(false);
            setNotice({ kind: "ok", text });
            router.refresh();
          }}
          onError={(text) => setNotice({ kind: "error", text })}
        />
      ) : null}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-xs text-slate-500">{label}</p>
      <p className="font-semibold text-slate-900">{value}</p>
    </div>
  );
}

function ApplyCogsButton({ onApply, disabled, applied }: { onApply: (effectiveFrom: string) => void; disabled: boolean; applied: string | null }) {
  const [open, setOpen] = useState(false);
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  return (
    <>
      <button type="button" className={btn.smallPrimary} disabled={disabled} onClick={() => setOpen(true)}>
        {applied ? "Re-apply to COGS" : "Apply landed cost to COGS"}
      </button>
      {open ? (
        <Modal title="Apply landed cost to COGS" onClose={() => setOpen(false)}>
          <p className="text-sm text-slate-600">A new COGS version will be recorded for every SKU on this order, effective from the date below. Reports from that date onward will be recalculated.</p>
          <Field label="Effective from" className="mt-3">
            <input type="date" value={date} onChange={(e) => setDate(e.target.value)} className={input} />
          </Field>
          <div className="mt-4 flex justify-end gap-2">
            <button type="button" className={btn.secondary} onClick={() => setOpen(false)}>Cancel</button>
            <button type="button" className={btn.primary} onClick={() => { setOpen(false); onApply(date); }}>Apply</button>
          </div>
        </Modal>
      ) : null}
    </>
  );
}

function ReceiveModal({ po, workspace, accountId, onClose, onDone, onError }: { po: PurchaseOrderDetail; workspace: InventoryWorkspace; accountId: string; onClose: () => void; onDone: (text: string) => void; onError: (text: string) => void }) {
  const [pending, startTransition] = useTransition();
  const [date, setDate] = useState(workspace.today);
  const [warehouseId, setWarehouseId] = useState(po.destinationWarehouseId || workspace.defaultWarehouseId || "");
  const [notes, setNotes] = useState("");
  const [qty, setQty] = useState<Record<string, string>>(() => Object.fromEntries(po.items.map((i) => [i.id, String(Math.max(0, i.orderedUnits - i.receivedUnits))])));

  function submit() {
    const lines = po.items.map((i) => ({ itemId: i.id, units: Number(qty[i.id]) || 0 })).filter((l) => l.units > 0);
    if (lines.length === 0) {
      onError("Enter units received on at least one line.");
      return;
    }
    startTransition(async () => {
      const res = await receivePurchaseOrder(accountId, { poId: po.id, date, warehouseId: warehouseId || null, notes: notes || null, lines });
      if (!res.ok) onError(res.error);
      else onDone(`${fmtInt(res.data!.received)} units received into the warehouse. PO is now ${res.data!.status.replace(/_/g, " ")}.`);
    });
  }

  return (
    <Modal title={`Receive stock — ${po.poNumber}`} onClose={onClose} wide>
      <div className="grid gap-3 md:grid-cols-3">
        <Field label="Received on"><input type="date" value={date} onChange={(e) => setDate(e.target.value)} className={input} /></Field>
        <Field label="Into warehouse">
          <select value={warehouseId} onChange={(e) => setWarehouseId(e.target.value)} className={input}>
            <option value="">—</option>
            {workspace.warehouses.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
          </select>
        </Field>
        <Field label="Notes"><input value={notes} onChange={(e) => setNotes(e.target.value)} className={input} placeholder="Delivery ref, damages…" /></Field>
      </div>
      <table className="mt-4 min-w-full text-sm">
        <thead>
          <tr className="bg-slate-50">
            <th className={th()}>SKU</th>
            <th className={th("text-right")}>Ordered</th>
            <th className={th("text-right")}>Already received</th>
            <th className={th("text-right")}>Outstanding</th>
            <th className={th("text-right")}>Receiving now</th>
            <th className={th("text-right")}>Cartons</th>
          </tr>
        </thead>
        <tbody>
          {po.items.map((i) => {
            const outstanding = Math.max(0, i.orderedUnits - i.receivedUnits);
            const now = Number(qty[i.id]) || 0;
            return (
              <tr key={i.id} className="border-t border-slate-100">
                <td className={td()}><span className="font-medium">{i.sku}</span><span className="block text-xs text-slate-500">{i.productName}</span></td>
                <td className={td("text-right")}>{fmtInt(i.orderedUnits)}</td>
                <td className={td("text-right")}>{fmtInt(i.receivedUnits)}</td>
                <td className={td("text-right")}>{fmtInt(outstanding)}</td>
                <td className={td("w-32 text-right")}>
                  <input value={qty[i.id] ?? ""} onChange={(e) => setQty({ ...qty, [i.id]: e.target.value })} className={`${inputSm} text-right ${now > outstanding ? "border-amber-400" : ""}`} inputMode="numeric" />
                  {now > outstanding ? <span className="block text-[11px] text-amber-700">more than ordered</span> : null}
                </td>
                <td className={td("text-right")}>{i.unitsPerBox && now > 0 ? fmtDec(now / i.unitsPerBox, 1) : "—"}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <div className="mt-4 flex justify-end gap-2">
        <button type="button" className={btn.secondary} onClick={onClose} disabled={pending}>Cancel</button>
        <button type="button" className={btn.primary} onClick={submit} disabled={pending}>{pending ? "Saving…" : "Receive into warehouse"}</button>
      </div>
    </Modal>
  );
}
