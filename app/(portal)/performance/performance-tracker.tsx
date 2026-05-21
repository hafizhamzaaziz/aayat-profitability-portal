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

type ActivePlatform = "amazon" | "temu";

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

const TEMU_PREFIX = "TEMU:";

function inferPlatformFromIdentifier(identifier: string | null): ActivePlatform {
  return String(identifier || "").toUpperCase().startsWith(TEMU_PREFIX) ? "temu" : "amazon";
}

function encodeIdentifier(platform: ActivePlatform, raw: string) {
  const cleaned = raw.trim().toUpperCase();
  if (!cleaned) return "";
  return platform === "temu" ? `${TEMU_PREFIX}${cleaned}` : cleaned;
}

function decodeIdentifier(raw: string | null) {
  const value = String(raw || "").trim().toUpperCase();
  if (value.startsWith(TEMU_PREFIX)) return value.slice(TEMU_PREFIX.length);
  return value;
}

function valueColorClass(current: number | null, previous: number | null, trend: "higher_better" | "lower_better") {
  if (current == null || previous == null) return "text-slate-900";
  if (current === previous) return "text-slate-900";
  if (trend === "higher_better") return current > previous ? "text-emerald-700" : "text-rose-700";
  return current > previous ? "text-rose-700" : "text-emerald-700";
}

function trendForMetric(metric: "ppc_spend" | "ppc_sales" | "total_sales" | "acos" | "tacos" | "bsr" | "reviews" | "rating") {
  if (metric === "ppc_sales" || metric === "total_sales" || metric === "reviews" || metric === "rating") {
    return "higher_better" as const;
  }
  return "lower_better" as const;
}

function metricValueClass(
  metric: "ppc_spend" | "ppc_sales" | "total_sales" | "acos" | "tacos" | "bsr" | "reviews" | "rating",
  current: number | null,
  previous: number | null
) {
  return valueColorClass(current, previous, trendForMetric(metric));
}

function metricTrend(
  metric: "ppc_spend" | "ppc_sales" | "total_sales" | "acos" | "tacos" | "bsr" | "reviews" | "rating",
  current: number | null,
  previous: number | null
) {
  if (current == null || previous == null || current === previous) return "neutral";
  const trend = trendForMetric(metric);
  const better = trend === "higher_better" ? current > previous : current < previous;
  return better ? "improved" : "declined";
}

function trendText(metric: "ppc_spend" | "ppc_sales" | "total_sales" | "acos" | "tacos" | "bsr" | "reviews" | "rating", trend: "improved" | "declined" | "neutral") {
  if (trend === "neutral") return "";
  if (metric === "ppc_sales") return trend === "improved" ? "PPC Sales improved" : "PPC Sales declined";
  if (metric === "total_sales") return trend === "improved" ? "Total Sales improved" : "Total Sales declined";
  if (metric === "reviews") return trend === "improved" ? "Reviews improved" : "Reviews declined";
  if (metric === "rating") return trend === "improved" ? "Rating improved" : "Rating declined";
  if (metric === "ppc_spend") return trend === "improved" ? "PPC Spend improved" : "PPC Spend worsened";
  if (metric === "acos") return trend === "improved" ? "ACOS improved" : "ACOS worsened";
  if (metric === "tacos") return trend === "improved" ? "TACOS improved" : "TACOS worsened";
  return trend === "improved" ? "BSR improved" : "BSR worsened";
}

function trendClass(trend: "improved" | "declined" | "neutral") {
  if (trend === "improved") return "text-emerald-700";
  if (trend === "declined") return "text-rose-700";
  return "text-slate-900";
}

function previousValueText(previous: number | null, formatter?: (value: number) => string) {
  if (previous == null) return "vs last: -";
  return `vs last: ${formatter ? formatter(previous) : previous}`;
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
  const [emailingWeekly, setEmailingWeekly] = useState(false);
  const [reportWeekStart, setReportWeekStart] = useState<string>(lastCompletedWeekMonday());
  const [activePlatform, setActivePlatform] = useState<ActivePlatform>("amazon");
  const [pageOffset, setPageOffset] = useState(0);
  const currentPage = Math.floor(pageOffset / PAGE_SIZE) + 1;
  const reportingWeekStart = lastCompletedWeekMonday();
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
      setError(activePlatform === "amazon" ? "ASIN is required." : "Goods ID is required.");
      return;
    }

    setSaving(true);
    setError(null);
    setMessage(null);
    setWarning(null);

    try {
      const identifierRaw = form.asin.trim().toUpperCase();
      if (activePlatform === "amazon" && identifierRaw && !/^[A-Z0-9]{10}$/.test(identifierRaw)) {
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
      const recordedDate = editingId ? form.recorded_date : reportWeekStart;
      if (!isMonday(recordedDate)) {
        throw new Error("Recorded week must be Monday.");
      }
      if (!editingId && recordedDate > reportingWeekStart) {
        throw new Error("Cannot save entries to a future week. Use Previous Week to pick a completed week.");
      }
      const payload = {
        account_id: accountId,
        recorded_date: recordedDate,
        product_name: form.product_name.trim(),
        asin: encodeIdentifier(activePlatform, identifierRaw) || null,
        bsr: activePlatform === "amazon" ? (form.bsr ? Number(form.bsr) : null) : null,
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
      setMessage(
        editingId
          ? `Performance metric updated for week ${weekRangeLabel(recordedDate)}.`
          : `Performance metric saved for week ${weekRangeLabel(recordedDate)}.`
      );
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
    setActivePlatform(inferPlatformFromIdentifier(row.asin));
    setEditingId(row.id);
    setForm({
      recorded_date: row.recorded_date,
      product_name: row.product_name,
      asin: decodeIdentifier(row.asin),
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

  const downloadWeeklyPdf = async (target: ActivePlatform | "all") => {
    const weekStart = reportWeekStart;
    setDownloadingWeekly(true);
    setError(null);
    try {
      const url = `/api/performance/weekly-pdf?accountId=${encodeURIComponent(accountId)}&weekStart=${encodeURIComponent(weekStart)}&platform=${encodeURIComponent(target)}`;
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`Weekly performance PDF failed (${response.status})`);
      }
      const blob = await response.blob();
      const objectUrl = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = objectUrl;
      a.download = `performance-${target}-week-${weekStart}.pdf`;
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

  const emailWeeklyPdfToClient = async (target: ActivePlatform | "all") => {
    const weekStart = reportWeekStart;
    const targetLabel = target === "all" ? "combined (Amazon + Temu)" : target === "temu" ? "Temu" : "Amazon";
    if (!window.confirm(`Send the ${targetLabel} weekly performance PDF by email to all assigned clients of this account?`)) return;
    setEmailingWeekly(true);
    setError(null);
    try {
      const url = `/api/performance/weekly-pdf?accountId=${encodeURIComponent(accountId)}&weekStart=${encodeURIComponent(weekStart)}&platform=${encodeURIComponent(target)}&email=1`;
      const response = await fetch(url);
      const payload = (await response.json().catch(() => ({}))) as {
        ok?: boolean;
        recipients?: string[];
        error?: string;
        skipped?: string;
      };
      if (!response.ok || payload.ok === false) {
        throw new Error(payload.error || `Weekly email send failed (${response.status})`);
      }
      if (payload.skipped) {
        throw new Error(payload.skipped);
      }
      const list = (payload.recipients || []).join(", ");
      setMessage(`Weekly performance emailed to ${payload.recipients?.length || 0} recipient${(payload.recipients?.length || 0) === 1 ? "" : "s"}${list ? `: ${list}` : ""}.`);
    } catch (err) {
      const text = err instanceof Error ? err.message : "Failed to email weekly performance PDF.";
      setError(text);
      await pushClientNotification({
        title: "Weekly performance email failed",
        body: text,
        level: "error",
        eventKey: `weekly-performance-email-fail:${accountId}:${weekStart}:${Date.now()}`,
      });
    } finally {
      setEmailingWeekly(false);
    }
  };

  const selectedWeekRows = useMemo(() => {
    const selected = rows.filter(
      (row) => row.recorded_date === reportWeekStart && inferPlatformFromIdentifier(row.asin) === activePlatform
    );
    const previousWeekStart = addDays(reportWeekStart, -7);
    const previousByKey = new Map<string, Metric>();
    const selectedByKey = new Map<string, Metric>();

    rows.forEach((row) => {
      if (inferPlatformFromIdentifier(row.asin) !== activePlatform) return;
      const key = `${decodeIdentifier(row.asin)}::${row.product_name.trim().toLowerCase()}`;
      if (row.recorded_date === previousWeekStart && !previousByKey.has(key)) {
        previousByKey.set(key, row);
      }
    });

    selected.forEach((row) => {
      const key = `${decodeIdentifier(row.asin)}::${row.product_name.trim().toLowerCase()}`;
      if (!selectedByKey.has(key)) selectedByKey.set(key, row);
    });

    return Array.from(selectedByKey.values())
      .map((row) => {
        const key = `${decodeIdentifier(row.asin)}::${row.product_name.trim().toLowerCase()}`;
        const previous = previousByKey.get(key) || null;
        return { current: row, previous };
      })
      .sort((a, b) => a.current.product_name.localeCompare(b.current.product_name));
  }, [rows, reportWeekStart, activePlatform]);

  const weekTotals = useMemo(() => {
    const sumPair = (selector: (row: Metric) => number | null) => {
      let cur = 0;
      let prev = 0;
      let curN = 0;
      let prevN = 0;
      selectedWeekRows.forEach(({ current, previous }) => {
        const c = selector(current);
        const p = previous ? selector(previous) : null;
        if (c != null) {
          cur += c;
          curN += 1;
        }
        if (p != null) {
          prev += p;
          prevN += 1;
        }
      });
      return { cur, prev, curN, prevN };
    };

    const ppcSpend = sumPair((row) => row.ppc_spend);
    const ppcSales = sumPair((row) => row.ppc_sales);
    const totalSales = sumPair((row) => row.total_sales);
    const acosCur = ppcSales.cur > 0 ? (ppcSpend.cur / ppcSales.cur) * 100 : null;
    const acosPrev = ppcSales.prev > 0 ? (ppcSpend.prev / ppcSales.prev) * 100 : null;
    const tacosCur = totalSales.cur > 0 ? (ppcSpend.cur / totalSales.cur) * 100 : null;
    const tacosPrev = totalSales.prev > 0 ? (ppcSpend.prev / totalSales.prev) * 100 : null;

    return {
      ppcSpend: { cur: ppcSpend.cur, prev: ppcSpend.prev },
      ppcSales: { cur: ppcSales.cur, prev: ppcSales.prev },
      totalSales: { cur: totalSales.cur, prev: totalSales.prev },
      acos: { cur: acosCur, prev: acosPrev },
      tacos: { cur: tacosCur, prev: tacosPrev },
    };
  }, [selectedWeekRows]);

  useEffect(() => {
    setPageOffset(0);
  }, [reportWeekStart]);

  const totalCount = selectedWeekRows.length;
  const totalPages = Math.max(1, Math.ceil(totalCount / PAGE_SIZE));
  const pagedWeekRows = selectedWeekRows.slice(pageOffset, pageOffset + PAGE_SIZE);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-2 rounded-2xl border border-slate-200 bg-white p-4">
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setActivePlatform("amazon")}
            className={`rounded-lg px-3 py-2 text-sm font-semibold ${activePlatform === "amazon" ? "bg-[var(--md-primary)] text-white" : "bg-slate-100 text-slate-700"}`}
          >
            Amazon
          </button>
          <button
            type="button"
            onClick={() => setActivePlatform("temu")}
            className={`rounded-lg px-3 py-2 text-sm font-semibold ${activePlatform === "temu" ? "bg-[var(--md-primary)] text-white" : "bg-slate-100 text-slate-700"}`}
          >
            Temu
          </button>
        </div>
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
          onClick={() => void downloadWeeklyPdf(activePlatform)}
          disabled={downloadingWeekly}
          className="rounded-lg bg-slate-900 px-3 py-2 text-sm font-semibold text-white disabled:opacity-60"
        >
          {downloadingWeekly ? "Generating..." : `Download ${activePlatform === "amazon" ? "Amazon" : "Temu"} PDF`}
        </button>
        <button
          onClick={() => void downloadWeeklyPdf("all")}
          disabled={downloadingWeekly}
          className="rounded-lg bg-slate-700 px-3 py-2 text-sm font-semibold text-white disabled:opacity-60"
        >
          {downloadingWeekly ? "Generating..." : "Download Combined PDF"}
        </button>
        {canEdit ? (
          <>
            <button
              onClick={() => void emailWeeklyPdfToClient(activePlatform)}
              disabled={emailingWeekly}
              title="Email this week's PDF to all assigned clients of this account"
              className="rounded-lg bg-[var(--md-primary)] px-3 py-2 text-sm font-semibold text-white disabled:opacity-60"
            >
              {emailingWeekly ? "Emailing..." : `Email ${activePlatform === "amazon" ? "Amazon" : "Temu"} to Client`}
            </button>
            <button
              onClick={() => void emailWeeklyPdfToClient("all")}
              disabled={emailingWeekly}
              title="Email the combined Amazon + Temu weekly PDF to all assigned clients of this account"
              className="rounded-lg bg-[var(--md-primary)] px-3 py-2 text-sm font-semibold text-white disabled:opacity-60"
            >
              {emailingWeekly ? "Emailing..." : "Email Combined to Client"}
            </button>
          </>
        ) : null}
        <p className="w-full text-xs text-slate-500">Use Previous/Next Week to view older weekly comparisons.</p>
      </div>

      {canEdit ? (
        <div className="grid gap-2 rounded-2xl border border-slate-200 bg-white p-4 md:grid-cols-4">
          {!editingId ? (
            <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-600 md:col-span-4">
              New entries are saved to the selected week:{" "}
              <span className="font-semibold">
                {formatUkDate(reportWeekStart)} to {formatUkDate(selectedWeekEnd)}
              </span>
              {reportWeekStart !== reportingWeekStart ? (
                <span className="ml-2 rounded-md bg-amber-100 px-2 py-0.5 text-[11px] font-semibold text-amber-800">
                  Backfilling an older week
                </span>
              ) : null}
              . Use Previous/Next Week above to change the target week.
            </div>
          ) : null}
          <input
            placeholder="Product name"
            value={form.product_name}
            onChange={(e) => setForm((prev) => ({ ...prev, product_name: e.target.value }))}
            className="rounded-lg border border-slate-300 px-2 py-2 text-sm"
          />
          <input
            placeholder={activePlatform === "amazon" ? "ASIN" : "Goods ID"}
            value={form.asin}
            onChange={(e) => setForm((prev) => ({ ...prev, asin: e.target.value.toUpperCase() }))}
            className="rounded-lg border border-slate-300 px-2 py-2 text-sm"
          />
          {activePlatform === "amazon" ? (
            <input
              placeholder="BSR"
              value={form.bsr}
              onChange={(e) => setForm((prev) => ({ ...prev, bsr: e.target.value }))}
              type="number"
              className="rounded-lg border border-slate-300 px-2 py-2 text-sm"
            />
          ) : (
            <div />
          )}
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

      <WeekTotalsCards totals={weekTotals} />

      <div className="rounded-2xl border border-slate-200 bg-white p-3 md:hidden">
        {loading ? (
          <p className="text-sm text-slate-500">Loading performance data...</p>
        ) : pagedWeekRows.length === 0 ? (
          <p className="text-sm text-slate-500">No performance metrics saved for this account.</p>
        ) : (
          <div className="space-y-2">
            {pagedWeekRows.map(({ current, previous }) => {
              const identifier = decodeIdentifier(current.asin);
              const acos = current.ppc_spend && current.ppc_sales ? (current.ppc_spend / current.ppc_sales) * 100 : null;
              const tacos = current.ppc_spend && current.total_sales ? (current.ppc_spend / current.total_sales) * 100 : null;
              const prevAcos = previous?.ppc_spend && previous?.ppc_sales ? (previous.ppc_spend / previous.ppc_sales) * 100 : null;
              const prevTacos = previous?.ppc_spend && previous?.total_sales ? (previous.ppc_spend / previous.total_sales) * 100 : null;
              return (
                <div key={current.id} className="rounded-xl border border-slate-200 p-3 text-sm">
                  <p className="font-semibold">{current.product_name}</p>
                  <p className="text-xs text-slate-500">{weekRangeLabel(current.recorded_date)}</p>
                  <p className="mt-1">{activePlatform === "amazon" ? "ASIN" : "Goods ID"}: {identifier || "-"}</p>
                  {activePlatform === "amazon" ? (
                    <>
                      <p className={metricValueClass("bsr", current.bsr, previous?.bsr ?? null)}>BSR: {current.bsr ?? "-"}</p>
                      <p className="text-xs text-slate-500">{previousValueText(previous?.bsr ?? null)}</p>
                    </>
                  ) : null}
                  <p className={metricValueClass("reviews", current.review_count, previous?.review_count ?? null)}>Reviews: {current.review_count ?? "-"}</p>
                  <p className="text-xs text-slate-500">{previousValueText(previous?.review_count ?? null)}</p>
                  <p className={metricValueClass("rating", current.rating, previous?.rating ?? null)}>Rating: {current.rating ?? "-"}</p>
                  <p className="text-xs text-slate-500">{previousValueText(previous?.rating ?? null, (value) => value.toFixed(2))}</p>
                  <p className={metricValueClass("ppc_spend", current.ppc_spend, previous?.ppc_spend ?? null)}>PPC Spend: {current.ppc_spend == null ? "-" : Number(current.ppc_spend).toFixed(2)}</p>
                  <p className="text-xs text-slate-500">{previousValueText(previous?.ppc_spend ?? null, (value) => value.toFixed(2))}</p>
                  <p className={metricValueClass("ppc_sales", current.ppc_sales, previous?.ppc_sales ?? null)}>PPC Sales: {current.ppc_sales == null ? "-" : Number(current.ppc_sales).toFixed(2)}</p>
                  <p className="text-xs text-slate-500">{previousValueText(previous?.ppc_sales ?? null, (value) => value.toFixed(2))}</p>
                  <p className={metricValueClass("total_sales", current.total_sales, previous?.total_sales ?? null)}>Total Sales: {current.total_sales == null ? "-" : Number(current.total_sales).toFixed(2)}</p>
                  <p className="text-xs text-slate-500">{previousValueText(previous?.total_sales ?? null, (value) => value.toFixed(2))}</p>
                  <p className={metricValueClass("acos", acos, prevAcos)}>ACOS: {acos == null ? "-" : `${acos.toFixed(2)}%`}</p>
                  <p className="text-xs text-slate-500">{previousValueText(prevAcos, (value) => `${value.toFixed(2)}%`)}</p>
                  <p className={metricValueClass("tacos", tacos, prevTacos)}>TACOS: {tacos == null ? "-" : `${tacos.toFixed(2)}%`}</p>
                  <p className="text-xs text-slate-500">{previousValueText(prevTacos, (value) => `${value.toFixed(2)}%`)}</p>
                  {(() => {
                    const keyMetric = activePlatform === "amazon" ? "bsr" : "total_sales";
                    const trend = metricTrend(
                      keyMetric,
                      keyMetric === "bsr" ? current.bsr : current.total_sales,
                      keyMetric === "bsr" ? (previous?.bsr ?? null) : (previous?.total_sales ?? null)
                    );
                    const text = trendText(keyMetric, trend);
                    return text ? <p className={`text-xs ${trendClass(trend)}`}>Trend: {text}</p> : null;
                  })()}
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
              <th className="px-4 py-3">{activePlatform === "amazon" ? "ASIN" : "Goods ID"}</th>
              <th className="px-4 py-3">PPC Spend</th>
              <th className="px-4 py-3">PPC Sales</th>
              <th className="px-4 py-3">Total Sales</th>
              <th className="px-4 py-3">ACOS</th>
              <th className="px-4 py-3">TACOS</th>
              {activePlatform === "amazon" ? <th className="px-4 py-3">BSR</th> : null}
              <th className="px-4 py-3">Reviews</th>
              <th className="px-4 py-3">Rating</th>
              {canEdit ? <th className="px-4 py-3">Actions</th> : null}
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td className="px-4 py-4 text-slate-500" colSpan={canEdit ? (activePlatform === "amazon" ? 13 : 12) : activePlatform === "amazon" ? 12 : 11}>
                  Loading performance data...
                </td>
              </tr>
            ) : pagedWeekRows.length === 0 ? (
              <tr>
                <td className="px-4 py-4 text-slate-500" colSpan={canEdit ? (activePlatform === "amazon" ? 13 : 12) : activePlatform === "amazon" ? 12 : 11}>
                  No performance metrics saved for this account.
                </td>
              </tr>
            ) : (
              pagedWeekRows.map(({ current, previous }) => {
                const identifier = decodeIdentifier(current.asin);
                const acos = current.ppc_spend && current.ppc_sales ? (current.ppc_spend / current.ppc_sales) * 100 : null;
                const tacos = current.ppc_spend && current.total_sales ? (current.ppc_spend / current.total_sales) * 100 : null;
                const prevAcos = previous?.ppc_spend && previous?.ppc_sales ? (previous.ppc_spend / previous.ppc_sales) * 100 : null;
                const prevTacos = previous?.ppc_spend && previous?.total_sales ? (previous.ppc_spend / previous.total_sales) * 100 : null;
                return (
                  <tr key={current.id} className="border-t border-slate-100">
                    <td className="px-4 py-3">{weekRangeLabel(current.recorded_date)}</td>
                    <td className="px-4 py-3">{current.product_name}</td>
                    <td className="px-4 py-3">
                      {identifier ? (
                        <a
                          href={activePlatform === "amazon" ? `https://www.amazon.co.uk/dp/${identifier}` : `https://www.temu.com/goods.html?_bg_fs=1&goods_id=${identifier}`}
                          target="_blank"
                          rel="noreferrer"
                          className="text-[var(--md-primary)] underline"
                        >
                          {identifier}
                        </a>
                      ) : (
                        "-"
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <div>
                        <p className={metricValueClass("ppc_spend", current.ppc_spend, previous?.ppc_spend ?? null)}>{current.ppc_spend == null ? "-" : Number(current.ppc_spend).toFixed(2)}</p>
                        <p className="text-xs text-slate-500">{previousValueText(previous?.ppc_spend ?? null, (value) => value.toFixed(2))}</p>
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <div>
                        <p className={metricValueClass("ppc_sales", current.ppc_sales, previous?.ppc_sales ?? null)}>{current.ppc_sales == null ? "-" : Number(current.ppc_sales).toFixed(2)}</p>
                        <p className="text-xs text-slate-500">{previousValueText(previous?.ppc_sales ?? null, (value) => value.toFixed(2))}</p>
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <div>
                        <p className={metricValueClass("total_sales", current.total_sales, previous?.total_sales ?? null)}>{current.total_sales == null ? "-" : Number(current.total_sales).toFixed(2)}</p>
                        <p className="text-xs text-slate-500">{previousValueText(previous?.total_sales ?? null, (value) => value.toFixed(2))}</p>
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <div>
                        <p className={metricValueClass("acos", acos, prevAcos)}>{acos == null ? "-" : `${acos.toFixed(2)}%`}</p>
                        <p className="text-xs text-slate-500">{previousValueText(prevAcos, (value) => `${value.toFixed(2)}%`)}</p>
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <div>
                        <p className={metricValueClass("tacos", tacos, prevTacos)}>{tacos == null ? "-" : `${tacos.toFixed(2)}%`}</p>
                        <p className="text-xs text-slate-500">{previousValueText(prevTacos, (value) => `${value.toFixed(2)}%`)}</p>
                      </div>
                    </td>
                    {activePlatform === "amazon" ? (
                      <td className="px-4 py-3">
                        <div>
                          <p className={metricValueClass("bsr", current.bsr, previous?.bsr ?? null)}>{current.bsr ?? "-"}</p>
                          <p className="text-xs text-slate-500">{previousValueText(previous?.bsr ?? null)}</p>
                        </div>
                      </td>
                    ) : null}
                    <td className="px-4 py-3">
                      <div>
                        <p className={metricValueClass("reviews", current.review_count, previous?.review_count ?? null)}>{current.review_count ?? "-"}</p>
                        <p className="text-xs text-slate-500">{previousValueText(previous?.review_count ?? null)}</p>
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <div>
                        <p className={metricValueClass("rating", current.rating, previous?.rating ?? null)}>{current.rating ?? "-"}</p>
                        <p className="text-xs text-slate-500">{previousValueText(previous?.rating ?? null, (value) => value.toFixed(2))}</p>
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
      {/* end of selected week table */}

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

type TotalsValue = { cur: number | null; prev: number | null };

type WeekTotals = {
  ppcSpend: TotalsValue;
  ppcSales: TotalsValue;
  totalSales: TotalsValue;
  acos: TotalsValue;
  tacos: TotalsValue;
};

function formatNumber(value: number | null, opts: { kind: "money" | "percent" }) {
  if (value == null) return "-";
  if (opts.kind === "percent") return `${value.toFixed(2)}%`;
  return value.toFixed(2);
}

function deltaText(cur: number | null, prev: number | null, kind: "money" | "percent") {
  if (cur == null || prev == null) return "vs last week: -";
  const diff = cur - prev;
  const sign = diff > 0 ? "+" : "";
  return `vs last week: ${sign}${formatNumber(diff, { kind })} (was ${formatNumber(prev, { kind })})`;
}

function deltaClass(
  cur: number | null,
  prev: number | null,
  trend: "higher_better" | "lower_better"
) {
  if (cur == null || prev == null || cur === prev) return "text-slate-500";
  const isUp = cur > prev;
  const good = trend === "higher_better" ? isUp : !isUp;
  return good ? "text-emerald-700" : "text-rose-700";
}

function WeekTotalsCards({ totals }: { totals: WeekTotals }) {
  const cards: Array<{
    label: string;
    value: number | null;
    prev: number | null;
    kind: "money" | "percent";
    trend: "higher_better" | "lower_better";
    aggregate: "total" | "average";
  }> = [
    {
      label: "Total PPC Spend",
      value: totals.ppcSpend.cur,
      prev: totals.ppcSpend.prev,
      kind: "money",
      trend: "lower_better",
      aggregate: "total",
    },
    {
      label: "Total PPC Sales",
      value: totals.ppcSales.cur,
      prev: totals.ppcSales.prev,
      kind: "money",
      trend: "higher_better",
      aggregate: "total",
    },
    {
      label: "Total Sales",
      value: totals.totalSales.cur,
      prev: totals.totalSales.prev,
      kind: "money",
      trend: "higher_better",
      aggregate: "total",
    },
    {
      label: "Avg ACOS",
      value: totals.acos.cur,
      prev: totals.acos.prev,
      kind: "percent",
      trend: "lower_better",
      aggregate: "average",
    },
    {
      label: "Avg TACOS",
      value: totals.tacos.cur,
      prev: totals.tacos.prev,
      kind: "percent",
      trend: "lower_better",
      aggregate: "average",
    },
  ];

  return (
    <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
      {cards.map((card) => (
        <div key={card.label} className="rounded-2xl border border-slate-200 bg-white p-3">
          <p className="text-xs uppercase tracking-wide text-slate-500">{card.label}</p>
          <p className="mt-1 text-xl font-semibold text-slate-900">
            {formatNumber(card.value, { kind: card.kind })}
          </p>
          <p className={`mt-1 text-xs ${deltaClass(card.value, card.prev, card.trend)}`}>
            {deltaText(card.value, card.prev, card.kind)}
          </p>
        </div>
      ))}
    </div>
  );
}
