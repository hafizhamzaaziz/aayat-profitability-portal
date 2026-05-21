"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { migrateLegacyExpensesForAccount } from "@/lib/reports/expense-migration";

type ExpenseRow = {
  id: string;
  description: string;
  expense_date: string;
  amount: number;
  includes_vat: boolean;
  marketplace: "amazon" | "temu" | "tiktok";
  expense_type: "one_time" | "recurring";
  recurring_end_date: string | null;
};

type Props = {
  accountId: string;
  canEdit: boolean;
  currency: string;
};

type ExpenseDraft = {
  description: string;
  expense_date: string;
  amount: string;
  includes_vat: boolean;
  marketplace: ExpenseRow["marketplace"];
  expense_type: ExpenseRow["expense_type"];
  recurring_end_date: string;
};

const emptyDraft: ExpenseDraft = {
  description: "",
  expense_date: "",
  amount: "",
  includes_vat: false,
  marketplace: "amazon" as const,
  expense_type: "one_time" as const,
  recurring_end_date: "",
};

export default function ExpensesPanel({ accountId, canEdit, currency }: Props) {
  const [rows, setRows] = useState<ExpenseRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [draft, setDraft] = useState<ExpenseDraft>(emptyDraft);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingDraft, setEditingDraft] = useState<ExpenseDraft>(emptyDraft);

  const totals = useMemo(() => {
    let amazon = 0;
    let temu = 0;
    let tiktok = 0;
    for (const row of rows) {
      if (row.marketplace === "amazon") amazon += Number(row.amount || 0);
      else if (row.marketplace === "temu") temu += Number(row.amount || 0);
      else tiktok += Number(row.amount || 0);
    }
    return { amazon, temu, tiktok, all: amazon + temu + tiktok };
  }, [rows]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const supabase = createClient();
    const { data, error: fetchError } = await supabase
      .from("expense_ledger")
      .select("id, description, expense_date, amount, includes_vat, marketplace, expense_type, recurring_end_date")
      .eq("account_id", accountId)
      .order("expense_date", { ascending: false });
    if (fetchError) {
      setError(fetchError.message);
      setLoading(false);
      return;
    }
    setRows((data || []) as ExpenseRow[]);
    setLoading(false);
  }, [accountId]);

  useEffect(() => {
    void load();
  }, [load]);

  const saveDraft = async () => {
    if (!canEdit) return;
    const amount = Number(draft.amount || 0);
    if (!draft.description.trim()) {
      setError("Expense detail is required.");
      return;
    }
    if (!draft.expense_date) {
      setError("Expense date is required.");
      return;
    }
    if (!Number.isFinite(amount) || amount === 0) {
      setError("Expense amount must be non-zero.");
      return;
    }
    if (draft.expense_type === "recurring" && draft.recurring_end_date && draft.recurring_end_date < draft.expense_date) {
      setError("Recurring end date cannot be before expense date.");
      return;
    }

    setSaving(true);
    setError(null);
    const supabase = createClient();
    const payload = {
      account_id: accountId,
      description: draft.description.trim(),
      expense_date: draft.expense_date,
      amount: Number(amount.toFixed(2)),
      includes_vat: draft.includes_vat,
      marketplace: draft.marketplace,
      expense_type: draft.expense_type,
      recurring_end_date: draft.expense_type === "recurring" ? (draft.recurring_end_date || null) : null,
    };
    const { error: insError } = await supabase.from("expense_ledger").insert(payload);
    if (insError) {
      setError(insError.message);
      setSaving(false);
      return;
    }
    setMessage("Expense added.");
    setDraft(emptyDraft);
    await load();
    setSaving(false);
  };

  const beginEdit = (row: ExpenseRow) => {
    setEditingId(row.id);
    setEditingDraft({
      description: row.description,
      expense_date: row.expense_date,
      amount: String(Number(row.amount || 0)),
      includes_vat: Boolean(row.includes_vat),
      marketplace: row.marketplace,
      expense_type: row.expense_type,
      recurring_end_date: row.recurring_end_date || "",
    });
  };

  const saveEdit = async () => {
    if (!canEdit || !editingId) return;
    const amount = Number(editingDraft.amount || 0);
    if (!editingDraft.description.trim()) {
      setError("Expense detail is required.");
      return;
    }
    if (!editingDraft.expense_date) {
      setError("Expense date is required.");
      return;
    }
    if (!Number.isFinite(amount) || amount === 0) {
      setError("Expense amount must be non-zero.");
      return;
    }
    if (
      editingDraft.expense_type === "recurring" &&
      editingDraft.recurring_end_date &&
      editingDraft.recurring_end_date < editingDraft.expense_date
    ) {
      setError("Recurring end date cannot be before expense date.");
      return;
    }

    setSaving(true);
    setError(null);
    const supabase = createClient();
    const { error: updError } = await supabase
      .from("expense_ledger")
      .update({
        description: editingDraft.description.trim(),
        expense_date: editingDraft.expense_date,
        amount: Number(amount.toFixed(2)),
        includes_vat: editingDraft.includes_vat,
        marketplace: editingDraft.marketplace,
        expense_type: editingDraft.expense_type,
        recurring_end_date:
          editingDraft.expense_type === "recurring" ? editingDraft.recurring_end_date || null : null,
      })
      .eq("id", editingId);
    if (updError) {
      setError(updError.message);
      setSaving(false);
      return;
    }
    setMessage("Expense updated.");
    setEditingId(null);
    await load();
    setSaving(false);
  };

  const runLegacyMigration = async () => {
    if (!canEdit) return;
    setSaving(true);
    setError(null);
    const supabase = createClient();
    try {
      const migrated = await migrateLegacyExpensesForAccount(supabase, accountId);
      setMessage(migrated > 0 ? `Migrated ${migrated} legacy expense row(s).` : "No legacy expenses left to migrate.");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to migrate legacy expenses.");
    } finally {
      setSaving(false);
    }
  };

  const remove = async (id: string) => {
    if (!canEdit) return;
    if (!window.confirm("Delete this expense?")) return;
    setSaving(true);
    setError(null);
    const supabase = createClient();
    const { error: delError } = await supabase.from("expense_ledger").delete().eq("id", id);
    if (delError) {
      setError(delError.message);
      setSaving(false);
      return;
    }
    setMessage("Expense deleted.");
    await load();
    setSaving(false);
  };

  return (
    <div className="space-y-3 rounded-2xl border border-slate-200 bg-white p-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-slate-800">Expenses</h3>
        <div className="flex items-center gap-3">
          <p className="text-xs text-slate-500">
            Total: {currency}{totals.all.toFixed(2)} (Amazon {currency}{totals.amazon.toFixed(2)} / Temu {currency}{totals.temu.toFixed(2)} / TikTok {currency}{totals.tiktok.toFixed(2)})
          </p>
          {canEdit ? (
            <button
              type="button"
              onClick={() => void runLegacyMigration()}
              disabled={saving}
              className="rounded-lg bg-slate-100 px-2 py-1 text-xs font-semibold text-slate-700 disabled:opacity-60"
            >
              Migrate old report expenses
            </button>
          ) : null}
        </div>
      </div>

      <div className="grid gap-2 md:grid-cols-[1.4fr_140px_140px_120px_120px_140px]">
        <input
          value={draft.description}
          onChange={(e) => setDraft((p) => ({ ...p, description: e.target.value }))}
          placeholder="Expense Detail"
          className="rounded-lg border border-slate-300 px-3 py-2 text-sm"
          disabled={!canEdit}
        />
        <input
          type="date"
          value={draft.expense_date}
          onChange={(e) => setDraft((p) => ({ ...p, expense_date: e.target.value }))}
          className="rounded-lg border border-slate-300 px-3 py-2 text-sm"
          disabled={!canEdit}
        />
        <input
          type="number"
          step="0.01"
          value={draft.amount}
          onChange={(e) => setDraft((p) => ({ ...p, amount: e.target.value }))}
          placeholder="Amount"
          className="rounded-lg border border-slate-300 px-3 py-2 text-sm"
          disabled={!canEdit}
        />
        <select
          value={draft.marketplace}
          onChange={(e) => setDraft((p) => ({ ...p, marketplace: e.target.value as ExpenseRow["marketplace"] }))}
          className="rounded-lg border border-slate-300 px-3 py-2 text-sm"
          disabled={!canEdit}
        >
          <option value="amazon">Amazon</option>
          <option value="temu">Temu</option>
          <option value="tiktok">TikTok</option>
        </select>
        <select
          value={draft.expense_type}
          onChange={(e) => setDraft((p) => ({ ...p, expense_type: e.target.value as ExpenseRow["expense_type"] }))}
          className="rounded-lg border border-slate-300 px-3 py-2 text-sm"
          disabled={!canEdit}
        >
          <option value="one_time">One Time</option>
          <option value="recurring">Recurring</option>
        </select>
        <input
          type="date"
          value={draft.recurring_end_date}
          onChange={(e) => setDraft((p) => ({ ...p, recurring_end_date: e.target.value }))}
          className="rounded-lg border border-slate-300 px-3 py-2 text-sm"
          disabled={!canEdit || draft.expense_type !== "recurring"}
          placeholder="Recurring end (optional)"
        />
      </div>
      <div className="flex items-center justify-between">
        <label className="inline-flex items-center gap-2 text-xs text-slate-600">
          <input
            type="checkbox"
            checked={draft.includes_vat}
            onChange={(e) => setDraft((p) => ({ ...p, includes_vat: e.target.checked }))}
            disabled={!canEdit}
          />
          Includes VAT
        </label>
        {canEdit ? (
          <button
            type="button"
            onClick={() => void saveDraft()}
            disabled={saving}
            className="rounded-xl bg-[var(--md-primary)] px-4 py-2 text-sm font-semibold text-white disabled:opacity-60"
          >
            {saving ? "Saving..." : "Add Expense"}
          </button>
        ) : null}
      </div>

      {message ? <p className="rounded-lg bg-green-50 px-3 py-2 text-sm text-green-700">{message}</p> : null}
      {error ? <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p> : null}

      {loading ? (
        <p className="text-sm text-slate-500">Loading expenses...</p>
      ) : rows.length === 0 ? (
        <p className="text-sm text-slate-500">No expenses yet.</p>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-slate-200">
          <table className="min-w-full text-sm">
            <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-3 py-2 text-left">Detail</th>
                <th className="px-3 py-2 text-left">Date</th>
                <th className="px-3 py-2 text-left">Amount</th>
                <th className="px-3 py-2 text-left">Incl VAT</th>
                <th className="px-3 py-2 text-left">Marketplace</th>
                <th className="px-3 py-2 text-left">Type</th>
                <th className="px-3 py-2 text-left">End Date</th>
                <th className="px-3 py-2 text-right">Action</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const isEditing = editingId === row.id;
                return (
                  <tr key={row.id} className="border-t border-slate-100">
                    <td className="px-3 py-2">
                      {isEditing ? (
                        <input
                          value={editingDraft.description}
                          onChange={(e) => setEditingDraft((p) => ({ ...p, description: e.target.value }))}
                          className="w-full rounded border border-slate-300 px-2 py-1 text-sm"
                        />
                      ) : (
                        row.description
                      )}
                    </td>
                    <td className="px-3 py-2">
                      {isEditing ? (
                        <input
                          type="date"
                          value={editingDraft.expense_date}
                          onChange={(e) => setEditingDraft((p) => ({ ...p, expense_date: e.target.value }))}
                          className="rounded border border-slate-300 px-2 py-1 text-sm"
                        />
                      ) : (
                        row.expense_date
                      )}
                    </td>
                    <td className="px-3 py-2">
                      {isEditing ? (
                        <input
                          type="number"
                          step="0.01"
                          value={editingDraft.amount}
                          onChange={(e) => setEditingDraft((p) => ({ ...p, amount: e.target.value }))}
                          className="w-28 rounded border border-slate-300 px-2 py-1 text-sm"
                        />
                      ) : (
                        `${currency}${Number(row.amount || 0).toFixed(2)}`
                      )}
                    </td>
                    <td className="px-3 py-2">
                      {isEditing ? (
                        <label className="inline-flex items-center gap-1 text-xs">
                          <input
                            type="checkbox"
                            checked={editingDraft.includes_vat}
                            onChange={(e) => setEditingDraft((p) => ({ ...p, includes_vat: e.target.checked }))}
                          />
                          Yes
                        </label>
                      ) : row.includes_vat ? (
                        "Yes"
                      ) : (
                        "No"
                      )}
                    </td>
                    <td className="px-3 py-2 capitalize">
                      {isEditing ? (
                        <select
                          value={editingDraft.marketplace}
                          onChange={(e) =>
                            setEditingDraft((p) => ({ ...p, marketplace: e.target.value as ExpenseRow["marketplace"] }))
                          }
                          className="rounded border border-slate-300 px-2 py-1 text-sm"
                        >
                          <option value="amazon">Amazon</option>
                          <option value="temu">Temu</option>
                          <option value="tiktok">TikTok</option>
                        </select>
                      ) : (
                        row.marketplace
                      )}
                    </td>
                    <td className="px-3 py-2">
                      {isEditing ? (
                        <select
                          value={editingDraft.expense_type}
                          onChange={(e) =>
                            setEditingDraft((p) => ({ ...p, expense_type: e.target.value as ExpenseRow["expense_type"] }))
                          }
                          className="rounded border border-slate-300 px-2 py-1 text-sm"
                        >
                          <option value="one_time">One Time</option>
                          <option value="recurring">Recurring</option>
                        </select>
                      ) : row.expense_type === "recurring" ? (
                        "Recurring"
                      ) : (
                        "One Time"
                      )}
                    </td>
                    <td className="px-3 py-2">
                      {isEditing ? (
                        <input
                          type="date"
                          value={editingDraft.recurring_end_date}
                          onChange={(e) => setEditingDraft((p) => ({ ...p, recurring_end_date: e.target.value }))}
                          disabled={editingDraft.expense_type !== "recurring"}
                          className="rounded border border-slate-300 px-2 py-1 text-sm disabled:bg-slate-100"
                        />
                      ) : (
                        row.recurring_end_date || "—"
                      )}
                    </td>
                    <td className="px-3 py-2 text-right">
                      {canEdit ? (
                        <div className="inline-flex gap-2">
                          {isEditing ? (
                            <>
                              <button
                                type="button"
                                onClick={() => void saveEdit()}
                                className="rounded-lg bg-[var(--md-primary)] px-2 py-1 text-xs font-semibold text-white"
                              >
                                Save
                              </button>
                              <button
                                type="button"
                                onClick={() => setEditingId(null)}
                                className="rounded-lg bg-slate-100 px-2 py-1 text-xs font-semibold text-slate-700"
                              >
                                Cancel
                              </button>
                            </>
                          ) : (
                            <button
                              type="button"
                              onClick={() => beginEdit(row)}
                              className="rounded-lg bg-slate-100 px-2 py-1 text-xs font-semibold text-slate-700"
                            >
                              Edit
                            </button>
                          )}
                          <button
                            type="button"
                            onClick={() => void remove(row.id)}
                            className="rounded-lg bg-red-50 px-2 py-1 text-xs font-semibold text-red-700"
                          >
                            Delete
                          </button>
                        </div>
                      ) : (
                        "—"
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
