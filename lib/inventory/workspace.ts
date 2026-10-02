/**
 * Server-side loader for the Inventory section. One call gathers catalogue,
 * stock position, demand, open documents and settings, then runs the planner
 * so every page (planner, POs, FBA shipments, stock) shares the same numbers.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { fetchAllRows } from "@/lib/supabase/fetch-all";
import { todayIsoUtc } from "@/lib/utils/date";
import {
  DEFAULT_PLANNER_SETTINGS,
  planSku,
  type ChannelDemand,
  type DemandChannel,
  type PlannerRow,
  type PlannerSettings,
  type PlannerSkuInput,
} from "./planner";

export type Warehouse = { id: string; name: string };

export type Supplier = {
  id: string;
  name: string;
  contactName: string | null;
  email: string | null;
  phone: string | null;
  country: string | null;
  currency: string;
  manufacturingDays: number;
  shippingDays: number;
  paymentTerms: string | null;
  notes: string | null;
  isActive: boolean;
};

export type PackProfileRef = {
  id: string;
  profileName: string;
  unitsPerBox: number;
  boxLength: number;
  boxWidth: number;
  boxHeight: number;
  dimensionUnit: "mm" | "cm" | "in";
  boxWeight: number | null;
  weightUnit: "kg" | "lb";
};

export type SkuSummary = {
  mappingId: string;
  productName: string;
  amazonSku: string | null;
  temuSkuId: string | null;
  tiktokSku: string | null;
  asin: string | null;
  supplierId: string | null;
  supplierName: string | null;
  leadTimeDays: number | null;
  moq: number | null;
  defaultPackProfileId: string | null;
  unitsPerBox: number | null;
  velocityOverride: number | null;
  isPlanned: boolean;
  unitCost: number;
  /** Where the on-hand numbers come from. */
  fbaSource: "live" | "count" | "none";
  warehouseSource: "count" | "none";
  baselineDate: string | null;
  lastSaleDate: string | null;
  /** Raw (unclamped) warehouse position; negative means the count drifted. */
  warehouseRaw: number | null;
  fbaRaw: number | null;
  demand: Partial<Record<DemandChannel, ChannelDemand>>;
};

export type InventorySettingsRow = {
  leadTimeDays: number;
  amazonCoverDays: number;
  warehouseCoverDays: number;
  storageCostPerPallet: number;
  storageCostPeriod: "week" | "month";
  fbaTransitDays: number;
  fbaCheckinDays: number;
  safetyDays: number;
  overstockDays: number;
  growthRatePct: number;
  velocityWeights: { d7: number; d30: number; d90: number };
};

export type OpenDocumentSummary = {
  id: string;
  label: string;
  status: string;
  date: string | null;
  units: number;
  secondary: string | null;
};

export type InventoryWorkspace = {
  today: string;
  currency: string;
  settings: InventorySettingsRow;
  plannerSettings: PlannerSettings;
  warehouses: Warehouse[];
  defaultWarehouseId: string | null;
  suppliers: Supplier[];
  packProfiles: PackProfileRef[];
  skus: SkuSummary[];
  rows: PlannerRow[];
  fbaLive: { snapshotAt: string | null; fresh: boolean; skus: number };
  openPurchaseOrders: OpenDocumentSummary[];
  openFbaShipments: OpenDocumentSummary[];
};

const OPEN_PO_STATUSES = ["ordered", "in_production", "shipped", "partially_received"];
const LIVE_FBA_MAX_AGE_MS = 36 * 60 * 60 * 1000;

function num(v: unknown, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function normKey(v: string | null | undefined) {
  return String(v || "").replace(/\u00a0/g, " ").trim().toUpperCase();
}

export function settingsFromDefaults(row: Record<string, unknown> | null): InventorySettingsRow {
  const weights = (row?.velocity_weights as Record<string, unknown> | null) || null;
  return {
    leadTimeDays: num(row?.lead_time_days, 90),
    amazonCoverDays: num(row?.amazon_cover_days, 30),
    warehouseCoverDays: num(row?.warehouse_cover_days, 120),
    storageCostPerPallet: num(row?.storage_cost_per_pallet, 0),
    storageCostPeriod: row?.storage_cost_period === "week" ? "week" : "month",
    fbaTransitDays: num(row?.fba_transit_days, 7),
    fbaCheckinDays: num(row?.fba_checkin_days, 5),
    safetyDays: num(row?.safety_days, 14),
    overstockDays: num(row?.overstock_days, 180),
    growthRatePct: num(row?.growth_rate_pct, 0),
    velocityWeights: {
      d7: num(weights?.d7, 0.2),
      d30: num(weights?.d30, 0.5),
      d90: num(weights?.d90, 0.3),
    },
  };
}

export function plannerSettingsFrom(s: InventorySettingsRow): PlannerSettings {
  return {
    ...DEFAULT_PLANNER_SETTINGS,
    fbaCoverDays: s.amazonCoverDays,
    warehouseCoverDays: s.warehouseCoverDays,
    defaultLeadTimeDays: s.leadTimeDays,
    fbaTransitDays: s.fbaTransitDays,
    fbaCheckinDays: s.fbaCheckinDays,
    safetyDays: s.safetyDays,
    overstockDays: s.overstockDays,
    growthRatePct: s.growthRatePct,
    velocityWeights: s.velocityWeights,
  };
}

export async function loadInventoryWorkspace(
  supabase: SupabaseClient,
  accountId: string,
  currency: string
): Promise<InventoryWorkspace> {
  const today = todayIsoUtc();

  type MappingRow = {
    id: string;
    amazon_sku: string | null;
    temu_sku_id: string | null;
    tiktok_seller_sku: string | null;
    amazon_asin: string | null;
    lead_time_days: number | null;
    supplier_id: string | null;
    moq: number | null;
    default_pack_profile_id: string | null;
    velocity_override: number | null;
    is_planned: boolean | null;
    sku_catalog: { product_name: string | null } | { product_name: string | null }[] | null;
  };
  type PositionRow = {
    sku_mapping_id: string;
    baseline_date: string | null;
    baseline_at: string | null;
    baseline_source: string | null;
    baseline_amazon: number;
    baseline_warehouse: number;
    moves_warehouse: number;
    moves_amazon: number;
    sold_warehouse: number;
    returned_warehouse: number;
    sold_fba: number;
    last_sale_date: string | null;
  };
  type DemandRow = {
    sku_mapping_id: string;
    channel: string;
    units_7: number;
    units_30: number;
    units_90: number;
    units_365: number;
    first_sale_date: string | null;
    last_sale_date: string | null;
  };

  const [
    mappingsRes,
    defaultsRes,
    warehousesRes,
    suppliersRes,
    packRes,
    cogsRes,
    positionRes,
    demandRes,
    fbaLiveRes,
    poItemsRes,
    shipItemsRes,
  ] = await Promise.all([
    fetchAllRows<MappingRow>((from, to) =>
      supabase
        .from("sku_mappings")
        .select(
          "id, amazon_sku, temu_sku_id, tiktok_seller_sku, amazon_asin, lead_time_days, supplier_id, moq, default_pack_profile_id, velocity_override, is_planned, sku_catalog(product_name)"
        )
        .eq("account_id", accountId)
        .order("created_at", { ascending: true })
        .range(from, to)
    ),
    supabase.from("inventory_defaults").select("*").eq("account_id", accountId).maybeSingle(),
    supabase.from("inventory_warehouses").select("id, name").eq("account_id", accountId).order("name"),
    supabase.from("inventory_suppliers").select("*").eq("account_id", accountId).order("name"),
    supabase.from("pack_profiles").select("*").eq("account_id", accountId).order("profile_name"),
    fetchAllRows<{ sku: string; unit_cost: number; sku_mapping_id: string | null }>((from, to) =>
      supabase.from("cogs").select("sku, unit_cost, sku_mapping_id").eq("account_id", accountId).range(from, to)
    ),
    supabase.rpc("inventory_stock_position", { p_account_id: accountId }),
    supabase.rpc("inventory_demand_summary", { p_account_id: accountId }),
    supabase.from("amazon_fba_inventory").select("*").eq("account_id", accountId),
    supabase
      .from("purchase_order_items")
      .select("sku_mapping_id, ordered_units, received_units, purchase_orders!inner(id, po_number, status, expected_arrival_date, supplier_id, account_id)")
      .eq("purchase_orders.account_id", accountId)
      .in("purchase_orders.status", OPEN_PO_STATUSES),
    supabase
      .from("fba_shipment_items")
      .select("sku_mapping_id, planned_units, sent_units, received_units, fba_shipments!inner(id, shipment_name, status, ship_date, expected_arrival_date, amazon_shipment_id, account_id)")
      .eq("fba_shipments.account_id", accountId)
      .in("fba_shipments.status", ["draft", "shipped", "receiving"]),
  ]);

  if (mappingsRes.error) throw new Error(mappingsRes.error.message);
  if (positionRes.error) throw new Error(positionRes.error.message);
  if (demandRes.error) throw new Error(demandRes.error.message);

  const settings = settingsFromDefaults((defaultsRes.data as Record<string, unknown> | null) || null);
  const plannerSettings = plannerSettingsFrom(settings);

  const warehouses: Warehouse[] = (warehousesRes.data || []).map((w) => ({ id: String(w.id), name: String(w.name) }));
  const defaultWarehouseId =
    warehouses.find((w) => w.name.trim().toLowerCase() === "sportive")?.id || warehouses[0]?.id || null;

  const suppliers: Supplier[] = ((suppliersRes.data || []) as Record<string, unknown>[]).map((s) => ({
    id: String(s.id),
    name: String(s.name),
    contactName: (s.contact_name as string | null) || null,
    email: (s.email as string | null) || null,
    phone: (s.phone as string | null) || null,
    country: (s.country as string | null) || null,
    currency: String(s.currency || "GBP"),
    manufacturingDays: num(s.manufacturing_days, 30),
    shippingDays: num(s.shipping_days, 45),
    paymentTerms: (s.payment_terms as string | null) || null,
    notes: (s.notes as string | null) || null,
    isActive: s.is_active !== false,
  }));
  const supplierById = new Map(suppliers.map((s) => [s.id, s]));

  const packProfiles: PackProfileRef[] = ((packRes.data || []) as Record<string, unknown>[]).map((p) => ({
    id: String(p.id),
    profileName: String(p.profile_name),
    unitsPerBox: num(p.units_per_box, 1),
    boxLength: num(p.box_length),
    boxWidth: num(p.box_width),
    boxHeight: num(p.box_height),
    dimensionUnit: (p.dimension_unit as "mm" | "cm" | "in") || "cm",
    boxWeight: p.box_weight == null ? null : num(p.box_weight),
    weightUnit: (p.weight_unit as "kg" | "lb") || "kg",
  }));
  const packById = new Map(packProfiles.map((p) => [p.id, p]));

  const cogsByMapping = new Map<string, number>();
  const cogsBySku = new Map<string, number>();
  for (const c of cogsRes.data || []) {
    if (c.sku_mapping_id) cogsByMapping.set(c.sku_mapping_id, num(c.unit_cost));
    cogsBySku.set(normKey(c.sku), num(c.unit_cost));
  }

  const positionByMapping = new Map<string, PositionRow>();
  for (const p of (positionRes.data || []) as PositionRow[]) positionByMapping.set(p.sku_mapping_id, p);

  const demandByMapping = new Map<string, Partial<Record<DemandChannel, ChannelDemand>>>();
  for (const d of (demandRes.data || []) as DemandRow[]) {
    const ch = d.channel as DemandChannel;
    if (!["fba", "fbm", "temu", "tiktok"].includes(ch)) continue;
    const cur = demandByMapping.get(d.sku_mapping_id) || {};
    cur[ch] = {
      units7: num(d.units_7),
      units30: num(d.units_30),
      units90: num(d.units_90),
      units365: num(d.units_365),
      firstSaleDate: d.first_sale_date,
      lastSaleDate: d.last_sale_date,
    };
    demandByMapping.set(d.sku_mapping_id, cur);
  }

  type LiveRow = {
    sku: string;
    fulfillable: number;
    inbound_working: number;
    inbound_shipped: number;
    inbound_receiving: number;
    reserved: number;
    snapshot_at: string;
  };
  const liveRows = ((fbaLiveRes.data || []) as LiveRow[]);
  const liveBySku = new Map(liveRows.map((r) => [normKey(r.sku), r]));
  const liveSnapshotAt = liveRows.reduce<string | null>((acc, r) => (!acc || r.snapshot_at > acc ? r.snapshot_at : acc), null);
  const liveFresh = !!liveSnapshotAt && Date.now() - new Date(liveSnapshotAt).getTime() < LIVE_FBA_MAX_AGE_MS;

  const onOrderByMapping = new Map<string, number>();
  const openPoById = new Map<string, OpenDocumentSummary>();
  for (const item of (poItemsRes.data || []) as Array<Record<string, unknown>>) {
    const po = item.purchase_orders as Record<string, unknown> | null;
    if (!po) continue;
    const outstanding = Math.max(0, num(item.ordered_units) - num(item.received_units));
    const mid = String(item.sku_mapping_id);
    onOrderByMapping.set(mid, (onOrderByMapping.get(mid) || 0) + outstanding);
    const id = String(po.id);
    const cur = openPoById.get(id) || {
      id,
      label: String(po.po_number),
      status: String(po.status),
      date: (po.expected_arrival_date as string | null) || null,
      units: 0,
      secondary: po.supplier_id ? supplierById.get(String(po.supplier_id))?.name || null : null,
    };
    cur.units += outstanding;
    openPoById.set(id, cur);
  }

  const inTransitByMapping = new Map<string, number>();
  const plannedToFbaByMapping = new Map<string, number>();
  const openShipById = new Map<string, OpenDocumentSummary>();
  for (const item of (shipItemsRes.data || []) as Array<Record<string, unknown>>) {
    const sh = item.fba_shipments as Record<string, unknown> | null;
    if (!sh) continue;
    const mid = String(item.sku_mapping_id);
    const status = String(sh.status);
    let units = 0;
    if (status === "draft") {
      units = num(item.planned_units);
      plannedToFbaByMapping.set(mid, (plannedToFbaByMapping.get(mid) || 0) + units);
    } else {
      units = Math.max(0, num(item.sent_units) - num(item.received_units));
      inTransitByMapping.set(mid, (inTransitByMapping.get(mid) || 0) + units);
    }
    const id = String(sh.id);
    const cur = openShipById.get(id) || {
      id,
      label: String(sh.shipment_name),
      status,
      date: (sh.expected_arrival_date as string | null) || (sh.ship_date as string | null) || null,
      units: 0,
      secondary: (sh.amazon_shipment_id as string | null) || null,
    };
    cur.units += units;
    openShipById.set(id, cur);
  }

  const skus: SkuSummary[] = [];
  const rows: PlannerRow[] = [];

  for (const m of mappingsRes.data) {
    const catalog = Array.isArray(m.sku_catalog) ? m.sku_catalog[0] : m.sku_catalog;
    const productName = String(catalog?.product_name || m.amazon_sku || m.temu_sku_id || m.tiktok_seller_sku || "Unnamed");
    const supplier = m.supplier_id ? supplierById.get(m.supplier_id) || null : null;
    const pack = m.default_pack_profile_id ? packById.get(m.default_pack_profile_id) || null : null;
    const unitCost =
      cogsByMapping.get(m.id) ??
      cogsBySku.get(normKey(m.amazon_sku)) ??
      cogsBySku.get(normKey(m.temu_sku_id)) ??
      cogsBySku.get(normKey(m.tiktok_seller_sku)) ??
      0;

    const pos = positionByMapping.get(m.id);
    const hasBaseline = !!pos?.baseline_date;
    const live = m.amazon_sku ? liveBySku.get(normKey(m.amazon_sku)) : undefined;

    let fbaOnHand: number | null = null;
    let fbaRaw: number | null = null;
    let fbaSource: SkuSummary["fbaSource"] = "none";
    let fbaInTransit = inTransitByMapping.get(m.id) || 0;
    let fbaReserved = 0;
    if (live && liveFresh) {
      fbaOnHand = num(live.fulfillable);
      fbaRaw = fbaOnHand;
      fbaReserved = num(live.reserved);
      fbaInTransit = Math.max(fbaInTransit, num(live.inbound_working) + num(live.inbound_shipped) + num(live.inbound_receiving));
      fbaSource = "live";
    } else if (hasBaseline && pos) {
      fbaRaw = num(pos.baseline_amazon) + num(pos.moves_amazon) - num(pos.sold_fba);
      fbaOnHand = Math.max(0, fbaRaw);
      fbaSource = "count";
    }

    let warehouseOnHand: number | null = null;
    let warehouseRaw: number | null = null;
    let warehouseSource: SkuSummary["warehouseSource"] = "none";
    if (hasBaseline && pos) {
      warehouseRaw =
        num(pos.baseline_warehouse) + num(pos.moves_warehouse) - num(pos.sold_warehouse) + num(pos.returned_warehouse);
      warehouseOnHand = Math.max(0, warehouseRaw);
      warehouseSource = "count";
    }

    const demand = demandByMapping.get(m.id) || {};
    const supplierLeadDays =
      m.lead_time_days != null && m.lead_time_days > 0
        ? m.lead_time_days
        : supplier
          ? supplier.manufacturingDays + supplier.shippingDays
          : null;

    const input: PlannerSkuInput = {
      mappingId: m.id,
      demand,
      fbaOnHand,
      fbaInTransit,
      fbaReserved,
      warehouseOnHand,
      onOrder: onOrderByMapping.get(m.id) || 0,
      plannedToFba: plannedToFbaByMapping.get(m.id) || 0,
      unitCost,
      supplierLeadDays,
      moq: m.moq,
      unitsPerBox: pack?.unitsPerBox || null,
      velocityOverride: m.velocity_override,
      isPlanned: m.is_planned !== false,
    };
    const row = planSku(input, plannerSettings, today);
    if (warehouseRaw != null && warehouseRaw < 0) {
      row.reasons.push(`Warehouse count drifted negative (${warehouseRaw}); record a stock take.`);
    }
    if (fbaRaw != null && fbaRaw < 0) {
      row.reasons.push(`FBA count drifted negative (${fbaRaw}); record a stock take.`);
    }

    skus.push({
      mappingId: m.id,
      productName,
      amazonSku: m.amazon_sku,
      temuSkuId: m.temu_sku_id,
      tiktokSku: m.tiktok_seller_sku,
      asin: m.amazon_asin,
      supplierId: m.supplier_id,
      supplierName: supplier?.name || null,
      leadTimeDays: m.lead_time_days,
      moq: m.moq,
      defaultPackProfileId: m.default_pack_profile_id,
      unitsPerBox: pack?.unitsPerBox || null,
      velocityOverride: m.velocity_override,
      isPlanned: m.is_planned !== false,
      unitCost,
      fbaSource,
      warehouseSource,
      baselineDate: pos?.baseline_date || null,
      lastSaleDate: pos?.last_sale_date || null,
      warehouseRaw,
      fbaRaw,
      demand,
    });
    rows.push(row);
  }

  return {
    today,
    currency,
    settings,
    plannerSettings,
    warehouses,
    defaultWarehouseId,
    suppliers,
    packProfiles,
    skus,
    rows,
    fbaLive: { snapshotAt: liveSnapshotAt, fresh: liveFresh, skus: liveRows.length },
    openPurchaseOrders: Array.from(openPoById.values()).sort((a, b) => (a.date || "9999").localeCompare(b.date || "9999")),
    openFbaShipments: Array.from(openShipById.values()).sort((a, b) => (a.date || "9999").localeCompare(b.date || "9999")),
  };
}
