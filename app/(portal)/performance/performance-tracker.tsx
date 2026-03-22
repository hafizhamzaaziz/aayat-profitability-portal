"use client";

import { useEffect, useMemo, useState } from "react";
import { createClient } from "@/lib/supabase/client";

type Metric = {
  id: string;
  recorded_date: string;
  product_name: string;
  bsr: number | null;
  review_count: number | null;
  rating: number | null;
};

type FormState = {
  recorded_date: string;
  product_name: string;
  bsr: string;
  review_count: string;
  rating: string;
};

type Props = {
  accountId: string;
  canEdit: boolean;
};

function initialForm(): FormState {
  const today = new Date().toISOString().slice(0, 10);
  return {
    recorded_date: today,
    product_name: "",
    bsr: "",
    review_count: "",
    rating: "",
  };
}

export default function PerformanceTracker({ accountId, canEdit }: Props) {
  const [rows, setRows] = useState<Metric[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [form, setForm] = useState<FormState>(initialForm());

  const loadRows = async () => {
    setLoading(true);
    setError(null);
    const supabase = createClient();

    const { data, error: fetchError } = await supabase
      .from("performance_metrics")
      .select("id, recorded_date, product_name, bsr, review_count, rating")
      .eq("account_id", accountId)
      .order("recorded_date", { ascending: false });

    if (fetchError) {
      setError(fetchError.message);
      setLoading(false);
      return;
    }

    setRows((data || []) as Metric[]);
    setLoading(false);
  };

  useEffect(() => {
    void loadRows();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accountId]);

  const saveMetric = async () => {
    if (!form.product_name.trim() || !form.recorded_date) return;

    setSaving(true);
    setError(null);
    setMessage(null);

    try {
      const supabase = createClient();
      const payload = {
        account_id: accountId,
        recorded_date: form.recorded_date,
        product_name: form.product_name.trim(),
        bsr: form.bsr ? Number(form.bsr) : null,
        review_count: form.review_count ? Number(form.review_count) : null,
        rating: form.rating ? Number(form.rating) : null,
      };

      const { error: insertError } = await supabase.from("performance_metrics").insert(payload);
      if (insertError) throw insertError;

      setForm(initialForm());
      setMessage("Performance metric saved.");
      await loadRows();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save metric.");
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
      return;
    }

    await loadRows();
  };

  const trendByProduct = useMemo(() => {
    const grouped = new Map<string, Metric[]>();

    rows.forEach((row) => {
      const key = row.product_name.trim().toLowerCase();
      if (!grouped.has(key)) grouped.set(key, []);
      grouped.get(key)?.push(row);
    });

    const trends = new Map<
      string,
      {
        bsrTrend: string;
        reviewTrend: string;
      }
    >();

    grouped.forEach((items, key) => {
      const sorted = [...items].sort((a, b) => (a.recorded_date < b.recorded_date ? 1 : -1));
      const current = sorted[0];
      const previous = sorted[1];

      let bsrTrend = "No prior BSR data";
      if (current?.bsr != null && previous?.bsr != null) {
        const delta = previous.bsr - current.bsr;
        if (delta > 0) bsrTrend = `BSR improved by ${delta} since last record`;
        else if (delta < 0) bsrTrend = `BSR dropped by ${Math.abs(delta)} since last record`;
        else bsrTrend = "BSR unchanged since last record";
      }

      let reviewTrend = "No prior review data";
      if (current?.review_count != null && previous?.review_count != null) {
        const delta = current.review_count - previous.review_count;
        if (delta > 0) reviewTrend = `Reviews increased by ${delta}`;
        else if (delta < 0) reviewTrend = `Reviews decreased by ${Math.abs(delta)}`;
        else reviewTrend = "Review count unchanged";
      }

      trends.set(key, { bsrTrend, reviewTrend });
    });

    return trends;
  }, [rows]);

  return (
    <div className="space-y-4">
      {canEdit ? (
        <div className="grid gap-2 rounded-2xl border border-slate-200 bg-white p-4 md:grid-cols-[150px_1fr_120px_140px_120px_auto]">
          <input
            type="date"
            value={form.recorded_date}
            onChange={(e) => setForm((prev) => ({ ...prev, recorded_date: e.target.value }))}
            className="rounded-lg border border-slate-300 px-2 py-2 text-sm"
          />
          <input
            placeholder="Product name"
            value={form.product_name}
            onChange={(e) => setForm((prev) => ({ ...prev, product_name: e.target.value }))}
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
          <button
            onClick={saveMetric}
            disabled={saving}
            className="rounded-lg bg-[var(--md-primary)] px-3 py-2 text-sm font-semibold text-white disabled:opacity-60"
          >
            {saving ? "Saving..." : "Add"}
          </button>
        </div>
      ) : (
        <p className="rounded-2xl bg-slate-100 px-3 py-2 text-sm text-slate-700">
          Client view is read-only. Team/Admin can log new performance rows.
        </p>
      )}

      {message ? <p className="rounded-xl bg-green-50 px-3 py-2 text-sm text-green-700">{message}</p> : null}
      {error ? <p className="rounded-xl bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p> : null}

      <div className="overflow-x-auto rounded-2xl border border-slate-200 bg-white">
        <table className="min-w-full text-sm">
          <thead className="text-left text-xs uppercase tracking-wide text-slate-500">
            <tr>
              <th className="px-4 py-3">Date</th>
              <th className="px-4 py-3">Product</th>
              <th className="px-4 py-3">BSR</th>
              <th className="px-4 py-3">Reviews</th>
              <th className="px-4 py-3">Rating</th>
              <th className="px-4 py-3">Trends</th>
              {canEdit ? <th className="px-4 py-3">Actions</th> : null}
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td className="px-4 py-4 text-slate-500" colSpan={canEdit ? 7 : 6}>
                  Loading performance data...
                </td>
              </tr>
            ) : rows.length === 0 ? (
              <tr>
                <td className="px-4 py-4 text-slate-500" colSpan={canEdit ? 7 : 6}>
                  No performance metrics saved for this account.
                </td>
              </tr>
            ) : (
              rows.map((row) => {
                const trend = trendByProduct.get(row.product_name.trim().toLowerCase());
                return (
                  <tr key={row.id} className="border-t border-slate-100">
                    <td className="px-4 py-3">{row.recorded_date}</td>
                    <td className="px-4 py-3">{row.product_name}</td>
                    <td className="px-4 py-3">{row.bsr ?? "-"}</td>
                    <td className="px-4 py-3">{row.review_count ?? "-"}</td>
                    <td className="px-4 py-3">{row.rating ?? "-"}</td>
                    <td className="px-4 py-3">
                      <div className="space-y-1 text-xs text-slate-600">
                        <p>{trend?.bsrTrend ?? "No trend"}</p>
                        <p>{trend?.reviewTrend ?? "No trend"}</p>
                      </div>
                    </td>
                    {canEdit ? (
                      <td className="px-4 py-3">
                        <button
                          onClick={() => deleteMetric(row.id)}
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
    </div>
  );
}
