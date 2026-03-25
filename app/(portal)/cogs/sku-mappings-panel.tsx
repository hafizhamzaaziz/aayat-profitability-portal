"use client";

import { useEffect, useMemo, useState } from "react";
import { createClient } from "@/lib/supabase/client";

type MappingRow = {
  id: string;
  sku_catalog_id: string;
  product_name: string;
  amazon_sku: string | null;
  temu_sku_id: string | null;
  lead_time_days: number | null;
  created_at: string;
};

type Props = {
  accountId: string;
  canEdit: boolean;
};

export default function SkuMappingsPanel({ accountId, canEdit }: Props) {
  const [rows, setRows] = useState<MappingRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [form, setForm] = useState({
    product_name: "",
    amazon_sku: "",
    temu_sku_id: "",
    lead_time_days: "",
  });

  const loadRows = async () => {
    setLoading(true);
    setError(null);
    const supabase = createClient();
    const { data, error: fetchError } = await supabase
      .from("sku_mappings")
      .select("id, sku_catalog_id, amazon_sku, temu_sku_id, lead_time_days, created_at, sku_catalog:sku_catalog_id(product_name)")
      .eq("account_id", accountId)
      .order("created_at", { ascending: false });
    if (fetchError) {
      setError(fetchError.message);
      setLoading(false);
      return;
    }
    const mapped = (data || []).map((row) => {
      const rec = row as unknown as {
        id: string;
        sku_catalog_id: string;
        amazon_sku: string | null;
        temu_sku_id: string | null;
        lead_time_days: number | null;
        created_at: string;
        sku_catalog?: { product_name?: string } | null;
      };
      return {
        id: rec.id,
        sku_catalog_id: rec.sku_catalog_id,
        product_name: rec.sku_catalog?.product_name || "Unnamed product",
        amazon_sku: rec.amazon_sku,
        temu_sku_id: rec.temu_sku_id,
        lead_time_days: rec.lead_time_days,
        created_at: rec.created_at,
      } as MappingRow;
    });
    setRows(mapped);
    setLoading(false);
  };

  useEffect(() => {
    void loadRows();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accountId]);

  const filtered = useMemo(() => {
    if (!search.trim()) return rows;
    const s = search.trim().toLowerCase();
    return rows.filter((row) => {
      return (
        row.product_name.toLowerCase().includes(s) ||
        String(row.amazon_sku || "")
          .toLowerCase()
          .includes(s) ||
        String(row.temu_sku_id || "")
          .toLowerCase()
          .includes(s)
      );
    });
  }, [rows, search]);

  const createMapping = async () => {
    if (!canEdit) return;
    if (!form.product_name.trim()) {
      setError("Product name is required.");
      return;
    }
    if (!form.amazon_sku.trim() && !form.temu_sku_id.trim()) {
      setError("Add at least Amazon SKU or Temu SKU ID.");
      return;
    }

    setError(null);
    setMessage(null);
    const supabase = createClient();
    const { data: catalog, error: catalogError } = await supabase
      .from("sku_catalog")
      .insert({
        account_id: accountId,
        product_name: form.product_name.trim(),
      })
      .select("id")
      .single();
    if (catalogError || !catalog?.id) {
      setError(catalogError?.message || "Failed to create product.");
      return;
    }

    const { error: mappingError } = await supabase.from("sku_mappings").insert({
      account_id: accountId,
      sku_catalog_id: catalog.id,
      amazon_sku: form.amazon_sku.trim().toUpperCase() || null,
      temu_sku_id: form.temu_sku_id.trim().toUpperCase() || null,
      lead_time_days: form.lead_time_days ? Number(form.lead_time_days) : null,
    });
    if (mappingError) {
      setError(mappingError.message);
      return;
    }
    setForm({ product_name: "", amazon_sku: "", temu_sku_id: "", lead_time_days: "" });
    setMessage("SKU mapping created.");
    await loadRows();
  };

  const saveRow = async (row: MappingRow) => {
    if (!canEdit) return;
    const supabase = createClient();
    const { error: catalogError } = await supabase
      .from("sku_catalog")
      .update({ product_name: row.product_name.trim() })
      .eq("id", row.sku_catalog_id);
    if (catalogError) {
      setError(catalogError.message);
      return;
    }
    const { error: mappingError } = await supabase
      .from("sku_mappings")
      .update({
        amazon_sku: row.amazon_sku?.trim().toUpperCase() || null,
        temu_sku_id: row.temu_sku_id?.trim().toUpperCase() || null,
        lead_time_days: row.lead_time_days ?? null,
      })
      .eq("id", row.id);
    if (mappingError) {
      setError(mappingError.message);
      return;
    }
    setMessage("SKU mapping updated.");
    await loadRows();
  };

  const deleteRow = async (row: MappingRow) => {
    if (!canEdit) return;
    const supabase = createClient();
    const { error: mappingError } = await supabase.from("sku_mappings").delete().eq("id", row.id);
    if (mappingError) {
      setError(mappingError.message);
      return;
    }
    await supabase.from("sku_catalog").delete().eq("id", row.sku_catalog_id);
    setMessage("SKU mapping deleted.");
    await loadRows();
  };

  return (
    <section className="space-y-3 rounded-2xl border border-slate-200 bg-white p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-slate-800">SKU Mapping (Amazon SKU ↔ Temu SKU ID)</h3>
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search product or SKU"
          className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm sm:w-72"
        />
      </div>

      {canEdit ? (
        <div className="grid gap-2 rounded-xl border border-slate-200 bg-slate-50 p-3 md:grid-cols-[1fr_1fr_1fr_140px_auto]">
          <input
            value={form.product_name}
            onChange={(e) => setForm((prev) => ({ ...prev, product_name: e.target.value }))}
            placeholder="Product name"
            className="rounded-lg border border-slate-300 px-3 py-2 text-sm"
          />
          <input
            value={form.amazon_sku}
            onChange={(e) => setForm((prev) => ({ ...prev, amazon_sku: e.target.value.toUpperCase() }))}
            placeholder="Amazon SKU"
            className="rounded-lg border border-slate-300 px-3 py-2 text-sm"
          />
          <input
            value={form.temu_sku_id}
            onChange={(e) => setForm((prev) => ({ ...prev, temu_sku_id: e.target.value.toUpperCase() }))}
            placeholder="Temu SKU ID"
            className="rounded-lg border border-slate-300 px-3 py-2 text-sm"
          />
          <input
            value={form.lead_time_days}
            onChange={(e) => setForm((prev) => ({ ...prev, lead_time_days: e.target.value }))}
            placeholder="Lead time (days)"
            type="number"
            className="rounded-lg border border-slate-300 px-3 py-2 text-sm"
          />
          <button onClick={() => void createMapping()} className="rounded-lg bg-[var(--md-primary)] px-3 py-2 text-sm font-semibold text-white">
            Add mapping
          </button>
        </div>
      ) : null}

      {message ? <p className="rounded-xl bg-green-50 px-3 py-2 text-sm text-green-700">{message}</p> : null}
      {error ? <p className="rounded-xl bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p> : null}

      <div className="overflow-x-auto rounded-xl border border-slate-200">
        <table className="min-w-full text-sm">
          <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
            <tr>
              <th className="px-3 py-2">Product</th>
              <th className="px-3 py-2">Amazon SKU</th>
              <th className="px-3 py-2">Temu SKU ID</th>
              <th className="px-3 py-2">Lead Time (days)</th>
              {canEdit ? <th className="px-3 py-2">Actions</th> : null}
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td className="px-3 py-3 text-slate-500" colSpan={canEdit ? 5 : 4}>
                  Loading mappings...
                </td>
              </tr>
            ) : filtered.length === 0 ? (
              <tr>
                <td className="px-3 py-3 text-slate-500" colSpan={canEdit ? 5 : 4}>
                  No mappings found.
                </td>
              </tr>
            ) : (
              filtered.map((row, idx) => (
                <EditableMappingRow
                  key={row.id}
                  row={row}
                  canEdit={canEdit}
                  onChange={(patch) => {
                    setRows((prev) => {
                      const next = [...prev];
                      const targetIdx = next.findIndex((r) => r.id === row.id);
                      if (targetIdx < 0) return prev;
                      next[targetIdx] = { ...next[targetIdx], ...patch };
                      return next;
                    });
                  }}
                  onSave={() => void saveRow(rows.find((r) => r.id === row.id) || row)}
                  onDelete={() => void deleteRow(row)}
                  className={idx % 2 ? "bg-white" : "bg-slate-50/30"}
                />
              ))
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function EditableMappingRow({
  row,
  canEdit,
  onChange,
  onSave,
  onDelete,
  className,
}: {
  row: MappingRow;
  canEdit: boolean;
  onChange: (patch: Partial<MappingRow>) => void;
  onSave: () => void;
  onDelete: () => void;
  className?: string;
}) {
  return (
    <tr className={className}>
      <td className="px-3 py-2">
        {canEdit ? (
          <input
            value={row.product_name}
            onChange={(e) => onChange({ product_name: e.target.value })}
            className="w-full rounded-lg border border-slate-300 px-2 py-1"
          />
        ) : (
          row.product_name
        )}
      </td>
      <td className="px-3 py-2">
        {canEdit ? (
          <input
            value={row.amazon_sku || ""}
            onChange={(e) => onChange({ amazon_sku: e.target.value.toUpperCase() || null })}
            className="w-full rounded-lg border border-slate-300 px-2 py-1"
          />
        ) : (
          row.amazon_sku || "-"
        )}
      </td>
      <td className="px-3 py-2">
        {canEdit ? (
          <input
            value={row.temu_sku_id || ""}
            onChange={(e) => onChange({ temu_sku_id: e.target.value.toUpperCase() || null })}
            className="w-full rounded-lg border border-slate-300 px-2 py-1"
          />
        ) : (
          row.temu_sku_id || "-"
        )}
      </td>
      <td className="px-3 py-2">
        {canEdit ? (
          <input
            type="number"
            value={row.lead_time_days ?? ""}
            onChange={(e) => onChange({ lead_time_days: e.target.value ? Number(e.target.value) : null })}
            className="w-full rounded-lg border border-slate-300 px-2 py-1"
          />
        ) : (
          row.lead_time_days ?? "-"
        )}
      </td>
      {canEdit ? (
        <td className="px-3 py-2">
          <div className="flex gap-2">
            <button onClick={onSave} className="rounded-lg bg-slate-900 px-3 py-1 text-xs font-semibold text-white">
              Save
            </button>
            <button onClick={onDelete} className="rounded-lg bg-red-50 px-3 py-1 text-xs font-semibold text-red-700">
              Delete
            </button>
          </div>
        </td>
      ) : null}
    </tr>
  );
}
