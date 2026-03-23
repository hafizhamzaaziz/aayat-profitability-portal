type Platform = "amazon" | "temu";

const expectedBreakdownLabels: Record<Platform, string[]> = {
  amazon: [
    "Product Sales",
    "Refunds on Sales",
    "Adjustments & Credits",
    "Selling Fees",
    "FBA Fees",
    "FBA Inventory Fee",
    "Other Transaction Fees",
    "Delivery Services",
    "Service Fees",
  ],
  temu: [
    "Order Payments",
    "Return Shipping Credit",
    "Refunds",
    "Service Fees",
    "Shipping Labels & Adjustments",
    "Chargebacks",
    "Penalties",
    "Seller Repayment",
  ],
};

export function validatePeriodRange(periodStart: string, periodEnd: string) {
  if (!periodStart || !periodEnd) return "Period start and end are required.";
  if (periodStart > periodEnd) return "Period start cannot be after period end.";
  return null;
}

export function validateBreakdown(platform: Platform, breakdown: unknown) {
  if (!breakdown || typeof breakdown !== "object") return "Breakdown is missing.";
  const summaryLines = (breakdown as { summaryLines?: Array<{ label?: string }> }).summaryLines;
  if (!Array.isArray(summaryLines)) return "Breakdown summary lines are invalid.";
  const labels = new Set(summaryLines.map((line) => String(line.label || "")));
  const missing = expectedBreakdownLabels[platform].filter((label) => !labels.has(label));
  if (missing.length > 0) return `Breakdown is incomplete. Missing: ${missing.join(", ")}`;
  return null;
}

export function deriveReportWarnings(input: {
  missingSkus: string[];
  netProfit: number;
  outputVat: number;
  inputVat: number;
}) {
  const warnings: string[] = [];
  if (input.missingSkus.length > 0) warnings.push(`${input.missingSkus.length} SKU(s) have no COGS mapping.`);
  if (Math.abs(input.netProfit) > 1000000) warnings.push("Net profit is unusually large. Please verify source file.");
  if (Math.abs(input.outputVat - input.inputVat) > 500000) warnings.push("VAT payable/reclaim value is unusually high.");
  return warnings;
}
