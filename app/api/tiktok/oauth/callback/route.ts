import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { decodeTiktokOauthState } from "@/lib/tiktok/oauth";
import { exchangeTiktokAuthCode } from "@/lib/tiktok/token";
import { TiktokShopClient } from "@/lib/tiktok/client";
import { saveTiktokConnection, type TiktokConnectionShop } from "@/lib/tiktok/credentials";
import { appBaseUrl } from "@/lib/amazon/oauth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * TikTok redirects the seller back here after they grant shop access.
 * Query string: state (HMAC-signed), code (one-shot auth code), app_key,
 * and on failure an error / error_description.
 *
 * On success we exchange the code for tokens, discover the authorized shop's
 * cipher, encrypt and persist everything, then land the seller on the shared
 * connection-result page.
 */
function publicRedirect(message: string, kind: "ok" | "error", accountName?: string | null) {
  const target = new URL("/amazon-connected", appBaseUrl());
  target.searchParams.set("status", kind);
  target.searchParams.set("message", message);
  target.searchParams.set("connection", "tiktok");
  if (accountName) target.searchParams.set("account", accountName);
  return NextResponse.redirect(target, { status: 302 });
}

export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const state = params.get("state");
  const code = params.get("code") || params.get("auth_code");
  const declinedError = params.get("error") || params.get("error_description");

  if (declinedError) {
    return publicRedirect(`TikTok authorization declined (${declinedError}). No connection saved.`, "error");
  }
  if (!state || !code) {
    return publicRedirect(
      "Missing state or authorization code from TikTok. Please start the connection flow again.",
      "error"
    );
  }

  let decoded: { accountId: string };
  try {
    decoded = decodeTiktokOauthState(state);
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
    const {
      data: { user },
    } = await supabase.auth.getUser();
    connectedBy = user?.id ?? null;
  } catch {
    connectedBy = null;
  }

  // 1) Exchange the one-shot code for tokens.
  let tokens;
  try {
    tokens = await exchangeTiktokAuthCode(code);
  } catch (err) {
    return publicRedirect(
      err instanceof Error ? err.message : "Failed to exchange TikTok authorization code.",
      "error",
      account.name
    );
  }

  // 2) Discover the authorized shop's cipher (required for all order calls).
  let shop: TiktokConnectionShop | null = null;
  try {
    const nowSec = Math.floor(Date.now() / 1000);
    const expSec = tokens.access_token_expire_in;
    const client = new TiktokShopClient({
      accessToken: tokens.access_token,
      accessTokenExpiresAtSec: expSec > nowSec - 86400 ? expSec : nowSec + expSec,
      refreshToken: tokens.refresh_token,
    });
    const shops = await client.getAuthorizedShops();
    const picked =
      shops.find((s) => (s.region || "").toUpperCase() === (tokens.seller_base_region || "").toUpperCase()) ||
      shops[0];
    if (picked) {
      shop = { cipher: picked.cipher, id: picked.id, name: picked.name, region: picked.region };
    }
  } catch (err) {
    // Don't fail the connection if shop discovery hiccups — it can be retried,
    // but most order calls need the cipher, so surface it.
    console.warn("TikTok getAuthorizedShops failed at connect time:", err);
  }

  // 3) Persist.
  try {
    await saveTiktokConnection({ accountId: decoded.accountId, tokens, shop, connectedBy });
  } catch (err) {
    return publicRedirect(
      err instanceof Error ? err.message : "Failed to save TikTok credentials.",
      "error",
      account.name
    );
  }

  const shopLabel = shop?.name ? ` Shop: ${shop.name}.` : shop ? "" : " (Shop cipher not discovered — retry sync if order pulls fail.)";
  return publicRedirect(
    `TikTok Shop connected for ${account.name}.${shopLabel}`,
    "ok",
    account.name
  );
}
