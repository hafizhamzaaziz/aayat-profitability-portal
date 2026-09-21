/**
 * When both a manual upload and an SP-API report exist for the same
 * (platform, period), Dashboard/KPI math must use one row — otherwise
 * sales and profit are counted twice.
 *
 * SP-API wins when present; otherwise the first remaining row is kept.
 */
export function preferCanonicalReports<
  T extends {
    platform: string;
    period_start: string;
    period_end: string;
    source?: string | null;
  },
>(rows: T[]): T[] {
  const rank = (source?: string | null) => (String(source || "").toLowerCase() === "sp_api" ? 2 : 1);
  const byKey = new Map<string, T>();
  for (const row of rows) {
    const key = `${String(row.platform).toLowerCase()}|${row.period_start}|${row.period_end}`;
    const existing = byKey.get(key);
    if (!existing || rank(row.source) > rank(existing.source)) byKey.set(key, row);
  }
  return Array.from(byKey.values());
}
