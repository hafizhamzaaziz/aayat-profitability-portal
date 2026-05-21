/**
 * Amazon Ads API v3 client.
 *
 * Wraps just the endpoints we need for profitability reconciliation:
 *   - GET  /v2/profiles                — list advertiser profiles per region
 *   - POST /reporting/reports          — request a Sponsored Products
 *                                         "Advertised Product" report (v3)
 *   - GET  /reporting/reports/{id}     — poll for report completion
 *   - GET  <s3-presigned-url>          — download the gzipped JSON
 *
 * Region matters: profiles in EU sellers are served from advertising-api-eu,
 * NA from advertising-api, FE from advertising-api-fe. Each profile is
 * tied to one marketplace and one country.
 *
 * Reports v3 docs:
 *   https://advertising.amazon.com/API/docs/en-us/offline-report-prod-3p
 * Spec for SP advertisedProduct report:
 *   https://advertising.amazon.com/API/docs/en-us/guides/reporting/v3/report-types/sponsored-products
 */

import { gunzipSync } from "zlib";
import { fetchAccessToken } from "./lwa";

export const ADS_API_HOSTS = {
  na: "https://advertising-api.amazon.com",
  eu: "https://advertising-api-eu.amazon.com",
  fe: "https://advertising-api-fe.amazon.com",
} as const;
export type AdsRegion = keyof typeof ADS_API_HOSTS;

export type AdsProfile = {
  profileId: number;
  countryCode: string;            // e.g. "GB", "DE", "US"
  currencyCode: string;           // e.g. "GBP", "EUR", "USD"
  dailyBudget?: number;
  timezone: string;
  accountInfo: {
    marketplaceStringId: string;  // SP-API marketplace ID
    id: string;                   // Amazon-internal advertiser ID
    type: string;                 // "seller" | "vendor" | "agency"
    name: string;
    validPaymentMethod?: boolean;
  };
};

export type SpAdvertisedProductRow = {
  date: string;                   // "YYYY-MM-DD"
  advertisedSku: string | null;   // SKU as the seller registered it
  advertisedAsin: string | null;
  campaignId: number;
  campaignName: string;
  adGroupId: number;
  adGroupName: string;
  cost: number;                   // ex-VAT spend
  impressions: number;
  clicks: number;
  // Attributed conversions / sales — we don't use these for ad-spend
  // reconciliation but keep the field so callers can decide later.
  sales7d?: number;
  purchases7d?: number;
  unitsSoldClicks7d?: number;
};

export type AdsReportStatus = "PENDING" | "PROCESSING" | "COMPLETED" | "FAILURE";

export class AdsApiClient {
  private accessToken: string | null = null;
  private accessTokenExpiresAt = 0;

  constructor(
    private readonly refreshToken: string,
    private readonly region: AdsRegion = "eu"
  ) {}

  private async getAccessToken(): Promise<string> {
    const nowSec = Math.floor(Date.now() / 1000);
    if (this.accessToken && nowSec < this.accessTokenExpiresAt - 60) {
      return this.accessToken;
    }
    const { access_token, expires_in } = await fetchAccessToken(this.refreshToken);
    this.accessToken = access_token;
    this.accessTokenExpiresAt = nowSec + expires_in;
    return access_token;
  }

  private async request(
    method: "GET" | "POST",
    path: string,
    init: {
      profileId?: number;
      body?: unknown;
      headers?: Record<string, string>;
    } = {}
  ): Promise<Response> {
    const accessToken = await this.getAccessToken();
    const headers: Record<string, string> = {
      Authorization: `Bearer ${accessToken}`,
      "Amazon-Advertising-API-ClientId": process.env.AMAZON_ADS_CLIENT_ID || "",
      ...(init.headers || {}),
    };
    if (init.profileId !== undefined) {
      headers["Amazon-Advertising-API-Scope"] = String(init.profileId);
    }
    let body: BodyInit | undefined;
    if (init.body !== undefined) {
      body = JSON.stringify(init.body);
      headers["Content-Type"] = headers["Content-Type"] || "application/vnd.createasyncreportrequest.v3+json";
    }
    const url = `${ADS_API_HOSTS[this.region]}${path}`;
    const res = await fetch(url, { method, headers, body, cache: "no-store" });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Ads API ${method} ${path} → ${res.status} :: ${text}`);
    }
    return res;
  }

  /**
   * List the advertiser profiles this refresh-token has access to in this
   * region. Each profile = one marketplace context. Use the profileId in
   * the `Amazon-Advertising-API-Scope` header for all subsequent calls.
   */
  async listProfiles(): Promise<AdsProfile[]> {
    const res = await this.request("GET", "/v2/profiles", {
      headers: { Accept: "application/json" },
    });
    return (await res.json()) as AdsProfile[];
  }

  /**
   * Create a Sponsored Products "Advertised Product" report covering
   * [startDate, endDate]. Returns the report id; poll with `getReport`.
   *
   * v3 reports are configured by a `configuration` object listing the
   * columns we want and the report type. We keep the column set minimal
   * (SKU + date + cost) so payloads are small and uploads stay snappy.
   *
   * groupBy "advertiser" + reportTypeId "spAdvertisedProduct" gives us
   * one row per (date, campaign, ad group, advertised product). Summed
   * by SKU it reconciles 1:1 with the "Advertised product" CSV the UI
   * exports.
   */
  async requestSpAdvertisedProductReport(input: {
    profileId: number;
    startDate: string; // "YYYY-MM-DD"
    endDate: string;
  }): Promise<{ reportId: string }> {
    const res = await this.request("POST", "/reporting/reports", {
      profileId: input.profileId,
      body: {
        name: `aayat-portal SP advertised product ${input.startDate}_${input.endDate}`,
        startDate: input.startDate,
        endDate: input.endDate,
        configuration: {
          adProduct: "SPONSORED_PRODUCTS",
          groupBy: ["advertiser"],
          columns: [
            "date",
            "campaignId",
            "campaignName",
            "adGroupId",
            "adGroupName",
            "advertisedSku",
            "advertisedAsin",
            "cost",
            "impressions",
            "clicks",
            "sales7d",
            "purchases7d",
            "unitsSoldClicks7d",
          ],
          reportTypeId: "spAdvertisedProduct",
          timeUnit: "DAILY",
          format: "GZIP_JSON",
        },
      },
    });
    const json = (await res.json()) as { reportId: string };
    return { reportId: json.reportId };
  }

  async getReport(profileId: number, reportId: string): Promise<{
    reportId: string;
    status: AdsReportStatus;
    url?: string;            // S3 presigned download URL when status=COMPLETED
    failureReason?: string;
  }> {
    const res = await this.request("GET", `/reporting/reports/${encodeURIComponent(reportId)}`, {
      profileId,
      headers: { Accept: "application/vnd.createasyncreportresponse.v3+json" },
    });
    return (await res.json()) as {
      reportId: string;
      status: AdsReportStatus;
      url?: string;
      failureReason?: string;
    };
  }

  /**
   * Poll the report until it completes (or hits a hard timeout). Reports
   * for ~90 days of SP data typically take 30–90 seconds to generate.
   */
  async waitForReport(
    profileId: number,
    reportId: string,
    opts: { intervalMs?: number; timeoutMs?: number } = {}
  ): Promise<string> {
    const intervalMs = opts.intervalMs ?? 5000;
    const timeoutMs = opts.timeoutMs ?? 4 * 60 * 1000;
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      const status = await this.getReport(profileId, reportId);
      if (status.status === "COMPLETED" && status.url) return status.url;
      if (status.status === "FAILURE") {
        throw new Error(`Ads report ${reportId} failed: ${status.failureReason || "unknown reason"}`);
      }
      await new Promise((r) => setTimeout(r, intervalMs));
    }
    throw new Error(`Ads report ${reportId} did not complete within ${Math.round(timeoutMs / 1000)}s`);
  }

  /**
   * Download a completed report (gzipped JSON array) from its S3
   * presigned URL and return parsed rows. The presigned URL is NOT on
   * the Ads API host — it's S3, so no auth header is needed.
   */
  async downloadReport(url: string): Promise<SpAdvertisedProductRow[]> {
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) {
      throw new Error(`Ads report download failed (${res.status})`);
    }
    const buf = Buffer.from(await res.arrayBuffer());
    // Reports v3 always returns gzipped JSON; fall back to raw JSON only
    // if the bytes don't look gzipped (defensive — saves a flaky deploy
    // if Amazon ever flips defaults).
    let json: string;
    if (buf[0] === 0x1f && buf[1] === 0x8b) {
      json = gunzipSync(buf).toString("utf8");
    } else {
      json = buf.toString("utf8");
    }
    return JSON.parse(json) as SpAdvertisedProductRow[];
  }
}
