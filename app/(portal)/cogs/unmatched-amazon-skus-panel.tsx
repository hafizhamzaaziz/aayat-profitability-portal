"use client";

import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { fetchAllRows } from "@/lib/supabase/fetch-all";

type UnmatchedSku = {
  sku: string;
  units: number;
  lastSeen: string;
};

export default function UnmatchedAmazonSkusPanel({
  accountId,
  canEdit,
}: {
  accountId: string;
  canEdit: boolean;
}) {
  const [rows, setRows] = useState<UnmatchedSku[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    setError(null);
    const supabase = createClient();
    const [{ data: mappings }, { data: facts }] = await Promise.all([
      fetchAllRows<{ amazon_sku: string | null }>((from, to) =>
        supabase
          .from("sku_mappings")
          .select("amazon_sku")
          .eq("account_id", accountId)
          .not("amazon_sku", "is", null)
          .order("id", { ascending: true })
          .range(from, to)
      ),
      fetchAllRows<{ sku: string | null; qty: number | string | null; sale_date: string }>((from, to) =>
        supabase
          .from("inventory_sales_facts_cache")
          .select("sku, qty, sale_date")
          .eq("account_id", accountId)
          .ilike("platform", "amazon%")
          .order("sale_date", { ascending: false })
          .range(from, to)
      ),
    ]);
    const known = new Set(
      (mappings || []).map((m) => String(m.amazon_sku || "").trim().toUpperCase()).filter(Boolean)
    );
    const agg = new Map<string, UnmatchedSku>();
    for (const row of facts || []) {
      const sku = String(row.sku || "").trim().toUpperCase();
      if (!sku || known.has(sku)) continue;
      const cur = agg.get(sku) || { sku, units: 0, lastSeen: row.sale_date };
      cur.units += Number(row.qty || 0);
      if (row.sale_date > cur.lastSeen) cur.lastSeen = row.sale_date;
      agg.set(sku, cur);
    }
    setRows(Array.from(agg.values()).sort((a, b) => b.units - a.units).slice(0, 80));
    setLoading(false);
  };

  useEffect(() => {
    void load();
  }, [accountId]);

  const linkSku = async (sku: string) => {
    if (!canEdit) return;
    setSaving(sku);
    setError(null);
    const supabase = createClient();
    const { data: existing } = await supabase
      .from("sku_catalog")
      .select("id")
      .eq("account_id", accountId)
      .eq("product_name", sku)
      .maybeSingle();
    let catalogId = existing?.id as string | undefined;
    if (!catalogId) {
      const { data: catalog, error: catalogError } = await supabase
        .from("sku_catalog")
        .insert({ account_id: accountId, product_name: sku })
        .select("id")
        .single();
      if (catalogError || !catalog?.id) {
        setError(catalogError?.message || "Could not create catalog row.");
        setSaving(null);
        return;
      }
      catalogId = catalog.id;
    }
    const { error: mapError } = await supabase.from("sku_mappings").insert({
      account_id: accountId,
      sku_catalog_id: catalogId,
      amazon_sku: sku,
    });
    if (mapError) setError(mapError.message);
    setSaving(null);
    await load();
  };

  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-4">
      <h3 className="text-sm font-semibold text-slate-900">Unmatched Amazon SKUs</h3>
      <p className="mt-1 text-xs text-slate-500">
        SKUs seen on SP-API / Orders that are not linked in mappings. Linking creates a catalog row and mapping
        only — it does not invent a cost.
      </p>
      {error ? <p className="mt-2 text-sm text-red-700">{error}</p> : null}
      {loading ? (
        <p className="mt-3 text-sm text-slate-500">Loading unmatched SKUs…</p>
      ) : rows.length === 0 ? (
        <p className="mt-3 text-sm text-slate-500">All recent Amazon SKUs are linked.</p>
      ) : (
        <div className="mt-3 overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead className="text-left text-xs uppercase tracking-wide text-slate-500">
              <tr>
                <th className="py-2 pr-4">SKU</th>
                <th className="py-2 pr-4">Units (facts)</th>
                <th className="py-2 pr-4">Last seen</th>
                <th className="py-2 pr-4"></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.sku} className="border-t border-slate-100">
                  <td className="py-2 pr-4 font-mono text-xs">{row.sku}</td>
                  <td className="py-2 pr-4">{row.units.toLocaleString()}</td>
                  <td className="py-2 pr-4">{row.lastSeen}</td>
                  <td className="py-2 pr-4">
                    {canEdit ? (
                      <button
                        type="button"
                        disabled={saving === row.sku}
                        onClick={() => void linkSku(row.sku)}
                        className="rounded-lg bg-slate-100 px-3 py-1 text-xs font-semibold text-slate-700 disabled:opacity-50"
                      >
                        {saving === row.sku ? "Linking…" : "Link SKU"}
                      </button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
