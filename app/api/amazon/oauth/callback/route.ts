import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { decodeOauthState } from "@/lib/amazon/oauth";
import { exchangeAuthorizationCode } from "@/lib/amazon/lwa";
import { encryptString } from "@/lib/security/encryption";
import { appBaseUrl } from "@/lib/amazon/oauth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Amazon redirects the seller back here after they click "Authorize" on the
 * SP-API consent screen. Query string contains:
 *
 *   state                — our signed state token (validates accountId + CSRF)
 *   spapi_oauth_code     — one-shot code (~5 min) we exchange for a refresh_token
 *   selling_partner_id   — the seller's merchant id (e.g. "A2EUQ1WTGCTBG2")
 *   mws_auth_token       — legacy MWS token, ignored (MWS is sunset)
 *
 * This endpoint is intentionally NOT portal-auth-gated: the actual seller
 * authorizing the app rarely has an Aayat portal login. Security is enforced
 * by the HMAC-signed state token (only the portal server can mint one) and
 * by the one-shot `spapi_oauth_code` (only valid for ~5 minutes, single use).
 *
 * The result is shown on the public /amazon-connected page so the seller
 * sees confirmation instead of being bounced to the portal login screen.
 */
function publicRedirect(message: string, kind: "ok" | "error", accountName?: string | null) {
  const target = new URL("/amazon-connected", appBaseUrl());
  target.searchParams.set("status", kind);
  target.searchParams.set("message", message);
  if (accountName) target.searchParams.set("account", accountName);
  return NextResponse.redirect(target, { status: 302 });
}

export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const state = params.get("state");
  const spapiOauthCode = params.get("spapi_oauth_code");
  const sellingPartnerId = params.get("selling_partner_id");
  const declinedError = params.get("error");

  if (declinedError) {
    return publicRedirect(
      `Amazon authorization declined (${declinedError}). No connection saved.`,
      "error"
    );
  }
  if (!state || !spapiOauthCode) {
    return publicRedirect(
      "Missing state or authorization code from Amazon. Please start the connection flow again.",
      "error"
    );
  }

  // 1. Verify the signed state and pull the accountId out of it.
  let decoded: { accountId: string };
  try {
    decoded = decodeOauthState(state);
  } catch (err) {
    return publicRedirect(err instanceof Error ? err.message : "Invalid OAuth state.", "error");
  }

  // 2. Confirm the account still exists. Use admin client so this works even
  //    when the seller has no portal session (which is the common case).
  const admin = createAdminClient();
  const { data: account } = await admin
    .from("accounts")
    .select("id, name")
    .eq("id", decoded.accountId)
    .maybeSingle();
  if (!account) return publicRedirect("Account no longer exists.", "error");

  // 3. Best-effort: capture the portal user as `connected_by` if they happen
  //    to be logged in (admin completing OAuth themselves). It's fine if not.
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

  // 4. Exchange the one-shot code for a long-lived refresh token.
  let tokens: { refresh_token: string };
  try {
    tokens = await exchangeAuthorizationCode(spapiOauthCode);
  } catch (err) {
    return publicRedirect(
      err instanceof Error ? err.message : "Failed to exchange authorization code with Amazon.",
      "error",
      account.name
    );
  }

  // 5. Encrypt the refresh_token and upsert the credential row.
  const refreshTokenEncrypted = encryptString(tokens.refresh_token);
  const { error: upsertError } = await admin
    .from("account_amazon_credentials")
    .upsert(
      {
        account_id: decoded.accountId,
        provider: "sp-api",
        selling_partner_id: sellingPartnerId,
        refresh_token_encrypted: refreshTokenEncrypted,
        connected_at: new Date().toISOString(),
        connected_by: connectedBy,
        last_sync_error: null,
      },
      { onConflict: "account_id,provider" }
    );
  if (upsertError) {
    return publicRedirect(
      `Failed to save Amazon credentials: ${upsertError.message}`,
      "error",
      account.name
    );
  }

  return publicRedirect(
    `Amazon SP-API connected for ${account.name}${sellingPartnerId ? ` (seller ${sellingPartnerId})` : ""}.`,
    "ok",
    account.name
  );
}
