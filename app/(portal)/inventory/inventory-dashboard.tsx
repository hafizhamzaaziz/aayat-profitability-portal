"use client";

import { useEffect, useMemo, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import {
  buildInventoryRows,
  type CogsRow,
  type InventoryDefaults,
  type InventoryLevelRow,
  type MonthlySalesRow,
  palletEstimate,
  type PackProfile,
  type SkuRef,
} from "@/lib/inventory/engine";
import { addDays, formatUkDate, todayIsoUtc } from "@/lib/utils/date";
import { resolveDescriptiveProductName } from "@/lib/utils/product-name";

type Props = {
  accountId: string;
  canEdit: boolean;
  currency: string;
};

type PlanRowOverride = {
  plannedUnits: number;
  plannedBoxes: number;
};

type InventoryTab = "overview" | "replenishment" | "ledger" | "stock-intake" | "shipment-planning" | "daily-sales";
type LedgerEventKey = "intake" | "send_amazon" | "outbound" | "adjustment" | "sale" | "return";
type LedgerEntry = {
  id: string;
  date: string;
  mappingId: string;
  product: string;
  sku: string;
  event: string;
  eventKey: LedgerEventKey;
  source: string;
  delta: number;
  isMovement: boolean;
  notes: string | null;
};
type StockStatus = "reorder" | "ok" | "overstock" | "idle";
type HealthIssue = { mappingId: string; label: string; issue: string; severity: "warn" | "error" };
type IntakeAction = "supplier_inbound" | "seller_returns" | "b2b_wholesale" | "amazon_transfer";
type SortColumn =
  | "product"
  | "amazon_sku"
  | "temu_sku"
  | "selected_amazon"
  | "selected_temu"
  | "selected_combined"
  | "ytd"
  | "avg_month"
  | "amazon_stock"
  | "warehouse_stock"
  | "amazon_days"
  | "warehouse_days"
  | "stock_value"
  | "potential_sales"
  | "potential_profit";
type SortDirection = "asc" | "desc";
type TxFact = { mappingId: string; date: string; platform: "amazon" | "temu"; quantity: number };
type Warehouse = { id: string; name: string };

type InventoryMovement = {
  id: string;
  mappingId: string;
  movementDate: string;
  movementType: "inbound" | "outbound" | "adjustment" | "amazon_transfer";
  unitsDelta: number;
  boxes: number | null;
  packProfileId: string | null;
  notes: string | null;
  createdAt: string;
};

type IntakeSummary = {
  intakeId: string;
  productName: string;
  skuLabel: string;
  actionLabel: string;
  units: number;
  boxes: number | null;
  unitsPerBox: number | null;
  pallets: number | null;
  boxesPerPallet: number | null;
  destination: "amazon" | "warehouse" | "both";
  amazonBefore: number;
  amazonAfter: number;
  warehouseBefore: number;
  warehouseAfter: number;
  movementDate: string;
  notes: string | null;
};
type DailySale = {
  id: string;
  account_id: string;
  sku_mapping_id: string;
  sale_date: string;
  platform: string;
  warehouse_id: string | null;
  sold_units: number;
  returns_units: number;
  collected_units: number;
  notes: string | null;
  created_at: string;
};

type DailyEntryRow = {
  id: string;
  skuSearch: string;
  mappingId: string;
  saleDate: string;
  platform: "amazon" | "temu" | "tiktok";
  warehouseId: string;
  soldUnits: string;
  returnsUnits: string;
  collectedUnits: string;
  notes: string;
};

type DailySaleEditDraft = {
  saleDate: string;
  mappingId: string;
  skuSearch: string;
  platform: "amazon" | "temu" | "tiktok";
  warehouseId: string;
  soldUnits: string;
  returnsUnits: string;
  collectedUnits: string;
  notes: string;
};

/** Keep only digits (optionally one decimal point); blocks negatives and stepper noise. */
function sanitizeNonNegativeNumber(value: string): string {
  const cleaned = value.replace(/[^0-9.]/g, "");
  const firstDot = cleaned.indexOf(".");
  if (firstDot === -1) return cleaned;
  return cleaned.slice(0, firstDot + 1) + cleaned.slice(firstDot + 1).replace(/\./g, "");
}

function createDailyEntryRow(): DailyEntryRow {
  return {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    skuSearch: "",
    mappingId: "",
    saleDate: todayIsoUtc(),
    platform: "amazon",
    warehouseId: "",
    soldUnits: "",
    returnsUnits: "",
    collectedUnits: "",
    notes: "",
  };
}

type SavedShipmentPlan = {
  id: string;
  planDate: string;
  planType: "amazon_requirement" | "warehouse_requirement" | "manual";
  title: string;
  notes: string | null;
  orientation: "portrait" | "landscape";
  itemCount: number;
  totalUnits: number;
  totalPallets: number;
  createdAt: string;
  convertedAt: string | null;
};

function dailyEntryMappingLabel(m?: SkuRef) {
  if (!m) return "";
  const sku = m.amazonSku || m.temuSkuId || "—";
  return `${sku} — ${m.productName}`;
}

// Type-ahead SKU picker used in place of long native <select> dropdowns. Renders
// a single-line trigger that opens a panel with a search box and a filtered list.
function SkuCombobox({
  value,
  onChange,
  mappings,
  mappingById,
  placeholder = "Select SKU",
  allowAll = false,
  disabled = false,
  className,
}: {
  value: string;
  onChange: (mappingId: string) => void;
  mappings: SkuRef[];
  mappingById: Map<string, SkuRef>;
  placeholder?: string;
  allowAll?: boolean;
  disabled?: boolean;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return mappings;
    return mappings.filter(
      (m) =>
        String(m.amazonSku || "").toLowerCase().includes(q) ||
        String(m.temuSkuId || "").toLowerCase().includes(q) ||
        String(m.productName || "").toLowerCase().includes(q)
    );
  }, [mappings, query]);

  const label =
    value === "all" ? "All SKUs" : value ? dailyEntryMappingLabel(mappingById.get(value)) : placeholder;

  return (
    <div className={`relative min-w-0 ${className ?? ""}`}>
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
        className="flex w-full min-w-0 items-center justify-between gap-1 rounded-lg border border-slate-300 px-2 py-2 text-left text-sm disabled:opacity-50"
        title={value && value !== "all" ? dailyEntryMappingLabel(mappingById.get(value)) : undefined}
      >
        <span className={`min-w-0 truncate ${value ? "text-slate-800" : "text-slate-400"}`}>{label}</span>
        <span className="shrink-0 text-[10px] text-slate-400">▾</span>
      </button>
      {open ? (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className="absolute left-0 top-full z-20 mt-1 w-full min-w-[16rem] rounded-lg border border-slate-200 bg-white p-2 shadow-lg">
            <input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Type to search SKU / product"
              className="mb-1 w-full rounded-lg border border-slate-300 px-2 py-1.5 text-xs"
            />
            <div className="max-h-56 overflow-auto">
              {allowAll ? (
                <button
                  type="button"
                  onClick={() => {
                    onChange("all");
                    setOpen(false);
                  }}
                  className={`mb-1 block w-full rounded-md px-2 py-1 text-left text-xs ${
                    value === "all" ? "bg-[var(--md-primary)] text-white" : "text-slate-700 hover:bg-slate-100"
                  }`}
                >
                  All SKUs
                </button>
              ) : null}
              {filtered.length === 0 ? (
                <p className="px-2 py-1 text-[11px] text-slate-500">No results found.</p>
              ) : (
                filtered.slice(0, 100).map((m) => (
                  <button
                    key={m.mappingId}
                    type="button"
                    onClick={() => {
                      onChange(m.mappingId);
                      setOpen(false);
                    }}
                    className={`mb-1 block w-full truncate rounded-md px-2 py-1 text-left text-xs ${
                      value === m.mappingId ? "bg-[var(--md-primary)] text-white" : "text-slate-700 hover:bg-slate-100"
                    }`}
                  >
                    {(m.amazonSku || m.temuSkuId || "—") + " — " + shortenName(m.productName, 40)}
                  </button>
                ))
              )}
            </div>
          </div>
        </>
      ) : null}
    </div>
  );
}

const DEFAULTS: InventoryDefaults = {
  leadTimeDays: 90,
  amazonCoverDays: 30,
  warehouseCoverDays: 120,
  storageCostPerPallet: 0,
  storageCostPeriod: "month",
};

function monthStartFromDateIso(input: string) {
  return `${input.slice(0, 7)}-01`;
}

function normalizeSkuToken(input: unknown) {
  const raw = String(input ?? "")
    .replace(/\u00a0/g, " ")
    .trim()
    .toUpperCase();
  if (!raw) return "";
  if (/^\d+\.0+$/.test(raw)) return raw.replace(/\.0+$/, "");
  return raw;
}

// PostgREST caps every response at the project's "Max rows" setting (1000 by
// default) regardless of the requested `.range()`. Tables like
// `inventory_sales_facts_cache` hold tens of thousands of rows per account, so
// a single fetch silently returns an arbitrary slice and the dashboard badly
// undercounts. This pages through the full result set so aggregates are exact.
// `pageSize` must stay <= the server cap; 1000 matches the Supabase default.
async function fetchAllRows<T>(
  makeQuery: (
    from: number,
    to: number,
  ) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>,
  pageSize = 1000,
): Promise<{ data: T[]; error: { message: string } | null }> {
  const all: T[] = [];
  let from = 0;
  // Guard against an unexpected infinite loop (e.g. backend never shrinks page).
  for (let guard = 0; guard < 5000; guard++) {
    const { data, error } = await makeQuery(from, from + pageSize - 1);
    if (error) return { data: all, error };
    const batch = (data || []) as T[];
    all.push(...batch);
    if (batch.length < pageSize) break;
    from += pageSize;
  }
  return { data: all, error: null };
}

function daysBetweenInclusive(startIso: string, endIso: string) {
  const start = new Date(`${startIso}T00:00:00Z`);
  const end = new Date(`${endIso}T00:00:00Z`);
  const ms = end.getTime() - start.getTime();
  return Math.max(1, Math.floor(ms / (24 * 60 * 60 * 1000)) + 1);
}

function shortenName(input: string, max = 28) {
  const value = String(input || "").trim();
  if (value.length <= max) return value;
  return `${value.slice(0, max - 3)}...`;
}

function normalizeKey(input: string) {
  return input.trim().toLowerCase().replace(/\s+/g, " ");
}

function findRawValue(rawRow: Record<string, unknown>, terms: string[]) {
  const keys = Object.keys(rawRow);
  for (const term of terms) {
    const match = keys.find((k) => normalizeKey(k) === term);
    if (match) return rawRow[match];
  }
  for (const term of terms) {
    const match = keys.find((k) => normalizeKey(k).includes(term));
    if (match) return rawRow[match];
  }
  return undefined;
}

async function ensureAmazonOnlyMappingsFromData(input: {
  accountId: string;
  canEdit: boolean;
  mappings: Array<{ id: string; amazon_sku: string | null }>;
  reportTransactions: Array<{ platform: string | null; sku: string | null }>;
}) {
  if (!input.canEdit) return 0;

  const existingAmazonSkus = new Set(
    input.mappings
      .map((row) => String(row.amazon_sku || "").trim().toUpperCase())
      .filter(Boolean)
  );

  const candidates = new Set<string>();
  input.reportTransactions.forEach((row) => {
    const platform = String(row.platform || "").trim().toLowerCase();
    if (!platform.startsWith("amazon")) return;
    const sku = String(row.sku || "").trim().toUpperCase();
    if (sku) candidates.add(sku);
  });

  const missingAmazonSkus = Array.from(candidates).filter((sku) => !existingAmazonSkus.has(sku));
  if (missingAmazonSkus.length === 0) return 0;

  const supabase = createClient();
  let created = 0;

  for (const sku of missingAmazonSkus) {
    const { data: existingMapping } = await supabase
      .from("sku_mappings")
      .select("id")
      .eq("account_id", input.accountId)
      .eq("amazon_sku", sku)
      .maybeSingle();
    if (existingMapping?.id) continue;

    const { data: catalogRow, error: catalogError } = await supabase
      .from("sku_catalog")
      .upsert(
        {
          account_id: input.accountId,
          product_name: sku,
        },
        { onConflict: "account_id,product_name" }
      )
      .select("id")
      .single();
    if (catalogError || !catalogRow?.id) continue;

    const { data: mappingRow, error: mappingError } = await supabase
      .from("sku_mappings")
      .insert({
        account_id: input.accountId,
        sku_catalog_id: String(catalogRow.id),
        amazon_sku: sku,
        temu_sku_id: null,
        lead_time_days: null,
      })
      .select("id")
      .maybeSingle();
    if (mappingError) continue;
    created += 1;

    if (mappingRow?.id) {
      await supabase
        .from("cogs")
        .update({ sku_mapping_id: String(mappingRow.id) })
        .eq("account_id", input.accountId)
        .eq("sku", sku)
        .is("sku_mapping_id", null);
    }
  }

  return created;
}

async function repairTemuMappingsFromTransactionData(input: {
  accountId: string;
  canEdit: boolean;
  mappings: Array<{ id: string; amazon_sku: string | null; temu_sku_id: string | null }>;
  reportTransactions: Array<{ platform: string | null; sku: string | null; raw_row?: Record<string, unknown> | null }>;
}) {
  if (!input.canEdit) return 0;
  const amazonSkuSet = new Set<string>();
  const temuSkuSet = new Set<string>();
  input.reportTransactions.forEach((row) => {
    const platform = String(row.platform || "").trim().toLowerCase();
    const sku =
      platform.startsWith("temu")
        ? normalizeSkuToken(findRawValue((row.raw_row || {}) as Record<string, unknown>, ["sku id", "temu sku", "sku"]) ?? row.sku ?? "")
        : normalizeSkuToken(row.sku || "");
    if (!sku) return;
    if (platform.startsWith("amazon")) amazonSkuSet.add(sku);
    if (platform.startsWith("temu")) temuSkuSet.add(sku);
  });

  const supabase = createClient();
  let repaired = 0;
  for (const m of input.mappings) {
    const amazonSku = normalizeSkuToken(m.amazon_sku || "");
    if (!amazonSku || m.temu_sku_id) continue;
    if (!temuSkuSet.has(amazonSku) || amazonSkuSet.has(amazonSku)) continue;
    const { error } = await supabase
      .from("sku_mappings")
      .update({ amazon_sku: null, temu_sku_id: amazonSku })
      .eq("id", m.id);
    if (!error) repaired += 1;
  }
  return repaired;
}

export default function InventoryDashboard({ accountId, canEdit, currency }: Props) {
  const OVERVIEW_PAGE_SIZE = 25;
  const DAILY_PAGE_SIZE = 25;
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [activeTab, setActiveTab] = useState<InventoryTab>("overview");
  const [plannerSearch, setPlannerSearch] = useState("");
  const [sortColumn, setSortColumn] = useState<SortColumn>("product");
  const [sortDirection, setSortDirection] = useState<SortDirection>("asc");
  const [periodStartDate, setPeriodStartDate] = useState(addDays(todayIsoUtc(), -29));
  const [periodEndDate, setPeriodEndDate] = useState(todayIsoUtc());
  const [overviewOffset, setOverviewOffset] = useState(0);
  const [dailyOffset, setDailyOffset] = useState(0);

  const [mappings, setMappings] = useState<SkuRef[]>([]);
  const [cogs, setCogs] = useState<CogsRow[]>([]);
  const [salesRows, setSalesRows] = useState<MonthlySalesRow[]>([]);
  const [txFacts, setTxFacts] = useState<TxFact[]>([]);
  const [levels, setLevels] = useState<InventoryLevelRow[]>([]);
  const [packProfiles, setPackProfiles] = useState<PackProfile[]>([]);
  const [profileIdsByMapping, setProfileIdsByMapping] = useState<Record<string, string[]>>({});
  const [warehouses, setWarehouses] = useState<Warehouse[]>([]);
  const [dailySales, setDailySales] = useState<DailySale[]>([]);
  const [defaults, setDefaults] = useState<InventoryDefaults>(DEFAULTS);
  const [accountVatRate, setAccountVatRate] = useState(20);

  const [stockDate, setStockDate] = useState(todayIsoUtc());
  const [stockDraft, setStockDraft] = useState<Record<string, { amazonUnits: number; warehouseUnits: number }>>({});

  const [intake, setIntake] = useState({
    mappingId: "",
    actionType: "supplier_inbound" as IntakeAction,
    destination: "warehouse" as "warehouse" | "amazon",
    units: "",
    boxes: "",
    profileId: "",
    movementDate: todayIsoUtc(),
    notes: "",
  });

  const [newProfile, setNewProfile] = useState({
    profileName: "",
    unitsPerBox: "",
    boxLength: "",
    boxWidth: "",
    boxHeight: "",
    dimensionUnit: "cm" as "mm" | "cm" | "in",
    boxWeight: "",
    weightUnit: "kg" as "kg" | "lb",
  });
  const [profileSkuSearch, setProfileSkuSearch] = useState("");
  const [newProfileLinkedMappingIds, setNewProfileLinkedMappingIds] = useState<string[]>([]);
  const [editingProfileId, setEditingProfileId] = useState<string | null>(null);
  const [profileEditDraft, setProfileEditDraft] = useState<PackProfile | null>(null);
  const [editingProfileLinkedMappingIds, setEditingProfileLinkedMappingIds] = useState<string[]>([]);
  const [editingProfileSkuSearch, setEditingProfileSkuSearch] = useState("");

  const [movements, setMovements] = useState<InventoryMovement[]>([]);
  const [lastIntakeSummary, setLastIntakeSummary] = useState<IntakeSummary | null>(null);
  const [editingMovementId, setEditingMovementId] = useState<string | null>(null);
  const [movementDraft, setMovementDraft] = useState<{
    units: string;
    boxes: string;
    movementDate: string;
    notes: string;
  } | null>(null);

  const [selectedMappingIds, setSelectedMappingIds] = useState<string[]>([]);
  const [planType, setPlanType] = useState<"amazon_requirement" | "warehouse_requirement">("amazon_requirement");
  const [planTitle, setPlanTitle] = useState("Weekly replenishment plan");
  const [planNotes, setPlanNotes] = useState("");
  const [profileByMapping, setProfileByMapping] = useState<Record<string, string>>({});
  const [overrides, setOverrides] = useState<Record<string, PlanRowOverride>>({});
  const [savedPlanId, setSavedPlanId] = useState<string | null>(null);
  // When set, we're editing an existing saved plan (Save updates it in place).
  const [editingPlanId, setEditingPlanId] = useState<string | null>(null);
  // When set, the inline "create pack profile" modal is open for this SKU; the
  // new profile is auto-linked to it so the planner never sends you elsewhere.
  const [quickProfileMappingId, setQuickProfileMappingId] = useState<string | null>(null);
  const [quickProfileSaving, setQuickProfileSaving] = useState(false);
  const [quickProfile, setQuickProfile] = useState({
    profileName: "",
    unitsPerBox: "",
    boxLength: "",
    boxWidth: "",
    boxHeight: "",
    dimensionUnit: "cm" as "mm" | "cm" | "in",
    boxWeight: "",
    weightUnit: "kg" as "kg" | "lb",
  });
  const [dailyHistorySkuSearch, setDailyHistorySkuSearch] = useState("");
  const [dailyFilters, setDailyFilters] = useState({
    from: addDays(todayIsoUtc(), -29),
    to: todayIsoUtc(),
    platform: "all",
    warehouseId: "all",
    mappingId: "all",
  });
  const [dailyEntryRows, setDailyEntryRows] = useState<DailyEntryRow[]>([createDailyEntryRow()]);
  const [openEntrySkuDropdownId, setOpenEntrySkuDropdownId] = useState<string | null>(null);
  const [editingDailySaleId, setEditingDailySaleId] = useState<string | null>(null);
  const [dailySaleDraft, setDailySaleDraft] = useState<DailySaleEditDraft | null>(null);
  const [savedPlans, setSavedPlans] = useState<SavedShipmentPlan[]>([]);
  const REPLEN_PAGE_SIZE = 25;
  const LEDGER_PAGE_SIZE = 30;
  const [replenSearch, setReplenSearch] = useState("");
  const [replenStatusFilter, setReplenStatusFilter] = useState<"all" | "reorder" | "overstock" | "idle">("all");
  const [replenOffset, setReplenOffset] = useState(0);
  const [showDataHealth, setShowDataHealth] = useState(false);
  const [ledgerOffset, setLedgerOffset] = useState(0);
  const [ledgerFilters, setLedgerFilters] = useState({
    mappingId: "all",
    eventKey: "all" as "all" | LedgerEventKey,
    from: addDays(todayIsoUtc(), -89),
    to: todayIsoUtc(),
  });

  const nowIso = todayIsoUtc();

  const loadAll = async () => {
    setLoading(true);
    setError(null);
    const supabase = createClient();

    const [mappingRes, defaultsRes, salesFactsRes, levelRes, cogsRes, profilesRes, movementLinksRes, warehousesRes, dailySalesRes, accountRes, skuDescRes] = await Promise.all([
      supabase
        .from("sku_mappings")
        .select("id, amazon_sku, temu_sku_id, lead_time_days, sku_catalog:sku_catalog_id(product_name)")
        .eq("account_id", accountId)
        .order("created_at", { ascending: false }),
      supabase.from("inventory_defaults").select("*").eq("account_id", accountId).maybeSingle(),
      // Pre-aggregated per-day units from `inventory_sales_facts_cache` (refreshed
      // whenever a report is uploaded / recomputed / deleted). Paged through in
      // full because accounts routinely exceed the PostgREST row cap — a single
      // fetch would return an arbitrary slice and undercount every total. The
      // deterministic ordering keeps page boundaries stable. The SKU universe
      // used by mapping-repair helpers is derived from this same dataset.
      fetchAllRows<{ platform: string | null; sku: string | null; sale_date: string; qty: number | string | null }>(
        (from, to) =>
          supabase
            .from("inventory_sales_facts_cache")
            .select("platform, sku, sale_date, qty")
            .eq("account_id", accountId)
            .order("sale_date", { ascending: true })
            .order("sku", { ascending: true })
            .order("platform", { ascending: true })
            .range(from, to),
      ),
      supabase
        .from("inventory_levels")
        .select("sku_mapping_id, level_date, amazon_units, warehouse_units")
        .eq("account_id", accountId),
      supabase.from("cogs").select("sku, unit_cost, sku_mapping_id").eq("account_id", accountId),
      supabase
        .from("pack_profiles")
        .select("id, profile_name, units_per_box, box_length, box_width, box_height, dimension_unit, box_weight, weight_unit")
        .eq("account_id", accountId)
        .order("created_at", { ascending: false }),
      // Full movement history (latest first) — drives both the pack-profile
      // link map and the new "Recent Stock Actions" list with edit/delete.
      supabase
        .from("inventory_movements")
        .select("id, sku_mapping_id, movement_date, movement_type, units_delta, boxes, pack_profile_id, notes, created_at")
        .eq("account_id", accountId)
        .order("created_at", { ascending: false })
        .limit(2000),
      supabase.from("inventory_warehouses").select("id, name").eq("account_id", accountId).order("name", { ascending: true }),
      supabase
        .from("inventory_daily_sales")
        .select("id, account_id, sku_mapping_id, sale_date, platform, warehouse_id, sold_units, returns_units, collected_units, notes, created_at")
        .eq("account_id", accountId)
        .order("sale_date", { ascending: false })
        .limit(3000),
      supabase.from("accounts").select("vat_rate").eq("id", accountId).maybeSingle(),
      // Paged: a busy account holds several thousand SKU description rows, more
      // than the PostgREST row cap, so a single fetch dropped product names.
      fetchAllRows<{ sku: string; description: string | null }>(
        (from, to) =>
          supabase
            .from("report_sku_breakdowns")
            .select("sku, description")
            .eq("account_id", accountId)
            .not("description", "is", null)
            .order("sku", { ascending: true })
            .range(from, to),
      ),
    ]);

    if (mappingRes.error) {
      setError(mappingRes.error.message);
      setLoading(false);
      return;
    }

    if (defaultsRes.error && defaultsRes.error.code !== "PGRST116") {
      setError(defaultsRes.error.message);
      setLoading(false);
      return;
    }
    if (salesFactsRes.error) {
      setError(salesFactsRes.error.message);
      setLoading(false);
      return;
    }
    if (levelRes.error) {
      setError(levelRes.error.message);
      setLoading(false);
      return;
    }
    if (cogsRes.error) {
      setError(cogsRes.error.message);
      setLoading(false);
      return;
    }
    if (profilesRes.error) {
      setError(profilesRes.error.message);
      setLoading(false);
      return;
    }
    if (movementLinksRes.error) {
      setError(movementLinksRes.error.message);
      setLoading(false);
      return;
    }
    if (warehousesRes.error) {
      setError(warehousesRes.error.message);
      setLoading(false);
      return;
    }
    if (dailySalesRes.error) {
      setError(dailySalesRes.error.message);
      setLoading(false);
      return;
    }
    if (accountRes.error) {
      setError(accountRes.error.message);
      setLoading(false);
      return;
    }
    if (skuDescRes.error) {
      setError(skuDescRes.error.message);
      setLoading(false);
      return;
    }

    const descriptionBySku = new Map<string, string>();
    ((skuDescRes.data || []) as Array<{ sku?: string | null; description?: string | null }>).forEach((row) => {
      const sku = String(row.sku || "").trim().toUpperCase();
      const description = String(row.description || "").trim();
      if (!sku || !description) return;
      const current = descriptionBySku.get(sku);
      if (!current || description.length > current.length) {
        descriptionBySku.set(sku, description);
      }
    });

    const nextMappings: SkuRef[] = (mappingRes.data || []).map((row) => {
      const rec = row as unknown as {
        id: string;
        amazon_sku: string | null;
        temu_sku_id: string | null;
        lead_time_days: number | null;
        sku_catalog?: { product_name?: string } | null;
      };
      return {
        mappingId: rec.id,
        productName: resolveDescriptiveProductName({
          productName: rec.sku_catalog?.product_name || null,
          amazonSku: rec.amazon_sku,
          temuSkuId: rec.temu_sku_id,
          descriptionBySku,
        }),
        amazonSku: rec.amazon_sku,
        temuSkuId: rec.temu_sku_id,
        leadTimeDays: rec.lead_time_days,
      };
    });
    setMappings(nextMappings);

    const defaultsRow = defaultsRes.data as
      | {
          lead_time_days?: number;
          amazon_cover_days?: number;
          warehouse_cover_days?: number;
          storage_cost_per_pallet?: number;
          storage_cost_period?: "week" | "month";
        }
      | null;
    setDefaults({
      leadTimeDays: Number(defaultsRow?.lead_time_days ?? DEFAULTS.leadTimeDays),
      amazonCoverDays: Number(defaultsRow?.amazon_cover_days ?? DEFAULTS.amazonCoverDays),
      warehouseCoverDays: Number(defaultsRow?.warehouse_cover_days ?? DEFAULTS.warehouseCoverDays),
      storageCostPerPallet: Number(defaultsRow?.storage_cost_per_pallet ?? DEFAULTS.storageCostPerPallet),
      storageCostPeriod: defaultsRow?.storage_cost_period || DEFAULTS.storageCostPeriod,
    });

      const mappingByAmazonSku = new Map(
      nextMappings
        .filter((m) => m.amazonSku)
        .map((m) => [String(m.amazonSku).trim().toUpperCase(), m.mappingId])
    );
    const mappingByTemuSku = new Map(
      nextMappings
        .filter((m) => m.temuSkuId)
        .map((m) => [String(m.temuSkuId).trim().toUpperCase(), m.mappingId])
    );
    const monthlyAccumulator = new Map<string, MonthlySalesRow>();
    const factRows: TxFact[] = [];
    (salesFactsRes.data || []).forEach((row) => {
      const rec = row as unknown as {
        platform: string | null;
        sku: string | null;
        sale_date: string;
        qty: number | string | null;
      };
      const platform = String(rec.platform || "").trim().toLowerCase();
      const sku = normalizeSkuToken(rec.sku || "");
      if (!sku || !rec.sale_date) return;
      const quantity = Number(rec.qty || 0);
      if (!Number.isFinite(quantity) || quantity <= 0) return;

      const mappingId =
        platform.startsWith("amazon")
          ? mappingByAmazonSku.get(sku)
          : platform.startsWith("temu")
            ? mappingByTemuSku.get(sku)
            : mappingByAmazonSku.get(sku) || mappingByTemuSku.get(sku);
      if (!mappingId) return;
      const txDate = String(rec.sale_date || "").slice(0, 10);
      if (txDate) {
        factRows.push({
          mappingId,
          date: txDate,
          platform: platform.startsWith("temu") ? "temu" : "amazon",
          quantity,
        });
      }

      const monthStart = monthStartFromDateIso(rec.sale_date);
      const key = `${mappingId}|${monthStart}`;
      const existing = monthlyAccumulator.get(key) || {
        mappingId,
        monthStart,
        amazonUnits: 0,
        temuUnits: 0,
      };
      if (platform.startsWith("temu")) existing.temuUnits += quantity;
      else existing.amazonUnits += quantity;
      monthlyAccumulator.set(key, existing);
    });
    setSalesRows(Array.from(monthlyAccumulator.values()));
    setTxFacts(factRows);

    setLevels(
      (levelRes.data || []).map((row) => {
        const rec = row as unknown as {
          sku_mapping_id: string;
          level_date: string;
          amazon_units: number;
          warehouse_units: number;
        };
        return {
          mappingId: rec.sku_mapping_id,
          levelDate: rec.level_date,
          amazonUnits: Number(rec.amazon_units || 0),
          warehouseUnits: Number(rec.warehouse_units || 0),
        };
      })
    );

    const mappingById = new Map(nextMappings.map((m) => [m.mappingId, m]));
    setCogs(
      (cogsRes.data || []).map((row) => {
        const rec = row as unknown as { sku: string; unit_cost: number; sku_mapping_id: string | null };
        const mapping = rec.sku_mapping_id ? mappingById.get(rec.sku_mapping_id) : null;
        return {
          amazonSku: mapping?.amazonSku || rec.sku,
          temuSkuId: mapping?.temuSkuId || null,
          unitCost: Number(rec.unit_cost || 0),
        };
      })
    );

    setPackProfiles(
      (profilesRes.data || []).map((row) => {
        const rec = row as unknown as {
          id: string;
          profile_name: string;
          units_per_box: number;
          box_length: number;
          box_width: number;
          box_height: number;
          dimension_unit: "mm" | "cm" | "in";
          box_weight: number | null;
          weight_unit: "kg" | "lb";
        };
        return {
          id: rec.id,
          profileName: rec.profile_name,
          unitsPerBox: Number(rec.units_per_box),
          boxLength: Number(rec.box_length),
          boxWidth: Number(rec.box_width),
          boxHeight: Number(rec.box_height),
          dimensionUnit: rec.dimension_unit,
          boxWeight: rec.box_weight == null ? null : Number(rec.box_weight),
          weightUnit: rec.weight_unit,
        };
      })
    );

    const links: Record<string, string[]> = {};
    const allMovements: InventoryMovement[] = [];
    (movementLinksRes.data || []).forEach((row) => {
      const rec = row as unknown as {
        id: string;
        sku_mapping_id: string;
        movement_date: string;
        movement_type: InventoryMovement["movementType"];
        units_delta: number;
        boxes: number | null;
        pack_profile_id: string | null;
        notes: string | null;
        created_at: string;
      };
      if (rec.pack_profile_id) {
        const list = links[rec.sku_mapping_id] || [];
        if (!list.includes(rec.pack_profile_id)) list.push(rec.pack_profile_id);
        links[rec.sku_mapping_id] = list;
      }
      // Skip the placeholder rows we use purely to record SKU↔profile links.
      if (rec.notes === "__profile_link__") return;
      allMovements.push({
        id: String(rec.id),
        mappingId: String(rec.sku_mapping_id),
        movementDate: String(rec.movement_date),
        movementType: rec.movement_type,
        unitsDelta: Number(rec.units_delta || 0),
        boxes: rec.boxes == null ? null : Number(rec.boxes),
        packProfileId: rec.pack_profile_id ? String(rec.pack_profile_id) : null,
        notes: rec.notes,
        createdAt: String(rec.created_at),
      });
    });
    setProfileIdsByMapping(links);
    setMovements(allMovements);
    setWarehouses(
      (warehousesRes.data || []).map((w) => ({
        id: String((w as { id: string }).id),
        name: String((w as { name: string }).name || ""),
      }))
    );
    setDailySales(
      (dailySalesRes.data || []).map((row) => {
        const rec = row as unknown as DailySale;
        return {
          id: String(rec.id),
          account_id: String(rec.account_id),
          sku_mapping_id: String(rec.sku_mapping_id),
          sale_date: String(rec.sale_date),
          platform: String(rec.platform || "amazon"),
          warehouse_id: rec.warehouse_id ? String(rec.warehouse_id) : null,
          sold_units: Number(rec.sold_units || 0),
          returns_units: Number(rec.returns_units || 0),
          collected_units: Number(rec.collected_units || 0),
          notes: rec.notes || null,
          created_at: String(rec.created_at || ""),
        };
      })
    );
    setAccountVatRate(Number((accountRes.data as { vat_rate?: number } | null)?.vat_rate ?? 20));

    void loadSavedPlans();

    setLoading(false);

    // Defer the SKU-mapping auto-repair (creates Amazon-only mappings for new
    // SKUs and re-tags Temu IDs that were stored as amazon_sku) so it never
    // blocks the initial render. Runs at most once per account per browser
    // session — so opening Inventory feels instant on subsequent visits.
    if (canEdit && typeof window !== "undefined") {
      const cacheKey = `inv-mapping-repair:${accountId}`;
      if (!sessionStorage.getItem(cacheKey)) {
        setTimeout(() => {
          void (async () => {
            try {
              const skuUniverse = ((salesFactsRes.data || []) as Array<{
                platform: string | null;
                sku: string | null;
              }>).map((row) => ({ platform: row.platform, sku: row.sku }));
              const created = await ensureAmazonOnlyMappingsFromData({
                accountId,
                canEdit,
                mappings: (mappingRes.data || []) as Array<{ id: string; amazon_sku: string | null }>,
                reportTransactions: skuUniverse,
              });
              const repaired = await repairTemuMappingsFromTransactionData({
                accountId,
                canEdit,
                mappings: (mappingRes.data || []) as Array<{
                  id: string;
                  amazon_sku: string | null;
                  temu_sku_id: string | null;
                }>,
                reportTransactions: skuUniverse.map((row) => ({ ...row, raw_row: null })),
              });
              sessionStorage.setItem(cacheKey, String(Date.now()));
              if (created > 0 || repaired > 0) {
                setMessage(
                  `${created + repaired} SKU mapping${created + repaired === 1 ? "" : "s"} auto-updated in the background. Refresh to see the latest numbers.`
                );
              }
            } catch {
              // Background repair is best-effort; surface nothing if it fails.
            }
          })();
        }, 1500);
      }
    }
  };

  useEffect(() => {
    void loadAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accountId]);

  const computedRows = useMemo(() => {
    return buildInventoryRows({
      mappings,
      monthlySales: salesRows,
      levels,
      cogs,
      defaults,
      nowIso,
    });
  }, [mappings, salesRows, levels, cogs, defaults, nowIso]);

  const visibleRows = useMemo(() => {
    const q = search.trim().toLowerCase();
    const filtered = !q
      ? computedRows
      : computedRows.filter((row) => {
          return (
            row.productName.toLowerCase().includes(q) ||
            String(row.amazonSku || "")
              .toLowerCase()
              .includes(q) ||
            String(row.temuSkuId || "")
              .toLowerCase()
              .includes(q)
          );
        });
    const sorted = [...filtered].sort((a, b) => {
      const sumPeriod = (mappingId: string, platform?: "amazon" | "temu") =>
        txFacts
          .filter(
            (tx) =>
              tx.mappingId === mappingId &&
              (!periodStartDate || tx.date >= periodStartDate) &&
              (!periodEndDate || tx.date <= periodEndDate) &&
              (!platform || tx.platform === platform)
          )
          .reduce((acc, tx) => acc + Number(tx.quantity || 0), 0);
      const aPeriodAmazon = sumPeriod(a.mappingId, "amazon");
      const aPeriodTemu = sumPeriod(a.mappingId, "temu");
      const bPeriodAmazon = sumPeriod(b.mappingId, "amazon");
      const bPeriodTemu = sumPeriod(b.mappingId, "temu");
      const compareNumeric = (x: number, y: number) => (sortDirection === "asc" ? x - y : y - x);
      const compareText = (x: string, y: string) => (sortDirection === "asc" ? x.localeCompare(y) : y.localeCompare(x));
      switch (sortColumn) {
        case "amazon_sku":
          return compareText(String(a.amazonSku || ""), String(b.amazonSku || ""));
        case "temu_sku":
          return compareText(String(a.temuSkuId || ""), String(b.temuSkuId || ""));
        case "selected_amazon":
          return compareNumeric(aPeriodAmazon, bPeriodAmazon);
        case "selected_temu":
          return compareNumeric(aPeriodTemu, bPeriodTemu);
        case "selected_combined":
          return compareNumeric(aPeriodAmazon + aPeriodTemu, bPeriodAmazon + bPeriodTemu);
        case "ytd":
          return compareNumeric(a.yearTotalUnits, b.yearTotalUnits);
        case "avg_month":
          return compareNumeric(a.yearAvgPerMonth, b.yearAvgPerMonth);
        case "amazon_stock":
          return compareNumeric(a.amazonUnitsOnHand, b.amazonUnitsOnHand);
        case "warehouse_stock":
          return compareNumeric(a.warehouseUnitsOnHand, b.warehouseUnitsOnHand);
        case "amazon_days":
          return compareNumeric(a.amazonDaysLeft ?? Number.POSITIVE_INFINITY, b.amazonDaysLeft ?? Number.POSITIVE_INFINITY);
        case "warehouse_days":
          return compareNumeric(a.warehouseDaysLeft ?? Number.POSITIVE_INFINITY, b.warehouseDaysLeft ?? Number.POSITIVE_INFINITY);
        case "stock_value":
          return compareNumeric(a.stockValue, b.stockValue);
        case "potential_sales":
          return compareNumeric(a.potentialSalesValue, b.potentialSalesValue);
        case "potential_profit":
          return compareNumeric(a.potentialProfitValue, b.potentialProfitValue);
        default:
          return compareText(a.productName, b.productName);
      }
    });
    return sorted;
  }, [computedRows, search, sortColumn, sortDirection, txFacts, periodStartDate, periodEndDate]);

  const selectedRows = useMemo(() => {
    return computedRows.filter((row) => selectedMappingIds.includes(row.mappingId));
  }, [computedRows, selectedMappingIds]);

  const overviewTotalCount = visibleRows.length;
  const overviewTotalPages = Math.max(1, Math.ceil(overviewTotalCount / OVERVIEW_PAGE_SIZE));
  const overviewCurrentPage = Math.floor(overviewOffset / OVERVIEW_PAGE_SIZE) + 1;
  const overviewRows = visibleRows.slice(overviewOffset, overviewOffset + OVERVIEW_PAGE_SIZE);

  const plannerVisibleRows = useMemo(() => {
    if (!plannerSearch.trim()) return computedRows;
    const q = plannerSearch.trim().toLowerCase();
    return computedRows.filter((row) => {
      return (
        row.productName.toLowerCase().includes(q) ||
        String(row.amazonSku || "")
          .toLowerCase()
          .includes(q) ||
        String(row.temuSkuId || "")
          .toLowerCase()
          .includes(q)
      );
    });
  }, [computedRows, plannerSearch]);

  const profileLinkRows = useMemo(() => {
    const q = profileSkuSearch.trim().toLowerCase();
    if (!q) return mappings;
    return mappings.filter((m) => {
      return (
        m.productName.toLowerCase().includes(q) ||
        String(m.amazonSku || "")
          .toLowerCase()
          .includes(q) ||
        String(m.temuSkuId || "")
          .toLowerCase()
          .includes(q)
      );
    });
  }, [mappings, profileSkuSearch]);

  const profileEditLinkRows = useMemo(() => {
    const q = editingProfileSkuSearch.trim().toLowerCase();
    if (!q) return mappings;
    return mappings.filter((m) => {
      return (
        m.productName.toLowerCase().includes(q) ||
        String(m.amazonSku || "")
          .toLowerCase()
          .includes(q) ||
        String(m.temuSkuId || "")
          .toLowerCase()
          .includes(q)
      );
    });
  }, [mappings, editingProfileSkuSearch]);

  const periodUnitsByMapping = useMemo(() => {
    const map = new Map<string, { amazon: number; temu: number }>();
    txFacts.forEach((tx) => {
      if (periodStartDate && tx.date < periodStartDate) return;
      if (periodEndDate && tx.date > periodEndDate) return;
      const prev = map.get(tx.mappingId) || { amazon: 0, temu: 0 };
      if (tx.platform === "temu") prev.temu += Number(tx.quantity || 0);
      else prev.amazon += Number(tx.quantity || 0);
      map.set(tx.mappingId, prev);
    });
    return map;
  }, [txFacts, periodStartDate, periodEndDate]);

  const previousPeriodRange = useMemo(() => {
    const spanDays = daysBetweenInclusive(periodStartDate, periodEndDate);
    const prevEnd = addDays(periodStartDate, -1);
    const prevStart = addDays(prevEnd, -(spanDays - 1));
    return { prevStart, prevEnd };
  }, [periodStartDate, periodEndDate]);

  const previousPeriodUnitsByMapping = useMemo(() => {
    const map = new Map<string, { amazon: number; temu: number }>();
    txFacts.forEach((tx) => {
      if (tx.date < previousPeriodRange.prevStart || tx.date > previousPeriodRange.prevEnd) return;
      const prev = map.get(tx.mappingId) || { amazon: 0, temu: 0 };
      if (tx.platform === "temu") prev.temu += Number(tx.quantity || 0);
      else prev.amazon += Number(tx.quantity || 0);
      map.set(tx.mappingId, prev);
    });
    return map;
  }, [txFacts, previousPeriodRange]);

  const ytdComparisonByMapping = useMemo(() => {
    const currentYearStart = `${nowIso.slice(0, 4)}-01-01`;
    const prevNowIso = addDays(nowIso, -365);
    const previousYearStart = `${prevNowIso.slice(0, 4)}-01-01`;
    const map = new Map<string, { current: number; previous: number }>();

    txFacts.forEach((tx) => {
      const current = map.get(tx.mappingId) || { current: 0, previous: 0 };
      if (tx.date >= currentYearStart && tx.date <= nowIso) current.current += Number(tx.quantity || 0);
      if (tx.date >= previousYearStart && tx.date <= prevNowIso) current.previous += Number(tx.quantity || 0);
      map.set(tx.mappingId, current);
    });
    return map;
  }, [txFacts, nowIso]);

  // Column totals for the Overview & Velocity table, computed across the whole
  // filtered set (not just the current page) so the figures reflect the
  // selected period as a whole.
  const overviewTotals = useMemo(() => {
    const totals = {
      selectedAmazon: 0,
      selectedTemu: 0,
      selectedCombined: 0,
      ytd: 0,
      avgPerMonth: 0,
      amazonStock: 0,
      warehouseStock: 0,
      stockValue: 0,
      potentialSales: 0,
      potentialProfit: 0,
    };
    visibleRows.forEach((row) => {
      const selAmz = periodUnitsByMapping.get(row.mappingId)?.amazon || 0;
      const selTemu = periodUnitsByMapping.get(row.mappingId)?.temu || 0;
      totals.selectedAmazon += selAmz;
      totals.selectedTemu += selTemu;
      totals.selectedCombined += selAmz + selTemu;
      totals.ytd += ytdComparisonByMapping.get(row.mappingId)?.current || 0;
      totals.avgPerMonth += Number(row.yearAvgPerMonth || 0);
      totals.amazonStock += Number(row.amazonUnitsOnHand || 0);
      totals.warehouseStock += Number(row.warehouseUnitsOnHand || 0);
      totals.stockValue += Number(row.stockValue || 0);
      totals.potentialSales += Number(row.potentialSalesValue || 0);
      totals.potentialProfit += Number(row.potentialProfitValue || 0);
    });
    return totals;
  }, [visibleRows, periodUnitsByMapping, ytdComparisonByMapping]);

  useEffect(() => {
    setOverviewOffset(0);
  }, [search, sortColumn, sortDirection, periodStartDate, periodEndDate]);

  useEffect(() => {
    setDailyOffset(0);
  }, [dailyFilters, dailyHistorySkuSearch]);

  const onSortClick = (column: SortColumn) => {
    if (sortColumn === column) {
      setSortDirection((prev) => (prev === "asc" ? "desc" : "asc"));
      return;
    }
    setSortColumn(column);
    setSortDirection(
      column === "selected_combined" ||
        column === "selected_amazon" ||
        column === "selected_temu" ||
        column === "ytd" ||
        column === "avg_month" ||
        column === "stock_value" ||
        column === "potential_sales" ||
        column === "potential_profit"
        ? "desc"
        : "asc"
    );
  };

  const saveStockSnapshot = async () => {
    if (!canEdit) return;
    const supabase = createClient();
    const payload = Object.entries(stockDraft).map(([mappingId, values]) => ({
      account_id: accountId,
      sku_mapping_id: mappingId,
      level_date: stockDate,
      amazon_units: Number(values.amazonUnits || 0),
      warehouse_units: Number(values.warehouseUnits || 0),
    }));
    if (payload.length === 0) {
      setError("Enter at least one stock row before saving snapshot.");
      return;
    }
    const { error: saveError } = await supabase.from("inventory_levels").upsert(payload, {
      onConflict: "account_id,sku_mapping_id,level_date",
    });
    if (saveError) {
      setError(saveError.message);
      return;
    }
    setMessage("Stock snapshot saved.");
    setStockDraft({});
    await loadAll();
  };

  const addPackProfile = async () => {
    if (!canEdit) return;
    if (!newProfile.profileName.trim() || !newProfile.unitsPerBox || !newProfile.boxLength || !newProfile.boxWidth || !newProfile.boxHeight) {
      setError("Profile name, units/box and dimensions are required.");
      return;
    }
    const supabase = createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    const { data: savedProfile, error: saveError } = await supabase
      .from("pack_profiles")
      .insert({
        account_id: accountId,
        profile_name: newProfile.profileName.trim(),
        units_per_box: Number(newProfile.unitsPerBox),
        box_length: Number(newProfile.boxLength),
        box_width: Number(newProfile.boxWidth),
        box_height: Number(newProfile.boxHeight),
        dimension_unit: newProfile.dimensionUnit,
        box_weight: newProfile.boxWeight ? Number(newProfile.boxWeight) : null,
        weight_unit: newProfile.weightUnit,
      })
      .select("id")
      .single();
    if (saveError || !savedProfile?.id) {
      setError(saveError?.message || "Failed to save profile.");
      return;
    }
    if (newProfileLinkedMappingIds.length > 0) {
      const linkRows = newProfileLinkedMappingIds.map((mappingId) => ({
        account_id: accountId,
        sku_mapping_id: mappingId,
        movement_date: todayIsoUtc(),
        movement_type: "adjustment" as const,
        units_delta: 0,
        boxes: null,
        pack_profile_id: String(savedProfile.id),
        notes: "__profile_link__",
        created_by: user?.id || null,
      }));
      const { error: linkError } = await supabase.from("inventory_movements").insert(linkRows);
      if (linkError) {
        setError(linkError.message);
        return;
      }
    }
    setMessage("Pack profile saved and linked.");
    setNewProfile({
      profileName: "",
      unitsPerBox: "",
      boxLength: "",
      boxWidth: "",
      boxHeight: "",
      dimensionUnit: "cm",
      boxWeight: "",
      weightUnit: "kg",
    });
    setNewProfileLinkedMappingIds([]);
    setProfileSkuSearch("");
    await loadAll();
  };

  const updatePackProfile = async (profile: PackProfile) => {
    if (!canEdit) return;
    const supabase = createClient();
    const { error: updateError } = await supabase
      .from("pack_profiles")
      .update({
        profile_name: profile.profileName.trim(),
        units_per_box: Number(profile.unitsPerBox),
        box_length: Number(profile.boxLength),
        box_width: Number(profile.boxWidth),
        box_height: Number(profile.boxHeight),
        dimension_unit: profile.dimensionUnit,
        box_weight: profile.boxWeight == null ? null : Number(profile.boxWeight),
        weight_unit: profile.weightUnit,
      })
      .eq("id", profile.id)
      .eq("account_id", accountId);
    if (updateError) {
      setError(updateError.message);
      return;
    }

    // Sync SKU links: diff the desired set against the current set and apply
    // the smallest possible insert/update to keep movement history intact.
    const desiredLinkedIds = new Set(editingProfileLinkedMappingIds);
    const currentLinkedIds = new Set(
      Object.entries(profileIdsByMapping)
        .filter(([, ids]) => ids.includes(profile.id))
        .map(([mappingId]) => mappingId)
    );
    const toLink = [...desiredLinkedIds].filter((id) => !currentLinkedIds.has(id));
    const toUnlink = [...currentLinkedIds].filter((id) => !desiredLinkedIds.has(id));

    if (toLink.length > 0) {
      const {
        data: { user },
      } = await supabase.auth.getUser();
      const linkRows = toLink.map((mappingId) => ({
        account_id: accountId,
        sku_mapping_id: mappingId,
        movement_date: todayIsoUtc(),
        movement_type: "adjustment" as const,
        units_delta: 0,
        boxes: null,
        pack_profile_id: profile.id,
        notes: "__profile_link__",
        created_by: user?.id || null,
      }));
      const { error: linkError } = await supabase.from("inventory_movements").insert(linkRows);
      if (linkError) {
        setError(linkError.message);
        return;
      }
    }

    if (toUnlink.length > 0) {
      // Remove the placeholder link rows for those mappings, and clear the
      // pack_profile_id pointer on any *real* movements so the SKU is no
      // longer reported as "linked" without losing intake history.
      const { error: deleteLinkErr } = await supabase
        .from("inventory_movements")
        .delete()
        .eq("account_id", accountId)
        .eq("pack_profile_id", profile.id)
        .eq("notes", "__profile_link__")
        .in("sku_mapping_id", toUnlink);
      if (deleteLinkErr) {
        setError(deleteLinkErr.message);
        return;
      }
      const { error: clearProfileErr } = await supabase
        .from("inventory_movements")
        .update({ pack_profile_id: null })
        .eq("account_id", accountId)
        .eq("pack_profile_id", profile.id)
        .in("sku_mapping_id", toUnlink);
      if (clearProfileErr) {
        setError(clearProfileErr.message);
        return;
      }
    }

    setMessage(
      toLink.length || toUnlink.length
        ? `Pack profile updated. Linked ${toLink.length}, unlinked ${toUnlink.length} SKU(s).`
        : "Pack profile updated."
    );
    setEditingProfileId(null);
    setProfileEditDraft(null);
    setEditingProfileLinkedMappingIds([]);
    setEditingProfileSkuSearch("");
    await loadAll();
  };

  const deletePackProfile = async (profileId: string) => {
    if (!canEdit) return;
    const linkedMappings = Object.entries(profileIdsByMapping)
      .filter(([, profileIds]) => profileIds.includes(profileId))
      .map(([mappingId]) => mappings.find((m) => m.mappingId === mappingId))
      .filter(Boolean) as SkuRef[];

    const supabase = createClient();

    if (linkedMappings.length > 0) {
      const preview = linkedMappings
        .slice(0, 8)
        .map((m) => `• ${m.amazonSku || m.temuSkuId || "—"} — ${m.productName}`)
        .join("\n");
      const more = linkedMappings.length > 8 ? `\n…and ${linkedMappings.length - 8} more` : "";
      const confirmed = window.confirm(
        `This pack profile is linked to ${linkedMappings.length} SKU(s):\n\n${preview}${more}\n\n` +
          `Unlink it from these SKUs and delete the profile?\n\n` +
          `(This clears the profile reference on past stock-intake records — it does not delete those records or change unit counts.)`
      );
      if (!confirmed) return;

      const { error: unlinkError } = await supabase
        .from("inventory_movements")
        .update({ pack_profile_id: null })
        .eq("account_id", accountId)
        .eq("pack_profile_id", profileId);
      if (unlinkError) {
        setError(unlinkError.message);
        return;
      }
    } else if (!window.confirm("Delete this pack profile?")) {
      return;
    }

    const { error: deleteError } = await supabase
      .from("pack_profiles")
      .delete()
      .eq("id", profileId)
      .eq("account_id", accountId);
    if (deleteError) {
      setError(deleteError.message);
      return;
    }
    setMessage(
      linkedMappings.length > 0
        ? `Pack profile deleted and unlinked from ${linkedMappings.length} SKU(s).`
        : "Pack profile deleted."
    );
    await loadAll();
  };

  const intakeActionDeltas = (
    actionType: IntakeAction,
    destination: "warehouse" | "amazon",
    units: number
  ): {
    movementType: InventoryMovement["movementType"];
    amazonDelta: number;
    warehouseDelta: number;
    label: string;
    destLabel: "amazon" | "warehouse" | "both";
  } => {
    if (actionType === "supplier_inbound") {
      const toAmazon = destination === "amazon";
      return {
        movementType: "inbound",
        amazonDelta: toAmazon ? units : 0,
        warehouseDelta: toAmazon ? 0 : units,
        label: toAmazon ? "Supplier inbound to Amazon" : "Supplier inbound to warehouse",
        destLabel: toAmazon ? "amazon" : "warehouse",
      };
    }
    if (actionType === "seller_returns") {
      return {
        movementType: "adjustment",
        amazonDelta: 0,
        warehouseDelta: units,
        label: "Seller returns to warehouse",
        destLabel: "warehouse",
      };
    }
    if (actionType === "b2b_wholesale") {
      return {
        movementType: "outbound",
        amazonDelta: 0,
        warehouseDelta: -units,
        label: "B2B/wholesale deduction",
        destLabel: "warehouse",
      };
    }
    return {
      movementType: "amazon_transfer",
      amazonDelta: units,
      warehouseDelta: -units,
      label: "Warehouse to Amazon transfer",
      destLabel: "both",
    };
  };

  const applyDeltaToLatestLevel = async (
    mappingId: string,
    amazonDelta: number,
    warehouseDelta: number,
    levelDate: string
  ): Promise<{ amazonAfter: number; warehouseAfter: number; amazonBefore: number; warehouseBefore: number }> => {
    const supabase = createClient();
    const latest = levels
      .filter((row) => row.mappingId === mappingId)
      .sort((a, b) => (a.levelDate < b.levelDate ? 1 : -1))[0];
    const amazonBefore = Number(latest?.amazonUnits || 0);
    const warehouseBefore = Number(latest?.warehouseUnits || 0);
    const amazonAfter = amazonBefore + amazonDelta;
    const warehouseAfter = warehouseBefore + warehouseDelta;
    if (amazonAfter < 0 || warehouseAfter < 0) {
      throw new Error("Stock change would result in negative inventory. Check quantities.");
    }
    const { error: levelError } = await supabase.from("inventory_levels").upsert(
      {
        account_id: accountId,
        sku_mapping_id: mappingId,
        level_date: levelDate,
        amazon_units: amazonAfter,
        warehouse_units: warehouseAfter,
      },
      { onConflict: "account_id,sku_mapping_id,level_date" }
    );
    if (levelError) throw new Error(levelError.message);
    return { amazonAfter, warehouseAfter, amazonBefore, warehouseBefore };
  };

  const recordStockIntake = async () => {
    if (!canEdit) return;
    if (!intake.mappingId) {
      setError("Select SKU before recording stock.");
      return;
    }
    const profile = packProfiles.find((p) => p.id === intake.profileId);
    const unitsFromBoxes = profile && intake.boxes ? Number(intake.boxes) * profile.unitsPerBox : 0;
    const units = Math.max(0, Number(intake.units || 0), unitsFromBoxes);
    if (!units) {
      setError("Enter units or boxes.");
      return;
    }
    const supabase = createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();

    const action = intakeActionDeltas(intake.actionType, intake.destination, units);
    const noteSuffix = intake.notes.trim() ? ` - ${intake.notes.trim()}` : "";
    const fullNotes = `${action.label}${noteSuffix}`;

    let stockResult: Awaited<ReturnType<typeof applyDeltaToLatestLevel>>;
    try {
      stockResult = await applyDeltaToLatestLevel(intake.mappingId, action.amazonDelta, action.warehouseDelta, intake.movementDate);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to apply stock change.");
      return;
    }

    const { data: insertedMovement, error: movementError } = await supabase
      .from("inventory_movements")
      .insert({
        account_id: accountId,
        sku_mapping_id: intake.mappingId,
        movement_date: intake.movementDate,
        movement_type: action.movementType,
        units_delta: action.warehouseDelta !== 0 ? action.warehouseDelta : action.amazonDelta,
        boxes: intake.boxes ? Number(intake.boxes) : null,
        pack_profile_id: intake.profileId || null,
        notes: fullNotes,
        created_by: user?.id || null,
      })
      .select("id")
      .single();
    if (movementError || !insertedMovement?.id) {
      setError(movementError?.message || "Failed to record stock movement.");
      return;
    }

    const mapping = mappings.find((m) => m.mappingId === intake.mappingId);
    const palletInfo = profile ? palletEstimate(profile, units) : null;
    setLastIntakeSummary({
      intakeId: String(insertedMovement.id),
      productName: mapping?.productName || "—",
      skuLabel: mapping?.amazonSku || mapping?.temuSkuId || "—",
      actionLabel: action.label,
      units,
      boxes: intake.boxes
        ? Number(intake.boxes)
        : profile
          ? Math.ceil(units / Math.max(1, profile.unitsPerBox))
          : null,
      unitsPerBox: profile ? profile.unitsPerBox : null,
      pallets: palletInfo ? palletInfo.pallets : null,
      boxesPerPallet: palletInfo ? palletInfo.boxesPerPallet : null,
      destination: action.destLabel,
      amazonBefore: stockResult.amazonBefore,
      amazonAfter: stockResult.amazonAfter,
      warehouseBefore: stockResult.warehouseBefore,
      warehouseAfter: stockResult.warehouseAfter,
      movementDate: intake.movementDate,
      notes: intake.notes.trim() || null,
    });

    setMessage("Stock intake recorded.");
    setIntake({
      mappingId: "",
      actionType: "supplier_inbound",
      destination: "warehouse",
      units: "",
      boxes: "",
      profileId: "",
      movementDate: todayIsoUtc(),
      notes: "",
    });
    await loadAll();
  };

  const convertPlanToStockIntake = async (planId: string) => {
    if (!canEdit) return;
    const supabase = createClient();
    const { data, error: loadErr } = await supabase
      .from("shipment_plans")
      .select("id, plan_type, title, converted_at, shipment_plan_items(sku_mapping_id, planned_units, planned_boxes, units_per_box)")
      .eq("id", planId)
      .eq("account_id", accountId)
      .single();
    if (loadErr || !data) {
      setError(loadErr?.message || "Failed to load plan.");
      return;
    }
    const planRow = data as unknown as {
      plan_type: string;
      title: string;
      converted_at: string | null;
      shipment_plan_items: Array<{
        sku_mapping_id: string;
        planned_units: number | null;
        planned_boxes: number | null;
        units_per_box: number | null;
      }> | null;
    };
    if (planRow.converted_at) {
      setError(`\u201c${planRow.title}\u201d was already converted to stock intake. Duplicate it to run again.`);
      return;
    }
    const items = (planRow.shipment_plan_items || []).filter((it) => Number(it.planned_units || 0) > 0);
    if (items.length === 0) {
      setError("This plan has no planned units to convert.");
      return;
    }

    const actionType: IntakeAction = planRow.plan_type === "amazon_requirement" ? "amazon_transfer" : "supplier_inbound";
    const destination: "warehouse" | "amazon" = "warehouse";
    const actionPreview =
      actionType === "amazon_transfer" ? "Transfer warehouse \u2192 Amazon" : "Supplier inbound \u2192 warehouse";

    if (
      typeof window !== "undefined" &&
      !window.confirm(
        `Convert \u201c${planRow.title}\u201d into Stock Intake Actions?\n\n` +
          `${items.length} SKU(s) will be recorded as: ${actionPreview}.\n` +
          `This updates stock levels and adds movements. Run it only once per plan.`,
      )
    ) {
      return;
    }

    const today = todayIsoUtc();
    const {
      data: { user },
    } = await supabase.auth.getUser();

    let applied = 0;
    let totalUnits = 0;
    const failures: string[] = [];
    for (const it of items) {
      const units = Math.max(0, Number(it.planned_units || 0));
      if (!units) continue;
      const action = intakeActionDeltas(actionType, destination, units);
      const mapping = mappings.find((m) => m.mappingId === it.sku_mapping_id);
      const skuLabel = mapping?.amazonSku || mapping?.temuSkuId || it.sku_mapping_id;
      try {
        await applyDeltaToLatestLevel(it.sku_mapping_id, action.amazonDelta, action.warehouseDelta, today);
      } catch (err) {
        failures.push(`${skuLabel}: ${err instanceof Error ? err.message : "stock error"}`);
        continue;
      }
      const linkedIds = profileIdsByMapping[it.sku_mapping_id] || [];
      const matchedProfile = packProfiles
        .filter((p) => linkedIds.includes(p.id))
        .find((p) => Number(p.unitsPerBox) === Number(it.units_per_box || 0));
      const { error: movementError } = await supabase.from("inventory_movements").insert({
        account_id: accountId,
        sku_mapping_id: it.sku_mapping_id,
        movement_date: today,
        movement_type: action.movementType,
        units_delta: action.warehouseDelta !== 0 ? action.warehouseDelta : action.amazonDelta,
        boxes: it.planned_boxes ? Number(it.planned_boxes) : null,
        pack_profile_id: matchedProfile?.id || null,
        notes: `${action.label} \u2014 from plan \u201c${planRow.title}\u201d`,
        created_by: user?.id || null,
      });
      if (movementError) {
        failures.push(`${skuLabel}: ${movementError.message}`);
        continue;
      }
      applied += 1;
      totalUnits += units;
    }

    if (applied > 0) {
      await supabase
        .from("shipment_plans")
        .update({ converted_at: new Date().toISOString() })
        .eq("id", planId)
        .eq("account_id", accountId);
    }

    await loadAll();
    await loadSavedPlans();
    if (applied > 0) setActiveTab("stock-intake");
    const failNote = failures.length
      ? ` ${failures.length} skipped: ${failures.slice(0, 5).join("; ")}${failures.length > 5 ? "\u2026" : ""}.`
      : "";
    if (applied > 0) {
      setMessage(
        `Converted \u201c${planRow.title}\u201d \u2192 ${applied} stock intake action(s), ${totalUnits.toLocaleString()} units.${failNote}`,
      );
    } else {
      setError(`No actions recorded for \u201c${planRow.title}\u201d.${failNote}`);
    }
  };

  const beginEditMovement = (movement: InventoryMovement) => {
    setEditingMovementId(movement.id);
    setMovementDraft({
      units: String(Math.abs(movement.unitsDelta)),
      boxes: movement.boxes == null ? "" : String(movement.boxes),
      movementDate: movement.movementDate,
      notes: movement.notes || "",
    });
  };

  const cancelEditMovement = () => {
    setEditingMovementId(null);
    setMovementDraft(null);
  };

  const saveEditedMovement = async (movement: InventoryMovement) => {
    if (!canEdit || !movementDraft) return;
    const newUnits = Math.max(0, Number(movementDraft.units || 0));
    if (!newUnits) {
      setError("Units must be greater than 0.");
      return;
    }
    const supabase = createClient();
    const oldAmazonDelta = movement.movementType === "amazon_transfer" ? Math.abs(movement.unitsDelta) : 0;
    const oldWarehouseDelta = movement.unitsDelta;

    let newAmazonDelta = 0;
    let newWarehouseDelta = 0;
    if (movement.movementType === "inbound") {
      // Inbound goes to whichever column originally received it (sign of delta).
      if (movement.unitsDelta >= 0) newWarehouseDelta = newUnits;
      else newWarehouseDelta = -newUnits;
    } else if (movement.movementType === "adjustment") {
      newWarehouseDelta = movement.unitsDelta >= 0 ? newUnits : -newUnits;
    } else if (movement.movementType === "outbound") {
      newWarehouseDelta = -newUnits;
    } else {
      // amazon_transfer: warehouse -newUnits, amazon +newUnits.
      newWarehouseDelta = -newUnits;
      newAmazonDelta = newUnits;
    }

    const amazonDiff = newAmazonDelta - oldAmazonDelta;
    const warehouseDiff = newWarehouseDelta - oldWarehouseDelta;

    try {
      await applyDeltaToLatestLevel(movement.mappingId, amazonDiff, warehouseDiff, movementDraft.movementDate);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update stock level.");
      return;
    }

    const { error: updateError } = await supabase
      .from("inventory_movements")
      .update({
        movement_date: movementDraft.movementDate,
        units_delta: newWarehouseDelta !== 0 ? newWarehouseDelta : newAmazonDelta,
        boxes: movementDraft.boxes ? Number(movementDraft.boxes) : null,
        notes: movementDraft.notes || movement.notes,
      })
      .eq("id", movement.id)
      .eq("account_id", accountId);
    if (updateError) {
      setError(updateError.message);
      return;
    }
    setMessage("Stock action updated.");
    cancelEditMovement();
    await loadAll();
  };

  const deleteMovement = async (movement: InventoryMovement) => {
    if (!canEdit) return;
    if (!window.confirm("Reverse and delete this stock action?")) return;
    const supabase = createClient();
    const reverseAmazon = movement.movementType === "amazon_transfer" ? -Math.abs(movement.unitsDelta) : 0;
    const reverseWarehouse = -movement.unitsDelta;
    try {
      await applyDeltaToLatestLevel(movement.mappingId, reverseAmazon, reverseWarehouse, todayIsoUtc());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to reverse stock change.");
      return;
    }
    const { error: deleteError } = await supabase
      .from("inventory_movements")
      .delete()
      .eq("id", movement.id)
      .eq("account_id", accountId);
    if (deleteError) {
      setError(deleteError.message);
      return;
    }
    setMessage("Stock action reversed and deleted.");
    if (lastIntakeSummary?.intakeId === movement.id) setLastIntakeSummary(null);
    await loadAll();
  };

  const intakeEstimate = useMemo(() => {
    const profile = packProfiles.find((p) => p.id === intake.profileId);
    if (!profile) return null;
    const units = Math.max(0, Number(intake.units || 0));
    return palletEstimate(profile, units);
  }, [packProfiles, intake.profileId, intake.units]);

  const selectedTotalPallets = useMemo(() => {
    return selectedRows.reduce((acc, row) => {
      const profile = packProfiles.find((p) => p.id === profileByMapping[row.mappingId]);
      if (!profile) return acc;
      const override = overrides[row.mappingId];
      const suggested = planType === "amazon_requirement" ? row.suggestedAmazonUnits : row.suggestedWarehouseUnits;
      const plannedUnits = Math.max(0, Number(override?.plannedUnits ?? suggested));
      const plannedBoxes = Math.max(
        0,
        Number(override?.plannedBoxes ?? Math.ceil(plannedUnits / Math.max(1, profile.unitsPerBox)))
      );
      const estimate = palletEstimate(profile, plannedBoxes * Math.max(1, profile.unitsPerBox));
      return acc + estimate.pallets;
    }, 0);
  }, [selectedRows, packProfiles, profileByMapping, overrides, planType]);

  const buildPlanItems = (planId: string) =>
    selectedRows.map((row) => {
      const profile = packProfiles.find((p) => p.id === profileByMapping[row.mappingId]);
      const suggested = planType === "amazon_requirement" ? row.suggestedAmazonUnits : row.suggestedWarehouseUnits;
      const plannedUnits = Math.max(0, Number(overrides[row.mappingId]?.plannedUnits ?? suggested));
      const estimate = profile ? palletEstimate(profile, plannedUnits) : { plannedBoxes: 0, pallets: 0, unitsPerBox: 1 };
      const plannedBoxes = Math.max(0, Number(overrides[row.mappingId]?.plannedBoxes ?? estimate.plannedBoxes));
      const pallets = profile
        ? palletEstimate(profile, profile.unitsPerBox > 0 ? plannedBoxes * profile.unitsPerBox : plannedUnits).pallets
        : estimate.pallets;
      const leadTimeDays = mappings.find((m) => m.mappingId === row.mappingId)?.leadTimeDays ?? defaults.leadTimeDays;
      return {
        shipment_plan_id: planId,
        sku_mapping_id: row.mappingId,
        suggested_units: suggested,
        planned_units: plannedUnits,
        units_per_box: estimate.unitsPerBox,
        planned_boxes: plannedBoxes,
        pallets,
        amazon_units_snapshot: row.amazonUnitsOnHand,
        warehouse_units_snapshot: row.warehouseUnitsOnHand,
        lead_time_days: leadTimeDays,
      };
    });

  const saveShipmentPlan = async () => {
    if (!canEdit) return;
    if (selectedRows.length === 0) {
      setError("Select at least one SKU to create shipment plan.");
      return;
    }
    const supabase = createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    const title = planTitle.trim() || "Shipment plan";

    // Block duplicate plan names. The user decides whether to overwrite the
    // existing plan or go back and rename this one. The plan currently being
    // edited is excluded so re-saving it under its own name is always allowed.
    const duplicate = savedPlans.find(
      (p) => p.title.trim().toLowerCase() === title.toLowerCase() && p.id !== editingPlanId
    );
    if (duplicate) {
      const replace =
        typeof window !== "undefined" &&
        window.confirm(
          `A shipment plan named “${title}” already exists.\n\n` +
            `OK — replace the existing plan\n` +
            `Cancel — keep it and change this plan's name first.`
        );
      if (!replace) {
        setError(`A plan named “${title}” already exists — replace it or choose a different name.`);
        return;
      }
      const { error: dupDeleteError } = await supabase
        .from("shipment_plans")
        .delete()
        .eq("id", duplicate.id)
        .eq("account_id", accountId);
      if (dupDeleteError) {
        setError(dupDeleteError.message);
        return;
      }
      if (savedPlanId === duplicate.id) setSavedPlanId(null);
    }

    const orientation = selectedRows.length > 8 ? "landscape" : "portrait";
    const isEditing = Boolean(editingPlanId && editingPlanId !== duplicate?.id);
    let targetPlanId = isEditing ? editingPlanId : null;

    if (isEditing && targetPlanId) {
      const { error: updateError } = await supabase
        .from("shipment_plans")
        .update({ plan_type: planType, title, notes: planNotes.trim() || null, orientation })
        .eq("id", targetPlanId)
        .eq("account_id", accountId);
      if (updateError) {
        setError(updateError.message);
        return;
      }
      // Replace the item set so removed/added SKUs and edits are reflected.
      const { error: clearError } = await supabase
        .from("shipment_plan_items")
        .delete()
        .eq("shipment_plan_id", targetPlanId);
      if (clearError) {
        setError(clearError.message);
        return;
      }
    } else {
      const { data: plan, error: planError } = await supabase
        .from("shipment_plans")
        .insert({
          account_id: accountId,
          plan_type: planType,
          title,
          notes: planNotes.trim() || null,
          orientation,
          created_by: user?.id || null,
        })
        .select("id")
        .single();
      if (planError || !plan?.id) {
        setError(planError?.message || "Failed to create shipment plan.");
        return;
      }
      targetPlanId = String(plan.id);
    }

    if (!targetPlanId) {
      setError("Could not resolve the shipment plan id.");
      return;
    }

    const { error: itemsError } = await supabase.from("shipment_plan_items").insert(buildPlanItems(targetPlanId));
    if (itemsError) {
      setError(itemsError.message);
      return;
    }
    setSavedPlanId(targetPlanId);
    // Stay "attached" to the saved plan so a follow-up save updates it in place
    // instead of creating a duplicate.
    setEditingPlanId(targetPlanId);
    setMessage(isEditing ? "Shipment plan updated." : "Shipment plan saved.");
    await loadSavedPlans();
  };

  const resetPlanner = () => {
    setEditingPlanId(null);
    setSavedPlanId(null);
    setSelectedMappingIds([]);
    setOverrides({});
    setProfileByMapping({});
    setPlanTitle("Weekly replenishment plan");
    setPlanNotes("");
    setPlanType("amazon_requirement");
  };

  const startEditPlan = async (planId: string) => {
    if (!canEdit) return;
    const supabase = createClient();
    const { data, error: loadError } = await supabase
      .from("shipment_plans")
      .select("id, plan_type, title, notes, shipment_plan_items(sku_mapping_id, planned_units, planned_boxes, units_per_box)")
      .eq("id", planId)
      .eq("account_id", accountId)
      .single();
    if (loadError || !data) {
      setError(loadError?.message || "Failed to load the plan for editing.");
      return;
    }
    const planRow = data as unknown as {
      id: string;
      plan_type: string;
      title: string;
      notes: string | null;
      shipment_plan_items: Array<{
        sku_mapping_id: string;
        planned_units: number | null;
        planned_boxes: number | null;
        units_per_box: number | null;
      }> | null;
    };
    const items = planRow.shipment_plan_items || [];
    const nextOverrides: Record<string, PlanRowOverride> = {};
    const nextProfileByMapping: Record<string, string> = {};
    items.forEach((it) => {
      nextOverrides[it.sku_mapping_id] = {
        plannedUnits: Number(it.planned_units || 0),
        plannedBoxes: Number(it.planned_boxes || 0),
      };
      // Best-effort: re-attach a linked profile, preferring one whose box size
      // matches what was saved so pallet maths line up.
      const linkedIds = profileIdsByMapping[it.sku_mapping_id] || [];
      const linkedProfiles = packProfiles.filter((p) => linkedIds.includes(p.id));
      const match =
        linkedProfiles.find((p) => Number(p.unitsPerBox) === Number(it.units_per_box || 0)) || linkedProfiles[0];
      if (match) nextProfileByMapping[it.sku_mapping_id] = match.id;
    });
    setSelectedMappingIds(items.map((it) => it.sku_mapping_id));
    setOverrides(nextOverrides);
    setProfileByMapping(nextProfileByMapping);
    setPlanType(planRow.plan_type === "warehouse_requirement" ? "warehouse_requirement" : "amazon_requirement");
    setPlanTitle(planRow.title || "Shipment plan");
    setPlanNotes(planRow.notes || "");
    setEditingPlanId(planId);
    setSavedPlanId(planId);
    setActiveTab("shipment-planning");
    setMessage(`Editing “${planRow.title}”. Make changes and click Update plan.`);
  };

  const duplicatePlan = async (planId: string) => {
    if (!canEdit) return;
    const supabase = createClient();
    const { data, error: loadError } = await supabase
      .from("shipment_plans")
      .select("id, plan_type, title, notes, shipment_plan_items(sku_mapping_id, planned_units, planned_boxes, units_per_box)")
      .eq("id", planId)
      .eq("account_id", accountId)
      .single();
    if (loadError || !data) {
      setError(loadError?.message || "Failed to load the plan to duplicate.");
      return;
    }
    const planRow = data as unknown as {
      plan_type: string;
      title: string;
      notes: string | null;
      shipment_plan_items: Array<{
        sku_mapping_id: string;
        planned_units: number | null;
        planned_boxes: number | null;
        units_per_box: number | null;
      }> | null;
    };
    const items = planRow.shipment_plan_items || [];
    const nextOverrides: Record<string, PlanRowOverride> = {};
    const nextProfileByMapping: Record<string, string> = {};
    items.forEach((it) => {
      nextOverrides[it.sku_mapping_id] = {
        plannedUnits: Number(it.planned_units || 0),
        plannedBoxes: Number(it.planned_boxes || 0),
      };
      const linkedIds = profileIdsByMapping[it.sku_mapping_id] || [];
      const linkedProfiles = packProfiles.filter((p) => linkedIds.includes(p.id));
      const match =
        linkedProfiles.find((p) => Number(p.unitsPerBox) === Number(it.units_per_box || 0)) || linkedProfiles[0];
      if (match) nextProfileByMapping[it.sku_mapping_id] = match.id;
    });
    setSelectedMappingIds(items.map((it) => it.sku_mapping_id));
    setOverrides(nextOverrides);
    setProfileByMapping(nextProfileByMapping);
    setPlanType(planRow.plan_type === "warehouse_requirement" ? "warehouse_requirement" : "amazon_requirement");
    setPlanTitle(`${planRow.title} (copy)`);
    setPlanNotes(planRow.notes || "");
    // Detach from the source plan so saving creates a brand-new plan.
    setEditingPlanId(null);
    setSavedPlanId(null);
    setActiveTab("shipment-planning");
    setMessage(`Duplicated “${planRow.title}”. Adjust as needed and click Save plan.`);
  };

  const openQuickProfile = (mappingId: string) => {
    setQuickProfile({
      profileName: "",
      unitsPerBox: "",
      boxLength: "",
      boxWidth: "",
      boxHeight: "",
      dimensionUnit: "cm",
      boxWeight: "",
      weightUnit: "kg",
    });
    setQuickProfileMappingId(mappingId);
  };

  const saveQuickProfile = async () => {
    if (!canEdit || !quickProfileMappingId) return;
    if (
      !quickProfile.profileName.trim() ||
      !quickProfile.unitsPerBox ||
      !quickProfile.boxLength ||
      !quickProfile.boxWidth ||
      !quickProfile.boxHeight
    ) {
      setError("Profile name, units/box and dimensions are required.");
      return;
    }
    setQuickProfileSaving(true);
    try {
      const supabase = createClient();
      const {
        data: { user },
      } = await supabase.auth.getUser();
      const { data: savedProfile, error: saveError } = await supabase
        .from("pack_profiles")
        .insert({
          account_id: accountId,
          profile_name: quickProfile.profileName.trim(),
          units_per_box: Number(quickProfile.unitsPerBox),
          box_length: Number(quickProfile.boxLength),
          box_width: Number(quickProfile.boxWidth),
          box_height: Number(quickProfile.boxHeight),
          dimension_unit: quickProfile.dimensionUnit,
          box_weight: quickProfile.boxWeight ? Number(quickProfile.boxWeight) : null,
          weight_unit: quickProfile.weightUnit,
        })
        .select("id")
        .single();
      if (saveError || !savedProfile?.id) {
        setError(saveError?.message || "Failed to save profile.");
        return;
      }
      const newProfileId = String(savedProfile.id);
      const { error: linkError } = await supabase.from("inventory_movements").insert({
        account_id: accountId,
        sku_mapping_id: quickProfileMappingId,
        movement_date: todayIsoUtc(),
        movement_type: "adjustment" as const,
        units_delta: 0,
        boxes: null,
        pack_profile_id: newProfileId,
        notes: "__profile_link__",
        created_by: user?.id || null,
      });
      if (linkError) {
        setError(linkError.message);
        return;
      }
      const mappingId = quickProfileMappingId;
      setQuickProfileMappingId(null);
      await loadAll();
      // Auto-select the freshly created profile for this row.
      setProfileByMapping((prev) => ({ ...prev, [mappingId]: newProfileId }));
      setMessage("Pack profile created and linked to this SKU.");
    } finally {
      setQuickProfileSaving(false);
    }
  };

  const loadSavedPlans = async () => {
    const supabase = createClient();
    const { data, error: plansError } = await supabase
      .from("shipment_plans")
      .select("id, plan_date, plan_type, title, notes, orientation, converted_at, created_at, shipment_plan_items(planned_units, pallets)")
      .eq("account_id", accountId)
      .order("created_at", { ascending: false })
      .limit(200);
    if (plansError) {
      // Non-fatal: keep page usable even if plan history fails to load.
      return;
    }
    const next: SavedShipmentPlan[] = ((data || []) as Array<Record<string, unknown>>).map((row) => {
      const items = (row.shipment_plan_items as Array<{ planned_units?: number; pallets?: number }> | null) || [];
      return {
        id: String(row.id),
        planDate: String(row.plan_date || ""),
        planType: (row.plan_type as SavedShipmentPlan["planType"]) || "manual",
        title: String(row.title || "Shipment plan"),
        notes: (row.notes as string | null) || null,
        orientation: (row.orientation as SavedShipmentPlan["orientation"]) || "portrait",
        itemCount: items.length,
        totalUnits: items.reduce((acc, it) => acc + Number(it.planned_units || 0), 0),
        totalPallets: items.reduce((acc, it) => acc + Number(it.pallets || 0), 0),
        createdAt: String(row.created_at || ""),
        convertedAt: (row.converted_at as string | null) || null,
      };
    });
    setSavedPlans(next);
  };

  const deleteShipmentPlan = async (planId: string) => {
    if (!canEdit) return;
    if (typeof window !== "undefined" && !window.confirm("Delete this shipment plan? This cannot be undone.")) return;
    const supabase = createClient();
    const { error: deleteError } = await supabase
      .from("shipment_plans")
      .delete()
      .eq("id", planId)
      .eq("account_id", accountId);
    if (deleteError) {
      setError(deleteError.message);
      return;
    }
    if (savedPlanId === planId) setSavedPlanId(null);
    if (editingPlanId === planId) setEditingPlanId(null);
    setMessage("Shipment plan deleted.");
    await loadSavedPlans();
  };

  const downloadPlanPdf = async (planId: string) => {
    const response = await fetch(`/api/inventory/shipment-plan/${encodeURIComponent(planId)}/pdf`);
    if (!response.ok) {
      setError(`Shipment PDF failed (${response.status})`);
      return;
    }
    const blob = await response.blob();
    const objectUrl = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = objectUrl;
    a.download = `inventory-shipment-plan-${planId}.pdf`;
    a.click();
    URL.revokeObjectURL(objectUrl);
    setMessage("Shipment plan PDF downloaded.");
  };

  const addWarehouse = async (rawName?: string): Promise<string | null> => {
    if (!canEdit) return null;
    const name = String(rawName || "").trim();
    if (!name) {
      setError("Enter a warehouse name.");
      return null;
    }
    const supabase = createClient();
    const { data, error: insertError } = await supabase
      .from("inventory_warehouses")
      .insert({ account_id: accountId, name })
      .select("id")
      .single();
    if (insertError) {
      setError(insertError.message);
      return null;
    }
    setMessage("Warehouse added.");
    await loadAll();
    return data?.id ? String(data.id) : null;
  };

  const saveDailySaleRows = async () => {
    if (!canEdit) return;
    const rowsToSave = dailyEntryRows.filter((row) => row.mappingId && row.saleDate && row.platform);
    if (rowsToSave.length === 0) {
      setError("Add at least one valid row (SKU, date and platform are required).");
      return;
    }
    const firstInvalid = dailyEntryRows.find((row) => !row.mappingId || !row.saleDate || !row.platform);
    if (firstInvalid) {
      setError("Some rows are incomplete. Fill SKU, date and platform or remove the row.");
      return;
    }
    const supabase = createClient();
    const { error: insertError } = await supabase
      .from("inventory_daily_sales")
      .insert(
        rowsToSave.map((row) => ({
          account_id: accountId,
          sku_mapping_id: row.mappingId,
          sale_date: row.saleDate,
          platform: row.platform,
          warehouse_id: row.warehouseId || null,
          sold_units: Number(row.soldUnits || 0),
          returns_units: Number(row.returnsUnits || 0),
          collected_units: Number(row.collectedUnits || 0),
          notes: row.notes.trim() || null,
        }))
      );
    if (insertError) {
      setError(insertError.message);
      return;
    }
    setMessage(`${rowsToSave.length} daily sales row${rowsToSave.length > 1 ? "s" : ""} saved.`);
    setDailyEntryRows([createDailyEntryRow()]);
    await loadAll();
  };

  const deleteDailySaleRow = async (id: string) => {
    if (!canEdit) return;
    if (!window.confirm("Delete this daily sales row?")) return;
    const supabase = createClient();
    const { error: deleteError } = await supabase
      .from("inventory_daily_sales")
      .delete()
      .eq("id", id)
      .eq("account_id", accountId);
    if (deleteError) {
      setError(deleteError.message);
      return;
    }
    setMessage("Daily sales row deleted.");
    await loadAll();
  };

  const beginEditDailySaleRow = (row: DailySale) => {
    if (!canEdit) return;
    const m = mappingById.get(row.sku_mapping_id);
    setEditingDailySaleId(row.id);
    setDailySaleDraft({
      saleDate: row.sale_date,
      mappingId: row.sku_mapping_id,
      skuSearch: m ? `${m.amazonSku || m.temuSkuId || ""}${m.productName ? ` — ${m.productName}` : ""}` : "",
      platform: (row.platform as DailySaleEditDraft["platform"]) || "amazon",
      warehouseId: row.warehouse_id || "",
      soldUnits: String(row.sold_units ?? 0),
      returnsUnits: String(row.returns_units ?? 0),
      collectedUnits: String(row.collected_units ?? 0),
      notes: row.notes || "",
    });
  };

  const cancelEditDailySaleRow = () => {
    setEditingDailySaleId(null);
    setDailySaleDraft(null);
  };

  const saveEditDailySaleRow = async (rowId: string) => {
    if (!canEdit || !dailySaleDraft) return;
    const soldUnits = Number(dailySaleDraft.soldUnits || 0);
    const returnsUnits = Number(dailySaleDraft.returnsUnits || 0);
    const collectedUnits = Number(dailySaleDraft.collectedUnits || 0);
    if (soldUnits < 0 || returnsUnits < 0 || collectedUnits < 0) {
      setError("Units sold, returns and collected must be non-negative.");
      return;
    }
    if (!dailySaleDraft.saleDate) {
      setError("Please select a sale date.");
      return;
    }
    if (!dailySaleDraft.mappingId) {
      setError("Please select a SKU for this row.");
      return;
    }
    const supabase = createClient();
    const { error: updateError } = await supabase
      .from("inventory_daily_sales")
      .update({
        sale_date: dailySaleDraft.saleDate,
        sku_mapping_id: dailySaleDraft.mappingId,
        platform: dailySaleDraft.platform,
        warehouse_id: dailySaleDraft.warehouseId || null,
        sold_units: soldUnits,
        returns_units: returnsUnits,
        collected_units: collectedUnits,
        notes: dailySaleDraft.notes.trim() || null,
      })
      .eq("id", rowId)
      .eq("account_id", accountId);
    if (updateError) {
      setError(updateError.message);
      return;
    }
    setMessage("Daily sales row updated.");
    setEditingDailySaleId(null);
    setDailySaleDraft(null);
    await loadAll();
  };

  const mappingById = useMemo(() => {
    const map = new Map<string, SkuRef>();
    mappings.forEach((m) => map.set(m.mappingId, m));
    return map;
  }, [mappings]);

  const getFilteredMappingsForRow = (row: DailyEntryRow) => {
    const q = row.skuSearch.trim().toLowerCase();
    if (!q) return mappings;
    return mappings.filter((m) => {
      const sku = String(m.amazonSku || m.temuSkuId || "").toLowerCase();
      const productName = String(m.productName || "").toLowerCase();
      return productName.includes(q) || sku.includes(q);
    });
  };

  const updateDailyEntryRow = (rowId: string, patch: Partial<DailyEntryRow>) => {
    setDailyEntryRows((prev) => prev.map((row) => (row.id === rowId ? { ...row, ...patch } : row)));
  };

  const addDailyEntryFormRow = () => {
    setDailyEntryRows((prev) => [...prev, createDailyEntryRow()]);
  };

  const removeDailyEntryFormRow = (rowId: string) => {
    setDailyEntryRows((prev) => {
      if (prev.length === 1) return prev;
      return prev.filter((row) => row.id !== rowId);
    });
  };

  const dailyRowsFiltered = useMemo(() => {
    const q = dailyHistorySkuSearch.trim().toLowerCase();
    return dailySales.filter((row) => {
      if (dailyFilters.from && row.sale_date < dailyFilters.from) return false;
      if (dailyFilters.to && row.sale_date > dailyFilters.to) return false;
      if (dailyFilters.platform !== "all" && row.platform !== dailyFilters.platform) return false;
      if (dailyFilters.warehouseId !== "all" && (row.warehouse_id || "") !== dailyFilters.warehouseId) return false;
      if (dailyFilters.mappingId !== "all" && row.sku_mapping_id !== dailyFilters.mappingId) return false;
      if (q) {
        const m = mappingById.get(row.sku_mapping_id);
        const sku = String(m?.amazonSku || m?.temuSkuId || "").toLowerCase();
        const name = String(m?.productName || "").toLowerCase();
        if (!sku.includes(q) && !name.includes(q)) return false;
      }
      return true;
    });
  }, [dailySales, dailyFilters, dailyHistorySkuSearch, mappingById]);

  const dailyTotalCount = dailyRowsFiltered.length;
  const dailyTotalPages = Math.max(1, Math.ceil(dailyTotalCount / DAILY_PAGE_SIZE));
  const dailyCurrentPage = Math.floor(dailyOffset / DAILY_PAGE_SIZE) + 1;
  const dailyRowsPaged = dailyRowsFiltered.slice(dailyOffset, dailyOffset + DAILY_PAGE_SIZE);

  useEffect(() => {
    const maxOffset = Math.max(0, (dailyTotalPages - 1) * DAILY_PAGE_SIZE);
    if (dailyOffset > maxOffset) setDailyOffset(maxOffset);
  }, [dailyOffset, dailyTotalPages, DAILY_PAGE_SIZE]);

  const cogsByMapping = useMemo(() => {
    const map = new Map<string, number>();
    const cogsBySku = new Map<string, number>();
    cogs.forEach((row) => {
      if (row.amazonSku) cogsBySku.set(`A:${String(row.amazonSku).trim().toUpperCase()}`, Number(row.unitCost || 0));
      if (row.temuSkuId) cogsBySku.set(`T:${String(row.temuSkuId).trim().toUpperCase()}`, Number(row.unitCost || 0));
    });
    mappings.forEach((m) => {
      const cost =
        cogsBySku.get(`A:${String(m.amazonSku || "").trim().toUpperCase()}`) ??
        cogsBySku.get(`T:${String(m.temuSkuId || "").trim().toUpperCase()}`) ??
        0;
      map.set(m.mappingId, Number(cost || 0));
    });
    return map;
  }, [mappings, cogs]);

  const dailyTotals = useMemo(() => {
    const vatRate = Number(accountVatRate || 0) / 100;
    const excl = dailyRowsFiltered.reduce((acc, row) => {
      const unitCost = cogsByMapping.get(row.sku_mapping_id) || 0;
      const units = Number(row.sold_units || 0);
      return acc + units * unitCost;
    }, 0);
    const incl = excl * (1 + vatRate);
    return {
      excl: Number(excl.toFixed(2)),
      incl: Number(incl.toFixed(2)),
      sold: dailyRowsFiltered.reduce((acc, row) => acc + Number(row.sold_units || 0), 0),
      returns: dailyRowsFiltered.reduce((acc, row) => acc + Number(row.returns_units || 0), 0),
      collected: dailyRowsFiltered.reduce((acc, row) => acc + Number(row.collected_units || 0), 0),
    };
  }, [dailyRowsFiltered, cogsByMapping, accountVatRate]);

  // Phase 3/4 engine: enrich every computed row with reorder points + a health
  // status so the Overview action strip and Replenishment dashboard stay in sync.
  type ReplenRow = (typeof computedRows)[number] & {
    leadTimeDays: number;
    unitCost: number;
    reorderPointAmazon: number;
    reorderPointWarehouse: number;
    amazonStatus: StockStatus;
    warehouseStatus: StockStatus;
    needsReorder: boolean;
    isOverstock: boolean;
  };
  const insights = useMemo(() => {
    const rows: ReplenRow[] = computedRows.map((row) => {
      const lead = mappingById.get(row.mappingId)?.leadTimeDays ?? defaults.leadTimeDays;
      const v = row.dailyVelocity;
      const reorderPointAmazon = Math.ceil(v * lead);
      const reorderPointWarehouse = Math.ceil(v * (lead + defaults.warehouseCoverDays));
      const amazonStatus: StockStatus =
        v <= 0
          ? "idle"
          : row.suggestedAmazonUnits > 0
          ? "reorder"
          : row.amazonDaysLeft != null && row.amazonDaysLeft > defaults.amazonCoverDays * 3
          ? "overstock"
          : "ok";
      const warehouseStatus: StockStatus =
        v <= 0
          ? "idle"
          : row.suggestedWarehouseUnits > 0
          ? "reorder"
          : row.warehouseDaysLeft != null && row.warehouseDaysLeft > (defaults.warehouseCoverDays + lead) * 1.5
          ? "overstock"
          : "ok";
      return {
        ...row,
        leadTimeDays: lead,
        unitCost: cogsByMapping.get(row.mappingId) || 0,
        reorderPointAmazon,
        reorderPointWarehouse,
        amazonStatus,
        warehouseStatus,
        needsReorder: amazonStatus === "reorder" || warehouseStatus === "reorder",
        isOverstock: amazonStatus === "overstock" || warehouseStatus === "overstock",
      };
    });

    const health: HealthIssue[] = [];
    rows.forEach((row) => {
      const label = row.amazonSku || row.temuSkuId || row.productName || "Unknown SKU";
      const onHand = row.amazonUnitsOnHand + row.warehouseUnitsOnHand;
      if (!row.amazonSku && !row.temuSkuId) {
        health.push({ mappingId: row.mappingId, label, issue: "No Amazon SKU or Temu Goods ID set", severity: "error" });
      }
      if (row.amazonUnitsOnHand < 0 || row.warehouseUnitsOnHand < 0) {
        health.push({ mappingId: row.mappingId, label, issue: "Negative stock on hand (data error)", severity: "error" });
      }
      if (onHand > 0 && row.unitCost <= 0) {
        health.push({ mappingId: row.mappingId, label, issue: "Stock on hand but no COGS set", severity: "warn" });
      }
      if (row.dailyVelocity > 0 && onHand === 0) {
        health.push({ mappingId: row.mappingId, label, issue: "Selling but no stock recorded", severity: "warn" });
      }
    });

    return {
      rows,
      reorderCount: rows.filter((r) => r.needsReorder).length,
      overstockCount: rows.filter((r) => r.isOverstock).length,
      idleCount: rows.filter((r) => r.amazonStatus === "idle" && r.amazonUnitsOnHand + r.warehouseUnitsOnHand > 0).length,
      totalStockValue: rows.reduce((acc, r) => acc + r.stockValue, 0),
      health,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [computedRows, mappingById, defaults, cogsByMapping]);

  const replenVisibleRows = useMemo(() => {
    const q = replenSearch.trim().toLowerCase();
    return insights.rows
      .filter((row) => {
        if (replenStatusFilter === "reorder" && !row.needsReorder) return false;
        if (replenStatusFilter === "overstock" && !row.isOverstock) return false;
        if (replenStatusFilter === "idle" && !(row.amazonStatus === "idle" && row.amazonUnitsOnHand + row.warehouseUnitsOnHand > 0))
          return false;
        if (!q) return true;
        return (
          row.productName.toLowerCase().includes(q) ||
          String(row.amazonSku || "").toLowerCase().includes(q) ||
          String(row.temuSkuId || "").toLowerCase().includes(q)
        );
      })
      .sort((a, b) => Number(b.needsReorder) - Number(a.needsReorder) || a.productName.localeCompare(b.productName));
  }, [insights, replenSearch, replenStatusFilter]);

  const replenTotalPages = Math.max(1, Math.ceil(replenVisibleRows.length / REPLEN_PAGE_SIZE));
  const replenCurrentPage = Math.min(replenTotalPages, Math.floor(replenOffset / REPLEN_PAGE_SIZE) + 1);
  const replenPaged = replenVisibleRows.slice((replenCurrentPage - 1) * REPLEN_PAGE_SIZE, replenCurrentPage * REPLEN_PAGE_SIZE);

  // Phase 2 ledger: a single chronological event stream rebuilt (read-only) from
  // real stock movements + manual daily sales + uploaded transaction sales.
  const ledgerEntries = useMemo(() => {
    const movementEventMap: Record<InventoryMovement["movementType"], { event: string; key: LedgerEventKey }> = {
      inbound: { event: "Intake", key: "intake" },
      amazon_transfer: { event: "Send to Amazon", key: "send_amazon" },
      outbound: { event: "Outbound", key: "outbound" },
      adjustment: { event: "Adjustment", key: "adjustment" },
    };
    const entries: LedgerEntry[] = [];
    movements.forEach((mv) => {
      const m = mappingById.get(mv.mappingId);
      const meta = movementEventMap[mv.movementType] || { event: "Adjustment", key: "adjustment" as LedgerEventKey };
      entries.push({
        id: `mv-${mv.id}`,
        date: mv.movementDate,
        mappingId: mv.mappingId,
        product: m?.productName || "—",
        sku: m?.amazonSku || m?.temuSkuId || "—",
        event: meta.event,
        eventKey: meta.key,
        source: "Stock movement",
        delta: Number(mv.unitsDelta || 0),
        isMovement: true,
        notes: mv.notes,
      });
    });
    dailySales.forEach((ds) => {
      const m = mappingById.get(ds.sku_mapping_id);
      const sku = m?.amazonSku || m?.temuSkuId || "—";
      const product = m?.productName || "—";
      if (Number(ds.sold_units || 0) > 0) {
        entries.push({
          id: `ds-sale-${ds.id}`,
          date: ds.sale_date,
          mappingId: ds.sku_mapping_id,
          product,
          sku,
          event: "Sale",
          eventKey: "sale",
          source: `Daily sales (${ds.platform})`,
          delta: -Number(ds.sold_units || 0),
          isMovement: false,
          notes: ds.notes,
        });
      }
      if (Number(ds.returns_units || 0) > 0) {
        entries.push({
          id: `ds-ret-${ds.id}`,
          date: ds.sale_date,
          mappingId: ds.sku_mapping_id,
          product,
          sku,
          event: "Return",
          eventKey: "return",
          source: `Daily sales (${ds.platform})`,
          delta: Number(ds.returns_units || 0),
          isMovement: false,
          notes: ds.notes,
        });
      }
    });
    // Uploaded transaction sales are only folded in when a single SKU is
    // selected — otherwise the aggregate stream would be enormous and noisy.
    if (ledgerFilters.mappingId !== "all") {
      txFacts
        .filter((tx) => tx.mappingId === ledgerFilters.mappingId)
        .forEach((tx, idx) => {
          const m = mappingById.get(tx.mappingId);
          entries.push({
            id: `tx-${tx.mappingId}-${tx.date}-${tx.platform}-${idx}`,
            date: tx.date,
            mappingId: tx.mappingId,
            product: m?.productName || "—",
            sku: m?.amazonSku || m?.temuSkuId || "—",
            event: "Sale",
            eventKey: "sale",
            source: `Reported sales (${tx.platform})`,
            delta: -Number(tx.quantity || 0),
            isMovement: false,
            notes: null,
          });
        });
    }
    return entries
      .filter((e) => {
        if (ledgerFilters.mappingId !== "all" && e.mappingId !== ledgerFilters.mappingId) return false;
        if (ledgerFilters.eventKey !== "all" && e.eventKey !== ledgerFilters.eventKey) return false;
        if (ledgerFilters.from && e.date < ledgerFilters.from) return false;
        if (ledgerFilters.to && e.date > ledgerFilters.to) return false;
        return true;
      })
      .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  }, [movements, dailySales, txFacts, mappingById, ledgerFilters]);

  const ledgerNetMovement = useMemo(
    () => ledgerEntries.filter((e) => e.isMovement).reduce((acc, e) => acc + e.delta, 0),
    [ledgerEntries]
  );
  const ledgerTotalPages = Math.max(1, Math.ceil(ledgerEntries.length / LEDGER_PAGE_SIZE));
  const ledgerCurrentPage = Math.min(ledgerTotalPages, Math.floor(ledgerOffset / LEDGER_PAGE_SIZE) + 1);
  const ledgerPaged = ledgerEntries.slice((ledgerCurrentPage - 1) * LEDGER_PAGE_SIZE, ledgerCurrentPage * LEDGER_PAGE_SIZE);

  const addMappingToPlan = (mappingId: string) => {
    setSelectedMappingIds((prev) => {
      if (prev.includes(mappingId)) {
        setMessage("SKU removed from shipment plan selection.");
        return prev.filter((id) => id !== mappingId);
      }
      setMessage("SKU added to shipment plan selection. Open Shipment Planning when ready.");
      return [...prev, mappingId];
    });
  };

  const downloadDailySalesCsv = () => {
    if (dailyRowsFiltered.length === 0) {
      setError("No daily sales rows in selected filters to export.");
      return;
    }
    const escapeCsv = (value: unknown) => {
      const str = String(value ?? "");
      if (/[",\n\r]/.test(str)) return `"${str.replace(/"/g, '""')}"`;
      return str;
    };
    const headers = [
      "Date",
      "SKU",
      "Product",
      "Platform",
      "Warehouse",
      "Units Sold",
      "Returns",
      "Collected",
      "COGS Excl VAT",
      "COGS Incl VAT",
      "Notes",
    ];
    const vatRate = Number(accountVatRate || 0) / 100;
    const lines = [headers.join(",")];
    dailyRowsFiltered.forEach((row) => {
      const m = mappingById.get(row.sku_mapping_id);
      const wh = warehouses.find((w) => w.id === row.warehouse_id);
      const unitCost = cogsByMapping.get(row.sku_mapping_id) || 0;
      const sold = Number(row.sold_units || 0);
      const excl = sold * unitCost;
      const incl = excl * (1 + vatRate);
      lines.push(
        [
          row.sale_date,
          m?.amazonSku || m?.temuSkuId || "",
          m?.productName || "",
          row.platform,
          wh?.name || "",
          sold,
          row.returns_units,
          row.collected_units,
          excl.toFixed(2),
          incl.toFixed(2),
          row.notes || "",
        ]
          .map(escapeCsv)
          .join(",")
      );
    });
    const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8;" });
    const objectUrl = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = objectUrl;
    a.download = `daily-sales-${dailyFilters.from}_${dailyFilters.to}.csv`;
    a.click();
    URL.revokeObjectURL(objectUrl);
    setMessage("Daily Sales CSV downloaded.");
  };

  const downloadDailySalesPdf = async () => {
    const params = new URLSearchParams({
      accountId,
      from: dailyFilters.from,
      to: dailyFilters.to,
      platform: dailyFilters.platform,
      warehouseId: dailyFilters.warehouseId,
      mappingId: dailyFilters.mappingId,
      skuSearch: dailyHistorySkuSearch.trim(),
    });
    const response = await fetch(`/api/inventory/daily-sales/pdf?${params.toString()}`);
    if (!response.ok) {
      setError(`Daily sales PDF failed (${response.status})`);
      return;
    }
    const blob = await response.blob();
    const objectUrl = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = objectUrl;
    a.download = `daily-sales-${dailyFilters.from}_${dailyFilters.to}.pdf`;
    a.click();
    URL.revokeObjectURL(objectUrl);
    setMessage("Daily Sales PDF downloaded.");
  };

  if (loading) return <p className="text-sm text-slate-500">Loading inventory workspace...</p>;

  return (
    <div className="space-y-4">
      {message ? <p className="rounded-xl bg-green-50 px-3 py-2 text-sm text-green-700">{message}</p> : null}
      {error ? <p className="rounded-xl bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p> : null}

      <section className="rounded-2xl border border-slate-200 bg-white p-2">
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => setActiveTab("overview")}
            className={`rounded-xl px-3 py-2 text-sm font-semibold ${activeTab === "overview" ? "bg-[var(--md-primary)] text-white" : "bg-slate-100 text-slate-700"}`}
          >
            Overview & Velocity
          </button>
          <button
            type="button"
            onClick={() => setActiveTab("replenishment")}
            className={`rounded-xl px-3 py-2 text-sm font-semibold ${activeTab === "replenishment" ? "bg-[var(--md-primary)] text-white" : "bg-slate-100 text-slate-700"}`}
          >
            Replenishment
            {insights.reorderCount > 0 ? (
              <span className="ml-1 rounded-full bg-red-500 px-1.5 py-0.5 text-[10px] font-bold text-white">{insights.reorderCount}</span>
            ) : null}
          </button>
          <button
            type="button"
            onClick={() => setActiveTab("ledger")}
            className={`rounded-xl px-3 py-2 text-sm font-semibold ${activeTab === "ledger" ? "bg-[var(--md-primary)] text-white" : "bg-slate-100 text-slate-700"}`}
          >
            Stock Ledger
          </button>
          <button
            type="button"
            onClick={() => setActiveTab("stock-intake")}
            className={`rounded-xl px-3 py-2 text-sm font-semibold ${activeTab === "stock-intake" ? "bg-[var(--md-primary)] text-white" : "bg-slate-100 text-slate-700"}`}
          >
            Stock Intake & Pallet Calculator
          </button>
          <button
            type="button"
            onClick={() => setActiveTab("shipment-planning")}
            className={`rounded-xl px-3 py-2 text-sm font-semibold ${activeTab === "shipment-planning" ? "bg-[var(--md-primary)] text-white" : "bg-slate-100 text-slate-700"}`}
          >
            Shipment Planning
          </button>
          <button
            type="button"
            onClick={() => setActiveTab("daily-sales")}
            className={`rounded-xl px-3 py-2 text-sm font-semibold ${activeTab === "daily-sales" ? "bg-[var(--md-primary)] text-white" : "bg-slate-100 text-slate-700"}`}
          >
            Daily Sales
          </button>
        </div>
      </section>

      {activeTab === "overview" ? (
        <section className="space-y-3 rounded-2xl border border-slate-200 bg-white p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-sm font-semibold text-slate-800">Overview & Velocity</h3>
            <div className="flex flex-wrap gap-2">
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search SKU or product"
                className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm sm:w-72"
              />
              <label className="text-xs text-slate-600">
                <span className="mb-1 block uppercase tracking-wide text-slate-500">From</span>
                <input
                  type="date"
                  value={periodStartDate}
                  onChange={(e) => setPeriodStartDate(e.target.value)}
                  className="rounded-lg border border-slate-300 px-3 py-2 text-sm"
                />
              </label>
              <label className="text-xs text-slate-600">
                <span className="mb-1 block uppercase tracking-wide text-slate-500">To</span>
                <input
                  type="date"
                  value={periodEndDate}
                  onChange={(e) => setPeriodEndDate(e.target.value)}
                  className="rounded-lg border border-slate-300 px-3 py-2 text-sm"
                />
              </label>
            </div>
          </div>
          <p className="text-xs text-slate-500">
            Selected period metrics and YTD show inline comparison against the immediately previous matching period.
          </p>

          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <button
              type="button"
              onClick={() => {
                setReplenStatusFilter("reorder");
                setReplenOffset(0);
                setActiveTab("replenishment");
              }}
              className="rounded-xl border border-red-200 bg-red-50 p-3 text-left transition hover:bg-red-100"
            >
              <p className="text-2xl font-bold text-red-700">{insights.reorderCount}</p>
              <p className="text-xs font-semibold text-red-700">Reorder now</p>
              <p className="text-[11px] text-red-600/80">Below reorder point</p>
            </button>
            <button
              type="button"
              onClick={() => {
                setReplenStatusFilter("overstock");
                setReplenOffset(0);
                setActiveTab("replenishment");
              }}
              className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-left transition hover:bg-amber-100"
            >
              <p className="text-2xl font-bold text-amber-700">{insights.overstockCount}</p>
              <p className="text-xs font-semibold text-amber-700">Overstocked</p>
              <p className="text-[11px] text-amber-600/80">Excess cover days</p>
            </button>
            <button
              type="button"
              onClick={() => setActiveTab("shipment-planning")}
              className="rounded-xl border border-sky-200 bg-sky-50 p-3 text-left transition hover:bg-sky-100"
            >
              <p className="text-2xl font-bold text-sky-700">{savedPlans.length}</p>
              <p className="text-xs font-semibold text-sky-700">Saved plans</p>
              <p className="text-[11px] text-sky-600/80">Shipment planning</p>
            </button>
            <button
              type="button"
              onClick={() => {
                setActiveTab("ledger");
                setShowDataHealth(true);
              }}
              className={`rounded-xl border p-3 text-left transition ${
                insights.health.length > 0
                  ? "border-orange-200 bg-orange-50 hover:bg-orange-100"
                  : "border-emerald-200 bg-emerald-50 hover:bg-emerald-100"
              }`}
            >
              <p className={`text-2xl font-bold ${insights.health.length > 0 ? "text-orange-700" : "text-emerald-700"}`}>
                {insights.health.length}
              </p>
              <p className={`text-xs font-semibold ${insights.health.length > 0 ? "text-orange-700" : "text-emerald-700"}`}>
                Data issues
              </p>
              <p className={`text-[11px] ${insights.health.length > 0 ? "text-orange-600/80" : "text-emerald-600/80"}`}>
                {insights.health.length > 0 ? "Needs attention" : "All healthy"}
              </p>
            </button>
          </div>
          {canEdit ? (
            <div className="flex flex-wrap items-end gap-2 rounded-xl border border-slate-200 bg-slate-50 p-3">
              <label className="text-xs text-slate-600">
                <span className="mb-1 block uppercase tracking-wide text-slate-500">Stock Date</span>
                <input type="date" value={stockDate} onChange={(e) => setStockDate(e.target.value)} className="rounded-lg border border-slate-300 px-2 py-2 text-sm" />
              </label>
              <button onClick={() => void saveStockSnapshot()} className="rounded-lg bg-[var(--md-primary)] px-3 py-2 text-sm font-semibold text-white">
                Save Stock Updates
              </button>
              <p className="text-xs text-slate-500">3PL stock is auto-updated from intake, transfers, returns and deductions.</p>
            </div>
          ) : null}
          <div className="overflow-x-auto rounded-xl border border-slate-200">
          <table className="min-w-full text-xs">
            <thead className="sticky top-0 z-10 bg-slate-50 text-left uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-2 py-2">Select</th>
                <th className="px-2 py-2">SKU</th>
                <th className="px-2 py-2">
                  <button type="button" onClick={() => onSortClick("product")} className="inline-flex items-center gap-1">
                    Product
                    <span className="text-[10px]">{sortColumn === "product" ? (sortDirection === "asc" ? "↑" : "↓") : "↕"}</span>
                  </button>
                </th>
                <th className="px-2 py-2">
                  <button type="button" onClick={() => onSortClick("selected_amazon")} className="inline-flex items-center gap-1">
                    Selected Period Amazon
                    <span className="text-[10px]">{sortColumn === "selected_amazon" ? (sortDirection === "asc" ? "↑" : "↓") : "↕"}</span>
                  </button>
                </th>
                <th className="px-2 py-2">
                  <button type="button" onClick={() => onSortClick("selected_temu")} className="inline-flex items-center gap-1">
                    Selected Period Temu
                    <span className="text-[10px]">{sortColumn === "selected_temu" ? (sortDirection === "asc" ? "↑" : "↓") : "↕"}</span>
                  </button>
                </th>
                <th className="px-2 py-2">
                  <button type="button" onClick={() => onSortClick("selected_combined")} className="inline-flex items-center gap-1">
                    Selected Period Combined
                    <span className="text-[10px]">{sortColumn === "selected_combined" ? (sortDirection === "asc" ? "↑" : "↓") : "↕"}</span>
                  </button>
                </th>
                <th className="px-2 py-2">
                  <button type="button" onClick={() => onSortClick("ytd")} className="inline-flex items-center gap-1">
                    YTD Units
                    <span className="text-[10px]">{sortColumn === "ytd" ? (sortDirection === "asc" ? "↑" : "↓") : "↕"}</span>
                  </button>
                </th>
                <th className="px-2 py-2">
                  <button type="button" onClick={() => onSortClick("avg_month")} className="inline-flex items-center gap-1">
                    Avg/Mo
                    <span className="text-[10px]">{sortColumn === "avg_month" ? (sortDirection === "asc" ? "↑" : "↓") : "↕"}</span>
                  </button>
                </th>
                <th className="px-2 py-2">
                  <button type="button" onClick={() => onSortClick("amazon_stock")} className="inline-flex items-center gap-1">
                    Amazon Stock
                    <span className="text-[10px]">{sortColumn === "amazon_stock" ? (sortDirection === "asc" ? "↑" : "↓") : "↕"}</span>
                  </button>
                </th>
                <th className="px-2 py-2">
                  <button type="button" onClick={() => onSortClick("warehouse_stock")} className="inline-flex items-center gap-1">
                    3PL Stock
                    <span className="text-[10px]">{sortColumn === "warehouse_stock" ? (sortDirection === "asc" ? "↑" : "↓") : "↕"}</span>
                  </button>
                </th>
                <th className="px-2 py-2">
                  <button type="button" onClick={() => onSortClick("amazon_days")} className="inline-flex items-center gap-1">
                    Amazon Days Left
                    <span className="text-[10px]">{sortColumn === "amazon_days" ? (sortDirection === "asc" ? "↑" : "↓") : "↕"}</span>
                  </button>
                </th>
                <th className="px-2 py-2">
                  <button type="button" onClick={() => onSortClick("warehouse_days")} className="inline-flex items-center gap-1">
                    3PL Days Left
                    <span className="text-[10px]">{sortColumn === "warehouse_days" ? (sortDirection === "asc" ? "↑" : "↓") : "↕"}</span>
                  </button>
                </th>
                <th className="px-2 py-2">
                  <button type="button" onClick={() => onSortClick("stock_value")} className="inline-flex items-center gap-1">
                    Stock Value
                    <span className="text-[10px]">{sortColumn === "stock_value" ? (sortDirection === "asc" ? "↑" : "↓") : "↕"}</span>
                  </button>
                </th>
                <th className="px-2 py-2">
                  <button type="button" onClick={() => onSortClick("potential_sales")} className="inline-flex items-center gap-1">
                    Potential Sales
                    <span className="text-[10px]">{sortColumn === "potential_sales" ? (sortDirection === "asc" ? "↑" : "↓") : "↕"}</span>
                  </button>
                </th>
                <th className="px-2 py-2">
                  <button type="button" onClick={() => onSortClick("potential_profit")} className="inline-flex items-center gap-1">
                    Potential Profit
                    <span className="text-[10px]">{sortColumn === "potential_profit" ? (sortDirection === "asc" ? "↑" : "↓") : "↕"}</span>
                  </button>
                </th>
              </tr>
            </thead>
            <tbody>
              {visibleRows.length === 0 ? (
                <tr>
                  <td className="px-2 py-3 text-slate-500" colSpan={15}>
                    No SKU mappings found yet. Create mappings in COGS first.
                  </td>
                </tr>
              ) : (
                <>
                <tr className="border-t border-slate-200 bg-slate-100/80 font-semibold text-slate-700">
                  <td className="px-2 py-2"></td>
                  <td className="px-2 py-2">Totals</td>
                  <td className="px-2 py-2 text-[11px] font-normal text-slate-500">{overviewTotalCount} SKUs</td>
                  <td className="px-2 py-2">{overviewTotals.selectedAmazon}</td>
                  <td className="px-2 py-2">{overviewTotals.selectedTemu}</td>
                  <td className="px-2 py-2">{overviewTotals.selectedCombined}</td>
                  <td className="px-2 py-2">{overviewTotals.ytd}</td>
                  <td className="px-2 py-2">{Math.round(overviewTotals.avgPerMonth)}</td>
                  <td className="px-2 py-2">{overviewTotals.amazonStock}</td>
                  <td className="px-2 py-2">{overviewTotals.warehouseStock}</td>
                  <td className="px-2 py-2">-</td>
                  <td className="px-2 py-2">-</td>
                  <td className="px-2 py-2">{currency}{overviewTotals.stockValue.toFixed(2)}</td>
                  <td className="px-2 py-2">{currency}{overviewTotals.potentialSales.toFixed(2)}</td>
                  <td className="px-2 py-2">{currency}{overviewTotals.potentialProfit.toFixed(2)}</td>
                </tr>
                {overviewRows.map((row) => {
                  const selectedAmazon = periodUnitsByMapping.get(row.mappingId)?.amazon || 0;
                  const selectedTemu = periodUnitsByMapping.get(row.mappingId)?.temu || 0;
                  const selectedCombined = selectedAmazon + selectedTemu;
                  const previousAmazon = previousPeriodUnitsByMapping.get(row.mappingId)?.amazon || 0;
                  const previousTemu = previousPeriodUnitsByMapping.get(row.mappingId)?.temu || 0;
                  const previousCombined = previousAmazon + previousTemu;
                  const selectedDelta = selectedCombined - previousCombined;
                  const ytd = ytdComparisonByMapping.get(row.mappingId)?.current || 0;
                  const ytdPrevious = ytdComparisonByMapping.get(row.mappingId)?.previous || 0;
                  const ytdDelta = ytd - ytdPrevious;
                  return (
                  <tr key={row.mappingId} className="border-t border-slate-100">
                    <td className="px-2 py-2">
                      <input
                        type="checkbox"
                        checked={selectedMappingIds.includes(row.mappingId)}
                        onChange={(e) =>
                          setSelectedMappingIds((prev) =>
                            e.target.checked ? [...new Set([...prev, row.mappingId])] : prev.filter((id) => id !== row.mappingId)
                          )
                        }
                      />
                    </td>
                    <td className="px-2 py-2 font-medium">
                      {row.amazonSku || row.temuSkuId || "-"}
                      {row.amazonSku && row.temuSkuId ? <span className="ml-1 text-[10px] text-slate-500">(A+T)</span> : null}
                    </td>
                    <td className="px-2 py-2 text-slate-600" title={row.productName}>
                      {shortenName(row.productName)}
                    </td>
                    <td className="px-2 py-2">
                      <div>
                        <p>{selectedAmazon}</p>
                        <p className={`text-[10px] ${selectedAmazon - previousAmazon > 0 ? "text-emerald-700" : selectedAmazon - previousAmazon < 0 ? "text-rose-700" : "text-slate-500"}`}>
                          vs last: {selectedAmazon - previousAmazon > 0 ? "+" : ""}
                          {selectedAmazon - previousAmazon}
                        </p>
                      </div>
                    </td>
                    <td className="px-2 py-2">
                      <div>
                        <p>{selectedTemu}</p>
                        <p className={`text-[10px] ${selectedTemu - previousTemu > 0 ? "text-emerald-700" : selectedTemu - previousTemu < 0 ? "text-rose-700" : "text-slate-500"}`}>
                          vs last: {selectedTemu - previousTemu > 0 ? "+" : ""}
                          {selectedTemu - previousTemu}
                        </p>
                      </div>
                    </td>
                    <td className="px-2 py-2">
                      <div>
                        <p>{selectedCombined}</p>
                        <p className={`text-[10px] ${selectedDelta > 0 ? "text-emerald-700" : selectedDelta < 0 ? "text-rose-700" : "text-slate-500"}`}>
                          vs last: {selectedDelta > 0 ? "+" : ""}
                          {selectedDelta}
                        </p>
                      </div>
                    </td>
                    <td className="px-2 py-2">
                      <div>
                        <p>{ytd}</p>
                        <p className={`text-[10px] ${ytdDelta > 0 ? "text-emerald-700" : ytdDelta < 0 ? "text-rose-700" : "text-slate-500"}`}>
                          vs last: {ytdDelta > 0 ? "+" : ""}
                          {ytdDelta}
                        </p>
                      </div>
                    </td>
                    <td className="px-2 py-2">{row.yearAvgPerMonth}</td>
                    <td className="px-2 py-2">
                      {canEdit ? (
                        <input
                          type="number"
                          value={stockDraft[row.mappingId]?.amazonUnits ?? row.amazonUnitsOnHand}
                          onChange={(e) =>
                            setStockDraft((prev) => ({
                              ...prev,
                              [row.mappingId]: {
                                amazonUnits: Number(e.target.value || 0),
                                warehouseUnits: prev[row.mappingId]?.warehouseUnits ?? row.warehouseUnitsOnHand,
                              },
                            }))
                          }
                          className="w-20 rounded-lg border border-slate-300 px-2 py-1"
                        />
                      ) : (
                        row.amazonUnitsOnHand
                      )}
                    </td>
                    <td className="px-2 py-2">
                      {row.warehouseUnitsOnHand}
                    </td>
                    <td className="px-2 py-2">{row.amazonDaysLeft == null ? "-" : row.amazonDaysLeft}</td>
                    <td className="px-2 py-2">{row.warehouseDaysLeft == null ? "-" : row.warehouseDaysLeft}</td>
                    <td className="px-2 py-2">
                      {currency}
                      {row.stockValue.toFixed(2)}
                    </td>
                    <td className="px-2 py-2">
                      {currency}
                      {row.potentialSalesValue.toFixed(2)}
                    </td>
                    <td className="px-2 py-2">
                      {currency}
                      {row.potentialProfitValue.toFixed(2)}
                    </td>
                  </tr>
                );
                })}
                </>
              )}
            </tbody>
          </table>
        </div>
          <div className="flex flex-wrap items-center justify-end gap-2">
            <span className="text-xs text-slate-500">
              Page {overviewCurrentPage} of {overviewTotalPages} ({overviewTotalCount} items)
            </span>
            <select
              value={overviewCurrentPage}
              onChange={(e) => setOverviewOffset((Number(e.target.value) - 1) * OVERVIEW_PAGE_SIZE)}
              className="rounded-lg border border-slate-300 px-2 py-1.5 text-xs"
            >
              {Array.from({ length: overviewTotalPages }, (_, idx) => idx + 1).map((page) => (
                <option key={page} value={page}>
                  {page}
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={() => setOverviewOffset((prev) => Math.max(0, prev - OVERVIEW_PAGE_SIZE))}
              disabled={overviewOffset === 0}
              className="rounded-lg bg-slate-100 px-3 py-1.5 text-xs font-semibold text-slate-700 disabled:opacity-50"
            >
              Previous
            </button>
            <button
              type="button"
              onClick={() => setOverviewOffset((prev) => prev + OVERVIEW_PAGE_SIZE)}
              disabled={overviewCurrentPage >= overviewTotalPages}
              className="rounded-lg bg-slate-100 px-3 py-1.5 text-xs font-semibold text-slate-700 disabled:opacity-50"
            >
              Next
            </button>
          </div>
        </section>
      ) : null}

      {activeTab === "stock-intake" && canEdit ? (
        <>
          <section className="space-y-2 rounded-2xl border border-slate-200 bg-white p-4">
            <h3 className="text-sm font-semibold text-slate-800">Pack Profile Manager</h3>
            <p className="text-xs text-slate-500">
              Save reusable carton specs once (units/box + dimensions). You can then reuse profiles in stock actions and shipment planning.
            </p>
            <div className="space-y-2 rounded-xl border border-slate-200 bg-slate-50 p-3">
              <label className="text-xs text-slate-600">
                <span className="mb-1 block uppercase tracking-wide text-slate-500">Link profile to SKU(s) first</span>
                <input
                  value={profileSkuSearch}
                  onChange={(e) => setProfileSkuSearch(e.target.value)}
                  placeholder="Search SKU or product"
                  className="w-full rounded-lg border border-slate-300 px-2 py-2 text-sm"
                />
              </label>
              <div className="max-h-32 overflow-auto rounded-lg border border-slate-200 bg-white p-2">
                {profileLinkRows.length === 0 ? (
                  <p className="text-xs text-slate-500">No SKU found for this search.</p>
                ) : (
                  <div className="grid gap-1">
                    {profileLinkRows.map((m) => (
                      <label key={m.mappingId} className="flex items-center gap-2 rounded-md px-2 py-1 text-xs hover:bg-slate-50">
                        <input
                          type="checkbox"
                          checked={newProfileLinkedMappingIds.includes(m.mappingId)}
                          onChange={(e) =>
                            setNewProfileLinkedMappingIds((prev) =>
                              e.target.checked ? [...new Set([...prev, m.mappingId])] : prev.filter((id) => id !== m.mappingId)
                            )
                          }
                        />
                        <span className="font-semibold text-slate-700">{m.amazonSku || m.temuSkuId || "—"}</span>
                        <span className="text-slate-500">({shortenName(m.productName, 40)})</span>
                      </label>
                    ))}
                  </div>
                )}
              </div>
            </div>
            <div className="grid gap-2 md:grid-cols-10">
              <input value={newProfile.profileName} onChange={(e) => setNewProfile((p) => ({ ...p, profileName: e.target.value }))} placeholder="Profile name" className="rounded-lg border border-slate-300 px-2 py-2 text-sm md:col-span-2" />
              <input value={newProfile.unitsPerBox} onChange={(e) => setNewProfile((p) => ({ ...p, unitsPerBox: e.target.value }))} type="number" placeholder="Units/box" className="rounded-lg border border-slate-300 px-2 py-2 text-sm" />
              <input value={newProfile.boxLength} onChange={(e) => setNewProfile((p) => ({ ...p, boxLength: e.target.value }))} type="number" placeholder="Length" className="rounded-lg border border-slate-300 px-2 py-2 text-sm" />
              <input value={newProfile.boxWidth} onChange={(e) => setNewProfile((p) => ({ ...p, boxWidth: e.target.value }))} type="number" placeholder="Width" className="rounded-lg border border-slate-300 px-2 py-2 text-sm" />
              <input value={newProfile.boxHeight} onChange={(e) => setNewProfile((p) => ({ ...p, boxHeight: e.target.value }))} type="number" placeholder="Height" className="rounded-lg border border-slate-300 px-2 py-2 text-sm" />
              <select value={newProfile.dimensionUnit} onChange={(e) => setNewProfile((p) => ({ ...p, dimensionUnit: e.target.value as "mm" | "cm" | "in" }))} className="rounded-lg border border-slate-300 px-2 py-2 text-sm">
                <option value="mm">mm</option>
                <option value="cm">cm</option>
                <option value="in">in</option>
              </select>
              <input value={newProfile.boxWeight} onChange={(e) => setNewProfile((p) => ({ ...p, boxWeight: e.target.value }))} type="number" placeholder="Weight" className="rounded-lg border border-slate-300 px-2 py-2 text-sm" />
              <select value={newProfile.weightUnit} onChange={(e) => setNewProfile((p) => ({ ...p, weightUnit: e.target.value as "kg" | "lb" }))} className="rounded-lg border border-slate-300 px-2 py-2 text-sm">
                <option value="kg">kg</option>
                <option value="lb">lb</option>
              </select>
              <button onClick={() => void addPackProfile()} className="rounded-lg bg-[var(--md-primary)] px-3 py-2 text-sm font-semibold text-white">
                Save profile
              </button>
            </div>
            <div className="overflow-x-auto rounded-xl border border-slate-200">
              <table className="min-w-full text-xs">
                <thead className="bg-slate-100 text-left uppercase tracking-wide text-slate-500">
                  <tr>
                    <th className="px-2 py-2">Profile</th>
                    <th className="px-2 py-2">Units/Box</th>
                    <th className="px-2 py-2">Dimensions</th>
                    <th className="px-2 py-2">Weight</th>
                    <th className="px-2 py-2">Linked SKUs</th>
                    <th className="px-2 py-2 text-right">Action</th>
                  </tr>
                </thead>
                <tbody>
                  {packProfiles.length === 0 ? (
                    <tr>
                      <td className="px-2 py-2 text-slate-500" colSpan={6}>
                        No pack profiles yet.
                      </td>
                    </tr>
                  ) : (
                    packProfiles.flatMap((profile) => {
                      const linkedCount = Object.values(profileIdsByMapping).filter((ids) => ids.includes(profile.id)).length;
                      const editing = editingProfileId === profile.id && profileEditDraft;
                      return [
                        <tr key={profile.id} className="border-t border-slate-200">
                          <td className="px-2 py-2">
                            {editing ? (
                              <input
                                value={profileEditDraft.profileName}
                                onChange={(e) =>
                                  setProfileEditDraft((prev) => (prev ? { ...prev, profileName: e.target.value } : prev))
                                }
                                className="w-40 rounded border border-slate-300 px-2 py-1"
                              />
                            ) : (
                              profile.profileName
                            )}
                          </td>
                          <td className="px-2 py-2">
                            {editing ? (
                              <input
                                type="number"
                                value={profileEditDraft.unitsPerBox}
                                onChange={(e) =>
                                  setProfileEditDraft((prev) =>
                                    prev ? { ...prev, unitsPerBox: Math.max(1, Number(e.target.value || 1)) } : prev
                                  )
                                }
                                className="w-20 rounded border border-slate-300 px-2 py-1"
                              />
                            ) : (
                              profile.unitsPerBox
                            )}
                          </td>
                          <td className="px-2 py-2">
                            {editing ? (
                              <div className="flex items-center gap-1">
                                <input
                                  type="number"
                                  value={profileEditDraft.boxLength}
                                  onChange={(e) =>
                                    setProfileEditDraft((prev) =>
                                      prev ? { ...prev, boxLength: Number(e.target.value || 0) } : prev
                                    )
                                  }
                                  className="w-16 rounded border border-slate-300 px-1 py-1"
                                />
                                <input
                                  type="number"
                                  value={profileEditDraft.boxWidth}
                                  onChange={(e) =>
                                    setProfileEditDraft((prev) =>
                                      prev ? { ...prev, boxWidth: Number(e.target.value || 0) } : prev
                                    )
                                  }
                                  className="w-16 rounded border border-slate-300 px-1 py-1"
                                />
                                <input
                                  type="number"
                                  value={profileEditDraft.boxHeight}
                                  onChange={(e) =>
                                    setProfileEditDraft((prev) =>
                                      prev ? { ...prev, boxHeight: Number(e.target.value || 0) } : prev
                                    )
                                  }
                                  className="w-16 rounded border border-slate-300 px-1 py-1"
                                />
                                <select
                                  value={profileEditDraft.dimensionUnit}
                                  onChange={(e) =>
                                    setProfileEditDraft((prev) =>
                                      prev
                                        ? { ...prev, dimensionUnit: e.target.value as "mm" | "cm" | "in" }
                                        : prev
                                    )
                                  }
                                  className="rounded border border-slate-300 px-1 py-1"
                                >
                                  <option value="mm">mm</option>
                                  <option value="cm">cm</option>
                                  <option value="in">in</option>
                                </select>
                              </div>
                            ) : (
                              `${profile.boxLength} x ${profile.boxWidth} x ${profile.boxHeight} ${profile.dimensionUnit}`
                            )}
                          </td>
                          <td className="px-2 py-2">
                            {editing ? (
                              <div className="flex items-center gap-1">
                                <input
                                  type="number"
                                  value={profileEditDraft.boxWeight ?? ""}
                                  onChange={(e) =>
                                    setProfileEditDraft((prev) =>
                                      prev
                                        ? {
                                            ...prev,
                                            boxWeight: e.target.value ? Number(e.target.value) : null,
                                          }
                                        : prev
                                    )
                                  }
                                  className="w-20 rounded border border-slate-300 px-1 py-1"
                                />
                                <select
                                  value={profileEditDraft.weightUnit}
                                  onChange={(e) =>
                                    setProfileEditDraft((prev) =>
                                      prev ? { ...prev, weightUnit: e.target.value as "kg" | "lb" } : prev
                                    )
                                  }
                                  className="rounded border border-slate-300 px-1 py-1"
                                >
                                  <option value="kg">kg</option>
                                  <option value="lb">lb</option>
                                </select>
                              </div>
                            ) : profile.boxWeight != null ? (
                              `${profile.boxWeight} ${profile.weightUnit}`
                            ) : (
                              "-"
                            )}
                          </td>
                          <td className="px-2 py-2">{linkedCount}</td>
                          <td className="px-2 py-2 text-right">
                            {editing ? (
                              <div className="inline-flex gap-1">
                                <button
                                  type="button"
                                  onClick={() => void updatePackProfile(profileEditDraft)}
                                  className="rounded bg-[var(--md-primary)] px-2 py-1 text-white"
                                >
                                  Save
                                </button>
                                <button
                                  type="button"
                                  onClick={() => {
                                    setEditingProfileId(null);
                                    setProfileEditDraft(null);
                                    setEditingProfileLinkedMappingIds([]);
                                    setEditingProfileSkuSearch("");
                                  }}
                                  className="rounded bg-slate-200 px-2 py-1"
                                >
                                  Cancel
                                </button>
                              </div>
                            ) : (
                              <div className="inline-flex gap-1">
                                <button
                                  type="button"
                                  onClick={() => {
                                    setEditingProfileId(profile.id);
                                    setProfileEditDraft({ ...profile });
                                    setEditingProfileLinkedMappingIds(
                                      Object.entries(profileIdsByMapping)
                                        .filter(([, ids]) => ids.includes(profile.id))
                                        .map(([mappingId]) => mappingId)
                                    );
                                    setEditingProfileSkuSearch("");
                                  }}
                                  className="rounded bg-slate-200 px-2 py-1"
                                >
                                  Edit
                                </button>
                                <button
                                  type="button"
                                  onClick={() => void deletePackProfile(profile.id)}
                                  className="rounded bg-red-100 px-2 py-1 text-red-700"
                                >
                                  Delete
                                </button>
                              </div>
                            )}
                          </td>
                        </tr>,
                        editing ? (
                          <tr key={`${profile.id}-edit-links`} className="bg-slate-50">
                            <td colSpan={6} className="px-3 py-3">
                              <div className="space-y-2">
                                <div className="flex flex-wrap items-center justify-between gap-2">
                                  <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                                    Linked SKUs ({editingProfileLinkedMappingIds.length})
                                  </p>
                                  <input
                                    value={editingProfileSkuSearch}
                                    onChange={(e) => setEditingProfileSkuSearch(e.target.value)}
                                    placeholder="Search SKU or product to add"
                                    className="rounded-lg border border-slate-300 px-2 py-1 text-xs"
                                  />
                                </div>
                                <div className="max-h-40 overflow-auto rounded-lg border border-slate-200 bg-white p-2">
                                  {profileEditLinkRows.length === 0 ? (
                                    <p className="text-xs text-slate-500">No SKU found for this search.</p>
                                  ) : (
                                    <div className="grid gap-1 md:grid-cols-2">
                                      {profileEditLinkRows.map((m) => (
                                        <label
                                          key={m.mappingId}
                                          className="flex items-center gap-2 rounded-md px-2 py-1 text-xs hover:bg-slate-50"
                                        >
                                          <input
                                            type="checkbox"
                                            checked={editingProfileLinkedMappingIds.includes(m.mappingId)}
                                            onChange={(e) =>
                                              setEditingProfileLinkedMappingIds((prev) =>
                                                e.target.checked
                                                  ? [...new Set([...prev, m.mappingId])]
                                                  : prev.filter((id) => id !== m.mappingId)
                                              )
                                            }
                                          />
                                          <span className="font-semibold text-slate-700">{m.amazonSku || m.temuSkuId || "—"}</span>
                                          <span className="text-slate-500">
                                            ({shortenName(m.productName, 40)})
                                          </span>
                                        </label>
                                      ))}
                                    </div>
                                  )}
                                </div>
                                <p className="text-[11px] text-slate-500">
                                  Tick to add, untick to remove. Past stock-intake history for unticked SKUs is preserved — only the link to this profile is cleared.
                                </p>
                              </div>
                            </td>
                          </tr>
                        ) : null,
                      ];
                    })
                  )}
                </tbody>
              </table>
            </div>
          </section>

          <section className="space-y-2 rounded-2xl border border-slate-200 bg-white p-4">
            <h3 className="text-sm font-semibold text-slate-800">Stock Intake Actions</h3>
            <p className="text-xs text-slate-500">
              Use this for supplier inbound, seller returns, B2B/wholesale deductions, and warehouse-to-Amazon transfers.
            </p>
            <div className="grid gap-2 rounded-xl border border-slate-200 bg-slate-50 p-3 md:grid-cols-[1fr_160px_120px_120px_1fr_140px_auto]">
              <SkuCombobox
                value={intake.mappingId}
                onChange={(mappingId) => setIntake((prev) => ({ ...prev, mappingId }))}
                mappings={mappings}
                mappingById={mappingById}
                placeholder="Select SKU"
              />
              <select
                value={intake.profileId}
                onChange={(e) => {
                  const nextProfileId = e.target.value;
                  const p = packProfiles.find((profile) => profile.id === nextProfileId);
                  const currentUnits = Number(intake.units || 0);
                  setIntake((prev) => ({
                    ...prev,
                    profileId: nextProfileId,
                    boxes: p && currentUnits > 0 ? String(Math.ceil(currentUnits / Math.max(1, p.unitsPerBox))) : prev.boxes,
                  }));
                }}
                className="rounded-lg border border-slate-300 px-2 py-2 text-sm"
              >
                <option value="">Select box profile</option>
                {(intake.mappingId
                  ? packProfiles.filter((profile) => (profileIdsByMapping[intake.mappingId] || []).includes(profile.id))
                  : []
                ).map((profile) => (
                  <option key={profile.id} value={profile.id}>
                    {profile.profileName}
                  </option>
                ))}
              </select>
              <select
                value={intake.actionType}
                onChange={(e) => setIntake((prev) => ({ ...prev, actionType: e.target.value as IntakeAction }))}
                className="rounded-lg border border-slate-300 px-2 py-2 text-sm"
              >
                <option value="supplier_inbound">Supplier inbound</option>
                <option value="seller_returns">Seller returns</option>
                <option value="b2b_wholesale">B2B/Wholesale deduction</option>
                <option value="amazon_transfer">Transfer warehouse to Amazon</option>
              </select>
              {intake.actionType === "supplier_inbound" ? (
                <select value={intake.destination} onChange={(e) => setIntake((prev) => ({ ...prev, destination: e.target.value as "warehouse" | "amazon" }))} className="rounded-lg border border-slate-300 px-2 py-2 text-sm">
                  <option value="warehouse">To warehouse</option>
                  <option value="amazon">To Amazon</option>
                </select>
              ) : (
                <div className="rounded-lg border border-slate-200 bg-white px-2 py-2 text-xs text-slate-500">
                  {intake.actionType === "seller_returns"
                    ? "Destination: 3PL warehouse"
                    : intake.actionType === "b2b_wholesale"
                      ? "Source: 3PL warehouse"
                      : "From 3PL to Amazon"}
                </div>
              )}
              <input
                type="number"
                value={intake.units}
                onChange={(e) => {
                  const nextUnits = Number(e.target.value || 0);
                  const selectedProfile = packProfiles.find((p) => p.id === intake.profileId);
                  setIntake((prev) => ({
                    ...prev,
                    units: e.target.value,
                    boxes:
                      selectedProfile && nextUnits > 0
                        ? String(Math.ceil(nextUnits / Math.max(1, selectedProfile.unitsPerBox)))
                        : prev.boxes,
                  }));
                }}
                placeholder="Units"
                className="rounded-lg border border-slate-300 px-2 py-2 text-sm"
              />
              <input
                type="number"
                value={intake.boxes}
                onChange={(e) => {
                  const nextBoxes = Number(e.target.value || 0);
                  const selectedProfile = packProfiles.find((p) => p.id === intake.profileId);
                  setIntake((prev) => ({
                    ...prev,
                    boxes: e.target.value,
                    units:
                      selectedProfile && nextBoxes > 0
                        ? String(nextBoxes * Math.max(1, selectedProfile.unitsPerBox))
                        : prev.units,
                  }));
                }}
                placeholder="Boxes"
                className="rounded-lg border border-slate-300 px-2 py-2 text-sm"
              />
              <input type="date" value={intake.movementDate} onChange={(e) => setIntake((prev) => ({ ...prev, movementDate: e.target.value }))} className="rounded-lg border border-slate-300 px-2 py-2 text-sm" />
              <button onClick={() => void recordStockIntake()} className="rounded-lg bg-slate-900 px-3 py-2 text-sm font-semibold text-white">
                Apply action
              </button>
            </div>
            {intake.mappingId && (profileIdsByMapping[intake.mappingId] || []).length === 0 ? (
              <p className="text-xs text-amber-700">
                No box profile linked to this SKU yet. Create/link a profile in Pack Profile Manager first.
              </p>
            ) : null}

            {/* Live pallet calculator: prominent Units → Boxes → Pallet card */}
            <div className="grid gap-2 rounded-xl border border-slate-200 bg-white p-3 sm:grid-cols-3">
              <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
                <p className="text-[10px] uppercase tracking-wide text-slate-500">Total Units</p>
                <p className="text-2xl font-bold text-slate-900">
                  {intakeEstimate ? Number(intake.units || intakeEstimate.plannedBoxes * intakeEstimate.unitsPerBox || 0) : Number(intake.units || 0)}
                </p>
                <p className="text-[11px] text-slate-500">
                  {intakeEstimate ? `${intakeEstimate.unitsPerBox} units/box` : "Select profile to convert"}
                </p>
              </div>
              <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
                <p className="text-[10px] uppercase tracking-wide text-slate-500">Total Boxes</p>
                <p className="text-2xl font-bold text-slate-900">
                  {intakeEstimate ? intakeEstimate.plannedBoxes : intake.boxes ? Number(intake.boxes) : 0}
                </p>
                <p className="text-[11px] text-slate-500">
                  {intakeEstimate && intakeEstimate.boxesPerPallet > 0
                    ? `${intakeEstimate.boxesPerPallet} boxes/pallet`
                    : "Pack profile sets boxes/pallet"}
                </p>
              </div>
              <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-3">
                <p className="text-[10px] uppercase tracking-wide text-emerald-700">Pallet Footprint</p>
                <p className="text-2xl font-bold text-emerald-900">
                  {intakeEstimate ? intakeEstimate.pallets.toFixed(2) : "—"}
                </p>
                <p className="text-[11px] text-emerald-700">1000×1200mm pallet, max 1800mm stack</p>
              </div>
            </div>
            {!intakeEstimate ? (
              <p className="text-[11px] text-slate-500">
                Live calculation appears once a box profile is selected. Adjust either Units or Boxes — the other side updates automatically.
              </p>
            ) : null}
          </section>

          {lastIntakeSummary ? (
            <section className="space-y-2 rounded-2xl border border-emerald-200 bg-emerald-50 p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <p className="text-[10px] uppercase tracking-wide text-emerald-700">Last action applied</p>
                  <h3 className="text-sm font-semibold text-emerald-900">
                    {lastIntakeSummary.actionLabel} — {lastIntakeSummary.skuLabel}{" "}
                    <span className="text-emerald-700">({lastIntakeSummary.productName})</span>
                  </h3>
                </div>
                <button
                  type="button"
                  onClick={() => setLastIntakeSummary(null)}
                  className="rounded-lg border border-emerald-300 px-2 py-1 text-xs text-emerald-700"
                >
                  Dismiss
                </button>
              </div>
              <div className="grid gap-2 sm:grid-cols-3">
                <div className="rounded-lg border border-emerald-200 bg-white p-3">
                  <p className="text-[10px] uppercase tracking-wide text-emerald-700">Units → Boxes → Pallets</p>
                  <p className="text-sm font-semibold text-slate-900">
                    {lastIntakeSummary.units}
                    {lastIntakeSummary.boxes != null ? ` → ${lastIntakeSummary.boxes} boxes` : ""}
                    {lastIntakeSummary.pallets != null ? ` → ${lastIntakeSummary.pallets.toFixed(2)} pallets` : ""}
                  </p>
                  {lastIntakeSummary.boxesPerPallet ? (
                    <p className="text-[11px] text-slate-500">
                      {lastIntakeSummary.boxesPerPallet} boxes/pallet • {lastIntakeSummary.unitsPerBox} units/box
                    </p>
                  ) : null}
                </div>
                <div className="rounded-lg border border-emerald-200 bg-white p-3">
                  <p className="text-[10px] uppercase tracking-wide text-emerald-700">Amazon stock</p>
                  <p className="text-sm font-semibold text-slate-900">
                    {lastIntakeSummary.amazonBefore} → {lastIntakeSummary.amazonAfter}
                  </p>
                  <p className="text-[11px] text-slate-500">
                    {lastIntakeSummary.amazonAfter - lastIntakeSummary.amazonBefore >= 0 ? "+" : ""}
                    {lastIntakeSummary.amazonAfter - lastIntakeSummary.amazonBefore} units
                  </p>
                </div>
                <div className="rounded-lg border border-emerald-200 bg-white p-3">
                  <p className="text-[10px] uppercase tracking-wide text-emerald-700">3PL warehouse stock</p>
                  <p className="text-sm font-semibold text-slate-900">
                    {lastIntakeSummary.warehouseBefore} → {lastIntakeSummary.warehouseAfter}
                  </p>
                  <p className="text-[11px] text-slate-500">
                    {lastIntakeSummary.warehouseAfter - lastIntakeSummary.warehouseBefore >= 0 ? "+" : ""}
                    {lastIntakeSummary.warehouseAfter - lastIntakeSummary.warehouseBefore} units
                  </p>
                </div>
              </div>
              <p className="text-[11px] text-emerald-700">
                Effective {lastIntakeSummary.movementDate}
                {lastIntakeSummary.notes ? ` • ${lastIntakeSummary.notes}` : ""} • Recorded as intake #{lastIntakeSummary.intakeId.slice(0, 8)}.
              </p>
            </section>
          ) : null}

          <section className="space-y-2 rounded-2xl border border-slate-200 bg-white p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="text-sm font-semibold text-slate-800">Recent Stock Actions</h3>
              <p className="text-xs text-slate-500">Showing latest {Math.min(movements.length, 25)} of {movements.length} actions</p>
            </div>
            <div className="overflow-x-auto rounded-xl border border-slate-200">
              <table className="min-w-full text-xs">
                <thead className="bg-slate-100 text-left uppercase tracking-wide text-slate-500">
                  <tr>
                    <th className="px-2 py-2">Date</th>
                    <th className="px-2 py-2">SKU</th>
                    <th className="px-2 py-2">Action</th>
                    <th className="px-2 py-2 text-right">Units Δ</th>
                    <th className="px-2 py-2 text-right">Boxes</th>
                    <th className="px-2 py-2">Notes</th>
                    <th className="px-2 py-2 text-right">Manage</th>
                  </tr>
                </thead>
                <tbody>
                  {movements.length === 0 ? (
                    <tr>
                      <td colSpan={7} className="px-2 py-3 text-slate-500">
                        No stock actions recorded yet. Use the form above to apply your first one.
                      </td>
                    </tr>
                  ) : (
                    movements.slice(0, 25).map((m) => {
                      const mapping = mappings.find((mp) => mp.mappingId === m.mappingId);
                      const isEditing = editingMovementId === m.id && movementDraft;
                      const typeLabel =
                        m.movementType === "amazon_transfer"
                          ? "Warehouse → Amazon"
                          : m.movementType === "inbound"
                            ? "Inbound"
                            : m.movementType === "outbound"
                              ? "Outbound"
                              : "Adjustment";
                      return (
                        <tr key={m.id} className="border-t border-slate-200 align-top">
                          <td className="px-2 py-2">
                            {isEditing ? (
                              <input
                                type="date"
                                value={movementDraft.movementDate}
                                onChange={(e) =>
                                  setMovementDraft((prev) => (prev ? { ...prev, movementDate: e.target.value } : prev))
                                }
                                className="w-32 rounded border border-slate-300 px-2 py-1"
                              />
                            ) : (
                              m.movementDate
                            )}
                          </td>
                          <td className="px-2 py-2">
                            <p className="font-semibold text-slate-700">{mapping?.amazonSku || mapping?.temuSkuId || "—"}</p>
                            <p className="text-[11px] text-slate-500">{shortenName(mapping?.productName || "—", 36)}</p>
                          </td>
                          <td className="px-2 py-2">{typeLabel}</td>
                          <td className="px-2 py-2 text-right">
                            {isEditing ? (
                              <input
                                type="number"
                                value={movementDraft.units}
                                onChange={(e) =>
                                  setMovementDraft((prev) => (prev ? { ...prev, units: e.target.value } : prev))
                                }
                                className="w-20 rounded border border-slate-300 px-2 py-1 text-right"
                              />
                            ) : (
                              <span className={m.unitsDelta >= 0 ? "text-emerald-700" : "text-rose-700"}>
                                {m.unitsDelta >= 0 ? "+" : ""}
                                {m.unitsDelta}
                              </span>
                            )}
                          </td>
                          <td className="px-2 py-2 text-right">
                            {isEditing ? (
                              <input
                                type="number"
                                value={movementDraft.boxes}
                                onChange={(e) =>
                                  setMovementDraft((prev) => (prev ? { ...prev, boxes: e.target.value } : prev))
                                }
                                className="w-20 rounded border border-slate-300 px-2 py-1 text-right"
                              />
                            ) : m.boxes != null ? (
                              m.boxes
                            ) : (
                              "-"
                            )}
                          </td>
                          <td className="px-2 py-2 text-slate-600">
                            {isEditing ? (
                              <input
                                value={movementDraft.notes}
                                onChange={(e) =>
                                  setMovementDraft((prev) => (prev ? { ...prev, notes: e.target.value } : prev))
                                }
                                className="w-48 rounded border border-slate-300 px-2 py-1"
                              />
                            ) : (
                              m.notes || "-"
                            )}
                          </td>
                          <td className="px-2 py-2 text-right">
                            {isEditing ? (
                              <div className="inline-flex gap-1">
                                <button
                                  type="button"
                                  onClick={() => void saveEditedMovement(m)}
                                  className="rounded bg-[var(--md-primary)] px-2 py-1 text-white"
                                >
                                  Save
                                </button>
                                <button
                                  type="button"
                                  onClick={cancelEditMovement}
                                  className="rounded bg-slate-200 px-2 py-1"
                                >
                                  Cancel
                                </button>
                              </div>
                            ) : (
                              <div className="inline-flex gap-1">
                                <button
                                  type="button"
                                  onClick={() => beginEditMovement(m)}
                                  className="rounded bg-slate-200 px-2 py-1"
                                >
                                  Edit
                                </button>
                                <button
                                  type="button"
                                  onClick={() => void deleteMovement(m)}
                                  className="rounded bg-red-100 px-2 py-1 text-red-700"
                                >
                                  Delete
                                </button>
                              </div>
                            )}
                          </td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>
            <p className="text-[11px] text-slate-500">
              Edit replaces the recorded units (or boxes / date / notes) and applies the difference to the latest stock snapshot. Delete reverses the action and removes it.
            </p>
          </section>
        </>
      ) : null}

      {activeTab === "shipment-planning" ? (
      <section className="space-y-2 rounded-2xl border border-slate-200 bg-white p-4">
        <h3 className="text-sm font-semibold text-slate-800">Shipment Planning (Multi-SKU)</h3>
        <div className="space-y-2 rounded-xl border border-slate-200 bg-slate-50 p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-xs text-slate-600">
              Select SKUs for this shipment plan. You can select here directly (same selection as Overview tab).
            </p>
            <p className="text-xs font-semibold text-slate-700">Selected: {selectedMappingIds.length}</p>
          </div>
          <div className="flex flex-wrap gap-2">
            <input
              value={plannerSearch}
              onChange={(e) => setPlannerSearch(e.target.value)}
              placeholder="Search SKU or product for planner"
              className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm sm:w-80"
            />
            <button
              type="button"
              onClick={() => setSelectedMappingIds(plannerVisibleRows.map((r) => r.mappingId))}
              className="rounded-lg bg-slate-100 px-3 py-2 text-xs font-semibold text-slate-700"
            >
              Select visible
            </button>
            <button
              type="button"
              onClick={() =>
                setSelectedMappingIds((prev) => prev.filter((id) => !plannerVisibleRows.some((r) => r.mappingId === id)))
              }
              className="rounded-lg bg-slate-100 px-3 py-2 text-xs font-semibold text-slate-700"
            >
              Clear visible
            </button>
          </div>
          <div className="max-h-44 overflow-auto rounded-lg border border-slate-200 bg-white p-2">
            {plannerVisibleRows.length === 0 ? (
              <p className="text-xs text-slate-500">No SKUs match your search.</p>
            ) : (
              <div className="grid gap-1">
                {plannerVisibleRows.map((row) => (
                  <label key={row.mappingId} className="flex items-center gap-2 rounded-md px-2 py-1 text-xs hover:bg-slate-50">
                    <input
                      type="checkbox"
                      checked={selectedMappingIds.includes(row.mappingId)}
                      onChange={(e) =>
                        setSelectedMappingIds((prev) =>
                          e.target.checked ? [...new Set([...prev, row.mappingId])] : prev.filter((id) => id !== row.mappingId)
                        )
                      }
                    />
                    <span className="font-semibold text-slate-700">{row.amazonSku || row.temuSkuId || "No SKU"}</span>
                    <span className="text-slate-500">({row.productName})</span>
                  </label>
                ))}
              </div>
            )}
          </div>
        </div>
        <div className="grid gap-2 md:grid-cols-[1fr_1fr_1fr_auto]">
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setPlanType("amazon_requirement")}
              className={`rounded-lg px-3 py-2 text-sm font-semibold ${planType === "amazon_requirement" ? "bg-[var(--md-primary)] text-white" : "bg-slate-100 text-slate-700"}`}
            >
              Send to Amazon
            </button>
            <button
              type="button"
              onClick={() => setPlanType("warehouse_requirement")}
              className={`rounded-lg px-3 py-2 text-sm font-semibold ${planType === "warehouse_requirement" ? "bg-[var(--md-primary)] text-white" : "bg-slate-100 text-slate-700"}`}
            >
              Order from Supplier
            </button>
          </div>
          <input value={planTitle} onChange={(e) => setPlanTitle(e.target.value)} placeholder="Plan title" className="rounded-lg border border-slate-300 px-2 py-2 text-sm" />
          <input value={planNotes} onChange={(e) => setPlanNotes(e.target.value)} placeholder="Notes" className="rounded-lg border border-slate-300 px-2 py-2 text-sm" />
          {canEdit ? (
            <div className="flex items-center gap-2">
              <button onClick={() => void saveShipmentPlan()} className="rounded-lg bg-[var(--md-primary)] px-3 py-2 text-sm font-semibold text-white">
                {editingPlanId ? "Update plan" : "Save plan"}
              </button>
              {editingPlanId ? (
                <button
                  type="button"
                  onClick={resetPlanner}
                  className="rounded-lg bg-slate-100 px-3 py-2 text-sm font-semibold text-slate-700"
                >
                  New plan
                </button>
              ) : null}
            </div>
          ) : null}
        </div>
        {editingPlanId ? (
          <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs font-medium text-amber-800">
            Editing a saved plan — changes overwrite it when you click “Update plan”. Click “New plan” to start a fresh one.
          </p>
        ) : null}

        <div className="overflow-x-auto rounded-xl border border-slate-200">
          <table className="min-w-full text-xs">
            <thead className="bg-slate-50 text-left uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-2 py-2">SKU</th>
                <th className="px-2 py-2">Product</th>
                <th className="px-2 py-2">Suggested Units</th>
                <th className="px-2 py-2">Planned Units</th>
                <th className="px-2 py-2">Box Profile</th>
                <th className="px-2 py-2">Planned Boxes</th>
                <th className="px-2 py-2">Pallets</th>
                <th className="px-2 py-2">Lead Time</th>
              </tr>
            </thead>
            <tbody>
              {selectedRows.length === 0 ? (
                <tr>
                  <td className="px-2 py-3 text-slate-500" colSpan={8}>
                    Select SKUs from the selector above to build shipment plan.
                  </td>
                </tr>
              ) : (
                selectedRows.map((row) => {
                  const linkedProfileIds = profileIdsByMapping[row.mappingId] || [];
                  const availableProfiles = packProfiles.filter((p) => linkedProfileIds.includes(p.id));
                  const profile = packProfiles.find((p) => p.id === profileByMapping[row.mappingId]);
                  const suggested = planType === "amazon_requirement" ? row.suggestedAmazonUnits : row.suggestedWarehouseUnits;
                  const plannedUnits = Number(overrides[row.mappingId]?.plannedUnits ?? suggested);
                  const estimate = profile ? palletEstimate(profile, plannedUnits) : { plannedBoxes: 0, pallets: 0, unitsPerBox: 1 };
                  const overrideBoxes = Number(overrides[row.mappingId]?.plannedBoxes ?? estimate.plannedBoxes);
                  return (
                    <tr key={row.mappingId} className="border-t border-slate-100">
                      <td className="px-2 py-2 font-medium">{row.amazonSku || row.temuSkuId || "—"}</td>
                      <td className="px-2 py-2 text-slate-600" title={row.productName}>{shortenName(row.productName)}</td>
                      <td className="px-2 py-2">{suggested}</td>
                      <td className="px-2 py-2">
                        {canEdit ? (
                          <input
                            type="number"
                            value={plannedUnits}
                            onChange={(e) =>
                              setOverrides((prev) => ({
                                ...prev,
                                [row.mappingId]: {
                                  plannedUnits: Number(e.target.value || 0),
                                  plannedBoxes:
                                    profile && profile.unitsPerBox > 0
                                      ? Math.ceil(Number(e.target.value || 0) / profile.unitsPerBox)
                                      : 0,
                                },
                              }))
                            }
                            className="w-24 rounded-lg border border-slate-300 px-2 py-1"
                          />
                        ) : (
                          plannedUnits
                        )}
                      </td>
                      <td className="px-2 py-2">
                        {canEdit ? (
                          <div className="flex items-center gap-1">
                            <select
                              value={profileByMapping[row.mappingId] || ""}
                              onChange={(e) => {
                                const nextProfileId = e.target.value;
                                setProfileByMapping((prev) => ({ ...prev, [row.mappingId]: nextProfileId }));
                                const selectedProfile = packProfiles.find((p) => p.id === nextProfileId);
                                if (selectedProfile) {
                                  setOverrides((prev) => ({
                                    ...prev,
                                    [row.mappingId]: {
                                      plannedUnits: Number(prev[row.mappingId]?.plannedUnits ?? suggested),
                                      plannedBoxes: Math.ceil(
                                        Number(prev[row.mappingId]?.plannedUnits ?? suggested) / selectedProfile.unitsPerBox
                                      ),
                                    },
                                  }));
                                }
                              }}
                              className="rounded-lg border border-slate-300 px-2 py-1"
                            >
                              <option value="">
                                {availableProfiles.length > 0 ? "Select profile" : "No linked profile"}
                              </option>
                              {availableProfiles.map((p) => (
                                <option key={p.id} value={p.id}>
                                  {p.profileName}
                                </option>
                              ))}
                            </select>
                            <button
                              type="button"
                              onClick={() => openQuickProfile(row.mappingId)}
                              title="Create a new pack profile and link it to this SKU"
                              className="shrink-0 rounded-lg border border-[var(--md-primary)] px-2 py-1 text-xs font-semibold text-[var(--md-primary)] hover:bg-[var(--md-primary)] hover:text-white"
                            >
                              + New
                            </button>
                          </div>
                        ) : (
                          profile?.profileName || "-"
                        )}
                      </td>
                      <td className="px-2 py-2">
                        {canEdit ? (
                          <input
                            type="number"
                            value={overrideBoxes}
                            onChange={(e) =>
                              setOverrides((prev) => ({
                                ...prev,
                                [row.mappingId]: {
                                  plannedBoxes: Number(e.target.value || 0),
                                  plannedUnits: profile ? Number(e.target.value || 0) * profile.unitsPerBox : Number(e.target.value || 0),
                                },
                              }))
                            }
                            className="w-24 rounded-lg border border-slate-300 px-2 py-1"
                          />
                        ) : (
                          overrideBoxes
                        )}
                      </td>
                      <td className="px-2 py-2">{estimate.pallets.toFixed(2)}</td>
                      <td className="px-2 py-2">{mappings.find((m) => m.mappingId === row.mappingId)?.leadTimeDays ?? defaults.leadTimeDays} days</td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-sm text-slate-700">
            Total pallets: <span className="font-semibold">{selectedTotalPallets.toFixed(2)}</span>
          </p>
          {savedPlanId ? (
            <button onClick={() => void downloadPlanPdf(savedPlanId)} className="rounded-lg bg-slate-900 px-3 py-2 text-sm font-semibold text-white">
              Download Shipment PDF
            </button>
          ) : null}
        </div>

        <div className="space-y-2 rounded-xl border border-slate-200 bg-slate-50 p-3">
          <div className="flex items-center justify-between">
            <h4 className="text-sm font-semibold text-slate-800">Saved Plans</h4>
            <span className="text-xs text-slate-500">{savedPlans.length} saved</span>
          </div>
          {savedPlans.length === 0 ? (
            <p className="text-xs text-slate-500">No saved shipment plans yet. Build a plan above and click “Save plan”.</p>
          ) : (
            <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white">
              <table className="min-w-full text-xs">
                <thead className="bg-slate-50 text-left uppercase tracking-wide text-slate-500">
                  <tr>
                    <th className="px-2 py-2">Title</th>
                    <th className="px-2 py-2">Type</th>
                    <th className="px-2 py-2">Date</th>
                    <th className="px-2 py-2">SKUs</th>
                    <th className="px-2 py-2">Units</th>
                    <th className="px-2 py-2">Pallets</th>
                    <th className="px-2 py-2 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {savedPlans.map((plan) => (
                    <tr key={plan.id} className="border-t border-slate-100">
                      <td className="px-2 py-2 font-medium text-slate-800" title={plan.notes || undefined}>
                        <div className="flex items-center gap-2">
                          <span>{plan.title}</span>
                          {plan.convertedAt ? (
                            <span
                              className="rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-emerald-700"
                              title={`Converted to stock intake on ${formatUkDate(plan.convertedAt.slice(0, 10))}`}
                            >
                              Converted
                            </span>
                          ) : null}
                        </div>
                      </td>
                      <td className="px-2 py-2 text-slate-600">
                        {plan.planType === "amazon_requirement"
                          ? "Send to Amazon"
                          : plan.planType === "warehouse_requirement"
                          ? "Order from Supplier"
                          : "Manual"}
                      </td>
                      <td className="px-2 py-2 text-slate-600">{formatUkDate(plan.planDate)}</td>
                      <td className="px-2 py-2">{plan.itemCount}</td>
                      <td className="px-2 py-2">{plan.totalUnits.toLocaleString()}</td>
                      <td className="px-2 py-2">{plan.totalPallets.toFixed(2)}</td>
                      <td className="px-2 py-2">
                        <div className="flex justify-end gap-1">
                          {canEdit && !plan.convertedAt ? (
                            <button
                              type="button"
                              onClick={() => void startEditPlan(plan.id)}
                              className={`rounded px-2 py-1 font-semibold ${
                                editingPlanId === plan.id
                                  ? "bg-[var(--md-primary)] text-white"
                                  : "bg-slate-100 text-slate-700"
                              }`}
                            >
                              {editingPlanId === plan.id ? "Editing" : "Edit"}
                            </button>
                          ) : null}
                          {canEdit && !plan.convertedAt ? (
                            <button
                              type="button"
                              onClick={() => void convertPlanToStockIntake(plan.id)}
                              className="rounded bg-emerald-50 px-2 py-1 font-semibold text-emerald-700"
                              title="Record this plan as stock intake actions"
                            >
                              To Intake
                            </button>
                          ) : null}
                          {canEdit ? (
                            <button
                              type="button"
                              onClick={() => void duplicatePlan(plan.id)}
                              className="rounded bg-slate-100 px-2 py-1 font-semibold text-slate-700"
                              title="Copy this plan into a new draft"
                            >
                              Duplicate
                            </button>
                          ) : null}
                          <button
                            type="button"
                            onClick={() => void downloadPlanPdf(plan.id)}
                            className="rounded bg-slate-900 px-2 py-1 font-semibold text-white"
                          >
                            PDF
                          </button>
                          {canEdit ? (
                            <button
                              type="button"
                              onClick={() => void deleteShipmentPlan(plan.id)}
                              className="rounded bg-red-50 px-2 py-1 font-semibold text-red-700"
                            >
                              Delete
                            </button>
                          ) : null}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {quickProfileMappingId ? (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4">
            <div className="w-full max-w-lg rounded-2xl border border-slate-200 bg-white p-4 shadow-xl">
              <div className="mb-1 flex items-center justify-between">
                <h4 className="text-sm font-semibold text-slate-800">New pack profile</h4>
                <button
                  type="button"
                  onClick={() => setQuickProfileMappingId(null)}
                  className="rounded-lg px-2 py-1 text-xs font-semibold text-slate-500 hover:bg-slate-100"
                >
                  ✕
                </button>
              </div>
              <p className="mb-3 text-xs text-slate-500">
                Creating and linking a profile to{" "}
                <span className="font-semibold text-slate-700">
                  {dailyEntryMappingLabel(mappingById.get(quickProfileMappingId))}
                </span>
                .
              </p>
              <div className="grid gap-2 sm:grid-cols-2">
                <input
                  value={quickProfile.profileName}
                  onChange={(e) => setQuickProfile((p) => ({ ...p, profileName: e.target.value }))}
                  placeholder="Profile name"
                  className="rounded-lg border border-slate-300 px-2 py-2 text-sm sm:col-span-2"
                />
                <input
                  value={quickProfile.unitsPerBox}
                  onChange={(e) => setQuickProfile((p) => ({ ...p, unitsPerBox: e.target.value }))}
                  type="number"
                  placeholder="Units / box"
                  className="rounded-lg border border-slate-300 px-2 py-2 text-sm"
                />
                <select
                  value={quickProfile.dimensionUnit}
                  onChange={(e) => setQuickProfile((p) => ({ ...p, dimensionUnit: e.target.value as "mm" | "cm" | "in" }))}
                  className="rounded-lg border border-slate-300 px-2 py-2 text-sm"
                >
                  <option value="mm">mm</option>
                  <option value="cm">cm</option>
                  <option value="in">in</option>
                </select>
                <input
                  value={quickProfile.boxLength}
                  onChange={(e) => setQuickProfile((p) => ({ ...p, boxLength: e.target.value }))}
                  type="number"
                  placeholder="Length"
                  className="rounded-lg border border-slate-300 px-2 py-2 text-sm"
                />
                <input
                  value={quickProfile.boxWidth}
                  onChange={(e) => setQuickProfile((p) => ({ ...p, boxWidth: e.target.value }))}
                  type="number"
                  placeholder="Width"
                  className="rounded-lg border border-slate-300 px-2 py-2 text-sm"
                />
                <input
                  value={quickProfile.boxHeight}
                  onChange={(e) => setQuickProfile((p) => ({ ...p, boxHeight: e.target.value }))}
                  type="number"
                  placeholder="Height"
                  className="rounded-lg border border-slate-300 px-2 py-2 text-sm"
                />
                <div className="grid grid-cols-[1fr_92px] gap-2">
                  <input
                    value={quickProfile.boxWeight}
                    onChange={(e) => setQuickProfile((p) => ({ ...p, boxWeight: e.target.value }))}
                    type="number"
                    placeholder="Weight"
                    className="rounded-lg border border-slate-300 px-2 py-2 text-sm"
                  />
                  <select
                    value={quickProfile.weightUnit}
                    onChange={(e) => setQuickProfile((p) => ({ ...p, weightUnit: e.target.value as "kg" | "lb" }))}
                    className="rounded-lg border border-slate-300 px-2 py-2 text-sm"
                  >
                    <option value="kg">kg</option>
                    <option value="lb">lb</option>
                  </select>
                </div>
              </div>
              <div className="mt-3 flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setQuickProfileMappingId(null)}
                  className="rounded-lg bg-slate-100 px-3 py-2 text-sm font-semibold text-slate-700"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={() => void saveQuickProfile()}
                  disabled={quickProfileSaving}
                  className="rounded-lg bg-[var(--md-primary)] px-3 py-2 text-sm font-semibold text-white disabled:opacity-60"
                >
                  {quickProfileSaving ? "Saving..." : "Create & link"}
                </button>
              </div>
            </div>
          </div>
        ) : null}
      </section>
      ) : null}

      {activeTab === "daily-sales" ? (
        <section className="space-y-3 rounded-2xl border border-slate-200 bg-white p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-sm font-semibold text-slate-800">Daily Sales</h3>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => downloadDailySalesCsv()}
                className="rounded-lg bg-slate-100 px-3 py-2 text-xs font-semibold text-slate-700"
              >
                Download CSV
              </button>
              <button
                type="button"
                onClick={() => void downloadDailySalesPdf()}
                className="rounded-lg bg-slate-900 px-3 py-2 text-xs font-semibold text-white"
              >
                Download PDF
              </button>
            </div>
          </div>

          <div className="space-y-2 rounded-xl border border-slate-200 bg-slate-50 p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Daily Entry Rows</p>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={addDailyEntryFormRow}
                  disabled={!canEdit}
                  className="rounded-lg bg-slate-100 px-3 py-1.5 text-xs font-semibold text-slate-700 disabled:opacity-50"
                >
                  + Add Row
                </button>
                <button
                  type="button"
                  onClick={() => void saveDailySaleRows()}
                  disabled={!canEdit}
                  className="rounded-lg bg-[var(--md-primary)] px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50"
                >
                  Save All Rows
                </button>
              </div>
            </div>

            {dailyEntryRows.map((entryRow, idx) => {
              const filteredMappings = getFilteredMappingsForRow(entryRow);
              return (
                <div
                  key={entryRow.id}
                  className="grid gap-2 rounded-lg border border-slate-200 bg-white p-2 md:grid-cols-[1fr_124px_108px_170px_96px_96px_96px_1fr_auto]"
                >
                  <div className="relative">
                    <button
                      type="button"
                      disabled={!canEdit}
                      onClick={() => setOpenEntrySkuDropdownId((prev) => (prev === entryRow.id ? null : entryRow.id))}
                      className="flex w-full items-center justify-between gap-1 rounded-lg border border-slate-300 px-2 py-1.5 text-left text-xs disabled:opacity-50"
                      title={entryRow.mappingId ? dailyEntryMappingLabel(mappingById.get(entryRow.mappingId)) : undefined}
                    >
                      <span className={`truncate ${entryRow.mappingId ? "text-slate-800" : "text-slate-400"}`}>
                        {entryRow.mappingId ? dailyEntryMappingLabel(mappingById.get(entryRow.mappingId)) : "Select SKU / product"}
                      </span>
                      <span className="shrink-0 text-[10px] text-slate-400">▾</span>
                    </button>
                    {openEntrySkuDropdownId === entryRow.id ? (
                      <>
                        <div className="fixed inset-0 z-10" onClick={() => setOpenEntrySkuDropdownId(null)} />
                        <div className="absolute left-0 top-full z-20 mt-1 w-72 rounded-lg border border-slate-200 bg-white p-2 shadow-lg">
                          <input
                            autoFocus
                            value={entryRow.skuSearch}
                            onChange={(e) => updateDailyEntryRow(entryRow.id, { skuSearch: e.target.value })}
                            placeholder="Search SKU / product"
                            className="mb-1 w-full rounded-lg border border-slate-300 px-2 py-1.5 text-xs"
                          />
                          <div className="max-h-52 overflow-auto">
                            {filteredMappings.length === 0 ? (
                              <p className="px-2 py-1 text-[11px] text-slate-500">No results found.</p>
                            ) : (
                              filteredMappings.slice(0, 50).map((m) => (
                                <button
                                  key={m.mappingId}
                                  type="button"
                                  onClick={() => {
                                    updateDailyEntryRow(entryRow.id, { mappingId: m.mappingId });
                                    setOpenEntrySkuDropdownId(null);
                                  }}
                                  className={`mb-1 block w-full rounded-md px-2 py-1 text-left text-[11px] ${
                                    entryRow.mappingId === m.mappingId ? "bg-[var(--md-primary)] text-white" : "bg-white text-slate-700 hover:bg-slate-100"
                                  }`}
                                  disabled={!canEdit}
                                >
                                  {(m.amazonSku || m.temuSkuId || "—") + " — " + shortenName(m.productName, 36)}
                                </button>
                              ))
                            )}
                          </div>
                        </div>
                      </>
                    ) : null}
                  </div>

                  <input
                    type="date"
                    value={entryRow.saleDate}
                    onChange={(e) => updateDailyEntryRow(entryRow.id, { saleDate: e.target.value })}
                    className="rounded-lg border border-slate-300 px-2 py-1.5 text-xs"
                    disabled={!canEdit}
                  />

                  <select
                    value={entryRow.platform}
                    onChange={(e) => updateDailyEntryRow(entryRow.id, { platform: e.target.value as DailyEntryRow["platform"] })}
                    className="rounded-lg border border-slate-300 px-2 py-1.5 text-xs"
                    disabled={!canEdit}
                  >
                    <option value="amazon">Amazon</option>
                    <option value="temu">Temu</option>
                    <option value="tiktok">TikTok</option>
                  </select>

                  <select
                    value={entryRow.warehouseId}
                    onChange={(e) => {
                      const next = e.target.value;
                      if (next === "__add_new__") {
                        const name = window.prompt("Warehouse name");
                        if (!name) return;
                        void addWarehouse(name).then((id) => {
                          if (id) updateDailyEntryRow(entryRow.id, { warehouseId: id });
                        });
                        return;
                      }
                      updateDailyEntryRow(entryRow.id, { warehouseId: next });
                    }}
                    className="w-full rounded-lg border border-slate-300 px-2 py-1.5 text-xs"
                    disabled={!canEdit}
                  >
                    {warehouses.map((w) => (
                      <option key={w.id} value={w.id}>
                        {w.name}
                      </option>
                    ))}
                    {canEdit ? <option value="__add_new__">+ Add new warehouse...</option> : null}
                  </select>

                  <input
                    type="text"
                    inputMode="numeric"
                    value={entryRow.soldUnits}
                    onChange={(e) => updateDailyEntryRow(entryRow.id, { soldUnits: sanitizeNonNegativeNumber(e.target.value) })}
                    placeholder="Units sold"
                    className="no-spinner rounded-lg border border-slate-300 px-2 py-1.5 text-xs"
                    disabled={!canEdit}
                  />

                  <input
                    type="text"
                    inputMode="numeric"
                    value={entryRow.returnsUnits}
                    onChange={(e) => updateDailyEntryRow(entryRow.id, { returnsUnits: sanitizeNonNegativeNumber(e.target.value) })}
                    placeholder="Returns"
                    className="no-spinner rounded-lg border border-slate-300 px-2 py-1.5 text-xs"
                    disabled={!canEdit}
                  />

                  <input
                    type="text"
                    inputMode="numeric"
                    value={entryRow.collectedUnits}
                    onChange={(e) => updateDailyEntryRow(entryRow.id, { collectedUnits: sanitizeNonNegativeNumber(e.target.value) })}
                    placeholder="Collected"
                    className="no-spinner rounded-lg border border-slate-300 px-2 py-1.5 text-xs"
                    disabled={!canEdit}
                  />

                  <input
                    value={entryRow.notes}
                    onChange={(e) => updateDailyEntryRow(entryRow.id, { notes: e.target.value })}
                    placeholder="Notes"
                    className="w-full rounded-lg border border-slate-300 px-2 py-1.5 text-xs"
                    disabled={!canEdit}
                  />

                  <button
                    type="button"
                    onClick={() => removeDailyEntryFormRow(entryRow.id)}
                    disabled={!canEdit || dailyEntryRows.length <= 1}
                    className="rounded-lg bg-red-50 px-2 py-1.5 text-xs font-semibold text-red-700 disabled:opacity-50"
                    title={idx === 0 && dailyEntryRows.length <= 1 ? "At least one row is required" : "Remove row"}
                  >
                    Remove
                  </button>
                </div>
              );
            })}
          </div>

          <div className="grid gap-2 rounded-xl border border-slate-200 bg-slate-50 p-3 md:grid-cols-6">
            <label className="text-xs text-slate-600">
              <span className="mb-1 block uppercase tracking-wide text-slate-500">From</span>
              <input
                type="date"
                value={dailyFilters.from}
                onChange={(e) => setDailyFilters((prev) => ({ ...prev, from: e.target.value }))}
                className="w-full rounded-lg border border-slate-300 px-2 py-2 text-sm"
              />
            </label>
            <label className="text-xs text-slate-600">
              <span className="mb-1 block uppercase tracking-wide text-slate-500">To</span>
              <input
                type="date"
                value={dailyFilters.to}
                onChange={(e) => setDailyFilters((prev) => ({ ...prev, to: e.target.value }))}
                className="w-full rounded-lg border border-slate-300 px-2 py-2 text-sm"
              />
            </label>
            <label className="text-xs text-slate-600">
              <span className="mb-1 block uppercase tracking-wide text-slate-500">Platform</span>
              <select
                value={dailyFilters.platform}
                onChange={(e) => setDailyFilters((prev) => ({ ...prev, platform: e.target.value }))}
                className="w-full rounded-lg border border-slate-300 px-2 py-2 text-sm"
              >
                <option value="all">All</option>
                <option value="amazon">Amazon</option>
                <option value="temu">Temu</option>
                <option value="tiktok">TikTok</option>
              </select>
            </label>
            <label className="text-xs text-slate-600">
              <span className="mb-1 block uppercase tracking-wide text-slate-500">Warehouse</span>
              <select
                value={dailyFilters.warehouseId}
                onChange={(e) => setDailyFilters((prev) => ({ ...prev, warehouseId: e.target.value }))}
                className="w-full rounded-lg border border-slate-300 px-2 py-2 text-sm"
              >
                <option value="all">All</option>
                {warehouses.map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-xs text-slate-600">
              <span className="mb-1 block uppercase tracking-wide text-slate-500">SKU</span>
              <select
                value={dailyFilters.mappingId}
                onChange={(e) => setDailyFilters((prev) => ({ ...prev, mappingId: e.target.value }))}
                className="w-full rounded-lg border border-slate-300 px-2 py-2 text-sm"
              >
                <option value="all">All</option>
                {mappings.map((m) => (
                  <option key={m.mappingId} value={m.mappingId}>
                    {(m.amazonSku || m.temuSkuId || "—") + " — " + m.productName}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-xs text-slate-600">
              <span className="mb-1 block uppercase tracking-wide text-slate-500">Search SKU/Product</span>
              <input
                value={dailyHistorySkuSearch}
                onChange={(e) => setDailyHistorySkuSearch(e.target.value)}
                placeholder="Type to search"
                className="w-full rounded-lg border border-slate-300 px-2 py-2 text-sm"
              />
            </label>
          </div>

          <div className="grid gap-2 rounded-xl border border-slate-200 bg-slate-50 p-3 md:grid-cols-5">
            <p className="text-sm text-slate-700">
              Units sold: <span className="font-semibold">{dailyTotals.sold}</span>
            </p>
            <p className="text-sm text-slate-700">
              Returns: <span className="font-semibold">{dailyTotals.returns}</span>
            </p>
            <p className="text-sm text-slate-700">
              Collected: <span className="font-semibold">{dailyTotals.collected}</span>
            </p>
            <p className="text-sm text-slate-700">
              Total Excl VAT: <span className="font-semibold">{currency}{dailyTotals.excl.toFixed(2)}</span>
            </p>
            <p className="text-sm text-slate-700">
              Total Incl VAT: <span className="font-semibold">{currency}{dailyTotals.incl.toFixed(2)}</span>
            </p>
          </div>

          <div className="overflow-x-auto rounded-xl border border-slate-200">
            <table className="min-w-full text-xs">
              <thead className="bg-slate-50 text-left uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="px-2 py-2">Date</th>
                  <th className="px-2 py-2">SKU</th>
                  <th className="px-2 py-2">Product</th>
                  <th className="px-2 py-2">Platform</th>
                  <th className="px-2 py-2">Warehouse</th>
                  <th className="px-2 py-2">Units Sold</th>
                  <th className="px-2 py-2">Returns</th>
                  <th className="px-2 py-2">Collected</th>
                  <th className="px-2 py-2">Excl VAT (COGS)</th>
                  <th className="px-2 py-2">Incl VAT (COGS)</th>
                  <th className="px-2 py-2">Notes</th>
                  {canEdit ? <th className="px-2 py-2 text-right">Action</th> : null}
                </tr>
              </thead>
              <tbody>
                {dailyRowsFiltered.length === 0 ? (
                  <tr>
                    <td className="px-2 py-3 text-slate-500" colSpan={canEdit ? 12 : 11}>
                      No daily sales data in selected filters.
                    </td>
                  </tr>
                ) : (
                  dailyRowsPaged.map((row) => {
                    const isEditingRow = canEdit && editingDailySaleId === row.id && Boolean(dailySaleDraft);
                    const draftMapping = isEditingRow && dailySaleDraft ? mappingById.get(dailySaleDraft.mappingId) : undefined;
                    const m = draftMapping || mappingById.get(row.sku_mapping_id);
                    const wh = warehouses.find((w) => w.id === row.warehouse_id);
                    const costMappingId = isEditingRow && dailySaleDraft ? dailySaleDraft.mappingId : row.sku_mapping_id;
                    const unitCost = cogsByMapping.get(costMappingId) || 0;
                    const units = Number(isEditingRow ? dailySaleDraft?.soldUnits || 0 : row.sold_units || 0);
                    const excl = units * unitCost;
                    const incl = excl * (1 + Number(accountVatRate || 0) / 100);
                    return (
                      <tr key={row.id} className="border-t border-slate-100">
                        <td className="px-2 py-2">
                          {isEditingRow ? (
                            <input
                              type="date"
                              value={dailySaleDraft?.saleDate || ""}
                              onChange={(e) => setDailySaleDraft((prev) => (prev ? { ...prev, saleDate: e.target.value } : prev))}
                              className="rounded border border-slate-300 px-2 py-1"
                            />
                          ) : (
                            row.sale_date
                          )}
                        </td>
                        <td className="px-2 py-2 font-medium">
                          {isEditingRow ? (
                            <select
                              value={dailySaleDraft?.mappingId || ""}
                              onChange={(e) => setDailySaleDraft((prev) => (prev ? { ...prev, mappingId: e.target.value } : prev))}
                              className="max-w-[200px] rounded border border-slate-300 px-2 py-1"
                            >
                              <option value="">Select SKU</option>
                              {mappings.map((mp) => (
                                <option key={mp.mappingId} value={mp.mappingId}>
                                  {mp.amazonSku || mp.temuSkuId || "No SKU"}
                                  {mp.productName ? ` — ${mp.productName}` : ""}
                                </option>
                              ))}
                            </select>
                          ) : (
                            m?.amazonSku || m?.temuSkuId || "-"
                          )}
                        </td>
                        <td className="px-2 py-2 text-slate-600" title={m?.productName || "-"}>
                          {m?.productName || "-"}
                        </td>
                        <td className="px-2 py-2 capitalize">
                          {isEditingRow ? (
                            <select
                              value={dailySaleDraft?.platform || "amazon"}
                              onChange={(e) =>
                                setDailySaleDraft((prev) => (prev ? { ...prev, platform: e.target.value as DailySaleEditDraft["platform"] } : prev))
                              }
                              className="rounded border border-slate-300 px-2 py-1"
                            >
                              <option value="amazon">Amazon</option>
                              <option value="temu">Temu</option>
                              <option value="tiktok">TikTok</option>
                            </select>
                          ) : (
                            row.platform
                          )}
                        </td>
                        <td className="px-2 py-2">
                          {isEditingRow ? (
                            <select
                              value={dailySaleDraft?.warehouseId || ""}
                              onChange={(e) => setDailySaleDraft((prev) => (prev ? { ...prev, warehouseId: e.target.value } : prev))}
                              className="rounded border border-slate-300 px-2 py-1"
                            >
                              <option value="">No warehouse</option>
                              {warehouses.map((w) => (
                                <option key={w.id} value={w.id}>
                                  {w.name}
                                </option>
                              ))}
                            </select>
                          ) : (
                            wh?.name || "-"
                          )}
                        </td>
                        <td className="px-2 py-2">
                          {isEditingRow ? (
                            <input
                              type="text"
                              inputMode="numeric"
                              value={dailySaleDraft?.soldUnits || ""}
                              onChange={(e) => setDailySaleDraft((prev) => (prev ? { ...prev, soldUnits: sanitizeNonNegativeNumber(e.target.value) } : prev))}
                              className="no-spinner w-20 rounded border border-slate-300 px-2 py-1"
                            />
                          ) : (
                            row.sold_units
                          )}
                        </td>
                        <td className="px-2 py-2">
                          {isEditingRow ? (
                            <input
                              type="text"
                              inputMode="numeric"
                              value={dailySaleDraft?.returnsUnits || ""}
                              onChange={(e) => setDailySaleDraft((prev) => (prev ? { ...prev, returnsUnits: sanitizeNonNegativeNumber(e.target.value) } : prev))}
                              className="no-spinner w-20 rounded border border-slate-300 px-2 py-1"
                            />
                          ) : (
                            row.returns_units
                          )}
                        </td>
                        <td className="px-2 py-2">
                          {isEditingRow ? (
                            <input
                              type="text"
                              inputMode="numeric"
                              value={dailySaleDraft?.collectedUnits || ""}
                              onChange={(e) => setDailySaleDraft((prev) => (prev ? { ...prev, collectedUnits: sanitizeNonNegativeNumber(e.target.value) } : prev))}
                              className="no-spinner w-20 rounded border border-slate-300 px-2 py-1"
                            />
                          ) : (
                            row.collected_units
                          )}
                        </td>
                        <td className="px-2 py-2">{currency}{excl.toFixed(2)}</td>
                        <td className="px-2 py-2">{currency}{incl.toFixed(2)}</td>
                        <td className="px-2 py-2">
                          {isEditingRow ? (
                            <input
                              value={dailySaleDraft?.notes || ""}
                              onChange={(e) => setDailySaleDraft((prev) => (prev ? { ...prev, notes: e.target.value } : prev))}
                              className="w-full min-w-[160px] rounded border border-slate-300 px-2 py-1"
                              placeholder="Notes"
                            />
                          ) : (
                            row.notes || "-"
                          )}
                        </td>
                        {canEdit ? (
                          <td className="px-2 py-2 text-right">
                            {isEditingRow ? (
                              <div className="flex justify-end gap-1">
                                <button
                                  type="button"
                                  onClick={() => void saveEditDailySaleRow(row.id)}
                                  className="rounded bg-emerald-50 px-2 py-1 text-emerald-700"
                                >
                                  Save
                                </button>
                                <button
                                  type="button"
                                  onClick={cancelEditDailySaleRow}
                                  className="rounded bg-slate-100 px-2 py-1 text-slate-700"
                                >
                                  Cancel
                                </button>
                              </div>
                            ) : (
                              <div className="flex justify-end gap-1">
                                <button
                                  type="button"
                                  onClick={() => beginEditDailySaleRow(row)}
                                  className="rounded bg-blue-50 px-2 py-1 text-blue-700"
                                >
                                  Edit
                                </button>
                                <button
                                  type="button"
                                  onClick={() => void deleteDailySaleRow(row.id)}
                                  className="rounded bg-red-50 px-2 py-1 text-red-700"
                                >
                                  Delete
                                </button>
                              </div>
                            )}
                          </td>
                        ) : null}
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-600">
            <span>
              Page {dailyCurrentPage} of {dailyTotalPages} ({dailyTotalCount} rows)
            </span>
            <div className="flex items-center gap-2">
              <select
                value={dailyCurrentPage}
                onChange={(e) => setDailyOffset((Number(e.target.value) - 1) * DAILY_PAGE_SIZE)}
                className="rounded-md border border-slate-300 px-2 py-1"
              >
                {Array.from({ length: dailyTotalPages }, (_, idx) => idx + 1).map((page) => (
                  <option key={page} value={page}>
                    {page}
                  </option>
                ))}
              </select>
              <button
                type="button"
                onClick={() => setDailyOffset((prev) => Math.max(0, prev - DAILY_PAGE_SIZE))}
                disabled={dailyOffset === 0}
                className="rounded-md border border-slate-300 px-2 py-1 disabled:opacity-50"
              >
                Previous
              </button>
              <button
                type="button"
                onClick={() => setDailyOffset((prev) => prev + DAILY_PAGE_SIZE)}
                disabled={dailyCurrentPage >= dailyTotalPages}
                className="rounded-md border border-slate-300 px-2 py-1 disabled:opacity-50"
              >
                Next
              </button>
            </div>
          </div>
        </section>
      ) : null}

      {activeTab === "replenishment" ? (
        <section className="space-y-3 rounded-2xl border border-slate-200 bg-white p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h3 className="text-sm font-semibold text-slate-800">Replenishment</h3>
              <p className="text-xs text-slate-500">
                Reorder point = daily velocity × lead time. Suggested order tops you back up to your cover targets.
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <input
                value={replenSearch}
                onChange={(e) => {
                  setReplenSearch(e.target.value);
                  setReplenOffset(0);
                }}
                placeholder="Search SKU or product"
                className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm sm:w-64"
              />
              <select
                value={replenStatusFilter}
                onChange={(e) => {
                  setReplenStatusFilter(e.target.value as typeof replenStatusFilter);
                  setReplenOffset(0);
                }}
                className="rounded-lg border border-slate-300 px-3 py-2 text-sm"
              >
                <option value="all">All statuses</option>
                <option value="reorder">Reorder now ({insights.reorderCount})</option>
                <option value="overstock">Overstocked ({insights.overstockCount})</option>
                <option value="idle">Idle stock ({insights.idleCount})</option>
              </select>
            </div>
          </div>

          {canEdit && selectedMappingIds.length > 0 ? (
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-sky-200 bg-sky-50 px-3 py-2 text-xs">
              <span className="font-semibold text-sky-800">{selectedMappingIds.length} SKU{selectedMappingIds.length === 1 ? "" : "s"} selected for the shipment plan</span>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setSelectedMappingIds([])}
                  className="rounded-md border border-slate-300 bg-white px-2 py-1 font-semibold text-slate-700"
                >
                  Clear selection
                </button>
                <button
                  type="button"
                  onClick={() => setActiveTab("shipment-planning")}
                  className="rounded-md bg-[var(--md-primary)] px-2 py-1 font-semibold text-white"
                >
                  Open Shipment Planning
                </button>
              </div>
            </div>
          ) : null}

          <div className="overflow-x-auto rounded-xl border border-slate-200">
            <table className="min-w-full text-xs">
              <thead className="bg-slate-50 text-left uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="px-2 py-2">SKU</th>
                  <th className="px-2 py-2">Product</th>
                  <th className="px-2 py-2">Velocity/day</th>
                  <th className="px-2 py-2">Lead (days)</th>
                  <th className="px-2 py-2">On hand (A / W)</th>
                  <th className="px-2 py-2">Days left (A / W)</th>
                  <th className="px-2 py-2">Reorder pt (A / W)</th>
                  <th className="px-2 py-2">Suggested (A / W)</th>
                  <th className="px-2 py-2">Status</th>
                  {canEdit ? <th className="px-2 py-2 text-right">Action</th> : null}
                </tr>
              </thead>
              <tbody>
                {replenPaged.length === 0 ? (
                  <tr>
                    <td className="px-2 py-3 text-slate-500" colSpan={canEdit ? 10 : 9}>
                      No SKUs match this filter.
                    </td>
                  </tr>
                ) : (
                  replenPaged.map((row) => {
                    const status = row.needsReorder
                      ? { label: "Reorder", cls: "bg-red-100 text-red-700" }
                      : row.isOverstock
                      ? { label: "Overstock", cls: "bg-amber-100 text-amber-700" }
                      : row.amazonStatus === "idle" && row.amazonUnitsOnHand + row.warehouseUnitsOnHand > 0
                      ? { label: "Idle", cls: "bg-slate-100 text-slate-600" }
                      : { label: "OK", cls: "bg-emerald-100 text-emerald-700" };
                    return (
                      <tr key={row.mappingId} className="border-t border-slate-100">
                        <td className="px-2 py-2 font-medium">{row.amazonSku || row.temuSkuId || "—"}</td>
                        <td className="px-2 py-2 text-slate-600" title={row.productName}>
                          {shortenName(row.productName)}
                        </td>
                        <td className="px-2 py-2">{row.dailyVelocity.toFixed(2)}</td>
                        <td className="px-2 py-2">{row.leadTimeDays}</td>
                        <td className="px-2 py-2">
                          {row.amazonUnitsOnHand} / {row.warehouseUnitsOnHand}
                        </td>
                        <td className="px-2 py-2">
                          {row.amazonDaysLeft ?? "∞"} / {row.warehouseDaysLeft ?? "∞"}
                        </td>
                        <td className="px-2 py-2">
                          {row.reorderPointAmazon} / {row.reorderPointWarehouse}
                        </td>
                        <td className="px-2 py-2 font-semibold">
                          <span className={row.suggestedAmazonUnits > 0 ? "text-red-700" : "text-slate-500"}>
                            {row.suggestedAmazonUnits}
                          </span>{" "}
                          /{" "}
                          <span className={row.suggestedWarehouseUnits > 0 ? "text-red-700" : "text-slate-500"}>
                            {row.suggestedWarehouseUnits}
                          </span>
                        </td>
                        <td className="px-2 py-2">
                          <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${status.cls}`}>{status.label}</span>
                        </td>
                        {canEdit ? (
                          <td className="px-2 py-2 text-right">
                            {selectedMappingIds.includes(row.mappingId) ? (
                              <button
                                type="button"
                                onClick={() => addMappingToPlan(row.mappingId)}
                                className="rounded border border-red-200 bg-red-50 px-2 py-1 font-semibold text-red-700"
                              >
                                Remove
                              </button>
                            ) : (
                              <button
                                type="button"
                                onClick={() => addMappingToPlan(row.mappingId)}
                                className="rounded bg-[var(--md-primary)] px-2 py-1 font-semibold text-white"
                              >
                                Add to plan
                              </button>
                            )}
                          </td>
                        ) : null}
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-600">
            <span>
              Page {replenCurrentPage} of {replenTotalPages} ({replenVisibleRows.length} SKUs)
            </span>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setReplenOffset((prev) => Math.max(0, prev - REPLEN_PAGE_SIZE))}
                disabled={replenCurrentPage <= 1}
                className="rounded-md border border-slate-300 px-2 py-1 disabled:opacity-50"
              >
                Previous
              </button>
              <button
                type="button"
                onClick={() => setReplenOffset((prev) => prev + REPLEN_PAGE_SIZE)}
                disabled={replenCurrentPage >= replenTotalPages}
                className="rounded-md border border-slate-300 px-2 py-1 disabled:opacity-50"
              >
                Next
              </button>
            </div>
          </div>
        </section>
      ) : null}

      {activeTab === "ledger" ? (
        <section className="space-y-3 rounded-2xl border border-slate-200 bg-white p-4">
          <div>
            <h3 className="text-sm font-semibold text-slate-800">Stock Ledger</h3>
            <p className="text-xs text-slate-500">
              One chronological stream of every stock event. Intakes/transfers/adjustments are real stock movements; sales and
              returns are shown for context. Select a single SKU to fold in uploaded transaction sales and a net movement total.
            </p>
          </div>

          <div className="rounded-xl border border-slate-200 bg-slate-50">
            <button
              type="button"
              onClick={() => setShowDataHealth((v) => !v)}
              className="flex w-full items-center justify-between px-3 py-2 text-left text-sm font-semibold text-slate-800"
            >
              <span>
                Data Health Check{" "}
                <span
                  className={`ml-1 rounded-full px-2 py-0.5 text-[11px] font-bold ${
                    insights.health.length > 0 ? "bg-orange-100 text-orange-700" : "bg-emerald-100 text-emerald-700"
                  }`}
                >
                  {insights.health.length > 0 ? `${insights.health.length} issues` : "All healthy"}
                </span>
              </span>
              <span className="text-xs text-slate-500">{showDataHealth ? "Hide" : "Show"}</span>
            </button>
            {showDataHealth ? (
              <div className="border-t border-slate-200 p-3">
                {insights.health.length === 0 ? (
                  <p className="text-xs text-emerald-700">No data issues detected. Stock, COGS and SKU mappings look consistent.</p>
                ) : (
                  <ul className="space-y-1">
                    {insights.health.map((issue, idx) => (
                      <li key={`${issue.mappingId}-${idx}`} className="flex items-center gap-2 text-xs">
                        <span
                          className={`rounded-full px-2 py-0.5 text-[10px] font-bold uppercase ${
                            issue.severity === "error" ? "bg-red-100 text-red-700" : "bg-amber-100 text-amber-700"
                          }`}
                        >
                          {issue.severity}
                        </span>
                        <button
                          type="button"
                          onClick={() => {
                            setLedgerFilters((prev) => ({ ...prev, mappingId: issue.mappingId }));
                            setLedgerOffset(0);
                          }}
                          className="font-semibold text-slate-700 underline-offset-2 hover:underline"
                        >
                          {issue.label}
                        </button>
                        <span className="text-slate-500">— {issue.issue}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            ) : null}
          </div>

          <div className="flex flex-wrap items-end gap-2 rounded-xl border border-slate-200 bg-slate-50 p-3">
            <label className="text-xs text-slate-600">
              <span className="mb-1 block uppercase tracking-wide text-slate-500">SKU</span>
              <SkuCombobox
                value={ledgerFilters.mappingId}
                onChange={(mappingId) => {
                  setLedgerFilters((prev) => ({ ...prev, mappingId }));
                  setLedgerOffset(0);
                }}
                mappings={mappings}
                mappingById={mappingById}
                allowAll
                placeholder="All SKUs"
                className="w-56"
              />
            </label>
            <label className="text-xs text-slate-600">
              <span className="mb-1 block uppercase tracking-wide text-slate-500">Event</span>
              <select
                value={ledgerFilters.eventKey}
                onChange={(e) => {
                  setLedgerFilters((prev) => ({ ...prev, eventKey: e.target.value as "all" | LedgerEventKey }));
                  setLedgerOffset(0);
                }}
                className="h-[38px] w-44 rounded-lg border border-slate-300 px-2 py-2 text-sm"
              >
                <option value="all">All events</option>
                <option value="intake">Intake</option>
                <option value="send_amazon">Send to Amazon</option>
                <option value="outbound">Outbound</option>
                <option value="adjustment">Adjustment</option>
                <option value="sale">Sale</option>
                <option value="return">Return</option>
              </select>
            </label>
            <label className="text-xs text-slate-600">
              <span className="mb-1 block uppercase tracking-wide text-slate-500">From</span>
              <input
                type="date"
                value={ledgerFilters.from}
                onChange={(e) => {
                  setLedgerFilters((prev) => ({ ...prev, from: e.target.value }));
                  setLedgerOffset(0);
                }}
                className="h-[38px] rounded-lg border border-slate-300 px-2 py-2 text-sm"
              />
            </label>
            <label className="text-xs text-slate-600">
              <span className="mb-1 block uppercase tracking-wide text-slate-500">To</span>
              <input
                type="date"
                value={ledgerFilters.to}
                onChange={(e) => {
                  setLedgerFilters((prev) => ({ ...prev, to: e.target.value }));
                  setLedgerOffset(0);
                }}
                className="h-[38px] rounded-lg border border-slate-300 px-2 py-2 text-sm"
              />
            </label>
          </div>

          <div className="overflow-x-auto rounded-xl border border-slate-200">
            <table className="min-w-full text-xs">
              <thead className="bg-slate-50 text-left uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="px-2 py-2">Date</th>
                  <th className="px-2 py-2">SKU</th>
                  <th className="px-2 py-2">Product</th>
                  <th className="px-2 py-2">Event</th>
                  <th className="px-2 py-2">Source</th>
                  <th className="px-2 py-2 text-right">Qty</th>
                  <th className="px-2 py-2">Notes</th>
                </tr>
              </thead>
              <tbody>
                {ledgerPaged.length === 0 ? (
                  <tr>
                    <td className="px-2 py-3 text-slate-500" colSpan={7}>
                      No events in selected filters.
                    </td>
                  </tr>
                ) : (
                  ledgerPaged.map((entry) => (
                    <tr key={entry.id} className="border-t border-slate-100">
                      <td className="px-2 py-2 whitespace-nowrap">{formatUkDate(entry.date)}</td>
                      <td className="px-2 py-2 font-medium">{entry.sku}</td>
                      <td className="px-2 py-2 text-slate-600" title={entry.product}>
                        {shortenName(entry.product)}
                      </td>
                      <td className="px-2 py-2">
                        <span
                          className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${
                            entry.eventKey === "intake"
                              ? "bg-emerald-100 text-emerald-700"
                              : entry.eventKey === "send_amazon"
                              ? "bg-sky-100 text-sky-700"
                              : entry.eventKey === "adjustment"
                              ? "bg-slate-100 text-slate-700"
                              : entry.eventKey === "return"
                              ? "bg-violet-100 text-violet-700"
                              : entry.eventKey === "sale"
                              ? "bg-orange-100 text-orange-700"
                              : "bg-rose-100 text-rose-700"
                          }`}
                        >
                          {entry.event}
                        </span>
                      </td>
                      <td className="px-2 py-2 text-slate-500">{entry.source}</td>
                      <td className={`px-2 py-2 text-right font-semibold ${entry.delta < 0 ? "text-red-600" : "text-emerald-700"}`}>
                        {entry.delta > 0 ? "+" : ""}
                        {entry.delta}
                      </td>
                      <td className="px-2 py-2 text-slate-500">{entry.notes || "—"}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-600">
            <span>
              Page {ledgerCurrentPage} of {ledgerTotalPages} ({ledgerEntries.length} events)
              {ledgerFilters.mappingId !== "all" ? (
                <>
                  {" "}
                  · Net stock movement: <span className="font-semibold text-slate-800">{ledgerNetMovement >= 0 ? "+" : ""}{ledgerNetMovement}</span>
                </>
              ) : null}
            </span>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setLedgerOffset((prev) => Math.max(0, prev - LEDGER_PAGE_SIZE))}
                disabled={ledgerCurrentPage <= 1}
                className="rounded-md border border-slate-300 px-2 py-1 disabled:opacity-50"
              >
                Previous
              </button>
              <button
                type="button"
                onClick={() => setLedgerOffset((prev) => prev + LEDGER_PAGE_SIZE)}
                disabled={ledgerCurrentPage >= ledgerTotalPages}
                className="rounded-md border border-slate-300 px-2 py-1 disabled:opacity-50"
              >
                Next
              </button>
            </div>
          </div>
        </section>
      ) : null}

      {!canEdit ? (
        <p className="rounded-xl bg-slate-100 px-3 py-2 text-sm text-slate-700">
          Client access is read-only for inventory. Admin and Team can create or update inventory records.
        </p>
      ) : null}

      <p className="text-xs text-slate-500">Today: {formatUkDate(todayIsoUtc())}</p>
    </div>
  );
}
