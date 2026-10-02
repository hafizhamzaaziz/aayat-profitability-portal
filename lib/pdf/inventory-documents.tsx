import React from "react";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { Document, Image, Link, Page, StyleSheet, Text, View, pdf } from "@react-pdf/renderer";
import { formatUkDate } from "@/lib/utils/date";
import { PdfWatermark, AAYAT_WEBSITE, AAYAT_PLUM_500 } from "./brand";

/**
 * Purchase order (sent to the manufacturer) and FBA packing list (sent to the
 * 3PL) PDFs. Both share the same brand chrome.
 */

const styles = StyleSheet.create({
  page: { fontSize: 9.5, paddingTop: 24, paddingLeft: 28, paddingRight: 28, paddingBottom: 64, color: "#1f2937", fontFamily: "Helvetica" },
  topRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 12 },
  logo: { width: 56, height: 56, objectFit: "contain" as const },
  heading: { fontSize: 18, fontWeight: 700, color: "#401634" },
  docNo: { fontSize: 12, fontWeight: 700, marginTop: 2 },
  sub: { color: "#6b7280", fontSize: 9, marginTop: 2 },
  metaRow: { flexDirection: "row", gap: 10, marginBottom: 10 },
  metaBox: { flex: 1, borderWidth: 1, borderColor: "#e5e7eb", borderRadius: 6, padding: 8 },
  metaLabel: { fontSize: 8, color: "#6b7280", textTransform: "uppercase" as const, marginBottom: 3 },
  metaValue: { fontSize: 10, fontWeight: 700 },
  metaLine: { fontSize: 9, marginTop: 1 },
  section: { borderWidth: 1, borderColor: "#e5e7eb", borderRadius: 6, overflow: "hidden" as const },
  tableHead: { flexDirection: "row", borderBottomWidth: 1, borderBottomColor: "#e5e7eb", backgroundColor: "#f8fafc", paddingVertical: 5, paddingHorizontal: 6, fontWeight: 700 },
  tr: { flexDirection: "row", borderBottomWidth: 1, borderBottomColor: "#f3f4f6", paddingVertical: 5, paddingHorizontal: 6 },
  trTotal: { flexDirection: "row", backgroundColor: "#f8fafc", paddingVertical: 6, paddingHorizontal: 6, fontWeight: 700 },
  right: { textAlign: "right" as const },
  small: { fontSize: 8, color: "#6b7280" },
  notes: { marginTop: 10, borderWidth: 1, borderColor: "#e5e7eb", borderRadius: 6, padding: 8 },
  signRow: { flexDirection: "row", gap: 24, marginTop: 28 },
  signBox: { flex: 1, borderTopWidth: 1, borderTopColor: "#9ca3af", paddingTop: 4, fontSize: 8, color: "#6b7280" },
  footer: { position: "absolute", left: 28, right: 28, bottom: 12, borderTopWidth: 1, borderTopColor: "#e5e7eb", paddingTop: 6, flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  footerText: { fontSize: 9, color: "#6b7280" },
  footerLink: { fontSize: 9, color: AAYAT_PLUM_500, textDecoration: "none", fontWeight: 700 },
  footerLogo: { width: 92, height: 18, objectFit: "contain" as const },
});

function Footer({ footerLogoDataUrl }: { footerLogoDataUrl: string | null }) {
  return (
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
        <Text style={styles.footerText} render={({ pageNumber, totalPages }) => `  |  page ${pageNumber} / ${totalPages}`} />
      </View>
    </View>
  );
}

function money(currency: string, v: number, dp = 2) {
  const sym = currency === "GBP" || currency === "£" ? "£" : currency === "USD" ? "$" : currency === "EUR" ? "€" : `${currency} `;
  return `${sym}${Number(v || 0).toLocaleString("en-GB", { minimumFractionDigits: dp, maximumFractionDigits: dp })}`;
}

// ---------------------------------------------------------------------------
// Purchase order
// ---------------------------------------------------------------------------

export type PurchaseOrderPdfInput = {
  accountName: string;
  accountLogoUrl: string | null;
  poNumber: string;
  status: string;
  orderDate: string | null;
  expectedReadyDate: string | null;
  expectedArrivalDate: string | null;
  currency: string;
  supplier: { name: string; contactName: string | null; email: string | null; phone: string | null; country: string | null; paymentTerms: string | null } | null;
  shipTo: string | null;
  trackingRef: string | null;
  notes: string | null;
  freightCost: number;
  dutyCost: number;
  otherCost: number;
  items: Array<{ productName: string; sku: string; asin: string | null; orderedUnits: number; receivedUnits: number; unitCost: number; unitsPerBox: number | null; notes: string | null }>;
};

const po = StyleSheet.create({
  cProduct: { width: "34%" },
  cSku: { width: "16%" },
  cCtn: { width: "10%", textAlign: "right" as const },
  cQty: { width: "12%", textAlign: "right" as const },
  cCost: { width: "13%", textAlign: "right" as const },
  cTotal: { width: "15%", textAlign: "right" as const },
});

function PurchaseOrderPdf({ data, footerLogoDataUrl }: { data: PurchaseOrderPdfInput; footerLogoDataUrl: string | null }) {
  const goods = data.items.reduce((a, i) => a + i.orderedUnits * i.unitCost, 0);
  const units = data.items.reduce((a, i) => a + i.orderedUnits, 0);
  const cartons = data.items.reduce((a, i) => a + (i.unitsPerBox ? Math.ceil(i.orderedUnits / i.unitsPerBox) : 0), 0);
  const extras = data.freightCost + data.dutyCost + data.otherCost;
  return (
    <Document title={`${data.poNumber} – Purchase order`}>
      <Page size="A4" style={styles.page}>
        <PdfWatermark />
        <View style={styles.topRow}>
          <View>
            <Text style={styles.heading}>Purchase order</Text>
            <Text style={styles.docNo}>{data.poNumber}</Text>
            <Text style={styles.sub}>
              {data.accountName} · {data.orderDate ? `Order date ${formatUkDate(data.orderDate)}` : "Draft"} · Status {data.status.replace(/_/g, " ")}
            </Text>
          </View>
          {data.accountLogoUrl ? (
            // eslint-disable-next-line jsx-a11y/alt-text
            <Image src={data.accountLogoUrl} style={styles.logo} />
          ) : null}
        </View>

        <View style={styles.metaRow}>
          <View style={styles.metaBox}>
            <Text style={styles.metaLabel}>Supplier</Text>
            <Text style={styles.metaValue}>{data.supplier?.name || "—"}</Text>
            {data.supplier?.contactName ? <Text style={styles.metaLine}>{data.supplier.contactName}</Text> : null}
            {data.supplier?.email ? <Text style={styles.metaLine}>{data.supplier.email}</Text> : null}
            {data.supplier?.phone ? <Text style={styles.metaLine}>{data.supplier.phone}</Text> : null}
            {data.supplier?.country ? <Text style={styles.metaLine}>{data.supplier.country}</Text> : null}
          </View>
          <View style={styles.metaBox}>
            <Text style={styles.metaLabel}>Ship to</Text>
            <Text style={styles.metaValue}>{data.shipTo || "—"}</Text>
            <Text style={styles.metaLine}>Buyer: {data.accountName}</Text>
            {data.trackingRef ? <Text style={styles.metaLine}>Ref: {data.trackingRef}</Text> : null}
          </View>
          <View style={styles.metaBox}>
            <Text style={styles.metaLabel}>Dates & terms</Text>
            <Text style={styles.metaLine}>Goods ready: {data.expectedReadyDate ? formatUkDate(data.expectedReadyDate) : "—"}</Text>
            <Text style={styles.metaLine}>Arrival at warehouse: {data.expectedArrivalDate ? formatUkDate(data.expectedArrivalDate) : "—"}</Text>
            <Text style={styles.metaLine}>Payment: {data.supplier?.paymentTerms || "—"}</Text>
            <Text style={styles.metaLine}>Currency: {data.currency}</Text>
          </View>
        </View>

        <View style={styles.section}>
          <View style={styles.tableHead}>
            <Text style={po.cProduct}>Product</Text>
            <Text style={po.cSku}>SKU</Text>
            <Text style={po.cCtn}>Cartons</Text>
            <Text style={po.cQty}>Units</Text>
            <Text style={po.cCost}>Unit price</Text>
            <Text style={po.cTotal}>Line total</Text>
          </View>
          {data.items.map((it, idx) => (
            <View key={`${it.sku}-${idx}`} style={styles.tr} wrap={false}>
              <View style={po.cProduct}>
                <Text>{it.productName}</Text>
                {it.asin ? <Text style={styles.small}>ASIN {it.asin}</Text> : null}
                {it.notes ? <Text style={styles.small}>{it.notes}</Text> : null}
              </View>
              <Text style={po.cSku}>{it.sku}</Text>
              <Text style={po.cCtn}>{it.unitsPerBox ? `${Math.ceil(it.orderedUnits / it.unitsPerBox)} × ${it.unitsPerBox}` : "—"}</Text>
              <Text style={po.cQty}>{it.orderedUnits.toLocaleString("en-GB")}</Text>
              <Text style={po.cCost}>{money(data.currency, it.unitCost, 4)}</Text>
              <Text style={po.cTotal}>{money(data.currency, it.orderedUnits * it.unitCost)}</Text>
            </View>
          ))}
          <View style={styles.trTotal} wrap={false}>
            <Text style={po.cProduct}>Total</Text>
            <Text style={po.cSku}>{data.items.length} lines</Text>
            <Text style={po.cCtn}>{cartons || "—"}</Text>
            <Text style={po.cQty}>{units.toLocaleString("en-GB")}</Text>
            <Text style={po.cCost} />
            <Text style={po.cTotal}>{money(data.currency, goods)}</Text>
          </View>
        </View>

        {extras > 0 ? (
          <View style={[styles.notes, { flexDirection: "row", justifyContent: "flex-end", gap: 18 }]} wrap={false}>
            <Text>Goods {money(data.currency, goods)}</Text>
            {data.freightCost ? <Text>Freight {money(data.currency, data.freightCost)}</Text> : null}
            {data.dutyCost ? <Text>Duty {money(data.currency, data.dutyCost)}</Text> : null}
            {data.otherCost ? <Text>Other {money(data.currency, data.otherCost)}</Text> : null}
            <Text style={{ fontWeight: 700 }}>Landed {money(data.currency, goods + extras)}</Text>
          </View>
        ) : null}

        <View style={styles.notes} wrap={false}>
          <Text style={{ fontWeight: 700, marginBottom: 3 }}>Notes & instructions</Text>
          <Text>{data.notes || "Please confirm receipt of this order, the unit prices and the goods-ready date. Label every carton with the SKU, quantity and carton number (e.g. 1 of 24)."}</Text>
        </View>

        <View style={styles.signRow} wrap={false}>
          <Text style={styles.signBox}>Authorised by {data.accountName}</Text>
          <Text style={styles.signBox}>Accepted by supplier (name, date)</Text>
        </View>

        <Footer footerLogoDataUrl={footerLogoDataUrl} />
      </Page>
    </Document>
  );
}

// ---------------------------------------------------------------------------
// FBA packing list
// ---------------------------------------------------------------------------

export type FbaPackingListPdfInput = {
  accountName: string;
  accountLogoUrl: string | null;
  shipmentName: string;
  amazonShipmentId: string | null;
  status: string;
  sourceWarehouse: string | null;
  shipDate: string | null;
  expectedArrivalDate: string | null;
  carrier: string | null;
  trackingRef: string | null;
  poNumber: string | null;
  notes: string | null;
  items: Array<{ productName: string; sku: string; asin: string | null; fnsku: string | null; units: number; unitsPerBox: number | null; boxes: number | null; pallets: number | null; notes: string | null }>;
};

const pl = StyleSheet.create({
  cProduct: { width: "32%" },
  cSku: { width: "16%" },
  cAsin: { width: "14%" },
  cPer: { width: "9%", textAlign: "right" as const },
  cBoxes: { width: "9%", textAlign: "right" as const },
  cUnits: { width: "10%", textAlign: "right" as const },
  cPallets: { width: "10%", textAlign: "right" as const },
});

function FbaPackingListPdf({ data, footerLogoDataUrl }: { data: FbaPackingListPdfInput; footerLogoDataUrl: string | null }) {
  const units = data.items.reduce((a, i) => a + i.units, 0);
  const boxes = data.items.reduce((a, i) => a + (i.boxes ?? (i.unitsPerBox ? Math.ceil(i.units / i.unitsPerBox) : 0)), 0);
  const pallets = data.items.reduce((a, i) => a + (i.pallets || 0), 0);
  return (
    <Document title={`${data.shipmentName} – FBA packing list`}>
      <Page size="A4" orientation={data.items.length > 14 ? "landscape" : "portrait"} style={styles.page}>
        <PdfWatermark />
        <View style={styles.topRow}>
          <View>
            <Text style={styles.heading}>FBA packing list</Text>
            <Text style={styles.docNo}>{data.shipmentName}</Text>
            <Text style={styles.sub}>
              {data.accountName}
              {data.amazonShipmentId ? ` · Amazon shipment ${data.amazonShipmentId}` : ""} · Status {data.status}
            </Text>
          </View>
          {data.accountLogoUrl ? (
            // eslint-disable-next-line jsx-a11y/alt-text
            <Image src={data.accountLogoUrl} style={styles.logo} />
          ) : null}
        </View>

        <View style={styles.metaRow}>
          <View style={styles.metaBox}>
            <Text style={styles.metaLabel}>From</Text>
            <Text style={styles.metaValue}>{data.sourceWarehouse || "—"}</Text>
            {data.poNumber ? <Text style={styles.metaLine}>Stock from {data.poNumber}</Text> : null}
          </View>
          <View style={styles.metaBox}>
            <Text style={styles.metaLabel}>To</Text>
            <Text style={styles.metaValue}>Amazon FBA</Text>
            <Text style={styles.metaLine}>Use the FC address and labels from Seller Central for shipment {data.amazonShipmentId || "(ID pending)"}.</Text>
          </View>
          <View style={styles.metaBox}>
            <Text style={styles.metaLabel}>Transport</Text>
            <Text style={styles.metaLine}>Ship date: {data.shipDate ? formatUkDate(data.shipDate) : "—"}</Text>
            <Text style={styles.metaLine}>Expected at Amazon: {data.expectedArrivalDate ? formatUkDate(data.expectedArrivalDate) : "—"}</Text>
            <Text style={styles.metaLine}>Carrier: {data.carrier || "—"}</Text>
            <Text style={styles.metaLine}>Tracking: {data.trackingRef || "—"}</Text>
          </View>
        </View>

        <View style={styles.section}>
          <View style={styles.tableHead}>
            <Text style={pl.cProduct}>Product</Text>
            <Text style={pl.cSku}>Seller SKU</Text>
            <Text style={pl.cAsin}>ASIN / FNSKU</Text>
            <Text style={pl.cPer}>Per ctn</Text>
            <Text style={pl.cBoxes}>Cartons</Text>
            <Text style={pl.cUnits}>Units</Text>
            <Text style={pl.cPallets}>Pallets</Text>
          </View>
          {data.items.map((it, idx) => (
            <View key={`${it.sku}-${idx}`} style={styles.tr} wrap={false}>
              <View style={pl.cProduct}>
                <Text>{it.productName}</Text>
                {it.notes ? <Text style={styles.small}>{it.notes}</Text> : null}
              </View>
              <Text style={pl.cSku}>{it.sku}</Text>
              <View style={pl.cAsin}>
                <Text>{it.asin || "—"}</Text>
                {it.fnsku ? <Text style={styles.small}>{it.fnsku}</Text> : null}
              </View>
              <Text style={pl.cPer}>{it.unitsPerBox || "—"}</Text>
              <Text style={pl.cBoxes}>{it.boxes ?? (it.unitsPerBox ? Math.ceil(it.units / it.unitsPerBox) : "—")}</Text>
              <Text style={pl.cUnits}>{it.units.toLocaleString("en-GB")}</Text>
              <Text style={pl.cPallets}>{it.pallets == null ? "—" : it.pallets.toFixed(2)}</Text>
            </View>
          ))}
          <View style={styles.trTotal} wrap={false}>
            <Text style={pl.cProduct}>Total</Text>
            <Text style={pl.cSku}>{data.items.length} SKUs</Text>
            <Text style={pl.cAsin} />
            <Text style={pl.cPer} />
            <Text style={pl.cBoxes}>{boxes || "—"}</Text>
            <Text style={pl.cUnits}>{units.toLocaleString("en-GB")}</Text>
            <Text style={pl.cPallets}>{pallets ? pallets.toFixed(2) : "—"}</Text>
          </View>
        </View>

        <View style={styles.notes} wrap={false}>
          <Text style={{ fontWeight: 700, marginBottom: 3 }}>Instructions for the warehouse</Text>
          <Text>{data.notes || "Apply the Amazon FBA box labels in carton order, do not mix SKUs within a carton unless the label says so, and confirm the final carton count and weights back to us before the carrier collects."}</Text>
        </View>

        <View style={styles.signRow} wrap={false}>
          <Text style={styles.signBox}>Packed by (name, date)</Text>
          <Text style={styles.signBox}>Collected by carrier (name, date)</Text>
        </View>

        <Footer footerLogoDataUrl={footerLogoDataUrl} />
      </Page>
    </Document>
  );
}

// ---------------------------------------------------------------------------
// Rendering helpers
// ---------------------------------------------------------------------------

async function getFooterLogoDataUrl() {
  try {
    const bytes = await readFile(path.join(process.cwd(), "public", "aayat-logo.png"));
    return `data:image/png;base64,${bytes.toString("base64")}`;
  } catch {
    return null;
  }
}

async function toBytes(instance: ReturnType<typeof pdf>): Promise<Uint8Array> {
  const output = await instance.toBuffer();
  if (output instanceof Uint8Array) return output;
  const web = output as unknown as { getReader?: () => ReadableStreamDefaultReader<Uint8Array> };
  const chunks: Uint8Array[] = [];
  if (typeof web.getReader === "function") {
    const reader = web.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) chunks.push(value);
    }
  } else {
    const node = output as unknown as { on?: (event: string, cb: (...args: unknown[]) => void) => void };
    if (typeof node.on !== "function") throw new Error("Unexpected PDF output type.");
    await new Promise<void>((resolve, reject) => {
      node.on!("data", (chunk: unknown) => chunks.push(chunk instanceof Uint8Array ? chunk : new Uint8Array(Buffer.from(String(chunk)))));
      node.on!("end", () => resolve());
      node.on!("error", (err: unknown) => reject(err));
    });
  }
  const merged = new Uint8Array(chunks.reduce((a, c) => a + c.length, 0));
  let offset = 0;
  for (const c of chunks) {
    merged.set(c, offset);
    offset += c.length;
  }
  return merged;
}

export async function renderPurchaseOrderPdf(data: PurchaseOrderPdfInput): Promise<Uint8Array> {
  const footerLogoDataUrl = await getFooterLogoDataUrl();
  return toBytes(pdf(<PurchaseOrderPdf data={data} footerLogoDataUrl={footerLogoDataUrl} />));
}

export async function renderFbaPackingListPdf(data: FbaPackingListPdfInput): Promise<Uint8Array> {
  const footerLogoDataUrl = await getFooterLogoDataUrl();
  return toBytes(pdf(<FbaPackingListPdf data={data} footerLogoDataUrl={footerLogoDataUrl} />));
}
