import { addDays } from "@/lib/utils/date";

export type InventoryDefaults = {
  leadTimeDays: number;
  amazonCoverDays: number;
  warehouseCoverDays: number;
  storageCostPerPallet: number;
  storageCostPeriod: "week" | "month";
};

export type SkuRef = {
  mappingId: string;
  productName: string;
  amazonSku: string | null;
  temuSkuId: string | null;
  leadTimeDays: number | null;
};

export type MonthlySalesRow = {
  mappingId: string;
  monthStart: string;
  amazonUnits: number;
  temuUnits: number;
};

export type InventoryLevelRow = {
  mappingId: string;
  levelDate: string;
  amazonUnits: number;
  warehouseUnits: number;
};

export type CogsRow = {
  amazonSku: string | null;
  temuSkuId: string | null;
  unitCost: number;
};

export type PackProfile = {
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

export type InventoryComputedRow = {
  mappingId: string;
  productName: string;
  amazonSku: string | null;
  temuSkuId: string | null;
  prevMonthAmazonUnits: number;
  prevMonthTemuUnits: number;
  yearTotalUnits: number;
  yearAvgPerMonth: number;
  amazonUnitsOnHand: number;
  warehouseUnitsOnHand: number;
  dailyVelocity: number;
  amazonDaysLeft: number | null;
  warehouseDaysLeft: number | null;
  stockValue: number;
  potentialSalesValue: number;
  potentialProfitValue: number;
  suggestedAmazonUnits: number;
  suggestedWarehouseUnits: number;
};

const PALLET_LENGTH_MM = 1200;
const PALLET_WIDTH_MM = 1000;
const MAX_TOTAL_HEIGHT_MM = 1800;
const PALLET_HEIGHT_MM = 144;
const MAX_STACK_HEIGHT_MM = MAX_TOTAL_HEIGHT_MM - PALLET_HEIGHT_MM;

function round2(value: number) {
  return Number(value.toFixed(2));
}

function toMm(value: number, unit: PackProfile["dimensionUnit"]) {
  if (unit === "mm") return value;
  if (unit === "cm") return value * 10;
  return value * 25.4;
}

export function palletEstimate(profile: PackProfile, plannedUnits: number) {
  const unitsPerBox = Math.max(1, Number(profile.unitsPerBox || 1));
  const plannedBoxes = Math.ceil(Math.max(0, plannedUnits) / unitsPerBox);
  const lengthMm = toMm(Number(profile.boxLength || 0), profile.dimensionUnit);
  const widthMm = toMm(Number(profile.boxWidth || 0), profile.dimensionUnit);
  const heightMm = toMm(Number(profile.boxHeight || 0), profile.dimensionUnit);

  if (lengthMm <= 0 || widthMm <= 0 || heightMm <= 0) {
    return {
      plannedBoxes,
      boxesPerPallet: 0,
      pallets: 0,
      unitsPerBox,
    };
  }

  const boxesPerLayerA = Math.floor(PALLET_LENGTH_MM / lengthMm) * Math.floor(PALLET_WIDTH_MM / widthMm);
  const boxesPerLayerB = Math.floor(PALLET_LENGTH_MM / widthMm) * Math.floor(PALLET_WIDTH_MM / lengthMm);
  const boxesPerLayer = Math.max(0, boxesPerLayerA, boxesPerLayerB);
  const layers = Math.max(0, Math.floor(MAX_STACK_HEIGHT_MM / heightMm));
  const boxesPerPallet = boxesPerLayer * layers;
  const pallets = boxesPerPallet > 0 ? round2(plannedBoxes / boxesPerPallet) : 0;

  return {
    plannedBoxes,
    boxesPerPallet,
    pallets,
    unitsPerBox,
  };
}

export function buildInventoryRows(input: {
  mappings: SkuRef[];
  monthlySales: MonthlySalesRow[];
  levels: InventoryLevelRow[];
  cogs: CogsRow[];
  defaults: InventoryDefaults;
  nowIso: string;
}) {
  const nowYear = Number(input.nowIso.slice(0, 4));
  const currentMonthStart = `${input.nowIso.slice(0, 7)}-01`;
  const prevMonthStart = addDays(currentMonthStart, -1).slice(0, 7) + "-01";

  const salesByMapping = new Map<string, MonthlySalesRow[]>();
  input.monthlySales.forEach((row) => {
    const list = salesByMapping.get(row.mappingId) || [];
    list.push(row);
    salesByMapping.set(row.mappingId, list);
  });

  const latestLevelByMapping = new Map<string, InventoryLevelRow>();
  input.levels.forEach((row) => {
    const current = latestLevelByMapping.get(row.mappingId);
    if (!current || current.levelDate < row.levelDate) latestLevelByMapping.set(row.mappingId, row);
  });

  const cogsBySku = new Map<string, number>();
  input.cogs.forEach((row) => {
    if (row.amazonSku) cogsBySku.set(`A:${row.amazonSku.trim().toUpperCase()}`, Number(row.unitCost || 0));
    if (row.temuSkuId) cogsBySku.set(`T:${row.temuSkuId.trim().toUpperCase()}`, Number(row.unitCost || 0));
  });

  const rows: InventoryComputedRow[] = input.mappings.map((mapping) => {
    const salesRows = salesByMapping.get(mapping.mappingId) || [];
    const currentYearRows = salesRows.filter((row) => Number(row.monthStart.slice(0, 4)) === nowYear);
    const prevMonth = salesRows.find((row) => row.monthStart === prevMonthStart);
    const yearTotal = currentYearRows.reduce((acc, row) => acc + Number(row.amazonUnits || 0) + Number(row.temuUnits || 0), 0);

    const monthsCount = Math.max(
      1,
      new Set(currentYearRows.map((row) => row.monthStart)).size
    );
    const yearAvgPerMonth = yearTotal / monthsCount;
    const dailyVelocity = yearAvgPerMonth / 30;

    const level = latestLevelByMapping.get(mapping.mappingId);
    const amazonUnitsOnHand = Number(level?.amazonUnits || 0);
    const warehouseUnitsOnHand = Number(level?.warehouseUnits || 0);
    const amazonDaysLeft = dailyVelocity > 0 ? round2(amazonUnitsOnHand / dailyVelocity) : null;
    const warehouseDaysLeft = dailyVelocity > 0 ? round2(warehouseUnitsOnHand / dailyVelocity) : null;

    const unitCost =
      cogsBySku.get(`A:${String(mapping.amazonSku || "").trim().toUpperCase()}`) ??
      cogsBySku.get(`T:${String(mapping.temuSkuId || "").trim().toUpperCase()}`) ??
      0;
    const totalUnitsOnHand = amazonUnitsOnHand + warehouseUnitsOnHand;
    const stockValue = round2(totalUnitsOnHand * unitCost);

    const targetNetMarginRate = 0.18;
    const potentialSalesValue = stockValue > 0 ? round2(stockValue / (1 - targetNetMarginRate)) : 0;
    const potentialProfitValue = round2(Math.max(0, potentialSalesValue - stockValue));

    const suggestedAmazonUnits = Math.max(0, Math.ceil(dailyVelocity * input.defaults.amazonCoverDays - amazonUnitsOnHand));
    const leadTimeDays = mapping.leadTimeDays ?? input.defaults.leadTimeDays;
    const neededWarehouseCoverage = input.defaults.warehouseCoverDays + leadTimeDays;
    const suggestedWarehouseUnits = Math.max(
      0,
      Math.ceil(dailyVelocity * neededWarehouseCoverage - warehouseUnitsOnHand)
    );

    return {
      mappingId: mapping.mappingId,
      productName: mapping.productName,
      amazonSku: mapping.amazonSku,
      temuSkuId: mapping.temuSkuId,
      prevMonthAmazonUnits: Number(prevMonth?.amazonUnits || 0),
      prevMonthTemuUnits: Number(prevMonth?.temuUnits || 0),
      yearTotalUnits: round2(yearTotal),
      yearAvgPerMonth: round2(yearAvgPerMonth),
      amazonUnitsOnHand,
      warehouseUnitsOnHand,
      dailyVelocity: round2(dailyVelocity),
      amazonDaysLeft,
      warehouseDaysLeft,
      stockValue,
      potentialSalesValue,
      potentialProfitValue,
      suggestedAmazonUnits,
      suggestedWarehouseUnits,
    };
  });

  return rows.sort((a, b) => a.productName.localeCompare(b.productName));
}
