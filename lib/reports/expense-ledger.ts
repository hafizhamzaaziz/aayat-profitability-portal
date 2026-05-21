export type ExpenseMarketplace = "amazon" | "temu" | "tiktok";
export type ExpenseType = "one_time" | "recurring";

export type ExpenseLedgerRow = {
  id: string;
  account_id: string;
  description: string;
  amount: number;
  includes_vat: boolean;
  expense_date: string;
  recurring_end_date: string | null;
  marketplace: string;
  expense_type: string;
};

export type ExpenseOccurrence = {
  expense_id: string;
  description: string;
  amount: number;
  includes_vat: boolean;
  marketplace: ExpenseMarketplace;
  expense_type: ExpenseType;
  occurrence_date: string;
};

const MARKETPLACES_BY_PLATFORM: Record<string, ExpenseMarketplace[]> = {
  amazon: ["amazon"],
  temu: ["temu"],
  tiktok: ["tiktok"],
};

function toIso(input: string) {
  return String(input || "").slice(0, 10);
}

function inRange(day: string, start: string, end: string) {
  return day >= start && day <= end;
}

function addMonthsIso(iso: string, months: number) {
  const [y, m, d] = iso.split("-").map(Number);
  const date = new Date(Date.UTC(y, (m || 1) - 1 + months, d || 1));
  return date.toISOString().slice(0, 10);
}

function normalizeMarketplace(input: string): ExpenseMarketplace {
  const val = String(input || "").trim().toLowerCase();
  if (val === "amazon" || val === "temu" || val === "tiktok") return val;
  return "amazon";
}

function normalizeType(input: string): ExpenseType {
  return String(input || "").trim().toLowerCase() === "recurring" ? "recurring" : "one_time";
}

export function computeExpenseOccurrencesForPeriod(input: {
  rows: ExpenseLedgerRow[];
  platform: string;
  periodStart: string;
  periodEnd: string;
}): ExpenseOccurrence[] {
  const periodStart = toIso(input.periodStart);
  const periodEnd = toIso(input.periodEnd);
  const supported = MARKETPLACES_BY_PLATFORM[String(input.platform || "").toLowerCase()] || [];
  if (supported.length === 0) return [];

  const out: ExpenseOccurrence[] = [];
  for (const raw of input.rows) {
    const marketplace = normalizeMarketplace(raw.marketplace);
    if (!supported.includes(marketplace)) continue;
    const expenseType = normalizeType(raw.expense_type);
    const startDate = toIso(raw.expense_date);
    const endDate = raw.recurring_end_date ? toIso(raw.recurring_end_date) : null;
    const amount = Number(raw.amount || 0);
    if (!startDate || !Number.isFinite(amount) || amount === 0) continue;

    if (expenseType === "one_time") {
      if (!inRange(startDate, periodStart, periodEnd)) continue;
      out.push({
        expense_id: raw.id,
        description: String(raw.description || ""),
        amount,
        includes_vat: Boolean(raw.includes_vat),
        marketplace,
        expense_type: "one_time",
        occurrence_date: startDate,
      });
      continue;
    }

    // Monthly recurrence. Emit one occurrence per month based on start day.
    let monthOffset = 0;
    while (monthOffset < 2400) {
      const occ = addMonthsIso(startDate, monthOffset);
      if (occ > periodEnd) break;
      if (endDate && occ > endDate) break;
      if (occ >= periodStart) {
        out.push({
          expense_id: raw.id,
          description: String(raw.description || ""),
          amount,
          includes_vat: Boolean(raw.includes_vat),
          marketplace,
          expense_type: "recurring",
          occurrence_date: occ,
        });
      }
      monthOffset += 1;
    }
  }

  out.sort((a, b) => a.occurrence_date.localeCompare(b.occurrence_date));
  return out;
}
