import React from "react";
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
  expenses: ExpenseLine[];
  performance: PerformanceLine[];
  notes: string;
};

const styles = StyleSheet.create({
  page: { fontSize: 11, padding: 28, color: "#1f2937", fontFamily: "Helvetica" },
  topRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 16 },
  logo: { width: 90, height: 42, objectFit: "contain" },
  heading: { fontSize: 18, fontWeight: 700 },
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
});

function m(currency: string, value: number) {
  return `${currency}${Number(value || 0).toFixed(2)}`;
}

function ReportPdf({ data }: { data: Input }) {
  const perf = data.performance.slice(0, 8);

  return (
    <Document>
      <Page size="A4" style={styles.page}>
        <View style={styles.topRow}>
          <View>
            <Text style={styles.heading}>Aayat Profitability Report</Text>
            <Text style={styles.sub}>{data.accountName}</Text>
            <Text style={styles.sub}>
              {data.platform.toUpperCase()} | {data.periodStart} to {data.periodEnd}
            </Text>
          </View>
          {data.accountLogoUrl ? (
            // eslint-disable-next-line jsx-a11y/alt-text
            <Image src={data.accountLogoUrl} style={styles.logo} />
          ) : null}
        </View>

        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Financial Summary</Text>
          <View style={styles.row}>
            <Text style={styles.label}>Gross Sales</Text>
            <Text style={styles.value}>{m(data.currency, data.report.gross_sales)}</Text>
          </View>
          <View style={styles.row}>
            <Text style={styles.label}>Total COGS</Text>
            <Text style={styles.value}>{m(data.currency, data.report.total_cogs)}</Text>
          </View>
          <View style={styles.row}>
            <Text style={styles.label}>Total Fees</Text>
            <Text style={styles.value}>{m(data.currency, data.report.total_fees)}</Text>
          </View>
          <View style={styles.row}>
            <Text style={styles.label}>Output VAT</Text>
            <Text style={styles.value}>{m(data.currency, data.report.output_vat)}</Text>
          </View>
          <View style={styles.row}>
            <Text style={styles.label}>Input VAT</Text>
            <Text style={styles.value}>{m(data.currency, data.report.input_vat)}</Text>
          </View>
          <View style={{ ...styles.row, borderBottomWidth: 0 }}>
            <Text style={{ ...styles.label, fontWeight: 700 }}>Net Profit</Text>
            <Text style={{ ...styles.value, fontSize: 12 }}>{m(data.currency, data.report.net_profit)}</Text>
          </View>
        </View>

        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Manual Notes</Text>
          <Text style={styles.notes}>{data.notes?.trim() ? data.notes.trim() : "No manual notes provided."}</Text>
        </View>

        <View style={styles.section}>
          <Text style={styles.sectionTitle}>External Expenses Snapshot</Text>
          {data.expenses.length === 0 ? (
            <Text style={styles.sub}>No manual expenses recorded.</Text>
          ) : (
            data.expenses.slice(0, 10).map((e, idx) => (
              <View key={`${e.description}-${idx}`} style={styles.row}>
                <Text style={styles.label}>{e.description || "Expense"}</Text>
                <Text style={styles.value}>
                  {m(data.currency, e.amount)}
                  {e.includes_vat ? " (inc VAT)" : ""}
                </Text>
              </View>
            ))
          )}
        </View>

        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Performance Metrics Snapshot</Text>
          {perf.length === 0 ? (
            <Text style={styles.sub}>No performance metrics available.</Text>
          ) : (
            <>
              <View style={styles.tableHead}>
                <Text style={styles.c1}>Date</Text>
                <Text style={styles.c2}>Product</Text>
                <Text style={styles.c3}>BSR</Text>
                <Text style={styles.c4}>Reviews</Text>
                <Text style={styles.c5}>Rating</Text>
              </View>
              {perf.map((p, idx) => (
                <View key={`${p.product_name}-${idx}`} style={styles.tr}>
                  <Text style={styles.c1}>{p.recorded_date}</Text>
                  <Text style={styles.c2}>{p.product_name}</Text>
                  <Text style={styles.c3}>{p.bsr ?? "-"}</Text>
                  <Text style={styles.c4}>{p.review_count ?? "-"}</Text>
                  <Text style={styles.c5}>{p.rating ?? "-"}</Text>
                </View>
              ))}
            </>
          )}
        </View>
      </Page>
    </Document>
  );
}

export async function renderReportPdfBuffer(data: Input): Promise<Uint8Array> {
  const instance = pdf(<ReportPdf data={data} />);
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
