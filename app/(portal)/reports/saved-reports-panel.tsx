"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import html2canvas from "html2canvas";
import { createClient } from "@/lib/supabase/client";

type SavedReport = {
  id: string;
  platform: "amazon" | "temu";
  period_start: string;
  period_end: string;
  gross_sales: number;
  total_cogs: number;
  total_fees: number;
  output_vat: number;
  input_vat: number;
  net_profit: number;
};

type Expense = {
  id: string;
  description: string;
  amount: number;
  includes_vat: boolean;
};

type Props = {
  accountId: string;
  canEdit: boolean;
  currency: string;
  vatRate: number;
};

function money(value: number) {
  return Number((value || 0).toFixed(2));
}

function computeExpenseTotals(rows: Expense[], vatRatePct: number) {
  const vatRate = (Number(vatRatePct) || 0) / 100;
  let net = 0;
  let vat = 0;
  for (const row of rows) {
    const amount = Number(row.amount || 0);
    if (!amount) continue;
    if (row.includes_vat && vatRate > 0) {
      const vatPart = amount * (vatRate / (1 + vatRate));
      vat += vatPart;
      net += amount - vatPart;
    } else {
      net += amount;
    }
  }
  return { net: money(net), vat: money(vat) };
}

export default function SavedReportsPanel({ accountId, canEdit, currency, vatRate }: Props) {
  const [reports, setReports] = useState<SavedReport[]>([]);
  const [selectedId, setSelectedId] = useState<string>("");
  const [expenses, setExpenses] = useState<Expense[]>([]);
  const [originalExpenses, setOriginalExpenses] = useState<Expense[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const [filterStart, setFilterStart] = useState("");
  const [filterEnd, setFilterEnd] = useState("");
  const [exportNotes, setExportNotes] = useState("");
  const reportExportRef = useRef<HTMLDivElement | null>(null);

  const selected = useMemo(() => reports.find((r) => r.id === selectedId) || null, [reports, selectedId]);

  const [form, setForm] = useState({
    gross_sales: "0",
    total_cogs: "0",
    total_fees: "0",
    output_vat: "0",
    input_vat: "0",
    net_profit: "0",
  });

  const loadReports = async () => {
    setLoading(true);
    setError(null);
    const supabase = createClient();

    let query = supabase
      .from("reports")
      .select(
        "id, platform, period_start, period_end, gross_sales, total_cogs, total_fees, output_vat, input_vat, net_profit"
      )
      .eq("account_id", accountId)
      .order("period_start", { ascending: false });

    if (filterStart) query = query.gte("period_start", filterStart);
    if (filterEnd) query = query.lte("period_end", filterEnd);

    const { data, error: fetchError } = await query;

    if (fetchError) {
      setError(fetchError.message);
      setLoading(false);
      return;
    }

    const nextReports = (data || []) as SavedReport[];
    setReports(nextReports);

    if (nextReports.length > 0) {
      const current = nextReports.find((r) => r.id === selectedId) || nextReports[0];
      setSelectedId(current.id);
    } else {
      setSelectedId("");
      setExpenses([]);
    }

    setLoading(false);
  };

  const loadExpenses = async (reportId: string) => {
    const supabase = createClient();
    const { data } = await supabase
      .from("expenses")
      .select("id, description, amount, includes_vat")
      .eq("report_id", reportId)
      .order("created_at", { ascending: true });

    const next = (data || []) as Expense[];
    setExpenses(next);
    setOriginalExpenses(next);
  };

  useEffect(() => {
    void loadReports();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accountId]);

  useEffect(() => {
    if (!selected) return;
    setForm({
      gross_sales: String(selected.gross_sales ?? 0),
      total_cogs: String(selected.total_cogs ?? 0),
      total_fees: String(selected.total_fees ?? 0),
      output_vat: String(selected.output_vat ?? 0),
      input_vat: String(selected.input_vat ?? 0),
      net_profit: String(selected.net_profit ?? 0),
    });
    setExportNotes("");
    void loadExpenses(selected.id);
  }, [selected]);

  const addExpense = () => {
    setExpenses((prev) => [
      ...prev,
      { id: crypto.randomUUID(), description: "", amount: 0, includes_vat: false },
    ]);
  };

  const updateExpense = (id: string, patch: Partial<Expense>) => {
    setExpenses((prev) => prev.map((e) => (e.id === id ? { ...e, ...patch } : e)));
  };

  const removeExpense = (id: string) => {
    setExpenses((prev) => prev.filter((e) => e.id !== id));
  };

  const saveChanges = async () => {
    if (!selected) return;

    setSaving(true);
    setError(null);
    setMessage(null);

    try {
      const supabase = createClient();

      const reportPatchInput = {
        gross_sales: money(Number(form.gross_sales)),
        total_cogs: money(Number(form.total_cogs)),
        total_fees: money(Number(form.total_fees)),
        output_vat: money(Number(form.output_vat)),
        input_vat: money(Number(form.input_vat)),
        net_profit: money(Number(form.net_profit)),
      };

      // Keep report totals in sync with updated manual expenses.
      const oldTotals = computeExpenseTotals(originalExpenses, vatRate);
      const newTotals = computeExpenseTotals(expenses, vatRate);
      const deltaVat = money(newTotals.vat - oldTotals.vat);
      const deltaNet = money(newTotals.net - oldTotals.net);
      const reportPatch = {
        ...reportPatchInput,
        input_vat: money(reportPatchInput.input_vat + deltaVat),
        net_profit: money(reportPatchInput.net_profit - deltaNet),
      };

      const { error: reportError } = await supabase.from("reports").update(reportPatch).eq("id", selected.id);
      if (reportError) throw reportError;

      const { error: clearError } = await supabase.from("expenses").delete().eq("report_id", selected.id);
      if (clearError) throw clearError;

      const payload = expenses
        .filter((e) => e.description.trim().length > 0 || Number(e.amount) !== 0)
        .map((e) => ({
          report_id: selected.id,
          description: e.description.trim(),
          amount: money(Number(e.amount)),
          includes_vat: Boolean(e.includes_vat),
        }));

      if (payload.length > 0) {
        const { error: expenseError } = await supabase.from("expenses").insert(payload);
        if (expenseError) throw expenseError;
      }

      setMessage("Saved report totals and expenses.");
      await loadReports();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save changes.");
    } finally {
      setSaving(false);
    }
  };

  const deleteSelectedReport = async () => {
    if (!selected) return;
    if (!window.confirm("Delete this saved report period? This also removes linked manual expenses.")) return;
    setSaving(true);
    setError(null);
    setMessage(null);
    try {
      const supabase = createClient();
      const { error: deleteError } = await supabase.from("reports").delete().eq("id", selected.id);
      if (deleteError) throw deleteError;
      setMessage("Report deleted.");
      await loadReports();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete report.");
    } finally {
      setSaving(false);
    }
  };

  const downloadPdf = async () => {
    if (!selected) return;

    setDownloading(true);
    setError(null);

    try {
      const query = new URLSearchParams();
      if (exportNotes.trim()) query.set("notes", exportNotes.trim());
      const url = `/api/reports/${selected.id}/pdf${query.toString() ? `?${query.toString()}` : ""}`;

      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`PDF export failed (${response.status})`);
      }

      const blob = await response.blob();
      const objectUrl = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = objectUrl;
      a.download = `profitability-${selected.platform}-${selected.period_start}.pdf`;
      a.click();
      URL.revokeObjectURL(objectUrl);
      setMessage("PDF exported.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to export PDF.");
    } finally {
      setDownloading(false);
    }
  };

  const downloadPng = async () => {
    if (!selected || !reportExportRef.current) return;
    setDownloading(true);
    setError(null);
    try {
      const canvas = await html2canvas(reportExportRef.current, {
        backgroundColor: "#ffffff",
        scale: 2,
        useCORS: true,
      });
      const objectUrl = canvas.toDataURL("image/png");
      const a = document.createElement("a");
      a.href = objectUrl;
      a.download = `profitability-${selected.platform}-${selected.period_start}.png`;
      a.click();
      setMessage("PNG exported.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to export PNG.");
    } finally {
      setDownloading(false);
    }
  };

  const missingForSelectedPeriod = Boolean(filterStart && filterEnd && reports.length === 0);

  return (
    <div className="space-y-4 rounded-2xl border border-slate-200 bg-white p-4">
      <div className="flex flex-wrap items-end gap-2">
        <div>
          <label className="mb-1 block text-xs font-medium uppercase tracking-wide text-slate-500">History Start</label>
          <input
            type="date"
            value={filterStart}
            onChange={(e) => setFilterStart(e.target.value)}
            className="rounded-xl border border-slate-300 px-3 py-2 text-sm"
          />
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium uppercase tracking-wide text-slate-500">History End</label>
          <input
            type="date"
            value={filterEnd}
            onChange={(e) => setFilterEnd(e.target.value)}
            className="rounded-xl border border-slate-300 px-3 py-2 text-sm"
          />
        </div>
        <button onClick={() => void loadReports()} className="rounded-xl bg-slate-100 px-4 py-2 text-sm font-semibold text-slate-700">
          Refresh
        </button>
      </div>

      {missingForSelectedPeriod ? (
        <div className="rounded-2xl border border-yellow-200 bg-yellow-50 p-3 text-sm text-yellow-800">
          Report missing for this period.
        </div>
      ) : null}

      {loading ? (
        <p className="text-sm text-slate-500">Loading saved reports...</p>
      ) : reports.length === 0 ? (
        <p className="text-sm text-slate-500">No saved reports found for this account/filter.</p>
      ) : (
        <div className="grid gap-3 md:grid-cols-[260px_1fr]">
          <div className="space-y-2">
            {reports.map((report) => (
              <button
                key={report.id}
                onClick={() => setSelectedId(report.id)}
                className={`w-full rounded-xl border px-3 py-2 text-left text-sm ${
                  selectedId === report.id
                    ? "border-[var(--md-primary)] bg-[var(--md-primary-container)]"
                    : "border-slate-200 bg-white"
                }`}
              >
                <p className="font-semibold capitalize">{report.platform}</p>
                <p className="text-xs text-slate-500">
                  {report.period_start} to {report.period_end}
                </p>
                <p className="mt-1 text-xs text-slate-600">Net: {currency}{Number(report.net_profit).toFixed(2)}</p>
              </button>
            ))}
          </div>

          {selected ? (
            <div ref={reportExportRef} className="space-y-3 rounded-2xl border border-slate-200 p-3">
              <h5 className="text-sm font-semibold text-slate-800">Report Detail</h5>

              <div className="grid gap-2 md:grid-cols-2">
                {Object.entries(form).map(([key, value]) => (
                  <label key={key} className="text-xs text-slate-600">
                    <span className="mb-1 block uppercase tracking-wide text-slate-500">{key.replaceAll("_", " ")}</span>
                    <input
                      type="number"
                      step="0.01"
                      value={value}
                      onChange={(e) => setForm((prev) => ({ ...prev, [key]: e.target.value }))}
                      disabled={!canEdit}
                      className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm disabled:bg-slate-100"
                    />
                  </label>
                ))}
              </div>

              <div className="space-y-2 rounded-xl border border-slate-200 p-3">
                <div className="flex items-center justify-between">
                  <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Manual Expenses</p>
                  {canEdit ? (
                    <button onClick={addExpense} className="rounded-lg bg-slate-100 px-2 py-1 text-xs font-semibold text-slate-700">
                      Add
                    </button>
                  ) : null}
                </div>
                {expenses.length === 0 ? <p className="text-sm text-slate-500">No expenses</p> : null}
                {expenses.map((expense) => (
                  <div key={expense.id} className="grid gap-2 md:grid-cols-[1fr_120px_120px_auto]">
                    <input
                      value={expense.description}
                      onChange={(e) => updateExpense(expense.id, { description: e.target.value })}
                      disabled={!canEdit}
                      className="rounded-lg border border-slate-300 px-2 py-1 text-sm disabled:bg-slate-100"
                    />
                    <input
                      type="number"
                      step="0.01"
                      value={expense.amount}
                      onChange={(e) => updateExpense(expense.id, { amount: Number(e.target.value) })}
                      disabled={!canEdit}
                      className="rounded-lg border border-slate-300 px-2 py-1 text-sm disabled:bg-slate-100"
                    />
                    <label className="flex items-center gap-2 rounded-lg border border-slate-300 px-2 py-1 text-xs">
                      <input
                        type="checkbox"
                        checked={expense.includes_vat}
                        onChange={(e) => updateExpense(expense.id, { includes_vat: e.target.checked })}
                        disabled={!canEdit}
                      />
                      Inc VAT
                    </label>
                    {canEdit ? (
                      <button
                        onClick={() => removeExpense(expense.id)}
                        className="rounded-lg bg-red-50 px-2 py-1 text-xs font-semibold text-red-700"
                      >
                        Remove
                      </button>
                    ) : null}
                  </div>
                ))}
              </div>

              <div className="space-y-2 rounded-xl border border-slate-200 p-3">
                <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Manual Notes for PDF</p>
                <textarea
                  value={exportNotes}
                  onChange={(e) => setExportNotes(e.target.value)}
                  rows={3}
                  className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                  placeholder="Add notes to include in the PDF report..."
                />
                <button
                  onClick={downloadPdf}
                  disabled={downloading}
                  className="rounded-xl bg-slate-900 px-4 py-2 text-sm font-semibold text-white disabled:opacity-60"
                >
                  {downloading ? "Generating PDF..." : "Download PDF"}
                </button>
                <button
                  onClick={downloadPng}
                  disabled={downloading}
                  className="ml-2 rounded-xl bg-slate-700 px-4 py-2 text-sm font-semibold text-white disabled:opacity-60"
                >
                  {downloading ? "Generating PNG..." : "Download PNG"}
                </button>
              </div>

              {message ? <p className="rounded-xl bg-green-50 px-3 py-2 text-sm text-green-700">{message}</p> : null}
              {error ? <p className="rounded-xl bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p> : null}

              {canEdit ? (
                <div className="flex flex-wrap gap-2">
                  <button
                    onClick={saveChanges}
                    disabled={saving}
                    className="rounded-xl bg-[var(--md-primary)] px-4 py-2 text-sm font-semibold text-white disabled:opacity-60"
                  >
                    {saving ? "Saving..." : "Save edits"}
                  </button>
                  <button
                    onClick={deleteSelectedReport}
                    disabled={saving}
                    className="rounded-xl bg-red-50 px-4 py-2 text-sm font-semibold text-red-700 disabled:opacity-60"
                  >
                    Delete report
                  </button>
                </div>
              ) : (
                <p className="rounded-xl bg-slate-100 px-3 py-2 text-sm text-slate-700">Read-only access for clients.</p>
              )}
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}
