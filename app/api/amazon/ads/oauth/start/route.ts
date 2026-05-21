import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { buildAdsConsentUrl, type AdsAuthRegion } from "@/lib/amazon/ads/lwa";
import { encodeAdsOauthState, adsOauthCallbackUrl } from "@/lib/amazon/ads/oauth";
import { isEncryptionConfigured } from "@/lib/security/encryption";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Kicks off the Amazon Ads-API OAuth consent flow for a given account.
 *
 *   GET /api/amazon/ads/oauth/start?accountId=<uuid>&region=eu
 *
 * Region picks the OAuth host (eu, na, fe). The seller signs into their
 * Amazon advertising account on that host and grants us the
 * `advertising::campaign_management` scope. They land back at
 * /api/amazon/ads/oauth/callback with a one-shot `code`.
 *
 * Not auth-gated — same reasoning as the SP-API start route: the HMAC-signed
 * state is the security boundary, and the seller signing in is rarely a
 * portal user.
 */
export async function GET(request: NextRequest) {
  const accountId = request.nextUrl.searchParams.get("accountId");
  const regionParam = (request.nextUrl.searchParams.get("region") || "eu").toLowerCase();
  const region: AdsAuthRegion = (["eu", "na", "fe"].includes(regionParam) ? regionParam : "eu") as AdsAuthRegion;

  if (!accountId) {
    return new Response("Missing accountId", { status: 400 });
  }
  if (!isEncryptionConfigured()) {
    return new Response("Token encryption key (TOKEN_ENC_KEY) is not configured on the server.", { status: 503 });
  }
  if (!process.env.AMAZON_ADS_CLIENT_ID) {
    return new Response("AMAZON_ADS_CLIENT_ID is not configured (create the Ads LWA Security Profile first).", { status: 503 });
  }

  const admin = createAdminClient();
  const { data: account } = await admin.from("accounts").select("id, name").eq("id", accountId).maybeSingle();
  if (!account) return new Response("Account not found", { status: 404 });

  const state = encodeAdsOauthState(accountId);
  const consentUrl = buildAdsConsentUrl({
    state,
    redirectUri: adsOauthCallbackUrl(),
    region,
  });

  return NextResponse.redirect(consentUrl, { status: 302 });
}
