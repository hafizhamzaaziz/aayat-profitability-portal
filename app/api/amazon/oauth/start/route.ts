import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  MARKETPLACES,
  buildConsentUrl,
  encodeOauthState,
  oauthCallbackUrl,
  type MarketplaceKey,
} from "@/lib/amazon/oauth";
import { isEncryptionConfigured } from "@/lib/security/encryption";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Kicks off the Amazon SP-API OAuth consent flow for a given account.
 *
 *   GET /api/amazon/oauth/start?accountId=<uuid>&marketplace=uk
 *
 * Intentionally NOT auth-gated, because the actual seller authorizing this
 * connection is rarely a portal user — they're an Amazon seller who has no
 * Aayat login. Security is enforced by the HMAC-signed `state` token (only
 * a portal server with TOKEN_ENC_KEY can mint a valid state). At worst,
 * dropping the auth gate lets an attacker generate consent URLs for known
 * accountIds; nothing can be saved against an account without a valid
 * Amazon authorization for that state.
 */
export async function GET(request: NextRequest) {
  const accountId = request.nextUrl.searchParams.get("accountId");
  const marketplaceParam = (request.nextUrl.searchParams.get("marketplace") || "uk").toLowerCase();
  const marketplace = (Object.keys(MARKETPLACES).includes(marketplaceParam)
    ? marketplaceParam
    : "uk") as MarketplaceKey;

  if (!accountId) {
    return new Response("Missing accountId", { status: 400 });
  }

  if (!isEncryptionConfigured()) {
    return new Response(
      "Token encryption key (TOKEN_ENC_KEY) is not configured on the server. Add it to your environment variables.",
      { status: 503 }
    );
  }

  const applicationId = process.env.AMAZON_SP_APP_ID;
  if (!applicationId) {
    return new Response("AMAZON_SP_APP_ID is not configured.", { status: 503 });
  }

  // Confirm the account exists (admin client bypasses RLS so unauth callers
  // can still validate the accountId in the link).
  const admin = createAdminClient();
  const { data: account } = await admin
    .from("accounts")
    .select("id, name")
    .eq("id", accountId)
    .maybeSingle();
  if (!account) return new Response("Account not found", { status: 404 });

  const state = encodeOauthState(accountId);
  const consentUrl = buildConsentUrl({
    marketplace,
    applicationId,
    state,
    redirectUri: oauthCallbackUrl(),
    draftApp: true,
  });

  return NextResponse.redirect(consentUrl, { status: 302 });
}
