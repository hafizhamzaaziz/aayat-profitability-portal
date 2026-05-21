import { NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { loadSpApiClient, updateMarketplaceIds, updateSyncStatus } from "@/lib/amazon/credentials";
import { SpApiError } from "@/lib/amazon/spapi";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * "Test SP-API" smoke check for an account's stored connection.
 *
 *   GET /api/amazon/test?accountId=<uuid>
 *
 * What it does:
 *   1. Calls getMarketplaceParticipations to confirm refresh_token → access_token
 *      flow + a real signed SP-API call work end-to-end. Persists the
 *      discovered marketplace_ids back to the credential row so subsequent
 *      data pulls know which marketplaces to ask about.
 *   2. Calls listOrders (last 30 days, page size 1) just to count orders
 *      reachable via SP-API — proves we can actually read seller data, not
 *      just metadata.
 *   3. Writes last_synced_at / last_sync_error so the connection panel shows
 *      live sync health.
 *
 * Returns a JSON payload safe to display in the UI (no tokens included).
 */
export async function GET(request: NextRequest) {
  const accountId = request.nextUrl.searchParams.get("accountId");
  if (!accountId) return Response.json({ ok: false, error: "Missing accountId" }, { status: 400 });

  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return Response.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  const { data: userRow } = await supabase.from("users").select("role").eq("id", user.id).single();
  const role = String(userRow?.role || "client");
  if (role !== "admin" && role !== "team") {
    return Response.json({ ok: false, error: "Forbidden" }, { status: 403 });
  }

  try {
    const { client, sellingPartnerId, region } = await loadSpApiClient(accountId);

    // 1. Marketplace participations
    const parts = await client.getMarketplaceParticipations();
    const marketplaces = (parts.payload || []).map((p) => ({
      id: p.marketplace.id,
      name: p.marketplace.name,
      country: p.marketplace.countryCode,
      currency: p.marketplace.defaultCurrencyCode,
      participating: p.participation.isParticipating,
      suspended: p.participation.hasSuspendedListings,
    }));
    const activeMarketplaceIds = marketplaces.filter((m) => m.participating).map((m) => m.id);
    if (activeMarketplaceIds.length > 0) {
      await updateMarketplaceIds(accountId, activeMarketplaceIds);
    }

    // 2. Count orders in the last 30 days
    const createdAfter = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    let orderSample: { id: string; status: string; purchaseDate: string } | null = null;
    let orderCountSample = 0;
    let ordersError: string | null = null;
    if (activeMarketplaceIds.length > 0) {
      try {
        const orders = await client.listOrders({
          marketplaceIds: activeMarketplaceIds,
          createdAfter,
          maxResultsPerPage: 10,
        });
        const list = orders.payload?.Orders || [];
        orderCountSample = list.length;
        const first = list[0];
        if (first) {
          orderSample = {
            id: first.AmazonOrderId,
            status: first.OrderStatus,
            purchaseDate: first.PurchaseDate,
          };
        }
      } catch (err) {
        ordersError =
          err instanceof SpApiError
            ? `${err.status}: ${err.message}`
            : err instanceof Error
            ? err.message
            : String(err);
      }
    }

    await updateSyncStatus(accountId, { ok: true });
    return Response.json({
      ok: true,
      region,
      sellingPartnerId,
      marketplaces,
      sampleOrders: {
        windowDays: 30,
        countOnFirstPage: orderCountSample,
        first: orderSample,
        error: ordersError,
      },
    });
  } catch (err) {
    const message =
      err instanceof SpApiError
        ? `${err.status}: ${err.message} :: ${err.body.slice(0, 500)}`
        : err instanceof Error
        ? err.message
        : String(err);
    await updateSyncStatus(accountId, { ok: false, error: message }).catch(() => {});
    return Response.json({ ok: false, error: message }, { status: 502 });
  }
}
