"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { InventoryWorkspace } from "@/lib/inventory/workspace";
import { addDays } from "@/lib/utils/date";
import { createFbaShipment } from "../actions";
import { inventoryHref } from "../_components/inventory-shell";
import { LineEditor, lineBoxes, newLine, type EditableLine } from "../_components/line-editor";
import { Card, Field, Notice, btn, input } from "../_components/ui";

export default function FbaShipmentEditor({ workspace, accountId }: { workspace: InventoryWorkspace; accountId: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState(`FBA ${workspace.today}`);
  const [amazonId, setAmazonId] = useState("");
  const [warehouseId, setWarehouseId] = useState(workspace.defaultWarehouseId || "");
  const [shipDate, setShipDate] = useState(workspace.today);
  const [expected, setExpected] = useState(addDays(workspace.today, workspace.settings.fbaTransitDays));
  const [carrier, setCarrier] = useState("");
  const [notes, setNotes] = useState("");
  const [lines, setLines] = useState<EditableLine[]>([newLine()]);

  function addAllNeedingFba() {
    const need = workspace.rows.filter((r) => r.recommendedFbaUnits > 0 && !lines.some((l) => l.mappingId === r.mappingId));
    if (need.length === 0) {
      setError("No SKUs currently need topping up at FBA.");
      return;
    }
    setError(null);
    const added = need.map((r) => {
      const sku = workspace.skus.find((s) => s.mappingId === r.mappingId)!;
      return newLine({ mappingId: r.mappingId, units: String(r.recommendedFbaUnits), packProfileId: sku.defaultPackProfileId || "" });
    });
    setLines([...lines.filter((l) => l.mappingId), ...added]);
  }

  function save() {
    const packById = new Map(workspace.packProfiles.map((p) => [p.id, p]));
    const items = lines
      .filter((l) => l.mappingId && Number(l.units) > 0)
      .map((l) => {
        const { boxes, pallets, unitsPerBox } = lineBoxes(l, packById);
        return { mappingId: l.mappingId, plannedUnits: Number(l.units), packProfileId: l.packProfileId || null, unitsPerBox, boxes, pallets, notes: l.notes || null };
      });
    if (items.length === 0) {
      setError("Add at least one SKU with units.");
      return;
    }
    setError(null);
    startTransition(async () => {
      const res = await createFbaShipment(accountId, {
        shipmentName: name,
        amazonShipmentId: amazonId || null,
        sourceWarehouseId: warehouseId || null,
        shipDate: shipDate || null,
        expectedArrivalDate: expected || null,
        carrier: carrier || null,
        notes: notes || null,
        items,
      });
      if (!res.ok) {
        setError(res.error);
        return;
      }
      router.push(inventoryHref(`/inventory/fba-shipments/${res.data!.id}`, accountId));
    });
  }

  return (
    <div className="space-y-4">
      {error ? <Notice kind="error">{error}</Notice> : null}
      <Card title="Shipment details">
        <div className="grid gap-3 md:grid-cols-3 lg:grid-cols-6">
          <Field label="Name" className="lg:col-span-2"><input value={name} onChange={(e) => setName(e.target.value)} className={input} /></Field>
          <Field label="Amazon shipment ID" hint="FBA… from Seller Central (can add later)"><input value={amazonId} onChange={(e) => setAmazonId(e.target.value)} className={input} placeholder="FBA15…" /></Field>
          <Field label="From warehouse">
            <select value={warehouseId} onChange={(e) => setWarehouseId(e.target.value)} className={input}>
              <option value="">—</option>
              {workspace.warehouses.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
            </select>
          </Field>
          <Field label="Planned ship date"><input type="date" value={shipDate} onChange={(e) => setShipDate(e.target.value)} className={input} /></Field>
          <Field label="Expected at Amazon"><input type="date" value={expected} onChange={(e) => setExpected(e.target.value)} className={input} /></Field>
          <Field label="Carrier" className="lg:col-span-2"><input value={carrier} onChange={(e) => setCarrier(e.target.value)} className={input} placeholder="UPS partnered, pallet carrier…" /></Field>
          <Field label="Notes" className="md:col-span-3 lg:col-span-4"><input value={notes} onChange={(e) => setNotes(e.target.value)} className={input} placeholder="Prep instructions for the 3PL…" /></Field>
        </div>
      </Card>
      <Card title="Lines" actions={<button type="button" onClick={addAllNeedingFba} className={btn.secondary}>Add all SKUs needing FBA stock</button>}>
        <LineEditor mode="fba" lines={lines} onChange={setLines} skus={workspace.skus} packProfiles={workspace.packProfiles} rows={workspace.rows} currency={workspace.currency} />
      </Card>
      <div className="flex flex-wrap justify-end gap-2">
        <button type="button" onClick={() => router.push(inventoryHref("/inventory/fba-shipments", accountId))} className={btn.secondary} disabled={pending}>Cancel</button>
        <button type="button" onClick={save} className={btn.primary} disabled={pending}>{pending ? "Saving…" : "Save draft shipment"}</button>
      </div>
    </div>
  );
}
