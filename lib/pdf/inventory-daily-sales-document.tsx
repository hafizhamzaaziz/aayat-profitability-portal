import React from "react";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { Document, Image, Link, Page, StyleSheet, Text, View, pdf } from "@react-pdf/renderer";
import { formatUkDate } from "@/lib/utils/date";
import { PdfWatermark, AAYAT_WEBSITE, AAYAT_PLUM_500 } from "./brand";

type DailySalesPdfRow = {
  sale_date: string;
  product_name: string;
  sku: string;
  platform: string;
  warehouse: string;
  sold_units: number;
  returns_units: number;
  collected_units: number;
  excl_vat: number;
  incl_vat: number;
  notes: string;
};

type Input = {
  accountName: string;
  accountLogoUrl: string | null;
  from: string;
  to: string;
  rows: DailySalesPdfRow[];
  currency: string;
};

const styles = StyleSheet.create({
  page: { fontSize: 9, paddingTop: 24, paddingLeft: 24, paddingRight: 24, paddingBottom: 64, color: "#1f2937", fontFamily: "Helvetica" },
  topRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 10 },
  logo: { width: 56, height: 56, objectFit: "contain" as const },
  heading: { fontSize: 16, fontWeight: 700, maxWidth: "80%", color: "#401634" },
  sub: { color: "#6b7280", fontSize: 9, marginTop: 2 },
  tableHead: { flexDirection: "row", borderBottomWidth: 1, borderBottomColor: "#e5e7eb", backgroundColor: "#f8fafc", paddingVertical: 4, paddingHorizontal: 3, fontWeight: 700 },
  tr: { flexDirection: "row", borderBottomWidth: 1, borderBottomColor: "#f3f4f6", paddingVertical: 4, paddingHorizontal: 3 },
  cDate: { width: "10%" },
  cProduct: { width: "16%" },
  cSku: { width: "12%" },
  cPlatform: { width: "8%" },
  cWarehouse: { width: "10%" },
  cNum: { width: "7%", textAlign: "right" },
  cAmt: { width: "10%", textAlign: "right" },
  cNotes: { width: "13%" },
  footer: {
    position: "absolute",
    left: 24,
    right: 24,
    bottom: 12,
    borderTopWidth: 1,
    borderTopColor: "#e5e7eb",
    paddingTop: 6,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  footerText: { fontSize: 9, color: "#6b7280" },
  footerLink: { fontSize: 9, color: AAYAT_PLUM_500, textDecoration: "none", fontWeight: 700 },
  footerLogo: { width: 92, height: 18, objectFit: "contain" as const },
});

function m(currency: string, value: number) {
  return `${currency}${Number(value || 0).toFixed(2)}`;
}

function DailySalesPdf({ data, footerLogoDataUrl }: { data: Input; footerLogoDataUrl: string | null }) {
  const totals = data.rows.reduce(
    (acc, row) => {
      acc.sold += Number(row.sold_units || 0);
      acc.returns += Number(row.returns_units || 0);
      acc.collected += Number(row.collected_units || 0);
      acc.excl += Number(row.excl_vat || 0);
      acc.incl += Number(row.incl_vat || 0);
      return acc;
    },
    { sold: 0, returns: 0, collected: 0, excl: 0, incl: 0 }
  );
  return (
    <Document>
      <Page size="A4" orientation="landscape" style={styles.page}>
        <PdfWatermark />
        <View style={styles.topRow}>
          <View>
            <Text style={styles.heading}>{data.accountName} Daily Sales</Text>
            <Text style={styles.sub}>
              {formatUkDate(data.from)} to {formatUkDate(data.to)}
            </Text>
          </View>
          {data.accountLogoUrl ? (
            // eslint-disable-next-line jsx-a11y/alt-text
            <Image src={data.accountLogoUrl} style={styles.logo} />
          ) : null}
        </View>

        <View style={styles.tableHead}>
          <Text style={styles.cDate}>Date</Text>
          <Text style={styles.cProduct}>Product</Text>
          <Text style={styles.cSku}>SKU</Text>
          <Text style={styles.cPlatform}>Platform</Text>
          <Text style={styles.cWarehouse}>Warehouse</Text>
          <Text style={styles.cNum}>Sold</Text>
          <Text style={styles.cNum}>Returns</Text>
          <Text style={styles.cNum}>Collected</Text>
          <Text style={styles.cAmt}>Excl VAT</Text>
          <Text style={styles.cAmt}>Incl VAT</Text>
          <Text style={styles.cNotes}>Notes</Text>
        </View>
        {data.rows.map((row, idx) => (
          <View key={`${row.sale_date}-${row.sku}-${idx}`} style={styles.tr} wrap={false}>
            <Text style={styles.cDate}>{row.sale_date}</Text>
            <Text style={styles.cProduct}>{row.product_name}</Text>
            <Text style={styles.cSku}>{row.sku}</Text>
            <Text style={styles.cPlatform}>{row.platform}</Text>
            <Text style={styles.cWarehouse}>{row.warehouse}</Text>
            <Text style={styles.cNum}>{row.sold_units}</Text>
            <Text style={styles.cNum}>{row.returns_units}</Text>
            <Text style={styles.cNum}>{row.collected_units}</Text>
            <Text style={styles.cAmt}>{m(data.currency, row.excl_vat)}</Text>
            <Text style={styles.cAmt}>{m(data.currency, row.incl_vat)}</Text>
            <Text style={styles.cNotes}>{row.notes || "-"}</Text>
          </View>
        ))}
        <View style={{ ...styles.tr, borderBottomWidth: 0, backgroundColor: "#f8fafc" }}>
          <Text style={{ ...styles.cDate, fontWeight: 700 }}>TOTAL</Text>
          <Text style={styles.cProduct} />
          <Text style={styles.cSku} />
          <Text style={styles.cPlatform} />
          <Text style={styles.cWarehouse} />
          <Text style={{ ...styles.cNum, fontWeight: 700 }}>{totals.sold}</Text>
          <Text style={{ ...styles.cNum, fontWeight: 700 }}>{totals.returns}</Text>
          <Text style={{ ...styles.cNum, fontWeight: 700 }}>{totals.collected}</Text>
          <Text style={{ ...styles.cAmt, fontWeight: 700 }}>{m(data.currency, totals.excl)}</Text>
          <Text style={{ ...styles.cAmt, fontWeight: 700 }}>{m(data.currency, totals.incl)}</Text>
          <Text style={styles.cNotes} />
        </View>

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

export async function renderInventoryDailySalesPdfBuffer(data: Input): Promise<Uint8Array> {
  const footerLogoDataUrl = await getFooterLogoDataUrl();
  const instance = pdf(<DailySalesPdf data={data} footerLogoDataUrl={footerLogoDataUrl} />);
  const output = await instance.toBuffer();

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

  throw new Error("Unexpected daily sales PDF output type.");
}
