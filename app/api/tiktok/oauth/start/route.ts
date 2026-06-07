import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { encodeTiktokOauthState, buildTiktokConsentUrl } from "@/lib/tiktok/oauth";
import { isTiktokConfigured } from "@/lib/tiktok/config";
import { isEncryptionConfigured } from "@/lib/security/encryption";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Kicks off the TikTok Shop seller-authorization flow for a given account.
 *
 *   GET /api/tiktok/oauth/start?accountId=<uuid>
 *
 * Redirects the seller to TikTok's authorization page (keyed by service_id).
 * After they approve, TikTok redirects to /api/tiktok/oauth/callback with a
 * one-shot `code`. Security is the HMAC-signed `state` (embeds accountId).
 */
export async function GET(request: NextRequest) {
  const accountId = request.nextUrl.searchParams.get("accountId");

  if (!accountId) {
    return new Response("Missing accountId", { status: 400 });
  }
  if (!isEncryptionConfigured()) {
    return new Response("Token encryption key (TOKEN_ENC_KEY) is not configured on the server.", { status: 503 });
  }
  if (!isTiktokConfigured()) {
    return new Response(
      "TikTok app is not configured (set TIKTOK_APP_KEY, TIKTOK_APP_SECRET and TIKTOK_SERVICE_ID).",
      { status: 503 }
    );
  }

  const admin = createAdminClient();
  const { data: account } = await admin.from("accounts").select("id, name").eq("id", accountId).maybeSingle();
  if (!account) return new Response("Account not found", { status: 404 });

  const state = encodeTiktokOauthState(accountId);
  const consentUrl = buildTiktokConsentUrl(state);

  return NextResponse.redirect(consentUrl, { status: 302 });
}
