"use client";

import Link from "next/link";
import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { InventoryWorkspace } from "@/lib/inventory/workspace";
import { formatUkDate } from "@/lib/utils/date";
import { deleteMovement, recordAdjustment, type AdjustmentType } from "../actions";
import { inventoryHref } from "../_components/inventory-shell";
import { Card, EmptyState, Field, Modal, Notice, SkuPicker, SortHeader, BusyOverlay, ProductCell, btn, fmtInt, input, inputSm, td, th } from "../_components/ui";

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
  actor: string | null;
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

function eventWhy(event: LedgerEvent) {
  const note = event.notes?.trim();
  if (note) return note;
  if (event.reference) return event.reference.label;
  if (event.kind === "stock_take") return "Stock take. No reason was recorded.";
  return "No reason was recorded.";
}

function eventWhen(event: LedgerEvent) {
  const saved = new Date(event.createdAt);
  if (Number.isNaN(saved.getTime())) return { clock: formatUkDate(event.date), stockDate: null as string | null };
  const clock = saved.toLocaleString("en-GB", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
  const savedDay = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London" }).format(saved);
  return { clock, stockDate: savedDay === event.date ? null : formatUkDate(event.date) };
}

function eventPlace(event: LedgerEvent) {
  if (event.kind === "stock_take") return "FBA and 3PL";
  return event.location === "amazon" ? "Amazon FBA" : event.warehouse || "3PL";
}

type LedgerSort = "when" | "who" | "product" | "event" | "units" | "why";

export default function EventsWorkspace({
  workspace,
  accountId,
  canEdit,
  events,
}: {
  workspace: InventoryWorkspace;
  accountId: string;
  canEdit: boolean;
  events: LedgerEvent[];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [notice, setNotice] = useState<{ kind: "ok" | "error" | "info"; text: string } | null>(null);
  const [adjusting, setAdjusting] = useState(false);
  const [ledgerSku, setLedgerSku] = useState("");
  const [ledgerType, setLedgerType] = useState("");
  const [ledgerSort, setLedgerSort] = useState<{ key: LedgerSort; dir: "asc" | "desc" }>({ key: "when", dir: "desc" });

  const skuById = useMemo(() => new Map(workspace.skus.map((s) => [s.mappingId, s])), [workspace.skus]);

  const ledger = useMemo(() => {
    const dir = ledgerSort.dir === "asc" ? 1 : -1;
    const rows = events.filter((e) => (!ledgerSku || e.mappingId === ledgerSku) && (!ledgerType || e.type === ledgerType));
    rows.sort((a, b) => {
      const skuA = skuById.get(a.mappingId);
      const skuB = skuById.get(b.mappingId);
      const pick = (e: LedgerEvent, skuName: string) => {
        switch (ledgerSort.key) {
          case "when":
            return e.createdAt;
          case "who":
            return (e.actor || "Not recorded").toLowerCase();
          case "product":
            return skuName.toLowerCase();
          case "event":
            return TYPE_LABEL[e.type] || e.type;
          case "units":
            return e.kind === "stock_take" ? (e.warehouseUnits ?? 0) : e.delta;
          case "why":
            return eventWhy(e).toLowerCase();
        }
      };
      const av = pick(a, skuA?.productName || "");
      const bv = pick(b, skuB?.productName || "");
      if (typeof av === "number" && typeof bv === "number") return (av - bv) * dir;
      return String(av).localeCompare(String(bv)) * dir;
    });
    return rows.slice(0, 400);
  }, [events, ledgerSku, ledgerType, ledgerSort, skuById]);

  function toggleLedger(key: LedgerSort) {
    setLedgerSort((s) => (s.key === key ? { key, dir: s.dir === "asc" ? "desc" : "asc" } : { key, dir: key === "when" || key === "units" ? "desc" : "asc" }));
  }

  function removeMovement(id: string) {
    if (!confirm("Delete this event? Stock will be recalculated without it.")) return;
    startTransition(async () => {
      const res = await deleteMovement(accountId, id);
      if (!res.ok) setNotice({ kind: "error", text: res.error });
      router.refresh();
    });
  }

  return (
    <div className="space-y-4">
      <BusyOverlay show={pending} label="Saving…" />
      {notice ? <Notice kind={notice.kind}>{notice.text}</Notice> : null}
      <Card
        title="Events"
        subtitle="Who changed a stock number, when they did it, and why. Receipts and FBA shipments open on their own pages. A manual correction can be deleted here."
        actions={
          <>
            <div style={{ width: 240 }}><SkuPicker options={workspace.skus} value={ledgerSku} onChange={setLedgerSku} placeholder="All SKUs" /></div>
            <select value={ledgerType} onChange={(e) => setLedgerType(e.target.value)} className={inputSm} style={{ width: 190 }}>
              <option value="">All types</option>
              {Object.entries(TYPE_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
            {canEdit ? <button type="button" className={btn.small} onClick={() => setAdjusting(true)}>Return / adjustment</button> : null}
          </>
        }
      >
        {ledger.length === 0 ? (
          <EmptyState>No events yet. Receive a purchase order, ship to FBA, or record a stock take with a reason.</EmptyState>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead>
                <tr className="bg-slate-50">
                  <SortHeader label="When" active={ledgerSort.key === "when"} dir={ledgerSort.dir} onClick={() => toggleLedger("when")} />
                  <SortHeader label="Who" active={ledgerSort.key === "who"} dir={ledgerSort.dir} onClick={() => toggleLedger("who")} />
                  <SortHeader label="Product" active={ledgerSort.key === "product"} dir={ledgerSort.dir} onClick={() => toggleLedger("product")} />
                  <SortHeader label="Change" active={ledgerSort.key === "event"} dir={ledgerSort.dir} onClick={() => toggleLedger("event")} />
                  <SortHeader label="Units" align="right" active={ledgerSort.key === "units"} dir={ledgerSort.dir} onClick={() => toggleLedger("units")} />
                  <SortHeader label="Why" active={ledgerSort.key === "why"} dir={ledgerSort.dir} onClick={() => toggleLedger("why")} />
                  <th className={th()}></th>
                </tr>
              </thead>
              <tbody>
                {ledger.map((e) => {
                  const sku = skuById.get(e.mappingId);
                  const when = eventWhen(e);
                  return (
                    <tr key={`${e.kind}-${e.id}`} className="border-t border-slate-100">
                      <td className={td("whitespace-nowrap")}>
                        {when.clock}
                        {when.stockDate ? <span className="block text-[11px] text-slate-400">Stock date {when.stockDate}</span> : null}
                      </td>
                      <td className={td()}>{e.actor || "Not recorded"}</td>
                      <td className={td()}><ProductCell productName={sku?.productName || "Unknown SKU"} amazonSku={sku?.amazonSku} asin={sku?.asin} temuSkuId={sku?.temuSkuId} tiktokSku={sku?.tiktokSku} /></td>
                      <td className={td()}>
                        {TYPE_LABEL[e.type] || e.type}
                        <span className="block text-[11px] text-slate-400">{eventPlace(e)}</span>
                      </td>
                      <td className={td("text-right")}>
                        {e.kind === "stock_take" ? (
                          <span className="text-xs">FBA {fmtInt(e.fba)} · 3PL {fmtInt(e.warehouseUnits)}</span>
                        ) : (
                          <span className={e.delta > 0 ? "text-emerald-700" : "text-rose-700"}>{e.delta > 0 ? "+" : ""}{fmtInt(e.delta)}</span>
                        )}
                      </td>
                      <td className={td("text-xs text-slate-700")}>
                        {e.reference ? (
                          <>
                            {e.notes?.trim() ? <span className="block">{e.notes.trim()}</span> : null}
                            <Link href={inventoryHref(e.reference.href, accountId)} className="text-plum-700 hover:underline">{e.reference.label}</Link>
                          </>
                        ) : eventWhy(e)}
                      </td>
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
    if (!notes.trim()) return onError("Add a reason for this change.");
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
        <Field label="Why"><input value={notes} onChange={(e) => setNotes(e.target.value)} className={input} placeholder="Why is this stock changing?" /></Field>
      </div>
      <div className="mt-4 flex justify-end gap-2">
        <button type="button" className={btn.secondary} onClick={onClose} disabled={pending}>Cancel</button>
        <button type="button" className={btn.primary} onClick={submit} disabled={pending}>{pending ? "Saving…" : "Record"}</button>
      </div>
    </Modal>
  );
}
