"use client";

import { useEffect, useState } from "react";
import Papa from "papaparse";
import * as XLSX from "xlsx";
import { createClient } from "@/lib/supabase/client";
import { pushClientNotification } from "@/lib/notifications/client";
import FileDropzone from "@/components/ui/file-dropzone";

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

type Props = {
  accountId: string;
  canEdit: boolean;
};

type CogsVersion = {
  unitCost: number;
  includesVat: boolean;
  effectiveFrom: string;
};

type ReportRow = {
  id: string;
  period_start: string;
  platform: "amazon" | "temu";
  output_vat: number;
  input_vat: number;
  net_profit: number;
  total_cogs: number;
  breakdown: Record<string, unknown> | null;
};

type ReportTxRow = {
  platform: "amazon" | "temu";
  transaction_date: string | null;
  sku: string | null;
  quantity: number | null;
  raw_row: Record<string, unknown> | null;
};

function normalizeProductName(input: unknown) {
  return String(input ?? "")
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function round2(value: number) {
  return Number((value || 0).toFixed(2));
}

function normalizeSku(input: unknown) {
  return String(input ?? "")
    .replace(/\u00a0/g, " ")
    .trim()
    .toUpperCase();
}

function normalizeKey(input: string) {
  return input.trim().toLowerCase().replace(/\s+/g, " ");
}

function findRawValue(rawRow: Record<string, unknown>, terms: string[]) {
  const keys = Object.keys(rawRow || {});
  for (const term of terms) {
    const key = keys.find((k) => normalizeKey(k) === term);
    if (key) return rawRow[key];
  }
  for (const term of terms) {
    const key = keys.find((k) => normalizeKey(k).includes(term));
    if (key) return rawRow[key];
  }
  return undefined;
}

function isUnitsSaleTx(platform: "amazon" | "temu", rawRow: Record<string, unknown> | null) {
  if (!rawRow) return true;
  const txType = String(findRawValue(rawRow, ["transaction type", "type"]) ?? "")
    .trim()
    .toLowerCase();
  if (!txType) return true;
  if (platform === "amazon") {
    return txType.includes("order") && !txType.includes("refund") && !txType.includes("adjustment") && !txType.includes("transfer");
  }
  return txType.includes("order payment") || txType === "order";
}

function resolveCogsVersion(lookup: Map<string, CogsVersion[]>, sku: string, txDateIso: string) {
  const versions = lookup.get(sku);
  if (!versions || versions.length === 0) return null;
  let selected: CogsVersion | null = null;
  for (const version of versions) {
    if (version.effectiveFrom <= txDateIso) selected = version;
    else break;
  }
  return selected || versions[0] || null;
}

function computeExpenseTotals(expenses: Array<{ amount: number; includes_vat: boolean }>, vatRatePct: number) {
  const vatRate = (Number(vatRatePct) || 0) / 100;
  let net = 0;
  let vat = 0;
  for (const row of expenses) {
    const amount = Number(row.amount || 0);
    if (!amount) continue;
    if (row.includes_vat && vatRate > 0) {
      const vatPart = amount * (vatRate / (1 + vatRate));
      vat += vatPart;
      net += amount - vatPart;
    } else {
      net += amount;
    }
  }
  return { net: round2(net), vat: round2(vat) };
}

async function removeCatalogIfUnused(supabase: ReturnType<typeof createClient>, catalogId: string) {
  const { count } = await supabase
    .from("sku_mappings")
    .select("id", { count: "exact", head: true })
    .eq("sku_catalog_id", catalogId);
  if (Number(count || 0) === 0) {
    await supabase.from("sku_catalog").delete().eq("id", catalogId);
  }
}

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
  const [importIncludesVat, setImportIncludesVat] = useState(false);
  const [importEffectiveFrom, setImportEffectiveFrom] = useState(todayIso);
  const [importing, setImporting] = useState(false);
  const [importFileName, setImportFileName] = useState("");
  const [importRows, setImportRows] = useState<Record<string, unknown>[]>([]);
  const [importHeaders, setImportHeaders] = useState<string[]>([]);
  const [importNameCol, setImportNameCol] = useState("");
  const [importSkuCol, setImportSkuCol] = useState("");
  const [importCostCol, setImportCostCol] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [historySku, setHistorySku] = useState<string | null>(null);
  const [historyRows, setHistoryRows] = useState<CogsHistoryRow[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [offset, setOffset] = useState(0);
  const [totalCount, setTotalCount] = useState(0);
  const [mappingByAmazonSku, setMappingByAmazonSku] = useState<Record<string, string>>({});

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
      const [{ data, error: fetchError }, { count }, { data: mappingRows, error: mappingError }] = await Promise.all([
        supabase
          .from("cogs")
          .select("id, sku, sku_mapping_id, unit_cost, includes_vat, effective_from, updated_at")
          .eq("account_id", accountId)
          .order("sku", { ascending: true })
          .range(nextOffset, nextOffset + PAGE_SIZE - 1),
        supabase.from("cogs").select("id", { count: "exact", head: true }).eq("account_id", accountId),
        supabase
          .from("sku_mappings")
          .select("id, amazon_sku, sku_catalog:sku_catalog_id(product_name)")
          .eq("account_id", accountId),
      ]);

      if (fetchError) throw fetchError;
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
      setMappingByAmazonSku(mapByAmazonSku);
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

  const upsertProductAndMapping = async (supabase: ReturnType<typeof createClient>, sku: string, productName: string) => {
    const normalizedSku = sku.trim().toUpperCase();
    const normalizedName = normalizeProductName(productName);
    if (!normalizedName) throw new Error("Product name is required.");

    const { data: existingMapping } = await supabase
      .from("sku_mappings")
      .select("id, sku_catalog_id")
      .eq("account_id", accountId)
      .eq("amazon_sku", normalizedSku)
      .maybeSingle();

    if (existingMapping?.id && existingMapping?.sku_catalog_id) {
      const { data: existingCatalogByName, error: existingCatalogByNameError } = await supabase
        .from("sku_catalog")
        .select("id")
        .eq("account_id", accountId)
        .eq("product_name", normalizedName)
        .maybeSingle();
      if (existingCatalogByNameError) throw existingCatalogByNameError;

      const currentCatalogId = String(existingMapping.sku_catalog_id);
      if (existingCatalogByName?.id && String(existingCatalogByName.id) !== currentCatalogId) {
        const { error: moveError } = await supabase
          .from("sku_mappings")
          .update({ sku_catalog_id: String(existingCatalogByName.id) })
          .eq("id", String(existingMapping.id));
        if (moveError) throw moveError;
        await removeCatalogIfUnused(supabase, currentCatalogId);
      } else {
        const { error: renameError } = await supabase
          .from("sku_catalog")
          .update({ product_name: normalizedName })
          .eq("id", currentCatalogId);
        if (renameError) throw renameError;
      }
      return String(existingMapping.id);
    }

    const { data: existingCatalog } = await supabase
      .from("sku_catalog")
      .select("id")
      .eq("account_id", accountId)
      .eq("product_name", normalizedName)
      .maybeSingle();
    const catalogId =
      existingCatalog?.id ||
      (
        await supabase
          .from("sku_catalog")
          .insert({ account_id: accountId, product_name: normalizedName })
          .select("id")
          .single()
      ).data?.id;
    if (!catalogId) throw new Error("Failed to resolve product catalog for COGS.");

    const { data: reusableMapping } = await supabase
      .from("sku_mappings")
      .select("id")
      .eq("account_id", accountId)
      .eq("sku_catalog_id", String(catalogId))
      .is("amazon_sku", null)
      .limit(1)
      .maybeSingle();
    if (reusableMapping?.id) {
      const { error: patchErr } = await supabase
        .from("sku_mappings")
        .update({ amazon_sku: normalizedSku })
        .eq("id", String(reusableMapping.id));
      if (!patchErr) return String(reusableMapping.id);
    }

    const { data: mappingBySku, error: mappingBySkuError } = await supabase
      .from("sku_mappings")
      .select("id")
      .eq("account_id", accountId)
      .eq("amazon_sku", normalizedSku)
      .maybeSingle();
    if (mappingBySkuError) throw mappingBySkuError;
    if (mappingBySku?.id) return String(mappingBySku.id);

    const { data: insertedMapping, error: insertedMappingError } = await supabase
      .from("sku_mappings")
      .insert({
        account_id: accountId,
        sku_catalog_id: String(catalogId),
        amazon_sku: normalizedSku,
        temu_sku_id: null,
        lead_time_days: null,
      })
      .select("id")
      .single();
    if (insertedMappingError || !insertedMapping?.id) {
      throw insertedMappingError || new Error("Failed to create SKU mapping.");
    }
    return String(insertedMapping.id);
  };

  const recalculateReportsFromEffectiveDate = async (supabase: ReturnType<typeof createClient>, effectiveFrom: string) => {
    const { data: accountRow, error: accountError } = await supabase
      .from("accounts")
      .select("vat_rate")
      .eq("id", accountId)
      .single();
    if (accountError) throw accountError;
    const vatRatePct = Number(accountRow?.vat_rate || 0);

    const { data: cogsHistory, error: cogsHistoryError } = await supabase
      .from("cogs_history")
      .select("sku, unit_cost, includes_vat, effective_from")
      .eq("account_id", accountId)
      .order("effective_from", { ascending: true });
    if (cogsHistoryError) throw cogsHistoryError;
    const lookup = new Map<string, CogsVersion[]>();
    (cogsHistory || []).forEach((row) => {
      const sku = normalizeSku(row.sku);
      if (!sku) return;
      const list = lookup.get(sku) || [];
      list.push({
        unitCost: Number(row.unit_cost || 0),
        includesVat: Boolean(row.includes_vat),
        effectiveFrom: String(row.effective_from || effectiveFrom),
      });
      lookup.set(sku, list);
    });
    lookup.forEach((rows, sku) => {
      lookup.set(
        sku,
        rows.sort((a, b) => (a.effectiveFrom < b.effectiveFrom ? -1 : 1))
      );
    });

    const { data: reports, error: reportsError } = await supabase
      .from("reports")
      .select("id, period_start, platform, output_vat, input_vat, net_profit, total_cogs, breakdown")
      .eq("account_id", accountId)
      .gte("period_end", effectiveFrom);
    if (reportsError) throw reportsError;

    let updatedCount = 0;
    for (const rawReport of (reports || []) as unknown as ReportRow[]) {
      const report = rawReport;
      const { data: txRows, error: txError } = await supabase
        .from("report_transactions")
        .select("platform, transaction_date, sku, quantity, raw_row")
        .eq("report_id", report.id);
      if (txError) throw txError;

      const { data: expenseRows, error: expenseError } = await supabase
        .from("expenses")
        .select("amount, includes_vat")
        .eq("report_id", report.id);
      if (expenseError) throw expenseError;

      let purchaseCost = 0;
      let purchaseVat = 0;
      const cogsSnapshotMap = new Map<string, { sku: string; quantity: number; unit_cost: number; includes_vat: boolean; effective_from: string }>();

      ((txRows || []) as unknown as ReportTxRow[]).forEach((tx) => {
        const platform = tx.platform === "temu" ? "temu" : "amazon";
        if (!isUnitsSaleTx(platform, tx.raw_row || null)) return;
        const sku = normalizeSku(tx.sku || "");
        const qty = Math.abs(Number(tx.quantity || 0));
        if (!sku || !qty) return;
        const txDate = String(tx.transaction_date || report.period_start || effectiveFrom).slice(0, 10);
        const cogs = resolveCogsVersion(lookup, sku, txDate);
        if (!cogs) return;

        const vatRate = vatRatePct > 0 ? vatRatePct / 100 : 0;
        if (cogs.includesVat && vatRate > 0) {
          const unitNet = cogs.unitCost / (1 + vatRate);
          const unitVat = cogs.unitCost - unitNet;
          purchaseCost += unitNet * qty;
          purchaseVat += unitVat * qty;
        } else {
          purchaseCost += cogs.unitCost * qty;
        }

        const snapshotKey = `${sku}|${cogs.unitCost}|${cogs.includesVat ? "1" : "0"}|${cogs.effectiveFrom}`;
        const current = cogsSnapshotMap.get(snapshotKey) || {
          sku,
          quantity: 0,
          unit_cost: cogs.unitCost,
          includes_vat: cogs.includesVat,
          effective_from: cogs.effectiveFrom,
        };
        current.quantity += qty;
        cogsSnapshotMap.set(snapshotKey, current);
      });

      const breakdown = (report.breakdown || {}) as Record<string, unknown>;
      const pnl = (breakdown.pnl || {}) as Record<string, number>;
      const vat = (breakdown.vat || {}) as Record<string, number>;
      const expenseTotals = computeExpenseTotals(
        ((expenseRows || []) as Array<{ amount: number; includes_vat: boolean }>).map((e) => ({
          amount: Number(e.amount || 0),
          includes_vat: Boolean(e.includes_vat),
        })),
        vatRatePct
      );
      const settlementNet = Number(pnl.settlementNet || report.net_profit + report.total_cogs + expenseTotals.net);
      const inputVatFees = Number(vat.inputVatFees || 0);
      const inputVatPurchases = vatRatePct > 0 ? round2(purchaseVat + expenseTotals.vat) : 0;
      const inputVat = vatRatePct > 0 ? round2(inputVatFees + inputVatPurchases) : 0;
      const outputVat = vatRatePct > 0 ? Number(report.output_vat || 0) : 0;
      const finalVat = vatRatePct > 0 ? round2(outputVat - inputVat) : 0;
      const nextPurchaseCost = round2(purchaseCost);
      const nextNetProfit = round2(settlementNet - nextPurchaseCost - expenseTotals.net);

      const nextBreakdown = {
        ...breakdown,
        pnl: {
          ...(breakdown.pnl as object),
          settlementNet: round2(settlementNet),
          purchaseCost: nextPurchaseCost,
          netProfit: nextNetProfit,
        },
        vat: vatRatePct > 0
          ? {
              ...(breakdown.vat as object),
              outputVat: round2(outputVat),
              inputVatFees: round2(inputVatFees),
              inputVatPurchases,
              finalVat,
            }
          : {
              outputVat: 0,
              inputVatFees: 0,
              inputVatPurchases: 0,
              finalVat: 0,
            },
      };

      const { error: updateError } = await supabase
        .from("reports")
        .update({
          total_cogs: nextPurchaseCost,
          input_vat: inputVat,
          output_vat: round2(outputVat),
          net_profit: nextNetProfit,
          cogs_snapshot: Array.from(cogsSnapshotMap.values()),
          breakdown: nextBreakdown,
        })
        .eq("id", report.id);
      if (updateError) throw updateError;
      updatedCount += 1;
    }
    return updatedCount;
  };

  const applyCogsVersion = async (input: {
    productName: string;
    sku: string;
    unitCost: number;
    includesVat: boolean;
    effectiveFrom: string;
  }, options?: { skipRecalc?: boolean }) => {
    const supabase = createClient();
    const normalizedSku = input.sku.trim().toUpperCase();
    const normalizedName = normalizeProductName(input.productName);
    if (!normalizedSku) throw new Error("SKU is required.");
    if (!normalizedName) throw new Error("Product name is required.");
    if (!input.effectiveFrom) throw new Error("Effective from date is required.");
    const mappingId = await upsertProductAndMapping(supabase, normalizedSku, normalizedName);

    const {
      data: { user },
    } = await supabase.auth.getUser();

    const { error: cogsError } = await supabase.from("cogs").upsert(
      {
        account_id: accountId,
        sku: normalizedSku,
        sku_mapping_id: mappingId || mappingByAmazonSku[normalizedSku] || null,
        unit_cost: Number(input.unitCost.toFixed(2)),
        includes_vat: input.includesVat,
        effective_from: input.effectiveFrom,
      },
      { onConflict: "account_id,sku" }
    );
    if (cogsError) throw cogsError;

    const { error: historyError } = await supabase.from("cogs_history").upsert(
      {
        account_id: accountId,
        sku: normalizedSku,
        unit_cost: Number(input.unitCost.toFixed(2)),
        includes_vat: input.includesVat,
        effective_from: input.effectiveFrom,
        changed_by: user?.id || null,
      },
      { onConflict: "account_id,sku,effective_from" }
    );
    if (historyError) throw historyError;

    if (options?.skipRecalc) return 0;
    return recalculateReportsFromEffectiveDate(supabase, input.effectiveFrom);
  };

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
        dedup.set(sku, {
          product_name: productName,
          sku,
          unit_cost: unitCost,
          includes_vat: importIncludesVat,
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
              Imported costs include VAT
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
            <div className="grid gap-3 rounded-xl border border-slate-200 bg-white p-3 md:grid-cols-[1fr_1fr_1fr_auto]">
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
              <th className="px-4 py-3">Product Name</th>
              <th className="px-4 py-3">SKU</th>
              <th className="px-4 py-3">Mapped</th>
              <th className="px-4 py-3">Unit Cost</th>
              <th className="px-4 py-3">Includes VAT</th>
              <th className="px-4 py-3">Effective From</th>
              <th className="px-4 py-3">Updated</th>
              {canEdit ? <th className="px-4 py-3">Actions</th> : null}
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td className="px-4 py-4 text-slate-500" colSpan={canEdit ? 8 : 7}>
                  Loading COGS...
                </td>
              </tr>
            ) : rows.length === 0 ? (
              <tr>
                <td className="px-4 py-4 text-slate-500" colSpan={canEdit ? 8 : 7}>
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
  onHistory,
}: {
  row: CogsRow;
  canEdit: boolean;
  onSave: (id: string, productName: string, sku: string, unitCost: number, includesVat: boolean, effectiveFrom: string) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
  onHistory: (sku: string) => Promise<void>;
}) {
  const [productName, setProductName] = useState(row.product_name || row.sku);
  const [sku, setSku] = useState(row.sku);
  const [unitCost, setUnitCost] = useState(String(row.unit_cost));
  const [includesVat, setIncludesVat] = useState(Boolean(row.includes_vat));
  const [effectiveFrom, setEffectiveFrom] = useState(row.effective_from);
  const [menuOpen, setMenuOpen] = useState(false);

  return (
    <tr className="border-t border-slate-100">
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
