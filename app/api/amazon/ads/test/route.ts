import { NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { loadAdsApiClient, setAdsProfileIds } from "@/lib/amazon/ads/credentials";

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

  try {
    const { client, region } = await loadAdsApiClient(accountId);
    const profiles = await client.listProfiles();

    // Refresh stored profile map so the next sync picks up any new
    // marketplaces the seller has added.
    const profileIds: Record<string, number> = {};
    for (const p of profiles) {
      const existing = profileIds[p.countryCode];
      if (!existing || p.accountInfo.type === "seller") {
        profileIds[p.countryCode] = p.profileId;
      }
    }
    await setAdsProfileIds(accountId, profileIds);

    return Response.json({
      ok: true,
      region,
      profileCount: profiles.length,
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
