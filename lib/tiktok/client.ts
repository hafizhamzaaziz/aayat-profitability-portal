import { getTiktokAppCreds, tiktokApiBase } from "./config";
import { signTiktokRequest } from "./signing";
import { refreshTiktokToken, type TiktokTokenData } from "./token";

/**
 * TikTok Shop Open Platform API client (Partner API v2, 202309 endpoints).
 *
 * Responsibilities:
 *   - Sign every request (HMAC-SHA256) and attach app_key / timestamp / sign in
 *     the query string and the access token in the x-tts-access-token header.
 *   - Proactively refresh the access token when it's near expiry, using the
 *     stored refresh token. Because TikTok rotates the refresh token on every
 *     refresh, the new tokens are handed back via `onTokensRefreshed` so the
 *     caller can persist them.
 *
 * The shop_cipher identifies which authorized shop's data we're reading and is
 * required on all shop-scoped endpoints (orders, finance). The shops-discovery
 * endpoint is the one exception and is called without a cipher.
 */

export type TiktokAuthorizedShop = {
  id: string;
  name: string;
  region: string;
  seller_type?: string;
  cipher: string;
  code?: string;
};

export class TiktokShopClient {
  private accessToken: string;
  private accessTokenExpiresAtSec: number;
  private refreshToken: string;
  private readonly shopCipher: string | null;
  private readonly onTokensRefreshed?: (tokens: TiktokTokenData) => Promise<void> | void;

  constructor(opts: {
    accessToken: string;
    accessTokenExpiresAtSec: number;
    refreshToken: string;
    shopCipher?: string | null;
    onTokensRefreshed?: (tokens: TiktokTokenData) => Promise<void> | void;
  }) {
    this.accessToken = opts.accessToken;
    this.accessTokenExpiresAtSec = opts.accessTokenExpiresAtSec;
    this.refreshToken = opts.refreshToken;
    this.shopCipher = opts.shopCipher ?? null;
    this.onTokensRefreshed = opts.onTokensRefreshed;
  }

  private async ensureAccessToken(): Promise<string> {
    const nowSec = Math.floor(Date.now() / 1000);
    // Refresh 5 minutes before expiry (or if we have no valid token at all).
    if (this.accessToken && nowSec < this.accessTokenExpiresAtSec - 300) {
      return this.accessToken;
    }
    const tokens = await refreshTiktokToken(this.refreshToken);
    this.accessToken = tokens.access_token;
    this.refreshToken = tokens.refresh_token;
    const expSec = tokens.access_token_expire_in;
    this.accessTokenExpiresAtSec = expSec > nowSec - 86400 ? expSec : nowSec + expSec;
    if (this.onTokensRefreshed) await this.onTokensRefreshed(tokens);
    return this.accessToken;
  }

  private async request<T = unknown>(
    method: "GET" | "POST",
    path: string,
    init: {
      query?: Record<string, string | number | undefined>;
      body?: unknown;
      withShopCipher?: boolean;
    } = {}
  ): Promise<T> {
    const { appKey, appSecret } = getTiktokAppCreds();
    const accessToken = await this.ensureAccessToken();
    const withCipher = init.withShopCipher !== false;

    const query: Record<string, string | number | undefined> = {
      app_key: appKey,
      timestamp: Math.floor(Date.now() / 1000),
      ...(init.query || {}),
    };
    if (withCipher && this.shopCipher) query.shop_cipher = this.shopCipher;

    const bodyStr = init.body !== undefined ? JSON.stringify(init.body) : undefined;
    const sign = signTiktokRequest({
      appSecret,
      path,
      query,
      body: bodyStr,
      method,
      contentType: "application/json",
    });
    query.sign = sign;

    const usp = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== "") usp.set(k, String(v));
    }
    const url = `${tiktokApiBase()}${path}?${usp.toString()}`;

    const res = await fetch(url, {
      method,
      headers: {
        "content-type": "application/json",
        "x-tts-access-token": accessToken,
      },
      body: bodyStr,
      cache: "no-store",
    });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`TikTok API ${method} ${path} → ${res.status} :: ${text.slice(0, 500)}`);
    }
    let envelope: { code: number; message: string; data?: T };
    try {
      envelope = JSON.parse(text) as { code: number; message: string; data?: T };
    } catch {
      throw new Error(`TikTok API ${path} returned non-JSON: ${text.slice(0, 300)}`);
    }
    if (envelope.code !== 0) {
      throw new Error(`TikTok API ${path} error (code ${envelope.code}): ${envelope.message}`);
    }
    return envelope.data as T;
  }

  /**
   * List the shops this authorization can access. Called WITHOUT a shop_cipher
   * (it's how we discover the cipher in the first place). Returns the shop list
   * including each shop's `cipher`.
   */
  async getAuthorizedShops(): Promise<TiktokAuthorizedShop[]> {
    const data = await this.request<{ shops: TiktokAuthorizedShop[] }>(
      "GET",
      "/authorization/202309/shops",
      { withShopCipher: false }
    );
    return data?.shops || [];
  }

  /**
   * Search orders created within [createTimeGe, createTimeLt] (epoch seconds).
   * Paginates with page_token. Returns the raw TikTok order objects.
   */
  async searchOrders(input: {
    createTimeGe: number;
    createTimeLt: number;
    pageSize?: number;
    pageToken?: string;
  }): Promise<{ orders: TiktokRawOrder[]; nextPageToken: string | null; totalCount: number | null }> {
    const pageSize = input.pageSize ?? 100;
    const query: Record<string, string | number | undefined> = {
      page_size: pageSize,
      sort_field: "create_time",
      sort_order: "ASC",
    };
    if (input.pageToken) query.page_token = input.pageToken;

    const data = await this.request<{
      orders?: TiktokRawOrder[];
      next_page_token?: string;
      total_count?: number;
    }>("POST", "/order/202309/orders/search", {
      query,
      body: {
        create_time_ge: input.createTimeGe,
        create_time_lt: input.createTimeLt,
      },
    });
    return {
      orders: data?.orders || [],
      nextPageToken: data?.next_page_token || null,
      totalCount: typeof data?.total_count === "number" ? data.total_count : null,
    };
  }
}

/**
 * Minimal shape of a TikTok order object from /order/202309/orders/search.
 * Only the fields we map into the P&L engine are typed; the API returns more.
 */
export type TiktokRawOrder = {
  id: string;
  status: string;
  create_time: number; // epoch seconds
  payment?: {
    currency?: string;
    total_amount?: string;
    sub_total?: string;
    shipping_fee?: string;
    tax?: string;
  };
  line_items?: TiktokRawLineItem[];
};

export type TiktokRawLineItem = {
  id: string;
  product_id?: string;
  product_name?: string;
  sku_id?: string;
  seller_sku?: string;
  sku_name?: string; // variation, e.g. "Grey, King"
  sale_price?: string;
  original_price?: string;
  currency?: string;
  display_status?: string;
  // Refund/return signal on the line, when present.
  is_gift?: boolean;
};
