"use client";

import { useEffect, useState } from "react";
import Papa from "papaparse";
import * as XLSX from "xlsx";
import { createClient } from "@/lib/supabase/client";
import { pushClientNotification } from "@/lib/notifications/client";

type CogsRow = {
  id: string;
  sku: string;
  unit_cost: number;
  includes_vat: boolean;
  updated_at: string;
};

type Props = {
  accountId: string;
  canEdit: boolean;
};

export default function CogsTable({ accountId, canEdit }: Props) {
  const PAGE_SIZE = 30;
  const [rows, setRows] = useState<CogsRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [newSku, setNewSku] = useState("");
  const [newCost, setNewCost] = useState("");
  const [newIncludesVat, setNewIncludesVat] = useState(false);
  const [importIncludesVat, setImportIncludesVat] = useState(false);
  const [importing, setImporting] = useState(false);
  const [importFileName, setImportFileName] = useState("");
  const [importRows, setImportRows] = useState<Record<string, unknown>[]>([]);
  const [importHeaders, setImportHeaders] = useState<string[]>([]);
  const [importSkuCol, setImportSkuCol] = useState("");
  const [importCostCol, setImportCostCol] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [offset, setOffset] = useState(0);
  const [totalCount, setTotalCount] = useState(0);

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

  const loadRows = async (nextOffset = offset) => {
    setLoading(true);
    setError(null);
    try {
      const supabase = createClient();
      const [{ data, error: fetchError }, { count }] = await Promise.all([
        supabase
          .from("cogs")
          .select("*")
          .eq("account_id", accountId)
          .order("sku", { ascending: true })
          .range(nextOffset, nextOffset + PAGE_SIZE - 1),
        supabase.from("cogs").select("id", { count: "exact", head: true }).eq("account_id", accountId),
      ]);

      if (fetchError) throw fetchError;
      const normalized = (data || []).map((row) => ({
        id: String(row.id),
        sku: String(row.sku),
        unit_cost: Number(row.unit_cost || 0),
        includes_vat: Boolean(row.includes_vat),
        updated_at: String(row.updated_at),
      }));
      setRows(normalized as CogsRow[]);
      setTotalCount(Number(count || 0));
    } catch (err) {
      setError(getErrorMessage(err, "Failed to load COGS rows."));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    setOffset(0);
    void loadRows(0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accountId]);

  const addRow = async () => {
    if (!newSku.trim() || !newCost.trim()) return;
    try {
      const supabase = createClient();
      const { error: insertError } = await supabase.from("cogs").insert({
        account_id: accountId,
        sku: newSku.trim().toUpperCase(),
        unit_cost: Number(newCost),
        includes_vat: newIncludesVat,
      });
      if (insertError) throw insertError;
      setNewSku("");
      setNewCost("");
      setNewIncludesVat(false);
      setMessage("COGS row added.");
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

  const updateRow = async (id: string, sku: string, unitCost: number, includesVat: boolean) => {
    try {
      const supabase = createClient();
      const { error: updateError } = await supabase
        .from("cogs")
        .update({
          sku: sku.trim().toUpperCase(),
          unit_cost: unitCost,
          includes_vat: includesVat,
        })
        .eq("id", id);
      if (updateError) throw updateError;
      setMessage("COGS row updated.");
      await loadRows();
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
      setImportSkuCol(pickColumn(headers, ["sku", "asin", "itemid", "reference", "itemcode"]));
      setImportCostCol(pickColumn(headers, ["unitcost", "cost", "cogs", "buyingprice", "purchasecost"]));
      setMessage("File loaded. Confirm SKU and Cost columns, then click Import.");
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
    if (!importSkuCol || !importCostCol) {
      setError("Please select both SKU Column and COG Column.");
      return;
    }

    setImporting(true);
    setError(null);
    setMessage(null);
    try {
      const dedup = new Map<string, { account_id: string; sku: string; unit_cost: number; includes_vat: boolean }>();
      for (const row of importRows) {
        const sku = String(row[importSkuCol] ?? "").trim().toUpperCase();
        const unitCost = Number(parseMoney(row[importCostCol]).toFixed(2));
        if (!sku || unitCost <= 0) continue;
        dedup.set(sku, {
          account_id: accountId,
          sku,
          unit_cost: unitCost,
          includes_vat: importIncludesVat,
        });
      }

      const payload = Array.from(dedup.values());
      if (!payload.length) {
        throw new Error("No valid SKU + cost rows found after parsing selected columns.");
      }

      const supabase = createClient();
      const { error: upsertError } = await supabase.from("cogs").upsert(payload, { onConflict: "account_id,sku" });
      if (upsertError) throw upsertError;

      setMessage(
        `Imported ${payload.length} unique SKUs successfully${payload.length < importRows.length ? " (duplicates merged)." : ""}`
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
          <div className="grid gap-3 md:grid-cols-[1fr_180px_200px_auto]">
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
            <button
              onClick={addRow}
              className="rounded-xl bg-[var(--md-primary)] px-4 py-2 text-sm font-semibold text-white"
            >
              Add SKU
            </button>
          </div>

          <div className="grid gap-3 rounded-xl bg-slate-50 p-3 md:grid-cols-[1fr_200px_auto]">
            <input
              type="file"
              accept=".csv,.xlsx,.xls,.xlsm,.xlxs"
              onChange={(event) => {
                void onImportFileChange(event.target.files?.[0] ?? null);
                event.currentTarget.value = "";
              }}
              disabled={importing}
              className="rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm"
            />
            <label className="flex items-center gap-2 rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm">
              <input
                type="checkbox"
                checked={importIncludesVat}
                onChange={(event) => setImportIncludesVat(event.target.checked)}
                disabled={importing}
              />
              Imported costs include VAT
            </label>
            <div className="flex items-center text-xs text-slate-600">
              {importing ? "Reading file..." : importFileName ? `Loaded: ${importFileName}` : "Upload CSV/XLSX file"}
            </div>
          </div>

          {importRows.length > 0 ? (
            <div className="grid gap-3 rounded-xl border border-slate-200 bg-white p-3 md:grid-cols-[1fr_1fr_auto]">
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

      <div className="overflow-x-auto rounded-2xl border border-slate-200 bg-white">
        <table className="min-w-full text-sm">
          <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
            <tr>
              <th className="px-4 py-3">SKU</th>
              <th className="px-4 py-3">Unit Cost</th>
              <th className="px-4 py-3">Includes VAT</th>
              <th className="px-4 py-3">Updated</th>
              {canEdit ? <th className="px-4 py-3">Actions</th> : null}
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td className="px-4 py-4 text-slate-500" colSpan={canEdit ? 5 : 4}>
                  Loading COGS...
                </td>
              </tr>
            ) : rows.length === 0 ? (
              <tr>
                <td className="px-4 py-4 text-slate-500" colSpan={canEdit ? 5 : 4}>
                  No COGS rows found for this account.
                </td>
              </tr>
            ) : (
              rows.map((row) => (
                <EditableCogsRow
                  key={row.id}
                  row={row}
                  canEdit={canEdit}
                  onSave={updateRow}
                  onDelete={deleteRow}
                />
              ))
            )}
          </tbody>
        </table>
      </div>
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
    </div>
  );
}

function EditableCogsRow({
  row,
  canEdit,
  onSave,
  onDelete,
}: {
  row: CogsRow;
  canEdit: boolean;
  onSave: (id: string, sku: string, unitCost: number, includesVat: boolean) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
}) {
  const [sku, setSku] = useState(row.sku);
  const [unitCost, setUnitCost] = useState(String(row.unit_cost));
  const [includesVat, setIncludesVat] = useState(Boolean(row.includes_vat));

  return (
    <tr className="border-t border-slate-100">
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
      <td className="px-4 py-3 text-slate-500">{new Date(row.updated_at).toLocaleString("en-GB")}</td>
      {canEdit ? (
        <td className="px-4 py-3">
          <div className="flex gap-2">
            <button
              onClick={() => onSave(row.id, sku, Number(unitCost), includesVat)}
              className="rounded-lg bg-slate-900 px-3 py-1.5 text-xs font-semibold text-white"
            >
              Save
            </button>
            <button
              onClick={() => onDelete(row.id)}
              className="rounded-lg bg-red-600 px-3 py-1.5 text-xs font-semibold text-white"
            >
              Delete
            </button>
          </div>
        </td>
      ) : null}
    </tr>
  );
}
