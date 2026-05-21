import { NextRequest, NextResponse } from "next/server";
import { appBaseUrl } from "@/lib/amazon/oauth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * OAuth Login URI registered with Amazon Developer Central.
 *
 * Two ways this endpoint can be reached:
 *
 *  A) APP-INITIATED workflow (the normal path):
 *     Admin clicks "Connect Amazon" in Settings → /api/amazon/oauth/start
 *     redirects directly to the Seller Central consent screen. This endpoint
 *     is NOT visited in that path.
 *
 *  B) AMAZON-INITIATED workflow:
 *     Seller is in Seller Central → Manage Your Apps → "Authorize Now". Amazon
 *     redirects them to this URL with query params:
 *
 *       amazon_callback_uri   — where we must redirect back to Amazon
 *       amazon_state          — opaque state we must round-trip
 *       selling_partner_id    — the seller's merchant id (already approved)
 *
 *     In that case we surface the request inside the portal so the admin can
 *     pick which Aayat account this Amazon seller should be linked to before
 *     completing the consent. Implementation of that UX is Phase 2 of the
 *     SP-API integration. For now we land the seller on /settings with a
 *     friendly message and the raw params preserved.
 *
 *  Anyone hitting this URL directly (no params, no Amazon context) just sees
 *  the Settings page with a hint.
 */
export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const amazonCallbackUri = params.get("amazon_callback_uri");
  const amazonState = params.get("amazon_state");
  const sellingPartnerId = params.get("selling_partner_id");

  const target = new URL("/settings", appBaseUrl());

  if (amazonCallbackUri && amazonState) {
    // Amazon-initiated path. Preserve the params so a follow-up release can
    // bind this seller to a specific portal account and finish the round-trip.
    target.searchParams.set("amazon", "info");
    target.searchParams.set(
      "amazon_message",
      `Amazon-initiated authorization detected${sellingPartnerId ? ` (seller ${sellingPartnerId})` : ""}. To finish connecting, log in, open Settings → Accounts → Edit → Connect Amazon for the account you want to link this seller to.`
    );
    target.searchParams.set("amazon_init", "1");
    target.searchParams.set("amazon_callback_uri", amazonCallbackUri);
    target.searchParams.set("amazon_state", amazonState);
    if (sellingPartnerId) target.searchParams.set("selling_partner_id", sellingPartnerId);
  } else {
    target.searchParams.set("amazon", "info");
    target.searchParams.set(
      "amazon_message",
      "Open Settings → Accounts Management → Edit any account → Connect Amazon to start an Amazon SP-API connection."
    );
  }

  return NextResponse.redirect(target, { status: 302 });
}
