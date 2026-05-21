/**
 * Bridged COGS lookup builder.
 *
 * Loads the account's `cogs` + `cogs_history` tables and the canonical
 * `sku_mappings` table, then produces a lookup keyed by every identifier
 * a transaction sheet might reference for the same physical product:
 *   - the seller-managed `cogs.sku`
 *   - the Amazon SKU on the linked `sku_mappings` row (if different)
 *   - the Temu SKU ID on the linked `sku_mappings` row
 *
 * Why: the COGS table is almost always keyed by the Amazon SKU. When a Temu
 * report runs, the engine looks up by the numeric Temu SKU ID and finds
 * nothing — yielding £0 COGS for every SKU. By exposing each cost under
 * every twin identifier this lookup makes per-SKU profitability work for
 * both platforms with the same underlying data.
 *
 * Lookup is case-insensitive (lowercased keys) and version-aware (each key
 * maps to a sorted `CogsVersion[]`).
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { CogsLookup, CogsVersion } from "./types";

type CogsRow = {
  sku: string;
  unit_cost: number | string | null;
  includes_vat: boolean | null;
  effective_from: string | null;
  sku_mapping_id?: string | null;
};

type MappingRow = {
  id: string;
  amazon_sku: string | null;
  temu_sku_id: string | null;
};

const todayIso = () => new Date().toISOString().slice(0, 10);
const norm = (value: unknown) => String(value ?? "").trim().toLowerCase();

function toCogsVersion(row: CogsRow): CogsVersion {
  return {
    unitCost: Number(row.unit_cost) || 0,
    includesVat: Boolean(row.includes_vat),
    effectiveFrom: String(row.effective_from || todayIso()),
  };
}

/**
 * Add a CogsVersion under `key`, dedup by effectiveFrom, keep sorted ASC.
 * Skips when the key is empty.
 */
function addVersion(lookup: CogsLookup, key: string, version: CogsVersion) {
  if (!key) return;
  const list = lookup.get(key) || [];
  // Dedup: same key + same effectiveFrom → keep first.
  if (list.some((v) => v.effectiveFrom === version.effectiveFrom)) return;
  list.push(version);
  lookup.set(key, list);
}

function sortLookup(lookup: CogsLookup) {
  lookup.forEach((versions, key) => {
    versions.sort((a, b) => (a.effectiveFrom < b.effectiveFrom ? -1 : 1));
    lookup.set(key, versions);
  });
}

/**
 * Build a CogsLookup that resolves both the seller's primary SKU and any
 * twin identifiers from `sku_mappings`. Use this in place of inline
 * cogs-fetch logic — it's the single source of truth for COGS resolution
 * across Amazon and Temu reports.
 *
 * @param accountId Account whose COGS to load.
 * @returns A `CogsLookup` keyed by lowercased identifiers.
 */
export async function buildBridgedCogsLookup(
  supabase: SupabaseClient,
  accountId: string
): Promise<CogsLookup> {
  const [cogsRes, historyRes, mappingsRes] = await Promise.all([
    supabase
      .from("cogs")
      .select("sku, unit_cost, includes_vat, effective_from, sku_mapping_id")
      .eq("account_id", accountId),
    supabase
      .from("cogs_history")
      .select("sku, unit_cost, includes_vat, effective_from")
      .eq("account_id", accountId)
      .order("effective_from", { ascending: true }),
    supabase
      .from("sku_mappings")
      .select("id, amazon_sku, temu_sku_id")
      .eq("account_id", accountId),
  ]);

  if (cogsRes.error) throw cogsRes.error;
  if (historyRes.error) throw historyRes.error;
  if (mappingsRes.error) throw mappingsRes.error;

  const mappings = (mappingsRes.data || []) as MappingRow[];

  // Build two index views over `sku_mappings` keyed by:
  //   - mapping.id         → sister identifiers
  //   - lowercased amazon_sku/temu_sku_id → sister identifiers
  const sistersById = new Map<string, string[]>();
  const sistersByIdent = new Map<string, string[]>();

  for (const m of mappings) {
    const ids: string[] = [];
    if (m.amazon_sku) ids.push(norm(m.amazon_sku));
    if (m.temu_sku_id) ids.push(norm(m.temu_sku_id));
    if (ids.length === 0) continue;
    sistersById.set(m.id, ids);
    for (const id of ids) {
      const existing = sistersByIdent.get(id) || [];
      // Deduplicate while preserving order.
      for (const sister of ids) {
        if (sister !== id && !existing.includes(sister)) existing.push(sister);
      }
      sistersByIdent.set(id, existing);
    }
  }

  const lookup: CogsLookup = new Map();

  const addRowToLookup = (row: CogsRow, isHistory: boolean) => {
    const primary = norm(row.sku);
    if (!primary) return;
    const version = toCogsVersion(row);

    addVersion(lookup, primary, version);

    // Bridge through mapping_id (most reliable — set explicitly when COGS is
    // saved or imported).
    const mapId = row.sku_mapping_id ? String(row.sku_mapping_id) : "";
    const sistersFromMap = mapId ? sistersById.get(mapId) || [] : [];
    for (const sister of sistersFromMap) addVersion(lookup, sister, version);

    // Fallback: bridge by identifier match (handles cases where the mapping
    // exists but `cogs.sku_mapping_id` was never set, e.g. legacy rows).
    const sistersFromIdent = sistersByIdent.get(primary) || [];
    for (const sister of sistersFromIdent) addVersion(lookup, sister, version);

    void isHistory; // sort step gives us correct ordering regardless
  };

  for (const row of (historyRes.data || []) as CogsRow[]) addRowToLookup(row, true);

  // Current-cogs rows are only added when no history version already exists
  // for that key — matches the behaviour the workbench used previously.
  for (const row of (cogsRes.data || []) as CogsRow[]) {
    const key = norm(row.sku);
    if (!key) continue;
    if (!lookup.has(key)) addRowToLookup(row, false);
    else {
      // Lookup may already have history versions under this key. Add the
      // current row only if its effectiveFrom isn't already present.
      addRowToLookup(row, false);
    }
  }

  sortLookup(lookup);
  return lookup;
}
