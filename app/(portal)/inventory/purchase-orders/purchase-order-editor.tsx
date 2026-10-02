"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { InventoryWorkspace } from "@/lib/inventory/workspace";
import { addDays } from "@/lib/utils/date";
import { createPurchaseOrder } from "../actions";
import { inventoryHref } from "../_components/inventory-shell";
import { LineEditor, newLine, type EditableLine } from "../_components/line-editor";
import { Card, Field, Notice, btn, input } from "../_components/ui";

export default function PurchaseOrderEditor({ workspace, accountId }: { workspace: InventoryWorkspace; accountId: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [supplierId, setSupplierId] = useState(workspace.suppliers[0]?.id || "");
  const supplier = workspace.suppliers.find((s) => s.id === supplierId) || null;
  const [orderDate, setOrderDate] = useState(workspace.today);
  const [expectedReady, setExpectedReady] = useState(supplier ? addDays(workspace.today, supplier.manufacturingDays) : "");
  const [expectedArrival, setExpectedArrival] = useState(supplier ? addDays(workspace.today, supplier.manufacturingDays + supplier.shippingDays) : "");
  const [warehouseId, setWarehouseId] = useState(workspace.defaultWarehouseId || "");
  const [currency, setCurrency] = useState(supplier?.currency || workspace.currency || "GBP");
  const [notes, setNotes] = useState("");
  const [lines, setLines] = useState<EditableLine[]>([newLine()]);

  const skusForSupplier = useMemo(() => {
    if (!supplierId) return workspace.skus;
    const own = workspace.skus.filter((s) => s.supplierId === supplierId);
    const others = workspace.skus.filter((s) => s.supplierId !== supplierId);
    return [...own, ...others];
  }, [workspace.skus, supplierId]);

  function onSupplierChange(id: string) {
    setSupplierId(id);
    const s = workspace.suppliers.find((x) => x.id === id);
    if (s) {
      setExpectedReady(addDays(orderDate, s.manufacturingDays));
      setExpectedArrival(addDays(orderDate, s.manufacturingDays + s.shippingDays));
      setCurrency(s.currency);
    }
  }

  function addSupplierSkusNeedingOrder() {
    const need = workspace.rows.filter((r) => {
      const sku = workspace.skus.find((s) => s.mappingId === r.mappingId);
      return sku && (!supplierId || sku.supplierId === supplierId) && r.recommendedOrderUnits > 0 && !lines.some((l) => l.mappingId === r.mappingId);
    });
    if (need.length === 0) {
      setError("No SKUs for this supplier currently need ordering.");
      return;
    }
    setError(null);
    const added = need.map((r) => {
      const sku = workspace.skus.find((s) => s.mappingId === r.mappingId)!;
      return newLine({ mappingId: r.mappingId, units: String(r.recommendedOrderUnits), unitCost: String(sku.unitCost || ""), packProfileId: sku.defaultPackProfileId || "" });
    });
    setLines([...lines.filter((l) => l.mappingId), ...added]);
  }

  function save(status: "draft" | "ordered") {
    const items = lines
      .filter((l) => l.mappingId && Number(l.units) > 0)
      .map((l) => ({
        mappingId: l.mappingId,
        orderedUnits: Number(l.units),
        unitCost: Number(l.unitCost) || 0,
        packProfileId: l.packProfileId || null,
        unitsPerBox: workspace.packProfiles.find((p) => p.id === l.packProfileId)?.unitsPerBox || null,
        notes: l.notes || null,
      }));
    if (items.length === 0) {
      setError("Add at least one SKU with units.");
      return;
    }
    setError(null);
    startTransition(async () => {
      const res = await createPurchaseOrder(accountId, {
        status,
        supplierId: supplierId || null,
        orderDate: status === "ordered" ? orderDate : null,
        expectedReadyDate: expectedReady || null,
        expectedArrivalDate: expectedArrival || null,
        destinationWarehouseId: warehouseId || null,
        currency,
        notes: notes || null,
        items,
      });
      if (!res.ok) {
        setError(res.error);
        return;
      }
      router.push(inventoryHref(`/inventory/purchase-orders/${res.data!.id}`, accountId));
    });
  }

  return (
    <div className="space-y-4">
      {error ? <Notice kind="error">{error}</Notice> : null}
      <Card title="Order details">
        <div className="grid gap-3 md:grid-cols-3 lg:grid-cols-6">
          <Field label="Supplier" className="lg:col-span-2">
            <select value={supplierId} onChange={(e) => onSupplierChange(e.target.value)} className={input}>
              <option value="">— no supplier —</option>
              {workspace.suppliers.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name} · {s.manufacturingDays}d make + {s.shippingDays}d ship
                </option>
              ))}
            </select>
          </Field>
          <Field label="Order date">
            <input type="date" value={orderDate} onChange={(e) => setOrderDate(e.target.value)} className={input} />
          </Field>
          <Field label="Expected ready" hint="Production complete">
            <input type="date" value={expectedReady} onChange={(e) => setExpectedReady(e.target.value)} className={input} />
          </Field>
          <Field label="Expected arrival" hint="At the 3PL">
            <input type="date" value={expectedArrival} onChange={(e) => setExpectedArrival(e.target.value)} className={input} />
          </Field>
          <Field label="Deliver to">
            <select value={warehouseId} onChange={(e) => setWarehouseId(e.target.value)} className={input}>
              <option value="">—</option>
              {workspace.warehouses.map((w) => (
                <option key={w.id} value={w.id}>{w.name}</option>
              ))}
            </select>
          </Field>
          <Field label="Currency">
            <input value={currency} onChange={(e) => setCurrency(e.target.value.toUpperCase())} className={input} maxLength={3} />
          </Field>
          <Field label="Notes" className="md:col-span-3 lg:col-span-5">
            <input value={notes} onChange={(e) => setNotes(e.target.value)} className={input} placeholder="Payment terms, packaging instructions, references…" />
          </Field>
        </div>
      </Card>

      <Card
        title="Lines"
        subtitle="Units default to the planner's suggestion when you pick a SKU. Cartons and pallets come from the carton profile."
        actions={
          <button type="button" onClick={addSupplierSkusNeedingOrder} className={btn.secondary}>
            Add all SKUs needing an order{supplier ? ` from ${supplier.name}` : ""}
          </button>
        }
      >
        <LineEditor mode="po" lines={lines} onChange={setLines} skus={skusForSupplier} packProfiles={workspace.packProfiles} rows={workspace.rows} currency={currency} />
      </Card>

      <div className="flex flex-wrap justify-end gap-2">
        <button type="button" onClick={() => router.push(inventoryHref("/inventory/purchase-orders", accountId))} className={btn.secondary} disabled={pending}>
          Cancel
        </button>
        <button type="button" onClick={() => save("draft")} className={btn.secondary} disabled={pending}>
          Save draft
        </button>
        <button type="button" onClick={() => save("ordered")} className={btn.primary} disabled={pending}>
          {pending ? "Saving…" : "Save & mark ordered"}
        </button>
      </div>
    </div>
  );
}
