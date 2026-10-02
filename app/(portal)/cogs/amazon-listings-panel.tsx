"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { fetchAllRows } from "@/lib/supabase/fetch-all";
import { applyCogsVersion } from "@/lib/cogs/apply-cogs-version";

type ListingRow = {
  marketplace_id: string;
  seller_sku: string;
  asin: string | null;
  title: string | null;
  price: number | null;
  quantity: number | null;
  fulfillment_channel: string | null;
  status: string | null;
  synced_at: string;
};

type MappingRow = { id: string; amazon_sku: string | null; amazon_asin: string | null; sku_catalog: unknown };
type CogsRow = { sku: string; unit_cost: number; includes_vat: boolean; sku_mapping_id: string | null };

type SkuView = {
  sku: string;
  asin: string | null;
  title: string;
  productName: string | null;
  mappingId: string | null;
  marketplaces: string[];
  channel: "fba" | "fbm" | "both";
  status: "Active" | "Inactive" | "Incomplete" | "Unknown";
  price: number | null;
  priceMarketplace: string | null;
  cost: number | null;
  costIncludesVat: boolean;
};

const MARKET_LABEL: Record<string, string> = {
  A1F83G8C2ARO7P: "UK",
  A1PA6795UKMFR9: "DE",
  A13V1IB3VIYZZH: "FR",
  APJ6JRA9NG5V4: "IT",
  A1RKKUPIHCS9HS: "ES",
  A1805IZSGTT6HS: "NL",
  A2NODRKZP88ZB9: "SE",
  A1C3SOZRARQ6R3: "PL",
  AMEN7PMS3EDWL: "BE",
  A2VIGQ35RCS4UG: "AE",
  A17E79C6D8DWNP: "SA",
  A33AVAJ2PDY3EV: "TR",
  ARBP9OOSHTCHU: "EG",
  A21TJRUUN4KGV: "IN",
  ATVPDKIKX0DER: "US",
  A2EUQ1WTGCTBG2: "CA",
  A1AM78C64UM0Y8: "MX",
  A2Q3Y263D00KWC: "BR",
  A1VC38T7YXB528: "JP",
  A39IBJ37TRP1C6: "AU",
  A19VAU5U5O7RUS: "SG",
};
const HOME = "A1F83G8C2ARO7P";

function marketLabel(id: string) {
  return MARKET_LABEL[id] || id.slice(0, 6);
}

function fmtMoney(v: number | null) {
  return v == null ? "—" : `£${v.toFixed(2)}`;
}

export default function AmazonListingsPanel({ accountId, canEdit }: { accountId: string; canEdit: boolean }) {
  const [rows, setRows] = useState<SkuView[]>([]);
  const [syncedAt, setSyncedAt] = useState<string | null>(null);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [connected, setConnected] = useState<boolean>(true);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<"all" | "active" | "inactive">("active");
  const [channelFilter, setChannelFilter] = useState<"all" | "fba" | "fbm">("all");
  const [onlyMissing, setOnlyMissing] = useState(false);
  const [editing, setEditing] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const supabase = createClient();
      const [listingsRes, mappingsRes, cogsRes, credRes] = await Promise.all([
        fetchAllRows<ListingRow>((from, to) =>
          supabase
            .from("amazon_listings")
            .select("marketplace_id, seller_sku, asin, title, price, quantity, fulfillment_channel, status, synced_at")
            .eq("account_id", accountId)
            .order("seller_sku", { ascending: true })
            .order("marketplace_id", { ascending: true })
            .range(from, to)
        ),
        fetchAllRows<MappingRow>((from, to) =>
          supabase
            .from("sku_mappings")
            .select("id, amazon_sku, amazon_asin, sku_catalog:sku_catalog_id(product_name)")
            .eq("account_id", accountId)
            .not("amazon_sku", "is", null)
            .order("id", { ascending: true })
            .range(from, to)
        ),
        fetchAllRows<CogsRow>((from, to) =>
          supabase.from("cogs").select("sku, unit_cost, includes_vat, sku_mapping_id").eq("account_id", accountId).order("sku", { ascending: true }).range(from, to)
        ),
        supabase.from("account_amazon_credentials").select("listings_synced_at, listings_sync_error, refresh_token_encrypted").eq("account_id", accountId).eq("provider", "sp-api").maybeSingle(),
      ]);
      if (listingsRes.error) throw listingsRes.error;
      if (mappingsRes.error) throw mappingsRes.error;
      if (cogsRes.error) throw cogsRes.error;

      const cred = credRes.data as { listings_synced_at?: string | null; listings_sync_error?: string | null; refresh_token_encrypted?: string | null } | null;
      setSyncedAt(cred?.listings_synced_at || null);
      setSyncError(cred?.listings_sync_error || null);
      setConnected(!!cred?.refresh_token_encrypted);

      const mappingBySku = new Map<string, { id: string; asin: string | null; productName: string | null }>();
      for (const m of mappingsRes.data || []) {
        const name = ((Array.isArray(m.sku_catalog) ? m.sku_catalog[0] : m.sku_catalog) as { product_name?: string } | null)?.product_name || null;
        mappingBySku.set(String(m.amazon_sku).trim().toUpperCase(), { id: m.id, asin: m.amazon_asin, productName: name });
      }
      const costBySku = new Map<string, CogsRow>();
      const costByMapping = new Map<string, CogsRow>();
      for (const c of cogsRes.data || []) {
        costBySku.set(String(c.sku).trim().toUpperCase(), c);
        if (c.sku_mapping_id) costByMapping.set(c.sku_mapping_id, c);
      }

      const grouped = new Map<string, ListingRow[]>();
      for (const l of listingsRes.data || []) {
        const key = l.seller_sku.trim().toUpperCase();
        grouped.set(key, [...(grouped.get(key) || []), l]);
      }

      const views: SkuView[] = [];
      for (const [key, list] of grouped) {
        const home = list.find((l) => l.marketplace_id === HOME) || list.find((l) => l.status === "Active") || list[0];
        const mapping = mappingBySku.get(key) || null;
        const cost = costBySku.get(key) || (mapping ? costByMapping.get(mapping.id) : undefined) || null;
        const channels = new Set(list.map((l) => l.fulfillment_channel));
        const statuses = new Set(list.map((l) => l.status));
        views.push({
          sku: home.seller_sku,
          asin: home.asin || mapping?.asin || list.find((l) => l.asin)?.asin || null,
          title: home.title || list.find((l) => l.title)?.title || "",
          productName: mapping?.productName || null,
          mappingId: mapping?.id || null,
          marketplaces: Array.from(new Set(list.map((l) => l.marketplace_id))).sort((a, b) => (a === HOME ? -1 : b === HOME ? 1 : marketLabel(a).localeCompare(marketLabel(b)))),
          channel: channels.has("fba") && channels.has("fbm") ? "both" : channels.has("fba") ? "fba" : "fbm",
          status: statuses.has("Active") ? "Active" : statuses.has("Incomplete") ? "Incomplete" : statuses.has("Inactive") ? "Inactive" : "Unknown",
          price: home.price,
          priceMarketplace: home.price == null ? null : home.marketplace_id,
          cost: cost ? Number(cost.unit_cost) : null,
          costIncludesVat: !!cost?.includes_vat,
        });
      }
      views.sort((a, b) => (a.status === b.status ? a.sku.localeCompare(b.sku) : a.status === "Active" ? -1 : b.status === "Active" ? 1 : a.sku.localeCompare(b.sku)));
      setRows(views);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load Amazon listings.");
    } finally {
      setLoading(false);
    }
  }, [accountId]);

  useEffect(() => {
    void load();
  }, [load]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return rows.filter((r) => {
      if (statusFilter === "active" && r.status !== "Active") return false;
      if (statusFilter === "inactive" && r.status === "Active") return false;
      if (channelFilter !== "all" && r.channel !== "both" && r.channel !== channelFilter) return false;
      if (onlyMissing && r.cost != null) return false;
      if (q && !`${r.sku} ${r.asin || ""} ${r.title} ${r.productName || ""}`.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [rows, search, statusFilter, channelFilter, onlyMissing]);

  const stats = useMemo(() => {
    const active = rows.filter((r) => r.status === "Active");
    return {
      total: rows.length,
      active: active.length,
      withCost: rows.filter((r) => r.cost != null).length,
      activeMissing: active.filter((r) => r.cost == null).length,
    };
  }, [rows]);

  const syncNow = async () => {
    setSyncing(true);
    setNotice(null);
    setError(null);
    try {
      const res = await fetch("/api/amazon/listings/sync", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ accountId }) });
      const json = (await res.json()) as { ok?: boolean; error?: string; listings?: number; distinctSkus?: number; newMappings?: number; marketplaces?: Array<{ marketplaceId: string; ok: boolean; rows: number; error?: string }>; warnings?: string[] };
      if (!res.ok || !json.ok) throw new Error(json.error || json.warnings?.[0] || json.marketplaces?.find((m) => m.error)?.error || "Listings sync failed.");
      const okMarkets = (json.marketplaces || []).filter((m) => m.ok);
      setNotice(
        `Pulled ${json.listings ?? 0} listings (${json.distinctSkus ?? 0} SKUs) from ${okMarkets.map((m) => marketLabel(m.marketplaceId)).join(", ")}. ${json.newMappings ? `${json.newMappings} new SKU${json.newMappings === 1 ? "" : "s"} added to the catalog.` : "No new SKUs."}${json.warnings?.length ? ` ${json.warnings.join(" ")}` : ""}`
      );
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Listings sync failed.");
    } finally {
      setSyncing(false);
    }
  };

  const saveCost = async (row: SkuView) => {
    const raw = editing[row.sku];
    const value = Number(raw);
    if (!raw || !Number.isFinite(value) || value < 0) return;
    setSaving(row.sku);
    setError(null);
    try {
      await applyCogsVersion(createClient(), accountId, {
        productName: row.productName || row.title || row.sku,
        sku: row.sku,
        unitCost: value,
        includesVat: false,
        effectiveFrom: new Date().toISOString().slice(0, 10),
      });
      setEditing((e) => {
        const n = { ...e };
        delete n[row.sku];
        return n;
      });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save cost.");
    } finally {
      setSaving(null);
    }
  };

  return (
    <section className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-slate-900">Amazon listings</h2>
          <p className="mt-1 max-w-2xl text-sm text-slate-600">
            Every seller SKU and ASIN on the connected Amazon account, pulled straight from Amazon (refreshes daily; press Sync to pull now). New SKUs are added to the product catalog automatically — costs are never guessed, so fill in any that show <span className="font-medium text-amber-700">cost missing</span>.
          </p>
          <p className="mt-1 text-xs text-slate-500">
            {syncedAt ? `Last full refresh ${new Date(syncedAt).toLocaleString("en-GB", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" })}` : rows.length ? "Partial refresh so far — remaining marketplaces fill in on the next hourly run." : "Not synced yet."}
            {syncError ? <span className="ml-2 text-rose-600">Last error: {syncError}</span> : null}
          </p>
        </div>
        {canEdit ? (
          <button type="button" onClick={syncNow} disabled={syncing || !connected} className="rounded-lg bg-plum-700 px-3 py-2 text-sm font-semibold text-white hover:bg-plum-800 disabled:opacity-50" title={connected ? "" : "Connect Amazon SP-API first"}>
            {syncing ? "Syncing… (can take a minute per marketplace)" : "Sync listings from Amazon"}
          </button>
        ) : null}
      </div>

      {error ? <p className="mt-3 rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700">{error}</p> : null}
      {notice ? <p className="mt-3 rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-800">{notice}</p> : null}

      <div className="mt-3 grid grid-cols-2 gap-2 text-sm md:grid-cols-4">
        <Stat label="SKUs listed" value={stats.total} />
        <Stat label="Active" value={stats.active} />
        <Stat label="With cost" value={stats.withCost} />
        <Stat label="Active, cost missing" value={stats.activeMissing} warn={stats.activeMissing > 0} />
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search SKU, ASIN, title…" className="w-64 rounded-lg border border-slate-300 px-3 py-1.5 text-sm" />
        <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as typeof statusFilter)} className="rounded-lg border border-slate-300 px-2 py-1.5 text-sm">
          <option value="active">Active only</option>
          <option value="inactive">Inactive / incomplete</option>
          <option value="all">All statuses</option>
        </select>
        <select value={channelFilter} onChange={(e) => setChannelFilter(e.target.value as typeof channelFilter)} className="rounded-lg border border-slate-300 px-2 py-1.5 text-sm">
          <option value="all">FBA + FBM</option>
          <option value="fba">FBA</option>
          <option value="fbm">FBM</option>
        </select>
        <label className="flex items-center gap-1 text-sm text-slate-600"><input type="checkbox" checked={onlyMissing} onChange={(e) => setOnlyMissing(e.target.checked)} /> cost missing only</label>
        <span className="ml-auto text-xs text-slate-500">{filtered.length} of {rows.length}</span>
      </div>

      {loading ? (
        <p className="mt-4 text-sm text-slate-500">Loading listings…</p>
      ) : rows.length === 0 ? (
        <p className="mt-4 rounded-lg border border-dashed border-slate-300 px-3 py-6 text-center text-sm text-slate-500">
          {connected ? "No listings pulled yet. Press “Sync listings from Amazon”." : "Connect the Amazon SP-API account in Settings to pull listings."}
        </p>
      ) : (
        <div className="mt-3 overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead>
              <tr className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
                <th className="px-3 py-2">SKU</th>
                <th className="px-3 py-2">ASIN</th>
                <th className="px-3 py-2">Amazon title</th>
                <th className="px-3 py-2">Product</th>
                <th className="px-3 py-2">Channel</th>
                <th className="px-3 py-2">Markets</th>
                <th className="px-3 py-2">Status</th>
                <th className="px-3 py-2 text-right">Price</th>
                <th className="px-3 py-2 text-right">Cost (ex VAT)</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((r) => (
                <tr key={r.sku} className="border-t border-slate-100 align-top">
                  <td className="px-3 py-2 font-mono text-xs">{r.sku}</td>
                  <td className="px-3 py-2 font-mono text-xs">{r.asin ? <a href={`https://www.amazon.co.uk/dp/${r.asin}`} target="_blank" rel="noreferrer" className="text-plum-700 hover:underline">{r.asin}</a> : "—"}</td>
                  <td className="max-w-[320px] truncate px-3 py-2 text-slate-700" title={r.title}>{r.title || "—"}</td>
                  <td className="max-w-[220px] truncate px-3 py-2 text-slate-700" title={r.productName || ""}>{r.productName || <span className="text-slate-400">unmapped</span>}</td>
                  <td className="px-3 py-2">
                    <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${r.channel === "fba" ? "bg-amber-50 text-amber-800" : r.channel === "fbm" ? "bg-sky-50 text-sky-800" : "bg-violet-50 text-violet-800"}`}>{r.channel === "both" ? "FBA + FBM" : r.channel.toUpperCase()}</span>
                  </td>
                  <td className="px-3 py-2 text-xs text-slate-600">{r.marketplaces.map(marketLabel).join(" · ")}</td>
                  <td className="px-3 py-2"><span className={`text-xs font-medium ${r.status === "Active" ? "text-emerald-700" : "text-slate-500"}`}>{r.status}</span></td>
                  <td className="px-3 py-2 text-right">{fmtMoney(r.price)}{r.priceMarketplace && r.priceMarketplace !== HOME ? <span className="block text-[10px] text-slate-400">{marketLabel(r.priceMarketplace)}</span> : null}</td>
                  <td className="px-3 py-2 text-right">
                    {r.cost != null && editing[r.sku] == null ? (
                      <button type="button" className="font-medium text-slate-900 hover:underline" disabled={!canEdit} onClick={() => setEditing({ ...editing, [r.sku]: String(r.cost) })} title="Change cost">
                        {fmtMoney(r.cost)}{r.costIncludesVat ? <span className="ml-1 text-[10px] text-slate-400">inc VAT</span> : null}
                      </button>
                    ) : canEdit ? (
                      <span className="inline-flex items-center gap-1">
                        <input
                          value={editing[r.sku] ?? ""}
                          onChange={(e) => setEditing({ ...editing, [r.sku]: e.target.value })}
                          onKeyDown={(e) => { if (e.key === "Enter") void saveCost(r); if (e.key === "Escape") setEditing((x) => { const n = { ...x }; delete n[r.sku]; return n; }); }}
                          placeholder="0.00"
                          inputMode="decimal"
                          className={`w-24 rounded-md border px-2 py-1 text-right text-sm ${r.cost == null ? "border-amber-400 bg-amber-50/40" : "border-slate-300"}`}
                        />
                        <button type="button" onClick={() => void saveCost(r)} disabled={saving === r.sku || !editing[r.sku]} className="rounded-md bg-slate-900 px-2 py-1 text-xs font-semibold text-white disabled:opacity-40">{saving === r.sku ? "…" : "Save"}</button>
                      </span>
                    ) : (
                      <span className="text-xs font-medium text-amber-700">cost missing</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function Stat({ label, value, warn }: { label: string; value: number; warn?: boolean }) {
  return (
    <div className={`rounded-lg border px-3 py-2 ${warn ? "border-amber-200 bg-amber-50" : "border-slate-200 bg-slate-50"}`}>
      <p className="text-xs text-slate-500">{label}</p>
      <p className={`text-lg font-semibold ${warn ? "text-amber-800" : "text-slate-900"}`}>{value.toLocaleString("en-GB")}</p>
    </div>
  );
}
