/**
 * Login with Amazon (LWA) helpers for the SP-API integration.
 *
 * SP-API uses LWA OAuth 2.0 in two flows:
 *
 * 1. Authorization code flow (once per seller, at "Connect Amazon" time):
 *    spapi_oauth_code → exchangeAuthorizationCode → { refresh_token, access_token, expires_in }
 *    We store the refresh_token encrypted in account_amazon_credentials.
 *
 * 2. Refresh token flow (every time we want to call SP-API, ~once per hour):
 *    refresh_token → fetchAccessToken → { access_token, expires_in }
 *    The access_token is short-lived (1h) and only kept in memory.
 *
 * Endpoints are global (not region-specific). The region only matters for the
 * SP-API endpoint (eu vs na vs fe), not for LWA.
 */

const LWA_TOKEN_URL = "https://api.amazon.com/auth/o2/token";

export type LwaTokens = {
  access_token: string;
  refresh_token: string;
  token_type: "bearer";
  expires_in: number;
};

function getCreds() {
  const clientId = process.env.AMAZON_LWA_CLIENT_ID;
  const clientSecret = process.env.AMAZON_LWA_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error(
      "AMAZON_LWA_CLIENT_ID / AMAZON_LWA_CLIENT_SECRET are not set. Configure them in .env.local and Vercel."
    );
  }
  return { clientId, clientSecret };
}

/**
 * Exchange a one-shot `spapi_oauth_code` (from the OAuth callback) for a
 * long-lived refresh_token. Call this once per seller, immediately after the
 * callback fires.
 */
export async function exchangeAuthorizationCode(spapiOauthCode: string): Promise<LwaTokens> {
  const { clientId, clientSecret } = getCreds();
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: spapiOauthCode,
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
    throw new Error(`LWA code exchange failed (${res.status}): ${text}`);
  }
  return JSON.parse(text) as LwaTokens;
}

/**
 * Trade a stored refresh_token for a short-lived access_token. Cache the
 * result in memory for `expires_in - 60s` to avoid hammering LWA.
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
    throw new Error(`LWA refresh failed (${res.status}): ${text}`);
  }
  const parsed = JSON.parse(text) as { access_token: string; expires_in: number };
  return { access_token: parsed.access_token, expires_in: parsed.expires_in };
}
