"use client";

import { useEffect, useMemo, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { addDays, currentMondayIsoUtc, formatUkDate, isMonday, lastCompletedWeekMondayIsoUtc } from "@/lib/utils/date";
import { pushClientNotification } from "@/lib/notifications/client";

type Metric = {
  id: string;
  created_at: string;
  recorded_date: string;
  product_name: string;
  asin: string | null;
  bsr: number | null;
  review_count: number | null;
  rating: number | null;
  ppc_spend: number | null;
  ppc_sales: number | null;
  total_sales: number | null;
};

type FormState = {
  recorded_date: string;
  product_name: string;
  asin: string;
  bsr: string;
  review_count: string;
  rating: string;
  ppc_spend: string;
  ppc_sales: string;
  total_sales: string;
};

type Props = {
  accountId: string;
  canEdit: boolean;
};

function initialForm(): FormState {
  const monday = currentMondayIsoUtc();
  return {
    recorded_date: monday,
    product_name: "",
    asin: "",
    bsr: "",
    review_count: "",
    rating: "",
    ppc_spend: "",
    ppc_sales: "",
    total_sales: "",
  };
}

function lastCompletedWeekMonday() {
  return lastCompletedWeekMondayIsoUtc();
}

function weekRangeLabel(weekStart: string) {
  return `${formatUkDate(weekStart)} to ${formatUkDate(addDays(weekStart, 6))}`;
}

function deltaText(current: number | null, previous: number | null, mode: "higher_better" | "lower_better" | "neutral", decimals = 2) {
  if (current == null || previous == null) {
    return { text: "vs last: -", className: "text-slate-500" };
  }
  const diff = current - previous;
  const sign = diff > 0 ? "+" : "";
  const text = `vs last: ${sign}${diff.toFixed(decimals)}`;
  if (diff === 0 || mode === "neutral") return { text, className: "text-slate-500" };
  if (mode === "higher_better") return { text, className: diff > 0 ? "text-emerald-700" : "text-rose-700" };
  return { text, className: diff < 0 ? "text-emerald-700" : "text-rose-700" };
}

export default function PerformanceTracker({ accountId, canEdit }: Props) {
  const PAGE_SIZE = 20;
  const [rows, setRows] = useState<Metric[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const [form, setForm] = useState<FormState>(initialForm());
  const [editingId, setEditingId] = useState<string | null>(null);
  const [downloadingWeekly, setDownloadingWeekly] = useState(false);
  const [reportWeekStart, setReportWeekStart] = useState<string>(lastCompletedWeekMonday());
  const [pageOffset, setPageOffset] = useState(0);
  const currentPage = Math.floor(pageOffset / PAGE_SIZE) + 1;
  const reportingWeekStart = lastCompletedWeekMonday();
  const reportingWeekEnd = addDays(reportingWeekStart, 6);
  const selectedWeekEnd = addDays(reportWeekStart, 6);

  const loadRows = async () => {
    setLoading(true);
    setError(null);
    const supabase = createClient();

    const { data, error: fetchError } = await supabase
      .from("performance_metrics")
      .select("id, created_at, recorded_date, product_name, asin, bsr, review_count, rating, ppc_spend, ppc_sales, total_sales")
      .eq("account_id", accountId)
      .order("recorded_date", { ascending: false })
      .order("created_at", { ascending: false });

    if (fetchError) {
      setError(fetchError.message);
      setLoading(false);
      return;
    }

    const nextRows = (data || []) as Metric[];
    setRows(nextRows);
    setLoading(false);
  };

  useEffect(() => {
    setPageOffset(0);
    void loadRows();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accountId]);

  const saveMetric = async () => {
    if (!form.product_name.trim()) {
      setError("Product name is required.");
      return;
    }
    if (!form.asin.trim()) {
      setError("ASIN is required.");
      return;
    }

    setSaving(true);
    setError(null);
    setMessage(null);
    setWarning(null);

    try {
      const asin = form.asin.trim().toUpperCase();
      if (asin && !/^[A-Z0-9]{10}$/.test(asin)) {
        throw new Error("ASIN must be exactly 10 letters/numbers.");
      }
      const ppcSpend = form.ppc_spend ? Number(form.ppc_spend) : null;
      const ppcSales = form.ppc_sales ? Number(form.ppc_sales) : null;
      const totalSales = form.total_sales ? Number(form.total_sales) : null;
      if ((ppcSpend ?? 0) < 0 || (ppcSales ?? 0) < 0 || (totalSales ?? 0) < 0) {
        throw new Error("PPC Spend, PPC Sales, and Total Sales must be non-negative.");
      }
      if (ppcSpend != null && totalSales != null && ppcSpend > totalSales) {
        setWarning("PPC Spend is higher than Total Sales. Please verify the values.");
      }

      const supabase = createClient();
      const recordedDate = editingId ? form.recorded_date : reportingWeekStart;
      if (!isMonday(recordedDate)) {
        throw new Error("Recorded week must be Monday.");
      }
      const payload = {
        account_id: accountId,
        recorded_date: recordedDate,
        product_name: form.product_name.trim(),
        asin: asin || null,
        bsr: form.bsr ? Number(form.bsr) : null,
        review_count: form.review_count ? Number(form.review_count) : null,
        rating: form.rating ? Number(form.rating) : null,
        ppc_spend: ppcSpend,
        ppc_sales: ppcSales,
        total_sales: totalSales,
      };
      if (editingId) {
        const { error: updateError } = await supabase.from("performance_metrics").update(payload).eq("id", editingId);
        if (updateError) throw updateError;
      } else {
        const { error: insertError } = await supabase.from("performance_metrics").insert(payload);
        if (insertError) throw insertError;
      }

      setForm(initialForm());
      setEditingId(null);
      setMessage(editingId ? "Performance metric updated." : "Performance metric saved.");
      await loadRows();
    } catch (err) {
      const text = err instanceof Error ? err.message : "Failed to save metric.";
      setError(text);
      await pushClientNotification({
        title: "Performance save failed",
        body: text,
        level: "error",
        eventKey: `performance-save-fail:${accountId}:${Date.now()}`,
      });
    } finally {
      setSaving(false);
    }
  };

  const deleteMetric = async (id: string) => {
    if (!canEdit) return;

    const supabase = createClient();
    const { error: deleteError } = await supabase.from("performance_metrics").delete().eq("id", id);
    if (deleteError) {
      setError(deleteError.message);
      await pushClientNotification({
        title: "Performance delete failed",
        body: deleteError.message,
        level: "error",
        eventKey: `performance-delete-fail:${id}:${Date.now()}`,
      });
      return;
    }

    await loadRows();
  };

  const editMetric = (row: Metric) => {
    setEditingId(row.id);
    setForm({
      recorded_date: row.recorded_date,
      product_name: row.product_name,
      asin: row.asin || "",
      bsr: row.bsr == null ? "" : String(row.bsr),
      review_count: row.review_count == null ? "" : String(row.review_count),
      rating: row.rating == null ? "" : String(row.rating),
      ppc_spend: row.ppc_spend == null ? "" : String(row.ppc_spend),
      ppc_sales: row.ppc_sales == null ? "" : String(row.ppc_sales),
      total_sales: row.total_sales == null ? "" : String(row.total_sales),
    });
  };

  const cancelEdit = () => {
    setEditingId(null);
    setForm(initialForm());
  };

  const downloadWeeklyPdf = async () => {
    const weekStart = reportWeekStart;
    setDownloadingWeekly(true);
    setError(null);
    try {
      const url = `/api/performance/weekly-pdf?accountId=${encodeURIComponent(accountId)}&weekStart=${encodeURIComponent(weekStart)}`;
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`Weekly performance PDF failed (${response.status})`);
      }
      const blob = await response.blob();
      const objectUrl = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = objectUrl;
      a.download = `performance-week-${weekStart}.pdf`;
      a.click();
      URL.revokeObjectURL(objectUrl);
      setMessage("Weekly performance PDF exported.");
    } catch (err) {
      const text = err instanceof Error ? err.message : "Failed to export weekly performance PDF.";
      setError(text);
      await pushClientNotification({
        title: "Weekly performance PDF failed",
        body: text,
        level: "error",
        eventKey: `weekly-performance-pdf-fail:${accountId}:${weekStart}:${Date.now()}`,
      });
    } finally {
      setDownloadingWeekly(false);
    }
  };

  const selectedWeekRows = useMemo(() => {
    const selected = rows.filter((row) => row.recorded_date === reportWeekStart);
    const previousWeekStart = addDays(reportWeekStart, -7);
    const previousByKey = new Map<string, Metric>();
    const selectedByKey = new Map<string, Metric>();

    rows.forEach((row) => {
      const key = `${row.asin || ""}::${row.product_name.trim().toLowerCase()}`;
      if (row.recorded_date === previousWeekStart && !previousByKey.has(key)) {
        previousByKey.set(key, row);
      }
    });

    selected.forEach((row) => {
      const key = `${row.asin || ""}::${row.product_name.trim().toLowerCase()}`;
      if (!selectedByKey.has(key)) selectedByKey.set(key, row);
    });

    return Array.from(selectedByKey.values())
      .map((row) => {
        const key = `${row.asin || ""}::${row.product_name.trim().toLowerCase()}`;
        const previous = previousByKey.get(key) || null;
        return { current: row, previous };
      })
      .sort((a, b) => a.current.product_name.localeCompare(b.current.product_name));
  }, [rows, reportWeekStart]);

  useEffect(() => {
    setPageOffset(0);
  }, [reportWeekStart]);

  const totalCount = selectedWeekRows.length;
  const totalPages = Math.max(1, Math.ceil(totalCount / PAGE_SIZE));
  const pagedWeekRows = selectedWeekRows.slice(pageOffset, pageOffset + PAGE_SIZE);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-2 rounded-2xl border border-slate-200 bg-white p-4">
        <p className="text-sm text-slate-700">
          Weekly report period:{" "}
          <span className="font-semibold">
            {formatUkDate(reportWeekStart)} to {formatUkDate(selectedWeekEnd)}
          </span>
        </p>
        <button
          type="button"
          onClick={() => setReportWeekStart((prev) => addDays(prev, -7))}
          className="rounded-lg bg-slate-100 px-3 py-2 text-sm font-semibold text-slate-700"
        >
          Previous Week
        </button>
        <button
          type="button"
          onClick={() => setReportWeekStart((prev) => addDays(prev, 7))}
          disabled={reportWeekStart >= reportingWeekStart}
          className="rounded-lg bg-slate-100 px-3 py-2 text-sm font-semibold text-slate-700 disabled:opacity-50"
        >
          Next Week
        </button>
        <button
          onClick={downloadWeeklyPdf}
          disabled={downloadingWeekly}
          className="rounded-lg bg-slate-900 px-3 py-2 text-sm font-semibold text-white disabled:opacity-60"
        >
          {downloadingWeekly ? "Generating..." : "Download Weekly PDF"}
        </button>
        <p className="w-full text-xs text-slate-500">Use Previous/Next Week to view older weekly comparisons.</p>
      </div>

      {canEdit ? (
        <div className="grid gap-2 rounded-2xl border border-slate-200 bg-white p-4 md:grid-cols-4">
          {!editingId ? (
            <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-600 md:col-span-4">
              New entries are saved to last completed week: {formatUkDate(reportingWeekStart)} to{" "}
              {formatUkDate(reportingWeekEnd)}.
            </div>
          ) : null}
          <input
            placeholder="Product name"
            value={form.product_name}
            onChange={(e) => setForm((prev) => ({ ...prev, product_name: e.target.value }))}
            className="rounded-lg border border-slate-300 px-2 py-2 text-sm"
          />
          <input
            placeholder="ASIN"
            value={form.asin}
            onChange={(e) => setForm((prev) => ({ ...prev, asin: e.target.value.toUpperCase() }))}
            className="rounded-lg border border-slate-300 px-2 py-2 text-sm"
          />
          <input
            placeholder="BSR"
            value={form.bsr}
            onChange={(e) => setForm((prev) => ({ ...prev, bsr: e.target.value }))}
            type="number"
            className="rounded-lg border border-slate-300 px-2 py-2 text-sm"
          />
          <input
            placeholder="Reviews"
            value={form.review_count}
            onChange={(e) => setForm((prev) => ({ ...prev, review_count: e.target.value }))}
            type="number"
            className="rounded-lg border border-slate-300 px-2 py-2 text-sm"
          />
          <input
            placeholder="Rating"
            value={form.rating}
            onChange={(e) => setForm((prev) => ({ ...prev, rating: e.target.value }))}
            type="number"
            step="0.01"
            className="rounded-lg border border-slate-300 px-2 py-2 text-sm"
          />
          <input
            placeholder="PPC Spend"
            value={form.ppc_spend}
            onChange={(e) => setForm((prev) => ({ ...prev, ppc_spend: e.target.value }))}
            type="number"
            step="0.01"
            className="rounded-lg border border-slate-300 px-2 py-2 text-sm"
          />
          <input
            placeholder="PPC Sales"
            value={form.ppc_sales}
            onChange={(e) => setForm((prev) => ({ ...prev, ppc_sales: e.target.value }))}
            type="number"
            step="0.01"
            className="rounded-lg border border-slate-300 px-2 py-2 text-sm"
          />
          <input
            placeholder="Total Sales"
            value={form.total_sales}
            onChange={(e) => setForm((prev) => ({ ...prev, total_sales: e.target.value }))}
            type="number"
            step="0.01"
            className="rounded-lg border border-slate-300 px-2 py-2 text-sm"
          />
          <button
            onClick={saveMetric}
            disabled={saving}
            className="rounded-lg bg-[var(--md-primary)] px-3 py-2 text-sm font-semibold text-white disabled:opacity-60"
          >
            {saving ? "Saving..." : editingId ? "Update" : "Add"}
          </button>
          {editingId ? (
            <button
              onClick={cancelEdit}
              type="button"
              className="rounded-lg bg-slate-100 px-3 py-2 text-sm font-semibold text-slate-700"
            >
              Cancel
            </button>
          ) : null}
        </div>
      ) : (
        <p className="rounded-2xl bg-slate-100 px-3 py-2 text-sm text-slate-700">
          Client view is read-only. Team/Admin can log new performance rows.
        </p>
      )}

      {message ? <p className="rounded-xl bg-green-50 px-3 py-2 text-sm text-green-700">{message}</p> : null}
      {error ? <p className="rounded-xl bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p> : null}
      {warning ? <p className="rounded-xl bg-yellow-50 px-3 py-2 text-sm text-yellow-800">{warning}</p> : null}

      <div className="rounded-2xl border border-slate-200 bg-white p-3 md:hidden">
        {loading ? (
          <p className="text-sm text-slate-500">Loading performance data...</p>
        ) : pagedWeekRows.length === 0 ? (
          <p className="text-sm text-slate-500">No performance metrics saved for this account.</p>
        ) : (
          <div className="space-y-2">
            {pagedWeekRows.map(({ current, previous }) => {
              const acos = current.ppc_spend && current.ppc_sales ? (current.ppc_spend / current.ppc_sales) * 100 : null;
              const tacos = current.ppc_spend && current.total_sales ? (current.ppc_spend / current.total_sales) * 100 : null;
              const bsrTrend =
                current.bsr != null && previous?.bsr != null
                  ? previous.bsr - current.bsr
                  : null;
              const reviewTrend =
                current.review_count != null && previous?.review_count != null
                  ? current.review_count - previous.review_count
                  : null;
              return (
                <div key={current.id} className="rounded-xl border border-slate-200 p-3 text-sm">
                  <p className="font-semibold">{current.product_name}</p>
                  <p className="text-xs text-slate-500">{weekRangeLabel(current.recorded_date)}</p>
                  <p className="mt-1">ASIN: {current.asin || "-"}</p>
                  <p>BSR: {current.bsr ?? "-"}</p>
                  <p>Reviews: {current.review_count ?? "-"}</p>
                  <p>Rating: {current.rating ?? "-"}</p>
                  <p>PPC Spend: {current.ppc_spend == null ? "-" : Number(current.ppc_spend).toFixed(2)}</p>
                  <p>PPC Sales: {current.ppc_sales == null ? "-" : Number(current.ppc_sales).toFixed(2)}</p>
                  <p>Total Sales: {current.total_sales == null ? "-" : Number(current.total_sales).toFixed(2)}</p>
                  <p>ACOS: {acos == null ? "-" : `${acos.toFixed(2)}%`}</p>
                  <p>TACOS: {tacos == null ? "-" : `${tacos.toFixed(2)}%`}</p>
                  <p>Trend: {bsrTrend == null ? "No prior BSR data" : bsrTrend > 0 ? `BSR improved by ${bsrTrend}` : bsrTrend < 0 ? `BSR dropped by ${Math.abs(bsrTrend)}` : "BSR unchanged"}</p>
                  <p>Trend: {reviewTrend == null ? "No prior review data" : reviewTrend > 0 ? `Reviews increased by ${reviewTrend}` : reviewTrend < 0 ? `Reviews decreased by ${Math.abs(reviewTrend)}` : "Review count unchanged"}</p>
                  {canEdit ? (
                    <div className="mt-2 flex gap-2">
                      <button onClick={() => editMetric(current)} className="rounded-lg bg-slate-100 px-2 py-1 text-xs font-semibold text-slate-700">
                        Edit
                      </button>
                      <button
                        onClick={() => deleteMetric(current.id)}
                        className="rounded-lg bg-red-50 px-2 py-1 text-xs font-semibold text-red-700"
                      >
                        Delete
                      </button>
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        )}
      </div>

      <div className="hidden overflow-x-auto rounded-2xl border border-slate-200 bg-white md:block">
        <table className="min-w-full text-sm">
          <thead className="text-left text-xs uppercase tracking-wide text-slate-500">
            <tr>
              <th className="px-4 py-3">Week</th>
              <th className="px-4 py-3">Product</th>
              <th className="px-4 py-3">ASIN</th>
              <th className="px-4 py-3">PPC Spend</th>
              <th className="px-4 py-3">PPC Sales</th>
              <th className="px-4 py-3">Total Sales</th>
              <th className="px-4 py-3">ACOS</th>
              <th className="px-4 py-3">TACOS</th>
              <th className="px-4 py-3">BSR</th>
              <th className="px-4 py-3">Reviews</th>
              <th className="px-4 py-3">Rating</th>
              {canEdit ? <th className="px-4 py-3">Actions</th> : null}
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td className="px-4 py-4 text-slate-500" colSpan={canEdit ? 13 : 12}>
                  Loading performance data...
                </td>
              </tr>
            ) : pagedWeekRows.length === 0 ? (
              <tr>
                <td className="px-4 py-4 text-slate-500" colSpan={canEdit ? 13 : 12}>
                  No performance metrics saved for this account.
                </td>
              </tr>
            ) : (
              pagedWeekRows.map(({ current, previous }) => {
                const acos = current.ppc_spend && current.ppc_sales ? (current.ppc_spend / current.ppc_sales) * 100 : null;
                const tacos = current.ppc_spend && current.total_sales ? (current.ppc_spend / current.total_sales) * 100 : null;
                const prevAcos = previous?.ppc_spend && previous?.ppc_sales ? (previous.ppc_spend / previous.ppc_sales) * 100 : null;
                const prevTacos = previous?.ppc_spend && previous?.total_sales ? (previous.ppc_spend / previous.total_sales) * 100 : null;
                const spendDelta = deltaText(current.ppc_spend, previous?.ppc_spend ?? null, "neutral");
                const ppcSalesDelta = deltaText(current.ppc_sales, previous?.ppc_sales ?? null, "higher_better");
                const totalSalesDelta = deltaText(current.total_sales, previous?.total_sales ?? null, "higher_better");
                const acosDelta = deltaText(acos, prevAcos, "lower_better");
                const tacosDelta = deltaText(tacos, prevTacos, "lower_better");
                const bsrDelta = deltaText(current.bsr, previous?.bsr ?? null, "lower_better", 0);
                const reviewsDelta = deltaText(current.review_count, previous?.review_count ?? null, "higher_better", 0);
                const ratingDelta = deltaText(current.rating, previous?.rating ?? null, "higher_better");
                return (
                  <tr key={current.id} className="border-t border-slate-100">
                    <td className="px-4 py-3">{weekRangeLabel(current.recorded_date)}</td>
                    <td className="px-4 py-3">{current.product_name}</td>
                    <td className="px-4 py-3">
                      {current.asin ? (
                        <a
                          href={`https://www.amazon.co.uk/dp/${current.asin}`}
                          target="_blank"
                          rel="noreferrer"
                          className="text-[var(--md-primary)] underline"
                        >
                          {current.asin}
                        </a>
                      ) : (
                        "-"
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <div>
                        <p>{current.ppc_spend == null ? "-" : Number(current.ppc_spend).toFixed(2)}</p>
                        <p className={`text-xs ${spendDelta.className}`}>{spendDelta.text}</p>
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <div>
                        <p>{current.ppc_sales == null ? "-" : Number(current.ppc_sales).toFixed(2)}</p>
                        <p className={`text-xs ${ppcSalesDelta.className}`}>{ppcSalesDelta.text}</p>
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <div>
                        <p>{current.total_sales == null ? "-" : Number(current.total_sales).toFixed(2)}</p>
                        <p className={`text-xs ${totalSalesDelta.className}`}>{totalSalesDelta.text}</p>
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <div>
                        <p>{acos == null ? "-" : `${acos.toFixed(2)}%`}</p>
                        <p className={`text-xs ${acosDelta.className}`}>{acosDelta.text}</p>
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <div>
                        <p>{tacos == null ? "-" : `${tacos.toFixed(2)}%`}</p>
                        <p className={`text-xs ${tacosDelta.className}`}>{tacosDelta.text}</p>
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <div>
                        <p>{current.bsr ?? "-"}</p>
                        <p className={`text-xs ${bsrDelta.className}`}>{bsrDelta.text}</p>
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <div>
                        <p>{current.review_count ?? "-"}</p>
                        <p className={`text-xs ${reviewsDelta.className}`}>{reviewsDelta.text}</p>
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <div>
                        <p>{current.rating ?? "-"}</p>
                        <p className={`text-xs ${ratingDelta.className}`}>{ratingDelta.text}</p>
                      </div>
                    </td>
                    {canEdit ? (
                      <td className="px-4 py-3">
                        <button
                          onClick={() => editMetric(current)}
                          className="mr-2 rounded-lg bg-slate-100 px-2 py-1 text-xs font-semibold text-slate-700"
                        >
                          Edit
                        </button>
                        <button
                          onClick={() => deleteMetric(current.id)}
                          className="rounded-lg bg-red-50 px-2 py-1 text-xs font-semibold text-red-700"
                        >
                          Delete
                        </button>
                      </td>
                    ) : null}
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
      <div className="flex flex-wrap items-center justify-end gap-2">
        <span className="text-xs text-slate-500">
          Page {currentPage} of {totalPages} ({totalCount} items)
        </span>
        <select
          value={currentPage}
          onChange={(e) => {
            const targetPage = Number(e.target.value);
            const next = Math.max(0, (targetPage - 1) * PAGE_SIZE);
            setPageOffset(next);
          }}
          className="rounded-lg border border-slate-300 px-2 py-1.5 text-xs"
        >
          {Array.from({ length: totalPages }, (_, i) => i + 1).map((page) => (
            <option key={page} value={page}>
              {page}
            </option>
          ))}
        </select>
        <button
          type="button"
          onClick={() => {
            const next = Math.max(0, pageOffset - PAGE_SIZE);
            setPageOffset(next);
          }}
          disabled={pageOffset === 0 || loading}
          className="rounded-lg bg-slate-100 px-3 py-1.5 text-xs font-semibold text-slate-700 disabled:opacity-50"
        >
          Previous
        </button>
        <button
          type="button"
          onClick={() => {
            const next = pageOffset + PAGE_SIZE;
            setPageOffset(next);
          }}
          disabled={currentPage >= totalPages || loading}
          className="rounded-lg bg-slate-100 px-3 py-1.5 text-xs font-semibold text-slate-700 disabled:opacity-50"
        >
          Next
        </button>
      </div>
    </div>
  );
}
