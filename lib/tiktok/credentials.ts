import { createAdminClient } from "@/lib/supabase/admin";
import { encryptString, decryptString } from "@/lib/security/encryption";
import { TiktokShopClient } from "./client";
import { TIKTOK_PROVIDER } from "./config";
import { tiktokExpiryToIso, type TiktokTokenData } from "./token";

/**
 * Persistence for TikTok Shop OAuth credentials, keyed by account.
 *
 * Tokens are encrypted at rest with the shared TOKEN_ENC_KEY (AES-256-GCM).
 * Because TikTok rotates the refresh token on every refresh, the client is
 * wired with an `onTokensRefreshed` callback that re-persists both tokens.
 */

export type TiktokConnectionShop = {
  cipher: string;
  id?: string;
  name?: string;
  region?: string;
};

/** Upsert the credential row after a successful OAuth exchange + shop discovery. */
export async function saveTiktokConnection(input: {
  accountId: string;
  tokens: TiktokTokenData;
  shop: TiktokConnectionShop | null;
  connectedBy: string | null;
}): Promise<void> {
  const { accountId, tokens, shop, connectedBy } = input;
  const admin = createAdminClient();
  const { error } = await admin.from("account_tiktok_credentials").upsert(
    {
      account_id: accountId,
      provider: TIKTOK_PROVIDER,
      access_token_encrypted: encryptString(tokens.access_token),
      access_token_expires_at: tiktokExpiryToIso(tokens.access_token_expire_in),
      refresh_token_encrypted: encryptString(tokens.refresh_token),
      refresh_token_expires_at: tiktokExpiryToIso(tokens.refresh_token_expire_in),
      shop_cipher: shop?.cipher ?? null,
      shop_id: shop?.id ?? null,
      shop_name: shop?.name ?? null,
      region: shop?.region ?? tokens.seller_base_region ?? null,
      seller_name: tokens.seller_name ?? null,
      open_id: tokens.open_id ?? null,
      connected_at: new Date().toISOString(),
      connected_by: connectedBy,
      last_sync_error: null,
    },
    { onConflict: "account_id,provider" }
  );
  if (error) {
    throw new Error(`Failed to save TikTok credentials: ${error.message}`);
  }
}

/** Persist rotated tokens (called from inside the client after a refresh). */
async function persistRotatedTokens(accountId: string, tokens: TiktokTokenData): Promise<void> {
  const admin = createAdminClient();
  await admin
    .from("account_tiktok_credentials")
    .update({
      access_token_encrypted: encryptString(tokens.access_token),
      access_token_expires_at: tiktokExpiryToIso(tokens.access_token_expire_in),
      refresh_token_encrypted: encryptString(tokens.refresh_token),
      refresh_token_expires_at: tiktokExpiryToIso(tokens.refresh_token_expire_in),
    })
    .eq("account_id", accountId)
    .eq("provider", TIKTOK_PROVIDER);
}

/** Load a ready-to-use API client for an account, or throw if not connected. */
export async function loadTiktokClient(accountId: string): Promise<{
  client: TiktokShopClient;
  shopCipher: string | null;
  shopName: string | null;
}> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("account_tiktok_credentials")
    .select(
      "access_token_encrypted, access_token_expires_at, refresh_token_encrypted, shop_cipher, shop_name"
    )
    .eq("account_id", accountId)
    .eq("provider", TIKTOK_PROVIDER)
    .maybeSingle();

  if (error) throw new Error(`Failed to load TikTok credentials: ${error.message}`);
  if (!data?.refresh_token_encrypted) {
    throw new Error("No TikTok Shop connection found for this account.");
  }

  const accessToken = data.access_token_encrypted ? decryptString(data.access_token_encrypted) : "";
  const refreshToken = decryptString(data.refresh_token_encrypted);
  const accessTokenExpiresAtSec = data.access_token_expires_at
    ? Math.floor(new Date(data.access_token_expires_at).getTime() / 1000)
    : 0;

  const client = new TiktokShopClient({
    accessToken,
    accessTokenExpiresAtSec,
    refreshToken,
    shopCipher: data.shop_cipher,
    onTokensRefreshed: (tokens) => persistRotatedTokens(accountId, tokens),
  });

  return { client, shopCipher: data.shop_cipher ?? null, shopName: data.shop_name ?? null };
}

export async function updateTiktokSyncStatus(
  accountId: string,
  outcome: { ok: true } | { ok: false; error: string }
): Promise<void> {
  const admin = createAdminClient();
  if (outcome.ok) {
    await admin
      .from("account_tiktok_credentials")
      .update({ last_synced_at: new Date().toISOString(), last_sync_error: null })
      .eq("account_id", accountId)
      .eq("provider", TIKTOK_PROVIDER);
  } else {
    await admin
      .from("account_tiktok_credentials")
      .update({ last_sync_error: outcome.error.slice(0, 1000) })
      .eq("account_id", accountId)
      .eq("provider", TIKTOK_PROVIDER);
  }
}
