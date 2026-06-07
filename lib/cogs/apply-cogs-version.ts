/**
 * Shared COGS persistence logic.
 *
 * This is the single source of truth for writing a SKU cost into the
 * `cogs` table (upsert on `account_id,sku`) + the `cogs_history` table
 * (upsert on `account_id,sku,effective_from`), resolving/creating the
 * product + `sku_mappings` row, and recalculating saved reports from a
 * given effective date.
 *
 * Both the COGS page (`cogs-table.tsx`) and the report workbench's
 * "missing SKU" modal call into this module so the two flows persist
 * costs identically.
 */

import type { createClient } from "@/lib/supabase/client";
import { computeExpenseOccurrencesForPeriod, type ExpenseLedgerRow } from "@/lib/reports/expense-ledger";
import { computeExpenseTotals } from "@/lib/reports/expense-totals";

type SupabaseClient = ReturnType<typeof createClient>;

export type CogsVersion = {
  unitCost: number;
  includesVat: boolean;
  effectiveFrom: string;
};

export type ApplyCogsInput = {
  productName: string;
  sku: string;
  unitCost: number;
  includesVat: boolean;
  effectiveFrom: string;
};

type ReportRow = {
  id: string;
  period_start: string;
  period_end: string;
  platform: "amazon" | "temu" | "tiktok";
  output_vat: number;
  input_vat: number;
  net_profit: number;
  total_cogs: number;
  breakdown: Record<string, unknown> | null;
};

type ReportTxRow = {
  platform: "amazon" | "temu" | "tiktok";
  transaction_date: string | null;
  sku: string | null;
  quantity: number | null;
  raw_row: Record<string, unknown> | null;
};

export function normalizeProductName(input: unknown) {
  return String(input ?? "")
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function normalizeSku(input: unknown) {
  return String(input ?? "")
    .replace(/\u00a0/g, " ")
    .trim()
    .toUpperCase();
}

function round2(value: number) {
  return Number((value || 0).toFixed(2));
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

function isUnitsSaleTx(platform: "amazon" | "temu" | "tiktok", rawRow: Record<string, unknown> | null) {
  if (!rawRow) return true;
  if (platform === "tiktok") {
    const status = String(findRawValue(rawRow, ["order status"]) ?? "")
      .trim()
      .toLowerCase();
    return status !== "canceled" && status !== "cancelled";
  }
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

async function removeCatalogIfUnused(supabase: SupabaseClient, catalogId: string) {
  const { count } = await supabase
    .from("sku_mappings")
    .select("id", { count: "exact", head: true })
    .eq("sku_catalog_id", catalogId);
  if (Number(count || 0) === 0) {
    await supabase.from("sku_catalog").delete().eq("id", catalogId);
  }
}

/**
 * Resolve (or create) the product + `sku_mappings` row for a SKU and return
 * the mapping id. Renames/moves the catalog entry to keep product names in
 * sync, mirroring the COGS page behaviour exactly.
 */
export async function upsertProductAndMapping(
  supabase: SupabaseClient,
  accountId: string,
  sku: string,
  productName: string
) {
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
}

/**
 * Recalculate every saved report whose period overlaps (period_end >=
 * effectiveFrom) using the latest `cogs_history`. Returns the number of
 * reports updated.
 */
export async function recalculateReportsFromEffectiveDate(
  supabase: SupabaseClient,
  accountId: string,
  effectiveFrom: string
) {
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

    const { data: expenseLedgerRows, error: expenseError } = await supabase
      .from("expense_ledger")
      .select("id, account_id, description, expense_date, amount, includes_vat, marketplace, expense_type, recurring_end_date")
      .eq("account_id", accountId)
      .lte("expense_date", String(report.period_end || report.period_start))
      .or(`recurring_end_date.is.null,recurring_end_date.gte.${String(report.period_start)}`);
    if (expenseError) throw expenseError;
    const expenseRows = computeExpenseOccurrencesForPeriod({
      rows: (expenseLedgerRows || []) as ExpenseLedgerRow[],
      platform: String(report.platform || "amazon"),
      periodStart: String(report.period_start),
      periodEnd: String(report.period_end || report.period_start),
    });

    let purchaseCost = 0;
    let purchaseVat = 0;
    const cogsSnapshotMap = new Map<string, { sku: string; quantity: number; unit_cost: number; includes_vat: boolean; effective_from: string }>();

    ((txRows || []) as unknown as ReportTxRow[]).forEach((tx) => {
      const platform = tx.platform === "temu" ? "temu" : tx.platform === "tiktok" ? "tiktok" : "amazon";
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
}

/**
 * Persist a single SKU cost version: upserts into `cogs` (on
 * `account_id,sku`) and `cogs_history` (on `account_id,sku,effective_from`),
 * resolving the product + mapping first. When `skipRecalc` is not set, all
 * overlapping saved reports are recalculated and the count returned.
 */
export async function applyCogsVersion(
  supabase: SupabaseClient,
  accountId: string,
  input: ApplyCogsInput,
  options?: { skipRecalc?: boolean }
) {
  const normalizedSku = input.sku.trim().toUpperCase();
  const normalizedName = normalizeProductName(input.productName);
  if (!normalizedSku) throw new Error("SKU is required.");
  if (!normalizedName) throw new Error("Product name is required.");
  if (!input.effectiveFrom) throw new Error("Effective from date is required.");
  const mappingId = await upsertProductAndMapping(supabase, accountId, normalizedSku, normalizedName);

  const {
    data: { user },
  } = await supabase.auth.getUser();

  const { error: cogsError } = await supabase.from("cogs").upsert(
    {
      account_id: accountId,
      sku: normalizedSku,
      sku_mapping_id: mappingId || null,
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
  return recalculateReportsFromEffectiveDate(supabase, accountId, input.effectiveFrom);
}
