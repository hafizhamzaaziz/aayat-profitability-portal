/**
 * Carton → pallet estimate for a UK standard pallet (1200 × 1000 mm, max
 * 1800 mm total height including the 144 mm pallet).
 */

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

const PALLET_LENGTH_MM = 1200;
const PALLET_WIDTH_MM = 1000;
const MAX_TOTAL_HEIGHT_MM = 1800;
const PALLET_HEIGHT_MM = 144;
const MAX_STACK_HEIGHT_MM = MAX_TOTAL_HEIGHT_MM - PALLET_HEIGHT_MM;

function round2(value: number) {
  return Math.round(value * 100) / 100;
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
    return { plannedBoxes, boxesPerPallet: 0, pallets: 0, unitsPerBox };
  }

  const boxesPerLayerA = Math.floor(PALLET_LENGTH_MM / lengthMm) * Math.floor(PALLET_WIDTH_MM / widthMm);
  const boxesPerLayerB = Math.floor(PALLET_LENGTH_MM / widthMm) * Math.floor(PALLET_WIDTH_MM / lengthMm);
  const boxesPerLayer = Math.max(0, boxesPerLayerA, boxesPerLayerB);
  const layers = Math.max(0, Math.floor(MAX_STACK_HEIGHT_MM / heightMm));
  const boxesPerPallet = boxesPerLayer * layers;
  const pallets = boxesPerPallet > 0 ? round2(plannedBoxes / boxesPerPallet) : 0;

  return { plannedBoxes, boxesPerPallet, pallets, unitsPerBox };
}
