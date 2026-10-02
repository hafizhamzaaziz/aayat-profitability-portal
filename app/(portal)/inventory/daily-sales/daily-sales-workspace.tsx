"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { InventoryWorkspace } from "@/lib/inventory/workspace";
import { addDays, formatUkDate } from "@/lib/utils/date";
import { bulkSetDailySalesWarehouse, deleteDailySale, resyncDailySalesFromAmazon, saveDailySales, type DailySaleInput } from "../actions";
import { inventoryHref } from "../_components/inventory-shell";
import { Card, EmptyState, Field, Kpi, Modal, Notice, SkuPicker, btn, fmtInt, input, inputSm, td, th } from "../_components/ui";

export type DailySaleRow = {
  id: string;
  mappingId: string;
  saleDate: string;
  platform: "amazon" | "temu" | "tiktok";
  channel: "fba" | "fbm" | null;
  warehouseId: string | null;
  soldUnits: number;
  returnsUnits: number;
  collectedUnits: number;
  notes: string | null;
  source: string;
};

type ChannelKey = "fba" | "fbm" | "temu" | "tiktok";

function channelOf(r: Pick<DailySaleRow, "platform" | "channel">): ChannelKey {
  if (r.platform === "amazon") return r.channel === "fba" ? "fba" : "fbm";
  return r.platform;
}

const CHANNEL_LABEL: Record<ChannelKey, string> = { fba: "Amazon FBA", fbm: "Amazon FBM", temu: "Temu", tiktok: "TikTok" };
const CHANNEL_TONE: Record<ChannelKey, string> = {
  fba: "bg-amber-50 text-amber-800 border-amber-200",
  fbm: "bg-sky-50 text-sky-800 border-sky-200",
  temu: "bg-orange-50 text-orange-800 border-orange-200",
  tiktok: "bg-slate-100 text-slate-800 border-slate-200",
};

export default function DailySalesWorkspace({ workspace, accountId, canEdit, rows, from, to, error }: { workspace: InventoryWorkspace; accountId: string; canEdit: boolean; rows: DailySaleRow[]; from: string; to: string; error: string | null }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [notice, setNotice] = useState<{ kind: "ok" | "error" | "info"; text: string } | null>(error ? { kind: "error", text: error } : null);
  const [range, setRange] = useState({ from, to });
  const [channel, setChannel] = useState<"" | ChannelKey>("");
  const [warehouseFilter, setWarehouseFilter] = useState("");
  const [skuFilter, setSkuFilter] = useState("");
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkWarehouse, setBulkWarehouse] = useState(workspace.defaultWarehouseId || "");
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<DailySaleRow | null>(null);
  const [group, setGroup] = useState<"rows" | "day">("rows");

  const skuById = useMemo(() => new Map(workspace.skus.map((s) => [s.mappingId, s])), [workspace.skus]);
  const warehouseName = useMemo(() => new Map(workspace.warehouses.map((w) => [w.id, w.name])), [workspace.warehouses]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return rows.filter((r) => {
      if (channel && channelOf(r) !== channel) return false;
      if (warehouseFilter === "none" ? r.warehouseId : warehouseFilter && r.warehouseId !== warehouseFilter) return false;
      if (skuFilter && r.mappingId !== skuFilter) return false;
      if (q) {
        const s = skuById.get(r.mappingId);
        if (!`${s?.productName || ""} ${s?.amazonSku || ""} ${s?.temuSkuId || ""} ${s?.tiktokSku || ""} ${r.notes || ""}`.toLowerCase().includes(q)) return false;
      }
      return true;
    });
  }, [rows, channel, warehouseFilter, skuFilter, search, skuById]);

  const totals = useMemo(() => {
    const t: Record<ChannelKey, number> = { fba: 0, fbm: 0, temu: 0, tiktok: 0 };
    let returns = 0, unassigned = 0;
    for (const r of filtered) {
      t[channelOf(r)] += r.soldUnits;
      returns += r.returnsUnits;
      if (channelOf(r) !== "fba" && !r.warehouseId && r.soldUnits > 0) unassigned += 1;
    }
    return { ...t, returns, unassigned, all: t.fba + t.fbm + t.temu + t.tiktok };
  }, [filtered]);

  const byDay = useMemo(() => {
    const m = new Map<string, Record<ChannelKey, number> & { returns: number; rows: number }>();
    for (const r of filtered) {
      const d = m.get(r.saleDate) || { fba: 0, fbm: 0, temu: 0, tiktok: 0, returns: 0, rows: 0 };
      d[channelOf(r)] += r.soldUnits;
      d.returns += r.returnsUnits;
      d.rows += 1;
      m.set(r.saleDate, d);
    }
    return Array.from(m.entries()).sort((a, b) => (a[0] < b[0] ? 1 : -1));
  }, [filtered]);

  function applyRange(next: { from: string; to: string }) {
    setRange(next);
    router.push(inventoryHref("/inventory/daily-sales", accountId, { from: next.from, to: next.to }));
  }

  function toggleAll(on: boolean) {
    setSelected(on ? new Set(filtered.filter((r) => channelOf(r) !== "fba").map((r) => r.id)) : new Set());
  }

  function applyBulkWarehouse() {
    const ids = Array.from(selected);
    if (ids.length === 0) return;
    startTransition(async () => {
      const res = await bulkSetDailySalesWarehouse(accountId, ids, bulkWarehouse || null);
      if (!res.ok) setNotice({ kind: "error", text: res.error });
      else {
        setNotice({ kind: "ok", text: `Warehouse updated on ${res.data?.updated} row${res.data?.updated === 1 ? "" : "s"}.` });
        setSelected(new Set());
      }
      router.refresh();
    });
  }

  function resync() {
    startTransition(async () => {
      const res = await resyncDailySalesFromAmazon(accountId, { from: range.from, to: range.to });
      if (!res.ok) setNotice({ kind: "error", text: res.error });
      else setNotice({ kind: "ok", text: "Amazon rows for this range were rebuilt from the synced order data." });
      router.refresh();
    });
  }

  function remove(r: DailySaleRow) {
    if (!confirm("Delete this row?")) return;
    startTransition(async () => {
      const res = await deleteDailySale(accountId, r.id);
      if (!res.ok) setNotice({ kind: "error", text: res.error });
      router.refresh();
    });
  }

  function exportCsv() {
    const head = ["Date", "Product", "SKU", "Channel", "Warehouse", "Sold", "Returns", "Collected", "Notes", "Source"];
    const lines = filtered.map((r) => {
      const s = skuById.get(r.mappingId);
      return [r.saleDate, s?.productName || "", s?.amazonSku || s?.temuSkuId || s?.tiktokSku || "", CHANNEL_LABEL[channelOf(r)], r.warehouseId ? warehouseName.get(r.warehouseId) || "" : "", r.soldUnits, r.returnsUnits, r.collectedUnits, r.notes || "", r.source];
    });
    const csv = [head, ...lines].map((row) => row.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(",")).join("\n");
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
    a.download = `daily-sales-${range.from}_${range.to}.csv`;
    a.click();
  }

  const pdfParams = new URLSearchParams({ accountId, from: range.from, to: range.to });
  if (channel) pdfParams.set("channel", channel);
  if (warehouseFilter && warehouseFilter !== "none") pdfParams.set("warehouseId", warehouseFilter);
  if (skuFilter) pdfParams.set("mappingId", skuFilter);
  if (search.trim()) pdfParams.set("skuSearch", search.trim());

  return (
    <div className="space-y-4">
      {notice ? <Notice kind={notice.kind}>{notice.text}</Notice> : null}

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <Kpi label="Units sold" value={fmtInt(totals.all)} hint={`${formatUkDate(range.from)} – ${formatUkDate(range.to)}`} />
        <Kpi label="Amazon FBA" value={fmtInt(totals.fba)} hint="from Amazon's stock" />
        <Kpi label="Amazon FBM" value={fmtInt(totals.fbm)} hint="shipped by 3PL" />
        <Kpi label="Temu" value={fmtInt(totals.temu)} hint="shipped by 3PL" />
        <Kpi label="TikTok" value={fmtInt(totals.tiktok)} hint="shipped by 3PL" />
        <Kpi label="Needs warehouse" value={fmtInt(totals.unassigned)} hint="3PL rows with no warehouse" tone={totals.unassigned > 0 ? "warn" : "good"} />
      </div>

      <Card
        actions={
          <>
            <button type="button" className={btn.small} onClick={exportCsv}>CSV</button>
            <a className={btn.small} href={`/api/inventory/daily-sales/pdf?${pdfParams.toString()}`} target="_blank" rel="noreferrer">PDF</a>
            {canEdit ? <button type="button" className={btn.small} onClick={resync} disabled={pending}>Re-sync Amazon rows</button> : null}
            {canEdit ? <button type="button" className={btn.smallPrimary} onClick={() => setAdding(true)}>Log sales</button> : null}
          </>
        }
      >
        <div className="grid gap-3 md:grid-cols-3 xl:grid-cols-7">
          <Field label="From"><input type="date" value={range.from} onChange={(e) => setRange({ ...range, from: e.target.value })} onBlur={() => applyRange(range)} className={input} /></Field>
          <Field label="To"><input type="date" value={range.to} onChange={(e) => setRange({ ...range, to: e.target.value })} onBlur={() => applyRange(range)} className={input} /></Field>
          <Field label="Quick range">
            <div className="flex gap-1">
              {[7, 14, 30, 90].map((d) => (
                <button key={d} type="button" className={btn.small} onClick={() => applyRange({ from: addDays(workspace.today, -(d - 1)), to: workspace.today })}>{d}d</button>
              ))}
            </div>
          </Field>
          <Field label="Channel">
            <select value={channel} onChange={(e) => setChannel(e.target.value as "" | ChannelKey)} className={input}>
              <option value="">All</option>
              {(Object.keys(CHANNEL_LABEL) as ChannelKey[]).map((k) => <option key={k} value={k}>{CHANNEL_LABEL[k]}</option>)}
            </select>
          </Field>
          <Field label="Warehouse">
            <select value={warehouseFilter} onChange={(e) => setWarehouseFilter(e.target.value)} className={input}>
              <option value="">All</option>
              <option value="none">Not assigned</option>
              {workspace.warehouses.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
            </select>
          </Field>
          <Field label="SKU"><SkuPicker options={workspace.skus} value={skuFilter} onChange={setSkuFilter} placeholder="All SKUs" /></Field>
          <Field label="Search"><input value={search} onChange={(e) => setSearch(e.target.value)} className={input} placeholder="Product, SKU, note…" /></Field>
        </div>
      </Card>

      <Card
        title={group === "rows" ? `${fmtInt(filtered.length)} rows` : "By day"}
        actions={
          <>
            <div className="flex rounded-lg border border-slate-200 p-0.5 text-xs">
              <button type="button" onClick={() => setGroup("rows")} className={`rounded-md px-2 py-1 ${group === "rows" ? "bg-plum-700 text-white" : "text-slate-600"}`}>Rows</button>
              <button type="button" onClick={() => setGroup("day")} className={`rounded-md px-2 py-1 ${group === "day" ? "bg-plum-700 text-white" : "text-slate-600"}`}>By day</button>
            </div>
            {canEdit && selected.size > 0 ? (
              <>
                <span className="text-xs text-slate-600">{selected.size} selected →</span>
                <select value={bulkWarehouse} onChange={(e) => setBulkWarehouse(e.target.value)} className={inputSm} style={{ width: 160 }}>
                  <option value="">No warehouse</option>
                  {workspace.warehouses.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
                </select>
                <button type="button" className={btn.smallPrimary} onClick={applyBulkWarehouse} disabled={pending}>Set warehouse</button>
              </>
            ) : null}
          </>
        }
      >
        {group === "day" ? (
          byDay.length === 0 ? <EmptyState>No sales in this range.</EmptyState> : (
            <div className="overflow-x-auto">
              <table className="min-w-full text-sm">
                <thead><tr className="bg-slate-50"><th className={th()}>Date</th><th className={th("text-right")}>FBA</th><th className={th("text-right")}>FBM</th><th className={th("text-right")}>Temu</th><th className={th("text-right")}>TikTok</th><th className={th("text-right")}>Total</th><th className={th("text-right")}>Returns</th><th className={th("text-right")}>Rows</th></tr></thead>
                <tbody>
                  {byDay.map(([d, v]) => (
                    <tr key={d} className="border-t border-slate-100">
                      <td className={td()}>{formatUkDate(d)}</td>
                      <td className={td("text-right")}>{fmtInt(v.fba)}</td>
                      <td className={td("text-right")}>{fmtInt(v.fbm)}</td>
                      <td className={td("text-right")}>{fmtInt(v.temu)}</td>
                      <td className={td("text-right")}>{fmtInt(v.tiktok)}</td>
                      <td className={td("text-right font-semibold")}>{fmtInt(v.fba + v.fbm + v.temu + v.tiktok)}</td>
                      <td className={td("text-right")}>{fmtInt(v.returns)}</td>
                      <td className={td("text-right text-slate-500")}>{fmtInt(v.rows)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
        ) : filtered.length === 0 ? (
          <EmptyState>No sales rows in this range. Amazon rows appear after the hourly sync; log Temu / TikTok dispatches with “Log sales”.</EmptyState>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead>
                <tr className="bg-slate-50">
                  {canEdit ? <th className={th("w-8")}><input type="checkbox" checked={selected.size > 0 && selected.size === filtered.filter((r) => channelOf(r) !== "fba").length} onChange={(e) => toggleAll(e.target.checked)} /></th> : null}
                  <th className={th()}>Date</th>
                  <th className={th()}>Product</th>
                  <th className={th()}>Channel</th>
                  <th className={th()}>Warehouse</th>
                  <th className={th("text-right")}>Sold</th>
                  <th className={th("text-right")}>Returns</th>
                  <th className={th("text-right")}>Collected</th>
                  <th className={th()}>Notes</th>
                  <th className={th()}></th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((r) => {
                  const s = skuById.get(r.mappingId);
                  const ch = channelOf(r);
                  const synced = r.source !== "manual";
                  const missingWh = ch !== "fba" && !r.warehouseId && r.soldUnits > 0;
                  return (
                    <tr key={r.id} className="border-t border-slate-100">
                      {canEdit ? <td className={td()}>{ch !== "fba" ? <input type="checkbox" checked={selected.has(r.id)} onChange={(e) => { const n = new Set(selected); if (e.target.checked) n.add(r.id); else n.delete(r.id); setSelected(n); }} /> : null}</td> : null}
                      <td className={td("whitespace-nowrap")}>{formatUkDate(r.saleDate)}</td>
                      <td className={td()}><span className="font-medium">{s?.productName || "Unknown SKU"}</span><span className="block text-xs text-slate-500">{s?.amazonSku || s?.temuSkuId || s?.tiktokSku || ""}</span></td>
                      <td className={td()}><span className={`rounded-full border px-2 py-0.5 text-xs font-medium ${CHANNEL_TONE[ch]}`}>{CHANNEL_LABEL[ch]}</span>{synced ? <span className="ml-1 text-[10px] uppercase tracking-wide text-slate-400">sync</span> : null}</td>
                      <td className={td()}>{ch === "fba" ? <span className="text-xs text-slate-400">Amazon</span> : r.warehouseId ? warehouseName.get(r.warehouseId) || "—" : <span className={`text-xs ${missingWh ? "font-semibold text-amber-700" : "text-slate-400"}`}>not set</span>}</td>
                      <td className={td("text-right font-medium")}>{fmtInt(r.soldUnits)}</td>
                      <td className={td("text-right")}>{r.returnsUnits ? fmtInt(r.returnsUnits) : <span className="text-slate-300">0</span>}</td>
                      <td className={td("text-right")}>{r.collectedUnits ? fmtInt(r.collectedUnits) : <span className="text-slate-300">0</span>}</td>
                      <td className={td("max-w-[220px] truncate text-xs text-slate-500")} title={r.notes || ""}>{r.notes || ""}</td>
                      <td className={td("whitespace-nowrap text-right text-xs")}>
                        {canEdit ? (
                          <>
                            <button type="button" className="text-plum-700 hover:underline" onClick={() => setEditing(r)}>edit</button>
                            {!synced ? <button type="button" className="ml-2 text-rose-600 hover:underline" onClick={() => remove(r)} disabled={pending}>delete</button> : null}
                          </>
                        ) : null}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {adding ? (
        <LogSalesModal workspace={workspace} accountId={accountId} onClose={() => setAdding(false)} onDone={(t) => { setAdding(false); setNotice({ kind: "ok", text: t }); router.refresh(); }} onError={(t) => setNotice({ kind: "error", text: t })} />
      ) : null}
      {editing ? (
        <EditRowModal row={editing} workspace={workspace} accountId={accountId} onClose={() => setEditing(null)} onDone={(t) => { setEditing(null); setNotice({ kind: "ok", text: t }); router.refresh(); }} onError={(t) => setNotice({ kind: "error", text: t })} />
      ) : null}
    </div>
  );
}

type Draft = { key: string; mappingId: string; sold: string; returns: string; collected: string; notes: string };

function LogSalesModal({ workspace, accountId, onClose, onDone, onError }: { workspace: InventoryWorkspace; accountId: string; onClose: () => void; onDone: (t: string) => void; onError: (t: string) => void }) {
  const [pending, startTransition] = useTransition();
  const [date, setDate] = useState(workspace.today);
  const [channel, setChannel] = useState<ChannelKey>("temu");
  const [warehouseId, setWarehouseId] = useState(workspace.defaultWarehouseId || "");
  const [lines, setLines] = useState<Draft[]>([{ key: crypto.randomUUID(), mappingId: "", sold: "", returns: "", collected: "", notes: "" }]);

  // SKUs that have an id on the chosen channel come first; the rest stay available.
  const options = useMemo(() => {
    const has = (s: InventoryWorkspace["skus"][number]) => (channel === "temu" ? !!s.temuSkuId : channel === "tiktok" ? !!s.tiktokSku : !!s.amazonSku);
    return [...workspace.skus].sort((a, b) => Number(has(b)) - Number(has(a)) || a.productName.localeCompare(b.productName));
  }, [workspace.skus, channel]);

  function setLine(key: string, patch: Partial<Draft>) {
    setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  }

  function submit() {
    const payload: DailySaleInput[] = lines
      .filter((l) => l.mappingId && (Number(l.sold) || Number(l.returns) || Number(l.collected)))
      .map((l) => ({
        mappingId: l.mappingId,
        saleDate: date,
        platform: channel === "fba" || channel === "fbm" ? "amazon" : channel,
        channel: channel === "fba" ? "fba" : channel === "fbm" ? "fbm" : null,
        warehouseId: channel === "fba" ? null : warehouseId || null,
        soldUnits: Number(l.sold) || 0,
        returnsUnits: Number(l.returns) || 0,
        collectedUnits: Number(l.collected) || 0,
        notes: l.notes || null,
      }));
    if (payload.length === 0) return onError("Add at least one SKU with units.");
    startTransition(async () => {
      const res = await saveDailySales(accountId, payload);
      if (!res.ok) onError(res.error);
      else onDone(`${res.data?.saved} row${res.data?.saved === 1 ? "" : "s"} logged for ${formatUkDate(date)}.`);
    });
  }

  return (
    <Modal title="Log sales" onClose={onClose} wide>
      <div className="grid gap-3 md:grid-cols-3">
        <Field label="Date"><input type="date" value={date} onChange={(e) => setDate(e.target.value)} className={input} /></Field>
        <Field label="Channel" hint={channel === "fba" || channel === "fbm" ? "Amazon rows normally arrive automatically — only add here if the sync is missing something." : undefined}>
          <select value={channel} onChange={(e) => setChannel(e.target.value as ChannelKey)} className={input}>
            <option value="temu">Temu</option>
            <option value="tiktok">TikTok</option>
            <option value="fbm">Amazon FBM</option>
            <option value="fba">Amazon FBA</option>
          </select>
        </Field>
        {channel !== "fba" ? (
          <Field label="Shipped from">
            <select value={warehouseId} onChange={(e) => setWarehouseId(e.target.value)} className={input}>
              <option value="">—</option>
              {workspace.warehouses.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
            </select>
          </Field>
        ) : <div />}
      </div>
      <table className="mt-4 min-w-full text-sm">
        <thead><tr className="bg-slate-50"><th className={th()}>SKU</th><th className={th("w-24 text-right")}>Sold</th><th className={th("w-24 text-right")}>Returns</th><th className={th("w-24 text-right")}>Collected</th><th className={th()}>Notes</th><th className={th("w-8")}></th></tr></thead>
        <tbody>
          {lines.map((l) => (
            <tr key={l.key} className="border-t border-slate-100">
              <td className={td("min-w-[260px]")}><SkuPicker options={options} value={l.mappingId} onChange={(v) => setLine(l.key, { mappingId: v })} /></td>
              <td className={td()}><input value={l.sold} onChange={(e) => setLine(l.key, { sold: e.target.value })} className={`${inputSm} text-right`} inputMode="numeric" /></td>
              <td className={td()}><input value={l.returns} onChange={(e) => setLine(l.key, { returns: e.target.value })} className={`${inputSm} text-right`} inputMode="numeric" /></td>
              <td className={td()}><input value={l.collected} onChange={(e) => setLine(l.key, { collected: e.target.value })} className={`${inputSm} text-right`} inputMode="numeric" /></td>
              <td className={td()}><input value={l.notes} onChange={(e) => setLine(l.key, { notes: e.target.value })} className={inputSm} /></td>
              <td className={td()}><button type="button" className="text-xs text-rose-600" onClick={() => setLines((ls) => ls.filter((x) => x.key !== l.key))}>✕</button></td>
            </tr>
          ))}
        </tbody>
      </table>
      <button type="button" className={`${btn.small} mt-2`} onClick={() => setLines((ls) => [...ls, { key: crypto.randomUUID(), mappingId: "", sold: "", returns: "", collected: "", notes: "" }])}>+ Add SKU</button>
      <div className="mt-4 flex justify-end gap-2">
        <button type="button" className={btn.secondary} onClick={onClose} disabled={pending}>Cancel</button>
        <button type="button" className={btn.primary} onClick={submit} disabled={pending}>{pending ? "Saving…" : "Save"}</button>
      </div>
    </Modal>
  );
}

function EditRowModal({ row, workspace, accountId, onClose, onDone, onError }: { row: DailySaleRow; workspace: InventoryWorkspace; accountId: string; onClose: () => void; onDone: (t: string) => void; onError: (t: string) => void }) {
  const [pending, startTransition] = useTransition();
  const synced = row.source !== "manual";
  const ch = channelOf(row);
  const [form, setForm] = useState({ saleDate: row.saleDate, warehouseId: row.warehouseId || "", sold: String(row.soldUnits), returns: String(row.returnsUnits), collected: String(row.collectedUnits), notes: row.notes || "" });
  const sku = workspace.skus.find((s) => s.mappingId === row.mappingId);

  function submit() {
    startTransition(async () => {
      const res = await saveDailySales(accountId, [{
        id: row.id,
        mappingId: row.mappingId,
        saleDate: form.saleDate,
        platform: row.platform,
        channel: row.channel,
        warehouseId: ch === "fba" ? null : form.warehouseId || null,
        soldUnits: Number(form.sold) || 0,
        returnsUnits: Number(form.returns) || 0,
        collectedUnits: Number(form.collected) || 0,
        notes: form.notes || null,
      }]);
      if (!res.ok) onError(res.error);
      else onDone("Row updated.");
    });
  }

  return (
    <Modal title={`Edit · ${sku?.productName || "row"}`} onClose={onClose}>
      {synced ? <Notice kind="info">This row is synced from Amazon. Units are rebuilt on every sync, so only the warehouse and notes stick.</Notice> : null}
      <div className="mt-3 grid grid-cols-2 gap-3">
        <Field label="Date"><input type="date" value={form.saleDate} onChange={(e) => setForm({ ...form, saleDate: e.target.value })} className={input} disabled={synced} /></Field>
        <Field label="Channel"><p className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm">{CHANNEL_LABEL[ch]}</p></Field>
        {ch !== "fba" ? (
          <Field label="Shipped from">
            <select value={form.warehouseId} onChange={(e) => setForm({ ...form, warehouseId: e.target.value })} className={input}>
              <option value="">—</option>
              {workspace.warehouses.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
            </select>
          </Field>
        ) : <div />}
        <Field label="Sold"><input value={form.sold} onChange={(e) => setForm({ ...form, sold: e.target.value })} className={input} inputMode="numeric" disabled={synced} /></Field>
        <Field label="Returns"><input value={form.returns} onChange={(e) => setForm({ ...form, returns: e.target.value })} className={input} inputMode="numeric" disabled={synced} /></Field>
        <Field label="Collected"><input value={form.collected} onChange={(e) => setForm({ ...form, collected: e.target.value })} className={input} inputMode="numeric" disabled={synced} /></Field>
        <Field label="Notes" className="col-span-2"><input value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} className={input} /></Field>
      </div>
      <div className="mt-4 flex justify-end gap-2">
        <button type="button" className={btn.secondary} onClick={onClose} disabled={pending}>Cancel</button>
        <button type="button" className={btn.primary} onClick={submit} disabled={pending}>{pending ? "Saving…" : "Save"}</button>
      </div>
    </Modal>
  );
}
