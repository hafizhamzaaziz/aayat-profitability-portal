import { createHmac, randomBytes, timingSafeEqual } from "crypto";
import { appBaseUrl } from "@/lib/amazon/oauth";
import { tiktokServicesBase, getTiktokServiceId } from "./config";

/**
 * TikTok Shop OAuth state + authorize-URL helpers.
 *
 * Mirrors the Amazon Ads state logic: an HMAC-signed JSON payload (keyed by
 * TOKEN_ENC_KEY) embedding the accountId with a 30-min TTL. This is the CSRF /
 * binding boundary, so the start/callback routes don't need a portal session.
 *
 * Unlike Amazon, TikTok's seller authorization page is keyed by `service_id`
 * and the redirect URL is fixed in Partner Center — so we only attach `state`.
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

export function encodeTiktokOauthState(accountId: string): string {
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

export function decodeTiktokOauthState(state: string): { accountId: string } {
  const parts = state.split(".");
  if (parts.length !== 2) throw new Error("Malformed TikTok OAuth state.");
  const [payload, sig] = parts;
  const expected = sign(payload);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw new Error("TikTok OAuth state signature does not verify (possible CSRF).");
  }
  const decoded = JSON.parse(base64urlDecode(payload).toString("utf8")) as {
    aid: string;
    exp: number;
  };
  if (Math.floor(Date.now() / 1000) > Number(decoded.exp || 0)) {
    throw new Error("TikTok OAuth state has expired. Please start the connection flow again.");
  }
  if (!decoded.aid) throw new Error("TikTok OAuth state is missing accountId.");
  return { accountId: String(decoded.aid) };
}

export function tiktokOauthCallbackUrl(): string {
  return `${appBaseUrl()}/api/tiktok/oauth/callback`;
}

/**
 * Build the seller authorization URL. The seller logs into their TikTok Shop
 * account here and grants this app access to their shop. TikTok then redirects
 * to the app's registered redirect URL with a one-shot `code`.
 */
export function buildTiktokConsentUrl(state: string): string {
  const params = new URLSearchParams({
    service_id: getTiktokServiceId(),
    state,
  });
  return `${tiktokServicesBase()}/open/authorize?${params.toString()}`;
}
