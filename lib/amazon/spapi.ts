import { fetchAccessToken } from "./lwa";
import type {
  ListFinancialEventGroupsResponse,
  ListFinancialEventsResponse,
} from "./finance-types";

/**
 * Minimal Amazon SP-API client.
 *
 * Auth model (current SP-API, post-2024 simplification):
 *   - No AWS SigV4 signing required for "standard" operations.
 *   - Authentication is a single header:  x-amz-access-token: <LWA access token>
 *   - The access token is short-lived (~1h) and obtained by trading the
 *     long-lived refresh token against LWA.
 *
 * Region routing — the endpoint host differs by region; the seller's
 * marketplace_ids determine which one we hit:
 *   EU  -> https://sellingpartnerapi-eu.amazon.com   (UK, DE, FR, IT, ES, NL, SE, PL, BE, ...)
 *   NA  -> https://sellingpartnerapi-na.amazon.com   (US, CA, MX, BR)
 *   FE  -> https://sellingpartnerapi-fe.amazon.com   (JP, AU, SG, IN)
 *
 * Rate limits are returned in the response header `x-amzn-RateLimit-Limit`.
 * On 429 we retry with capped exponential backoff. On 5xx we retry once.
 */

export type SpRegion = "eu" | "na" | "fe";

const REGION_ENDPOINTS: Record<SpRegion, string> = {
  eu: "https://sellingpartnerapi-eu.amazon.com",
  na: "https://sellingpartnerapi-na.amazon.com",
  fe: "https://sellingpartnerapi-fe.amazon.com",
};

export class SpApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly body: string,
    public readonly path: string
  ) {
    super(message);
    this.name = "SpApiError";
  }
}

type CachedToken = { accessToken: string; expiresAt: number };

// Module-level cache keyed by refresh token. In a serverless context this is
// per-instance, which is fine — each cold start re-fetches a token at most
// once per hour per refresh token.
const tokenCache = new Map<string, CachedToken>();

const ACCESS_TOKEN_SAFETY_MARGIN_SEC = 60;

export class SpApiClient {
  readonly endpoint: string;
  constructor(
    private readonly refreshToken: string,
    region: SpRegion = "eu"
  ) {
    this.endpoint = REGION_ENDPOINTS[region];
  }

  private async getAccessToken(): Promise<string> {
    const cached = tokenCache.get(this.refreshToken);
    const now = Math.floor(Date.now() / 1000);
    if (cached && cached.expiresAt - ACCESS_TOKEN_SAFETY_MARGIN_SEC > now) {
      return cached.accessToken;
    }
    const fresh = await fetchAccessToken(this.refreshToken);
    tokenCache.set(this.refreshToken, {
      accessToken: fresh.access_token,
      expiresAt: now + fresh.expires_in,
    });
    return fresh.access_token;
  }

  /**
   * Low-level SP-API request. Returns the parsed JSON body on success.
   * Throws SpApiError on any non-2xx after retries.
   */
  async request<T = unknown>(
    path: string,
    init: {
      method?: "GET" | "POST" | "PUT" | "DELETE";
      query?: Record<string, string | number | string[] | undefined>;
      body?: unknown;
      maxRetries?: number;
    } = {}
  ): Promise<T> {
    const method = init.method || "GET";
    const maxRetries = init.maxRetries ?? 3;

    const url = new URL(this.endpoint + path);
    if (init.query) {
      for (const [k, v] of Object.entries(init.query)) {
        if (v === undefined || v === null || v === "") continue;
        if (Array.isArray(v)) {
          // SP-API expects comma-separated list values for most array params.
          url.searchParams.set(k, v.join(","));
        } else {
          url.searchParams.set(k, String(v));
        }
      }
    }

    let attempt = 0;
    let lastError: SpApiError | null = null;
    while (attempt <= maxRetries) {
      const accessToken = await this.getAccessToken();
      const res = await fetch(url.toString(), {
        method,
        headers: {
          "x-amz-access-token": accessToken,
          "user-agent": "aayat-profitability-portal/1.0 (Language=Node.js)",
          "content-type": "application/json",
          accept: "application/json",
        },
        body: init.body ? JSON.stringify(init.body) : undefined,
        cache: "no-store",
      });
      const text = await res.text();

      // Token expired between cache check and request — invalidate and retry once.
      if (res.status === 401 || res.status === 403) {
        tokenCache.delete(this.refreshToken);
        if (attempt === 0) {
          attempt++;
          continue;
        }
      }

      // Rate-limited — back off with jitter.
      if (res.status === 429 && attempt < maxRetries) {
        const backoffMs = 500 * Math.pow(2, attempt) + Math.random() * 250;
        await new Promise((r) => setTimeout(r, backoffMs));
        attempt++;
        continue;
      }

      // Transient server error — single retry.
      if (res.status >= 500 && res.status < 600 && attempt < maxRetries) {
        const backoffMs = 750 * Math.pow(2, attempt) + Math.random() * 250;
        await new Promise((r) => setTimeout(r, backoffMs));
        attempt++;
        continue;
      }

      if (!res.ok) {
        lastError = new SpApiError(res.status, `SP-API ${method} ${path} → ${res.status}`, text, path);
        throw lastError;
      }

      return text ? (JSON.parse(text) as T) : (undefined as T);
    }

    throw lastError || new SpApiError(0, `SP-API ${method} ${path} failed after retries`, "", path);
  }

  // -------- Convenience wrappers for specific endpoints --------

  /**
   * GET /sellers/v1/marketplaceParticipations
   * Lists the marketplaces this seller is registered in. Cheapest possible
   * endpoint — perfect for a "Test connection" smoke check.
   * Rate: 0.016 req/sec, burst 15.
   */
  async getMarketplaceParticipations(): Promise<{
    payload: Array<{
      marketplace: { id: string; name: string; countryCode: string; defaultCurrencyCode: string };
      participation: { isParticipating: boolean; hasSuspendedListings: boolean };
    }>;
  }> {
    return this.request("/sellers/v1/marketplaceParticipations");
  }

  /**
   * GET /orders/v0/orders
   * Lists orders within a time window. We use it for a "data smoke test"
   * (counting orders in the last 30 days proves we can pull real data).
   * Rate: 0.0167 req/sec, burst 20.
   */
  async listOrders(params: {
    marketplaceIds: string[];
    createdAfter?: string;
    createdBefore?: string;
    lastUpdatedAfter?: string;
    maxResultsPerPage?: number;
    nextToken?: string;
  }): Promise<{
    payload: {
      Orders: Array<{ AmazonOrderId: string; PurchaseDate: string; OrderStatus: string }>;
      NextToken?: string;
    };
  }> {
    return this.request("/orders/v0/orders", {
      query: {
        MarketplaceIds: params.marketplaceIds,
        CreatedAfter: params.createdAfter,
        CreatedBefore: params.createdBefore,
        LastUpdatedAfter: params.lastUpdatedAfter,
        MaxResultsPerPage: params.maxResultsPerPage,
        NextToken: params.nextToken,
      },
    });
  }

  /**
   * GET /finances/v0/financialEventGroups
   * Lists settlement-period groups. Use this to discover the IDs of
   * financial-event groups that ended within a date range, then call
   * listFinancialEventsByGroup for each group.
   *
   * Rate: 0.5 req/sec, burst 30.
   */
  async listFinancialEventGroups(params: {
    financialEventGroupStartedAfter?: string;
    financialEventGroupStartedBefore?: string;
    maxResultsPerPage?: number;
    nextToken?: string;
  }): Promise<ListFinancialEventGroupsResponse> {
    return this.request("/finances/v0/financialEventGroups", {
      query: {
        FinancialEventGroupStartedAfter: params.financialEventGroupStartedAfter,
        FinancialEventGroupStartedBefore: params.financialEventGroupStartedBefore,
        MaxResultsPerPage: params.maxResultsPerPage,
        NextToken: params.nextToken,
      },
    });
  }

  /**
   * GET /finances/v0/financialEvents
   * Lists all financial events posted within a date range. Returns the full
   * "FinancialEvents" payload (ShipmentEvent, RefundEvent, ServiceFeeEvent,
   * AdjustmentEvent, RetrochargeEvent, ProductAdsPaymentEvent, etc.).
   *
   * Use postedAfter/postedBefore for an event-time query (what we want for
   * a P&L), or financialEventGroupId for a settlement-grouped query.
   *
   * Rate: 0.5 req/sec, burst 30.
   */
  async listFinancialEvents(params: {
    postedAfter?: string;
    postedBefore?: string;
    financialEventGroupId?: string;
    amazonOrderId?: string;
    maxResultsPerPage?: number;
    nextToken?: string;
  }): Promise<ListFinancialEventsResponse> {
    return this.request("/finances/v0/financialEvents", {
      query: {
        PostedAfter: params.postedAfter,
        PostedBefore: params.postedBefore,
        FinancialEventGroupId: params.financialEventGroupId,
        AmazonOrderId: params.amazonOrderId,
        MaxResultsPerPage: params.maxResultsPerPage,
        NextToken: params.nextToken,
      },
    });
  }
}
