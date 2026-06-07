/**
 * TikTok Shop Open Platform (Partner API v2) configuration.
 *
 * Hosts:
 *   - Seller authorization page lives on services.tiktokshop.com and is keyed
 *     by the app's `service_id` (NOT the app_key). The redirect URL is fixed in
 *     Partner Center, so we don't pass redirect_uri in the authorize URL.
 *   - Token get/refresh live on auth.tiktok-shops.com and take app_key +
 *     app_secret directly (these calls are NOT request-signed).
 *   - All business APIs (orders, finance, authorization) live on
 *     open-api.tiktokglobalshop.com and MUST be HMAC-SHA256 signed.
 *
 * Env vars (configure in .env.local + Vercel):
 *   TIKTOK_APP_KEY       — app key from Partner Center
 *   TIKTOK_APP_SECRET    — app secret (also the HMAC signing key)
 *   TIKTOK_SERVICE_ID    — service id used to build the seller authorize URL
 *   TIKTOK_API_BASE      — optional override (default open-api.tiktokglobalshop.com)
 *   TIKTOK_AUTH_BASE     — optional override (default auth.tiktok-shops.com)
 *   TIKTOK_SERVICES_BASE — optional override (default services.tiktokshop.com)
 * Reused from the Amazon integration:
 *   TOKEN_ENC_KEY        — AES-256-GCM at-rest key + OAuth-state HMAC key
 *   APP_BASE_URL         — public base URL for the OAuth callback
 */

export const TIKTOK_PROVIDER = "tiktok-shop" as const;

export function tiktokApiBase(): string {
  return (process.env.TIKTOK_API_BASE || "https://open-api.tiktokglobalshop.com").replace(/\/+$/, "");
}

export function tiktokAuthBase(): string {
  return (process.env.TIKTOK_AUTH_BASE || "https://auth.tiktok-shops.com").replace(/\/+$/, "");
}

export function tiktokServicesBase(): string {
  return (process.env.TIKTOK_SERVICES_BASE || "https://services.tiktokshop.com").replace(/\/+$/, "");
}

export function getTiktokAppCreds(): { appKey: string; appSecret: string } {
  const appKey = process.env.TIKTOK_APP_KEY;
  const appSecret = process.env.TIKTOK_APP_SECRET;
  if (!appKey || !appSecret) {
    throw new Error(
      "TIKTOK_APP_KEY / TIKTOK_APP_SECRET are not set. Create a TikTok Shop app in Partner Center and add them to .env.local and Vercel env vars."
    );
  }
  return { appKey, appSecret };
}

export function getTiktokServiceId(): string {
  const serviceId = process.env.TIKTOK_SERVICE_ID;
  if (!serviceId) {
    throw new Error(
      "TIKTOK_SERVICE_ID is not set. Copy it from your app's authorization page in TikTok Shop Partner Center."
    );
  }
  return serviceId;
}

export function isTiktokConfigured(): boolean {
  return Boolean(process.env.TIKTOK_APP_KEY && process.env.TIKTOK_APP_SECRET && process.env.TIKTOK_SERVICE_ID);
}
