import { NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { fetchAccessToken } from "@/lib/amazon/lwa";
import { encryptString, isEncryptionConfigured } from "@/lib/security/encryption";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Save an Amazon SP-API refresh token manually (bypassing the OAuth flow).
 *
 * Use case: developer self-authorization. Amazon Developer Central can
 * display the refresh token directly on screen when you self-authorize your
 * own seller account. This endpoint lets an admin paste that token into a
 * portal account without round-tripping through OAuth.
 *
 *   POST /api/amazon/oauth/manual-token
 *   { accountId, refreshToken, sellingPartnerId? }
 *
 * Before saving, we validate the token by exchanging it for an access token
 * against LWA. If the exchange fails, we surface the LWA error verbatim and
 * do NOT touch the database.
 */
export async function POST(request: NextRequest) {
  const body = (await request.json().catch(() => ({}))) as {
    accountId?: string;
    refreshToken?: string;
    sellingPartnerId?: string;
  };
  const accountId = (body.accountId || "").trim();
  const refreshToken = (body.refreshToken || "").trim();
  const sellingPartnerId = (body.sellingPartnerId || "").trim() || null;

  if (!accountId || !refreshToken) {
    return Response.json(
      { ok: false, error: "accountId and refreshToken are both required." },
      { status: 400 }
    );
  }
  if (!isEncryptionConfigured()) {
    return Response.json(
      { ok: false, error: "TOKEN_ENC_KEY is not configured on the server." },
      { status: 503 }
    );
  }

  // Admin-only — this writes a credential that grants SP-API access.
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return Response.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  const { data: userRow } = await supabase.from("users").select("role").eq("id", user.id).single();
  if (String(userRow?.role) !== "admin") {
    return Response.json(
      { ok: false, error: "Only admins can save Amazon credentials manually." },
      { status: 403 }
    );
  }

  // 1. Validate the refresh token by trading it for an access token.
  let expiresIn: number;
  try {
    const tokens = await fetchAccessToken(refreshToken);
    expiresIn = tokens.expires_in;
  } catch (err) {
    return Response.json(
      {
        ok: false,
        error:
          err instanceof Error
            ? `Amazon rejected this refresh token: ${err.message}`
            : "Amazon rejected this refresh token.",
      },
      { status: 400 }
    );
  }

  // 2. Confirm the account exists.
  const admin = createAdminClient();
  const { data: account } = await admin
    .from("accounts")
    .select("id, name")
    .eq("id", accountId)
    .maybeSingle();
  if (!account) {
    return Response.json({ ok: false, error: "Account not found." }, { status: 404 });
  }

  // 3. Encrypt and upsert the credential row.
  const refreshTokenEncrypted = encryptString(refreshToken);
  const { error: upsertError } = await admin
    .from("account_amazon_credentials")
    .upsert(
      {
        account_id: accountId,
        provider: "sp-api",
        selling_partner_id: sellingPartnerId,
        refresh_token_encrypted: refreshTokenEncrypted,
        connected_at: new Date().toISOString(),
        connected_by: user.id,
        last_sync_error: null,
      },
      { onConflict: "account_id,provider" }
    );
  if (upsertError) {
    return Response.json({ ok: false, error: upsertError.message }, { status: 500 });
  }

  return Response.json({
    ok: true,
    accountName: account.name,
    accessTokenExpiresIn: expiresIn,
  });
}
