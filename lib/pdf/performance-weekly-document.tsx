import React from "react";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { Document, Image, Link, Page, StyleSheet, Text, View, pdf } from "@react-pdf/renderer";
import { formatUkDate } from "@/lib/utils/date";

type Metric = {
  recorded_date: string;
  product_name: string;
  asin: string | null;
  bsr: number | null;
  review_count: number | null;
  rating: number | null;
  ppc_spend: number | null;
  ppc_sales: number | null;
  total_sales: number | null;
};

type Platform = "amazon" | "temu";

type Section = {
  platform: Platform;
  rows: Metric[];
  previousRows: Metric[];
};

type Input = {
  accountName: string;
  accountLogoUrl: string | null;
  weekStart: string;
  weekEnd: string;
  previousWeekStart: string;
  previousWeekEnd: string;
  sections: Section[];
};

const styles = StyleSheet.create({
  page: { fontSize: 9, paddingTop: 20, paddingLeft: 20, paddingRight: 20, paddingBottom: 58, color: "#1f2937", fontFamily: "Helvetica" },
  topRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 10 },
  title: { fontSize: 15, fontWeight: 700, maxWidth: "80%" },
  sub: { fontSize: 9, color: "#6b7280", marginTop: 2 },
  logo: { width: 56, height: 56, objectFit: "contain" as const },
  tableHead: {
    flexDirection: "row",
    borderBottomWidth: 1,
    borderBottomColor: "#d1d5db",
    backgroundColor: "#f8fafc",
    paddingVertical: 3,
    paddingHorizontal: 4,
    fontWeight: 700,
  },
  tr: {
    flexDirection: "row",
    borderBottomWidth: 1,
    borderBottomColor: "#eef2f7",
    paddingVertical: 3,
    paddingHorizontal: 4,
  },
  c1: { width: "16%" },
  c2: { width: "12%" },
  c3: { width: "8%", textAlign: "right" },
  c4: { width: "8%", textAlign: "right" },
  c5: { width: "8%", textAlign: "right" },
  c6: { width: "7%", textAlign: "right" },
  c7: { width: "7%", textAlign: "right" },
  c8: { width: "8%", textAlign: "right" },
  c9: { width: "8%", textAlign: "right" },
  c10: { width: "6%", textAlign: "right" },
  c11: { width: "10%", textAlign: "right" },
  asinLink: { color: "#1d4ed8", textDecoration: "underline" },
  valueGood: { color: "#15803d" },
  valueBad: { color: "#dc2626" },
  valueNeutral: { color: "#111827" },
  deltaNeutral: { fontSize: 7, color: "#64748b" },
  sectionTitle: { marginTop: 8, marginBottom: 4, fontSize: 10, fontWeight: 700 },
  totalsRow: { flexDirection: "row", flexWrap: "wrap", gap: 6, marginTop: 6, marginBottom: 6 },
  totalsCard: {
    width: "19%",
    borderWidth: 1,
    borderColor: "#e2e8f0",
    borderRadius: 6,
    padding: 6,
    backgroundColor: "#f8fafc",
  },
  totalsLabel: { fontSize: 7, color: "#475569", textTransform: "uppercase" },
  totalsValue: { fontSize: 12, fontWeight: 700, marginTop: 2, color: "#0f172a" },
  totalsDelta: { fontSize: 7, marginTop: 2 },
  deltaGood: { color: "#15803d" },
  deltaBad: { color: "#dc2626" },
  footer: {
    position: "absolute",
    left: 20,
    right: 20,
    bottom: 14,
    borderTopWidth: 1,
    borderTopColor: "#e5e7eb",
    paddingTop: 6,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  footerText: { fontSize: 9, color: "#6b7280" },
  footerLogo: { width: 56, height: 56, objectFit: "contain" as const },
});

function pct(num: number | null) {
  return num == null ? "-" : `${num.toFixed(2)}%`;
}

function n(num: number | null) {
  return num == null ? "-" : Number(num).toFixed(2);
}

const TEMU_PREFIX = "TEMU:";

function decodeIdentifier(raw: string | null) {
  const value = String(raw || "").trim().toUpperCase();
  if (value.startsWith(TEMU_PREFIX)) return value.slice(TEMU_PREFIX.length);
  return value;
}

function comparisonMeta(
  current: number | null,
  previous: number | null,
  trend: "higher_better" | "lower_better",
  formatter?: (value: number) => string
) {
  if (current == null || previous == null) {
    return { vsLastText: "vs last: -", valueStyle: "neutral" as const };
  }
  if (current === previous) {
    return { vsLastText: `vs last: ${formatter ? formatter(previous) : previous}`, valueStyle: "neutral" as const };
  }
  const isGood = trend === "higher_better" ? current > previous : current < previous;
  return {
    vsLastText: `vs last: ${formatter ? formatter(previous) : previous}`,
    valueStyle: isGood ? ("good" as const) : ("bad" as const),
  };
}

function valueStyleFor(status: "good" | "bad" | "neutral") {
  if (status === "good") return styles.valueGood;
  if (status === "bad") return styles.valueBad;
  return styles.valueNeutral;
}

function sectionTotals(rows: Metric[]) {
  let spend = 0;
  let sales = 0;
  let total = 0;
  let spendN = 0;
  let salesN = 0;
  let totalN = 0;
  for (const row of rows) {
    if (row.ppc_spend != null) {
      spend += Number(row.ppc_spend);
      spendN += 1;
    }
    if (row.ppc_sales != null) {
      sales += Number(row.ppc_sales);
      salesN += 1;
    }
    if (row.total_sales != null) {
      total += Number(row.total_sales);
      totalN += 1;
    }
  }
  const acos = sales > 0 ? (spend / sales) * 100 : null;
  const tacos = total > 0 ? (spend / total) * 100 : null;
  return {
    spend: spendN ? spend : null,
    sales: salesN ? sales : null,
    total: totalN ? total : null,
    acos,
    tacos,
  };
}

function formatTotalsValue(value: number | null, kind: "money" | "percent") {
  if (value == null) return "-";
  return kind === "percent" ? `${value.toFixed(2)}%` : value.toFixed(2);
}

function totalsDeltaText(cur: number | null, prev: number | null, kind: "money" | "percent") {
  if (cur == null || prev == null) return "vs last week: -";
  const diff = cur - prev;
  const sign = diff > 0 ? "+" : "";
  return `vs last: ${sign}${formatTotalsValue(diff, kind)}`;
}

function totalsDeltaStyle(
  cur: number | null,
  prev: number | null,
  trend: "higher_better" | "lower_better"
) {
  if (cur == null || prev == null || cur === prev) return styles.totalsDelta;
  const isUp = cur > prev;
  const good = trend === "higher_better" ? isUp : !isUp;
  return good ? { ...styles.totalsDelta, ...styles.deltaGood } : { ...styles.totalsDelta, ...styles.deltaBad };
}

function SectionTotalsRow({ rows, previousRows }: { rows: Metric[]; previousRows: Metric[] }) {
  const cur = sectionTotals(rows);
  const prev = sectionTotals(previousRows);
  const cards: Array<{
    label: string;
    cur: number | null;
    prev: number | null;
    kind: "money" | "percent";
    trend: "higher_better" | "lower_better";
  }> = [
    { label: "Total PPC Spend", cur: cur.spend, prev: prev.spend, kind: "money", trend: "lower_better" },
    { label: "Total PPC Sales", cur: cur.sales, prev: prev.sales, kind: "money", trend: "higher_better" },
    { label: "Total Sales", cur: cur.total, prev: prev.total, kind: "money", trend: "higher_better" },
    { label: "Avg ACOS", cur: cur.acos, prev: prev.acos, kind: "percent", trend: "lower_better" },
    { label: "Avg TACOS", cur: cur.tacos, prev: prev.tacos, kind: "percent", trend: "lower_better" },
  ];
  return (
    <View style={styles.totalsRow}>
      {cards.map((card) => (
        <View key={card.label} style={styles.totalsCard}>
          <Text style={styles.totalsLabel}>{card.label}</Text>
          <Text style={styles.totalsValue}>{formatTotalsValue(card.cur, card.kind)}</Text>
          <Text style={totalsDeltaStyle(card.cur, card.prev, card.trend)}>
            {totalsDeltaText(card.cur, card.prev, card.kind)}
          </Text>
        </View>
      ))}
    </View>
  );
}

function WeeklyPerformancePdf({ data, footerLogoDataUrl }: { data: Input; footerLogoDataUrl: string | null }) {
  return (
    <Document>
      <Page size="A4" orientation="landscape" style={styles.page}>
        <View style={styles.topRow}>
          <View>
            <Text style={styles.title}>{data.accountName} Weekly Performance Report</Text>
            <Text style={styles.sub}>
              Week: {formatUkDate(data.weekStart)} to {formatUkDate(data.weekEnd)}
            </Text>
            <Text style={styles.sub}>
              Comparison: {formatUkDate(data.previousWeekStart)} to {formatUkDate(data.previousWeekEnd)}
            </Text>
          </View>
          {data.accountLogoUrl ? (
            // eslint-disable-next-line jsx-a11y/alt-text
            <Image src={data.accountLogoUrl} style={styles.logo} />
          ) : null}
        </View>

        {data.sections.map((section) => {
          const prevByKey = new Map<string, Metric>();
          for (const row of section.previousRows) {
            prevByKey.set(`${row.product_name.toLowerCase()}|${decodeIdentifier(row.asin)}`, row);
          }
          const idLabel = section.platform === "amazon" ? "ASIN" : "Goods ID";

          return (
            <View key={section.platform}>
              <Text style={styles.sectionTitle}>{section.platform === "amazon" ? "Amazon Performance" : "Temu Performance"}</Text>
              <SectionTotalsRow rows={section.rows} previousRows={section.previousRows} />
              <View style={styles.tableHead}>
                <Text style={styles.c1}>Product</Text>
                <Text style={styles.c2}>{idLabel}</Text>
                <Text style={styles.c3}>PPC Spend</Text>
                <Text style={styles.c4}>PPC Sales</Text>
                <Text style={styles.c5}>Total Sales</Text>
                <Text style={styles.c6}>ACOS</Text>
                <Text style={styles.c7}>TACOS</Text>
                {section.platform === "amazon" ? <Text style={styles.c8}>BSR</Text> : null}
                <Text style={styles.c9}>Reviews</Text>
                <Text style={styles.c10}>Rating</Text>
                <Text style={styles.c11}>Comparison</Text>
              </View>
              {section.rows.length === 0 ? (
                <View style={styles.tr}>
                  <Text>No rows for selected week.</Text>
                </View>
              ) : (
                section.rows.map((row, idx) => {
                  const identifier = decodeIdentifier(row.asin);
                  const acos = row.ppc_spend && row.ppc_sales ? (row.ppc_spend / row.ppc_sales) * 100 : null;
                  const tacos = row.ppc_spend && row.total_sales ? (row.ppc_spend / row.total_sales) * 100 : null;
                  const prev = prevByKey.get(`${row.product_name.toLowerCase()}|${identifier}`);
                  const prevAcos = prev?.ppc_spend && prev?.ppc_sales ? (prev.ppc_spend / prev.ppc_sales) * 100 : null;
                  const prevTacos = prev?.ppc_spend && prev?.total_sales ? (prev.ppc_spend / prev.total_sales) * 100 : null;
                  const spend = comparisonMeta(row.ppc_spend, prev?.ppc_spend ?? null, "lower_better", (value) => value.toFixed(2));
                  const ppcSales = comparisonMeta(row.ppc_sales, prev?.ppc_sales ?? null, "higher_better", (value) => value.toFixed(2));
                  const totalSales = comparisonMeta(row.total_sales, prev?.total_sales ?? null, "higher_better", (value) => value.toFixed(2));
                  const acosMeta = comparisonMeta(acos, prevAcos, "lower_better", (value) => `${value.toFixed(2)}%`);
                  const tacosMeta = comparisonMeta(tacos, prevTacos, "lower_better", (value) => `${value.toFixed(2)}%`);
                  const bsrMeta = comparisonMeta(row.bsr, prev?.bsr ?? null, "lower_better");
                  const reviewsMeta = comparisonMeta(row.review_count, prev?.review_count ?? null, "higher_better");
                  const ratingMeta = comparisonMeta(row.rating, prev?.rating ?? null, "higher_better", (value) => value.toFixed(2));

                  return (
                    <View key={`${section.platform}-${row.product_name}-${idx}`} style={styles.tr}>
                      <Text style={styles.c1}>{row.product_name}</Text>
                      <Text style={styles.c2}>
                        {identifier ? (
                          <Link
                            src={
                              section.platform === "amazon"
                                ? `https://www.amazon.co.uk/dp/${identifier}`
                                : `https://www.temu.com/goods.html?_bg_fs=1&goods_id=${identifier}`
                            }
                            style={styles.asinLink}
                          >
                            {identifier}
                          </Link>
                        ) : (
                          "-"
                        )}
                      </Text>
                      <View style={styles.c3}>
                        <Text style={valueStyleFor(spend.valueStyle)}>{n(row.ppc_spend)}</Text>
                        <Text style={styles.deltaNeutral}>{spend.vsLastText}</Text>
                      </View>
                      <View style={styles.c4}>
                        <Text style={valueStyleFor(ppcSales.valueStyle)}>{n(row.ppc_sales)}</Text>
                        <Text style={styles.deltaNeutral}>{ppcSales.vsLastText}</Text>
                      </View>
                      <View style={styles.c5}>
                        <Text style={valueStyleFor(totalSales.valueStyle)}>{n(row.total_sales)}</Text>
                        <Text style={styles.deltaNeutral}>{totalSales.vsLastText}</Text>
                      </View>
                      <View style={styles.c6}>
                        <Text style={valueStyleFor(acosMeta.valueStyle)}>{pct(acos)}</Text>
                        <Text style={styles.deltaNeutral}>{acosMeta.vsLastText}</Text>
                      </View>
                      <View style={styles.c7}>
                        <Text style={valueStyleFor(tacosMeta.valueStyle)}>{pct(tacos)}</Text>
                        <Text style={styles.deltaNeutral}>{tacosMeta.vsLastText}</Text>
                      </View>
                      {section.platform === "amazon" ? (
                        <View style={styles.c8}>
                          <Text style={valueStyleFor(bsrMeta.valueStyle)}>{row.bsr ?? "-"}</Text>
                          <Text style={styles.deltaNeutral}>{bsrMeta.vsLastText}</Text>
                        </View>
                      ) : null}
                      <View style={styles.c9}>
                        <Text style={valueStyleFor(reviewsMeta.valueStyle)}>{row.review_count ?? "-"}</Text>
                        <Text style={styles.deltaNeutral}>{reviewsMeta.vsLastText}</Text>
                      </View>
                      <View style={styles.c10}>
                        <Text style={valueStyleFor(ratingMeta.valueStyle)}>{row.rating ?? "-"}</Text>
                        <Text style={styles.deltaNeutral}>{ratingMeta.vsLastText}</Text>
                      </View>
                      <View style={styles.c11}>
                        <Text style={styles.deltaNeutral}>{totalSales.vsLastText}</Text>
                      </View>
                    </View>
                  );
                })
              )}
            </View>
          );
        })}

        <View style={styles.footer} fixed>
          {footerLogoDataUrl ? (
            // eslint-disable-next-line jsx-a11y/alt-text
            <Image src={footerLogoDataUrl} style={styles.footerLogo} />
          ) : (
            <Text />
          )}
          <Text style={styles.footerText}>© aayat.co | hello@aayat.co | +44 7727 666043</Text>
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

export async function renderWeeklyPerformancePdfBuffer(data: Input): Promise<Uint8Array> {
  const footerLogoDataUrl = await getFooterLogoDataUrl();
  const instance = pdf(<WeeklyPerformancePdf data={data} footerLogoDataUrl={footerLogoDataUrl} />);
  const output = await instance.toBuffer();
  if (output instanceof Uint8Array) return output;

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

  throw new Error("Unexpected performance PDF output type.");
}
