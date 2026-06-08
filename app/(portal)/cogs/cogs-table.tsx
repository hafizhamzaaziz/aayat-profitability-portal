"use client";

import { useEffect, useMemo, useState } from "react";
import Papa from "papaparse";
import * as XLSX from "xlsx";
import { createClient } from "@/lib/supabase/client";
import { pushClientNotification } from "@/lib/notifications/client";
import FileDropzone from "@/components/ui/file-dropzone";
import {
  applyCogsVersion as applyCogsVersionShared,
  recalculateReportsFromEffectiveDate as recalcReportsShared,
  normalizeProductName,
  type ApplyCogsInput,
} from "@/lib/cogs/apply-cogs-version";

type CogsRow = {
  id: string;
  product_name: string;
  sku: string;
  sku_mapping_id: string | null;
  unit_cost: number;
  includes_vat: boolean;
  effective_from: string;
  updated_at: string;
};

type CogsHistoryRow = {
  id: string;
  sku: string;
  unit_cost: number;
  includes_vat: boolean;
  effective_from: string;
  created_at: string;
};

// Per-row editable draft, lifted into the parent so that bulk "Save selected"
// can persist the in-progress edits for every selected row (not just the row
// the user last touched).
type CogsDraft = {
  productName: string;
  sku: string;
  unitCost: string;
  includesVat: boolean;
  effectiveFrom: string;
};

function draftFromRow(row: CogsRow): CogsDraft {
  return {
    productName: row.product_name || row.sku,
    sku: row.sku,
    unitCost: String(row.unit_cost),
    includesVat: Boolean(row.includes_vat),
    effectiveFrom: row.effective_from,
  };
}

type Props = {
  accountId: string;
  canEdit: boolean;
};

type SortKey = "product_name" | "sku" | "unit_cost" | "effective_from";
type SortDir = "asc" | "desc";

export default function CogsTable({ accountId, canEdit }: Props) {
  const todayIso = new Date().toISOString().slice(0, 10);
  const PAGE_SIZE = 30;
  const [rows, setRows] = useState<CogsRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [newProductName, setNewProductName] = useState("");
  const [newSku, setNewSku] = useState("");
  const [newCost, setNewCost] = useState("");
  const [newIncludesVat, setNewIncludesVat] = useState(false);
  const [newEffectiveFrom, setNewEffectiveFrom] = useState(todayIso);
  const [importIncludesVat, setImportIncludesVat] = useState(true);
  const [importEffectiveFrom, setImportEffectiveFrom] = useState(todayIso);
  const [importing, setImporting] = useState(false);
  const [importFileName, setImportFileName] = useState("");
  const [importRows, setImportRows] = useState<Record<string, unknown>[]>([]);
  const [importHeaders, setImportHeaders] = useState<string[]>([]);
  const [importNameCol, setImportNameCol] = useState("");
  const [importSkuCol, setImportSkuCol] = useState("");
  const [importCostCol, setImportCostCol] = useState("");
  const [importVatCol, setImportVatCol] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [historySku, setHistorySku] = useState<string | null>(null);
  const [historyRows, setHistoryRows] = useState<CogsHistoryRow[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [offset, setOffset] = useState(0);
  const [totalCount, setTotalCount] = useState(0);
  const [search, setSearch] = useState("");
  const [searchActive, setSearchActive] = useState("");
  // Lifted editable drafts keyed by row id + the set of selected row ids for
  // bulk actions. Both are kept in sync with the currently loaded `rows`.
  const [drafts, setDrafts] = useState<Record<string, CogsDraft>>({});
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkBusy, setBulkBusy] = useState(false);
  const [sortKey, setSortKey] = useState<SortKey | null>(null);
  const [sortDir, setSortDir] = useState<SortDir>("asc");

  // Client-side sort over the currently loaded page of rows. Sorting never
  // refetches; it only reorders what's visible.
  const sortedRows = useMemo(() => {
    if (!sortKey) return rows;
    const dir = sortDir === "asc" ? 1 : -1;
    return [...rows].sort((a, b) => {
      if (sortKey === "unit_cost") {
        return (Number(a.unit_cost) - Number(b.unit_cost)) * dir;
      }
      const av = String(sortKey === "product_name" ? a.product_name || a.sku : a[sortKey] ?? "").toLowerCase();
      const bv = String(sortKey === "product_name" ? b.product_name || b.sku : b[sortKey] ?? "").toLowerCase();
      return av.localeCompare(bv) * dir;
    });
  }, [rows, sortKey, sortDir]);

  const toggleSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortDir((prev) => (prev === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir("asc");
    }
  };

  const sortIndicator = (key: SortKey) => (sortKey === key ? (sortDir === "asc" ? " ▲" : " ▼") : "");

  const totalPages = Math.max(1, Math.ceil(totalCount / PAGE_SIZE));
  const currentPage = Math.floor(offset / PAGE_SIZE) + 1;

  const getErrorMessage = (err: unknown, fallback: string) => {
    if (err && typeof err === "object" && "message" in err && typeof (err as { message?: unknown }).message === "string") {
      return (err as { message: string }).message;
    }
    if (err instanceof Error) return err.message;
    return fallback;
  };

  const parseMoney = (value: unknown) => {
    if (value === null || value === undefined || value === "") return 0;
    const cleaned = String(value).replace(/[^0-9.-]/g, "");
    return Number.parseFloat(cleaned) || 0;
  };

  // Interpret a per-row "Includes VAT" cell. Truthy values (yes/y/true/1/incl)
  // mean the cost already includes VAT.
  const parseYesNo = (value: unknown) => {
    const v = String(value ?? "").trim().toLowerCase();
    return ["yes", "y", "true", "1", "inc", "incl", "included", "vat"].includes(v);
  };

  const loadRows = async (nextOffset = offset, activeSearch = searchActive) => {
    setLoading(true);
    setError(null);
    try {
      const supabase = createClient();
      const [{ data: mappingRows, error: mappingError }] = await Promise.all([
        supabase
          .from("sku_mappings")
          .select("id, amazon_sku, sku_catalog:sku_catalog_id(product_name)")
          .eq("account_id", accountId),
      ]);
      if (mappingError) throw mappingError;
      const mapByMappingId: Record<string, string> = {};
      const mapByAmazonSku: Record<string, string> = {};
      (mappingRows || []).forEach((row) => {
        const rec = row as { id?: string; amazon_sku?: string | null; sku_catalog?: { product_name?: string } | null };
        if (!rec.id) return;
        const productName = String(rec.sku_catalog?.product_name || "").trim();
        mapByMappingId[String(rec.id)] = productName;
        if (rec.amazon_sku) mapByAmazonSku[String(rec.amazon_sku).trim().toUpperCase()] = String(rec.id);
      });

      const trimmedSearch = activeSearch.trim();
      let cogsQuery = supabase
        .from("cogs")
        .select("id, sku, sku_mapping_id, unit_cost, includes_vat, effective_from, updated_at", { count: "exact" })
        .eq("account_id", accountId)
        .order("sku", { ascending: true });

      if (trimmedSearch) {
        const needle = `%${trimmedSearch.replace(/[%,]/g, "")}%`;
        const matchingMappingIds = Object.entries(mapByMappingId)
          .filter(([, productName]) => productName.toLowerCase().includes(trimmedSearch.toLowerCase()))
          .map(([id]) => id);
        const filters = [`sku.ilike.${needle}`];
        if (matchingMappingIds.length > 0) {
          filters.push(`sku_mapping_id.in.(${matchingMappingIds.join(",")})`);
        }
        cogsQuery = cogsQuery.or(filters.join(","));
        cogsQuery = cogsQuery.range(0, 499);
      } else {
        cogsQuery = cogsQuery.range(nextOffset, nextOffset + PAGE_SIZE - 1);
      }

      const { data, count, error: fetchError } = await cogsQuery;
      if (fetchError) throw fetchError;

      const normalized = (data || []).map((row) => ({
        id: String(row.id),
        product_name:
          (row.sku_mapping_id ? mapByMappingId[String(row.sku_mapping_id)] : "") ||
          (mapByAmazonSku[String(row.sku).trim().toUpperCase()] ? mapByMappingId[mapByAmazonSku[String(row.sku).trim().toUpperCase()]] : "") ||
          String(row.sku),
        sku: String(row.sku),
        sku_mapping_id: row.sku_mapping_id ? String(row.sku_mapping_id) : null,
        unit_cost: Number(row.unit_cost || 0),
        includes_vat: Boolean(row.includes_vat),
        effective_from: String(row.effective_from || todayIso),
        updated_at: String(row.updated_at),
      }));
      const normalizedRows = normalized as CogsRow[];
      setRows(normalizedRows);
      // Reset drafts to the freshly loaded values and drop any selected ids that
      // are no longer present in the visible result set (e.g. after a search,
      // page change, or delete).
      const nextDrafts: Record<string, CogsDraft> = {};
      const visibleIds = new Set<string>();
      normalizedRows.forEach((row) => {
        nextDrafts[row.id] = draftFromRow(row);
        visibleIds.add(row.id);
      });
      setDrafts(nextDrafts);
      setSelectedIds((prev) => {
        const next = new Set<string>();
        prev.forEach((id) => {
          if (visibleIds.has(id)) next.add(id);
        });
        return next;
      });
      setTotalCount(Number(count || (trimmedSearch ? normalized.length : 0)));
    } catch (err) {
      setError(getErrorMessage(err, "Failed to load COGS rows."));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    setOffset(0);
    void loadRows(0, searchActive);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accountId, searchActive]);

  useEffect(() => {
    const handle = setTimeout(() => {
      setSearchActive(search.trim());
    }, 250);
    return () => clearTimeout(handle);
  }, [search]);

  // COGS persistence is shared with the report workbench's "missing SKU"
  // modal. These thin wrappers bind the current account so all existing call
  // sites keep working unchanged.
  const applyCogsVersion = (input: ApplyCogsInput, options?: { skipRecalc?: boolean }) =>
    applyCogsVersionShared(createClient(), accountId, input, options);

  const recalculateReportsFromEffectiveDate = (supabase: ReturnType<typeof createClient>, effectiveFrom: string) =>
    recalcReportsShared(supabase, accountId, effectiveFrom);

  const loadHistory = async (sku: string) => {
    setHistorySku(sku);
    setHistoryLoading(true);
    setHistoryRows([]);
    try {
      const supabase = createClient();
      const { data, error: historyError } = await supabase
        .from("cogs_history")
        .select("id, sku, unit_cost, includes_vat, effective_from, created_at")
        .eq("account_id", accountId)
        .eq("sku", sku)
        .order("effective_from", { ascending: false });
      if (historyError) throw historyError;
      setHistoryRows((data || []) as CogsHistoryRow[]);
    } catch (err) {
      setError(getErrorMessage(err, "Failed to load COGS history."));
    } finally {
      setHistoryLoading(false);
    }
  };

  const addRow = async () => {
    if (!newProductName.trim() || !newSku.trim() || !newCost.trim()) return;
    try {
      const touchedReports = await applyCogsVersion({
        productName: newProductName,
        sku: newSku,
        unitCost: Number(newCost),
        includesVat: newIncludesVat,
        effectiveFrom: newEffectiveFrom,
      });
      setNewProductName("");
      setNewSku("");
      setNewCost("");
      setNewIncludesVat(false);
      setMessage(`COGS version added.${touchedReports > 0 ? ` Recalculated ${touchedReports} report(s).` : ""}`);
      await loadRows();
    } catch (err) {
      const text = getErrorMessage(err, "Failed to add SKU cost.");
      setError(text);
      await pushClientNotification({
        title: "COGS add failed",
        body: text,
        level: "error",
        eventKey: `cogs-add-fail:${accountId}:${Date.now()}`,
      });
    }
  };

  const updateRow = async (id: string, productName: string, sku: string, unitCost: number, includesVat: boolean, effectiveFrom: string) => {
    try {
      const touchedReports = await applyCogsVersion({ productName, sku, unitCost, includesVat, effectiveFrom });
      setMessage(`COGS version saved.${touchedReports > 0 ? ` Recalculated ${touchedReports} report(s).` : ""}`);
      await loadRows();
      if (historySku === sku.trim().toUpperCase()) {
        await loadHistory(sku.trim().toUpperCase());
      }
    } catch (err) {
      const text = getErrorMessage(err, "Failed to update SKU cost.");
      setError(text);
      await pushClientNotification({
        title: "COGS update failed",
        body: text,
        level: "error",
        eventKey: `cogs-update-fail:${id}:${Date.now()}`,
      });
    }
  };

  const deleteRow = async (id: string) => {
    try {
      const supabase = createClient();
      const { error: deleteError } = await supabase.from("cogs").delete().eq("id", id);
      if (deleteError) throw deleteError;
      setMessage("COGS row deleted.");
      await loadRows();
    } catch (err) {
      const text = getErrorMessage(err, "Failed to delete SKU cost.");
      setError(text);
      await pushClientNotification({
        title: "COGS delete failed",
        body: text,
        level: "error",
        eventKey: `cogs-delete-fail:${id}:${Date.now()}`,
      });
    }
  };

  const setDraft = (id: string, patch: Partial<CogsDraft>) => {
    setDrafts((prev) => ({
      ...prev,
      [id]: { ...(prev[id] || draftFromRow(rows.find((r) => r.id === id) as CogsRow)), ...patch },
    }));
  };

  const toggleSelect = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const allVisibleSelected = rows.length > 0 && rows.every((row) => selectedIds.has(row.id));

  const toggleSelectAll = () => {
    setSelectedIds((prev) => {
      if (rows.length > 0 && rows.every((row) => prev.has(row.id))) {
        // All currently visible rows are selected -> clear only those.
        const next = new Set(prev);
        rows.forEach((row) => next.delete(row.id));
        return next;
      }
      const next = new Set(prev);
      rows.forEach((row) => next.add(row.id));
      return next;
    });
  };

  const clearSelection = () => setSelectedIds(new Set());

  const bulkSaveSelected = async () => {
    const ids = rows.filter((row) => selectedIds.has(row.id)).map((row) => row.id);
    if (ids.length === 0) return;
    setBulkBusy(true);
    setError(null);
    setMessage(null);
    try {
      const effectiveDates: string[] = [];
      // Persist each selected row's edited draft using the same persistence path
      // as the single-row save, but defer the (expensive) report recalculation
      // until all rows are written, then recalc once from the earliest date.
      for (const id of ids) {
        const row = rows.find((r) => r.id === id);
        const draft = drafts[id];
        if (!row || !draft) continue;
        await applyCogsVersion(
          {
            productName: draft.productName,
            sku: draft.sku,
            unitCost: Number(draft.unitCost),
            includesVat: draft.includesVat,
            effectiveFrom: draft.effectiveFrom,
          },
          { skipRecalc: true }
        );
        effectiveDates.push(String(draft.effectiveFrom || todayIso));
      }
      const earliestEffective = effectiveDates.sort()[0] || todayIso;
      const touchedReports = await recalculateReportsFromEffectiveDate(createClient(), earliestEffective);
      setMessage(
        `Saved ${ids.length} selected SKU${ids.length === 1 ? "" : "s"}.${
          touchedReports > 0 ? ` Recalculated ${touchedReports} report(s).` : ""
        }`
      );
      await loadRows();
    } catch (err) {
      const text = getErrorMessage(err, "Failed to save selected SKU costs.");
      setError(text);
      await pushClientNotification({
        title: "COGS bulk save failed",
        body: text,
        level: "error",
        eventKey: `cogs-bulk-save-fail:${accountId}:${Date.now()}`,
      });
    } finally {
      setBulkBusy(false);
    }
  };

  const bulkDeleteSelected = async () => {
    const ids = rows.filter((row) => selectedIds.has(row.id)).map((row) => row.id);
    if (ids.length === 0) return;
    if (!window.confirm(`Delete ${ids.length} selected SKU${ids.length === 1 ? "" : "s"}? This cannot be undone.`)) {
      return;
    }
    setBulkBusy(true);
    setError(null);
    setMessage(null);
    try {
      const supabase = createClient();
      const { error: deleteError } = await supabase.from("cogs").delete().in("id", ids);
      if (deleteError) throw deleteError;
      setMessage(`Deleted ${ids.length} selected SKU${ids.length === 1 ? "" : "s"}.`);
      clearSelection();
      await loadRows();
    } catch (err) {
      const text = getErrorMessage(err, "Failed to delete selected SKU costs.");
      setError(text);
      await pushClientNotification({
        title: "COGS bulk delete failed",
        body: text,
        level: "error",
        eventKey: `cogs-bulk-delete-fail:${accountId}:${Date.now()}`,
      });
    } finally {
      setBulkBusy(false);
    }
  };

  const parseUploadFile = async (file: File): Promise<Record<string, unknown>[]> => {
    const lowered = file.name.toLowerCase();
    if (lowered.endsWith(".csv")) {
      return new Promise((resolve, reject) => {
        Papa.parse<Record<string, unknown>>(file, {
          header: true,
          skipEmptyLines: true,
          complete: (result) => resolve(result.data),
          error: reject,
        });
      });
    }

    const buffer = await file.arrayBuffer();
    const workbook = XLSX.read(buffer, { type: "array" });
    const firstSheet = workbook.SheetNames[0];
    const sheet = workbook.Sheets[firstSheet];
    const parsed = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: "" });
    if (parsed.length > 0) return parsed;

    // Fallback for files where header row isn't inferred cleanly.
    const raw = XLSX.utils.sheet_to_json<(string | number)[]>(sheet, { header: 1, defval: "" }) as Array<
      Array<string | number>
    >;
    const nonEmpty = raw.filter((row) => row.some((cell) => String(cell).trim() !== ""));
    if (nonEmpty.length < 2) return [];
    const headers = nonEmpty[0].map((cell) => String(cell));
    return nonEmpty.slice(1).map((row) =>
      Object.fromEntries(headers.map((header, idx) => [header, row[idx] ?? ""]))
    );
  };

  const norm = (value: unknown) =>
    String(value ?? "")
      .trim()
      .toLowerCase()
      .replace(/\s+/g, " ");

  const pickColumn = (headers: string[], terms: string[]) => {
    return (
      headers.find((header) => {
        const compact = norm(header).replace(/[^a-z0-9]/g, "");
        return terms.some((term) => compact.includes(term));
      }) || ""
    );
  };

  const onImportFileChange = async (file: File | null) => {
    if (!file) return;

    setError(null);
    setMessage(null);
    setImporting(true);

    try {
      const parsedRows = await parseUploadFile(file);
      if (!parsedRows.length) throw new Error("Uploaded file is empty.");

      const headers = Object.keys(parsedRows[0] || {});
      setImportRows(parsedRows);
      setImportHeaders(headers);
      setImportFileName(file.name);
      setImportNameCol(pickColumn(headers, ["productname", "name", "title", "description", "itemname"]));
      setImportSkuCol(pickColumn(headers, ["sku", "asin", "itemid", "reference", "itemcode"]));
      setImportCostCol(pickColumn(headers, ["unitcost", "cost", "cogs", "buyingprice", "purchasecost"]));
      setImportVatCol(pickColumn(headers, ["includesvat", "includevat", "incvat", "vatincluded", "vat"]));
      setMessage("File loaded. Confirm Product Name, SKU and Cost columns, then click Import.");
    } catch (err) {
      const msg = getErrorMessage(err, "Failed to import COGS file.");
      const columnHint = msg.includes("includes_vat")
        ? " Database is missing includes_vat column. Run: alter table public.cogs add column if not exists includes_vat boolean not null default false;"
        : "";
      setError(`${msg}${columnHint}`);
      await pushClientNotification({
        title: "COGS import failed",
        body: `${msg}${columnHint}`,
        level: "error",
        eventKey: `cogs-import-fail:${accountId}:${Date.now()}`,
      });
    } finally {
      setImporting(false);
    }
  };

  const runImport = async () => {
    if (!importRows.length) return;
    if (!importNameCol || !importSkuCol || !importCostCol) {
      setError("Please select Product Name, SKU Column and COG Column.");
      return;
    }

    setImporting(true);
    setError(null);
    setMessage(null);
    try {
      const dedup = new Map<
        string,
        { product_name: string; sku: string; unit_cost: number; includes_vat: boolean; effective_from: string }
      >();
      for (const row of importRows) {
        const productName = normalizeProductName(row[importNameCol] ?? "");
        const sku = String(row[importSkuCol] ?? "").trim().toUpperCase();
        const unitCost = Number(parseMoney(row[importCostCol]).toFixed(2));
        if (!productName || !sku || unitCost <= 0) continue;
        // Per-row "Includes VAT" wins when the column is mapped and the cell has
        // a value; otherwise fall back to the global toggle.
        let includesVat = importIncludesVat;
        if (importVatCol) {
          const raw = String(row[importVatCol] ?? "").trim();
          if (raw !== "") includesVat = parseYesNo(raw);
        }
        dedup.set(sku, {
          product_name: productName,
          sku,
          unit_cost: unitCost,
          includes_vat: includesVat,
          effective_from: importEffectiveFrom,
        });
      }

      const payload = Array.from(dedup.values());
      if (!payload.length) {
        throw new Error("No valid SKU + cost rows found after parsing selected columns.");
      }

      for (const item of payload) {
        await applyCogsVersion({
          productName: item.product_name,
          sku: item.sku,
          unitCost: item.unit_cost,
          includesVat: item.includes_vat,
          effectiveFrom: item.effective_from,
        }, { skipRecalc: true });
      }
      const earliestEffective = payload
        .map((item) => String(item.effective_from || todayIso))
        .sort()[0] || todayIso;
      const touchedReports = await recalculateReportsFromEffectiveDate(createClient(), earliestEffective);

      setMessage(
        `Imported ${payload.length} unique SKUs successfully${payload.length < importRows.length ? " (duplicates merged)." : ""}${
          touchedReports > 0 ? ` Recalculated ${touchedReports} report(s).` : ""
        }`
      );
      await loadRows();
    } catch (err) {
      const msg = getErrorMessage(err, "Failed to import COGS file.");
      const columnHint = msg.includes("includes_vat")
        ? " Database is missing includes_vat column. Run: alter table public.cogs add column if not exists includes_vat boolean not null default false;"
        : "";
      setError(`${msg}${columnHint}`);
      await pushClientNotification({
        title: "COGS import failed",
        body: `${msg}${columnHint}`,
        level: "error",
        eventKey: `cogs-import-fail:${accountId}:${Date.now()}`,
      });
    } finally {
      setImporting(false);
    }
  };

  return (
    <div className="space-y-4">
      {canEdit ? (
        <div className="space-y-3 rounded-2xl border border-slate-200 bg-white p-4">
          <div className="grid gap-3 md:grid-cols-[1.2fr_1fr_160px_180px_180px_auto]">
            <input
              value={newProductName}
              onChange={(event) => setNewProductName(event.target.value)}
              placeholder="Product name"
              className="rounded-xl border border-slate-300 px-3 py-2 text-sm"
            />
            <input
              value={newSku}
              onChange={(event) => setNewSku(event.target.value)}
              placeholder="SKU"
              className="rounded-xl border border-slate-300 px-3 py-2 text-sm"
            />
            <input
              value={newCost}
              onChange={(event) => setNewCost(event.target.value)}
              type="number"
              step="0.01"
              placeholder="Unit cost"
              className="rounded-xl border border-slate-300 px-3 py-2 text-sm"
            />
            <label className="flex items-center gap-2 rounded-xl border border-slate-300 px-3 py-2 text-sm">
              <input
                type="checkbox"
                checked={newIncludesVat}
                onChange={(event) => setNewIncludesVat(event.target.checked)}
              />
              Includes VAT
            </label>
            <label className="rounded-xl border border-slate-300 px-3 py-2 text-sm">
              <span className="mb-1 block text-xs uppercase tracking-wide text-slate-500">Effective From</span>
              <input
                type="date"
                value={newEffectiveFrom}
                onChange={(event) => setNewEffectiveFrom(event.target.value)}
                className="w-full bg-transparent text-sm outline-none"
              />
            </label>
            <button
              onClick={addRow}
              className="rounded-xl bg-[var(--md-primary)] px-4 py-2 text-sm font-semibold text-white"
            >
              Add SKU
            </button>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-xs text-slate-600">
              Upload columns: <span className="font-semibold">Product Name, SKU, Unit Cost</span> and an optional{" "}
              <span className="font-semibold">Includes VAT</span> (Yes/No) column. The VAT default &amp; effective date are set below.
            </p>
            <a
              href="/templates/cogs-template.csv"
              download
              className="rounded-lg border border-[var(--md-outline)] bg-white px-3 py-1.5 text-xs font-semibold text-[var(--md-primary)] hover:bg-slate-50"
            >
              Download template
            </a>
          </div>
          <div className="grid gap-3 rounded-xl bg-slate-50 p-3 md:grid-cols-[1fr_220px_180px_auto]">
            <FileDropzone
              accept=".csv,.xlsx,.xls,.xlsm,.xlxs"
              onFileSelect={(file) => void onImportFileChange(file)}
              disabled={importing}
              label="Upload COGS file"
              hint="CSV/XLS/XLSX"
              selectedFileName={importFileName || undefined}
            />
            <label className="flex items-center gap-2 rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm">
              <input
                type="checkbox"
                checked={importIncludesVat}
                onChange={(event) => setImportIncludesVat(event.target.checked)}
                disabled={importing}
              />
              Imported costs include VAT (default)
            </label>
            <label className="rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm">
              <span className="mb-1 block text-xs uppercase tracking-wide text-slate-500">Import Effective From</span>
              <input
                type="date"
                value={importEffectiveFrom}
                onChange={(event) => setImportEffectiveFrom(event.target.value)}
                disabled={importing}
                className="w-full bg-transparent text-sm outline-none"
              />
            </label>
            <div className="flex items-center text-xs text-slate-600">
              {importing ? "Reading file..." : importFileName ? `Loaded: ${importFileName}` : "Upload CSV/XLSX file"}
            </div>
          </div>

          {importRows.length > 0 ? (
            <div className="grid gap-3 rounded-xl border border-slate-200 bg-white p-3 md:grid-cols-[1fr_1fr_1fr_1fr_auto]">
              <div>
                <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-slate-500">Name Column</label>
                <select
                  value={importNameCol}
                  onChange={(event) => setImportNameCol(event.target.value)}
                  className="w-full rounded-lg border border-slate-300 px-2 py-2 text-sm"
                >
                  <option value="">Select column</option>
                  {importHeaders.map((header) => (
                    <option key={header} value={header}>
                      {header}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-slate-500">SKU Column</label>
                <select
                  value={importSkuCol}
                  onChange={(event) => setImportSkuCol(event.target.value)}
                  className="w-full rounded-lg border border-slate-300 px-2 py-2 text-sm"
                >
                  <option value="">Select column</option>
                  {importHeaders.map((header) => (
                    <option key={header} value={header}>
                      {header}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-slate-500">COG Column</label>
                <select
                  value={importCostCol}
                  onChange={(event) => setImportCostCol(event.target.value)}
                  className="w-full rounded-lg border border-slate-300 px-2 py-2 text-sm"
                >
                  <option value="">Select column</option>
                  {importHeaders.map((header) => (
                    <option key={header} value={header}>
                      {header}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-slate-500">
                  Includes VAT Column
                </label>
                <select
                  value={importVatCol}
                  onChange={(event) => setImportVatCol(event.target.value)}
                  className="w-full rounded-lg border border-slate-300 px-2 py-2 text-sm"
                >
                  <option value="">None (use default)</option>
                  {importHeaders.map((header) => (
                    <option key={header} value={header}>
                      {header}
                    </option>
                  ))}
                </select>
              </div>
              <div className="flex items-end">
                <button
                  type="button"
                  onClick={runImport}
                  disabled={importing}
                  className="rounded-lg bg-[var(--md-primary)] px-4 py-2 text-sm font-semibold text-white disabled:opacity-60"
                >
                  {importing ? "Importing..." : "Import COGS"}
                </button>
              </div>
            </div>
          ) : null}
        </div>
      ) : (
        <p className="rounded-2xl bg-slate-100 px-3 py-2 text-sm text-slate-700">
          You have client access. COGS is view-only.
        </p>
      )}

      {message ? <p className="rounded-2xl bg-green-50 px-3 py-2 text-sm text-green-700">{message}</p> : null}
      {error ? <p className="rounded-2xl bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p> : null}

      <div className="flex flex-wrap items-center gap-2">
        <input
          type="text"
          placeholder="Search product name or SKU"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="w-full max-w-sm rounded-lg border border-slate-300 px-3 py-2 text-sm"
        />
        {searchActive ? (
          <button
            type="button"
            onClick={() => setSearch("")}
            className="rounded-lg bg-slate-100 px-3 py-2 text-xs font-semibold text-slate-700"
          >
            Clear
          </button>
        ) : null}
        {searchActive ? (
          <span className="text-xs text-slate-500">
            Showing {rows.length} match{rows.length === 1 ? "" : "es"} for &ldquo;{searchActive}&rdquo;
          </span>
        ) : null}
      </div>

      {canEdit && selectedIds.size > 0 ? (
        <div className="flex flex-wrap items-center gap-3 rounded-2xl border border-[var(--md-outline)] bg-[var(--md-primary-container)] px-4 py-3">
          <span className="text-sm font-semibold text-slate-800">
            {selectedIds.size} selected
          </span>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => void bulkSaveSelected()}
              disabled={bulkBusy}
              className="rounded-xl bg-[var(--md-primary)] px-4 py-2 text-sm font-semibold text-[var(--md-on-primary)] disabled:opacity-60"
            >
              {bulkBusy ? "Working..." : "Save selected"}
            </button>
            <button
              type="button"
              onClick={() => void bulkDeleteSelected()}
              disabled={bulkBusy}
              className="rounded-xl bg-red-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-60"
            >
              Delete selected
            </button>
            <button
              type="button"
              onClick={clearSelection}
              disabled={bulkBusy}
              className="rounded-xl border border-[var(--md-outline)] bg-white px-4 py-2 text-sm font-semibold text-slate-700 disabled:opacity-60"
            >
              Clear selection
            </button>
          </div>
        </div>
      ) : null}

      <div className="overflow-x-auto rounded-2xl border border-slate-200 bg-white">
        <table className="min-w-full text-sm">
          <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
            <tr>
              {canEdit ? (
                <th className="px-4 py-3">
                  <input
                    type="checkbox"
                    aria-label="Select all visible rows"
                    checked={allVisibleSelected}
                    onChange={toggleSelectAll}
                    className="h-4 w-4 cursor-pointer accent-[var(--md-primary)]"
                  />
                </th>
              ) : null}
              <th className="px-4 py-3">
                <button type="button" onClick={() => toggleSort("product_name")} className="font-semibold uppercase tracking-wide hover:text-slate-700">
                  Product Name{sortIndicator("product_name")}
                </button>
              </th>
              <th className="px-4 py-3">
                <button type="button" onClick={() => toggleSort("sku")} className="font-semibold uppercase tracking-wide hover:text-slate-700">
                  SKU{sortIndicator("sku")}
                </button>
              </th>
              <th className="px-4 py-3">Mapped</th>
              <th className="px-4 py-3">
                <button type="button" onClick={() => toggleSort("unit_cost")} className="font-semibold uppercase tracking-wide hover:text-slate-700">
                  Unit Cost{sortIndicator("unit_cost")}
                </button>
              </th>
              <th className="px-4 py-3">Includes VAT</th>
              <th className="px-4 py-3">
                <button type="button" onClick={() => toggleSort("effective_from")} className="font-semibold uppercase tracking-wide hover:text-slate-700">
                  Effective From{sortIndicator("effective_from")}
                </button>
              </th>
              <th className="px-4 py-3">Updated</th>
              {canEdit ? <th className="px-4 py-3">Actions</th> : null}
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td className="px-4 py-4 text-slate-500" colSpan={canEdit ? 9 : 7}>
                  Loading COGS...
                </td>
              </tr>
            ) : rows.length === 0 ? (
              <tr>
                <td className="px-4 py-4 text-slate-500" colSpan={canEdit ? 9 : 7}>
                  No COGS rows found for this account.
                </td>
              </tr>
            ) : (
              sortedRows.map((row) => (
                <EditableCogsRow
                  key={row.id}
                  row={row}
                  canEdit={canEdit}
                  selected={selectedIds.has(row.id)}
                  onToggleSelect={toggleSelect}
                  draft={drafts[row.id] || draftFromRow(row)}
                  onDraftChange={setDraft}
                  onSave={updateRow}
                  onDelete={deleteRow}
                  onHistory={loadHistory}
                />
              ))
            )}
          </tbody>
        </table>
      </div>
      {historySku ? (
        <div className="rounded-2xl border border-slate-200 bg-white p-3">
          <div className="mb-2 flex items-center justify-between">
            <p className="text-sm font-semibold text-slate-800">COGS History for {historySku}</p>
            <button
              type="button"
              onClick={() => {
                setHistorySku(null);
                setHistoryRows([]);
              }}
              className="rounded-lg bg-slate-100 px-2 py-1 text-xs font-semibold text-slate-700"
            >
              Close
            </button>
          </div>
          {historyLoading ? (
            <p className="text-sm text-slate-500">Loading history...</p>
          ) : historyRows.length === 0 ? (
            <p className="text-sm text-slate-500">No history found.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="min-w-full text-xs">
                <thead className="text-left uppercase tracking-wide text-slate-500">
                  <tr>
                    <th className="px-2 py-1">Effective From</th>
                    <th className="px-2 py-1">Unit Cost</th>
                    <th className="px-2 py-1">Inc VAT</th>
                    <th className="px-2 py-1">Recorded</th>
                  </tr>
                </thead>
                <tbody>
                  {historyRows.map((h) => (
                    <tr key={h.id} className="border-t border-slate-100">
                      <td className="px-2 py-1">{new Date(`${h.effective_from}T00:00:00`).toLocaleDateString("en-GB")}</td>
                      <td className="px-2 py-1">{Number(h.unit_cost).toFixed(2)}</td>
                      <td className="px-2 py-1">{h.includes_vat ? "Yes" : "No"}</td>
                      <td className="px-2 py-1">{new Date(h.created_at).toLocaleString("en-GB")}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      ) : null}
      {searchActive ? null : (
      <div className="flex flex-wrap items-center justify-end gap-2">
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
          type="button"
          onClick={() => {
            const next = Math.max(0, offset - PAGE_SIZE);
            setOffset(next);
            void loadRows(next);
          }}
          disabled={offset === 0 || loading}
          className="rounded-lg bg-slate-100 px-3 py-1.5 text-xs font-semibold text-slate-700 disabled:opacity-50"
        >
          Previous
        </button>
        <button
          type="button"
          onClick={() => {
            const next = offset + PAGE_SIZE;
            setOffset(next);
            void loadRows(next);
          }}
          disabled={currentPage >= totalPages || loading}
          className="rounded-lg bg-slate-100 px-3 py-1.5 text-xs font-semibold text-slate-700 disabled:opacity-50"
        >
          Next
        </button>
      </div>
      )}
    </div>
  );
}

function EditableCogsRow({
  row,
  canEdit,
  selected,
  onToggleSelect,
  draft,
  onDraftChange,
  onSave,
  onDelete,
  onHistory,
}: {
  row: CogsRow;
  canEdit: boolean;
  selected: boolean;
  onToggleSelect: (id: string) => void;
  draft: CogsDraft;
  onDraftChange: (id: string, patch: Partial<CogsDraft>) => void;
  onSave: (id: string, productName: string, sku: string, unitCost: number, includesVat: boolean, effectiveFrom: string) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
  onHistory: (sku: string) => Promise<void>;
}) {
  const productName = draft.productName;
  const sku = draft.sku;
  const unitCost = draft.unitCost;
  const includesVat = draft.includesVat;
  const effectiveFrom = draft.effectiveFrom;
  const setProductName = (value: string) => onDraftChange(row.id, { productName: value });
  const setSku = (value: string) => onDraftChange(row.id, { sku: value });
  const setUnitCost = (value: string) => onDraftChange(row.id, { unitCost: value });
  const setIncludesVat = (value: boolean) => onDraftChange(row.id, { includesVat: value });
  const setEffectiveFrom = (value: string) => onDraftChange(row.id, { effectiveFrom: value });
  const [menuOpen, setMenuOpen] = useState(false);

  return (
    <tr className={`border-t border-slate-100 ${selected ? "bg-[var(--md-primary-container)]" : ""}`}>
      {canEdit ? (
        <td className="px-4 py-3">
          <input
            type="checkbox"
            aria-label={`Select ${row.sku}`}
            checked={selected}
            onChange={() => onToggleSelect(row.id)}
            className="h-4 w-4 cursor-pointer accent-[var(--md-primary)]"
          />
        </td>
      ) : null}
      <td className="px-4 py-3">
        {canEdit ? (
          <input
            value={productName}
            onChange={(event) => setProductName(event.target.value)}
            className="w-full rounded-lg border border-slate-300 px-2 py-1"
          />
        ) : (
          <span>{row.product_name || row.sku}</span>
        )}
      </td>
      <td className="px-4 py-3">
        {canEdit ? (
          <input
            value={sku}
            onChange={(event) => setSku(event.target.value)}
            className="w-full rounded-lg border border-slate-300 px-2 py-1"
          />
        ) : (
          <span>{row.sku}</span>
        )}
      </td>
      <td className="px-4 py-3 text-xs">
        {row.sku_mapping_id ? (
          <span className="rounded-full bg-green-50 px-2 py-0.5 font-semibold text-green-700">Yes</span>
        ) : (
          <span className="rounded-full bg-yellow-50 px-2 py-0.5 font-semibold text-yellow-700">No</span>
        )}
      </td>
      <td className="px-4 py-3">
        {canEdit ? (
          <input
            value={unitCost}
            onChange={(event) => setUnitCost(event.target.value)}
            type="number"
            step="0.01"
            className="w-full rounded-lg border border-slate-300 px-2 py-1"
          />
        ) : (
          <span>{row.unit_cost.toFixed(2)}</span>
        )}
      </td>
      <td className="px-4 py-3">
        {canEdit ? (
          <label className="inline-flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={includesVat}
              onChange={(event) => setIncludesVat(event.target.checked)}
            />
            VAT included
          </label>
        ) : row.includes_vat ? (
          "Yes"
        ) : (
          "No"
        )}
      </td>
      <td className="px-4 py-3">
        {canEdit ? (
          <input
            value={effectiveFrom}
            onChange={(event) => setEffectiveFrom(event.target.value)}
            type="date"
            className="w-full rounded-lg border border-slate-300 px-2 py-1"
          />
        ) : (
          <span>{new Date(`${row.effective_from}T00:00:00`).toLocaleDateString("en-GB")}</span>
        )}
      </td>
      <td className="px-4 py-3 text-slate-500">{new Date(row.updated_at).toLocaleString("en-GB")}</td>
      {canEdit ? (
        <td className="px-4 py-3">
          <div className="relative inline-block">
            <button
              type="button"
              onClick={() => setMenuOpen((prev) => !prev)}
              className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-slate-300 bg-white text-base font-semibold text-slate-700"
              aria-label="Open row actions"
            >
              ⋮
            </button>
            {menuOpen ? (
              <div className="absolute right-0 z-20 mt-2 min-w-[140px] rounded-lg border border-slate-200 bg-white p-1 shadow-lg">
                <button
                  type="button"
                  onClick={() => {
                    setMenuOpen(false);
                    void onSave(row.id, productName, sku, Number(unitCost), includesVat, effectiveFrom);
                  }}
                  className="block w-full rounded-md px-3 py-1.5 text-left text-xs font-semibold text-slate-700 hover:bg-slate-100"
                >
                  Save
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setMenuOpen(false);
                    void onHistory(sku.trim().toUpperCase());
                  }}
                  className="block w-full rounded-md px-3 py-1.5 text-left text-xs font-semibold text-slate-700 hover:bg-slate-100"
                >
                  History
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setMenuOpen(false);
                    void onDelete(row.id);
                  }}
                  className="block w-full rounded-md px-3 py-1.5 text-left text-xs font-semibold text-red-700 hover:bg-red-50"
                >
                  Delete
                </button>
              </div>
            ) : null}
          </div>
        </td>
      ) : null}
    </tr>
  );
}
