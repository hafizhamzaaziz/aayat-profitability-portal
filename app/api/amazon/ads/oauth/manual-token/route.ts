import { NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { fetchAccessToken } from "@/lib/amazon/ads/lwa";
import { AdsApiClient, type AdsRegion } from "@/lib/amazon/ads/client";
import { encryptString, isEncryptionConfigured } from "@/lib/security/encryption";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Save an Amazon Ads-API refresh token manually (bypassing the OAuth flow).
 * Used when the admin self-authorises and has the refresh token directly
 * from the LWA self-serve console.
 *
 *   POST /api/amazon/ads/oauth/manual-token
 *   { accountId, refreshToken }
 *
 * On save we also auto-discover profiles so the user doesn't need to do
 * it as a separate step.
 */
export async function POST(request: NextRequest) {
  const body = (await request.json().catch(() => ({}))) as {
    accountId?: string;
    refreshToken?: string;
  };
  const accountId = (body.accountId || "").trim();
  const refreshToken = (body.refreshToken || "").trim();

  if (!accountId || !refreshToken) {
    return Response.json(
      { ok: false, error: "accountId and refreshToken are both required." },
      { status: 400 }
    );
  }
  if (!isEncryptionConfigured()) {
    return Response.json({ ok: false, error: "TOKEN_ENC_KEY is not configured on the server." }, { status: 503 });
  }

  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return Response.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  const { data: userRow } = await supabase.from("users").select("role").eq("id", user.id).single();
  if (String(userRow?.role) !== "admin") {
    return Response.json(
      { ok: false, error: "Only admins can save Amazon Ads credentials manually." },
      { status: 403 }
    );
  }

  // Validate the refresh token by trading it for an access token.
  try {
    await fetchAccessToken(refreshToken);
  } catch (err) {
    return Response.json(
      {
        ok: false,
        error: err instanceof Error
          ? `Amazon rejected this refresh token: ${err.message}`
          : "Amazon rejected this refresh token.",
      },
      { status: 400 }
    );
  }

  const admin = createAdminClient();
  const { data: account } = await admin
    .from("accounts")
    .select("id, name")
    .eq("id", accountId)
    .maybeSingle();
  if (!account) return Response.json({ ok: false, error: "Account not found." }, { status: 404 });

  // Best-effort profile discovery — don't fail the save if it hiccups.
  const region = ((process.env.AMAZON_ADS_REGION || "eu").toLowerCase() as AdsRegion);
  let profileIds: Record<string, number> = {};
  try {
    const client = new AdsApiClient(refreshToken, region);
    const profiles = await client.listProfiles();
    for (const p of profiles) {
      const existing = profileIds[p.countryCode];
      if (!existing || p.accountInfo.type === "seller") {
        profileIds[p.countryCode] = p.profileId;
      }
    }
  } catch (err) {
    profileIds = {};
    console.warn("Ads listProfiles failed during manual-token save:", err);
  }

  const refreshTokenEncrypted = encryptString(refreshToken);
  const { error: upsertError } = await admin
    .from("account_amazon_credentials")
    .upsert(
      {
        account_id: accountId,
        provider: "ads-api",
        refresh_token_encrypted: refreshTokenEncrypted,
        connected_at: new Date().toISOString(),
        connected_by: user.id,
        last_sync_error: null,
        ads_profile_ids: profileIds,
      },
      { onConflict: "account_id,provider" }
    );
  if (upsertError) {
    return Response.json({ ok: false, error: upsertError.message }, { status: 500 });
  }

  return Response.json({
    ok: true,
    accountName: account.name,
    profileIds,
    profilesDiscovered: Object.keys(profileIds).length,
  });
}
