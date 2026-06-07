import { getTiktokAppCreds, tiktokAuthBase } from "./config";

/**
 * TikTok Shop token endpoints (auth.tiktok-shops.com).
 *
 * These calls are NOT request-signed — they authenticate with app_key +
 * app_secret directly in the query string.
 *
 *   - token/get:     auth_code → { access_token, refresh_token, expiries, shop info }
 *   - token/refresh: refresh_token → new { access_token, refresh_token, expiries }
 *
 * IMPORTANT: refresh ROTATES the refresh_token (returns a new one with a fresh
 * ~1-year expiry). Always persist the returned refresh_token.
 */

export type TiktokTokenData = {
  access_token: string;
  /** Absolute epoch SECONDS when the access token expires. */
  access_token_expire_in: number;
  refresh_token: string;
  /** Absolute epoch SECONDS when the refresh token expires. */
  refresh_token_expire_in: number;
  open_id?: string;
  seller_name?: string;
  seller_base_region?: string;
};

type TiktokTokenEnvelope = {
  code: number;
  message: string;
  data?: TiktokTokenData;
  request_id?: string;
};

async function callTokenEndpoint(path: string, extra: Record<string, string>): Promise<TiktokTokenData> {
  const { appKey, appSecret } = getTiktokAppCreds();
  const params = new URLSearchParams({
    app_key: appKey,
    app_secret: appSecret,
    ...extra,
  });
  const url = `${tiktokAuthBase()}${path}?${params.toString()}`;
  const res = await fetch(url, { method: "GET", cache: "no-store" });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`TikTok token request failed (${res.status}): ${text}`);
  }
  let envelope: TiktokTokenEnvelope;
  try {
    envelope = JSON.parse(text) as TiktokTokenEnvelope;
  } catch {
    throw new Error(`TikTok token response was not JSON: ${text.slice(0, 300)}`);
  }
  if (envelope.code !== 0 || !envelope.data) {
    throw new Error(`TikTok token error (code ${envelope.code}): ${envelope.message}`);
  }
  return envelope.data;
}

/** Exchange the one-shot auth code (from the OAuth callback) for tokens. */
export function exchangeTiktokAuthCode(authCode: string): Promise<TiktokTokenData> {
  return callTokenEndpoint("/api/v2/token/get", {
    auth_code: authCode,
    grant_type: "authorized_code",
  });
}

/** Trade a stored refresh token for fresh access + refresh tokens. */
export function refreshTiktokToken(refreshToken: string): Promise<TiktokTokenData> {
  return callTokenEndpoint("/api/v2/token/refresh", {
    refresh_token: refreshToken,
    grant_type: "refresh_token",
  });
}

/**
 * TikTok returns expiries as absolute epoch SECONDS. Convert to an ISO string,
 * tolerating the (rare) case where a duration-in-seconds is returned instead.
 */
export function tiktokExpiryToIso(expire: number): string {
  const nowSec = Math.floor(Date.now() / 1000);
  // Absolute timestamps are far in the future relative to "now"; a small value
  // (< ~1 year of seconds) is almost certainly a duration.
  const epochSec = expire > nowSec - 86400 ? expire : nowSec + expire;
  return new Date(epochSec * 1000).toISOString();
}
