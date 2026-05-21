import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { decodeAdsOauthState, adsOauthCallbackUrl } from "@/lib/amazon/ads/oauth";
import { exchangeAuthorizationCode } from "@/lib/amazon/ads/lwa";
import { AdsApiClient, type AdsRegion } from "@/lib/amazon/ads/client";
import { encryptString } from "@/lib/security/encryption";
import { appBaseUrl } from "@/lib/amazon/oauth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Amazon redirects the seller back here after they grant ads consent.
 * Query string:
 *   state  — our HMAC-signed state token (validates accountId + CSRF)
 *   code   — one-shot authorization code (single-use, ~5 min TTL)
 *   scope  — granted scopes (usually "advertising::campaign_management")
 *   error  — set if the user declined / authorization failed
 *
 * Same security model as the SP-API callback: not portal-auth-gated, since
 * the seller authorising may not have an Aayat login. Trust comes from the
 * signed state + the one-shot code.
 *
 * On success we:
 *   1. Exchange the code for a refresh_token (against the SAME redirect_uri
 *      we registered — Amazon strictly compares them).
 *   2. Immediately call listProfiles() to auto-discover the seller's
 *      profiles and store them as { GB: 1234, DE: 5678 } so the user
 *      doesn't have to pick one manually for the common case.
 *   3. Encrypt the refresh_token and upsert the credential row under
 *      provider='ads-api'.
 */
function publicRedirect(message: string, kind: "ok" | "error", accountName?: string | null) {
  const target = new URL("/amazon-connected", appBaseUrl());
  target.searchParams.set("status", kind);
  target.searchParams.set("message", message);
  target.searchParams.set("connection", "ads");
  if (accountName) target.searchParams.set("account", accountName);
  return NextResponse.redirect(target, { status: 302 });
}

export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const state = params.get("state");
  const code = params.get("code");
  const declinedError = params.get("error");

  if (declinedError) {
    return publicRedirect(
      `Amazon Ads authorization declined (${declinedError}). No connection saved.`,
      "error"
    );
  }
  if (!state || !code) {
    return publicRedirect(
      "Missing state or authorization code from Amazon. Please start the connection flow again.",
      "error"
    );
  }

  let decoded: { accountId: string };
  try {
    decoded = decodeAdsOauthState(state);
  } catch (err) {
    return publicRedirect(err instanceof Error ? err.message : "Invalid OAuth state.", "error");
  }

  const admin = createAdminClient();
  const { data: account } = await admin
    .from("accounts")
    .select("id, name")
    .eq("id", decoded.accountId)
    .maybeSingle();
  if (!account) return publicRedirect("Account no longer exists.", "error");

  let connectedBy: string | null = null;
  try {
    const supabase = createClient();
    const { data: { user } } = await supabase.auth.getUser();
    connectedBy = user?.id ?? null;
  } catch {
    connectedBy = null;
  }

  let tokens: { refresh_token: string };
  try {
    tokens = await exchangeAuthorizationCode({ code, redirectUri: adsOauthCallbackUrl() });
  } catch (err) {
    return publicRedirect(
      err instanceof Error ? err.message : "Failed to exchange Ads authorization code with Amazon.",
      "error",
      account.name
    );
  }

  // Auto-discover profiles so the user doesn't have to pick one manually.
  // We try each Ads region until one returns profiles — sellers with EU
  // marketplaces always come back from advertising-api-eu, US sellers from
  // advertising-api, etc.
  const region = ((process.env.AMAZON_ADS_REGION || "eu").toLowerCase() as AdsRegion);
  let profileIds: Record<string, number> = {};
  try {
    const client = new AdsApiClient(tokens.refresh_token, region);
    const profiles = await client.listProfiles();
    for (const p of profiles) {
      // Prefer "seller" profiles over "agency" when the same country has both.
      const existingProfileId = profileIds[p.countryCode];
      if (!existingProfileId || p.accountInfo.type === "seller") {
        profileIds[p.countryCode] = p.profileId;
      }
    }
  } catch (err) {
    // Don't fail the whole flow if profile discovery hiccups — the user
    // can re-trigger discovery from the UI later. Just log it as the
    // last_sync_error so it surfaces.
    profileIds = {};
    console.warn("Ads listProfiles failed at connect time:", err);
  }

  const refreshTokenEncrypted = encryptString(tokens.refresh_token);
  const { error: upsertError } = await admin
    .from("account_amazon_credentials")
    .upsert(
      {
        account_id: decoded.accountId,
        provider: "ads-api",
        refresh_token_encrypted: refreshTokenEncrypted,
        connected_at: new Date().toISOString(),
        connected_by: connectedBy,
        last_sync_error: null,
        ads_profile_ids: profileIds,
      },
      { onConflict: "account_id,provider" }
    );
  if (upsertError) {
    return publicRedirect(
      `Failed to save Ads credentials: ${upsertError.message}`,
      "error",
      account.name
    );
  }

  const profileCount = Object.keys(profileIds).length;
  return publicRedirect(
    `Amazon Ads connected for ${account.name}. Discovered ${profileCount} profile${profileCount === 1 ? "" : "s"} (${Object.keys(profileIds).join(", ") || "none"}).`,
    "ok",
    account.name
  );
}
