"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { FbaShipmentDetail } from "@/lib/inventory/documents";
import type { InventoryWorkspace } from "@/lib/inventory/workspace";
import { cancelFbaShipment, deleteFbaShipment, receiveFbaShipment, replaceFbaShipmentItems, shipFbaShipment, updateFbaShipment } from "../actions";
import { inventoryHref } from "../_components/inventory-shell";
import { LineEditor, lineBoxes, newLine, type EditableLine } from "../_components/line-editor";
import { Card, DocStatus, Field, Modal, Notice, btn, fmtDec, fmtInt, input, inputSm, td, th } from "../_components/ui";

const FLOW = ["draft", "shipped", "receiving", "closed"];

export default function FbaShipmentDetailView({ shipment: sh, workspace, accountId, canEdit }: { shipment: FbaShipmentDetail; workspace: InventoryWorkspace; accountId: string; canEdit: boolean }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [notice, setNotice] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [shipping, setShipping] = useState(false);
  const [receiving, setReceiving] = useState(false);
  const [editingLines, setEditingLines] = useState(false);
  const toLines = () => sh.items.map((it) => newLine({ id: it.id, mappingId: it.mappingId, units: String(it.plannedUnits), packProfileId: it.packProfileId || "", notes: it.notes || "" }));
  const [lines, setLines] = useState<EditableLine[]>(toLines);
  const [header, setHeader] = useState({
    shipmentName: sh.name,
    amazonShipmentId: sh.amazonShipmentId || "",
    sourceWarehouseId: sh.sourceWarehouseId || "",
    shipDate: sh.shipDate || "",
    expectedArrivalDate: sh.expectedArrivalDate || "",
    carrier: sh.carrier || "",
    trackingRef: sh.trackingRef || "",
    notes: sh.notes || "",
  });

  const isDraft = sh.status === "draft";
  const isTerminal = sh.status === "closed" || sh.status === "cancelled";
  const totals = sh.items.reduce(
    (a, i) => ({ planned: a.planned + i.plannedUnits, sent: a.sent + i.sentUnits, received: a.received + i.receivedUnits, boxes: a.boxes + (i.boxes || 0), pallets: a.pallets + (i.pallets || 0) }),
    { planned: 0, sent: 0, received: 0, boxes: 0, pallets: 0 }
  );

  function run(fn: () => Promise<{ ok: boolean; error?: string }>, okText?: string) {
    startTransition(async () => {
      const res = await fn();
      if (!res.ok) setNotice({ kind: "error", text: res.error || "Failed." });
      else if (okText) setNotice({ kind: "ok", text: okText });
      router.refresh();
    });
  }

  function saveHeader() {
    run(() => updateFbaShipment(accountId, sh.id, { ...header, amazonShipmentId: header.amazonShipmentId || null, sourceWarehouseId: header.sourceWarehouseId || null, shipDate: header.shipDate || null, expectedArrivalDate: header.expectedArrivalDate || null, carrier: header.carrier || null, trackingRef: header.trackingRef || null, notes: header.notes || null }), "Shipment updated.");
  }

  function saveLines() {
    const packById = new Map(workspace.packProfiles.map((p) => [p.id, p]));
    const items = lines
      .filter((l) => l.mappingId && Number(l.units) > 0)
      .map((l) => {
        const { boxes, pallets, unitsPerBox } = lineBoxes(l, packById);
        return { mappingId: l.mappingId, plannedUnits: Number(l.units), packProfileId: l.packProfileId || null, unitsPerBox, boxes, pallets, notes: l.notes || null };
      });
    startTransition(async () => {
      const res = await replaceFbaShipmentItems(accountId, sh.id, items);
      if (!res.ok) setNotice({ kind: "error", text: res.error });
      else {
        setNotice({ kind: "ok", text: "Lines saved." });
        setEditingLines(false);
      }
      router.refresh();
    });
  }

  const stepIndex = FLOW.indexOf(sh.status);

  return (
    <div className="space-y-4">
      {notice ? <Notice kind={notice.kind}>{notice.text}</Notice> : null}
      {sh.isLegacy ? <Notice kind="info">Migrated from an old shipment plan.</Notice> : null}

      <Card>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <ol className="flex flex-wrap items-center gap-1 text-xs">
            {FLOW.map((s, i) => (
              <li key={s} className="flex items-center gap-1">
                <span className={`rounded-full px-2 py-1 font-semibold ${sh.status !== "cancelled" && i <= stepIndex ? "bg-plum-700 text-white" : "bg-slate-100 text-slate-500"}`}>{s}</span>
                {i < FLOW.length - 1 ? <span className="text-slate-300">›</span> : null}
              </li>
            ))}
            {sh.status === "cancelled" ? <li><DocStatus status="cancelled" /></li> : null}
          </ol>
          {canEdit && !isTerminal ? (
            <div className="flex flex-wrap gap-2">
              {isDraft ? <button type="button" className={btn.plum} disabled={pending} onClick={() => setShipping(true)}>Mark as shipped</button> : null}
              {!isDraft ? <button type="button" className={btn.primary} disabled={pending} onClick={() => setReceiving(true)}>Record received at Amazon</button> : null}
              {isDraft ? (
                <button type="button" className={btn.danger} disabled={pending} onClick={() => { if (confirm("Delete this draft shipment?")) run(async () => { const r = await deleteFbaShipment(accountId, sh.id); if (r.ok) router.push(inventoryHref("/inventory/fba-shipments", accountId)); return r; }); }}>Delete draft</button>
              ) : (
                <button type="button" className={btn.danger} disabled={pending} onClick={() => { if (confirm("Cancel this shipment? Units not yet received go back to the warehouse.")) run(() => cancelFbaShipment(accountId, sh.id), "Shipment cancelled."); }}>Cancel shipment</button>
              )}
            </div>
          ) : null}
        </div>
        <div className="mt-3 grid grid-cols-2 gap-3 text-sm md:grid-cols-5">
          <Stat label="Planned" value={fmtInt(totals.planned)} />
          <Stat label="Sent" value={isDraft ? "—" : fmtInt(totals.sent)} />
          <Stat label="Received by Amazon" value={isDraft ? "—" : `${fmtInt(totals.received)}${totals.sent ? ` (${Math.round((totals.received / totals.sent) * 100)}%)` : ""}`} />
          <Stat label="Cartons / pallets" value={`${fmtInt(totals.boxes)} / ${fmtDec(totals.pallets, 2)}`} />
          <Stat label="Discrepancy" value={isDraft || sh.status === "shipped" ? "—" : totals.sent - totals.received === 0 ? "none" : `${totals.sent - totals.received > 0 ? "" : "+"}${fmtInt(totals.received - totals.sent)}`} />
        </div>
      </Card>

      <Card title="Details" actions={canEdit && !isTerminal ? <button type="button" onClick={saveHeader} disabled={pending} className={btn.smallPrimary}>Save details</button> : null}>
        <div className="grid gap-3 md:grid-cols-3 lg:grid-cols-6">
          <Field label="Name" className="lg:col-span-2"><input value={header.shipmentName} onChange={(e) => setHeader({ ...header, shipmentName: e.target.value })} className={input} disabled={!canEdit || isTerminal} /></Field>
          <Field label="Amazon shipment ID"><input value={header.amazonShipmentId} onChange={(e) => setHeader({ ...header, amazonShipmentId: e.target.value })} className={`${input} font-mono`} placeholder="FBA15…" disabled={!canEdit || isTerminal} /></Field>
          <Field label="From warehouse">
            <select value={header.sourceWarehouseId} onChange={(e) => setHeader({ ...header, sourceWarehouseId: e.target.value })} className={input} disabled={!canEdit || !isDraft}>
              <option value="">—</option>
              {workspace.warehouses.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
            </select>
          </Field>
          <Field label="Ship date"><input type="date" value={header.shipDate} onChange={(e) => setHeader({ ...header, shipDate: e.target.value })} className={input} disabled={!canEdit || isTerminal} /></Field>
          <Field label="Expected at Amazon"><input type="date" value={header.expectedArrivalDate} onChange={(e) => setHeader({ ...header, expectedArrivalDate: e.target.value })} className={input} disabled={!canEdit || isTerminal} /></Field>
          <Field label="Carrier" className="lg:col-span-2"><input value={header.carrier} onChange={(e) => setHeader({ ...header, carrier: e.target.value })} className={input} disabled={!canEdit || isTerminal} /></Field>
          <Field label="Tracking / PRO number" className="lg:col-span-2"><input value={header.trackingRef} onChange={(e) => setHeader({ ...header, trackingRef: e.target.value })} className={input} disabled={!canEdit || isTerminal} /></Field>
          <Field label="Linked PO" className="lg:col-span-2">
            <p className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm">
              {sh.purchaseOrderId ? <Link href={inventoryHref(`/inventory/purchase-orders/${sh.purchaseOrderId}`, accountId)} className="font-medium text-plum-700 hover:underline">{sh.poNumber}</Link> : <span className="text-slate-400">none</span>}
            </p>
          </Field>
          <Field label="Notes" className="md:col-span-3 lg:col-span-6"><input value={header.notes} onChange={(e) => setHeader({ ...header, notes: e.target.value })} className={input} disabled={!canEdit || isTerminal} /></Field>
        </div>
      </Card>

      <Card
        title="Lines"
        subtitle={isDraft ? "Edit freely until the shipment leaves the warehouse." : "Locked after shipping — record received units instead."}
        actions={
          canEdit && isDraft ? (
            editingLines ? (
              <>
                <button type="button" className={btn.small} onClick={() => { setEditingLines(false); setLines(toLines()); }}>Cancel</button>
                <button type="button" className={btn.smallPrimary} onClick={saveLines} disabled={pending}>Save lines</button>
              </>
            ) : (
              <button type="button" className={btn.small} onClick={() => setEditingLines(true)}>Edit lines</button>
            )
          ) : null
        }
      >
        {editingLines ? (
          <LineEditor mode="fba" lines={lines} onChange={setLines} skus={workspace.skus} packProfiles={workspace.packProfiles} rows={workspace.rows} currency={workspace.currency} />
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full">
              <thead>
                <tr className="bg-slate-50">
                  <th className={th()}>SKU</th>
                  <th className={th()}>ASIN</th>
                  <th className={th("text-right")}>Planned</th>
                  <th className={th("text-right")}>Sent</th>
                  <th className={th("text-right")}>Received</th>
                  <th className={th("text-right")}>Diff</th>
                  <th className={th("text-right")}>Cartons</th>
                  <th className={th("text-right")}>Pallets</th>
                  <th className={th()}>Notes</th>
                </tr>
              </thead>
              <tbody>
                {sh.items.map((it) => {
                  const diff = it.receivedUnits - it.sentUnits;
                  return (
                    <tr key={it.id} className="border-t border-slate-100">
                      <td className={td()}><span className="block font-medium">{it.sku}</span><span className="block text-xs text-slate-500">{it.productName}</span></td>
                      <td className={td("font-mono text-xs")}>{it.asin || "—"}</td>
                      <td className={td("text-right")}>{fmtInt(it.plannedUnits)}</td>
                      <td className={td("text-right")}>{isDraft ? "—" : fmtInt(it.sentUnits)}</td>
                      <td className={td("text-right")}>{isDraft ? "—" : fmtInt(it.receivedUnits)}</td>
                      <td className={td("text-right")}>{isDraft || sh.status === "shipped" ? "—" : diff === 0 ? <span className="text-emerald-700">0</span> : <span className="font-medium text-amber-700">{diff > 0 ? "+" : ""}{diff}</span>}</td>
                      <td className={td("text-right")}>{it.boxes ?? (it.unitsPerBox ? Math.ceil(it.plannedUnits / it.unitsPerBox) : "—")}{it.unitsPerBox ? <span className="block text-[11px] text-slate-500">{it.unitsPerBox}/ctn</span> : null}</td>
                      <td className={td("text-right")}>{it.pallets == null ? "—" : fmtDec(it.pallets, 2)}</td>
                      <td className={td("text-xs text-slate-500")}>{it.notes || ""}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {shipping ? (
        <ShipModal sh={sh} workspace={workspace} accountId={accountId} onClose={() => setShipping(false)} onDone={(t) => { setShipping(false); setNotice({ kind: "ok", text: t }); router.refresh(); }} onError={(t) => setNotice({ kind: "error", text: t })} />
      ) : null}
      {receiving ? (
        <ReceiveModal sh={sh} workspace={workspace} accountId={accountId} onClose={() => setReceiving(false)} onDone={(t) => { setReceiving(false); setNotice({ kind: "ok", text: t }); router.refresh(); }} onError={(t) => setNotice({ kind: "error", text: t })} />
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

function ShipModal({ sh, workspace, accountId, onClose, onDone, onError }: { sh: FbaShipmentDetail; workspace: InventoryWorkspace; accountId: string; onClose: () => void; onDone: (t: string) => void; onError: (t: string) => void }) {
  const [pending, startTransition] = useTransition();
  const [date, setDate] = useState(sh.shipDate || workspace.today);
  const [amazonId, setAmazonId] = useState(sh.amazonShipmentId || "");
  const [carrier, setCarrier] = useState(sh.carrier || "");
  const [tracking, setTracking] = useState(sh.trackingRef || "");
  const [qty, setQty] = useState<Record<string, string>>(() => Object.fromEntries(sh.items.map((i) => [i.id, String(i.plannedUnits)])));
  const rowById = new Map(workspace.rows.map((r) => [r.mappingId, r]));

  function submit() {
    startTransition(async () => {
      const res = await shipFbaShipment(accountId, { shipmentId: sh.id, shipDate: date, amazonShipmentId: amazonId || null, carrier: carrier || null, trackingRef: tracking || null, lines: sh.items.map((i) => ({ itemId: i.id, sentUnits: Number(qty[i.id]) || 0 })) });
      if (!res.ok) onError(res.error);
      else onDone("Shipment marked as shipped. Units left the warehouse and are now in transit to Amazon.");
    });
  }

  return (
    <Modal title="Mark as shipped" onClose={onClose} wide>
      <p className="text-sm text-slate-600">Confirm what actually left the warehouse. The warehouse stock drops by these units and they count as “in transit” until Amazon checks them in.</p>
      <div className="mt-3 grid gap-3 md:grid-cols-4">
        <Field label="Ship date"><input type="date" value={date} onChange={(e) => setDate(e.target.value)} className={input} /></Field>
        <Field label="Amazon shipment ID"><input value={amazonId} onChange={(e) => setAmazonId(e.target.value)} className={`${input} font-mono`} placeholder="FBA15…" /></Field>
        <Field label="Carrier"><input value={carrier} onChange={(e) => setCarrier(e.target.value)} className={input} /></Field>
        <Field label="Tracking"><input value={tracking} onChange={(e) => setTracking(e.target.value)} className={input} /></Field>
      </div>
      <table className="mt-4 min-w-full text-sm">
        <thead>
          <tr className="bg-slate-50">
            <th className={th()}>SKU</th>
            <th className={th("text-right")}>Planned</th>
            <th className={th("text-right")}>3PL on hand</th>
            <th className={th("text-right")}>Sending</th>
          </tr>
        </thead>
        <tbody>
          {sh.items.map((i) => {
            const row = rowById.get(i.mappingId);
            const sending = Number(qty[i.id]) || 0;
            const over = row?.warehouseOnHand != null && sending > row.warehouseOnHand;
            return (
              <tr key={i.id} className="border-t border-slate-100">
                <td className={td()}><span className="font-medium">{i.sku}</span><span className="block text-xs text-slate-500">{i.productName}</span></td>
                <td className={td("text-right")}>{fmtInt(i.plannedUnits)}</td>
                <td className={td("text-right")}>{row?.warehouseOnHand == null ? "—" : fmtInt(row.warehouseOnHand)}</td>
                <td className={td("w-32 text-right")}>
                  <input value={qty[i.id] ?? ""} onChange={(e) => setQty({ ...qty, [i.id]: e.target.value })} className={`${inputSm} text-right ${over ? "border-amber-400" : ""}`} inputMode="numeric" />
                  {over ? <span className="block text-[11px] text-amber-700">more than the warehouse shows</span> : null}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <div className="mt-4 flex justify-end gap-2">
        <button type="button" className={btn.secondary} onClick={onClose} disabled={pending}>Cancel</button>
        <button type="button" className={btn.plum} onClick={submit} disabled={pending}>{pending ? "Saving…" : "Confirm shipped"}</button>
      </div>
    </Modal>
  );
}

function ReceiveModal({ sh, workspace, accountId, onClose, onDone, onError }: { sh: FbaShipmentDetail; workspace: InventoryWorkspace; accountId: string; onClose: () => void; onDone: (t: string) => void; onError: (t: string) => void }) {
  const [pending, startTransition] = useTransition();
  const [date, setDate] = useState(workspace.today);
  const [close, setClose] = useState(false);
  const [qty, setQty] = useState<Record<string, string>>(() => Object.fromEntries(sh.items.map((i) => [i.id, String(i.receivedUnits || i.sentUnits)])));

  function submit() {
    startTransition(async () => {
      const res = await receiveFbaShipment(accountId, { shipmentId: sh.id, date, close, lines: sh.items.map((i) => ({ itemId: i.id, receivedUnits: Number(qty[i.id]) || 0 })) });
      if (!res.ok) onError(res.error);
      else onDone(res.data!.status === "closed" ? "Shipment closed. FBA stock updated with the units Amazon received." : "Received units recorded. Shipment stays open until everything is checked in.");
    });
  }

  return (
    <Modal title="Received at Amazon" onClose={onClose} wide>
      <p className="text-sm text-slate-600">Enter the total units Amazon has checked in so far for each SKU (from the shipment’s “Received” column in Seller Central). FBA stock increases by the change; shortfalls are highlighted for a reimbursement claim.</p>
      <div className="mt-3 grid gap-3 md:grid-cols-3">
        <Field label="Date"><input type="date" value={date} onChange={(e) => setDate(e.target.value)} className={input} /></Field>
        <label className="flex items-end gap-2 pb-2 text-sm text-slate-700"><input type="checkbox" checked={close} onChange={(e) => setClose(e.target.checked)} /> Close shipment now (Amazon has finished receiving)</label>
      </div>
      <table className="mt-4 min-w-full text-sm">
        <thead>
          <tr className="bg-slate-50">
            <th className={th()}>SKU</th>
            <th className={th("text-right")}>Sent</th>
            <th className={th("text-right")}>Received so far</th>
            <th className={th("text-right")}>Received total (cumulative)</th>
            <th className={th("text-right")}>Diff</th>
          </tr>
        </thead>
        <tbody>
          {sh.items.map((i) => {
            const v = Number(qty[i.id]) || 0;
            const diff = v - i.sentUnits;
            return (
              <tr key={i.id} className="border-t border-slate-100">
                <td className={td()}><span className="font-medium">{i.sku}</span><span className="block text-xs text-slate-500">{i.productName}</span></td>
                <td className={td("text-right")}>{fmtInt(i.sentUnits)}</td>
                <td className={td("text-right")}>{fmtInt(i.receivedUnits)}</td>
                <td className={td("w-36 text-right")}><input value={qty[i.id] ?? ""} onChange={(e) => setQty({ ...qty, [i.id]: e.target.value })} className={`${inputSm} text-right`} inputMode="numeric" /></td>
                <td className={td("text-right")}>{diff === 0 ? <span className="text-emerald-700">0</span> : <span className="font-medium text-amber-700">{diff > 0 ? "+" : ""}{diff}</span>}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <div className="mt-4 flex justify-end gap-2">
        <button type="button" className={btn.secondary} onClick={onClose} disabled={pending}>Cancel</button>
        <button type="button" className={btn.primary} onClick={submit} disabled={pending}>{pending ? "Saving…" : close ? "Save & close shipment" : "Save received units"}</button>
      </div>
    </Modal>
  );
}
