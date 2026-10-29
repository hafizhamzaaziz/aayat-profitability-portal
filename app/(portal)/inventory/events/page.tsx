import type { Metadata } from "next";
import { loadInventoryWorkspace } from "@/lib/inventory/workspace";
import { createAdminClient } from "@/lib/supabase/admin";
import { getInventoryPageContext } from "../_components/page-context";
import { InventoryShell } from "../_components/inventory-shell";
import EventsWorkspace, { type LedgerEvent } from "./events-workspace";

export const metadata: Metadata = { title: "Events" };
export const dynamic = "force-dynamic";

export default async function InventoryEventsPage({ searchParams }: { searchParams: { accountId?: string } }) {
  const page = await getInventoryPageContext(searchParams.accountId);
  if (!page.ok) return page.element;
  const { supabase, account, canEdit } = page.ctx;

  const [workspace, movementsRes, levelsRes] = await Promise.all([
    loadInventoryWorkspace(supabase, account.id, account.currency),
    supabase
      .from("inventory_movements")
      .select("id, sku_mapping_id, movement_date, movement_type, units_delta, location, warehouse_id, reference_type, reference_id, notes, created_by, created_at")
      .eq("account_id", account.id)
      .order("created_at", { ascending: false })
      .limit(600),
    supabase
      .from("inventory_levels")
      .select("id, sku_mapping_id, level_date, amazon_units, warehouse_units, source, notes, updated_by, updated_at")
      .eq("account_id", account.id)
      .order("updated_at", { ascending: false })
      .limit(300),
  ]);

  const [{ data: pos }, { data: ships }] = await Promise.all([
    supabase.from("purchase_orders").select("id, po_number").eq("account_id", account.id),
    supabase.from("fba_shipments").select("id, shipment_name").eq("account_id", account.id),
  ]);
  const poNumber = new Map((pos || []).map((p) => [String(p.id), String(p.po_number)]));
  const shipName = new Map((ships || []).map((s) => [String(s.id), String(s.shipment_name)]));
  const warehouseName = new Map(workspace.warehouses.map((w) => [w.id, w.name]));
  const movementRows = (movementsRes.data || []) as Array<Record<string, unknown>>;
  const levelRows = (levelsRes.data || []) as Array<Record<string, unknown>>;
  const actorIds = Array.from(new Set(
    [...movementRows.map((row) => String(row.created_by || "")), ...levelRows.map((row) => String(row.updated_by || ""))].filter(Boolean)
  ));
  const admin = createAdminClient();
  const { data: people } = actorIds.length
    ? await admin.from("users").select("id, full_name").in("id", actorIds)
    : { data: [] as Array<{ id: string; full_name: string | null }> };
  const actorName = new Map((people || []).map((person) => [String(person.id), String(person.full_name || "").trim() || "Former user"]));
  const who = (id: unknown) => {
    const key = String(id || "");
    return key ? actorName.get(key) || "Former user" : null;
  };

  const events: LedgerEvent[] = [
    ...movementRows.map((m) => ({
      id: String(m.id),
      kind: "movement" as const,
      mappingId: String(m.sku_mapping_id),
      date: String(m.movement_date),
      createdAt: String(m.created_at),
      type: String(m.movement_type),
      location: String(m.location || "warehouse"),
      delta: Number(m.units_delta || 0),
      warehouse: m.warehouse_id ? warehouseName.get(String(m.warehouse_id)) || null : null,
      reference:
        m.reference_type === "purchase_order"
          ? { label: poNumber.get(String(m.reference_id)) || "PO", href: `/inventory/purchase-orders/${m.reference_id}` }
          : m.reference_type === "fba_shipment"
            ? { label: shipName.get(String(m.reference_id)) || "FBA shipment", href: `/inventory/fba-shipments/${m.reference_id}` }
            : null,
      notes: (m.notes as string | null) || null,
      actor: who(m.created_by),
      deletable: !m.reference_type,
    })),
    ...levelRows.map((l) => ({
      id: String(l.id),
      kind: "stock_take" as const,
      mappingId: String(l.sku_mapping_id),
      date: String(l.level_date),
      createdAt: String(l.updated_at),
      type: "stock_take",
      location: "both",
      delta: 0,
      fba: Number(l.amazon_units || 0),
      warehouseUnits: Number(l.warehouse_units || 0),
      warehouse: null,
      reference: null,
      notes: (l.notes as string | null) || (l.source === "sp_api" ? "Synced from Amazon" : null),
      actor: l.source === "sp_api" ? "Amazon sync" : who(l.updated_by),
      deletable: false,
    })),
  ].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));

  return (
    <InventoryShell
      accountId={account.id}
      accountName={account.name}
      active="events"
      title="Events"
      description="Who changed a stock number, when they did it, and why."
    >
      <EventsWorkspace workspace={workspace} accountId={account.id} canEdit={canEdit} events={events} />
    </InventoryShell>
  );
}
