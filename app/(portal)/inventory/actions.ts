"use server";

/**
 * Server actions for the Inventory section. Every action checks the caller is
 * admin/team on the account, then writes with the caller's own Supabase
 * session so RLS still applies.
 */

import { revalidatePath } from "next/cache";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";
import { requireStaffAccountAccess } from "@/lib/auth/require-account";
import { applyCogsVersion } from "@/lib/cogs/apply-cogs-version";
import { syncFbaInventory } from "@/lib/amazon/ingest/fba-inventory";
import { todayIsoUtc } from "@/lib/utils/date";

export type ActionResult<T = undefined> = { ok: true; data?: T } | { ok: false; error: string };

type Ctx = { supabase: SupabaseClient; userId: string; accountId: string };

async function staff(accountId: string): Promise<{ ok: true; ctx: Ctx } | { ok: false; error: string }> {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Not signed in." };
  const id = String(accountId || "").trim();
  if (!id) return { ok: false, error: "Missing account." };
  const access = await requireStaffAccountAccess(supabase, user.id, id);
  if (!access.account) return { ok: false, error: "You do not have edit access to this account." };
  return { ok: true, ctx: { supabase, userId: user.id, accountId: id } };
}

function revalidateInventory() {
  revalidatePath("/inventory", "layout");
}

function fail(err: unknown): { ok: false; error: string } {
  const message = errorMessage(err);
  if (message.includes("cannot affect row a second time")) {
    return { ok: false, error: "Two rows in this save are the same product. Each product can only be saved once." };
  }
  return { ok: false, error: message };
}

function errorMessage(err: unknown): string {
  if (err instanceof Error && err.message.trim()) return err.message;
  if (err && typeof err === "object" && "message" in err) {
    const message = (err as { message?: unknown }).message;
    if (typeof message === "string" && message.trim()) return message;
  }
  if (typeof err === "string" && err.trim() && err !== "[object Object]") return err;
  return "Could not save.";
}

function int(v: unknown, fallback = 0) {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? n : fallback;
}

function dec(v: unknown, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function str(v: unknown): string | null {
  const s = String(v ?? "").trim();
  return s ? s : null;
}

function isoDate(v: unknown): string | null {
  const s = String(v ?? "").trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export type InventorySettingsInput = {
  leadTimeDays: number;
  amazonCoverDays: number;
  warehouseCoverDays: number;
  fbaTransitDays: number;
  fbaCheckinDays: number;
  safetyDays: number;
  overstockDays: number;
  growthRatePct: number;
  velocityWeights: { d7: number; d30: number; d90: number };
  storageCostPerPallet: number;
  storageCostPeriod: "week" | "month";
};

export async function saveInventorySettings(accountId: string, input: InventorySettingsInput): Promise<ActionResult> {
  const s = await staff(accountId);
  if (!s.ok) return s;
  const w = input.velocityWeights;
  const weightSum = dec(w.d7) + dec(w.d30) + dec(w.d90);
  if (weightSum <= 0) return { ok: false, error: "Velocity weights must add up to more than zero." };
  const { error } = await s.ctx.supabase.from("inventory_defaults").upsert(
    {
      account_id: s.ctx.accountId,
      lead_time_days: Math.max(0, int(input.leadTimeDays, 90)),
      amazon_cover_days: Math.max(1, int(input.amazonCoverDays, 30)),
      warehouse_cover_days: Math.max(1, int(input.warehouseCoverDays, 120)),
      fba_transit_days: Math.max(0, int(input.fbaTransitDays, 7)),
      fba_checkin_days: Math.max(0, int(input.fbaCheckinDays, 5)),
      safety_days: Math.max(0, int(input.safetyDays, 14)),
      overstock_days: Math.max(30, int(input.overstockDays, 180)),
      growth_rate_pct: dec(input.growthRatePct, 0),
      velocity_weights: { d7: dec(w.d7) / weightSum, d30: dec(w.d30) / weightSum, d90: dec(w.d90) / weightSum },
      storage_cost_per_pallet: Math.max(0, dec(input.storageCostPerPallet, 0)),
      storage_cost_period: input.storageCostPeriod === "week" ? "week" : "month",
      updated_at: new Date().toISOString(),
    },
    { onConflict: "account_id" }
  );
  if (error) return fail(error);
  revalidateInventory();
  return { ok: true };
}

export type SupplierInput = {
  id?: string | null;
  name: string;
  contactName?: string | null;
  email?: string | null;
  phone?: string | null;
  country?: string | null;
  currency?: string | null;
  manufacturingDays: number;
  shippingDays: number;
  paymentTerms?: string | null;
  notes?: string | null;
  isActive?: boolean;
};

export async function upsertSupplier(accountId: string, input: SupplierInput): Promise<ActionResult<{ id: string }>> {
  const s = await staff(accountId);
  if (!s.ok) return s;
  const name = str(input.name);
  if (!name) return { ok: false, error: "Supplier name is required." };
  const payload = {
    account_id: s.ctx.accountId,
    name,
    contact_name: str(input.contactName),
    email: str(input.email),
    phone: str(input.phone),
    country: str(input.country),
    currency: (str(input.currency) || "GBP").toUpperCase(),
    manufacturing_days: Math.max(0, int(input.manufacturingDays, 30)),
    shipping_days: Math.max(0, int(input.shippingDays, 45)),
    payment_terms: str(input.paymentTerms),
    notes: str(input.notes),
    is_active: input.isActive !== false,
    updated_at: new Date().toISOString(),
  };
  const query = input.id
    ? s.ctx.supabase.from("inventory_suppliers").update(payload).eq("id", input.id).eq("account_id", s.ctx.accountId).select("id").single()
    : s.ctx.supabase.from("inventory_suppliers").insert(payload).select("id").single();
  const { data, error } = await query;
  if (error) return fail(error);
  revalidateInventory();
  return { ok: true, data: { id: String(data.id) } };
}

export async function deleteSupplier(accountId: string, supplierId: string): Promise<ActionResult> {
  const s = await staff(accountId);
  if (!s.ok) return s;
  const { error } = await s.ctx.supabase.from("inventory_suppliers").delete().eq("id", supplierId).eq("account_id", s.ctx.accountId);
  if (error) return fail(error);
  revalidateInventory();
  return { ok: true };
}

export async function upsertWarehouse(accountId: string, input: { id?: string | null; name: string }): Promise<ActionResult> {
  const s = await staff(accountId);
  if (!s.ok) return s;
  const name = str(input.name);
  if (!name) return { ok: false, error: "Warehouse name is required." };
  const { error } = input.id
    ? await s.ctx.supabase.from("inventory_warehouses").update({ name, updated_at: new Date().toISOString() }).eq("id", input.id).eq("account_id", s.ctx.accountId)
    : await s.ctx.supabase.from("inventory_warehouses").insert({ account_id: s.ctx.accountId, name });
  if (error) return fail(error);
  revalidateInventory();
  return { ok: true };
}

export async function deleteWarehouse(accountId: string, warehouseId: string): Promise<ActionResult> {
  const s = await staff(accountId);
  if (!s.ok) return s;
  const { error } = await s.ctx.supabase.from("inventory_warehouses").delete().eq("id", warehouseId).eq("account_id", s.ctx.accountId);
  if (error) return fail(error);
  revalidateInventory();
  return { ok: true };
}

export type PackProfileInput = {
  id?: string | null;
  profileName: string;
  unitsPerBox: number;
  boxLength: number;
  boxWidth: number;
  boxHeight: number;
  dimensionUnit: "mm" | "cm" | "in";
  boxWeight?: number | null;
  weightUnit: "kg" | "lb";
};

export async function upsertPackProfile(accountId: string, input: PackProfileInput): Promise<ActionResult<{ id: string }>> {
  const s = await staff(accountId);
  if (!s.ok) return s;
  const profileName = str(input.profileName);
  if (!profileName) return { ok: false, error: "Carton name is required." };
  if (int(input.unitsPerBox) <= 0) return { ok: false, error: "Units per carton must be at least 1." };
  const payload = {
    account_id: s.ctx.accountId,
    profile_name: profileName,
    units_per_box: int(input.unitsPerBox, 1),
    box_length: Math.max(0, dec(input.boxLength)),
    box_width: Math.max(0, dec(input.boxWidth)),
    box_height: Math.max(0, dec(input.boxHeight)),
    dimension_unit: ["mm", "cm", "in"].includes(input.dimensionUnit) ? input.dimensionUnit : "cm",
    box_weight: input.boxWeight == null || input.boxWeight === ("" as unknown) ? null : Math.max(0, dec(input.boxWeight)),
    weight_unit: input.weightUnit === "lb" ? "lb" : "kg",
    updated_at: new Date().toISOString(),
  };
  const query = input.id
    ? s.ctx.supabase.from("pack_profiles").update(payload).eq("id", input.id).eq("account_id", s.ctx.accountId).select("id").single()
    : s.ctx.supabase.from("pack_profiles").insert(payload).select("id").single();
  const { data, error } = await query;
  if (error) return fail(error);
  revalidateInventory();
  return { ok: true, data: { id: String(data.id) } };
}

export async function deletePackProfile(accountId: string, profileId: string): Promise<ActionResult> {
  const s = await staff(accountId);
  if (!s.ok) return s;
  // Unlink first so FK "set null" semantics are explicit.
  await s.ctx.supabase.from("sku_mappings").update({ default_pack_profile_id: null }).eq("account_id", s.ctx.accountId).eq("default_pack_profile_id", profileId);
  const { error } = await s.ctx.supabase.from("pack_profiles").delete().eq("id", profileId).eq("account_id", s.ctx.accountId);
  if (error) return fail(error);
  revalidateInventory();
  return { ok: true };
}

export type SkuPlanningInput = {
  supplierId?: string | null;
  leadTimeDays?: number | null;
  moq?: number | null;
  defaultPackProfileId?: string | null;
  velocityOverride?: number | null;
  isPlanned?: boolean;
};

export async function updateSkuPlanning(accountId: string, mappingId: string, input: SkuPlanningInput): Promise<ActionResult> {
  const s = await staff(accountId);
  if (!s.ok) return s;
  const payload: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if ("supplierId" in input) payload.supplier_id = str(input.supplierId);
  if ("leadTimeDays" in input) payload.lead_time_days = input.leadTimeDays == null || input.leadTimeDays === ("" as unknown) ? null : Math.max(0, int(input.leadTimeDays));
  if ("moq" in input) payload.moq = input.moq == null || input.moq === ("" as unknown) ? null : Math.max(0, int(input.moq));
  if ("defaultPackProfileId" in input) payload.default_pack_profile_id = str(input.defaultPackProfileId);
  if ("velocityOverride" in input)
    payload.velocity_override = input.velocityOverride == null || input.velocityOverride === ("" as unknown) ? null : Math.max(0, dec(input.velocityOverride));
  if ("isPlanned" in input) payload.is_planned = input.isPlanned !== false;
  const { error } = await s.ctx.supabase.from("sku_mappings").update(payload).eq("id", mappingId).eq("account_id", s.ctx.accountId);
  if (error) return fail(error);
  revalidateInventory();
  return { ok: true };
}

export async function bulkUpdateSkuPlanning(
  accountId: string,
  rows: Array<{ mappingId: string } & SkuPlanningInput>
): Promise<ActionResult<{ updated: number }>> {
  const s = await staff(accountId);
  if (!s.ok) return s;
  let updated = 0;
  for (const row of rows) {
    const res = await updateSkuPlanning(accountId, row.mappingId, row);
    if (res.ok) updated += 1;
  }
  return { ok: true, data: { updated } };
}

// ---------------------------------------------------------------------------
// Stock takes and adjustments
// ---------------------------------------------------------------------------

export type StockTakeEntry = { mappingId: string; fbaUnits: number; warehouseUnits: number };

export async function recordStockTake(
  accountId: string,
  input: { date: string; entries: StockTakeEntry[]; notes?: string | null }
): Promise<ActionResult<{ saved: number }>> {
  const s = await staff(accountId);
  if (!s.ok) return s;
  const date = isoDate(input.date) || todayIsoUtc();
  const reason = str(input.notes);
  if (!reason) return { ok: false, error: "Add a reason for this stock take." };
  const built = input.entries
    .filter((e) => e.mappingId)
    .map((e) => ({
      account_id: s.ctx.accountId,
      sku_mapping_id: e.mappingId,
      level_date: date,
      amazon_units: Math.max(0, int(e.fbaUnits)),
      warehouse_units: Math.max(0, int(e.warehouseUnits)),
      source: "manual",
      notes: reason,
      updated_by: s.ctx.userId,
      updated_at: new Date().toISOString(),
    }));
  const byProduct = new Map<string, (typeof built)[number]>();
  const conflictIds = new Set<string>();
  for (const row of built) {
    const prev = byProduct.get(row.sku_mapping_id);
    if (prev && (prev.amazon_units !== row.amazon_units || prev.warehouse_units !== row.warehouse_units)) conflictIds.add(row.sku_mapping_id);
    byProduct.set(row.sku_mapping_id, row);
  }
  if (conflictIds.size > 0) {
    return {
      ok: false,
      error: `The same product is listed more than once with different counts (${conflictIds.size} product${conflictIds.size === 1 ? "" : "s"}). Nothing was saved.`,
    };
  }
  const rows = [...byProduct.values()];
  if (rows.length === 0) return { ok: false, error: "Nothing to save." };
  const { error } = await s.ctx.supabase.from("inventory_levels").upsert(rows, { onConflict: "account_id,sku_mapping_id,level_date" });
  if (error) return fail(error);
  revalidateInventory();
  return { ok: true, data: { saved: rows.length } };
}

export type AdjustmentType = "customer_return" | "b2b_outbound" | "damaged" | "adjustment";

export async function recordAdjustment(
  accountId: string,
  input: {
    mappingId: string;
    type: AdjustmentType;
    location: "warehouse" | "amazon";
    units: number;
    date: string;
    warehouseId?: string | null;
    notes?: string | null;
  }
): Promise<ActionResult> {
  const s = await staff(accountId);
  if (!s.ok) return s;
  const units = int(input.units);
  if (units === 0) return { ok: false, error: "Units cannot be zero." };
  if (!str(input.notes)) return { ok: false, error: "Add a reason for this change." };
  let delta = Math.abs(units);
  if (input.type === "b2b_outbound" || input.type === "damaged") delta = -delta;
  if (input.type === "adjustment") delta = units; // signed as entered
  const { error } = await s.ctx.supabase.from("inventory_movements").insert({
    account_id: s.ctx.accountId,
    sku_mapping_id: input.mappingId,
    movement_date: isoDate(input.date) || todayIsoUtc(),
    movement_type: input.type,
    units_delta: delta,
    location: input.location === "amazon" ? "amazon" : "warehouse",
    warehouse_id: input.location === "amazon" ? null : str(input.warehouseId),
    notes: str(input.notes),
    created_by: s.ctx.userId,
  });
  if (error) return fail(error);
  revalidateInventory();
  return { ok: true };
}

export async function deleteMovement(accountId: string, movementId: string): Promise<ActionResult> {
  const s = await staff(accountId);
  if (!s.ok) return s;
  const { data: mv } = await s.ctx.supabase
    .from("inventory_movements")
    .select("id, reference_type")
    .eq("id", movementId)
    .eq("account_id", s.ctx.accountId)
    .maybeSingle();
  if (!mv) return { ok: false, error: "Movement not found." };
  if (mv.reference_type) return { ok: false, error: "This movement belongs to a purchase order or FBA shipment. Edit that document instead." };
  const { error } = await s.ctx.supabase.from("inventory_movements").delete().eq("id", movementId);
  if (error) return fail(error);
  revalidateInventory();
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Purchase orders
// ---------------------------------------------------------------------------

export type PurchaseOrderItemInput = {
  mappingId: string;
  orderedUnits: number;
  unitCost: number;
  packProfileId?: string | null;
  unitsPerBox?: number | null;
  notes?: string | null;
};

export type PurchaseOrderHeaderInput = {
  supplierId?: string | null;
  orderDate?: string | null;
  expectedReadyDate?: string | null;
  expectedArrivalDate?: string | null;
  destinationWarehouseId?: string | null;
  currency?: string | null;
  freightCost?: number;
  dutyCost?: number;
  otherCost?: number;
  trackingRef?: string | null;
  notes?: string | null;
};

async function nextPoNumber(supabase: SupabaseClient, accountId: string) {
  const year = new Date().getUTCFullYear();
  const { count } = await supabase
    .from("purchase_orders")
    .select("id", { count: "exact", head: true })
    .eq("account_id", accountId)
    .like("po_number", `PO-${year}-%`);
  return `PO-${year}-${String((count || 0) + 1).padStart(3, "0")}`;
}

function headerPayload(input: PurchaseOrderHeaderInput) {
  const payload: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if ("supplierId" in input) payload.supplier_id = str(input.supplierId);
  if ("orderDate" in input) payload.order_date = isoDate(input.orderDate);
  if ("expectedReadyDate" in input) payload.expected_ready_date = isoDate(input.expectedReadyDate);
  if ("expectedArrivalDate" in input) payload.expected_arrival_date = isoDate(input.expectedArrivalDate);
  if ("destinationWarehouseId" in input) payload.destination_warehouse_id = str(input.destinationWarehouseId);
  if ("currency" in input) payload.currency = (str(input.currency) || "GBP").toUpperCase();
  if ("freightCost" in input) payload.freight_cost = Math.max(0, dec(input.freightCost));
  if ("dutyCost" in input) payload.duty_cost = Math.max(0, dec(input.dutyCost));
  if ("otherCost" in input) payload.other_cost = Math.max(0, dec(input.otherCost));
  if ("trackingRef" in input) payload.tracking_ref = str(input.trackingRef);
  if ("notes" in input) payload.notes = str(input.notes);
  return payload;
}

export async function createPurchaseOrder(
  accountId: string,
  input: PurchaseOrderHeaderInput & { items: PurchaseOrderItemInput[]; status?: "draft" | "ordered" }
): Promise<ActionResult<{ id: string; poNumber: string }>> {
  const s = await staff(accountId);
  if (!s.ok) return s;
  const items = (input.items || []).filter((i) => i.mappingId && int(i.orderedUnits) > 0);
  if (items.length === 0) return { ok: false, error: "Add at least one SKU with units." };

  let poNumber = await nextPoNumber(s.ctx.supabase, s.ctx.accountId);
  let created: { id: string } | null = null;
  for (let attempt = 0; attempt < 3 && !created; attempt++) {
    const { data, error } = await s.ctx.supabase
      .from("purchase_orders")
      .insert({
        account_id: s.ctx.accountId,
        po_number: poNumber,
        status: input.status === "ordered" ? "ordered" : "draft",
        created_by: s.ctx.userId,
        ...headerPayload({ ...input, orderDate: input.orderDate || (input.status === "ordered" ? todayIsoUtc() : null) }),
      })
      .select("id")
      .single();
    if (!error && data) created = { id: String(data.id) };
    else if (error && /duplicate|unique/i.test(error.message)) {
      poNumber = `${poNumber}-${attempt + 1}`;
    } else if (error) return fail(error);
  }
  if (!created) return { ok: false, error: "Could not allocate a PO number." };

  const { error: itemsError } = await s.ctx.supabase.from("purchase_order_items").insert(
    items.map((i) => ({
      purchase_order_id: created!.id,
      sku_mapping_id: i.mappingId,
      ordered_units: int(i.orderedUnits),
      unit_cost: Math.max(0, dec(i.unitCost)),
      pack_profile_id: str(i.packProfileId),
      units_per_box: i.unitsPerBox ? Math.max(1, int(i.unitsPerBox)) : null,
      notes: str(i.notes),
    }))
  );
  if (itemsError) return fail(itemsError);
  revalidateInventory();
  return { ok: true, data: { id: created.id, poNumber } };
}

export async function updatePurchaseOrder(accountId: string, poId: string, input: PurchaseOrderHeaderInput): Promise<ActionResult> {
  const s = await staff(accountId);
  if (!s.ok) return s;
  const { error } = await s.ctx.supabase.from("purchase_orders").update(headerPayload(input)).eq("id", poId).eq("account_id", s.ctx.accountId);
  if (error) return fail(error);
  revalidateInventory();
  return { ok: true };
}

export async function replacePurchaseOrderItems(accountId: string, poId: string, items: PurchaseOrderItemInput[]): Promise<ActionResult> {
  const s = await staff(accountId);
  if (!s.ok) return s;
  const { data: po } = await s.ctx.supabase.from("purchase_orders").select("id, status").eq("id", poId).eq("account_id", s.ctx.accountId).maybeSingle();
  if (!po) return { ok: false, error: "Purchase order not found." };
  const { data: existing } = await s.ctx.supabase.from("purchase_order_items").select("id, sku_mapping_id, received_units").eq("purchase_order_id", poId);
  const receivedByMapping = new Map((existing || []).map((e) => [String(e.sku_mapping_id), int(e.received_units)]));
  const clean = items.filter((i) => i.mappingId && int(i.orderedUnits) >= 0);
  for (const i of clean) {
    const received = receivedByMapping.get(i.mappingId) || 0;
    if (int(i.orderedUnits) < received) return { ok: false, error: `Ordered units cannot be below units already received (${received}).` };
  }
  for (const [mappingId, received] of receivedByMapping) {
    if (received > 0 && !clean.some((i) => i.mappingId === mappingId)) {
      return { ok: false, error: "Cannot remove a line that already has receipts." };
    }
  }
  // Upsert by mapping: update existing lines, insert new, delete removed.
  const keep = new Set<string>();
  for (const i of clean) {
    const ex = (existing || []).find((e) => String(e.sku_mapping_id) === i.mappingId);
    const payload = {
      ordered_units: int(i.orderedUnits),
      unit_cost: Math.max(0, dec(i.unitCost)),
      pack_profile_id: str(i.packProfileId),
      units_per_box: i.unitsPerBox ? Math.max(1, int(i.unitsPerBox)) : null,
      notes: str(i.notes),
    };
    if (ex) {
      keep.add(String(ex.id));
      const { error } = await s.ctx.supabase.from("purchase_order_items").update(payload).eq("id", ex.id);
      if (error) return fail(error);
    } else {
      const { data, error } = await s.ctx.supabase
        .from("purchase_order_items")
        .insert({ purchase_order_id: poId, sku_mapping_id: i.mappingId, ...payload })
        .select("id")
        .single();
      if (error) return fail(error);
      keep.add(String(data.id));
    }
  }
  for (const ex of existing || []) {
    if (!keep.has(String(ex.id))) {
      const { error } = await s.ctx.supabase.from("purchase_order_items").delete().eq("id", ex.id);
      if (error) return fail(error);
    }
  }
  await s.ctx.supabase.from("purchase_orders").update({ updated_at: new Date().toISOString() }).eq("id", poId);
  revalidateInventory();
  return { ok: true };
}

export type PurchaseOrderStatus = "draft" | "ordered" | "in_production" | "shipped" | "partially_received" | "received" | "closed" | "cancelled";

export async function setPurchaseOrderStatus(accountId: string, poId: string, status: PurchaseOrderStatus): Promise<ActionResult> {
  const s = await staff(accountId);
  if (!s.ok) return s;
  const { data: po } = await s.ctx.supabase.from("purchase_orders").select("id, status, order_date").eq("id", poId).eq("account_id", s.ctx.accountId).maybeSingle();
  if (!po) return { ok: false, error: "Purchase order not found." };
  const payload: Record<string, unknown> = { status, updated_at: new Date().toISOString() };
  if (status === "ordered" && !po.order_date) payload.order_date = todayIsoUtc();
  if (status === "closed") payload.closed_at = new Date().toISOString();
  if (status !== "closed" && po.status === "closed") payload.closed_at = null;
  const { error } = await s.ctx.supabase.from("purchase_orders").update(payload).eq("id", poId);
  if (error) return fail(error);
  revalidateInventory();
  return { ok: true };
}

export async function deletePurchaseOrder(accountId: string, poId: string): Promise<ActionResult> {
  const s = await staff(accountId);
  if (!s.ok) return s;
  const { count } = await s.ctx.supabase.from("purchase_order_receipts").select("id", { count: "exact", head: true }).eq("purchase_order_id", poId);
  if ((count || 0) > 0) return { ok: false, error: "This PO has receipts. Cancel it instead of deleting." };
  const { error } = await s.ctx.supabase.from("purchase_orders").delete().eq("id", poId).eq("account_id", s.ctx.accountId);
  if (error) return fail(error);
  revalidateInventory();
  return { ok: true };
}

export type ReceiptLine = { itemId: string; units: number };

export async function receivePurchaseOrder(
  accountId: string,
  input: { poId: string; date: string; warehouseId?: string | null; notes?: string | null; lines: ReceiptLine[] }
): Promise<ActionResult<{ received: number; status: string }>> {
  const s = await staff(accountId);
  if (!s.ok) return s;
  const { data: po } = await s.ctx.supabase
    .from("purchase_orders")
    .select("id, status, destination_warehouse_id")
    .eq("id", input.poId)
    .eq("account_id", s.ctx.accountId)
    .maybeSingle();
  if (!po) return { ok: false, error: "Purchase order not found." };
  if (po.status === "cancelled") return { ok: false, error: "This PO is cancelled." };
  const { data: items } = await s.ctx.supabase
    .from("purchase_order_items")
    .select("id, sku_mapping_id, ordered_units, received_units")
    .eq("purchase_order_id", input.poId);
  const itemById = new Map((items || []).map((i) => [String(i.id), i]));
  const date = isoDate(input.date) || todayIsoUtc();
  const warehouseId = str(input.warehouseId) || (po.destination_warehouse_id as string | null) || null;

  let receivedTotal = 0;
  for (const line of input.lines) {
    const units = int(line.units);
    if (units <= 0) continue;
    const item = itemById.get(line.itemId);
    if (!item) return { ok: false, error: "Line not found on this PO." };
    const { data: mv, error: mvError } = await s.ctx.supabase
      .from("inventory_movements")
      .insert({
        account_id: s.ctx.accountId,
        sku_mapping_id: item.sku_mapping_id,
        movement_date: date,
        movement_type: "po_receipt",
        units_delta: units,
        location: "warehouse",
        warehouse_id: warehouseId,
        reference_type: "purchase_order",
        reference_id: input.poId,
        notes: str(input.notes),
        created_by: s.ctx.userId,
      })
      .select("id")
      .single();
    if (mvError) return fail(mvError);
    const { error: rcError } = await s.ctx.supabase.from("purchase_order_receipts").insert({
      account_id: s.ctx.accountId,
      purchase_order_id: input.poId,
      purchase_order_item_id: item.id,
      received_date: date,
      units,
      warehouse_id: warehouseId,
      movement_id: mv.id,
      notes: str(input.notes),
      created_by: s.ctx.userId,
    });
    if (rcError) return fail(rcError);
    const { error: upError } = await s.ctx.supabase
      .from("purchase_order_items")
      .update({ received_units: int(item.received_units) + units })
      .eq("id", item.id);
    if (upError) return fail(upError);
    item.received_units = int(item.received_units) + units;
    receivedTotal += units;
  }
  if (receivedTotal === 0) return { ok: false, error: "Enter units received on at least one line." };

  const allReceived = (items || []).every((i) => int(i.received_units) >= int(i.ordered_units));
  const status = allReceived ? "received" : "partially_received";
  await s.ctx.supabase
    .from("purchase_orders")
    .update({ status, updated_at: new Date().toISOString() })
    .eq("id", input.poId);
  revalidateInventory();
  return { ok: true, data: { received: receivedTotal, status } };
}

/**
 * Landed cost per unit = line unit cost + share of freight/duty/other,
 * allocated by units ordered. Returned for review; applied only on request.
 */
export async function applyLandedCostToCogs(
  accountId: string,
  input: { poId: string; effectiveFrom: string; lines: Array<{ mappingId: string; landedUnitCost: number }> }
): Promise<ActionResult<{ applied: number }>> {
  const s = await staff(accountId);
  if (!s.ok) return s;
  const effectiveFrom = isoDate(input.effectiveFrom) || todayIsoUtc();
  const mappingIds = input.lines.map((l) => l.mappingId);
  const { data: mappings } = await s.ctx.supabase
    .from("sku_mappings")
    .select("id, amazon_sku, temu_sku_id, tiktok_seller_sku, sku_catalog(product_name)")
    .eq("account_id", s.ctx.accountId)
    .in("id", mappingIds);
  let applied = 0;
  for (const line of input.lines) {
    const m = (mappings || []).find((x) => String(x.id) === line.mappingId);
    if (!m) continue;
    const sku = m.amazon_sku || m.temu_sku_id || m.tiktok_seller_sku;
    if (!sku) continue;
    const catalog = Array.isArray(m.sku_catalog) ? m.sku_catalog[0] : m.sku_catalog;
    const productName = String((catalog as { product_name?: string | null } | null)?.product_name || sku);
    try {
      await applyCogsVersion(s.ctx.supabase, s.ctx.accountId, {
        sku,
        productName,
        unitCost: Math.max(0, dec(line.landedUnitCost)),
        includesVat: false,
        effectiveFrom,
      });
      applied += 1;
    } catch (err) {
      return fail(err);
    }
  }
  await s.ctx.supabase
    .from("purchase_orders")
    .update({ cogs_applied_at: new Date().toISOString() })
    .eq("id", input.poId)
    .eq("account_id", s.ctx.accountId);
  revalidateInventory();
  revalidatePath("/cogs");
  return { ok: true, data: { applied } };
}

// ---------------------------------------------------------------------------
// FBA shipments
// ---------------------------------------------------------------------------

export type FbaShipmentItemInput = {
  mappingId: string;
  plannedUnits: number;
  packProfileId?: string | null;
  unitsPerBox?: number | null;
  boxes?: number | null;
  pallets?: number | null;
  notes?: string | null;
};

export type FbaShipmentHeaderInput = {
  shipmentName?: string | null;
  amazonShipmentId?: string | null;
  sourceWarehouseId?: string | null;
  shipDate?: string | null;
  expectedArrivalDate?: string | null;
  carrier?: string | null;
  trackingRef?: string | null;
  purchaseOrderId?: string | null;
  notes?: string | null;
};

function shipmentHeaderPayload(input: FbaShipmentHeaderInput) {
  const payload: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if ("shipmentName" in input && str(input.shipmentName)) payload.shipment_name = str(input.shipmentName);
  if ("amazonShipmentId" in input) payload.amazon_shipment_id = str(input.amazonShipmentId)?.toUpperCase() || null;
  if ("sourceWarehouseId" in input) payload.source_warehouse_id = str(input.sourceWarehouseId);
  if ("shipDate" in input) payload.ship_date = isoDate(input.shipDate);
  if ("expectedArrivalDate" in input) payload.expected_arrival_date = isoDate(input.expectedArrivalDate);
  if ("carrier" in input) payload.carrier = str(input.carrier);
  if ("trackingRef" in input) payload.tracking_ref = str(input.trackingRef);
  if ("purchaseOrderId" in input) payload.purchase_order_id = str(input.purchaseOrderId);
  if ("notes" in input) payload.notes = str(input.notes);
  return payload;
}

function itemPayload(i: FbaShipmentItemInput) {
  return {
    planned_units: Math.max(0, int(i.plannedUnits)),
    pack_profile_id: str(i.packProfileId),
    units_per_box: i.unitsPerBox ? Math.max(1, int(i.unitsPerBox)) : null,
    boxes: i.boxes == null ? null : Math.max(0, int(i.boxes)),
    pallets: i.pallets == null ? null : Math.max(0, dec(i.pallets)),
    notes: str(i.notes),
  };
}

export async function createFbaShipment(
  accountId: string,
  input: FbaShipmentHeaderInput & { items: FbaShipmentItemInput[] }
): Promise<ActionResult<{ id: string }>> {
  const s = await staff(accountId);
  if (!s.ok) return s;
  const items = (input.items || []).filter((i) => i.mappingId && int(i.plannedUnits) > 0);
  if (items.length === 0) return { ok: false, error: "Add at least one SKU with units." };
  const name = str(input.shipmentName) || `FBA ${todayIsoUtc()}`;
  const { data, error } = await s.ctx.supabase
    .from("fba_shipments")
    .insert({
      account_id: s.ctx.accountId,
      shipment_name: name,
      status: "draft",
      created_by: s.ctx.userId,
      ...shipmentHeaderPayload({ ...input, shipmentName: name }),
    })
    .select("id")
    .single();
  if (error) return fail(error);
  const { error: itemsError } = await s.ctx.supabase.from("fba_shipment_items").insert(
    items.map((i) => ({ fba_shipment_id: data.id, sku_mapping_id: i.mappingId, ...itemPayload(i) }))
  );
  if (itemsError) return fail(itemsError);
  revalidateInventory();
  return { ok: true, data: { id: String(data.id) } };
}

export async function updateFbaShipment(accountId: string, shipmentId: string, input: FbaShipmentHeaderInput): Promise<ActionResult> {
  const s = await staff(accountId);
  if (!s.ok) return s;
  const { error } = await s.ctx.supabase.from("fba_shipments").update(shipmentHeaderPayload(input)).eq("id", shipmentId).eq("account_id", s.ctx.accountId);
  if (error) return fail(error);
  revalidateInventory();
  return { ok: true };
}

export async function replaceFbaShipmentItems(accountId: string, shipmentId: string, items: FbaShipmentItemInput[]): Promise<ActionResult> {
  const s = await staff(accountId);
  if (!s.ok) return s;
  const { data: sh } = await s.ctx.supabase.from("fba_shipments").select("id, status").eq("id", shipmentId).eq("account_id", s.ctx.accountId).maybeSingle();
  if (!sh) return { ok: false, error: "Shipment not found." };
  if (sh.status !== "draft") return { ok: false, error: "Only draft shipments can change their lines. Record received units instead." };
  const { error: delError } = await s.ctx.supabase.from("fba_shipment_items").delete().eq("fba_shipment_id", shipmentId);
  if (delError) return fail(delError);
  const clean = items.filter((i) => i.mappingId && int(i.plannedUnits) > 0);
  if (clean.length > 0) {
    const { error } = await s.ctx.supabase.from("fba_shipment_items").insert(
      clean.map((i) => ({ fba_shipment_id: shipmentId, sku_mapping_id: i.mappingId, ...itemPayload(i) }))
    );
    if (error) return fail(error);
  }
  await s.ctx.supabase.from("fba_shipments").update({ updated_at: new Date().toISOString() }).eq("id", shipmentId);
  revalidateInventory();
  return { ok: true };
}

/**
 * Mark a shipment as shipped: deducts the sent units from the warehouse and
 * puts them "in transit" until Amazon receives them.
 */
export async function shipFbaShipment(
  accountId: string,
  input: { shipmentId: string; shipDate: string; lines: Array<{ itemId: string; sentUnits: number }>; amazonShipmentId?: string | null; carrier?: string | null; trackingRef?: string | null }
): Promise<ActionResult> {
  const s = await staff(accountId);
  if (!s.ok) return s;
  const { data: sh } = await s.ctx.supabase
    .from("fba_shipments")
    .select("id, status, source_warehouse_id")
    .eq("id", input.shipmentId)
    .eq("account_id", s.ctx.accountId)
    .maybeSingle();
  if (!sh) return { ok: false, error: "Shipment not found." };
  if (sh.status !== "draft") return { ok: false, error: "This shipment has already been shipped." };
  const { data: items } = await s.ctx.supabase.from("fba_shipment_items").select("id, sku_mapping_id, planned_units").eq("fba_shipment_id", input.shipmentId);
  const date = isoDate(input.shipDate) || todayIsoUtc();
  let total = 0;
  for (const item of items || []) {
    const line = input.lines.find((l) => l.itemId === String(item.id));
    const sent = line ? int(line.sentUnits) : int(item.planned_units);
    if (sent <= 0) {
      await s.ctx.supabase.from("fba_shipment_items").update({ sent_units: 0 }).eq("id", item.id);
      continue;
    }
    const { error: mvError } = await s.ctx.supabase.from("inventory_movements").insert({
      account_id: s.ctx.accountId,
      sku_mapping_id: item.sku_mapping_id,
      movement_date: date,
      movement_type: "fba_shipment_out",
      units_delta: -sent,
      location: "warehouse",
      warehouse_id: sh.source_warehouse_id,
      reference_type: "fba_shipment",
      reference_id: input.shipmentId,
      created_by: s.ctx.userId,
    });
    if (mvError) return fail(mvError);
    const { error } = await s.ctx.supabase.from("fba_shipment_items").update({ sent_units: sent }).eq("id", item.id);
    if (error) return fail(error);
    total += sent;
  }
  if (total === 0) return { ok: false, error: "No units to ship." };
  const { error } = await s.ctx.supabase
    .from("fba_shipments")
    .update({
      status: "shipped",
      ship_date: date,
      shipped_at: new Date().toISOString(),
      ...shipmentHeaderPayload({ amazonShipmentId: input.amazonShipmentId, carrier: input.carrier, trackingRef: input.trackingRef }),
    })
    .eq("id", input.shipmentId);
  if (error) return fail(error);
  revalidateInventory();
  return { ok: true };
}

/** Record units Amazon has checked in so far (cumulative per line). */
export async function receiveFbaShipment(
  accountId: string,
  input: { shipmentId: string; date: string; lines: Array<{ itemId: string; receivedUnits: number }>; close?: boolean }
): Promise<ActionResult<{ status: string }>> {
  const s = await staff(accountId);
  if (!s.ok) return s;
  const { data: sh } = await s.ctx.supabase.from("fba_shipments").select("id, status").eq("id", input.shipmentId).eq("account_id", s.ctx.accountId).maybeSingle();
  if (!sh) return { ok: false, error: "Shipment not found." };
  if (sh.status === "draft") return { ok: false, error: "Mark the shipment as shipped first." };
  if (sh.status === "cancelled") return { ok: false, error: "This shipment is cancelled." };
  const { data: items } = await s.ctx.supabase.from("fba_shipment_items").select("id, sku_mapping_id, sent_units, received_units").eq("fba_shipment_id", input.shipmentId);
  const date = isoDate(input.date) || todayIsoUtc();
  for (const line of input.lines) {
    const item = (items || []).find((i) => String(i.id) === line.itemId);
    if (!item) continue;
    const target = Math.max(0, int(line.receivedUnits));
    const delta = target - int(item.received_units);
    if (delta === 0) continue;
    const { error: mvError } = await s.ctx.supabase.from("inventory_movements").insert({
      account_id: s.ctx.accountId,
      sku_mapping_id: item.sku_mapping_id,
      movement_date: date,
      movement_type: "fba_received",
      units_delta: delta,
      location: "amazon",
      reference_type: "fba_shipment",
      reference_id: input.shipmentId,
      created_by: s.ctx.userId,
    });
    if (mvError) return fail(mvError);
    const { error } = await s.ctx.supabase.from("fba_shipment_items").update({ received_units: target }).eq("id", item.id);
    if (error) return fail(error);
    item.received_units = target;
  }
  const allIn = (items || []).every((i) => int(i.received_units) >= int(i.sent_units));
  const status = input.close || allIn ? "closed" : "receiving";
  const { error } = await s.ctx.supabase
    .from("fba_shipments")
    .update({ status, closed_at: status === "closed" ? new Date().toISOString() : null, updated_at: new Date().toISOString() })
    .eq("id", input.shipmentId);
  if (error) return fail(error);
  revalidateInventory();
  return { ok: true, data: { status } };
}

export async function cancelFbaShipment(accountId: string, shipmentId: string): Promise<ActionResult> {
  const s = await staff(accountId);
  if (!s.ok) return s;
  const { data: sh } = await s.ctx.supabase.from("fba_shipments").select("id, status").eq("id", shipmentId).eq("account_id", s.ctx.accountId).maybeSingle();
  if (!sh) return { ok: false, error: "Shipment not found." };
  if (sh.status !== "draft") {
    // Shipped stock comes back to the warehouse.
    const { data: items } = await s.ctx.supabase.from("fba_shipment_items").select("id, sku_mapping_id, sent_units, received_units").eq("fba_shipment_id", shipmentId);
    for (const item of items || []) {
      const back = int(item.sent_units) - int(item.received_units);
      if (back <= 0) continue;
      await s.ctx.supabase.from("inventory_movements").insert({
        account_id: s.ctx.accountId,
        sku_mapping_id: item.sku_mapping_id,
        movement_date: todayIsoUtc(),
        movement_type: "adjustment",
        units_delta: back,
        location: "warehouse",
        reference_type: "fba_shipment",
        reference_id: shipmentId,
        notes: "Shipment cancelled — units returned to warehouse",
        created_by: s.ctx.userId,
      });
    }
  }
  const { error } = await s.ctx.supabase
    .from("fba_shipments")
    .update({ status: "cancelled", updated_at: new Date().toISOString() })
    .eq("id", shipmentId);
  if (error) return fail(error);
  revalidateInventory();
  return { ok: true };
}

export async function deleteFbaShipment(accountId: string, shipmentId: string): Promise<ActionResult> {
  const s = await staff(accountId);
  if (!s.ok) return s;
  const { data: sh } = await s.ctx.supabase.from("fba_shipments").select("id, status").eq("id", shipmentId).eq("account_id", s.ctx.accountId).maybeSingle();
  if (!sh) return { ok: false, error: "Shipment not found." };
  if (sh.status !== "draft" && sh.status !== "cancelled") return { ok: false, error: "Only draft or cancelled shipments can be deleted." };
  const { error } = await s.ctx.supabase.from("fba_shipments").delete().eq("id", shipmentId);
  if (error) return fail(error);
  revalidateInventory();
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Daily sales (FBM / Temu / TikTok dispatch log)
// ---------------------------------------------------------------------------

export type DailySaleInput = {
  id?: string | null;
  mappingId: string;
  saleDate: string;
  platform: "amazon" | "temu" | "tiktok";
  channel?: "fba" | "fbm" | null;
  warehouseId?: string | null;
  soldUnits: number;
  returnsUnits: number;
  collectedUnits: number;
  notes?: string | null;
};

export async function saveDailySales(accountId: string, rows: DailySaleInput[]): Promise<ActionResult<{ saved: number }>> {
  const s = await staff(accountId);
  if (!s.ok) return s;
  let saved = 0;
  for (const r of rows) {
    if (!r.mappingId || !isoDate(r.saleDate)) continue;
    const platform = ["amazon", "temu", "tiktok"].includes(r.platform) ? r.platform : "amazon";
    const channel = platform === "amazon" ? (r.channel === "fba" ? "fba" : "fbm") : null;
    const payload = {
      account_id: s.ctx.accountId,
      sku_mapping_id: r.mappingId,
      sale_date: r.saleDate,
      platform,
      channel,
      warehouse_id: channel === "fba" ? null : str(r.warehouseId),
      sold_units: Math.max(0, int(r.soldUnits)),
      returns_units: Math.max(0, int(r.returnsUnits)),
      collected_units: Math.max(0, int(r.collectedUnits)),
      notes: str(r.notes),
      updated_at: new Date().toISOString(),
    };
    const { error } = r.id
      ? await s.ctx.supabase.from("inventory_daily_sales").update(payload).eq("id", r.id).eq("account_id", s.ctx.accountId)
      : await s.ctx.supabase.from("inventory_daily_sales").insert({ ...payload, source: "manual", created_by: s.ctx.userId });
    if (error) return fail(error);
    saved += 1;
  }
  revalidateInventory();
  return { ok: true, data: { saved } };
}

export async function deleteDailySale(accountId: string, id: string): Promise<ActionResult> {
  const s = await staff(accountId);
  if (!s.ok) return s;
  const { error } = await s.ctx.supabase.from("inventory_daily_sales").delete().eq("id", id).eq("account_id", s.ctx.accountId);
  if (error) return fail(error);
  revalidateInventory();
  return { ok: true };
}

export async function bulkSetDailySalesWarehouse(accountId: string, ids: string[], warehouseId: string | null): Promise<ActionResult<{ updated: number }>> {
  const s = await staff(accountId);
  if (!s.ok) return s;
  if (ids.length === 0) return { ok: true, data: { updated: 0 } };
  const { data, error } = await s.ctx.supabase
    .from("inventory_daily_sales")
    .update({ warehouse_id: str(warehouseId), updated_at: new Date().toISOString() })
    .eq("account_id", s.ctx.accountId)
    .in("id", ids)
    .select("id");
  if (error) return fail(error);
  revalidateInventory();
  return { ok: true, data: { updated: (data || []).length } };
}

// ---------------------------------------------------------------------------
// Amazon refresh
// ---------------------------------------------------------------------------

export async function refreshFbaStock(accountId: string): Promise<ActionResult<{ skus: number } | { roleMissing: boolean }>> {
  const s = await staff(accountId);
  if (!s.ok) return s;
  const result = await syncFbaInventory({ supabase: s.ctx.supabase, accountId: s.ctx.accountId });
  revalidateInventory();
  if (result.ok) return { ok: true, data: { skus: result.skus } };
  return { ok: false, error: result.error };
}

export async function resyncDailySalesFromAmazon(accountId: string, range?: { from?: string; to?: string }): Promise<ActionResult> {
  const s = await staff(accountId);
  if (!s.ok) return s;
  const { error } = await s.ctx.supabase.rpc("sync_amazon_daily_sales_from_facts", {
    p_account_id: s.ctx.accountId,
    p_from: isoDate(range?.from),
    p_to: isoDate(range?.to),
  });
  if (error) return fail(error);
  revalidateInventory();
  return { ok: true };
}
