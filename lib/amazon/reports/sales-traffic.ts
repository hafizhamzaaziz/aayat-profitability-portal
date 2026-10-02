import { gunzipSync } from "node:zlib";
import { loadSpApiClient } from "@/lib/amazon/credentials";

export type SalesTrafficAsinRow = {
  parentAsin: string;
  childAsin: string;
  sku: string;
  units: number;
  orders: number;
  refunds: number;
  sales: number;
};

export type SalesTrafficDay = {
  date: string;
  units: number;
  orders: number;
  refunds: number;
  sales: number;
};

export type SalesTrafficReport = {
  from: string;
  to: string;
  byAsin: SalesTrafficAsinRow[];
  byDate: SalesTrafficDay[];
};

type Money = { amount?: number; currencyCode?: string };

function money(value: Money | undefined) {
  return Number(value?.amount || 0);
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function endIso(to: string) {
  const end = new Date(`${to}T23:59:59Z`);
  const latest = new Date(Date.now() - 3 * 60 * 1000);
  return (end.getTime() > latest.getTime() ? latest : end).toISOString();
}

/**
 * Amazon's Detail Page Sales and Traffic report.
 * PARENT matches Seller Central "by parent item". SKU includes the parent ASIN for each seller SKU.
 * Ordered product sales are ex-VAT and are not settlement figures.
 */
export async function fetchSalesAndTraffic(input: {
  accountId: string;
  from: string;
  to: string;
  asinGranularity: "PARENT" | "CHILD" | "SKU";
}): Promise<SalesTrafficReport> {
  const { client, marketplaceIds } = await loadSpApiClient(input.accountId);
  const marketplaceId = marketplaceIds[0] || "A1F83G8C2ARO7P";
  const created = await client.createReport({
    reportType: "GET_SALES_AND_TRAFFIC_REPORT",
    marketplaceIds: [marketplaceId],
    dataStartTime: `${input.from}T00:00:00Z`,
    dataEndTime: endIso(input.to),
    reportOptions: {
      dateGranularity: "DAY",
      asinGranularity: input.asinGranularity,
    },
  });
  const reportId = created.reportId;
  let documentId = "";
  for (let attempt = 0; attempt < 24; attempt += 1) {
    await sleep(attempt === 0 ? 4000 : 8000);
    const status = await client.getReport(reportId);
    if (status.processingStatus === "DONE" && status.reportDocumentId) {
      documentId = status.reportDocumentId;
      break;
    }
    if (status.processingStatus === "FATAL" || status.processingStatus === "CANCELLED") {
      throw new Error(`Sales and traffic report ${status.processingStatus} for ${input.from} to ${input.to}`);
    }
  }
  if (!documentId) throw new Error(`Sales and traffic report timed out for ${input.from} to ${input.to}`);

  const doc = await client.getReportDocument(documentId);
  const response = await fetch(doc.url);
  if (!response.ok) throw new Error(`Could not download sales and traffic report (${response.status})`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const raw = doc.compressionAlgorithm === "GZIP" ? gunzipSync(bytes) : bytes;
  const parsed = JSON.parse(raw.toString("utf8")) as {
    salesAndTrafficByAsin?: Array<{
      parentAsin?: string;
      childAsin?: string;
      sku?: string;
      salesByAsin?: {
        unitsOrdered?: number;
        unitsRefunded?: number;
        totalOrderItems?: number;
        orderedProductSales?: Money;
      };
    }>;
    salesAndTrafficByDate?: Array<{
      date?: string;
      salesByDate?: {
        unitsOrdered?: number;
        unitsRefunded?: number;
        totalOrderItems?: number;
        orderedProductSales?: Money;
      };
    }>;
  };

  const byAsin = (parsed.salesAndTrafficByAsin || []).map((row) => ({
    parentAsin: String(row.parentAsin || "").trim().toUpperCase(),
    childAsin: String(row.childAsin || "").trim().toUpperCase(),
    sku: String(row.sku || "").trim().toUpperCase(),
    units: Number(row.salesByAsin?.unitsOrdered || 0),
    orders: Number(row.salesByAsin?.totalOrderItems || 0),
    refunds: Number(row.salesByAsin?.unitsRefunded || 0),
    sales: money(row.salesByAsin?.orderedProductSales),
  }));
  const byDate = (parsed.salesAndTrafficByDate || []).map((row) => ({
    date: String(row.date || "").slice(0, 10),
    units: Number(row.salesByDate?.unitsOrdered || 0),
    orders: Number(row.salesByDate?.totalOrderItems || 0),
    refunds: Number(row.salesByDate?.unitsRefunded || 0),
    sales: money(row.salesByDate?.orderedProductSales),
  }));
  return { from: input.from, to: input.to, byAsin, byDate };
}
