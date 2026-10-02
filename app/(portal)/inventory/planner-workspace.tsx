"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { InventoryWorkspace, SkuSummary } from "@/lib/inventory/workspace";
import { STATUS_LABEL, STATUS_ORDER, type PlannerRow, type PlannerStatus } from "@/lib/inventory/planner";
import { formatUkDate } from "@/lib/utils/date";
import { createFbaShipment, createPurchaseOrder, refreshFbaStock, updateSkuPlanning } from "./actions";
import { inventoryHref } from "./_components/inventory-shell";
import { Card, Kpi, Notice, StatusBadge, btn, fmtDec, fmtInt, input, inputSm, td, th, useMoney } from "./_components/ui";

type Props = { workspace: InventoryWorkspace; accountId: string; canEdit: boolean };

type SortKey = "product" | "status" | "velocity" | "fba" | "warehouse" | "onOrder" | "fbaDays" | "totalDays" | "reorderDate" | "orderUnits" | "fbaUnits" | "value";

const STATUS_RANK = new Map(STATUS_ORDER.map((s, i) => [s, i]));

export default function PlannerWorkspace({ workspace, accountId, canEdit }: Props) {
  const router = useRouter();
  const money = useMoney(workspace.currency);
  const [pending, startTransition] = useTransition();
  const [notice, setNotice] = useState<{ kind: "ok" | "error" | "info"; text: string } | null>(null);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<PlannerStatus | "all" | "action">("action");
  const [supplierFilter, setSupplierFilter] = useState("all");
  const [showUnplanned, setShowUnplanned] = useState(false);
  const [sort, setSort] = useState<{ key: SortKey; dir: "asc" | "desc" }>({ key: "status", dir: "asc" });
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [expanded, setExpanded] = useState<string | null>(null);

  const skuById = useMemo(() => new Map(workspace.skus.map((s) => [s.mappingId, s])), [workspace.skus]);
  const rowById = useMemo(() => new Map(workspace.rows.map((r) => [r.mappingId, r])), [workspace.rows]);

  const counts = useMemo(() => {
    const c: Record<PlannerStatus, number> = { out_of_stock: 0, order_now: 0, ship_to_fba: 0, order_soon: 0, needs_count: 0, overstock: 0, healthy: 0, no_sales: 0 };
    let stockValue = 0;
    let inTransit = 0;
    let onOrder = 0;
    for (const r of workspace.rows) {
      const sku = skuById.get(r.mappingId);
      if (!sku?.isPlanned) continue;
      c[r.status] += 1;
      stockValue += r.stockValue;
      inTransit += r.fbaInTransit;
      onOrder += r.onOrder;
    }
    return { ...c, stockValue, inTransit, onOrder };
  }, [workspace.rows, skuById]);

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    const list = workspace.rows.filter((r) => {
      const sku = skuById.get(r.mappingId);
      if (!sku) return false;
      if (!showUnplanned && !sku.isPlanned) return false;
      if (supplierFilter !== "all" && (sku.supplierId || "none") !== supplierFilter) return false;
      if (statusFilter === "action") {
        if (!["out_of_stock", "order_now", "ship_to_fba", "order_soon", "needs_count"].includes(r.status)) return false;
      } else if (statusFilter !== "all" && r.status !== statusFilter) return false;
      if (q) {
        const hay = [sku.productName, sku.amazonSku, sku.temuSkuId, sku.tiktokSku, sku.asin, sku.supplierName].map((v) => String(v || "").toLowerCase());
        if (!hay.some((h) => h.includes(q))) return false;
      }
      return true;
    });
    const dir = sort.dir === "asc" ? 1 : -1;
    const val = (r: PlannerRow): number | string => {
      const sku = skuById.get(r.mappingId)!;
      switch (sort.key) {
        case "product":
          return sku.productName.toLowerCase();
        case "status":
          return STATUS_RANK.get(r.status) ?? 99;
        case "velocity":
          return r.totalVelocity;
        case "fba":
          return r.fbaOnHand ?? -1;
        case "warehouse":
          return r.warehouseOnHand ?? -1;
        case "onOrder":
          return r.onOrder;
        case "fbaDays":
          return r.fbaDaysOfCover ?? 9e9;
        case "totalDays":
          return r.totalDaysOfCover ?? 9e9;
        case "reorderDate":
          return r.reorderDate || "9999";
        case "orderUnits":
          return r.recommendedOrderUnits;
        case "fbaUnits":
          return r.recommendedFbaUnits;
        case "value":
          return r.stockValue;
      }
    };
    return list.sort((a, b) => {
      const va = val(a);
      const vb = val(b);
      if (va < vb) return -1 * dir;
      if (va > vb) return 1 * dir;
      return skuById.get(a.mappingId)!.productName.localeCompare(skuById.get(b.mappingId)!.productName);
    });
  }, [workspace.rows, skuById, search, statusFilter, supplierFilter, showUnplanned, sort]);

  function toggleSort(key: SortKey) {
    setSort((s) => (s.key === key ? { key, dir: s.dir === "asc" ? "desc" : "asc" } : { key, dir: key === "product" || key === "status" || key === "reorderDate" ? "asc" : "desc" }));
  }

  function toggleAll() {
    if (visible.every((r) => selected.has(r.mappingId))) setSelected(new Set());
    else setSelected(new Set(visible.map((r) => r.mappingId)));
  }

  const selectedRows = useMemo(() => Array.from(selected).map((id) => rowById.get(id)).filter((r): r is PlannerRow => !!r), [selected, rowById]);

  function createPoFromSelection() {
    if (selectedRows.length === 0) return;
    // One PO per supplier so each can be sent to the right manufacturer.
    const groups = new Map<string, PlannerRow[]>();
    for (const r of selectedRows) {
      const sku = skuById.get(r.mappingId)!;
      const key = sku.supplierId || "";
      groups.set(key, [...(groups.get(key) || []), r]);
    }
    startTransition(async () => {
      let lastId: string | null = null;
      let created = 0;
      for (const [supplierId, rows] of groups) {
        const res = await createPurchaseOrder(accountId, {
          supplierId: supplierId || null,
          destinationWarehouseId: workspace.defaultWarehouseId,
          currency: workspace.suppliers.find((s) => s.id === supplierId)?.currency || "GBP",
          items: rows.map((r) => {
            const sku = skuById.get(r.mappingId)!;
            const units = r.recommendedOrderUnits > 0 ? r.recommendedOrderUnits : Math.max(sku.moq || 0, sku.unitsPerBox || 0, 1);
            return { mappingId: r.mappingId, orderedUnits: units, unitCost: sku.unitCost, packProfileId: sku.defaultPackProfileId, unitsPerBox: sku.unitsPerBox };
          }),
        });
        if (!res.ok) {
          setNotice({ kind: "error", text: res.error });
          return;
        }
        lastId = res.data!.id;
        created += 1;
      }
      setSelected(new Set());
      if (created === 1 && lastId) router.push(inventoryHref(`/inventory/purchase-orders/${lastId}`, accountId));
      else {
        setNotice({ kind: "ok", text: `${created} draft purchase orders created (one per supplier).` });
        router.push(inventoryHref("/inventory/purchase-orders", accountId));
      }
    });
  }

  function createShipmentFromSelection() {
    if (selectedRows.length === 0) return;
    startTransition(async () => {
      const res = await createFbaShipment(accountId, {
        shipmentName: `FBA ${workspace.today}`,
        sourceWarehouseId: workspace.defaultWarehouseId,
        items: selectedRows.map((r) => {
          const sku = skuById.get(r.mappingId)!;
          const units = r.recommendedFbaUnits > 0 ? r.recommendedFbaUnits : Math.max(sku.unitsPerBox || 0, 1);
          return {
            mappingId: r.mappingId,
            plannedUnits: units,
            packProfileId: sku.defaultPackProfileId,
            unitsPerBox: sku.unitsPerBox,
            boxes: sku.unitsPerBox ? Math.ceil(units / sku.unitsPerBox) : null,
          };
        }),
      });
      if (!res.ok) {
        setNotice({ kind: "error", text: res.error });
        return;
      }
      setSelected(new Set());
      router.push(inventoryHref(`/inventory/fba-shipments/${res.data!.id}`, accountId));
    });
  }

  function refreshFba() {
    startTransition(async () => {
      const res = await refreshFbaStock(accountId);
      if (res.ok) setNotice({ kind: "ok", text: `FBA stock refreshed from Amazon (${(res.data as { skus: number }).skus} SKUs).` });
      else setNotice({ kind: "error", text: res.error });
      router.refresh();
    });
  }

  function exportCsv() {
    const header = ["Product", "Amazon SKU", "Temu SKU", "Supplier", "Status", "Velocity/day", "FBA /day", "Direct /day", "FBA on hand", "In transit", "Warehouse", "On order", "FBA days", "Total days", "Reorder date", "Order units", "Ship to FBA units", "Stock value"];
    const lines = visible.map((r) => {
      const s = skuById.get(r.mappingId)!;
      return [s.productName, s.amazonSku || "", s.temuSkuId || "", s.supplierName || "", STATUS_LABEL[r.status], r.totalVelocity, r.fbaVelocity, r.directVelocity, r.fbaOnHand ?? "", r.fbaInTransit, r.warehouseOnHand ?? "", r.onOrder, r.fbaDaysOfCover ?? "", r.totalDaysOfCover ?? "", r.reorderDate || "", r.recommendedOrderUnits, r.recommendedFbaUnits, r.stockValue];
    });
    const csv = [header, ...lines].map((row) => row.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(",")).join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `inventory-planner-${workspace.today}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  const sortIcon = (key: SortKey) => (sort.key === key ? (sort.dir === "asc" ? " ▲" : " ▼") : "");

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-7">
        <Kpi label="Out of stock" value={counts.out_of_stock} tone={counts.out_of_stock ? "danger" : "default"} hint="Selling with nothing left" />
        <Kpi label="Order now" value={counts.order_now} tone={counts.order_now ? "danger" : "default"} hint="Pipeline below reorder point" />
        <Kpi label="Ship to FBA" value={counts.ship_to_fba} tone={counts.ship_to_fba ? "warn" : "default"} hint="FBA inside lead time" />
        <Kpi label="Order soon" value={counts.order_soon} tone={counts.order_soon ? "warn" : "default"} hint="Reorder within 14 days" />
        <Kpi label="On order" value={fmtInt(counts.onOrder)} hint={`${workspace.openPurchaseOrders.length} open PO${workspace.openPurchaseOrders.length === 1 ? "" : "s"}`} href={inventoryHref("/inventory/purchase-orders", accountId)} />
        <Kpi label="In transit to FBA" value={fmtInt(counts.inTransit)} hint={`${workspace.openFbaShipments.filter((s) => s.status !== "draft").length} shipment(s) on the way`} href={inventoryHref("/inventory/fba-shipments", accountId)} />
        <Kpi label="Stock value" value={money(counts.stockValue)} hint="At COGS, FBA + transit + 3PL" />
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2 rounded-2xl border border-slate-200 bg-white px-4 py-2 text-xs text-slate-600">
        <div>
          FBA stock source:{" "}
          {workspace.fbaLive.fresh ? (
            <span className="font-semibold text-emerald-700">live from Amazon ({workspace.fbaLive.skus} SKUs, {new Date(workspace.fbaLive.snapshotAt!).toLocaleString("en-GB")})</span>
          ) : (
            <span className="font-semibold text-slate-800">your stock counts − FBA sales since the count</span>
          )}
          {!workspace.fbaLive.fresh ? <span className="ml-1 text-slate-500">· switches to live automatically once Amazon grants the Amazon Fulfillment role.</span> : null}
        </div>
        {canEdit ? (
          <button type="button" onClick={refreshFba} disabled={pending} className={btn.small}>
            Refresh FBA stock from Amazon
          </button>
        ) : null}
      </div>

      {notice ? <Notice kind={notice.kind}>{notice.text}</Notice> : null}

      <Card
        title="Planner"
        subtitle={`${visible.length} of ${workspace.rows.length} SKUs · velocity blends 7/30/90-day sales (${Math.round(workspace.settings.velocityWeights.d7 * 100)}/${Math.round(workspace.settings.velocityWeights.d30 * 100)}/${Math.round(workspace.settings.velocityWeights.d90 * 100)}%) · safety ${workspace.settings.safetyDays}d · FBA transit+check-in ${workspace.settings.fbaTransitDays + workspace.settings.fbaCheckinDays}d`}
        actions={
          <>
            <button type="button" onClick={exportCsv} className={btn.secondary}>Export CSV</button>
            {canEdit ? (
              <>
                <button type="button" onClick={createPoFromSelection} disabled={pending || selected.size === 0} className={btn.primary}>
                  Create PO ({selected.size})
                </button>
                <button type="button" onClick={createShipmentFromSelection} disabled={pending || selected.size === 0} className={btn.plum}>
                  Create FBA shipment ({selected.size})
                </button>
              </>
            ) : null}
          </>
        }
      >
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search product, SKU, ASIN, supplier…" className={`${input} sm:w-72`} />
          <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as PlannerStatus | "all" | "action")} className={`${input} sm:w-56`}>
            <option value="action">Needs action</option>
            <option value="all">All statuses</option>
            {STATUS_ORDER.map((s) => (
              <option key={s} value={s}>
                {STATUS_LABEL[s]} ({counts[s]})
              </option>
            ))}
          </select>
          <select value={supplierFilter} onChange={(e) => setSupplierFilter(e.target.value)} className={`${input} sm:w-48`}>
            <option value="all">All suppliers</option>
            <option value="none">No supplier set</option>
            {workspace.suppliers.map((s) => (
              <option key={s.id} value={s.id}>{s.name}</option>
            ))}
          </select>
          <label className="flex items-center gap-2 text-xs text-slate-600">
            <input type="checkbox" checked={showUnplanned} onChange={(e) => setShowUnplanned(e.target.checked)} /> Show excluded SKUs
          </label>
        </div>

        <div className="overflow-x-auto">
          <table className="min-w-full border-separate border-spacing-0">
            <thead>
              <tr className="bg-slate-50">
                <th className={th()}>{canEdit ? <input type="checkbox" checked={visible.length > 0 && visible.every((r) => selected.has(r.mappingId))} onChange={toggleAll} /> : null}</th>
                <th className={th("cursor-pointer")} onClick={() => toggleSort("product")}>Product{sortIcon("product")}</th>
                <th className={th("cursor-pointer")} onClick={() => toggleSort("status")}>Status{sortIcon("status")}</th>
                <th className={th("cursor-pointer text-right")} onClick={() => toggleSort("velocity")}>Units/day{sortIcon("velocity")}</th>
                <th className={th("cursor-pointer text-right")} onClick={() => toggleSort("fba")}>FBA{sortIcon("fba")}</th>
                <th className={th("cursor-pointer text-right")} onClick={() => toggleSort("warehouse")}>3PL{sortIcon("warehouse")}</th>
                <th className={th("cursor-pointer text-right")} onClick={() => toggleSort("onOrder")}>On order{sortIcon("onOrder")}</th>
                <th className={th("cursor-pointer text-right")} onClick={() => toggleSort("fbaDays")}>FBA days{sortIcon("fbaDays")}</th>
                <th className={th("cursor-pointer text-right")} onClick={() => toggleSort("totalDays")}>Total days{sortIcon("totalDays")}</th>
                <th className={th("cursor-pointer")} onClick={() => toggleSort("reorderDate")}>Reorder by{sortIcon("reorderDate")}</th>
                <th className={th("cursor-pointer text-right")} onClick={() => toggleSort("orderUnits")}>Order{sortIcon("orderUnits")}</th>
                <th className={th("cursor-pointer text-right")} onClick={() => toggleSort("fbaUnits")}>Ship to FBA{sortIcon("fbaUnits")}</th>
                <th className={th("cursor-pointer text-right")} onClick={() => toggleSort("value")}>Value{sortIcon("value")}</th>
              </tr>
            </thead>
            <tbody>
              {visible.length === 0 ? (
                <tr>
                  <td colSpan={13} className="px-3 py-8 text-center text-sm text-slate-500">
                    Nothing matches these filters. {statusFilter === "action" ? "No SKUs need action right now." : ""}
                  </td>
                </tr>
              ) : null}
              {visible.map((r) => {
                const sku = skuById.get(r.mappingId)!;
                const isOpen = expanded === r.mappingId;
                return (
                  <PlannerRowView
                    key={r.mappingId}
                    row={r}
                    sku={sku}
                    open={isOpen}
                    onToggle={() => setExpanded(isOpen ? null : r.mappingId)}
                    selected={selected.has(r.mappingId)}
                    onSelect={(v) =>
                      setSelected((prev) => {
                        const next = new Set(prev);
                        if (v) next.add(r.mappingId);
                        else next.delete(r.mappingId);
                        return next;
                      })
                    }
                    canEdit={canEdit}
                    accountId={accountId}
                    workspace={workspace}
                    money={money}
                    onNotice={(n) => setNotice(n)}
                  />
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}

function PlannerRowView({
  row: r,
  sku,
  open,
  onToggle,
  selected,
  onSelect,
  canEdit,
  accountId,
  workspace,
  money,
  onNotice,
}: {
  row: PlannerRow;
  sku: SkuSummary;
  open: boolean;
  onToggle: () => void;
  selected: boolean;
  onSelect: (v: boolean) => void;
  canEdit: boolean;
  accountId: string;
  workspace: InventoryWorkspace;
  money: (v: number | null | undefined) => string;
  onNotice: (n: { kind: "ok" | "error" | "info"; text: string }) => void;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [draft, setDraft] = useState({
    supplierId: sku.supplierId || "",
    leadTimeDays: sku.leadTimeDays == null ? "" : String(sku.leadTimeDays),
    moq: sku.moq == null ? "" : String(sku.moq),
    defaultPackProfileId: sku.defaultPackProfileId || "",
    velocityOverride: sku.velocityOverride == null ? "" : String(sku.velocityOverride),
    isPlanned: sku.isPlanned,
  });

  function savePlanning() {
    startTransition(async () => {
      const res = await updateSkuPlanning(accountId, sku.mappingId, {
        supplierId: draft.supplierId || null,
        leadTimeDays: draft.leadTimeDays === "" ? null : Number(draft.leadTimeDays),
        moq: draft.moq === "" ? null : Number(draft.moq),
        defaultPackProfileId: draft.defaultPackProfileId || null,
        velocityOverride: draft.velocityOverride === "" ? null : Number(draft.velocityOverride),
        isPlanned: draft.isPlanned,
      });
      onNotice(res.ok ? { kind: "ok", text: `Planning settings saved for ${sku.amazonSku || sku.productName}.` } : { kind: "error", text: res.error });
      router.refresh();
    });
  }

  const fbaCell = r.fbaOnHand == null ? "—" : fmtInt(r.fbaOnHand);
  const whCell = r.warehouseOnHand == null ? "—" : fmtInt(r.warehouseOnHand);
  const rowTone = r.status === "out_of_stock" || r.status === "order_now" ? "bg-red-50/40" : r.status === "ship_to_fba" || r.status === "order_soon" ? "bg-amber-50/40" : "";

  return (
    <>
      <tr className={`border-t border-slate-100 ${rowTone} hover:bg-slate-50`}>
        <td className={td()}>{canEdit ? <input type="checkbox" checked={selected} onChange={(e) => onSelect(e.target.checked)} /> : null}</td>
        <td className={td("min-w-[14rem]")}>
          <button type="button" onClick={onToggle} className="text-left">
            <span className="block font-medium text-slate-900">{sku.amazonSku || sku.temuSkuId || sku.tiktokSku}</span>
            <span className="block text-xs text-slate-500">
              {sku.productName}
              {sku.supplierName ? ` · ${sku.supplierName}` : ""}
            </span>
          </button>
        </td>
        <td className={td()}><StatusBadge status={r.status} /></td>
        <td className={td("text-right")} title={`FBA ${fmtDec(r.fbaVelocity, 2)} · FBM ${fmtDec(r.velocity.fbm, 2)} · Temu ${fmtDec(r.velocity.temu, 2)} · TikTok ${fmtDec(r.velocity.tiktok, 2)}`}>
          <span className="font-medium">{fmtDec(r.totalVelocity, 2)}</span>
          {r.velocitySource === "override" ? <span className="ml-1 text-xs text-plum-600">manual</span> : null}
          <span className="block text-xs text-slate-500">FBA {fmtDec(r.fbaVelocity, 1)} · direct {fmtDec(r.directVelocity, 1)}</span>
        </td>
        <td className={td("text-right")}>
          <span className="font-medium">{fbaCell}</span>
          {r.fbaInTransit > 0 ? <span className="block text-xs text-amber-700">+{fmtInt(r.fbaInTransit)} in transit</span> : null}
          {r.fbaReserved > 0 ? <span className="block text-xs text-slate-500">{fmtInt(r.fbaReserved)} reserved</span> : null}
        </td>
        <td className={td("text-right")}>
          <span className="font-medium">{whCell}</span>
          {r.plannedToFba > 0 ? <span className="block text-xs text-slate-500">{fmtInt(r.plannedToFba)} on draft shipments</span> : null}
        </td>
        <td className={td("text-right")}>{r.onOrder > 0 ? fmtInt(r.onOrder) : <span className="text-slate-400">0</span>}</td>
        <td className={td("text-right")}>
          {r.fbaDaysOfCover == null ? "—" : <span className={r.fbaDaysOfCover <= r.fbaLeadDays + workspace.settings.safetyDays ? "font-semibold text-amber-700" : ""}>{fmtDec(r.fbaDaysOfCover, 0)}</span>}
        </td>
        <td className={td("text-right")}>{r.totalDaysOfCover == null ? "—" : fmtDec(r.totalDaysOfCover, 0)}</td>
        <td className={td("whitespace-nowrap")}>
          {r.reorderDate ? (
            <span className={r.daysUntilReorder != null && r.daysUntilReorder <= 0 ? "font-semibold text-red-700" : ""}>
              {r.daysUntilReorder != null && r.daysUntilReorder <= 0 ? "Now" : formatUkDate(r.reorderDate)}
            </span>
          ) : (
            "—"
          )}
        </td>
        <td className={td("text-right")}>
          {r.recommendedOrderUnits > 0 ? (
            <>
              <span className="font-semibold text-slate-900">{fmtInt(r.recommendedOrderUnits)}</span>
              {r.recommendedOrderBoxes ? <span className="block text-xs text-slate-500">{r.recommendedOrderBoxes} ctn</span> : null}
            </>
          ) : (
            <span className="text-slate-400">—</span>
          )}
        </td>
        <td className={td("text-right")}>
          {r.recommendedFbaUnits > 0 ? (
            <>
              <span className="font-semibold text-slate-900">{fmtInt(r.recommendedFbaUnits)}</span>
              {r.recommendedFbaBoxes ? <span className="block text-xs text-slate-500">{r.recommendedFbaBoxes} ctn</span> : null}
            </>
          ) : (
            <span className="text-slate-400">—</span>
          )}
        </td>
        <td className={td("text-right")}>{money(r.stockValue)}</td>
      </tr>
      {open ? (
        <tr className="border-t border-slate-100 bg-slate-50/60">
          <td />
          <td colSpan={12} className="px-2 py-3">
            <div className="grid gap-4 lg:grid-cols-3">
              <div className="space-y-2 text-sm">
                <h4 className="text-xs font-semibold uppercase tracking-wide text-slate-500">Why</h4>
                <ul className="list-disc space-y-1 pl-4 text-slate-700">
                  {r.reasons.length === 0 ? <li>Stock covers demand comfortably.</li> : r.reasons.map((reason, i) => <li key={i}>{reason}</li>)}
                </ul>
                <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-xs text-slate-600">
                  <dt>Supplier lead</dt><dd className="text-right">{r.supplierLeadDays}d</dd>
                  <dt>FBA transit + check-in</dt><dd className="text-right">{r.fbaLeadDays}d</dd>
                  <dt>Effective lead (incl. safety)</dt><dd className="text-right">{r.effectiveLeadDays}d</dd>
                  <dt>Reorder point (pipeline)</dt><dd className="text-right">{fmtInt(r.reorderPoint)}</dd>
                  <dt>FBA reorder point</dt><dd className="text-right">{fmtInt(r.fbaReorderPoint)}</dd>
                  <dt>Pipeline now</dt><dd className="text-right">{fmtInt(r.pipelineUnits)}</dd>
                  <dt>Projected FBA stockout</dt><dd className="text-right">{r.fbaStockoutDate ? formatUkDate(r.fbaStockoutDate) : "—"}</dd>
                  <dt>Projected total stockout</dt><dd className="text-right">{r.totalStockoutDate ? formatUkDate(r.totalStockoutDate) : "—"}</dd>
                  <dt>Stock source</dt>
                  <dd className="text-right">
                    FBA: {sku.fbaSource === "live" ? "Amazon live" : sku.fbaSource === "count" ? `count ${formatUkDate(sku.baselineDate || "")}` : "none"} · 3PL: {sku.warehouseSource === "count" ? `count ${formatUkDate(sku.baselineDate || "")}` : "none"}
                  </dd>
                  <dt>Unit cost</dt><dd className="text-right">{money(sku.unitCost)}</dd>
                </dl>
              </div>
              <div className="text-sm">
                <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">Units sold</h4>
                <table className="w-full text-xs">
                  <thead>
                    <tr className="text-slate-500">
                      <th className="py-1 text-left font-medium">Channel</th>
                      <th className="py-1 text-right font-medium">7d</th>
                      <th className="py-1 text-right font-medium">30d</th>
                      <th className="py-1 text-right font-medium">90d</th>
                      <th className="py-1 text-right font-medium">365d</th>
                      <th className="py-1 text-right font-medium">/day</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(["fba", "fbm", "temu", "tiktok"] as const).map((ch) => {
                      const d = sku.demand[ch];
                      if (!d && r.velocity[ch] === 0) return null;
                      return (
                        <tr key={ch} className="border-t border-slate-200">
                          <td className="py-1 uppercase text-slate-700">{ch === "fba" ? "Amazon FBA" : ch === "fbm" ? "Amazon FBM" : ch}</td>
                          <td className="py-1 text-right">{fmtInt(d?.units7 || 0)}</td>
                          <td className="py-1 text-right">{fmtInt(d?.units30 || 0)}</td>
                          <td className="py-1 text-right">{fmtInt(d?.units90 || 0)}</td>
                          <td className="py-1 text-right">{fmtInt(d?.units365 || 0)}</td>
                          <td className="py-1 text-right font-medium">{fmtDec(r.velocity[ch], 2)}</td>
                        </tr>
                      );
                    })}
                    {Object.keys(sku.demand).length === 0 ? (
                      <tr><td colSpan={6} className="py-2 text-slate-500">No sales in the last 12 months.</td></tr>
                    ) : null}
                  </tbody>
                </table>
                {sku.lastSaleDate ? <p className="mt-2 text-xs text-slate-500">Last logged sale: {formatUkDate(sku.lastSaleDate)}</p> : null}
              </div>
              <div className="text-sm">
                <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">Planning settings for this SKU</h4>
                <div className="grid grid-cols-2 gap-2">
                  <label className="text-xs text-slate-600">
                    Supplier
                    <select value={draft.supplierId} onChange={(e) => setDraft({ ...draft, supplierId: e.target.value })} className={inputSm} disabled={!canEdit}>
                      <option value="">— none —</option>
                      {workspace.suppliers.map((s) => (
                        <option key={s.id} value={s.id}>{s.name} ({s.manufacturingDays + s.shippingDays}d)</option>
                      ))}
                    </select>
                  </label>
                  <label className="text-xs text-slate-600">
                    Lead time override (days)
                    <input value={draft.leadTimeDays} onChange={(e) => setDraft({ ...draft, leadTimeDays: e.target.value })} className={inputSm} placeholder={String(r.supplierLeadDays)} disabled={!canEdit} inputMode="numeric" />
                  </label>
                  <label className="text-xs text-slate-600">
                    MOQ (units)
                    <input value={draft.moq} onChange={(e) => setDraft({ ...draft, moq: e.target.value })} className={inputSm} disabled={!canEdit} inputMode="numeric" />
                  </label>
                  <label className="text-xs text-slate-600">
                    Carton
                    <select value={draft.defaultPackProfileId} onChange={(e) => setDraft({ ...draft, defaultPackProfileId: e.target.value })} className={inputSm} disabled={!canEdit}>
                      <option value="">— none —</option>
                      {workspace.packProfiles.map((p) => (
                        <option key={p.id} value={p.id}>{p.profileName} ({p.unitsPerBox}/ctn)</option>
                      ))}
                    </select>
                  </label>
                  <label className="text-xs text-slate-600">
                    Velocity override (units/day)
                    <input value={draft.velocityOverride} onChange={(e) => setDraft({ ...draft, velocityOverride: e.target.value })} className={inputSm} disabled={!canEdit} inputMode="decimal" placeholder="auto" />
                  </label>
                  <label className="flex items-end gap-2 pb-1 text-xs text-slate-600">
                    <input type="checkbox" checked={draft.isPlanned} onChange={(e) => setDraft({ ...draft, isPlanned: e.target.checked })} disabled={!canEdit} /> Include in planning
                  </label>
                </div>
                {canEdit ? (
                  <button type="button" onClick={savePlanning} disabled={pending} className={`${btn.smallPrimary} mt-2`}>
                    {pending ? "Saving…" : "Save SKU settings"}
                  </button>
                ) : null}
              </div>
            </div>
          </td>
        </tr>
      ) : null}
    </>
  );
}
