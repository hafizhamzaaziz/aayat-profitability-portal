/**
 * Loaders for purchase orders and FBA shipments (list + detail).
 */

import type { SupabaseClient } from "@supabase/supabase-js";

export type PurchaseOrderListRow = {
  id: string;
  poNumber: string;
  status: string;
  supplierName: string | null;
  orderDate: string | null;
  expectedReadyDate: string | null;
  expectedArrivalDate: string | null;
  destinationWarehouse: string | null;
  currency: string;
  orderedUnits: number;
  receivedUnits: number;
  goodsValue: number;
  extraCosts: number;
  lines: number;
  cogsAppliedAt: string | null;
  createdAt: string;
  isLegacy: boolean;
};

export type PurchaseOrderDetail = {
  id: string;
  poNumber: string;
  status: string;
  supplierId: string | null;
  supplierName: string | null;
  orderDate: string | null;
  expectedReadyDate: string | null;
  expectedArrivalDate: string | null;
  destinationWarehouseId: string | null;
  currency: string;
  freightCost: number;
  dutyCost: number;
  otherCost: number;
  trackingRef: string | null;
  notes: string | null;
  cogsAppliedAt: string | null;
  closedAt: string | null;
  createdAt: string;
  isLegacy: boolean;
  items: Array<{
    id: string;
    mappingId: string;
    productName: string;
    sku: string;
    orderedUnits: number;
    receivedUnits: number;
    unitCost: number;
    packProfileId: string | null;
    unitsPerBox: number | null;
    notes: string | null;
    currentCogs: number | null;
  }>;
  receipts: Array<{ id: string; itemId: string; date: string; units: number; warehouseName: string | null; notes: string | null; createdAt: string }>;
  linkedShipments: Array<{ id: string; name: string; status: string }>;
};

function num(v: unknown, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function catalogName(v: unknown): string | null {
  const c = Array.isArray(v) ? v[0] : v;
  return (c as { product_name?: string | null } | null)?.product_name || null;
}

export async function loadPurchaseOrders(supabase: SupabaseClient, accountId: string): Promise<PurchaseOrderListRow[]> {
  const [{ data: pos, error }, { data: items }, { data: suppliers }, { data: warehouses }] = await Promise.all([
    supabase
      .from("purchase_orders")
      .select("id, po_number, status, supplier_id, order_date, expected_ready_date, expected_arrival_date, destination_warehouse_id, currency, freight_cost, duty_cost, other_cost, cogs_applied_at, created_at, legacy_plan_id")
      .eq("account_id", accountId)
      .order("created_at", { ascending: false }),
    supabase
      .from("purchase_order_items")
      .select("purchase_order_id, ordered_units, received_units, unit_cost, purchase_orders!inner(account_id)")
      .eq("purchase_orders.account_id", accountId),
    supabase.from("inventory_suppliers").select("id, name").eq("account_id", accountId),
    supabase.from("inventory_warehouses").select("id, name").eq("account_id", accountId),
  ]);
  if (error) throw new Error(error.message);
  const supplierName = new Map((suppliers || []).map((s) => [String(s.id), String(s.name)]));
  const warehouseName = new Map((warehouses || []).map((w) => [String(w.id), String(w.name)]));
  const agg = new Map<string, { ordered: number; received: number; value: number; lines: number }>();
  for (const it of (items || []) as Array<Record<string, unknown>>) {
    const id = String(it.purchase_order_id);
    const cur = agg.get(id) || { ordered: 0, received: 0, value: 0, lines: 0 };
    cur.ordered += num(it.ordered_units);
    cur.received += num(it.received_units);
    cur.value += num(it.ordered_units) * num(it.unit_cost);
    cur.lines += 1;
    agg.set(id, cur);
  }
  return (pos || []).map((p) => {
    const a = agg.get(String(p.id)) || { ordered: 0, received: 0, value: 0, lines: 0 };
    return {
      id: String(p.id),
      poNumber: String(p.po_number),
      status: String(p.status),
      supplierName: p.supplier_id ? supplierName.get(String(p.supplier_id)) || null : null,
      orderDate: p.order_date,
      expectedReadyDate: p.expected_ready_date,
      expectedArrivalDate: p.expected_arrival_date,
      destinationWarehouse: p.destination_warehouse_id ? warehouseName.get(String(p.destination_warehouse_id)) || null : null,
      currency: String(p.currency || "GBP"),
      orderedUnits: a.ordered,
      receivedUnits: a.received,
      goodsValue: Math.round(a.value * 100) / 100,
      extraCosts: num(p.freight_cost) + num(p.duty_cost) + num(p.other_cost),
      lines: a.lines,
      cogsAppliedAt: p.cogs_applied_at,
      createdAt: String(p.created_at),
      isLegacy: !!p.legacy_plan_id,
    };
  });
}

export async function loadPurchaseOrder(supabase: SupabaseClient, accountId: string, poId: string): Promise<PurchaseOrderDetail | null> {
  const { data: po, error } = await supabase.from("purchase_orders").select("*").eq("id", poId).eq("account_id", accountId).maybeSingle();
  if (error) throw new Error(error.message);
  if (!po) return null;
  const [{ data: items }, { data: receipts }, { data: shipments }, { data: supplier }, { data: cogs }, { data: warehouses }] = await Promise.all([
    supabase
      .from("purchase_order_items")
      .select("id, sku_mapping_id, ordered_units, received_units, unit_cost, pack_profile_id, units_per_box, notes, sku_mappings(amazon_sku, temu_sku_id, tiktok_seller_sku, sku_catalog(product_name))")
      .eq("purchase_order_id", poId)
      .order("created_at", { ascending: true }),
    supabase.from("purchase_order_receipts").select("id, purchase_order_item_id, received_date, units, warehouse_id, notes, created_at").eq("purchase_order_id", poId).order("created_at", { ascending: false }),
    supabase.from("fba_shipments").select("id, shipment_name, status").eq("purchase_order_id", poId),
    po.supplier_id ? supabase.from("inventory_suppliers").select("name").eq("id", po.supplier_id).maybeSingle() : Promise.resolve({ data: null }),
    supabase.from("cogs").select("sku, unit_cost, sku_mapping_id").eq("account_id", accountId),
    supabase.from("inventory_warehouses").select("id, name").eq("account_id", accountId),
  ]);
  const warehouseName = new Map((warehouses || []).map((w) => [String(w.id), String(w.name)]));
  const cogsByMapping = new Map<string, number>();
  const cogsBySku = new Map<string, number>();
  for (const c of cogs || []) {
    if (c.sku_mapping_id) cogsByMapping.set(String(c.sku_mapping_id), num(c.unit_cost));
    cogsBySku.set(String(c.sku || "").trim().toUpperCase(), num(c.unit_cost));
  }

  return {
    id: String(po.id),
    poNumber: String(po.po_number),
    status: String(po.status),
    supplierId: po.supplier_id ? String(po.supplier_id) : null,
    supplierName: (supplier as { name?: string } | null)?.name || null,
    orderDate: po.order_date,
    expectedReadyDate: po.expected_ready_date,
    expectedArrivalDate: po.expected_arrival_date,
    destinationWarehouseId: po.destination_warehouse_id ? String(po.destination_warehouse_id) : null,
    currency: String(po.currency || "GBP"),
    freightCost: num(po.freight_cost),
    dutyCost: num(po.duty_cost),
    otherCost: num(po.other_cost),
    trackingRef: po.tracking_ref,
    notes: po.notes,
    cogsAppliedAt: po.cogs_applied_at,
    closedAt: po.closed_at,
    createdAt: String(po.created_at),
    isLegacy: !!po.legacy_plan_id,
    items: ((items || []) as Array<Record<string, unknown>>).map((it) => {
      const m = (Array.isArray(it.sku_mappings) ? it.sku_mappings[0] : it.sku_mappings) as Record<string, unknown> | null;
      const sku = String(m?.amazon_sku || m?.temu_sku_id || m?.tiktok_seller_sku || "");
      const mappingId = String(it.sku_mapping_id);
      return {
        id: String(it.id),
        mappingId,
        productName: catalogName(m?.sku_catalog) || sku,
        sku,
        orderedUnits: num(it.ordered_units),
        receivedUnits: num(it.received_units),
        unitCost: num(it.unit_cost),
        packProfileId: it.pack_profile_id ? String(it.pack_profile_id) : null,
        unitsPerBox: it.units_per_box == null ? null : num(it.units_per_box),
        notes: (it.notes as string | null) || null,
        currentCogs: cogsByMapping.get(mappingId) ?? cogsBySku.get(sku.toUpperCase()) ?? null,
      };
    }),
    receipts: (receipts || []).map((r) => ({
      id: String(r.id),
      itemId: String(r.purchase_order_item_id),
      date: String(r.received_date),
      units: num(r.units),
      warehouseName: r.warehouse_id ? warehouseName.get(String(r.warehouse_id)) || null : null,
      notes: r.notes,
      createdAt: String(r.created_at),
    })),
    linkedShipments: (shipments || []).map((s) => ({ id: String(s.id), name: String(s.shipment_name), status: String(s.status) })),
  };
}

export type FbaShipmentListRow = {
  id: string;
  name: string;
  amazonShipmentId: string | null;
  status: string;
  sourceWarehouse: string | null;
  shipDate: string | null;
  expectedArrivalDate: string | null;
  plannedUnits: number;
  sentUnits: number;
  receivedUnits: number;
  boxes: number;
  lines: number;
  poNumber: string | null;
  createdAt: string;
  isLegacy: boolean;
};

export type FbaShipmentDetail = {
  id: string;
  name: string;
  amazonShipmentId: string | null;
  status: string;
  sourceWarehouseId: string | null;
  shipDate: string | null;
  expectedArrivalDate: string | null;
  carrier: string | null;
  trackingRef: string | null;
  purchaseOrderId: string | null;
  poNumber: string | null;
  notes: string | null;
  shippedAt: string | null;
  closedAt: string | null;
  createdAt: string;
  isLegacy: boolean;
  items: Array<{
    id: string;
    mappingId: string;
    productName: string;
    sku: string;
    asin: string | null;
    plannedUnits: number;
    sentUnits: number;
    receivedUnits: number;
    packProfileId: string | null;
    unitsPerBox: number | null;
    boxes: number | null;
    pallets: number | null;
    notes: string | null;
  }>;
};

export async function loadFbaShipments(supabase: SupabaseClient, accountId: string): Promise<FbaShipmentListRow[]> {
  const [{ data: ships, error }, { data: items }, { data: warehouses }, { data: pos }] = await Promise.all([
    supabase
      .from("fba_shipments")
      .select("id, shipment_name, amazon_shipment_id, status, source_warehouse_id, ship_date, expected_arrival_date, purchase_order_id, created_at, legacy_plan_id")
      .eq("account_id", accountId)
      .order("created_at", { ascending: false }),
    supabase.from("fba_shipment_items").select("fba_shipment_id, planned_units, sent_units, received_units, boxes, fba_shipments!inner(account_id)").eq("fba_shipments.account_id", accountId),
    supabase.from("inventory_warehouses").select("id, name").eq("account_id", accountId),
    supabase.from("purchase_orders").select("id, po_number").eq("account_id", accountId),
  ]);
  if (error) throw new Error(error.message);
  const warehouseName = new Map((warehouses || []).map((w) => [String(w.id), String(w.name)]));
  const poNumber = new Map((pos || []).map((p) => [String(p.id), String(p.po_number)]));
  const agg = new Map<string, { planned: number; sent: number; received: number; boxes: number; lines: number }>();
  for (const it of (items || []) as Array<Record<string, unknown>>) {
    const id = String(it.fba_shipment_id);
    const cur = agg.get(id) || { planned: 0, sent: 0, received: 0, boxes: 0, lines: 0 };
    cur.planned += num(it.planned_units);
    cur.sent += num(it.sent_units);
    cur.received += num(it.received_units);
    cur.boxes += num(it.boxes);
    cur.lines += 1;
    agg.set(id, cur);
  }
  return (ships || []).map((s) => {
    const a = agg.get(String(s.id)) || { planned: 0, sent: 0, received: 0, boxes: 0, lines: 0 };
    return {
      id: String(s.id),
      name: String(s.shipment_name),
      amazonShipmentId: s.amazon_shipment_id,
      status: String(s.status),
      sourceWarehouse: s.source_warehouse_id ? warehouseName.get(String(s.source_warehouse_id)) || null : null,
      shipDate: s.ship_date,
      expectedArrivalDate: s.expected_arrival_date,
      plannedUnits: a.planned,
      sentUnits: a.sent,
      receivedUnits: a.received,
      boxes: a.boxes,
      lines: a.lines,
      poNumber: s.purchase_order_id ? poNumber.get(String(s.purchase_order_id)) || null : null,
      createdAt: String(s.created_at),
      isLegacy: !!s.legacy_plan_id,
    };
  });
}

export async function loadFbaShipment(supabase: SupabaseClient, accountId: string, shipmentId: string): Promise<FbaShipmentDetail | null> {
  const { data: sh, error } = await supabase.from("fba_shipments").select("*").eq("id", shipmentId).eq("account_id", accountId).maybeSingle();
  if (error) throw new Error(error.message);
  if (!sh) return null;
  const [{ data: items }, { data: po }] = await Promise.all([
    supabase
      .from("fba_shipment_items")
      .select("id, sku_mapping_id, planned_units, sent_units, received_units, pack_profile_id, units_per_box, boxes, pallets, notes, sku_mappings(amazon_sku, temu_sku_id, tiktok_seller_sku, amazon_asin, sku_catalog(product_name))")
      .eq("fba_shipment_id", shipmentId)
      .order("created_at", { ascending: true }),
    sh.purchase_order_id ? supabase.from("purchase_orders").select("po_number").eq("id", sh.purchase_order_id).maybeSingle() : Promise.resolve({ data: null }),
  ]);
  return {
    id: String(sh.id),
    name: String(sh.shipment_name),
    amazonShipmentId: sh.amazon_shipment_id,
    status: String(sh.status),
    sourceWarehouseId: sh.source_warehouse_id ? String(sh.source_warehouse_id) : null,
    shipDate: sh.ship_date,
    expectedArrivalDate: sh.expected_arrival_date,
    carrier: sh.carrier,
    trackingRef: sh.tracking_ref,
    purchaseOrderId: sh.purchase_order_id ? String(sh.purchase_order_id) : null,
    poNumber: (po as { po_number?: string } | null)?.po_number || null,
    notes: sh.notes,
    shippedAt: sh.shipped_at,
    closedAt: sh.closed_at,
    createdAt: String(sh.created_at),
    isLegacy: !!sh.legacy_plan_id,
    items: ((items || []) as Array<Record<string, unknown>>).map((it) => {
      const m = (Array.isArray(it.sku_mappings) ? it.sku_mappings[0] : it.sku_mappings) as Record<string, unknown> | null;
      const sku = String(m?.amazon_sku || m?.temu_sku_id || m?.tiktok_seller_sku || "");
      return {
        id: String(it.id),
        mappingId: String(it.sku_mapping_id),
        productName: catalogName(m?.sku_catalog) || sku,
        sku,
        asin: (m?.amazon_asin as string | null) || null,
        plannedUnits: num(it.planned_units),
        sentUnits: num(it.sent_units),
        receivedUnits: num(it.received_units),
        packProfileId: it.pack_profile_id ? String(it.pack_profile_id) : null,
        unitsPerBox: it.units_per_box == null ? null : num(it.units_per_box),
        boxes: it.boxes == null ? null : num(it.boxes),
        pallets: it.pallets == null ? null : num(it.pallets),
        notes: (it.notes as string | null) || null,
      };
    }),
  };
}
