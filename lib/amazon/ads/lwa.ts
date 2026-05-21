/**
 * Login with Amazon (LWA) helpers for the Amazon Ads API integration.
 *
 * The Ads API uses LWA OAuth 2.0 just like SP-API, but with:
 *   - A separate LWA Security Profile (separate client_id + client_secret)
 *     so Ads access can be revoked independently of SP-API access.
 *   - An "advertising::campaign_management" scope (rather than the SP-API
 *     scope set, which is implied by the developer-profile registration).
 *   - Authorization endpoint `https://www.amazon.com/ap/oa` (or regional
 *     variants for sellers logged into a non-US Amazon account).
 *
 * Token endpoint is identical to SP-API: https://api.amazon.com/auth/o2/token
 *
 * Flow:
 *   1. Authorization code (once per seller, at "Connect Amazon Ads" time):
 *        auth code → exchangeAuthorizationCode → { refresh_token, access_token }
 *      We store the refresh_token encrypted in account_amazon_credentials
 *      under provider='ads-api'.
 *   2. Refresh token (every time we want to call the Ads API, ~once per hour):
 *        refresh_token → fetchAccessToken → { access_token, expires_in }
 */

const LWA_TOKEN_URL = "https://api.amazon.com/auth/o2/token";
export const ADS_OAUTH_AUTHORIZE_HOSTS = {
  na: "https://www.amazon.com/ap/oa",
  eu: "https://eu.account.amazon.com/ap/oa",
  fe: "https://apac.account.amazon.com/ap/oa",
} as const;
export type AdsAuthRegion = keyof typeof ADS_OAUTH_AUTHORIZE_HOSTS;

export const ADS_SCOPES = ["advertising::campaign_management"] as const;

export type LwaTokens = {
  access_token: string;
  refresh_token: string;
  token_type: "bearer";
  expires_in: number;
};

function getCreds() {
  const clientId = process.env.AMAZON_ADS_CLIENT_ID;
  const clientSecret = process.env.AMAZON_ADS_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error(
      "AMAZON_ADS_CLIENT_ID / AMAZON_ADS_CLIENT_SECRET are not set. Configure them in .env.local and Vercel after creating the Ads LWA Security Profile."
    );
  }
  return { clientId, clientSecret };
}

export function getAdsClientId(): string {
  return getCreds().clientId;
}

/**
 * Exchange the one-shot `code` (returned to our callback after the seller
 * grants consent on Amazon's OAuth screen) for a long-lived refresh_token.
 * Call this once per seller, immediately after the callback fires.
 *
 * IMPORTANT: `redirectUri` MUST exactly match the redirect URI registered
 * on the Ads LWA Security Profile, otherwise Amazon returns "invalid_grant".
 */
export async function exchangeAuthorizationCode(input: {
  code: string;
  redirectUri: string;
}): Promise<LwaTokens> {
  const { clientId, clientSecret } = getCreds();
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: input.code,
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: input.redirectUri,
  });
  const res = await fetch(LWA_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
    cache: "no-store",
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Ads LWA code exchange failed (${res.status}): ${text}`);
  }
  return JSON.parse(text) as LwaTokens;
}

/**
 * Trade a stored refresh_token for a short-lived access_token (1h TTL).
 */
export async function fetchAccessToken(refreshToken: string): Promise<{
  access_token: string;
  expires_in: number;
}> {
  const { clientId, clientSecret } = getCreds();
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: clientId,
    client_secret: clientSecret,
  });
  const res = await fetch(LWA_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
    cache: "no-store",
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Ads LWA refresh failed (${res.status}): ${text}`);
  }
  const parsed = JSON.parse(text) as { access_token: string; expires_in: number };
  return { access_token: parsed.access_token, expires_in: parsed.expires_in };
}

/**
 * Build the consent URL we redirect the seller to. The seller signs into
 * their Amazon Ads account on that page and grants our app the
 * `advertising::campaign_management` scope.
 */
export function buildAdsConsentUrl(input: {
  state: string;
  redirectUri: string;
  region?: AdsAuthRegion;
}): string {
  const host = ADS_OAUTH_AUTHORIZE_HOSTS[input.region ?? "eu"];
  const params = new URLSearchParams({
    client_id: getAdsClientId(),
    scope: ADS_SCOPES.join(" "),
    response_type: "code",
    redirect_uri: input.redirectUri,
    state: input.state,
  });
  return `${host}?${params.toString()}`;
}
