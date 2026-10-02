"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { InventoryWorkspace, PackProfileRef, Supplier } from "@/lib/inventory/workspace";
import {
  bulkUpdateSkuPlanning,
  deletePackProfile,
  deleteSupplier,
  deleteWarehouse,
  saveInventorySettings,
  upsertPackProfile,
  upsertSupplier,
  upsertWarehouse,
  type InventorySettingsInput,
  type PackProfileInput,
  type SupplierInput,
} from "../actions";
import { Card, EmptyState, Field, Modal, Notice, btn, fmtInt, input, inputSm, td, th } from "../_components/ui";

type Tab = "planning" | "suppliers" | "warehouses" | "cartons" | "skus";
const TABS: Array<{ key: Tab; label: string }> = [
  { key: "planning", label: "Planning rules" },
  { key: "suppliers", label: "Suppliers" },
  { key: "warehouses", label: "Warehouses" },
  { key: "cartons", label: "Carton profiles" },
  { key: "skus", label: "SKU planning" },
];

export default function SettingsWorkspace({ workspace, accountId, canEdit, initialTab }: { workspace: InventoryWorkspace; accountId: string; canEdit: boolean; initialTab?: string }) {
  const [tab, setTab] = useState<Tab>((TABS.find((t) => t.key === initialTab)?.key as Tab) || "planning");
  const [notice, setNotice] = useState<{ kind: "ok" | "error" | "info"; text: string } | null>(null);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-1 rounded-xl border border-slate-200 bg-white p-1">
        {TABS.map((t) => (
          <button key={t.key} type="button" onClick={() => setTab(t.key)} className={`rounded-lg px-3 py-1.5 text-sm font-medium ${tab === t.key ? "bg-slate-900 text-white" : "text-slate-600 hover:bg-slate-100"}`}>
            {t.label}
          </button>
        ))}
      </div>
      {notice ? <Notice kind={notice.kind}>{notice.text}</Notice> : null}
      {tab === "planning" ? <PlanningRules workspace={workspace} accountId={accountId} canEdit={canEdit} notify={setNotice} /> : null}
      {tab === "suppliers" ? <Suppliers workspace={workspace} accountId={accountId} canEdit={canEdit} notify={setNotice} /> : null}
      {tab === "warehouses" ? <Warehouses workspace={workspace} accountId={accountId} canEdit={canEdit} notify={setNotice} /> : null}
      {tab === "cartons" ? <Cartons workspace={workspace} accountId={accountId} canEdit={canEdit} notify={setNotice} /> : null}
      {tab === "skus" ? <SkuPlanning workspace={workspace} accountId={accountId} canEdit={canEdit} notify={setNotice} /> : null}
    </div>
  );
}

type SectionProps = { workspace: InventoryWorkspace; accountId: string; canEdit: boolean; notify: (n: { kind: "ok" | "error" | "info"; text: string } | null) => void };

// ---------------------------------------------------------------------------
// Planning rules
// ---------------------------------------------------------------------------

function PlanningRules({ workspace, accountId, canEdit, notify }: SectionProps) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const s = workspace.settings;
  const [form, setForm] = useState({
    leadTimeDays: String(s.leadTimeDays),
    amazonCoverDays: String(s.amazonCoverDays),
    warehouseCoverDays: String(s.warehouseCoverDays),
    fbaTransitDays: String(s.fbaTransitDays),
    fbaCheckinDays: String(s.fbaCheckinDays),
    safetyDays: String(s.safetyDays),
    overstockDays: String(s.overstockDays),
    growthRatePct: String(s.growthRatePct),
    d7: String(Math.round(s.velocityWeights.d7 * 100)),
    d30: String(Math.round(s.velocityWeights.d30 * 100)),
    d90: String(Math.round(s.velocityWeights.d90 * 100)),
    storageCostPerPallet: String(s.storageCostPerPallet),
    storageCostPeriod: s.storageCostPeriod,
  });
  const weightSum = (Number(form.d7) || 0) + (Number(form.d30) || 0) + (Number(form.d90) || 0);
  const n = (k: keyof typeof form) => Number(form[k]) || 0;

  function save() {
    if (weightSum <= 0) return notify({ kind: "error", text: "Velocity weights must add up to more than zero." });
    const payload: InventorySettingsInput = {
      leadTimeDays: n("leadTimeDays"),
      amazonCoverDays: n("amazonCoverDays"),
      warehouseCoverDays: n("warehouseCoverDays"),
      fbaTransitDays: n("fbaTransitDays"),
      fbaCheckinDays: n("fbaCheckinDays"),
      safetyDays: n("safetyDays"),
      overstockDays: n("overstockDays"),
      growthRatePct: n("growthRatePct"),
      velocityWeights: { d7: n("d7") / weightSum, d30: n("d30") / weightSum, d90: n("d90") / weightSum },
      storageCostPerPallet: n("storageCostPerPallet"),
      storageCostPeriod: form.storageCostPeriod,
    };
    startTransition(async () => {
      const res = await saveInventorySettings(accountId, payload);
      notify(res.ok ? { kind: "ok", text: "Planning rules saved. The planner has been recalculated." } : { kind: "error", text: res.error });
      router.refresh();
    });
  }

  // Plain function (not a nested component) so inputs keep focus between renders.
  const F = (k: keyof typeof form, label: string, hint: string, suffix = "days") => (
    <Field key={k} label={label} hint={hint}>
      <div className="flex items-center gap-2">
        <input value={form[k]} onChange={(e) => setForm({ ...form, [k]: e.target.value })} className={input} inputMode="decimal" disabled={!canEdit} />
        <span className="text-xs text-slate-500">{suffix}</span>
      </div>
    </Field>
  );

  return (
    <div className="space-y-4">
      <Card title="Lead times" subtitle="How long each leg of the supply chain takes. Suppliers and individual SKUs can override the supplier leg.">
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          {F("leadTimeDays", "Default supplier lead time", "Manufacturing + shipping to the 3PL when a SKU has no supplier or override.")}
          {F("fbaTransitDays", "FBA transit", "3PL → Amazon fulfilment centre.")}
          {F("fbaCheckinDays", "FBA check-in", "Arrival → units become fulfillable. Amazon is often 3–10 days.")}
          {F("safetyDays", "Safety buffer", "Extra days added to every reorder point to absorb delays and spikes.")}
        </div>
      </Card>
      <Card title="Cover targets" subtitle="How much stock the planner aims for once an order or shipment lands.">
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          {F("amazonCoverDays", "FBA cover after a shipment", "Days of FBA sales each shipment should cover. 30–45 keeps storage fees low.")}
          {F("warehouseCoverDays", "Total cover after a PO", "Days of total sales a supplier order should cover (all channels, incl. the stock still in FBA).")}
          {F("overstockDays", "Overstock threshold", "Flag SKUs with more days of cover than this.")}
          {F("growthRatePct", "Growth adjustment", "Scale forecast velocity up (+) or down (−), e.g. 20 for a Q4 push.", "%")}
        </div>
      </Card>
      <Card title="Velocity blend" subtitle="Weights for the 7 / 30 / 90-day daily averages. They are normalised automatically; new SKUs only count the days they have existed.">
        <div className="grid gap-4 md:grid-cols-3">
          {F("d7", "Last 7 days", "Reacts fast to recent changes.", "%")}
          {F("d30", "Last 30 days", "The main signal for most SKUs.", "%")}
          {F("d90", "Last 90 days", "Smooths out promotions and stockouts.", "%")}
        </div>
        <p className="mt-2 text-xs text-slate-500">Current total {weightSum}% → normalised to {weightSum ? `${Math.round((n("d7") / weightSum) * 100)} / ${Math.round((n("d30") / weightSum) * 100)} / ${Math.round((n("d90") / weightSum) * 100)}` : "—"}.</p>
      </Card>
      <Card title="3PL storage" subtitle="Used for pallet cost estimates on purchase orders.">
        <div className="grid gap-4 md:grid-cols-3">
          {F("storageCostPerPallet", "Storage cost per pallet", "What the 3PL charges per pallet.", workspace.currency)}
          <Field label="Billing period" hint="Per week or per month.">
            <select value={form.storageCostPeriod} onChange={(e) => setForm({ ...form, storageCostPeriod: e.target.value as "week" | "month" })} className={input} disabled={!canEdit}>
              <option value="week">per week</option>
              <option value="month">per month</option>
            </select>
          </Field>
        </div>
      </Card>
      {canEdit ? (
        <div className="flex justify-end">
          <button type="button" className={btn.primary} onClick={save} disabled={pending}>{pending ? "Saving…" : "Save planning rules"}</button>
        </div>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Suppliers
// ---------------------------------------------------------------------------

const emptySupplier: SupplierInput = { name: "", contactName: "", email: "", phone: "", country: "", currency: "GBP", manufacturingDays: 30, shippingDays: 45, paymentTerms: "", notes: "", isActive: true };

function Suppliers({ workspace, accountId, canEdit, notify }: SectionProps) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [editing, setEditing] = useState<SupplierInput | null>(null);
  const skuCount = useMemo(() => {
    const m = new Map<string, number>();
    for (const s of workspace.skus) if (s.supplierId) m.set(s.supplierId, (m.get(s.supplierId) || 0) + 1);
    return m;
  }, [workspace.skus]);

  function save() {
    if (!editing?.name.trim()) return notify({ kind: "error", text: "Supplier name is required." });
    startTransition(async () => {
      const res = await upsertSupplier(accountId, { ...editing, manufacturingDays: Number(editing.manufacturingDays) || 0, shippingDays: Number(editing.shippingDays) || 0 });
      if (!res.ok) notify({ kind: "error", text: res.error });
      else {
        notify({ kind: "ok", text: "Supplier saved." });
        setEditing(null);
      }
      router.refresh();
    });
  }

  function remove(s: Supplier) {
    if (!confirm(`Delete ${s.name}? SKUs linked to it keep their own lead-time override, if any.`)) return;
    startTransition(async () => {
      const res = await deleteSupplier(accountId, s.id);
      notify(res.ok ? { kind: "ok", text: "Supplier deleted." } : { kind: "error", text: res.error });
      router.refresh();
    });
  }

  return (
    <Card
      title="Suppliers"
      subtitle="Each supplier's manufacturing and shipping time drives the reorder date for its SKUs. Purchase orders are raised per supplier."
      actions={canEdit ? <button type="button" className={btn.smallPrimary} onClick={() => setEditing({ ...emptySupplier })}>+ Supplier</button> : null}
    >
      {workspace.suppliers.length === 0 ? (
        <EmptyState>No suppliers yet. Add your manufacturer(s), then assign SKUs to them under “SKU planning”.</EmptyState>
      ) : (
        <div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead>
              <tr className="bg-slate-50">
                <th className={th()}>Name</th>
                <th className={th()}>Contact</th>
                <th className={th()}>Country</th>
                <th className={th("text-right")}>Manufacturing</th>
                <th className={th("text-right")}>Shipping</th>
                <th className={th("text-right")}>Total lead</th>
                <th className={th()}>Terms</th>
                <th className={th("text-right")}>SKUs</th>
                <th className={th()}></th>
              </tr>
            </thead>
            <tbody>
              {workspace.suppliers.map((s) => (
                <tr key={s.id} className={`border-t border-slate-100 ${!s.isActive ? "opacity-60" : ""}`}>
                  <td className={td("font-medium")}>{s.name}{!s.isActive ? <span className="ml-2 text-xs text-slate-500">inactive</span> : null}</td>
                  <td className={td("text-xs")}>{[s.contactName, s.email, s.phone].filter(Boolean).join(" · ") || "—"}</td>
                  <td className={td()}>{s.country || "—"}</td>
                  <td className={td("text-right")}>{s.manufacturingDays} d</td>
                  <td className={td("text-right")}>{s.shippingDays} d</td>
                  <td className={td("text-right font-semibold")}>{s.manufacturingDays + s.shippingDays} d</td>
                  <td className={td("text-xs")}>{s.paymentTerms || "—"}</td>
                  <td className={td("text-right")}>{skuCount.get(s.id) || 0}</td>
                  <td className={td("whitespace-nowrap text-right text-xs")}>
                    {canEdit ? (
                      <>
                        <button type="button" className="text-plum-700 hover:underline" onClick={() => setEditing({ id: s.id, name: s.name, contactName: s.contactName || "", email: s.email || "", phone: s.phone || "", country: s.country || "", currency: s.currency, manufacturingDays: s.manufacturingDays, shippingDays: s.shippingDays, paymentTerms: s.paymentTerms || "", notes: s.notes || "", isActive: s.isActive })}>edit</button>
                        <button type="button" className="ml-2 text-rose-600 hover:underline" onClick={() => remove(s)} disabled={pending}>delete</button>
                      </>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {editing ? (
        <Modal title={editing.id ? "Edit supplier" : "New supplier"} onClose={() => setEditing(null)}>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Name" className="col-span-2"><input value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} className={input} autoFocus /></Field>
            <Field label="Contact name"><input value={editing.contactName || ""} onChange={(e) => setEditing({ ...editing, contactName: e.target.value })} className={input} /></Field>
            <Field label="Country"><input value={editing.country || ""} onChange={(e) => setEditing({ ...editing, country: e.target.value })} className={input} placeholder="China" /></Field>
            <Field label="Email"><input value={editing.email || ""} onChange={(e) => setEditing({ ...editing, email: e.target.value })} className={input} /></Field>
            <Field label="Phone / WeChat"><input value={editing.phone || ""} onChange={(e) => setEditing({ ...editing, phone: e.target.value })} className={input} /></Field>
            <Field label="Manufacturing days" hint="Order → goods ready"><input value={String(editing.manufacturingDays)} onChange={(e) => setEditing({ ...editing, manufacturingDays: Number(e.target.value) || 0 })} className={input} inputMode="numeric" /></Field>
            <Field label="Shipping days" hint="Goods ready → received at 3PL"><input value={String(editing.shippingDays)} onChange={(e) => setEditing({ ...editing, shippingDays: Number(e.target.value) || 0 })} className={input} inputMode="numeric" /></Field>
            <Field label="Payment terms"><input value={editing.paymentTerms || ""} onChange={(e) => setEditing({ ...editing, paymentTerms: e.target.value })} className={input} placeholder="30% deposit, 70% before shipping" /></Field>
            <Field label="Currency"><input value="GBP" readOnly className={`${input} bg-slate-50`} /></Field>
            <Field label="Notes" className="col-span-2"><input value={editing.notes || ""} onChange={(e) => setEditing({ ...editing, notes: e.target.value })} className={input} /></Field>
            <label className="col-span-2 flex items-center gap-2 text-sm"><input type="checkbox" checked={editing.isActive !== false} onChange={(e) => setEditing({ ...editing, isActive: e.target.checked })} /> Active</label>
          </div>
          <div className="mt-4 flex justify-end gap-2">
            <button type="button" className={btn.secondary} onClick={() => setEditing(null)} disabled={pending}>Cancel</button>
            <button type="button" className={btn.primary} onClick={save} disabled={pending}>{pending ? "Saving…" : "Save"}</button>
          </div>
        </Modal>
      ) : null}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Warehouses
// ---------------------------------------------------------------------------

function Warehouses({ workspace, accountId, canEdit, notify }: SectionProps) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [name, setName] = useState("");
  const [editId, setEditId] = useState<string | null>(null);

  function save() {
    if (!name.trim()) return;
    startTransition(async () => {
      const res = await upsertWarehouse(accountId, { id: editId, name: name.trim() });
      if (!res.ok) notify({ kind: "error", text: res.error });
      else {
        notify({ kind: "ok", text: "Warehouse saved." });
        setName("");
        setEditId(null);
      }
      router.refresh();
    });
  }

  function remove(id: string, n: string) {
    if (!confirm(`Delete ${n}? Movements and sales keep their history but lose the warehouse link.`)) return;
    startTransition(async () => {
      const res = await deleteWarehouse(accountId, id);
      notify(res.ok ? { kind: "ok", text: "Warehouse deleted." } : { kind: "error", text: res.error });
      router.refresh();
    });
  }

  return (
    <Card title="Warehouses" subtitle={`Where stock sits before it goes to Amazon or ships FBM. ${workspace.defaultWarehouseId ? `“${workspace.warehouses.find((w) => w.id === workspace.defaultWarehouseId)?.name}” is the default for FBM / Temu / TikTok sales.` : ""}`}>
      {workspace.warehouses.length === 0 ? <EmptyState>No warehouse yet — add your 3PL (e.g. Sportive).</EmptyState> : (
        <ul className="divide-y divide-slate-100">
          {workspace.warehouses.map((w) => (
            <li key={w.id} className="flex items-center justify-between py-2 text-sm">
              <span className="font-medium">{w.name}{w.id === workspace.defaultWarehouseId ? <span className="ml-2 rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-600">default</span> : null}</span>
              {canEdit ? (
                <span className="text-xs">
                  <button type="button" className="text-plum-700 hover:underline" onClick={() => { setEditId(w.id); setName(w.name); }}>rename</button>
                  <button type="button" className="ml-2 text-rose-600 hover:underline" onClick={() => remove(w.id, w.name)} disabled={pending}>delete</button>
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {canEdit ? (
        <div className="mt-3 flex gap-2">
          <input value={name} onChange={(e) => setName(e.target.value)} className={input} placeholder={editId ? "New name" : "Warehouse name"} onKeyDown={(e) => { if (e.key === "Enter") save(); }} />
          {editId ? <button type="button" className={btn.secondary} onClick={() => { setEditId(null); setName(""); }}>Cancel</button> : null}
          <button type="button" className={btn.primary} onClick={save} disabled={pending || !name.trim()}>{editId ? "Rename" : "Add"}</button>
        </div>
      ) : null}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Carton profiles
// ---------------------------------------------------------------------------

const emptyPack: PackProfileInput = { profileName: "", unitsPerBox: 0, boxLength: 0, boxWidth: 0, boxHeight: 0, dimensionUnit: "cm", boxWeight: null, weightUnit: "kg" };

function Cartons({ workspace, accountId, canEdit, notify }: SectionProps) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [editing, setEditing] = useState<PackProfileInput | null>(null);
  const usage = useMemo(() => {
    const m = new Map<string, number>();
    for (const s of workspace.skus) if (s.defaultPackProfileId) m.set(s.defaultPackProfileId, (m.get(s.defaultPackProfileId) || 0) + 1);
    return m;
  }, [workspace.skus]);

  function save() {
    if (!editing?.profileName.trim()) return notify({ kind: "error", text: "Give the carton a name." });
    if (!(Number(editing.unitsPerBox) > 0)) return notify({ kind: "error", text: "Units per carton must be above zero." });
    startTransition(async () => {
      const res = await upsertPackProfile(accountId, editing);
      if (!res.ok) notify({ kind: "error", text: res.error });
      else {
        notify({ kind: "ok", text: "Carton profile saved." });
        setEditing(null);
      }
      router.refresh();
    });
  }

  function remove(p: PackProfileRef) {
    if (!confirm(`Delete “${p.profileName}”?`)) return;
    startTransition(async () => {
      const res = await deletePackProfile(accountId, p.id);
      notify(res.ok ? { kind: "ok", text: "Carton profile deleted." } : { kind: "error", text: res.error });
      router.refresh();
    });
  }

  const set = (patch: Partial<PackProfileInput>) => setEditing((e) => (e ? { ...e, ...patch } : e));

  return (
    <Card
      title="Carton profiles"
      subtitle="Units per carton and carton size. The planner rounds order and shipment quantities to full cartons and estimates pallets from these."
      actions={canEdit ? <button type="button" className={btn.smallPrimary} onClick={() => setEditing({ ...emptyPack })}>+ Carton</button> : null}
    >
      {workspace.packProfiles.length === 0 ? <EmptyState>No carton profiles yet.</EmptyState> : (
        <div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead><tr className="bg-slate-50"><th className={th()}>Name</th><th className={th("text-right")}>Units / carton</th><th className={th()}>Size</th><th className={th("text-right")}>Weight</th><th className={th("text-right")}>SKUs</th><th className={th()}></th></tr></thead>
            <tbody>
              {workspace.packProfiles.map((p) => (
                <tr key={p.id} className="border-t border-slate-100">
                  <td className={td("font-medium")}>{p.profileName}</td>
                  <td className={td("text-right")}>{fmtInt(p.unitsPerBox)}</td>
                  <td className={td()}>{p.boxLength} × {p.boxWidth} × {p.boxHeight} {p.dimensionUnit}</td>
                  <td className={td("text-right")}>{p.boxWeight == null ? "—" : `${p.boxWeight} ${p.weightUnit}`}</td>
                  <td className={td("text-right")}>{usage.get(p.id) || 0}</td>
                  <td className={td("whitespace-nowrap text-right text-xs")}>
                    {canEdit ? (
                      <>
                        <button type="button" className="text-plum-700 hover:underline" onClick={() => setEditing({ id: p.id, profileName: p.profileName, unitsPerBox: p.unitsPerBox, boxLength: p.boxLength, boxWidth: p.boxWidth, boxHeight: p.boxHeight, dimensionUnit: p.dimensionUnit, boxWeight: p.boxWeight, weightUnit: p.weightUnit })}>edit</button>
                        <button type="button" className="ml-2 text-rose-600 hover:underline" onClick={() => remove(p)} disabled={pending}>delete</button>
                      </>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {editing ? (
        <Modal title={editing.id ? "Edit carton" : "New carton"} onClose={() => setEditing(null)}>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Name" className="col-span-2"><input value={editing.profileName} onChange={(e) => set({ profileName: e.target.value })} className={input} placeholder="Master carton 24pc" autoFocus /></Field>
            <Field label="Units per carton"><input value={editing.unitsPerBox || ""} onChange={(e) => set({ unitsPerBox: Number(e.target.value) || 0 })} className={input} inputMode="numeric" /></Field>
            <Field label="Dimension unit">
              <select value={editing.dimensionUnit} onChange={(e) => set({ dimensionUnit: e.target.value as "mm" | "cm" | "in" })} className={input}><option value="cm">cm</option><option value="mm">mm</option><option value="in">in</option></select>
            </Field>
            <Field label="Length"><input value={editing.boxLength || ""} onChange={(e) => set({ boxLength: Number(e.target.value) || 0 })} className={input} inputMode="decimal" /></Field>
            <Field label="Width"><input value={editing.boxWidth || ""} onChange={(e) => set({ boxWidth: Number(e.target.value) || 0 })} className={input} inputMode="decimal" /></Field>
            <Field label="Height"><input value={editing.boxHeight || ""} onChange={(e) => set({ boxHeight: Number(e.target.value) || 0 })} className={input} inputMode="decimal" /></Field>
            <Field label="Carton weight">
              <div className="flex gap-2">
                <input value={editing.boxWeight ?? ""} onChange={(e) => set({ boxWeight: e.target.value === "" ? null : Number(e.target.value) })} className={input} inputMode="decimal" />
                <select value={editing.weightUnit} onChange={(e) => set({ weightUnit: e.target.value as "kg" | "lb" })} className={`${input} w-20`}><option value="kg">kg</option><option value="lb">lb</option></select>
              </div>
            </Field>
          </div>
          <div className="mt-4 flex justify-end gap-2">
            <button type="button" className={btn.secondary} onClick={() => setEditing(null)} disabled={pending}>Cancel</button>
            <button type="button" className={btn.primary} onClick={save} disabled={pending}>{pending ? "Saving…" : "Save"}</button>
          </div>
        </Modal>
      ) : null}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// SKU planning table
// ---------------------------------------------------------------------------

type SkuDraft = { supplierId: string; leadTimeDays: string; moq: string; defaultPackProfileId: string; velocityOverride: string; isPlanned: boolean };

function SkuPlanning({ workspace, accountId, canEdit, notify }: SectionProps) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [search, setSearch] = useState("");
  const [showExcluded, setShowExcluded] = useState(true);
  const initial = useMemo(() => {
    const m: Record<string, SkuDraft> = {};
    for (const s of workspace.skus) m[s.mappingId] = { supplierId: s.supplierId || "", leadTimeDays: s.leadTimeDays == null ? "" : String(s.leadTimeDays), moq: s.moq == null ? "" : String(s.moq), defaultPackProfileId: s.defaultPackProfileId || "", velocityOverride: s.velocityOverride == null ? "" : String(s.velocityOverride), isPlanned: s.isPlanned };
    return m;
  }, [workspace.skus]);
  const [draft, setDraft] = useState<Record<string, SkuDraft>>(initial);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkSupplier, setBulkSupplier] = useState("");
  const [bulkPack, setBulkPack] = useState("");

  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return workspace.skus.filter((s) => (showExcluded || s.isPlanned) && (!q || `${s.productName} ${s.amazonSku || ""} ${s.asin || ""}`.toLowerCase().includes(q)));
  }, [workspace.skus, search, showExcluded]);

  const dirty = useMemo(() => Object.keys(draft).filter((id) => JSON.stringify(draft[id]) !== JSON.stringify(initial[id])), [draft, initial]);

  function patch(id: string, p: Partial<SkuDraft>) {
    setDraft((d) => ({ ...d, [id]: { ...d[id], ...p } }));
  }

  function save() {
    const payload = dirty.map((id) => {
      const d = draft[id];
      return { mappingId: id, supplierId: d.supplierId || null, leadTimeDays: d.leadTimeDays === "" ? null : Number(d.leadTimeDays), moq: d.moq === "" ? null : Number(d.moq), defaultPackProfileId: d.defaultPackProfileId || null, velocityOverride: d.velocityOverride === "" ? null : Number(d.velocityOverride), isPlanned: d.isPlanned };
    });
    startTransition(async () => {
      const res = await bulkUpdateSkuPlanning(accountId, payload);
      notify(res.ok ? { kind: "ok", text: `${res.data?.updated} SKU${res.data?.updated === 1 ? "" : "s"} updated.` } : { kind: "error", text: res.error });
      router.refresh();
    });
  }

  function applyBulk() {
    const ids = Array.from(selected);
    setDraft((d) => {
      const n = { ...d };
      for (const id of ids) n[id] = { ...n[id], ...(bulkSupplier ? { supplierId: bulkSupplier === "__none" ? "" : bulkSupplier } : {}), ...(bulkPack ? { defaultPackProfileId: bulkPack === "__none" ? "" : bulkPack } : {}) };
      return n;
    });
    setSelected(new Set());
  }

  return (
    <Card
      title="SKU planning"
      subtitle="Assign each SKU to a supplier and carton, and set MOQ. Lead-time and velocity overrides are optional — leave blank to use the supplier's lead time and the blended sales velocity."
      actions={
        <>
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search…" className={inputSm} style={{ width: 180 }} />
          <label className="flex items-center gap-1 text-xs text-slate-600"><input type="checkbox" checked={showExcluded} onChange={(e) => setShowExcluded(e.target.checked)} /> show excluded</label>
          {canEdit ? <button type="button" className={btn.smallPrimary} onClick={save} disabled={pending || dirty.length === 0}>{pending ? "Saving…" : `Save ${dirty.length ? `(${dirty.length})` : ""}`}</button> : null}
        </>
      }
    >
      {canEdit && selected.size > 0 ? (
        <div className="mb-3 flex flex-wrap items-center gap-2 rounded-lg border border-plum-200 bg-plum-50 px-3 py-2 text-sm">
          <span className="font-medium">{selected.size} selected:</span>
          <select value={bulkSupplier} onChange={(e) => setBulkSupplier(e.target.value)} className={inputSm} style={{ width: 180 }}>
            <option value="">Supplier (no change)</option>
            <option value="__none">— none —</option>
            {workspace.suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
          <select value={bulkPack} onChange={(e) => setBulkPack(e.target.value)} className={inputSm} style={{ width: 180 }}>
            <option value="">Carton (no change)</option>
            <option value="__none">— none —</option>
            {workspace.packProfiles.map((p) => <option key={p.id} value={p.id}>{p.profileName}</option>)}
          </select>
          <button type="button" className={btn.small} onClick={applyBulk}>Apply</button>
          <button type="button" className={btn.small} onClick={() => setSelected(new Set())}>Clear</button>
        </div>
      ) : null}
      <div className="overflow-x-auto">
        <table className="min-w-full text-sm">
          <thead>
            <tr className="bg-slate-50">
              {canEdit ? <th className={th("w-8")}><input type="checkbox" checked={selected.size > 0 && selected.size === rows.length} onChange={(e) => setSelected(e.target.checked ? new Set(rows.map((r) => r.mappingId)) : new Set())} /></th> : null}
              <th className={th()}>Product</th>
              <th className={th()}>Supplier</th>
              <th className={th("text-right")}>Lead override</th>
              <th className={th("text-right")}>MOQ</th>
              <th className={th()}>Carton</th>
              <th className={th("text-right")}>Velocity override</th>
              <th className={th("text-center")}>Planned</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((s) => {
              const d = draft[s.mappingId];
              const changed = dirty.includes(s.mappingId);
              return (
                <tr key={s.mappingId} className={`border-t border-slate-100 ${changed ? "bg-amber-50/50" : ""} ${!d.isPlanned ? "opacity-70" : ""}`}>
                  {canEdit ? <td className={td()}><input type="checkbox" checked={selected.has(s.mappingId)} onChange={(e) => { const n = new Set(selected); if (e.target.checked) n.add(s.mappingId); else n.delete(s.mappingId); setSelected(n); }} /></td> : null}
                  <td className={td()}><span className="block font-medium">{s.productName}</span><span className="block text-xs text-slate-500">{s.amazonSku || s.temuSkuId || s.tiktokSku || ""}{s.asin ? ` · ${s.asin}` : ""}</span></td>
                  <td className={td()}>
                    <select value={d.supplierId} onChange={(e) => patch(s.mappingId, { supplierId: e.target.value })} className={inputSm} disabled={!canEdit} style={{ minWidth: 150 }}>
                      <option value="">—</option>
                      {workspace.suppliers.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
                    </select>
                  </td>
                  <td className={td("text-right")}><input value={d.leadTimeDays} onChange={(e) => patch(s.mappingId, { leadTimeDays: e.target.value })} className={`${inputSm} w-20 text-right`} inputMode="numeric" placeholder={String(workspace.suppliers.find((x) => x.id === d.supplierId) ? (workspace.suppliers.find((x) => x.id === d.supplierId)!.manufacturingDays + workspace.suppliers.find((x) => x.id === d.supplierId)!.shippingDays) : workspace.settings.leadTimeDays)} disabled={!canEdit} /></td>
                  <td className={td("text-right")}><input value={d.moq} onChange={(e) => patch(s.mappingId, { moq: e.target.value })} className={`${inputSm} w-20 text-right`} inputMode="numeric" disabled={!canEdit} /></td>
                  <td className={td()}>
                    <select value={d.defaultPackProfileId} onChange={(e) => patch(s.mappingId, { defaultPackProfileId: e.target.value })} className={inputSm} disabled={!canEdit} style={{ minWidth: 150 }}>
                      <option value="">—</option>
                      {workspace.packProfiles.map((p) => <option key={p.id} value={p.id}>{p.profileName} ({p.unitsPerBox})</option>)}
                    </select>
                  </td>
                  <td className={td("text-right")}><input value={d.velocityOverride} onChange={(e) => patch(s.mappingId, { velocityOverride: e.target.value })} className={`${inputSm} w-20 text-right`} inputMode="decimal" placeholder="auto" disabled={!canEdit} /></td>
                  <td className={td("text-center")}><input type="checkbox" checked={d.isPlanned} onChange={(e) => patch(s.mappingId, { isPlanned: e.target.checked })} disabled={!canEdit} /></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Card>
  );
}
