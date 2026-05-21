import { createAdminClient } from "@/lib/supabase/admin";
import { decryptString } from "@/lib/security/encryption";
import { SpApiClient, type SpRegion } from "./spapi";

/**
 * Loads an account's stored Amazon SP-API credential, decrypts the refresh
 * token, and returns an SpApiClient ready to make signed requests.
 *
 * Region defaults to whatever AMAZON_SP_REGION is set to in env (sensible
 * default = "eu" for Aayat's UK-centric portfolio).
 */
export async function loadSpApiClient(accountId: string): Promise<{
  client: SpApiClient;
  sellingPartnerId: string | null;
  marketplaceIds: string[];
  region: SpRegion;
}> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("account_amazon_credentials")
    .select("refresh_token_encrypted, selling_partner_id, marketplace_ids")
    .eq("account_id", accountId)
    .eq("provider", "sp-api")
    .maybeSingle();

  if (error) {
    throw new Error(`Failed to load Amazon credentials: ${error.message}`);
  }
  if (!data?.refresh_token_encrypted) {
    throw new Error("No Amazon SP-API connection found for this account.");
  }

  const refreshToken = decryptString(data.refresh_token_encrypted);
  const region = ((process.env.AMAZON_SP_REGION || "eu").toLowerCase() as SpRegion);

  return {
    client: new SpApiClient(refreshToken, region),
    sellingPartnerId: (data.selling_partner_id as string | null) || null,
    marketplaceIds: ((data.marketplace_ids as string[] | null) || []) as string[],
    region,
  };
}

/**
 * Updates the credential row's sync bookkeeping after a successful or failed
 * data pull. Idempotent and safe to call from any code path.
 */
export async function updateSyncStatus(
  accountId: string,
  outcome: { ok: true } | { ok: false; error: string }
): Promise<void> {
  const admin = createAdminClient();
  if (outcome.ok) {
    await admin
      .from("account_amazon_credentials")
      .update({ last_synced_at: new Date().toISOString(), last_sync_error: null })
      .eq("account_id", accountId)
      .eq("provider", "sp-api");
  } else {
    await admin
      .from("account_amazon_credentials")
      .update({ last_sync_error: outcome.error.slice(0, 1000) })
      .eq("account_id", accountId)
      .eq("provider", "sp-api");
  }
}

/**
 * Updates marketplace_ids on the credential row. Useful once we discover
 * which marketplaces a seller actually participates in (via
 * getMarketplaceParticipations) — we then use that list for all subsequent
 * Orders/Finance pulls instead of asking the admin to pick.
 */
export async function updateMarketplaceIds(accountId: string, marketplaceIds: string[]): Promise<void> {
  const admin = createAdminClient();
  await admin
    .from("account_amazon_credentials")
    .update({ marketplace_ids: marketplaceIds })
    .eq("account_id", accountId)
    .eq("provider", "sp-api");
}
