/**
 * Temu Ads-report parser + per-SKU allocator.
 *
 * The Temu ads-report XLSX is granular at the **Goods** level (parent
 * listing), not at the **SKU** level (variant). Layout we support:
 *
 *   row 0: header → Goods name, Goods ID, Spend, Base price sales, ROAS, ...
 *   row 1: "Total N item(s)", "", "£1,219.72", ...   (summary; skipped)
 *   row 2..N: one row per Goods, with Goods ID + ex-VAT Spend
 *
 * Spend column is ex-VAT (Temu invoices VAT on top of the report total),
 * so we treat the parsed value as ex-VAT and add 20% input-VAT reclaim
 * downstream.
 *
 * Per-SKU allocation works in three tiers:
 *   1. Goods ID → list of Temu SKU IDs the user has mapped (preferred).
 *   2. Goods name → SKU description prefix match (fallback when the user
 *      hasn't filled `sku_catalog.temu_goods_id`).
 *   3. No match → spend is pooled into a blank-Goods bucket and
 *      redistributed pro-rata across all selling SKUs by positive
 *      ex-VAT net sales (same safety net Amazon uses).
 *
 * Inside each Goods bucket the spend is split by **units sold** (positive
 * only) across constituent SKUs, falling back to positive ex-VAT net sales
 * when units are zero across the bucket.
 */

import Papa from "papaparse";
import * as XLSX from "xlsx";
import type { TemuPnL } from "./temu-pnl";

type Row = (string | number | null | undefined)[];

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type TemuAdReport = {
  /** Ex-VAT spend keyed by Goods ID (numeric string from the report). */
  spendByGoodsId: Record<string, number>;
  /** Last-seen Goods name per Goods ID (for display + name-fallback match). */
  goodsNameByGoodsId: Record<string, string>;
  /** Spend on rows where Goods ID was missing/blank. */
  blankGoodsSpend: number;
  /** Sum of all spend (ex-VAT). */
  totalSpend: number;
  sourceFilename: string;
  /** Original column label we picked for spend (e.g. "Spend"). */
  spendColumn: string;
  goodsCount: number;
};

export type TemuAdAllocation = {
  /** Final per-SKU ex-VAT ad spend (positive amounts). */
  spendBySku: Record<string, number>;
  /** Sum of `spendBySku` + unmatched spend → equals adReport.totalSpend. */
  totalSpendExvat: number;
  /** Spend that couldn't be tied to any selling SKU and was redistributed. */
  unmatchedSpendExvat: number;
  /** Per-Goods diagnostics for the UI. */
  bucketStats: Array<{
    goodsId: string | null;
    goodsName: string;
    spendExvat: number;
    matchedSkus: string[];
    /** 'goods_id' = matched via sku_mappings; 'name_prefix' = via description; 'unmatched' = redistributed. */
    matchedKind: "goods_id" | "name_prefix" | "unmatched" | "blank";
  }>;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function norm(value: unknown): string {
  return String(value ?? "")
    .replace(/\u00a0/g, " ")
    .replace(/\ufeff/g, "")
    .trim()
    .toLowerCase();
}

function normalizeId(value: unknown): string {
  // Goods IDs come as numeric. xlsx may serialize as number → convert without
  // exponent notation. Trim whitespace, strip commas just in case.
  const raw = String(value ?? "").replace(/\u00a0/g, " ").replace(/,/g, "").trim();
  if (!raw) return "";
  // If it's a number-string with `.0` suffix (xlsx artefact), strip it.
  if (/^\d+\.0+$/.test(raw)) return raw.replace(/\.0+$/, "");
  return raw;
}

function toFloat(value: unknown): number {
  if (value === null || value === undefined || value === "") return 0;
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  const cleaned = String(value).replace(/[,£$€\s]/g, "").trim();
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

function findHeaderRowIndex(rows: Row[]): number {
  // Look in the first 10 rows for one with both a "goods" header and either
  // a "spend" or "cost" header.
  for (let i = 0; i < Math.min(rows.length, 10); i += 1) {
    const cells = (rows[i] || []).map((c) => norm(c));
    const hasGoods = cells.some((h) => h.includes("goods"));
    const hasSpend = cells.some((h) => h.includes("spend") || h.includes("cost"));
    if (hasGoods && hasSpend) return i;
  }
  return -1;
}

function findColumnIndex(header: string[], needles: string[][]): number {
  for (const group of needles) {
    for (let j = 0; j < header.length; j += 1) {
      const h = header[j];
      if (!h) continue;
      if (group.every((sub) => h.includes(sub))) return j;
    }
  }
  return -1;
}

function isSummaryRow(name: string): boolean {
  // Temu's report inserts a "Total N item(s)" / "Total" summary row right
  // under the header. Skip it so it isn't double-counted.
  const n = name.toLowerCase();
  if (!n) return false;
  if (n.startsWith("total ")) return true;
  if (n === "total") return true;
  if (/^total\s+\d+\s+item/.test(n)) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

/**
 * Parse a Temu Ads "Product data details" XLSX/CSV.
 * Throws when the expected columns aren't present.
 */
export async function loadTemuAdReport(file: File): Promise<TemuAdReport> {
  const rows = await readRows(file);
  if (!rows.length) {
    return {
      spendByGoodsId: {},
      goodsNameByGoodsId: {},
      blankGoodsSpend: 0,
      totalSpend: 0,
      sourceFilename: file.name,
      spendColumn: "",
      goodsCount: 0,
    };
  }

  const headerIdx = findHeaderRowIndex(rows);
  if (headerIdx < 0) {
    throw new Error(
      "Could not find Goods name + Spend columns in the ads report. Expected a Temu 'Product data details' export."
    );
  }

  const header = (rows[headerIdx] || []).map((c) => norm(c));
  const dataRows = rows.slice(headerIdx + 1);

  const nameCol = findColumnIndex(header, [["goods", "name"]]);
  const idCol = findColumnIndex(header, [["goods", "id"]]);
  const spendCol = findColumnIndex(header, [["spend"], ["cost"]]);
  if (nameCol < 0) throw new Error("Could not find a 'Goods name' column in the ads report.");
  if (spendCol < 0) throw new Error("Could not find a 'Spend' column in the ads report.");

  const spendColLabel = (rows[headerIdx] || [])[spendCol];

  const spendByGoodsId: Record<string, number> = {};
  const goodsNameByGoodsId: Record<string, string> = {};
  let blankGoodsSpend = 0;
  let totalSpend = 0;

  for (const row of dataRows) {
    if (!row) continue;
    const name = String(row[nameCol] ?? "").replace(/\u00a0/g, " ").trim();
    if (isSummaryRow(name)) continue;
    const goodsId = idCol >= 0 ? normalizeId(row[idCol]) : "";
    const spend = toFloat(row[spendCol]);
    if (spend === 0) continue;

    const positive = Math.abs(spend);
    totalSpend += positive;

    if (!goodsId) {
      blankGoodsSpend += positive;
      continue;
    }
    spendByGoodsId[goodsId] = (spendByGoodsId[goodsId] || 0) + positive;
    if (name && !goodsNameByGoodsId[goodsId]) goodsNameByGoodsId[goodsId] = name;
  }

  return {
    spendByGoodsId,
    goodsNameByGoodsId,
    blankGoodsSpend,
    totalSpend,
    sourceFilename: file.name,
    spendColumn: String(spendColLabel ?? "Spend"),
    goodsCount: Object.keys(spendByGoodsId).length,
  };
}

// ---------------------------------------------------------------------------
// Allocator
// ---------------------------------------------------------------------------

function nameMatchesPrefix(goodsName: string, skuDescription: string): boolean {
  // Cheap heuristic: the SKU description is the listing title; for variant
  // SKUs it usually starts with the Goods name verbatim. Match if either
  // the goods name is contained in the SKU description, or the first ~40
  // chars are equal after normalization.
  if (!goodsName || !skuDescription) return false;
  const a = goodsName.replace(/\s+/g, " ").trim().toLowerCase();
  const b = skuDescription.replace(/\s+/g, " ").trim().toLowerCase();
  if (!a || !b) return false;
  if (b.includes(a)) return true;
  if (a.includes(b)) return true;
  const head = (s: string) => s.slice(0, Math.min(40, s.length));
  return head(a) === head(b);
}

/**
 * Distribute Temu ad spend across SKUs using:
 *   - mapping (Goods ID → SKU IDs) when available,
 *   - else Goods name ≈ SKU description match,
 *   - else pool to the unmatched bucket and spread by net sales.
 * Within each matched bucket spend is split by units sold (positive),
 * falling back to positive net sales when units are zero.
 */
export function allocateTemuAds(input: {
  adReport: TemuAdReport;
  pnl: TemuPnL;
  /** Goods ID → list of Temu SKU IDs the user has mapped under that goods. */
  goodsToSkuIds: Map<string, string[]>;
}): TemuAdAllocation {
  const { adReport, pnl, goodsToSkuIds } = input;

  // Build per-SKU positive sales + units (canonical lowercased keys).
  const positiveSalesBySku = new Map<string, number>();
  const positiveUnitsBySku = new Map<string, number>();
  let totalPositiveSales = 0;
  let totalPositiveUnits = 0;
  const allSkus = new Set<string>([
    ...Object.keys(pnl.skuUnits),
    ...Object.keys(pnl.skuRetail),
  ]);
  allSkus.forEach((sku) => {
    const s =
      (pnl.skuRetail[sku] || 0) +
      (pnl.skuPlatformDiscount[sku] || 0) +
      (pnl.skuSellerDiscount[sku] || 0) +
      (pnl.skuPlatformIncentive[sku] || 0) +
      (pnl.skuShipping[sku] || 0);
    const positiveSales = Math.max(0, s);
    const positiveUnits = Math.max(0, pnl.skuUnits[sku] || 0);
    positiveSalesBySku.set(sku, positiveSales);
    positiveUnitsBySku.set(sku, positiveUnits);
    totalPositiveSales += positiveSales;
    totalPositiveUnits += positiveUnits;
  });

  const spendBySku: Record<string, number> = {};
  let unmatchedSpendExvat = 0;
  const bucketStats: TemuAdAllocation["bucketStats"] = [];

  // Helper: split a goods bucket across a set of SKUs by units (then sales).
  const distributeBucket = (
    skus: string[],
    spend: number,
    bucketLabel: { goodsId: string | null; goodsName: string; matchedKind: TemuAdAllocation["bucketStats"][number]["matchedKind"] }
  ) => {
    // Filter to SKUs that actually appear in the period.
    const present = skus.filter((s) => allSkus.has(s));
    if (present.length === 0) {
      // No constituent SKU sold in the period → fall back to unmatched pot.
      unmatchedSpendExvat += spend;
      bucketStats.push({
        goodsId: bucketLabel.goodsId,
        goodsName: bucketLabel.goodsName,
        spendExvat: spend,
        matchedSkus: [],
        matchedKind: "unmatched",
      });
      return;
    }

    const totalUnits = present.reduce((acc, s) => acc + (positiveUnitsBySku.get(s) || 0), 0);
    const totalSales = present.reduce((acc, s) => acc + (positiveSalesBySku.get(s) || 0), 0);
    if (totalUnits > 0) {
      for (const s of present) {
        const share = (positiveUnitsBySku.get(s) || 0) / totalUnits;
        spendBySku[s] = (spendBySku[s] || 0) + spend * share;
      }
    } else if (totalSales > 0) {
      for (const s of present) {
        const share = (positiveSalesBySku.get(s) || 0) / totalSales;
        spendBySku[s] = (spendBySku[s] || 0) + spend * share;
      }
    } else {
      // Equal split when neither units nor sales are positive (rare;
      // happens when the bucket only had refunds in the period).
      const share = spend / present.length;
      for (const s of present) spendBySku[s] = (spendBySku[s] || 0) + share;
    }
    bucketStats.push({
      goodsId: bucketLabel.goodsId,
      goodsName: bucketLabel.goodsName,
      spendExvat: spend,
      matchedSkus: present,
      matchedKind: bucketLabel.matchedKind,
    });
  };

  // Tier 1: explicit Goods ID → SKU IDs from sku_mappings.
  // Tier 2: name-prefix match against SKU descriptions.
  // Tier 3: unmatched (pooled).
  for (const [goodsId, spend] of Object.entries(adReport.spendByGoodsId)) {
    const goodsName = adReport.goodsNameByGoodsId[goodsId] || "";
    const mapped = goodsToSkuIds.get(goodsId) || [];
    if (mapped.length > 0) {
      distributeBucket(mapped, spend, { goodsId, goodsName, matchedKind: "goods_id" });
      continue;
    }
    // Name-prefix fallback: find SKUs whose description matches the Goods name.
    const candidates: string[] = [];
    for (const sku of allSkus) {
      const desc = pnl.skuDescriptions[sku] || "";
      if (nameMatchesPrefix(goodsName, desc)) candidates.push(sku);
    }
    if (candidates.length > 0) {
      distributeBucket(candidates, spend, { goodsId, goodsName, matchedKind: "name_prefix" });
      continue;
    }
    // No match at all → pool.
    unmatchedSpendExvat += spend;
    bucketStats.push({
      goodsId,
      goodsName,
      spendExvat: spend,
      matchedSkus: [],
      matchedKind: "unmatched",
    });
  }

  // Blank-goods spend (rows where the report didn't include a Goods ID).
  if (adReport.blankGoodsSpend > 0) {
    unmatchedSpendExvat += adReport.blankGoodsSpend;
    bucketStats.push({
      goodsId: null,
      goodsName: "(blank)",
      spendExvat: adReport.blankGoodsSpend,
      matchedSkus: [],
      matchedKind: "blank",
    });
  }

  // Redistribute the unmatched pot across all selling SKUs by positive
  // ex-VAT net sales (same Option A safety net Amazon uses).
  if (unmatchedSpendExvat > 0 && totalPositiveSales > 0) {
    const skuList = Array.from(allSkus);
    for (const sku of skuList) {
      const share = (positiveSalesBySku.get(sku) || 0) / totalPositiveSales;
      if (share <= 0) continue;
      spendBySku[sku] = (spendBySku[sku] || 0) + unmatchedSpendExvat * share;
    }
  } else if (unmatchedSpendExvat > 0 && totalPositiveUnits > 0) {
    const skuList = Array.from(allSkus);
    for (const sku of skuList) {
      const share = (positiveUnitsBySku.get(sku) || 0) / totalPositiveUnits;
      if (share <= 0) continue;
      spendBySku[sku] = (spendBySku[sku] || 0) + unmatchedSpendExvat * share;
    }
  }
  // If neither sales nor units exist, the unmatched pool stays as an
  // account-level overhead that the engine subtracts from operating profit
  // but doesn't push down to per-SKU.

  // Round to 2dp at the end.
  const rounded: Record<string, number> = {};
  for (const [sku, amt] of Object.entries(spendBySku)) {
    const v = Math.round(amt * 100) / 100;
    if (v === 0) continue;
    rounded[sku] = v;
  }

  return {
    spendBySku: rounded,
    totalSpendExvat: Math.round(adReport.totalSpend * 100) / 100,
    unmatchedSpendExvat: Math.round(unmatchedSpendExvat * 100) / 100,
    bucketStats,
  };
}

/**
 * Build a `TemuAdReport` shape from already-persisted DB rows
 * (`report_ad_spend` Goods-level rows for a saved Temu report). Mirrors
 * `loadTemuAdReport` output so downstream callers don't care about source.
 */
export function temuAdReportFromRows(input: {
  rows: Array<{
    temu_goods_id: string | null;
    goods_name: string | null;
    spend_exvat: number;
  }>;
  totalSpendExvat?: number | null;
  blankGoodsSpend?: number | null;
  sourceFilename?: string | null;
  spendColumn?: string | null;
}): TemuAdReport {
  const spendByGoodsId: Record<string, number> = {};
  const goodsNameByGoodsId: Record<string, string> = {};
  let blankGoodsSpend = 0;
  let totalSpend = 0;

  for (const row of input.rows) {
    const amt = Number(row.spend_exvat || 0);
    if (!Number.isFinite(amt) || amt === 0) continue;
    const positive = Math.abs(amt);
    totalSpend += positive;
    const goodsId = normalizeId(row.temu_goods_id);
    if (!goodsId) {
      blankGoodsSpend += positive;
      continue;
    }
    spendByGoodsId[goodsId] = (spendByGoodsId[goodsId] || 0) + positive;
    if (row.goods_name && !goodsNameByGoodsId[goodsId]) {
      goodsNameByGoodsId[goodsId] = String(row.goods_name);
    }
  }

  return {
    spendByGoodsId,
    goodsNameByGoodsId,
    blankGoodsSpend: input.blankGoodsSpend ?? blankGoodsSpend,
    totalSpend: input.totalSpendExvat ?? totalSpend,
    sourceFilename: input.sourceFilename ?? "",
    spendColumn: input.spendColumn ?? "Spend",
    goodsCount: Object.keys(spendByGoodsId).length,
  };
}
