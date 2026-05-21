import { formatUkDate } from "@/lib/utils/date";

export function formatMoney(value: number, currency: string) {
  const sign = value < 0 ? "-" : "";
  const abs = Math.abs(value);
  return `${sign}${currency}${abs.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function formatPercent(value: number) {
  return `${value.toFixed(2)}%`;
}

export function formatPeriodLabel(periodStart: string, periodEnd: string) {
  return `${formatUkDate(periodStart)} – ${formatUkDate(periodEnd)}`;
}

export function platformLabel(platform: string) {
  if (platform === "amazon") return "Amazon";
  if (platform === "temu") return "Temu";
  if (platform === "all") return "All platforms";
  return platform.charAt(0).toUpperCase() + platform.slice(1);
}
