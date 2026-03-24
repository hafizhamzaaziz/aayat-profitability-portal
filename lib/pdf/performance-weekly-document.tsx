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

type Input = {
  accountName: string;
  accountLogoUrl: string | null;
  weekStart: string;
  weekEnd: string;
  previousWeekStart: string;
  previousWeekEnd: string;
  rows: Metric[];
  previousRows: Metric[];
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
  deltaGood: { fontSize: 7, color: "#15803d" },
  deltaBad: { fontSize: 7, color: "#dc2626" },
  deltaNeutral: { fontSize: 7, color: "#64748b" },
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

function deltaText(
  current: number | null,
  previous: number | null,
  mode: "higher_better" | "lower_better" | "neutral",
  decimals = 2
) {
  if (current == null || previous == null) {
    return { text: "vs last: -", style: "neutral" as const };
  }
  const diff = current - previous;
  const sign = diff > 0 ? "+" : "";
  const text = `vs last: ${sign}${diff.toFixed(decimals)}`;
  if (diff === 0 || mode === "neutral") return { text, style: "neutral" as const };
  if (mode === "higher_better") return { text, style: diff > 0 ? ("good" as const) : ("bad" as const) };
  return { text, style: diff < 0 ? ("good" as const) : ("bad" as const) };
}

function deltaStyleFor(status: "good" | "bad" | "neutral") {
  if (status === "good") return styles.deltaGood;
  if (status === "bad") return styles.deltaBad;
  return styles.deltaNeutral;
}

function WeeklyPerformancePdf({ data, footerLogoDataUrl }: { data: Input; footerLogoDataUrl: string | null }) {
  const prevByKey = new Map<string, Metric>();
  for (const row of data.previousRows) {
    prevByKey.set(`${row.product_name.toLowerCase()}|${row.asin || ""}`, row);
  }

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

        <View style={styles.tableHead}>
          <Text style={styles.c1}>Product</Text>
          <Text style={styles.c2}>ASIN</Text>
          <Text style={styles.c3}>PPC Spend</Text>
          <Text style={styles.c4}>PPC Sales</Text>
          <Text style={styles.c5}>Total Sales</Text>
          <Text style={styles.c6}>ACOS</Text>
          <Text style={styles.c7}>TACOS</Text>
          <Text style={styles.c8}>BSR</Text>
          <Text style={styles.c9}>Reviews</Text>
          <Text style={styles.c10}>Rating</Text>
          <Text style={styles.c11}>Week-over-week</Text>
        </View>

        {data.rows.length === 0 ? (
          <View style={styles.tr}>
            <Text>No rows for selected week.</Text>
          </View>
        ) : (
          data.rows.map((row, idx) => {
            const acos = row.ppc_spend && row.ppc_sales ? (row.ppc_spend / row.ppc_sales) * 100 : null;
            const tacos = row.ppc_spend && row.total_sales ? (row.ppc_spend / row.total_sales) * 100 : null;
            const prev = prevByKey.get(`${row.product_name.toLowerCase()}|${row.asin || ""}`);
            const prevAcos = prev?.ppc_spend && prev?.ppc_sales ? (prev.ppc_spend / prev.ppc_sales) * 100 : null;
            const prevTacos = prev?.ppc_spend && prev?.total_sales ? (prev.ppc_spend / prev.total_sales) * 100 : null;
            const spendDelta = deltaText(row.ppc_spend, prev?.ppc_spend ?? null, "neutral");
            const ppcSalesDelta = deltaText(row.ppc_sales, prev?.ppc_sales ?? null, "higher_better");
            const totalSalesDelta = deltaText(row.total_sales, prev?.total_sales ?? null, "higher_better");
            const acosDelta = deltaText(acos, prevAcos, "lower_better");
            const tacosDelta = deltaText(tacos, prevTacos, "lower_better");
            const bsrDelta = deltaText(row.bsr, prev?.bsr ?? null, "lower_better", 0);
            const reviewsDelta = deltaText(row.review_count, prev?.review_count ?? null, "higher_better", 0);
            const ratingDelta = deltaText(row.rating, prev?.rating ?? null, "higher_better");

            return (
              <View key={`${row.product_name}-${idx}`} style={styles.tr}>
                <Text style={styles.c1}>{row.product_name}</Text>
                <Text style={styles.c2}>
                  {row.asin ? (
                    <Link src={`https://www.amazon.co.uk/dp/${row.asin}`} style={styles.asinLink}>
                      {row.asin}
                    </Link>
                  ) : (
                    "-"
                  )}
                </Text>
                <View style={styles.c3}>
                  <Text>{n(row.ppc_spend)}</Text>
                  <Text style={deltaStyleFor(spendDelta.style)}>{spendDelta.text}</Text>
                </View>
                <View style={styles.c4}>
                  <Text>{n(row.ppc_sales)}</Text>
                  <Text style={deltaStyleFor(ppcSalesDelta.style)}>{ppcSalesDelta.text}</Text>
                </View>
                <View style={styles.c5}>
                  <Text>{n(row.total_sales)}</Text>
                  <Text style={deltaStyleFor(totalSalesDelta.style)}>{totalSalesDelta.text}</Text>
                </View>
                <View style={styles.c6}>
                  <Text>{pct(acos)}</Text>
                  <Text style={deltaStyleFor(acosDelta.style)}>{acosDelta.text}</Text>
                </View>
                <View style={styles.c7}>
                  <Text>{pct(tacos)}</Text>
                  <Text style={deltaStyleFor(tacosDelta.style)}>{tacosDelta.text}</Text>
                </View>
                <View style={styles.c8}>
                  <Text>{row.bsr ?? "-"}</Text>
                  <Text style={deltaStyleFor(bsrDelta.style)}>{bsrDelta.text}</Text>
                </View>
                <View style={styles.c9}>
                  <Text>{row.review_count ?? "-"}</Text>
                  <Text style={deltaStyleFor(reviewsDelta.style)}>{reviewsDelta.text}</Text>
                </View>
                <View style={styles.c10}>
                  <Text>{row.rating ?? "-"}</Text>
                  <Text style={deltaStyleFor(ratingDelta.style)}>{ratingDelta.text}</Text>
                </View>
                <View style={styles.c11}>
                  <Text style={deltaStyleFor(totalSalesDelta.style)}>
                    Sales {totalSalesDelta.text.replace("vs last: ", "")}
                  </Text>
                  <Text style={deltaStyleFor(acosDelta.style)}>
                    ACOS {acosDelta.text.replace("vs last: ", "")}
                  </Text>
                </View>
              </View>
            );
          })
        )}

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
