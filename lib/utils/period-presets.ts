import { addDays, todayIsoUtc } from "@/lib/utils/date";

export type PeriodPreset = "today" | "yesterday" | "mtd" | "this_month_forecast" | "last_month" | "custom";

export type ResolvedPeriod = {
  preset: PeriodPreset;
  from: string;
  to: string;
  /** Inclusive day count of the selected window. */
  days: number;
  /** For forecast: MTD window used as the pace base. */
  paceFrom?: string;
  paceTo?: string;
  forecastFactor?: number;
};

function utcParts(iso: string) {
  const [y, m, d] = iso.split("-").map(Number);
  return { y, m, d };
}

function pad(n: number) {
  return String(n).padStart(2, "0");
}

function monthStart(iso: string) {
  const { y, m } = utcParts(iso);
  return `${y}-${pad(m)}-01`;
}

function monthEnd(iso: string) {
  const { y, m } = utcParts(iso);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return `${y}-${pad(m)}-${pad(last)}`;
}

function daysInclusive(from: string, to: string) {
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b) || b < a) return 1;
  return Math.round((b - a) / 86400000) + 1;
}

export const PERIOD_PRESET_LABELS: Record<PeriodPreset, string> = {
  today: "Today",
  yesterday: "Yesterday",
  mtd: "Month to date",
  this_month_forecast: "This month (forecast)",
  last_month: "Last month",
  custom: "Custom",
};

export function parsePeriodPreset(value: string | null | undefined): PeriodPreset {
  if (
    value === "today" ||
    value === "yesterday" ||
    value === "mtd" ||
    value === "this_month_forecast" ||
    value === "last_month" ||
    value === "custom"
  ) {
    return value;
  }
  return "mtd";
}

/**
 * Resolve a dashboard / saved-reports period.
 * Forecast formula: MTD metric × (days in calendar month / current UTC day-of-month).
 */
export function resolvePeriod(input: {
  preset?: string | null;
  from?: string | null;
  to?: string | null;
  today?: string;
}): ResolvedPeriod {
  const today = input.today || todayIsoUtc();
  const preset = input.from && input.to && !input.preset ? "custom" : parsePeriodPreset(input.preset || null);

  if (preset === "today") {
    return { preset, from: today, to: today, days: 1 };
  }
  if (preset === "yesterday") {
    const y = addDays(today, -1);
    return { preset, from: y, to: y, days: 1 };
  }
  if (preset === "last_month") {
    const { y, m } = utcParts(today);
    const prev = m === 1 ? { y: y - 1, m: 12 } : { y, m: m - 1 };
    const from = `${prev.y}-${pad(prev.m)}-01`;
    return { preset, from, to: monthEnd(from), days: daysInclusive(from, monthEnd(from)) };
  }
  if (preset === "this_month_forecast") {
    const from = monthStart(today);
    const end = monthEnd(today);
    const { d } = utcParts(today);
    const monthDays = daysInclusive(from, end);
    return {
      preset,
      from,
      to: end,
      days: monthDays,
      paceFrom: from,
      paceTo: today,
      forecastFactor: monthDays / Math.max(1, d),
    };
  }
  if (preset === "custom") {
    const from = String(input.from || today).slice(0, 10);
    const to = String(input.to || from).slice(0, 10);
    const a = from <= to ? from : to;
    const b = from <= to ? to : from;
    return { preset, from: a, to: b, days: daysInclusive(a, b) };
  }

  const from = monthStart(today);
  return { preset: "mtd", from, to: today, days: daysInclusive(from, today) };
}

/** Prior window of equal length ending the day before `from`. */
export function priorPeriod(period: Pick<ResolvedPeriod, "from" | "to" | "days">): { from: string; to: string } {
  const to = addDays(period.from, -1);
  const from = addDays(to, -(period.days - 1));
  return { from, to };
}
