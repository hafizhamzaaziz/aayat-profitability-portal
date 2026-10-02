import type { Metadata } from "next";
import { loadInventoryWorkspace } from "@/lib/inventory/workspace";
import { getInventoryPageContext } from "../_components/page-context";
import { InventoryShell } from "../_components/inventory-shell";
import StockWorkspace, { type LedgerEvent } from "./stock-workspace";

export const metadata: Metadata = { title: "Stock & ledger" };
export const dynamic = "force-dynamic";

export default async function StockPage({ searchParams }: { searchParams: { accountId?: string } }) {
  const page = await getInventoryPageContext(searchParams.accountId);
  if (!page.ok) return page.element;
  const { supabase, account, canEdit } = page.ctx;

  const [workspace, movementsRes, levelsRes] = await Promise.all([
    loadInventoryWorkspace(supabase, account.id, account.currency),
    supabase
      .from("inventory_movements")
      .select("id, sku_mapping_id, movement_date, movement_type, units_delta, location, warehouse_id, reference_type, reference_id, notes, created_at")
      .eq("account_id", account.id)
      .order("created_at", { ascending: false })
      .limit(600),
    supabase
      .from("inventory_levels")
      .select("id, sku_mapping_id, level_date, amazon_units, warehouse_units, source, notes, updated_at")
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

  const events: LedgerEvent[] = [
    ...((movementsRes.data || []) as Array<Record<string, unknown>>).map((m) => ({
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
      deletable: !m.reference_type,
    })),
    ...((levelsRes.data || []) as Array<Record<string, unknown>>).map((l) => ({
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
      deletable: false,
    })),
  ].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));

  return (
    <InventoryShell
      accountId={account.id}
      accountName={account.name}
      active="stock"
      title="Stock & ledger"
      description="Current stock in every location, with the full history behind each number. Record a stock take whenever the 3PL or Amazon counts differ from what the system expects — the planner then works forward from that count using receipts, shipments and logged sales."
    >
      <StockWorkspace workspace={workspace} accountId={account.id} canEdit={canEdit} events={events} />
    </InventoryShell>
  );
}
