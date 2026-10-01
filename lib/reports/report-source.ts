/**
 * Manual CSV reports and Amazon API reports share an account, platform and
 * period. They are different rows (`reports.source`), and a save of one
 * origin must never replace the other.
 */

export type ReportOrigin = "manual" | "sp_api";

export function reportOrigin(source: string | null | undefined): ReportOrigin {
  return source === "sp_api" ? "sp_api" : "manual";
}

export function reportOriginLabel(source: string | null | undefined): "API" | "Manual" {
  return reportOrigin(source) === "sp_api" ? "API" : "Manual";
}

export type SavedPeriodRow = {
  id: string;
  period_start: string;
  period_end: string;
  source?: string | null;
};

export type ManualSaveDecision = {
  /** A same-origin report covers part of this range. The save must stop. */
  blockingOverlap: boolean;
  /** A same-origin report covers this exact period and may be replaced. */
  overwriteId: string | null;
  /** An Amazon API report already exists for this exact period and must be kept. */
  keepsApiSibling: boolean;
};

function day(value: string) {
  return String(value).slice(0, 10);
}

function rangesOverlap(start: string, end: string, otherStart: string, otherEnd: string) {
  const a = day(start);
  const b = day(end);
  const c = day(otherStart);
  const d = day(otherEnd);
  return a <= d && b >= c;
}

function samePeriod(start: string, end: string, otherStart: string, otherEnd: string) {
  return day(start) === day(otherStart) && day(end) === day(otherEnd);
}

/**
 * Decide what a manual save may replace.
 *
 * Amazon: only another manual report counts. An API report for the same
 * dates is a sibling, not a conflict.
 * Other platforms: every existing report counts, which is the previous
 * behaviour (those platforms are manual-only).
 */
export function decideManualSave(input: {
  platform: string;
  periodStart: string;
  periodEnd: string;
  existing: SavedPeriodRow[];
}): ManualSaveDecision {
  const amazon = input.platform === "amazon";
  const relevant = input.existing.filter((row) => (amazon ? reportOrigin(row.source) === "manual" : true));

  const exact = relevant.find((row) =>
    samePeriod(input.periodStart, input.periodEnd, String(row.period_start), String(row.period_end))
  );
  const blockingOverlap = relevant.some((row) => {
    const start = String(row.period_start);
    const end = String(row.period_end);
    return (
      rangesOverlap(input.periodStart, input.periodEnd, start, end) &&
      !samePeriod(input.periodStart, input.periodEnd, start, end)
    );
  });
  const keepsApiSibling =
    amazon &&
    input.existing.some(
      (row) =>
        reportOrigin(row.source) === "sp_api" &&
        samePeriod(input.periodStart, input.periodEnd, String(row.period_start), String(row.period_end))
    );

  return {
    blockingOverlap,
    overwriteId: exact?.id ?? null,
    keepsApiSibling,
  };
}

/**
 * Dashboard totals, charts and top SKUs. When an Amazon month has both an
 * API report and a manual report, count the API report only so the manual
 * upload stays a comparison copy and does not double the month.
 * Temu, TikTok and manual-only Amazon months are unchanged.
 */
export function officialReportsForTotals<
  T extends {
    platform: string;
    period_start: string;
    period_end: string;
    source?: string | null;
  },
>(rows: T[]): T[] {
  const apiPeriods = new Set<string>();
  for (const row of rows) {
    if (row.platform === "amazon" && reportOrigin(row.source) === "sp_api") {
      apiPeriods.add(`${row.period_start}|${row.period_end}`);
    }
  }
  return rows.filter((row) => {
    if (row.platform !== "amazon") return true;
    if (reportOrigin(row.source) === "sp_api") return true;
    return !apiPeriods.has(`${row.period_start}|${row.period_end}`);
  });
}
