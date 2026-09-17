import { monthStartIso } from "@/lib/utils/date";
import type { MonthlySalesRow } from "@/lib/inventory/engine";

export type SalesFactRow = {
  platform: string | null;
  sku: string | null;
  sale_date: string;
  qty: number | string | null;
};

export type TxFact = {
  mappingId: string;
  date: string;
  platform: "amazon" | "temu";
  quantity: number;
};

export type ManualDailySaleLike = {
  id: string;
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

export type UnifiedDailySale = ManualDailySaleLike & {
  source: "reports" | "manual";
  editable: boolean;
};

export function normalizeSkuToken(input: unknown) {
  const raw = String(input ?? "")
    .replace(/\u00a0/g, " ")
    .trim()
    .toUpperCase();
  if (!raw) return "";
  if (/^\d+\.0+$/.test(raw)) return raw.replace(/\.0+$/, "");
  return raw;
}

export function mapSalesFactsToTxFacts(input: {
  facts: SalesFactRow[];
  mappings: Array<{ mappingId: string; amazonSku: string | null; temuSkuId: string | null }>;
}): { txFacts: TxFact[]; monthlySales: MonthlySalesRow[] } {
  const mappingByAmazonSku = new Map(
    input.mappings
      .filter((m) => m.amazonSku)
      .map((m) => [normalizeSkuToken(m.amazonSku), m.mappingId]),
  );
  const mappingByTemuSku = new Map(
    input.mappings
      .filter((m) => m.temuSkuId)
      .map((m) => [normalizeSkuToken(m.temuSkuId), m.mappingId]),
  );

  const monthlyAccumulator = new Map<string, MonthlySalesRow>();
  const factRows: TxFact[] = [];

  input.facts.forEach((rec) => {
    const platform = String(rec.platform || "").trim().toLowerCase();
    const sku = normalizeSkuToken(rec.sku || "");
    if (!sku || !rec.sale_date) return;
    const quantity = Number(rec.qty || 0);
    if (!Number.isFinite(quantity) || quantity <= 0) return;

    const mappingId = platform.startsWith("amazon")
      ? mappingByAmazonSku.get(sku)
      : platform.startsWith("temu")
        ? mappingByTemuSku.get(sku)
        : mappingByAmazonSku.get(sku) || mappingByTemuSku.get(sku);
    if (!mappingId) return;

    const txDate = String(rec.sale_date || "").slice(0, 10);
    const factPlatform: "amazon" | "temu" = platform.startsWith("temu") ? "temu" : "amazon";
    if (txDate) {
      factRows.push({
        mappingId,
        date: txDate,
        platform: factPlatform,
        quantity,
      });
    }

    const monthStart = monthStartIso(rec.sale_date);
    const key = `${mappingId}|${monthStart}`;
    const existing = monthlyAccumulator.get(key) || {
      mappingId,
      monthStart,
      amazonUnits: 0,
      temuUnits: 0,
    };
    if (factPlatform === "temu") existing.temuUnits += quantity;
    else existing.amazonUnits += quantity;
    monthlyAccumulator.set(key, existing);
  });

  return { txFacts: factRows, monthlySales: Array.from(monthlyAccumulator.values()) };
}

function factKey(mappingId: string, date: string, platform: string) {
  return `${mappingId}|${date}|${String(platform || "").trim().toLowerCase()}`;
}

/**
 * Daily Sales history: sold units come from `inventory_sales_facts_cache`
 * (same source as Overview). Manual `inventory_daily_sales` rows stay visible
 * for returns/collected/warehouse notes and for platforms the cache does not
 * cover (e.g. TikTok). Manual sold units are not added on top of a matching
 * reports row, so Overview and Daily Sales totals agree for the same range.
 */
export function buildUnifiedDailySales(input: {
  txFacts: TxFact[];
  manual: ManualDailySaleLike[];
}): UnifiedDailySale[] {
  const soldByKey = new Map<string, number>();
  input.txFacts.forEach((tx) => {
    const key = factKey(tx.mappingId, tx.date, tx.platform);
    soldByKey.set(key, (soldByKey.get(key) || 0) + Number(tx.quantity || 0));
  });

  const manualByKey = new Map<string, ManualDailySaleLike[]>();
  input.manual.forEach((row) => {
    const key = factKey(row.sku_mapping_id, row.sale_date, row.platform);
    const list = manualByKey.get(key) || [];
    list.push(row);
    manualByKey.set(key, list);
  });

  const rows: UnifiedDailySale[] = [];
  const usedManualIds = new Set<string>();

  soldByKey.forEach((sold, key) => {
    const [mappingId, date, platform] = key.split("|");
    const manuals = manualByKey.get(key) || [];
    const overlay = manuals[0];
    manuals.forEach((row) => usedManualIds.add(row.id));
    rows.push({
      id: overlay ? overlay.id : `fact:${key}`,
      sku_mapping_id: mappingId,
      sale_date: date,
      platform,
      warehouse_id: overlay?.warehouse_id ?? null,
      sold_units: sold,
      returns_units: manuals.reduce((acc, row) => acc + Number(row.returns_units || 0), 0),
      collected_units: manuals.reduce((acc, row) => acc + Number(row.collected_units || 0), 0),
      notes: overlay?.notes ?? null,
      created_at: overlay?.created_at ?? `${date}T00:00:00.000Z`,
      source: "reports",
      editable: false,
    });
  });

  input.manual.forEach((row) => {
    if (usedManualIds.has(row.id)) return;
    rows.push({
      ...row,
      source: "manual",
      editable: true,
    });
  });

  return rows.sort((a, b) => {
    if (a.sale_date !== b.sale_date) return a.sale_date < b.sale_date ? 1 : -1;
    if (a.sku_mapping_id !== b.sku_mapping_id) return a.sku_mapping_id.localeCompare(b.sku_mapping_id);
    return a.platform.localeCompare(b.platform);
  });
}

export function sumReportedSoldUnits(rows: UnifiedDailySale[]) {
  return rows
    .filter((row) => row.source === "reports")
    .reduce((acc, row) => acc + Number(row.sold_units || 0), 0);
}
