import { NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import {
  loadAdsApiClient,
  setAdsProfileIds,
  setAdsAdvertiser,
  getAdsAdvertiser,
} from "@/lib/amazon/ads/credentials";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Smoke test — confirms the Ads-API credential can:
 *   - exchange the refresh token for an access token (via listProfiles)
 *   - list at least one profile
 *
 *   GET /api/amazon/ads/test?accountId=<uuid>
 *
 * Also refreshes the stored ads_profile_ids map from the live API in
 * case the seller's profiles changed (new marketplace added, etc).
 */
export async function GET(request: NextRequest) {
  const accountId = request.nextUrl.searchParams.get("accountId");
  if (!accountId) {
    return Response.json({ ok: false, error: "accountId is required." }, { status: 400 });
  }

  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return Response.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  const { data: userRow } = await supabase.from("users").select("role").eq("id", user.id).single();
  if (!["admin", "team"].includes(String(userRow?.role))) {
    return Response.json({ ok: false, error: "Forbidden" }, { status: 403 });
  }

  // Optional advertiser pin. When the connected credential is an agency that
  // sees many sellers, the caller passes ?advertiser=<exact name> to lock the
  // sync to that one advertiser's profiles.
  const advertiserParam = request.nextUrl.searchParams.get("advertiser");

  try {
    const { client, region } = await loadAdsApiClient(accountId);
    const profiles = await client.listProfiles();

    // Distinct advertiser (seller) names available under this credential.
    const advertiserOptions = Array.from(
      new Set(profiles.map((p) => String(p.accountInfo.name || "").trim()).filter(Boolean))
    ).sort((a, b) => a.localeCompare(b));

    // Effective advertiser: explicit param wins, else the previously-pinned one.
    const storedAdvertiser = await getAdsAdvertiser(accountId);
    const selectedAdvertiser = (advertiserParam ?? storedAdvertiser) || null;

    // Build the per-country profile map. When an advertiser is pinned we only
    // keep that advertiser's profiles, so a country never resolves to the wrong
    // seller. Without a pin (single-seller credential) keep the prior behaviour.
    const relevant = selectedAdvertiser
      ? profiles.filter((p) => String(p.accountInfo.name || "").trim() === selectedAdvertiser)
      : profiles;
    const profileIds: Record<string, number> = {};
    for (const p of relevant) {
      const existing = profileIds[p.countryCode];
      if (!existing || p.accountInfo.type === "seller") {
        profileIds[p.countryCode] = p.profileId;
      }
    }

    // Persist. If an advertiser was explicitly chosen (or already pinned),
    // store the pin + filtered map; otherwise only refresh the map.
    if (selectedAdvertiser) {
      await setAdsAdvertiser(accountId, selectedAdvertiser, profileIds);
    } else if (advertiserOptions.length <= 1) {
      // A single-advertiser credential is unambiguous — safe to auto-store.
      await setAdsProfileIds(accountId, profileIds);
    }

    return Response.json({
      ok: true,
      region,
      profileCount: profiles.length,
      advertiserOptions,
      selectedAdvertiser,
      profiles: profiles.map((p) => ({
        profileId: p.profileId,
        countryCode: p.countryCode,
        currencyCode: p.currencyCode,
        marketplaceId: p.accountInfo.marketplaceStringId,
        accountType: p.accountInfo.type,
        accountName: p.accountInfo.name,
      })),
      selectedProfileIds: profileIds,
    });
  } catch (err) {
    return Response.json(
      { ok: false, error: err instanceof Error ? err.message : "Unknown Ads-API error." },
      { status: 500 }
    );
  }
}
