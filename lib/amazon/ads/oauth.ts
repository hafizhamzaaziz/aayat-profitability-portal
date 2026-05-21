import { createHmac, randomBytes, timingSafeEqual } from "crypto";
import { appBaseUrl } from "@/lib/amazon/oauth";

/**
 * Ads-API OAuth helpers.
 *
 * Mirrors the SP-API state logic (HMAC-signed JSON payload, 30-min TTL)
 * but with its own callback URL so the two integrations are independent.
 *
 * We reuse `appBaseUrl()` from the SP-API helpers so all base-URL
 * resolution lives in one place.
 */

const STATE_TTL_SECONDS = 30 * 60;

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

export function encodeAdsOauthState(accountId: string): string {
  const payload = base64urlEncode(
    Buffer.from(
      JSON.stringify({
        aid: accountId,
        n: randomBytes(8).toString("hex"),
        exp: Math.floor(Date.now() / 1000) + STATE_TTL_SECONDS,
      })
    )
  );
  return `${payload}.${sign(payload)}`;
}

export function decodeAdsOauthState(state: string): { accountId: string } {
  const parts = state.split(".");
  if (parts.length !== 2) throw new Error("Malformed Ads OAuth state.");
  const [payload, sig] = parts;
  const expected = sign(payload);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw new Error("Ads OAuth state signature does not verify (possible CSRF).");
  }
  const decoded = JSON.parse(base64urlDecode(payload).toString("utf8")) as {
    aid: string;
    exp: number;
  };
  if (Math.floor(Date.now() / 1000) > Number(decoded.exp || 0)) {
    throw new Error("Ads OAuth state has expired. Please start the connection flow again.");
  }
  if (!decoded.aid) throw new Error("Ads OAuth state is missing accountId.");
  return { accountId: String(decoded.aid) };
}

export function adsOauthCallbackUrl(): string {
  return `${appBaseUrl()}/api/amazon/ads/oauth/callback`;
}
