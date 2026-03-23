export function formatUkDate(value: string) {
  if (!value) return "-";
  const dt = new Date(`${value}T00:00:00`);
  if (Number.isNaN(dt.getTime())) return value;
  return new Intl.DateTimeFormat("en-GB").format(dt);
}

export function isMonday(value: string) {
  if (!value) return false;
  const dt = new Date(`${value}T00:00:00`);
  if (Number.isNaN(dt.getTime())) return false;
  return dt.getDay() === 1;
}

export function addDays(value: string, days: number) {
  const dt = new Date(`${value}T00:00:00`);
  dt.setDate(dt.getDate() + days);
  return dt.toISOString().slice(0, 10);
}
