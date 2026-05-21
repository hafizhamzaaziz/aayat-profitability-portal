import type { SupabaseClient } from "@supabase/supabase-js";

export async function migrateLegacyExpensesForAccount(
  supabase: SupabaseClient,
  accountId: string
): Promise<number> {
  const { data: reports } = await supabase
    .from("reports")
    .select("id, period_start, platform")
    .eq("account_id", accountId);
  const reportRows = (reports || []) as Array<{ id: string; period_start: string; platform: string }>;
  if (reportRows.length === 0) return 0;

  const reportIds = reportRows.map((r) => r.id);
  const byId = new Map(reportRows.map((r) => [r.id, r]));
  const { data: legacyRows } = await supabase
    .from("expenses")
    .select("id, report_id, description, amount, includes_vat")
    .in("report_id", reportIds);

  const payload = ((legacyRows || []) as Array<{
    id: string;
    report_id: string;
    description: string;
    amount: number;
    includes_vat: boolean;
  }>)
    .map((row) => {
      const report = byId.get(String(row.report_id || ""));
      if (!report) return null;
      return {
        account_id: accountId,
        description: String(row.description || "").trim(),
        expense_date: String(report.period_start || "").slice(0, 10),
        amount: Number(Number(row.amount || 0).toFixed(2)),
        includes_vat: Boolean(row.includes_vat),
        marketplace: String(report.platform || "amazon").toLowerCase(),
        expense_type: "one_time",
        recurring_end_date: null,
        source_legacy_expense_id: row.id,
      };
    })
    .filter(
      (row): row is NonNullable<typeof row> =>
        Boolean(row && row.description.length > 0 && row.expense_date.length === 10)
    );

  if (payload.length === 0) return 0;
  const { error } = await supabase
    .from("expense_ledger")
    .upsert(payload, { onConflict: "source_legacy_expense_id" });
  if (error) throw error;
  return payload.length;
}
