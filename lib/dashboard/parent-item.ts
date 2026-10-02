import type { SupabaseClient } from "@supabase/supabase-js";
import { fetchSalesAndTraffic, type SalesTrafficAsinRow } from "@/lib/amazon/reports/sales-traffic";
import { resolvePeriod, type PeriodPreset } from "@/lib/utils/period-presets";

export type ParentProductRow = {
  parentAsin: string;
  units: number;
  orders: number;
  refunds: number;
  sales: number;
  vat: number;
};

export type ParentItemCard = {
  kind: "parent_item";
  preset: PeriodPreset;
  from: string;
  to: string;
  sales: number;
  vat: number;
  units: number;
  orders: number;
  refunds: number;
  products: ParentProductRow[];
  /** VAT is shown beside sales. It is not an expense and is not part of profit. */
  vatInProfit: false;
};

const CARD_PRESETS: PeriodPreset[] = ["today", "yesterday", "mtd", "last_month"];

function round2(value: number) {
  return Number(value.toFixed(2));
}

function isAsin(value: string) {
  return /^[A-Z0-9]{10}$/.test(value);
}

export function vatOnSales(sales: number, vatRatePct: number) {
  return round2(sales * (vatRatePct / 100));
}

function productsFromAsins(rows: SalesTrafficAsinRow[], vatRatePct: number): ParentProductRow[] {
  const byParent = new Map<string, ParentProductRow>();
  for (const row of rows) {
    const parentAsin = isAsin(row.parentAsin) ? row.parentAsin : "";
    if (!parentAsin) continue;
    const current = byParent.get(parentAsin) || {
      parentAsin,
      units: 0,
      orders: 0,
      refunds: 0,
      sales: 0,
      vat: 0,
    };
    current.units += row.units;
    current.orders += row.orders;
    current.refunds += row.refunds;
    current.sales += row.sales;
    byParent.set(parentAsin, current);
  }
  return Array.from(byParent.values())
    .map((row) => ({ ...row, sales: round2(row.sales), vat: vatOnSales(row.sales, vatRatePct) }))
    .filter((row) => row.units > 0 || row.sales > 0 || row.refunds > 0)
    .sort((a, b) => b.sales - a.sales);
}

function scaleCard(card: ParentItemCard, factor: number, from: string, to: string, preset: PeriodPreset): ParentItemCard {
  const mul = (value: number) => round2(value * factor);
  return {
    ...card,
    preset,
    from,
    to,
    sales: mul(card.sales),
    vat: mul(card.vat),
    units: Math.round(card.units * factor),
    orders: Math.round(card.orders * factor),
    refunds: Math.round(card.refunds * factor),
    products: card.products.map((row) => ({
      ...row,
      units: Math.round(row.units * factor),
      orders: Math.round(row.orders * factor),
      refunds: Math.round(row.refunds * factor),
      sales: mul(row.sales),
      vat: mul(row.vat),
    })),
  };
}

export function isParentItemCard(value: unknown): value is ParentItemCard {
  if (!value || typeof value !== "object") return false;
  return (value as { kind?: string }).kind === "parent_item";
}

export async function refreshParentItemCards(input: {
  supabase: SupabaseClient;
  accountId: string;
  vatRatePct: number;
}): Promise<ParentItemCard[]> {
  const cards: ParentItemCard[] = [];
  for (const preset of CARD_PRESETS) {
    const period = resolvePeriod({ preset });
    const report = await fetchSalesAndTraffic({
      accountId: input.accountId,
      from: period.from,
      to: period.to,
      asinGranularity: "PARENT",
    });
    const dated = report.byDate.filter((row) => row.date >= period.from && row.date <= period.to);
    const sales = round2(dated.reduce((sum, row) => sum + row.sales, 0));
    const card: ParentItemCard = {
      kind: "parent_item",
      preset,
      from: period.from,
      to: period.to,
      sales,
      vat: vatOnSales(sales, input.vatRatePct),
      units: dated.reduce((sum, row) => sum + row.units, 0),
      orders: dated.reduce((sum, row) => sum + row.orders, 0),
      refunds: dated.reduce((sum, row) => sum + row.refunds, 0),
      products: productsFromAsins(report.byAsin, input.vatRatePct),
      vatInProfit: false,
    };
    cards.push(card);
    await input.supabase.from("amazon_dashboard_snapshots").upsert(
      {
        account_id: input.accountId,
        preset,
        period_start: period.from,
        period_end: period.to,
        metrics: card,
        computed_at: new Date().toISOString(),
      },
      { onConflict: "account_id,preset" }
    );
  }

  const mtd = cards.find((card) => card.preset === "mtd");
  if (mtd) {
    const forecastPeriod = resolvePeriod({ preset: "this_month_forecast" });
    const factor = forecastPeriod.forecastFactor || 1;
    const forecast = scaleCard(mtd, factor, forecastPeriod.from, forecastPeriod.to, "this_month_forecast");
    cards.push(forecast);
    await input.supabase.from("amazon_dashboard_snapshots").upsert(
      {
        account_id: input.accountId,
        preset: "this_month_forecast",
        period_start: forecast.from,
        period_end: forecast.to,
        metrics: forecast,
        computed_at: new Date().toISOString(),
      },
      { onConflict: "account_id,preset" }
    );
  }
  return cards;
}
