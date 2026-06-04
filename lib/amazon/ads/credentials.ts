import { createAdminClient } from "@/lib/supabase/admin";
import { decryptString } from "@/lib/security/encryption";
import { AdsApiClient, type AdsRegion } from "./client";

/**
 * Loads an account's stored Amazon Ads-API refresh token, decrypts it, and
 * returns an AdsApiClient ready to make signed requests.
 *
 * Region defaults to AMAZON_ADS_REGION (sensible default: "eu" for Aayat's
 * UK-centric portfolio — the Ads API has separate hosts per region).
 *
 * Throws if the account hasn't connected Ads yet.
 */
export async function loadAdsApiClient(accountId: string): Promise<{
  client: AdsApiClient;
  profileIds: Record<string, number>;
  region: AdsRegion;
}> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("account_amazon_credentials")
    .select("refresh_token_encrypted, ads_profile_ids")
    .eq("account_id", accountId)
    .eq("provider", "ads-api")
    .maybeSingle();

  if (error) {
    throw new Error(`Failed to load Amazon Ads credentials: ${error.message}`);
  }
  if (!data?.refresh_token_encrypted) {
    throw new Error("No Amazon Ads-API connection found for this account.");
  }

  const refreshToken = decryptString(data.refresh_token_encrypted);
  const region = ((process.env.AMAZON_ADS_REGION || "eu").toLowerCase() as AdsRegion);
  const profileIds = (data.ads_profile_ids || {}) as Record<string, number>;

  return {
    client: new AdsApiClient(refreshToken, region),
    profileIds,
    region,
  };
}

export async function updateAdsSyncStatus(
  accountId: string,
  outcome: { ok: true } | { ok: false; error: string }
): Promise<void> {
  const admin = createAdminClient();
  if (outcome.ok) {
    await admin
      .from("account_amazon_credentials")
      .update({ last_synced_at: new Date().toISOString(), last_sync_error: null })
      .eq("account_id", accountId)
      .eq("provider", "ads-api");
  } else {
    await admin
      .from("account_amazon_credentials")
      .update({ last_sync_error: outcome.error.slice(0, 1000) })
      .eq("account_id", accountId)
      .eq("provider", "ads-api");
  }
}

/**
 * Update the per-country profileId map. We call this after the user picks
 * profiles in the UI (or auto-pick the first profile per country).
 *
 * Example: { GB: 1234567890, DE: 9876543210 }
 */
export async function setAdsProfileIds(
  accountId: string,
  profileIds: Record<string, number>
): Promise<void> {
  const admin = createAdminClient();
  await admin
    .from("account_amazon_credentials")
    .update({ ads_profile_ids: profileIds })
    .eq("account_id", accountId)
    .eq("provider", "ads-api");
}

/**
 * Pins the credential to a single advertiser (seller). Agency credentials can
 * see many advertisers across every marketplace, so we persist the chosen
 * advertiser name AND the per-country profile map filtered to it. Pass null to
 * clear the pin.
 */
export async function setAdsAdvertiser(
  accountId: string,
  advertiserName: string | null,
  profileIds: Record<string, number>
): Promise<void> {
  const admin = createAdminClient();
  await admin
    .from("account_amazon_credentials")
    .update({ ads_advertiser_name: advertiserName, ads_profile_ids: profileIds })
    .eq("account_id", accountId)
    .eq("provider", "ads-api");
}

/** Reads the currently-pinned advertiser name (or null). */
export async function getAdsAdvertiser(accountId: string): Promise<string | null> {
  const admin = createAdminClient();
  const { data } = await admin
    .from("account_amazon_credentials")
    .select("ads_advertiser_name")
    .eq("account_id", accountId)
    .eq("provider", "ads-api")
    .maybeSingle();
  return (data?.ads_advertiser_name as string | null) ?? null;
}
