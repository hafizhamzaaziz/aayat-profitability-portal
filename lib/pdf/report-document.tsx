import React from "react";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { Document, Image, Page, StyleSheet, Text, View, pdf } from "@react-pdf/renderer";

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
};

type Input = {
  accountName: string;
  accountLogoUrl: string | null;
  currency: string;
  platform: string;
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
  notes: string;
};

const styles = StyleSheet.create({
  page: { fontSize: 11, paddingTop: 28, paddingLeft: 28, paddingRight: 28, paddingBottom: 72, color: "#1f2937", fontFamily: "Helvetica" },
  topRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 16 },
  logo: { width: 90, height: 42, objectFit: "contain" as const },
  heading: { fontSize: 18, fontWeight: 700, maxWidth: "78%" },
  sub: { color: "#6b7280", fontSize: 10, marginTop: 2 },
  section: { marginTop: 14, borderWidth: 1, borderColor: "#e5e7eb", borderRadius: 8, padding: 10 },
  sectionTitle: { fontSize: 12, fontWeight: 700, marginBottom: 8 },
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
  footerLogo: { width: 56, height: 56, objectFit: "contain" as const },
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
  return (
    <Document>
      <Page size="A4" style={styles.page}>
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
          <>
            <View style={styles.section}>
              <Text style={styles.sectionTitle}>
                {data.breakdown.platform === "amazon" ? "Amazon Report Summary" : "Temu Report Summary"}
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

            <View style={styles.section}>
              <Text style={styles.sectionTitle}>Profit & Loss (excl. VAT)</Text>
              <MetricRow currency={data.currency} label="Settlement (excl. VAT)" value={data.breakdown.pnl.settlementNet} />
              <MetricRow currency={data.currency} label="Your Purchase Cost (excl. VAT)" value={-Math.abs(data.breakdown.pnl.purchaseCost)} />
              <View style={{ ...styles.row, borderBottomWidth: 0 }}>
                <Text style={{ ...styles.label, fontWeight: 700 }}>Total Net Profit</Text>
                <Text style={{ ...styles.value, fontWeight: 700, color: valueColor(data.breakdown.pnl.netProfit) }}>
                  {m(data.currency, data.breakdown.pnl.netProfit)}
                </Text>
              </View>
            </View>

            <View style={styles.section}>
              <Text style={styles.sectionTitle}>VAT Summary</Text>
              <MetricRow currency={data.currency} label="VAT on Sales (Output)" value={data.breakdown.vat.outputVat} />
              <MetricRow currency={data.currency} label="VAT on Fees/Inputs (Input)" value={-Math.abs(data.breakdown.vat.inputVatFees)} />
              <MetricRow currency={data.currency} label="VAT on Purchases (Input)" value={-Math.abs(data.breakdown.vat.inputVatPurchases)} />
              <View style={{ ...styles.row, borderBottomWidth: 0 }}>
                <Text style={{ ...styles.label, fontWeight: 700 }}>Final VAT to Pay / Reclaim</Text>
                <Text style={{ ...styles.value, fontWeight: 700, color: valueColor(data.breakdown.vat.finalVat) }}>
                  {m(data.currency, data.breakdown.vat.finalVat)}
                </Text>
              </View>
            </View>
          </>
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

        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Manual Notes</Text>
          <Text style={styles.notes}>{data.notes?.trim() ? data.notes.trim() : "No manual notes provided."}</Text>
        </View>

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
