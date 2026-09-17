import { addDays, minIsoDate, monthEndIso, monthStartIso } from "@/lib/utils/date";

export type FinanceWindow = {
  from: string;
  to: string;
};

/**
 * Next calendar-month window to ingest for an account.
 *
 * `through` is the last day we successfully ingested (inclusive). We never
 * rewind a completed past month (that caused empty-month report stubs when a
 * short window replaced a whole month). Historical catch-up walks one month
 * at a time; once we reach the current month we refresh month-start → today.
 */
export function nextFinanceWindow(input: {
  through: string | null;
  today: string;
  lookbackDays?: number;
}): FinanceWindow | null {
  const today = input.today;
  const lookbackDays = input.lookbackDays ?? 90;

  if (!input.through) {
    const start = monthStartIso(addDays(today, -lookbackDays));
    return { from: start, to: minIsoDate(monthEndIso(start), today) };
  }

  if (input.through >= today) {
    const start = monthStartIso(today);
    return { from: start, to: today };
  }

  const nextDay = addDays(input.through, 1);
  const start = monthStartIso(nextDay);
  return { from: start, to: minIsoDate(monthEndIso(start), today) };
}

/**
 * Expand an operator-picked range to full calendar months so ingestMonth can
 * replace a month atomically (P&L + txs stay consistent). `to` is capped at
 * today so Amazon is never asked for a postedBefore in the future.
 */
export function expandToCoveredMonths(from: string, to: string, today: string): FinanceWindow {
  const start = monthStartIso(from);
  const end = minIsoDate(monthEndIso(to), today);
  if (start > end) return { from: start, to: start };
  return { from: start, to: end };
}

export function clipReplaceRange(input: {
  bucketStart: string;
  bucketEnd: string;
  windowFrom: string;
  windowTo: string;
}): { replaceFrom: string; replaceTo: string; replaceEntireReport: boolean } {
  const replaceFrom = input.windowFrom > input.bucketStart ? input.windowFrom : input.bucketStart;
  const replaceTo = input.windowTo < input.bucketEnd ? input.windowTo : input.bucketEnd;
  const replaceEntireReport = replaceFrom <= input.bucketStart && replaceTo >= input.bucketEnd;
  return { replaceFrom, replaceTo, replaceEntireReport };
}
