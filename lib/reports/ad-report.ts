/**
 * Amazon Ads campaign-report parser.
 *
 * Auto-detects the SKU and spend columns, supporting any of the typical
 * Amazon Ads CSV/XLSX exports (Sponsored Products "Campaign", "Advertised
 * product", etc.). Spend is treated as ex-VAT (Amazon Ads UK invoices
 * charge VAT on top of the report total).
 *
 * Spend column preference order:
 *   1. "Total cost (reconciled)"   (most accurate, post-VAT-reconciliation)
 *   2. "Total cost"                (default Sponsored Products column)
 *   3. "Spend"                     (alternate name in some reports)
 *   4. "Supply cost"               (Sponsored Brands marketplace cost)
 *   5. any header containing "cost"
 *
 * If the preferred column is entirely empty (e.g. reconciled column not yet
 * populated), we fall back to the next non-empty column automatically.
 */

import Papa from "papaparse";
import * as XLSX from "xlsx";
import type { AdReport } from "./types";

type Row = (string | number | null | undefined)[];

function norm(value: unknown): string {
  return String(value ?? "")
    .replace(/\u00a0/g, " ")
    .replace(/\ufeff/g, "")
    .trim()
    .toLowerCase();
}

function normalizeSku(value: unknown): string {
  const raw = String(value ?? "")
    .replace(/\u00a0/g, " ")
    .trim();
  if (!raw) return "";
  return raw.toLowerCase();
}

function toFloat(value: unknown): number {
  if (value === null || value === undefined || value === "") return 0;
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  const cleaned = String(value).replace(/[,£$€]/g, "").trim();
  const parsed = Number.parseFloat(cleaned);
  return Number.isFinite(parsed) ? parsed : 0;
}

async function readRows(file: File): Promise<Row[]> {
  const lower = file.name.toLowerCase();
  if (lower.endsWith(".csv") || file.type === "text/csv") {
    return new Promise<Row[]>((resolve, reject) => {
      Papa.parse<string[]>(file, {
        header: false,
        skipEmptyLines: true,
        complete: (result) => resolve(result.data as Row[]),
        error: reject,
      });
    });
  }
  const buffer = await file.arrayBuffer();
  const workbook = XLSX.read(buffer, { type: "array" });
  const firstSheet = workbook.SheetNames[0];
  const aoa = XLSX.utils.sheet_to_json<unknown[]>(workbook.Sheets[firstSheet], {
    header: 1,
    defval: "",
  });
  return aoa as Row[];
}

function findHeaderRow(rows: Row[]): number {
  for (let i = 0; i < Math.min(rows.length, 10); i += 1) {
    const row = rows[i] || [];
    const lower = row.map((c) => norm(c));
    const hasSku = lower.some((h) => h.includes("sku"));
    const hasSpend = lower.some((h) => h.includes("spend") || h.includes("cost"));
    if (hasSku && hasSpend) return i;
  }
  return -1;
}

function findColumn(
  header: string[],
  needles: string[],
  exclude: string[] = []
): number {
  for (let j = 0; j < header.length; j += 1) {
    const h = header[j];
    if (!h) continue;
    if (needles.every((n) => h.includes(n)) && !exclude.some((e) => h.includes(e))) {
      return j;
    }
  }
  return -1;
}

function pickSpendColumn(header: string[], dataRows: Row[]): { col: number; label: string } {
  // Try in priority order; pick the first non-empty column.
  const candidates: Array<{ needles: string[]; exclude?: string[]; label: string }> = [
    { needles: ["total", "cost", "reconciled"], label: "Total cost (reconciled)" },
    { needles: ["total", "cost"], exclude: ["reconciled"], label: "Total cost" },
    { needles: ["spend"], label: "Spend" },
    { needles: ["supply", "cost"], label: "Supply cost" },
    { needles: ["cost"], exclude: ["reconciled"], label: "Cost" },
  ];

  for (const candidate of candidates) {
    const col = findColumn(header, candidate.needles, candidate.exclude);
    if (col < 0) continue;
    const sum = dataRows.reduce((acc, row) => acc + toFloat(row?.[col]), 0);
    if (sum !== 0) return { col, label: candidate.label };
  }

  // Last-resort: take any spend/cost column even if it sums to 0.
  for (const candidate of candidates) {
    const col = findColumn(header, candidate.needles, candidate.exclude);
    if (col >= 0) return { col, label: candidate.label };
  }

  return { col: -1, label: "" };
}

export async function loadAdReport(file: File): Promise<AdReport> {
  const rows = await readRows(file);
  if (!rows.length) {
    return {
      spendBySku: {},
      blankSkuSpend: 0,
      totalSpend: 0,
      sourceFilename: file.name,
      spendColumn: "",
      skuCount: 0,
    };
  }

  const headerIdx = findHeaderRow(rows);
  if (headerIdx < 0) {
    throw new Error(
      "Could not find SKU + Spend/Cost columns in the ads report. " +
        "Expected an Amazon Ads campaign-style CSV/XLSX with headers like 'Advertised product SKU' and 'Total cost'."
    );
  }

  const header = (rows[headerIdx] || []).map((c) => norm(c));
  const dataRows = rows.slice(headerIdx + 1);

  const skuCol = findColumn(header, ["sku"]);
  if (skuCol < 0) {
    throw new Error("Could not find a 'SKU' column in the ads report.");
  }

  const { col: spendCol, label: spendColumnLabel } = pickSpendColumn(header, dataRows);
  if (spendCol < 0) {
    throw new Error("Could not find a 'Total cost' / 'Spend' / 'Cost' column in the ads report.");
  }

  const spendBySku: Record<string, number> = {};
  let blankSkuSpend = 0;
  let totalSpend = 0;
  let skuCount = 0;

  for (const row of dataRows) {
    if (!row) continue;
    const rawSku = row[skuCol];
    const amt = toFloat(row[spendCol]);
    if (amt === 0) continue;
    const positive = Math.abs(amt);
    totalSpend += positive;

    const skuKey = normalizeSku(rawSku);
    if (!skuKey) {
      blankSkuSpend += positive;
    } else {
      if (!(skuKey in spendBySku)) skuCount += 1;
      spendBySku[skuKey] = (spendBySku[skuKey] || 0) + positive;
    }
  }

  return {
    spendBySku,
    blankSkuSpend,
    totalSpend,
    sourceFilename: file.name,
    spendColumn: spendColumnLabel,
    skuCount,
  };
}

/**
 * Build an `AdReport`-shaped object from already-persisted database rows
 * (used when re-rendering a saved report or recomputing after a transaction
 * change). Mirrors `loadAdReport` output so downstream callers don't care
 * about the source.
 */
export function adReportFromRows(input: {
  rows: Array<{ sku: string | null; spend_exvat: number }>;
  totalSpendExvat?: number | null;
  blankSkuSpend?: number | null;
  sourceFilename?: string | null;
  spendColumn?: string | null;
}): AdReport {
  const spendBySku: Record<string, number> = {};
  let blankSkuSpend = 0;
  let totalSpend = 0;

  for (const row of input.rows) {
    const amt = Number(row.spend_exvat || 0);
    if (!Number.isFinite(amt) || amt === 0) continue;
    const positive = Math.abs(amt);
    totalSpend += positive;
    const skuKey = normalizeSku(row.sku);
    if (!skuKey) {
      blankSkuSpend += positive;
    } else {
      spendBySku[skuKey] = (spendBySku[skuKey] || 0) + positive;
    }
  }

  return {
    spendBySku,
    blankSkuSpend: input.blankSkuSpend ?? blankSkuSpend,
    totalSpend: input.totalSpendExvat ?? totalSpend,
    sourceFilename: input.sourceFilename ?? "",
    spendColumn: input.spendColumn ?? "",
    skuCount: Object.keys(spendBySku).length,
  };
}
