function toUtcDateFromIso(value: string) {
  const match = String(value).trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (!year || month < 1 || month > 12 || day < 1 || day > 31) return null;
  return new Date(Date.UTC(year, month - 1, day));
}

function utcDateToIso(dt: Date) {
  const y = dt.getUTCFullYear();
  const m = String(dt.getUTCMonth() + 1).padStart(2, "0");
  const d = String(dt.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export function todayIsoUtc() {
  return utcDateToIso(new Date());
}

export function currentMondayIsoUtc() {
  const now = new Date();
  const day = now.getUTCDay();
  const shift = day === 0 ? -6 : 1 - day;
  const dt = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  dt.setUTCDate(dt.getUTCDate() + shift);
  return utcDateToIso(dt);
}

export function lastCompletedWeekMondayIsoUtc() {
  return addDays(currentMondayIsoUtc(), -7);
}

export function isTodayMondayUtc() {
  return todayIsoUtc() === currentMondayIsoUtc();
}

export function formatUkDate(value: string) {
  if (!value) return "-";
  const dt = toUtcDateFromIso(value);
  if (!dt) return value;
  return new Intl.DateTimeFormat("en-GB", { timeZone: "UTC" }).format(dt);
}

export function isMonday(value: string) {
  if (!value) return false;
  const dt = toUtcDateFromIso(value);
  if (!dt) return false;
  return dt.getUTCDay() === 1;
}

export function addDays(value: string, days: number) {
  const dt = toUtcDateFromIso(value);
  if (!dt) return value;
  dt.setUTCDate(dt.getUTCDate() + days);
  return utcDateToIso(dt);
}
