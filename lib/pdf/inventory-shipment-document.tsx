import React from "react";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { Document, Image, Page, StyleSheet, Text, View, pdf } from "@react-pdf/renderer";
import { formatUkDate } from "@/lib/utils/date";

type ShipmentPdfItem = {
  product_name: string;
  amazon_sku: string | null;
  temu_sku_id: string | null;
  suggested_units: number;
  planned_units: number;
  units_per_box: number;
  planned_boxes: number;
  pallets: number;
  lead_time_days: number | null;
};

type Input = {
  accountName: string;
  accountLogoUrl: string | null;
  title: string;
  planDate: string;
  planType: string;
  notes: string;
  orientation: "portrait" | "landscape";
  items: ShipmentPdfItem[];
};

const styles = StyleSheet.create({
  page: { fontSize: 10, paddingTop: 24, paddingLeft: 24, paddingRight: 24, paddingBottom: 64, color: "#1f2937", fontFamily: "Helvetica" },
  topRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 10 },
  logo: { width: 56, height: 56, objectFit: "contain" as const },
  heading: { fontSize: 16, fontWeight: 700, maxWidth: "80%" },
  sub: { color: "#6b7280", fontSize: 9, marginTop: 2 },
  section: { marginTop: 10, borderWidth: 1, borderColor: "#e5e7eb", borderRadius: 8, padding: 8 },
  tableHead: { flexDirection: "row", borderBottomWidth: 1, borderBottomColor: "#e5e7eb", backgroundColor: "#f8fafc", paddingVertical: 5, paddingHorizontal: 4, fontWeight: 700 },
  tr: { flexDirection: "row", borderBottomWidth: 1, borderBottomColor: "#f3f4f6", paddingVertical: 5, paddingHorizontal: 4 },
  c1: { width: "20%" },
  c2: { width: "11%" },
  c3: { width: "11%" },
  c4: { width: "10%", textAlign: "right" },
  c5: { width: "10%", textAlign: "right" },
  c6: { width: "10%", textAlign: "right" },
  c7: { width: "10%", textAlign: "right" },
  c8: { width: "10%", textAlign: "right" },
  c9: { width: "8%", textAlign: "right" },
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
  footerLogo: { width: 56, height: 56, objectFit: "contain" as const },
});

function InventoryShipmentPdf({ data, footerLogoDataUrl }: { data: Input; footerLogoDataUrl: string | null }) {
  const totalPallets = data.items.reduce((acc, item) => acc + Number(item.pallets || 0), 0);

  return (
    <Document>
      <Page size="A4" orientation={data.orientation} style={styles.page}>
        <View style={styles.topRow}>
          <View>
            <Text style={styles.heading}>{data.accountName} Shipment Plan</Text>
            <Text style={styles.sub}>{data.title}</Text>
            <Text style={styles.sub}>
              Date: {formatUkDate(data.planDate)} | Type: {data.planType.replace(/_/g, " ")}
            </Text>
          </View>
          {data.accountLogoUrl ? (
            // eslint-disable-next-line jsx-a11y/alt-text
            <Image src={data.accountLogoUrl} style={styles.logo} />
          ) : null}
        </View>

        <View style={styles.section}>
          <View style={styles.tableHead}>
            <Text style={styles.c1}>Product</Text>
            <Text style={styles.c2}>Amazon SKU</Text>
            <Text style={styles.c3}>Temu SKU ID</Text>
            <Text style={styles.c4}>Suggested</Text>
            <Text style={styles.c5}>Planned</Text>
            <Text style={styles.c6}>Units/Box</Text>
            <Text style={styles.c7}>Boxes</Text>
            <Text style={styles.c8}>Pallets</Text>
            <Text style={styles.c9}>Lead</Text>
          </View>
          {data.items.length === 0 ? (
            <View style={styles.tr}>
              <Text>No line items available.</Text>
            </View>
          ) : (
            data.items.map((item, idx) => (
              <View key={`${item.product_name}-${idx}`} style={styles.tr}>
                <Text style={styles.c1}>{item.product_name}</Text>
                <Text style={styles.c2}>{item.amazon_sku || "-"}</Text>
                <Text style={styles.c3}>{item.temu_sku_id || "-"}</Text>
                <Text style={styles.c4}>{Number(item.suggested_units || 0).toFixed(0)}</Text>
                <Text style={styles.c5}>{Number(item.planned_units || 0).toFixed(0)}</Text>
                <Text style={styles.c6}>{Number(item.units_per_box || 0).toFixed(0)}</Text>
                <Text style={styles.c7}>{Number(item.planned_boxes || 0).toFixed(0)}</Text>
                <Text style={styles.c8}>{Number(item.pallets || 0).toFixed(2)}</Text>
                <Text style={styles.c9}>{item.lead_time_days ?? "-"}d</Text>
              </View>
            ))
          )}
        </View>

        <View style={styles.section}>
          <Text style={{ marginBottom: 4, fontWeight: 700 }}>Summary</Text>
          <Text>Total SKUs: {data.items.length}</Text>
          <Text>Total Pallets: {totalPallets.toFixed(2)}</Text>
          <Text>Notes: {data.notes || "-"}</Text>
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

export async function renderInventoryShipmentPdfBuffer(data: Input): Promise<Uint8Array> {
  const footerLogoDataUrl = await getFooterLogoDataUrl();
  const instance = pdf(<InventoryShipmentPdf data={data} footerLogoDataUrl={footerLogoDataUrl} />);
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

  throw new Error("Unexpected shipment PDF output type.");
}
