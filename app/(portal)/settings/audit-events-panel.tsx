"use client";

import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";

type AuditRow = {
  id: string;
  table_name: string;
  entity_id: string | null;
  action: "insert" | "update" | "delete";
  actor_id: string | null;
  before_data: Record<string, unknown> | null;
  after_data: Record<string, unknown> | null;
  created_at: string;
};

const PAGE_SIZE = 25;

export default function AuditEventsPanel() {
  const [rows, setRows] = useState<AuditRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [offset, setOffset] = useState(0);
  const [tableFilter, setTableFilter] = useState("all");
  const [actionFilter, setActionFilter] = useState("all");
  const [dateFilter, setDateFilter] = useState("");
  const [totalCount, setTotalCount] = useState(0);
  const [actorMap, setActorMap] = useState<Record<string, string>>({});

  const totalPages = Math.max(1, Math.ceil(totalCount / PAGE_SIZE));
  const currentPage = Math.floor(offset / PAGE_SIZE) + 1;

  const describeEntity = (row: AuditRow) => {
    const data = row.after_data || row.before_data || {};
    if (row.table_name === "users") {
      const name = String(data.full_name || "");
      const email = String(data.email || "");
      if (name || email) return `${name}${name && email ? " | " : ""}${email}`;
    }
    if (row.table_name === "accounts") {
      const name = String(data.name || "");
      if (name) return name;
    }
    if (row.table_name === "reports") {
      const platform = String(data.platform || "");
      const start = String(data.period_start || "");
      const end = String(data.period_end || "");
      if (platform || start || end) return `${platform || "report"} ${start} to ${end}`;
    }
    if (row.table_name === "expenses") {
      const description = String(data.description || "");
      const amount = data.amount != null ? String(data.amount) : "";
      if (description || amount) return `${description}${amount ? ` (${amount})` : ""}`;
    }
    if (row.table_name === "performance_metrics") {
      const product = String(data.product_name || "");
      const date = String(data.recorded_date || "");
      if (product || date) return `${product}${date ? ` (${date})` : ""}`;
    }
    return row.entity_id || "-";
  };

  const loadRows = async (nextOffset = 0) => {
    setLoading(true);
    const supabase = createClient();
    let query = supabase
      .from("audit_events")
      .select("id, table_name, entity_id, action, actor_id, before_data, after_data, created_at")
      .order("created_at", { ascending: false })
      .range(nextOffset, nextOffset + PAGE_SIZE - 1);
    let countQuery = supabase.from("audit_events").select("id", { count: "exact", head: true });
    if (tableFilter !== "all") query = query.eq("table_name", tableFilter);
    if (tableFilter !== "all") countQuery = countQuery.eq("table_name", tableFilter);
    if (actionFilter !== "all") query = query.eq("action", actionFilter);
    if (actionFilter !== "all") countQuery = countQuery.eq("action", actionFilter);
    if (dateFilter) query = query.gte("created_at", `${dateFilter}T00:00:00`);
    if (dateFilter) countQuery = countQuery.gte("created_at", `${dateFilter}T00:00:00`);

    const [{ data }, { count }] = await Promise.all([query, countQuery]);
    const next = (data || []) as AuditRow[];
    setRows(next);
    setTotalCount(Number(count || 0));

    const actorIds = Array.from(new Set(next.map((row) => row.actor_id).filter(Boolean))) as string[];
    if (actorIds.length > 0) {
      const { data: users } = await supabase.from("users").select("id, full_name, email").in("id", actorIds);
      const map: Record<string, string> = {};
      (users || []).forEach((u) => {
        map[String(u.id)] = `${u.full_name} (${u.email})`;
      });
      setActorMap(map);
    } else {
      setActorMap({});
    }

    setLoading(false);
  };

  useEffect(() => {
    setOffset(0);
    void loadRows(0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tableFilter, actionFilter, dateFilter]);

  const nextPage = async () => {
    const next = offset + PAGE_SIZE;
    setOffset(next);
    await loadRows(next);
  };

  const previousPage = async () => {
    const next = Math.max(0, offset - PAGE_SIZE);
    setOffset(next);
    await loadRows(next);
  };

  return (
    <section className="rounded-2xl border border-slate-200 bg-white p-4">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h4 className="text-lg font-semibold">Audit Trail</h4>
        <button onClick={() => void loadRows(offset)} className="rounded-lg bg-slate-100 px-3 py-1 text-xs font-semibold text-slate-700">
          Refresh
        </button>
      </div>

      <div className="mb-3 grid gap-2 sm:grid-cols-3">
        <select value={tableFilter} onChange={(e) => setTableFilter(e.target.value)} className="rounded-lg border border-slate-300 px-2 py-2 text-sm">
          <option value="all">All tables</option>
          <option value="accounts">accounts</option>
          <option value="users">users</option>
          <option value="reports">reports</option>
          <option value="expenses">expenses</option>
          <option value="performance_metrics">performance_metrics</option>
        </select>
        <select value={actionFilter} onChange={(e) => setActionFilter(e.target.value)} className="rounded-lg border border-slate-300 px-2 py-2 text-sm">
          <option value="all">All actions</option>
          <option value="insert">insert</option>
          <option value="update">update</option>
          <option value="delete">delete</option>
        </select>
        <input type="date" value={dateFilter} onChange={(e) => setDateFilter(e.target.value)} className="rounded-lg border border-slate-300 px-2 py-2 text-sm" />
      </div>

      <div className="overflow-x-auto rounded-xl border border-slate-200">
        <table className="min-w-full text-sm">
          <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
            <tr>
              <th className="px-3 py-2">When</th>
              <th className="px-3 py-2">Table</th>
              <th className="px-3 py-2">Action</th>
              <th className="px-3 py-2">Details</th>
              <th className="px-3 py-2">Actor</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td className="px-3 py-3 text-slate-500" colSpan={5}>
                  Loading audit events...
                </td>
              </tr>
            ) : rows.length === 0 ? (
              <tr>
                <td className="px-3 py-3 text-slate-500" colSpan={5}>
                  No audit events found.
                </td>
              </tr>
            ) : (
              rows.map((row) => (
                <tr key={row.id} className="border-t border-slate-100">
                  <td className="px-3 py-2">{new Date(row.created_at).toLocaleString("en-GB")}</td>
                  <td className="px-3 py-2">{row.table_name}</td>
                  <td className="px-3 py-2">{row.action}</td>
                  <td className="px-3 py-2">{describeEntity(row)}</td>
                  <td className="px-3 py-2">{row.actor_id ? actorMap[row.actor_id] || row.actor_id : "-"}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <div className="mt-3 flex flex-wrap items-center justify-end gap-2">
        <span className="text-xs text-slate-500">
          Page {currentPage} of {totalPages} ({totalCount} items)
        </span>
        <select
          value={currentPage}
          onChange={(e) => {
            const targetPage = Number(e.target.value);
            const next = Math.max(0, (targetPage - 1) * PAGE_SIZE);
            setOffset(next);
            void loadRows(next);
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
          onClick={() => void previousPage()}
          disabled={offset === 0 || loading}
          className="rounded-lg bg-slate-100 px-3 py-1.5 text-xs font-semibold text-slate-700 disabled:opacity-50"
        >
          Previous
        </button>
        <button
          onClick={() => void nextPage()}
          disabled={currentPage >= totalPages || loading}
          className="rounded-lg bg-slate-100 px-3 py-1.5 text-xs font-semibold text-slate-700 disabled:opacity-50"
        >
          Next
        </button>
      </div>
    </section>
  );
}
