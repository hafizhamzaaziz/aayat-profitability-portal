import { createHmac, randomBytes, timingSafeEqual } from "crypto";

/**
 * SP-API OAuth helpers.
 *
 * The `state` parameter we pass to Amazon at consent time is round-tripped back
 * to us at the callback. We use it for two things:
 *   1. CSRF protection — the state is HMAC-signed so an attacker can't forge it.
 *   2. Account binding — we embed the accountId so the callback knows which
 *      portal account this authorization belongs to.
 *
 * State payload (base64url-encoded JSON):
 *   { aid: <accountId>, n: <nonce>, exp: <unix-seconds> }
 * Followed by ".<hmac>" using HMAC-SHA256(TOKEN_ENC_KEY, payload).
 *
 * State has a 30-minute TTL — enough time for a client to read the email,
 * click the link, and complete the consent screen.
 */

const STATE_TTL_SECONDS = 30 * 60;

// Marketplace IDs by region. SP-API uses these in API calls; OAuth itself is
// region-agnostic but the Seller Central consent URL must match the
// marketplace the seller is logged into.
export const MARKETPLACES = {
  uk: { id: "A1F83G8C2ARO7P", host: "sellercentral.amazon.co.uk", currency: "GBP", label: "United Kingdom" },
  de: { id: "A1PA6795UKMFR9", host: "sellercentral.amazon.de", currency: "EUR", label: "Germany" },
  fr: { id: "A13V1IB3VIYZZH", host: "sellercentral.amazon.fr", currency: "EUR", label: "France" },
  it: { id: "APJ6JRA9NG5V4", host: "sellercentral.amazon.it", currency: "EUR", label: "Italy" },
  es: { id: "A1RKKUPIHCS9HS", host: "sellercentral.amazon.es", currency: "EUR", label: "Spain" },
  nl: { id: "A1805IZSGTT6HS", host: "sellercentral.amazon.nl", currency: "EUR", label: "Netherlands" },
  us: { id: "ATVPDKIKX0DER", host: "sellercentral.amazon.com", currency: "USD", label: "United States" },
} as const;

export type MarketplaceKey = keyof typeof MARKETPLACES;

function getHmacKey(): Buffer {
  const raw = process.env.TOKEN_ENC_KEY;
  if (!raw) {
    throw new Error("TOKEN_ENC_KEY is not configured (also used for OAuth state signing).");
  }
  return Buffer.from(raw, "base64");
}

function base64urlEncode(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64urlDecode(s: string): Buffer {
  const padded = s.replace(/-/g, "+").replace(/_/g, "/") + "==".slice((s.length + 3) % 4);
  return Buffer.from(padded, "base64");
}

function sign(payload: string): string {
  return base64urlEncode(createHmac("sha256", getHmacKey()).update(payload).digest());
}

export function encodeOauthState(accountId: string): string {
  const payload = base64urlEncode(
    Buffer.from(
      JSON.stringify({
        aid: accountId,
        n: randomBytes(8).toString("hex"),
        exp: Math.floor(Date.now() / 1000) + STATE_TTL_SECONDS,
      })
    )
  );
  const sig = sign(payload);
  return `${payload}.${sig}`;
}

export type DecodedState = { accountId: string; expiresAt: number };

export function decodeOauthState(state: string): DecodedState {
  const parts = state.split(".");
  if (parts.length !== 2) {
    throw new Error("Malformed OAuth state.");
  }
  const [payload, sig] = parts;
  const expected = sign(payload);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw new Error("OAuth state signature does not verify (possible CSRF).");
  }
  const decoded = JSON.parse(base64urlDecode(payload).toString("utf8")) as {
    aid: string;
    exp: number;
  };
  if (Math.floor(Date.now() / 1000) > Number(decoded.exp || 0)) {
    throw new Error("OAuth state has expired. Please start the connection flow again.");
  }
  if (!decoded.aid) throw new Error("OAuth state is missing accountId.");
  return { accountId: String(decoded.aid), expiresAt: Number(decoded.exp) };
}

/**
 * Build the URL we redirect the seller to for consent.
 *
 * IMPORTANT: while the app is in Draft status in Developer Central, the
 * `version=beta` query param is required. Remove it once the app is Published.
 */
export function buildConsentUrl(input: {
  marketplace: MarketplaceKey;
  applicationId: string;
  state: string;
  redirectUri: string;
  draftApp?: boolean;
}): string {
  const market = MARKETPLACES[input.marketplace];
  const params = new URLSearchParams({
    application_id: input.applicationId,
    state: input.state,
    redirect_uri: input.redirectUri,
  });
  if (input.draftApp !== false) {
    params.set("version", "beta");
  }
  return `https://${market.host}/apps/authorize/consent?${params.toString()}`;
}

/**
 * Resolve the base URL of this deployment, used to construct the OAuth
 * callback URI. Precedence:
 *   1. APP_BASE_URL (explicit, recommended)
 *   2. NEXT_PUBLIC_APP_URL
 *   3. VERCEL_URL (auto-set on Vercel)
 *   4. http://localhost:3000 (dev fallback)
 */
export function appBaseUrl(): string {
  const explicit = process.env.APP_BASE_URL || process.env.NEXT_PUBLIC_APP_URL;
  if (explicit) return explicit.replace(/\/+$/, "");
  if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}`;
  return "http://localhost:3000";
}

export function oauthCallbackUrl(): string {
  return `${appBaseUrl()}/api/amazon/oauth/callback`;
}
