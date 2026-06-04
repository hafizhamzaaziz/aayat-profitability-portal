import React from "react";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { Document, Image, Link, Page, StyleSheet, Text, View, pdf } from "@react-pdf/renderer";
import { computeExpenseTotals } from "@/lib/reports/expense-totals";
import { PdfWatermark, AAYAT_WEBSITE, AAYAT_PLUM_500 } from "./brand";

type ExpenseLine = {
  description: string;
  amount: number;
  includes_vat: boolean;
};

type PerformanceLine = {
  recorded_date: string;
  product_name: string;
  bsr: number | null;
  review_count: number | null;
  rating: number | null;
  ppc_spend?: number | null;
  ppc_sales?: number | null;
  total_sales?: number | null;
};

type SkuPdfRow = {
  sku: string;
  description?: string | null;
  units: number;
  netSales: number;
  cogs: number;
  advertisingAlloc: number;
  netProfit: number;
  netMargin: number;
};

type AdMetaSummary = {
  source_filename: string | null;
  total_spend_exvat: number;
  blank_sku_spend: number;
  matched_sku_count: number;
  unmatched_sku_count: number;
};

type Input = {
  accountName: string;
  accountLogoUrl: string | null;
  currency: string;
  platform: string;
  vatRate: number;
  periodStart: string;
  periodEnd: string;
  report: {
    gross_sales: number;
    total_cogs: number;
    total_fees: number;
    output_vat: number;
    input_vat: number;
    net_profit: number;
  };
  breakdown: {
    platform: "amazon" | "temu";
    summaryLines: Array<{ label: string; value: number }>;
    settlementLabel: string;
    settlementValue: number;
    transferLabel: string;
    transferValue: number;
    pnl: {
      settlementNet: number;
      purchaseCost: number;
      netProfit: number;
      coreOperatingProfit?: number;
      adjustmentsNet?: number;
    };
    vat: {
      outputVat: number;
      inputVatFees: number;
      inputVatPurchases: number;
      finalVat: number;
    };
  } | null;
  expenses: ExpenseLine[];
  performance: PerformanceLine[];
  /**
   * Performance-metric rows from the previous comparable period (typically the
   * month immediately preceding `periodStart`). When provided, the snapshot
   * compares period averages instead of last-week-vs-week-before.
   */
  performancePrevious?: PerformanceLine[];
  notes: string;
  skuLines?: SkuPdfRow[];
  adMeta?: AdMetaSummary | null;
  /** Persisted data-quality warnings (from report.breakdown.warnings). */
  warnings?: string[];
};

const styles = StyleSheet.create({
  page: { fontSize: 11, paddingTop: 28, paddingLeft: 28, paddingRight: 28, paddingBottom: 72, color: "#1f2937", fontFamily: "Helvetica" },
  topRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 16 },
  logo: { width: 56, height: 56, objectFit: "contain" as const },
  heading: { fontSize: 18, fontWeight: 700, maxWidth: "78%", color: "#401634" },
  sub: { color: "#6b7280", fontSize: 10, marginTop: 2 },
  section: { marginTop: 14, borderWidth: 1, borderColor: "#e5e7eb", borderRadius: 8, padding: 10 },
  sectionTitle: { fontSize: 12, fontWeight: 700, marginBottom: 8, color: "#401634" },
  row: {
    flexDirection: "row",
    justifyContent: "space-between",
    borderBottomWidth: 1,
    borderBottomColor: "#f3f4f6",
    paddingVertical: 4,
  },
  label: { color: "#374151" },
  value: { fontWeight: 600 },
  notes: { minHeight: 56, color: "#374151", lineHeight: 1.4 },
  tableHead: {
    flexDirection: "row",
    backgroundColor: "#f8fafc",
    borderBottomWidth: 1,
    borderBottomColor: "#e5e7eb",
    paddingVertical: 5,
    paddingHorizontal: 6,
  },
  tr: {
    flexDirection: "row",
    borderBottomWidth: 1,
    borderBottomColor: "#f3f4f6",
    paddingVertical: 5,
    paddingHorizontal: 6,
  },
  c1: { width: "26%" },
  c2: { width: "34%" },
  c3: { width: "14%", textAlign: "right" },
  c4: { width: "14%", textAlign: "right" },
  c5: { width: "12%", textAlign: "right" },
  perfC1: { width: "26%", paddingRight: 4, fontSize: 9 },
  perfC2: { width: `${(74 / 7).toFixed(2)}%`, paddingRight: 4, textAlign: "right", fontSize: 9 },
  twoCol: {
    flexDirection: "row",
    alignItems: "flex-start",
    marginTop: 14,
  },
  col: {
    width: "50%",
  },
  colLeft: {
    paddingRight: 5,
  },
  colRight: {
    paddingLeft: 5,
  },
  tightSection: {
    borderWidth: 1,
    borderColor: "#e5e7eb",
    borderRadius: 8,
    padding: 10,
  },
  colStack: {
    marginTop: 0,
  },
  sectionGap: {
    marginTop: 10,
  },
  footer: {
    position: "absolute",
    left: 28,
    right: 28,
    bottom: 20,
    borderTopWidth: 1,
    borderTopColor: "#e5e7eb",
    paddingTop: 8,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  footerText: { fontSize: 9, color: "#6b7280" },
  footerLink: { fontSize: 9, color: AAYAT_PLUM_500, textDecoration: "none", fontWeight: 700 },
  footerLogo: { width: 92, height: 18, objectFit: "contain" as const },
});

function m(currency: string, value: number) {
  const amount = Number(value || 0);
  const abs = Math.abs(amount).toFixed(2);
  return amount < 0 ? `-${currency}${abs}` : `${currency}${abs}`;
}

function dateUk(value: string) {
  if (!value) return "-";
  const date = new Date(`${value}T00:00:00`);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("en-GB").format(date);
}

function addDaysIso(iso: string, days: number) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * Aggregate raw weekly performance rows into a single per-product summary,
 * averaging numeric metrics across all rows in the period. Reviews are
 * monotonic so we use the latest value rather than the average.
 */
type PerfAggregate = {
  product_name: string;
  bsr: number | null;
  reviews: number | null;
  rating: number | null;
  ppc_spend: number | null;
  ppc_sales: number | null;
  total_sales: number | null;
  acos: number | null;
  tacos: number | null;
};

function aggregatePerformance(rows: PerformanceLine[] | undefined | null): Map<string, PerfAggregate> {
  const out = new Map<string, PerfAggregate>();
  if (!rows || rows.length === 0) return out;
  const byProduct = new Map<string, PerformanceLine[]>();
  for (const row of rows) {
    const name = String(row.product_name || "").trim();
    if (!name) continue;
    const key = name.toLowerCase();
    const list = byProduct.get(key) || [];
    list.push(row);
    byProduct.set(key, list);
  }
  const avg = (values: Array<number | null | undefined>) => {
    const nums = values.filter((v): v is number => v != null && Number.isFinite(Number(v))).map((v) => Number(v));
    if (nums.length === 0) return null;
    return nums.reduce((a, b) => a + b, 0) / nums.length;
  };
  byProduct.forEach((list, key) => {
    const sorted = [...list].sort((a, b) => String(a.recorded_date).localeCompare(String(b.recorded_date)));
    const product_name = sorted[sorted.length - 1].product_name;
    const bsr = avg(sorted.map((r) => r.bsr));
    const reviews = sorted[sorted.length - 1].review_count ?? null;
    const rating = avg(sorted.map((r) => r.rating));
    const ppc_spend = avg(sorted.map((r) => r.ppc_spend ?? null));
    const ppc_sales = avg(sorted.map((r) => r.ppc_sales ?? null));
    const total_sales = avg(sorted.map((r) => r.total_sales ?? null));
    const acos =
      ppc_spend != null && ppc_sales && ppc_sales !== 0 ? (ppc_spend / ppc_sales) * 100 : null;
    const tacos =
      ppc_spend != null && total_sales && total_sales !== 0 ? (ppc_spend / total_sales) * 100 : null;
    out.set(key, { product_name, bsr, reviews, rating, ppc_spend, ppc_sales, total_sales, acos, tacos });
  });
  return out;
}

type MetricKey = "bsr" | "reviews" | "rating" | "ppc_spend" | "ppc_sales" | "total_sales" | "acos" | "tacos";

function trendForMetric(metric: MetricKey): "higher_better" | "lower_better" {
  if (metric === "ppc_sales" || metric === "total_sales" || metric === "reviews" || metric === "rating") {
    return "higher_better";
  }
  return "lower_better";
}

/** Mirrors `valueColorClass` in the Performance tab. */
function perfColor(metric: MetricKey, current: number | null, previous: number | null): string {
  if (current == null || previous == null || current === previous) return "#111827";
  const trend = trendForMetric(metric);
  const better = trend === "higher_better" ? current > previous : current < previous;
  return better ? "#15803d" : "#b91c1c";
}

function fmt(metric: MetricKey, value: number | null): string {
  if (value == null) return "-";
  if (metric === "rating") return value.toFixed(2);
  if (metric === "acos" || metric === "tacos") return `${value.toFixed(1)}%`;
  if (metric === "bsr" || metric === "reviews") return Math.round(value).toLocaleString();
  return value.toFixed(2);
}

function titleCase(value: string) {
  return value.charAt(0).toUpperCase() + value.slice(1).toLowerCase();
}

function valueColor(value: number) {
  return value < 0 ? "#b91c1c" : "#111827";
}

function MetricRow({ currency, label, value }: { currency: string; label: string; value: number }) {
  return (
    <View style={styles.row}>
      <Text style={styles.label}>{label}</Text>
      <Text style={{ ...styles.value, color: valueColor(value) }}>{m(currency, value)}</Text>
    </View>
  );
}

function ReportPdf({ data, footerLogoDataUrl }: { data: Input; footerLogoDataUrl: string | null }) {
  const currentRows = (data.performance || []).filter((p) => {
    const d = String(p.recorded_date || "").slice(0, 10);
    return d >= data.periodStart && d <= data.periodEnd;
  });
  const previousRows = data.performancePrevious || [];

  const currentAgg = aggregatePerformance(currentRows);
  const previousAgg = aggregatePerformance(previousRows);

  // Period label — show the actual date span (full month) instead of last week.
  const previousPeriodStart = (() => {
    const start = new Date(`${data.periodStart}T00:00:00Z`);
    const end = new Date(`${data.periodEnd}T00:00:00Z`);
    const days = Math.max(1, Math.round((end.getTime() - start.getTime()) / 86400000) + 1);
    return addDaysIso(data.periodStart, -days);
  })();
  const previousPeriodEnd = addDaysIso(data.periodStart, -1);

  type SnapshotRow = {
    product_name: string;
    bsr: number | null;
    bsrPrev: number | null;
    reviews: number | null;
    reviewsPrev: number | null;
    rating: number | null;
    ratingPrev: number | null;
    ppc_spend: number | null;
    ppc_spendPrev: number | null;
    ppc_sales: number | null;
    ppc_salesPrev: number | null;
    acos: number | null;
    acosPrev: number | null;
    tacos: number | null;
    tacosPrev: number | null;
    hasPrior: boolean;
  };

  const perfSnapshot: SnapshotRow[] = (() => {
    const out: SnapshotRow[] = [];
    currentAgg.forEach((cur, key) => {
      const prev = previousAgg.get(key) || null;
      out.push({
        product_name: cur.product_name,
        bsr: cur.bsr,
        bsrPrev: prev?.bsr ?? null,
        reviews: cur.reviews,
        reviewsPrev: prev?.reviews ?? null,
        rating: cur.rating,
        ratingPrev: prev?.rating ?? null,
        ppc_spend: cur.ppc_spend,
        ppc_spendPrev: prev?.ppc_spend ?? null,
        ppc_sales: cur.ppc_sales,
        ppc_salesPrev: prev?.ppc_sales ?? null,
        acos: cur.acos,
        acosPrev: prev?.acos ?? null,
        tacos: cur.tacos,
        tacosPrev: prev?.tacos ?? null,
        hasPrior: Boolean(prev),
      });
    });
    return out.sort((a, b) => a.product_name.localeCompare(b.product_name));
  })();
  const showVatSummary = Number(data.vatRate || 0) > 0;
  const expenseTotals = computeExpenseTotals(data.expenses, data.vatRate);

  return (
    <Document>
      <Page size="A4" style={styles.page}>
        <PdfWatermark />
        <View style={styles.topRow}>
          <View>
            <Text style={styles.heading}>
              {data.accountName} {titleCase(data.platform)} Profitability Report
            </Text>
            <Text style={styles.sub}>
              {dateUk(data.periodStart)} to {dateUk(data.periodEnd)}
            </Text>
          </View>
          {data.accountLogoUrl ? (
            // eslint-disable-next-line jsx-a11y/alt-text
            <Image src={data.accountLogoUrl} style={styles.logo} />
          ) : null}
        </View>

        {data.breakdown ? (
          <View style={styles.twoCol} wrap={false}>
            <View style={{ ...styles.col, ...styles.colLeft }}>
              <View style={styles.tightSection}>
              <Text style={styles.sectionTitle}>
                {data.breakdown.platform === "amazon" ? "Amazon Report Summary" : "Temu Report Summary"}
                {showVatSummary ? " (excl. VAT)" : ""}
              </Text>
              {data.breakdown.summaryLines.map((line) => (
                <MetricRow key={line.label} currency={data.currency} label={line.label} value={line.value} />
              ))}
              <View style={styles.row}>
                <Text style={{ ...styles.label, fontWeight: 700 }}>{data.breakdown.settlementLabel}</Text>
                <Text style={{ ...styles.value, fontWeight: 700, color: valueColor(data.breakdown.settlementValue) }}>
                  {m(data.currency, data.breakdown.settlementValue)}
                </Text>
              </View>
              <View style={{ ...styles.row, borderBottomWidth: 0 }}>
                <Text style={styles.label}>{data.breakdown.transferLabel}</Text>
                <Text style={{ ...styles.value, color: valueColor(data.breakdown.transferValue) }}>
                  {m(data.currency, data.breakdown.transferValue)}
                </Text>
              </View>
              </View>
            </View>

            <View style={{ ...styles.col, ...styles.colRight }}>
              <View style={styles.colStack}>
                <View style={styles.tightSection}>
                  <Text style={styles.sectionTitle}>{showVatSummary ? "Profit & Loss (excl. VAT)" : "Profit & Loss"}</Text>
                  <MetricRow currency={data.currency} label={showVatSummary ? "Settlement (excl. VAT)" : "Settlement"} value={data.breakdown.pnl.settlementNet} />
                  <MetricRow
                    currency={data.currency}
                    label="Your Purchase Cost (excl. VAT)"
                    value={-Math.abs(data.breakdown.pnl.purchaseCost)}
                  />
                  <MetricRow
                    currency={data.currency}
                    label="Total Expenses (excl. VAT)"
                    value={-Math.abs(expenseTotals.net)}
                  />
                  {data.breakdown.platform === "temu" &&
                  typeof data.breakdown.pnl.coreOperatingProfit === "number" &&
                  typeof data.breakdown.pnl.adjustmentsNet === "number" ? (
                    <>
                      <MetricRow
                        currency={data.currency}
                        label="Core Sales Operating Profit"
                        value={data.breakdown.pnl.coreOperatingProfit}
                      />
                      <MetricRow
                        currency={data.currency}
                        label="Adjustments Net (labels/repayments/penalties)"
                        value={data.breakdown.pnl.adjustmentsNet}
                      />
                    </>
                  ) : null}
                  <View style={{ ...styles.row, borderBottomWidth: 0 }}>
                    <Text style={{ ...styles.label, fontWeight: 700 }}>Total Net Profit</Text>
                    <Text style={{ ...styles.value, fontWeight: 700, color: valueColor(data.report.net_profit) }}>
                      {m(data.currency, data.report.net_profit)}
                    </Text>
                  </View>
                </View>
                {showVatSummary ? (
                  <View style={{ ...styles.tightSection, ...styles.sectionGap }}>
                    <Text style={styles.sectionTitle}>VAT Summary</Text>
                    <MetricRow currency={data.currency} label="VAT on Sales (Output)" value={data.report.output_vat} />
                    <MetricRow currency={data.currency} label="VAT on Fees/Inputs (Input)" value={-Math.abs(data.breakdown.vat.inputVatFees || 0)} />
                    <MetricRow currency={data.currency} label="VAT on Purchases (Input)" value={-Math.abs(data.breakdown.vat.inputVatPurchases || 0)} />
                    <View style={{ ...styles.row, borderBottomWidth: 0 }}>
                      <Text style={{ ...styles.label, fontWeight: 700 }}>Final VAT to Pay / Reclaim</Text>
                      <Text style={{ ...styles.value, fontWeight: 700, color: valueColor(data.report.output_vat - data.report.input_vat) }}>
                        {m(data.currency, data.report.output_vat - data.report.input_vat)}
                      </Text>
                    </View>
                  </View>
                ) : null}
              </View>
            </View>
          </View>
        ) : (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Financial Summary</Text>
            <MetricRow currency={data.currency} label="Gross Sales" value={data.report.gross_sales} />
            <MetricRow currency={data.currency} label="Total COGS" value={-Math.abs(data.report.total_cogs)} />
            <MetricRow currency={data.currency} label="Total Fees" value={-Math.abs(data.report.total_fees)} />
            <MetricRow currency={data.currency} label="Output VAT" value={data.report.output_vat} />
            <MetricRow currency={data.currency} label="Input VAT" value={-Math.abs(data.report.input_vat)} />
            <View style={{ ...styles.row, borderBottomWidth: 0 }}>
              <Text style={{ ...styles.label, fontWeight: 700 }}>Net Profit</Text>
              <Text style={{ ...styles.value, fontWeight: 700, color: valueColor(data.report.net_profit) }}>
                {m(data.currency, data.report.net_profit)}
              </Text>
            </View>
          </View>
        )}

        <View style={styles.section} wrap={false}>
          <Text style={styles.sectionTitle}>External Expenses Snapshot</Text>
          {data.expenses.length === 0 ? (
            <Text style={styles.sub}>No manual expenses recorded.</Text>
          ) : (
            data.expenses.slice(0, 10).map((e, idx) => (
              <View key={`${e.description}-${idx}`} style={styles.row}>
                <Text style={styles.label}>{e.description || "Expense"}</Text>
                <Text style={{ ...styles.value, color: valueColor(e.amount) }}>
                  {m(data.currency, e.amount)}
                  {e.includes_vat ? " (inc VAT)" : ""}
                </Text>
              </View>
            ))
          )}
        </View>

        <View style={styles.section} wrap={false}>
          <Text style={styles.sectionTitle}>Manual Notes</Text>
          <Text style={styles.notes}>{data.notes?.trim() ? data.notes.trim() : "No manual notes provided."}</Text>
        </View>

        {data.warnings && data.warnings.length > 0 ? (
          <View style={{ ...styles.section, borderColor: "#fde68a", backgroundColor: "#fffbeb" }}>
            <Text style={styles.sectionTitle}>Data Quality Warnings</Text>
            {data.warnings.map((warning, idx) => (
              <View key={`warn-${idx}`} style={{ flexDirection: "row", marginTop: 2 }}>
                <Text style={{ width: 10, color: "#92400e" }}>•</Text>
                <Text style={{ flex: 1, color: "#92400e" }}>{warning}</Text>
              </View>
            ))}
          </View>
        ) : null}

        {data.platform === "amazon" ? (
          <View style={styles.section}>
            <Text style={styles.sectionTitle} minPresenceAhead={90}>Performance Metrics Snapshot</Text>
            {perfSnapshot.length === 0 ? (
              <Text style={styles.sub}>No performance metrics available for this period.</Text>
            ) : (
              <>
                <Text style={styles.sub}>
                  {dateUk(data.periodStart)} to {dateUk(data.periodEnd)} averages, vs{" "}
                  {dateUk(previousPeriodStart)} to {dateUk(previousPeriodEnd)}
                </Text>
                <View style={styles.tableHead}>
                  <Text style={styles.perfC1}>Product</Text>
                  <Text style={styles.perfC2}>BSR</Text>
                  <Text style={styles.perfC2}>Reviews</Text>
                  <Text style={styles.perfC2}>Rating</Text>
                  <Text style={styles.perfC2}>PPC Spend</Text>
                  <Text style={styles.perfC2}>PPC Sales</Text>
                  <Text style={styles.perfC2}>ACOS</Text>
                  <Text style={styles.perfC2}>TACOS</Text>
                </View>
                {perfSnapshot.map((p, idx) => {
                  const cell = (metric: MetricKey, current: number | null, previous: number | null) => (
                    <View style={styles.perfC2}>
                      <Text style={{ color: perfColor(metric, current, previous) }}>{fmt(metric, current)}</Text>
                      <Text style={{ fontSize: 8, color: "#64748b" }}>
                        {previous == null ? "vs last: -" : `vs last: ${fmt(metric, previous)}`}
                      </Text>
                    </View>
                  );
                  return (
                    <View key={`${p.product_name}-${idx}`} style={styles.tr} wrap={false}>
                      <Text style={styles.perfC1}>{p.product_name}</Text>
                      {cell("bsr", p.bsr, p.bsrPrev)}
                      {cell("reviews", p.reviews, p.reviewsPrev)}
                      {cell("rating", p.rating, p.ratingPrev)}
                      {cell("ppc_spend", p.ppc_spend, p.ppc_spendPrev)}
                      {cell("ppc_sales", p.ppc_sales, p.ppc_salesPrev)}
                      {cell("acos", p.acos, p.acosPrev)}
                      {cell("tacos", p.tacos, p.tacosPrev)}
                    </View>
                  );
                })}
                <Text style={{ ...styles.sub, marginTop: 6, fontSize: 8 }}>
                  Green = better than previous period, red = worse. BSR/PPC Spend/ACOS/TACOS lower
                  is better; Reviews/Rating/PPC Sales higher is better.
                </Text>
              </>
            )}
          </View>
        ) : null}

        {data.skuLines && data.skuLines.length > 0 ? (
          <View style={styles.section}>
            <Text style={styles.sectionTitle} minPresenceAhead={90}>Per-SKU Profitability ({data.skuLines.length} SKUs)</Text>
            <Text style={styles.sub}>
              Sorted by net profit. Figures ex-VAT. Per-SKU net profit is marketplace activity only; manual external
              expenses are not pushed into individual SKUs and are reconciled in the roll-up below.
            </Text>
            <View style={{ ...styles.tableHead, marginTop: 6 }} fixed>
              <Text style={{ width: "32%" }}>SKU</Text>
              <Text style={{ width: "10%", textAlign: "right" }}>Units</Text>
              <Text style={{ width: "16%", textAlign: "right" }}>Net Sales</Text>
              <Text style={{ width: "14%", textAlign: "right" }}>COGS</Text>
              <Text style={{ width: "14%", textAlign: "right" }}>Ads</Text>
              <Text style={{ width: "14%", textAlign: "right" }}>Net Profit</Text>
            </View>
            {(() => {
              const sorted = [...data.skuLines].sort((a, b) => b.netProfit - a.netProfit);
              const totals = sorted.reduce(
                (acc, row) => {
                  acc.units += Number(row.units || 0);
                  acc.netSales += Number(row.netSales || 0);
                  acc.cogs += Number(row.cogs || 0);
                  acc.advertisingAlloc += Number(row.advertisingAlloc || 0);
                  acc.netProfit += Number(row.netProfit || 0);
                  return acc;
                },
                { units: 0, netSales: 0, cogs: 0, advertisingAlloc: 0, netProfit: 0 }
              );
              const externalNet = expenseTotals.net;
              const finalNet = Number(data.report.net_profit || 0);
              const bridgeCheck = Math.round((totals.netProfit - externalNet - finalNet) * 100) / 100;

              const rollRow = (
                label: string,
                vals: { units: string; ns: string; cg: string; ad: string; np: string },
                profitColor: string,
                emphasizeBg?: boolean
              ) => (
                <View
                  style={{
                    ...styles.tr,
                    borderTopWidth: 1,
                    borderTopColor: "#cbd5e1",
                    backgroundColor: emphasizeBg ? "#eef2ff" : "#f8fafc",
                    borderBottomWidth: 0,
                  }}
                  wrap={false}
                >
                  <Text style={{ width: "32%", fontWeight: emphasizeBg ? 700 : 600 }}>{label}</Text>
                  <Text style={{ width: "10%", textAlign: "right", fontWeight: emphasizeBg ? 700 : 600 }}>{vals.units}</Text>
                  <Text style={{ width: "16%", textAlign: "right", fontWeight: emphasizeBg ? 700 : 600 }}>{vals.ns}</Text>
                  <Text style={{ width: "14%", textAlign: "right", fontWeight: emphasizeBg ? 700 : 600 }}>{vals.cg}</Text>
                  <Text style={{ width: "14%", textAlign: "right", fontWeight: emphasizeBg ? 700 : 600 }}>{vals.ad}</Text>
                  <Text
                    style={{
                      width: "14%",
                      textAlign: "right",
                      fontWeight: emphasizeBg ? 700 : 600,
                      color: profitColor,
                    }}
                  >
                    {vals.np}
                  </Text>
                </View>
              );

              return (
                <>
                  {sorted.map((row, idx) => (
                    <View key={`${row.sku}-${idx}`} style={styles.tr} wrap={false}>
                      <View style={{ width: "32%" }}>
                        <Text style={{ fontFamily: "Courier" }}>{row.sku}</Text>
                        {row.description ? (
                          <Text style={{ fontSize: 8, color: "#64748b" }}>{(row.description || "").slice(0, 80)}</Text>
                        ) : null}
                      </View>
                      <Text style={{ width: "10%", textAlign: "right" }}>{row.units.toLocaleString()}</Text>
                      <Text style={{ width: "16%", textAlign: "right" }}>{m(data.currency, row.netSales)}</Text>
                      <Text style={{ width: "14%", textAlign: "right" }}>{m(data.currency, row.cogs)}</Text>
                      <Text style={{ width: "14%", textAlign: "right" }}>{m(data.currency, row.advertisingAlloc)}</Text>
                      <Text style={{ width: "14%", textAlign: "right", color: valueColor(row.netProfit), fontWeight: 700 }}>
                        {m(data.currency, row.netProfit)}
                      </Text>
                    </View>
                  ))}
                  {rollRow(
                    "Subtotal — marketplace (sum of SKUs)",
                    {
                      units: totals.units.toLocaleString(),
                      ns: m(data.currency, totals.netSales),
                      cg: m(data.currency, totals.cogs),
                      ad: m(data.currency, totals.advertisingAlloc),
                      np: m(data.currency, totals.netProfit),
                    },
                    valueColor(totals.netProfit),
                    false
                  )}
                  {rollRow(
                    "External expenses (net, not allocated)",
                    {
                      units: "—",
                      ns: "—",
                      cg: "—",
                      ad: "—",
                      np: externalNet > 0 ? m(data.currency, -externalNet) : m(data.currency, 0),
                    },
                    "#b91c1c",
                    false
                  )}
                  {rollRow(
                    "Final net profit (account)",
                    {
                      units: "—",
                      ns: "—",
                      cg: "—",
                      ad: "—",
                      np: m(data.currency, finalNet),
                    },
                    valueColor(finalNet),
                    true
                  )}
                  {Math.abs(bridgeCheck) > 0.02 ? (
                    <Text style={{ ...styles.sub, marginTop: 4, fontSize: 8, color: "#b45309" }}>
                      Bridge check: SKU subtotal minus external expenses should equal account net profit; residual{" "}
                      {m(data.currency, bridgeCheck)} — often unsaved edits or legacy data. Click Save edits or Recompute.
                    </Text>
                  ) : null}
                </>
              );
            })()}
          </View>
        ) : null}

        <View style={styles.footer} fixed>
          {footerLogoDataUrl ? (
            // eslint-disable-next-line jsx-a11y/alt-text
            <Image src={footerLogoDataUrl} style={styles.footerLogo} />
          ) : (
            <Text />
          )}
          <View style={{ flexDirection: "row", alignItems: "center" }}>
            <Link src={AAYAT_WEBSITE} style={styles.footerLink}>
              aayat.co
            </Link>
            <Text style={styles.footerText}>{"  |  hello@aayat.co  |  +44 7727 666043"}</Text>
          </View>
        </View>
      </Page>
    </Document>
  );
}

async function getFooterLogoDataUrl() {
  try {
    const logoPath = path.join(process.cwd(), "public", "aayat-logo.png");
    const bytes = await readFile(logoPath);
    return `data:image/png;base64,${bytes.toString("base64")}`;
  } catch {
    return null;
  }
}

export async function renderReportPdfBuffer(data: Input): Promise<Uint8Array> {
  const footerLogoDataUrl = await getFooterLogoDataUrl();
  const instance = pdf(<ReportPdf data={data} footerLogoDataUrl={footerLogoDataUrl} />);
  const output = await instance.toBuffer();

  // @react-pdf/renderer may return either a Node Buffer/Uint8Array or a stream depending on runtime/version.
  if (output instanceof Uint8Array) {
    return new Uint8Array(output);
  }

  const maybeWebStream = output as unknown as { getReader?: () => ReadableStreamDefaultReader<Uint8Array> };
  if (typeof maybeWebStream.getReader === "function") {
    const reader = maybeWebStream.getReader();
    const chunks: Uint8Array[] = [];
    let totalLength = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      chunks.push(value);
      totalLength += value.length;
    }
    const merged = new Uint8Array(totalLength);
    let offset = 0;
    for (const chunk of chunks) {
      merged.set(chunk, offset);
      offset += chunk.length;
    }
    return merged;
  }

  const maybeNodeStream = output as unknown as {
    on?: (event: string, callback: (...args: unknown[]) => void) => void;
  };
  if (typeof maybeNodeStream.on === "function") {
    const chunks: Uint8Array[] = [];
    await new Promise<void>((resolve, reject) => {
      maybeNodeStream.on!("data", (chunk: unknown) => {
        if (chunk instanceof Uint8Array) chunks.push(chunk);
        else chunks.push(new Uint8Array(Buffer.from(String(chunk))));
      });
      maybeNodeStream.on!("end", () => resolve());
      maybeNodeStream.on!("error", (err: unknown) => reject(err));
    });
    const totalLength = chunks.reduce((acc, chunk) => acc + chunk.length, 0);
    const merged = new Uint8Array(totalLength);
    let offset = 0;
    for (const chunk of chunks) {
      merged.set(chunk, offset);
      offset += chunk.length;
    }
    return merged;
  }

  throw new Error("Unexpected PDF buffer output type.");
}
