/**
 * Inventory planner — pure math, no I/O.
 *
 * Supply chain modelled:
 *
 *   supplier ──(manufacturing + shipping)──▶ 3PL warehouse ──(transit + check-in)──▶ Amazon FBA
 *                                               │                                      │
 *                                 FBM + Temu + TikTok orders                       FBA orders
 *
 * Every number the UI shows comes from here so the planner table, the PO
 * suggestions and the FBA shipment suggestions always agree.
 */

import { addDays } from "@/lib/utils/date";

export type DemandChannel = "fba" | "fbm" | "temu" | "tiktok";
export const DEMAND_CHANNELS: DemandChannel[] = ["fba", "fbm", "temu", "tiktok"];

export type ChannelDemand = {
  units7: number;
  units30: number;
  units90: number;
  units365: number;
  firstSaleDate: string | null;
  lastSaleDate: string | null;
};

export type VelocityWeights = { d7: number; d30: number; d90: number };

export type PlannerSettings = {
  /** Target days of FBA stock after a shipment arrives (inventory_defaults.amazon_cover_days). */
  fbaCoverDays: number;
  /** Target days of total pipeline cover after a supplier order lands (warehouse_cover_days). */
  warehouseCoverDays: number;
  /** Fallback supplier lead time when neither SKU nor supplier has one. */
  defaultLeadTimeDays: number;
  fbaTransitDays: number;
  fbaCheckinDays: number;
  safetyDays: number;
  overstockDays: number;
  growthRatePct: number;
  velocityWeights: VelocityWeights;
};

export type PlannerSkuInput = {
  mappingId: string;
  demand: Partial<Record<DemandChannel, ChannelDemand>>;
  /** null = no stock take recorded yet. */
  fbaOnHand: number | null;
  fbaInTransit: number;
  fbaReserved: number;
  warehouseOnHand: number | null;
  /** Units on open purchase orders not yet received. */
  onOrder: number;
  /** Units reserved on draft FBA shipments (not yet shipped) — informational. */
  plannedToFba: number;
  unitCost: number;
  /** Supplier manufacturing + shipping, or the SKU override. */
  supplierLeadDays: number | null;
  moq: number | null;
  unitsPerBox: number | null;
  velocityOverride: number | null;
  isPlanned: boolean;
};

export type PlannerStatus =
  | "needs_count"
  | "out_of_stock"
  | "order_now"
  | "ship_to_fba"
  | "order_soon"
  | "overstock"
  | "healthy"
  | "no_sales";

export type PlannerRow = {
  mappingId: string;
  velocity: Record<DemandChannel, number>;
  fbaVelocity: number;
  directVelocity: number;
  totalVelocity: number;
  velocitySource: "override" | "blend" | "none";
  fbaOnHand: number | null;
  fbaInTransit: number;
  fbaReserved: number;
  warehouseOnHand: number | null;
  onOrder: number;
  plannedToFba: number;
  pipelineUnits: number;
  fbaDaysOfCover: number | null;
  warehouseDaysOfCover: number | null;
  totalDaysOfCover: number | null;
  fbaStockoutDate: string | null;
  totalStockoutDate: string | null;
  fbaLeadDays: number;
  supplierLeadDays: number;
  effectiveLeadDays: number;
  fbaReorderPoint: number;
  reorderPoint: number;
  daysUntilReorder: number | null;
  reorderDate: string | null;
  recommendedOrderUnits: number;
  recommendedOrderBoxes: number | null;
  recommendedFbaUnits: number;
  recommendedFbaBoxes: number | null;
  fbaLimitedByWarehouse: boolean;
  stockValue: number;
  status: PlannerStatus;
  reasons: string[];
};

export const DEFAULT_PLANNER_SETTINGS: PlannerSettings = {
  fbaCoverDays: 30,
  warehouseCoverDays: 120,
  defaultLeadTimeDays: 90,
  fbaTransitDays: 7,
  fbaCheckinDays: 5,
  safetyDays: 14,
  overstockDays: 180,
  growthRatePct: 0,
  velocityWeights: { d7: 0.2, d30: 0.5, d90: 0.3 },
};

function round(value: number, dp = 2) {
  const f = Math.pow(10, dp);
  return Math.round(value * f) / f;
}

function daysBetween(fromIso: string, toIso: string) {
  const a = new Date(`${fromIso}T00:00:00Z`).getTime();
  const b = new Date(`${toIso}T00:00:00Z`).getTime();
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 0;
  return Math.round((b - a) / 86400000);
}

/**
 * Blend 7 / 30 / 90-day averages. A SKU younger than the window only counts
 * the days it has existed, so a product launched 12 days ago is not diluted
 * by 78 empty days.
 */
export function blendedVelocity(demand: ChannelDemand | undefined, weights: VelocityWeights, todayIso: string): number {
  if (!demand) return 0;
  const age = demand.firstSaleDate ? Math.max(1, daysBetween(demand.firstSaleDate, todayIso)) : 90;
  const windows: Array<{ units: number; days: number; weight: number }> = [
    { units: demand.units7, days: Math.min(7, age), weight: weights.d7 },
    { units: demand.units30, days: Math.min(30, age), weight: weights.d30 },
    { units: demand.units90, days: Math.min(90, age), weight: weights.d90 },
  ];
  let weightSum = 0;
  let value = 0;
  for (const w of windows) {
    if (w.weight <= 0 || w.days <= 0) continue;
    weightSum += w.weight;
    value += w.weight * (w.units / w.days);
  }
  if (weightSum <= 0) return 0;
  return value / weightSum;
}

function roundUpToMultiple(units: number, multiple: number | null) {
  if (units <= 0) return 0;
  if (!multiple || multiple <= 1) return Math.ceil(units);
  return Math.ceil(units / multiple) * multiple;
}

export function planSku(input: PlannerSkuInput, settings: PlannerSettings, todayIso: string): PlannerRow {
  const reasons: string[] = [];
  const velocity: Record<DemandChannel, number> = { fba: 0, fbm: 0, temu: 0, tiktok: 0 };
  for (const ch of DEMAND_CHANNELS) {
    velocity[ch] = blendedVelocity(input.demand[ch], settings.velocityWeights, todayIso);
  }
  let fbaVelocity = velocity.fba;
  let directVelocity = velocity.fbm + velocity.temu + velocity.tiktok;
  let totalVelocity = fbaVelocity + directVelocity;
  let velocitySource: PlannerRow["velocitySource"] = totalVelocity > 0 ? "blend" : "none";

  if (input.velocityOverride != null && input.velocityOverride > 0) {
    // Keep the observed channel mix, scale to the override.
    const share = totalVelocity > 0 ? fbaVelocity / totalVelocity : 0;
    totalVelocity = input.velocityOverride;
    fbaVelocity = totalVelocity * share;
    directVelocity = totalVelocity - fbaVelocity;
    velocitySource = "override";
    reasons.push(`Velocity fixed at ${round(input.velocityOverride, 2)}/day (manual override).`);
  }

  const fbaLeadDays = settings.fbaTransitDays + settings.fbaCheckinDays;
  const supplierLeadDays = input.supplierLeadDays ?? settings.defaultLeadTimeDays;
  const fbaShare = totalVelocity > 0 ? fbaVelocity / totalVelocity : 0;
  const effectiveLeadDays = supplierLeadDays + settings.safetyDays + fbaLeadDays * fbaShare;

  const fbaOnHand = input.fbaOnHand;
  const warehouseOnHand = input.warehouseOnHand;
  const fbaAvailable = (fbaOnHand ?? 0) + input.fbaInTransit;
  const pipelineUnits = (fbaOnHand ?? 0) + input.fbaInTransit + (warehouseOnHand ?? 0) + input.onOrder;

  const fbaDaysOfCover = fbaVelocity > 0 ? round(fbaAvailable / fbaVelocity, 1) : null;
  const warehouseDaysOfCover =
    directVelocity > 0 && warehouseOnHand != null ? round(warehouseOnHand / directVelocity, 1) : null;
  const totalDaysOfCover = totalVelocity > 0 ? round(pipelineUnits / totalVelocity, 1) : null;

  const fbaStockoutDate = fbaDaysOfCover != null ? addDays(todayIso, Math.floor(fbaDaysOfCover)) : null;
  const totalStockoutDate = totalDaysOfCover != null ? addDays(todayIso, Math.floor(totalDaysOfCover)) : null;

  // Growth tilts the planning velocity forward over the horizon it must cover.
  const horizonDays = effectiveLeadDays + settings.warehouseCoverDays;
  const growthFactor = 1 + (settings.growthRatePct / 100) * (horizonDays / 365);
  const planningVelocity = totalVelocity * Math.max(0, growthFactor);

  const fbaReorderPoint = Math.ceil(fbaVelocity * (fbaLeadDays + settings.safetyDays));
  const reorderPoint = Math.ceil(planningVelocity * effectiveLeadDays);

  const daysUntilReorder =
    planningVelocity > 0 ? round((pipelineUnits - reorderPoint) / planningVelocity, 0) : null;
  const reorderDate = daysUntilReorder != null ? addDays(todayIso, Math.max(0, daysUntilReorder)) : null;

  // Supplier order: bring the whole pipeline up to lead time + target cover.
  const targetPipeline = planningVelocity * (effectiveLeadDays + settings.warehouseCoverDays);
  let recommendedOrderUnits = 0;
  if (planningVelocity > 0 && daysUntilReorder != null && daysUntilReorder <= 14) {
    recommendedOrderUnits = Math.max(0, Math.ceil(targetPipeline - pipelineUnits));
    if (input.moq && recommendedOrderUnits > 0 && recommendedOrderUnits < input.moq) {
      recommendedOrderUnits = input.moq;
      reasons.push(`Rounded up to supplier MOQ (${input.moq}).`);
    }
    recommendedOrderUnits = roundUpToMultiple(recommendedOrderUnits, input.unitsPerBox);
  }
  const recommendedOrderBoxes =
    input.unitsPerBox && input.unitsPerBox > 0 && recommendedOrderUnits > 0
      ? Math.ceil(recommendedOrderUnits / input.unitsPerBox)
      : null;

  // FBA shipment: bring FBA (on hand + in transit) up to lead + target cover,
  // limited by what the warehouse actually holds.
  const fbaTarget = fbaVelocity * (fbaLeadDays + settings.fbaCoverDays);
  let recommendedFbaUnits = fbaVelocity > 0 ? Math.max(0, Math.ceil(fbaTarget - fbaAvailable)) : 0;
  let fbaLimitedByWarehouse = false;
  if (recommendedFbaUnits > 0 && warehouseOnHand != null) {
    const available = Math.max(0, warehouseOnHand - input.plannedToFba);
    if (recommendedFbaUnits > available) {
      recommendedFbaUnits = available;
      fbaLimitedByWarehouse = true;
      reasons.push("FBA shipment limited by warehouse stock.");
    }
  }
  recommendedFbaUnits = roundUpToMultiple(recommendedFbaUnits, input.unitsPerBox);
  if (fbaLimitedByWarehouse && warehouseOnHand != null && recommendedFbaUnits > warehouseOnHand) {
    // rounding to cartons cannot exceed what is physically there
    recommendedFbaUnits = input.unitsPerBox
      ? Math.floor(warehouseOnHand / input.unitsPerBox) * input.unitsPerBox
      : warehouseOnHand;
  }
  const recommendedFbaBoxes =
    input.unitsPerBox && input.unitsPerBox > 0 && recommendedFbaUnits > 0
      ? Math.ceil(recommendedFbaUnits / input.unitsPerBox)
      : null;

  const stockValue = round(((fbaOnHand ?? 0) + input.fbaInTransit + (warehouseOnHand ?? 0)) * (input.unitCost || 0), 2);

  // Status, most urgent first.
  let status: PlannerStatus;
  if (!input.isPlanned) {
    status = "healthy";
    reasons.push("Excluded from planning.");
  } else if (totalVelocity <= 0) {
    status = "no_sales";
    reasons.push("No sales in the last 90 days.");
  } else if (fbaOnHand == null && warehouseOnHand == null) {
    status = "needs_count";
    reasons.push("No stock take recorded — enter FBA and warehouse counts.");
  } else if ((fbaVelocity > 0 && fbaAvailable <= 0) || (directVelocity > 0 && (warehouseOnHand ?? 0) <= 0)) {
    status = "out_of_stock";
    if (fbaVelocity > 0 && fbaAvailable <= 0) reasons.push("FBA has no stock and still sells.");
    if (directVelocity > 0 && (warehouseOnHand ?? 0) <= 0) reasons.push("Warehouse is empty while FBM/Temu/TikTok still sell.");
  } else if (daysUntilReorder != null && daysUntilReorder <= 0 && recommendedOrderUnits > 0) {
    status = "order_now";
    reasons.push(`Pipeline (${pipelineUnits}) is at or below the reorder point (${reorderPoint}).`);
  } else if (fbaVelocity > 0 && fbaAvailable <= fbaReorderPoint && recommendedFbaUnits > 0) {
    status = "ship_to_fba";
    reasons.push(`FBA cover ${fbaDaysOfCover ?? 0}d is inside transit + check-in + safety (${fbaLeadDays + settings.safetyDays}d).`);
  } else if (daysUntilReorder != null && daysUntilReorder <= 14 && recommendedOrderUnits > 0) {
    status = "order_soon";
    reasons.push(`Reorder point reached in ${daysUntilReorder} days.`);
  } else if (totalDaysOfCover != null && totalDaysOfCover > settings.overstockDays) {
    status = "overstock";
    reasons.push(`${totalDaysOfCover} days of cover exceeds ${settings.overstockDays}d (aged-stock risk).`);
  } else {
    status = "healthy";
  }

  return {
    mappingId: input.mappingId,
    velocity: {
      fba: round(velocity.fba, 3),
      fbm: round(velocity.fbm, 3),
      temu: round(velocity.temu, 3),
      tiktok: round(velocity.tiktok, 3),
    },
    fbaVelocity: round(fbaVelocity, 3),
    directVelocity: round(directVelocity, 3),
    totalVelocity: round(totalVelocity, 3),
    velocitySource,
    fbaOnHand,
    fbaInTransit: input.fbaInTransit,
    fbaReserved: input.fbaReserved,
    warehouseOnHand,
    onOrder: input.onOrder,
    plannedToFba: input.plannedToFba,
    pipelineUnits,
    fbaDaysOfCover,
    warehouseDaysOfCover,
    totalDaysOfCover,
    fbaStockoutDate,
    totalStockoutDate,
    fbaLeadDays,
    supplierLeadDays,
    effectiveLeadDays: round(effectiveLeadDays, 0),
    fbaReorderPoint,
    reorderPoint,
    daysUntilReorder,
    reorderDate,
    recommendedOrderUnits,
    recommendedOrderBoxes,
    recommendedFbaUnits,
    recommendedFbaBoxes,
    fbaLimitedByWarehouse,
    stockValue,
    status,
    reasons,
  };
}

export const STATUS_ORDER: PlannerStatus[] = [
  "out_of_stock",
  "order_now",
  "ship_to_fba",
  "order_soon",
  "needs_count",
  "overstock",
  "healthy",
  "no_sales",
];

export const STATUS_LABEL: Record<PlannerStatus, string> = {
  needs_count: "Needs stock count",
  out_of_stock: "Out of stock",
  order_now: "Order from supplier now",
  ship_to_fba: "Ship to FBA",
  order_soon: "Order soon",
  overstock: "Overstocked",
  healthy: "Healthy",
  no_sales: "No recent sales",
};
