import { NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireStaffAccountAccess } from "@/lib/auth/require-account";
import { syncAmazonListings } from "@/lib/amazon/ingest/listings";
import { SpApiError } from "@/lib/amazon/spapi";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * POST /api/amazon/listings/sync { accountId, marketplaceIds? }
 * Pull the seller's full Amazon listings catalog (every SKU + ASIN) and make
 * sure each SKU has a product mapping. Admin/team only.
 */
export async function POST(request: NextRequest) {
  const userClient = createClient();
  const {
    data: { user },
  } = await userClient.auth.getUser();
  if (!user) return Response.json({ ok: false, error: "Unauthorized" }, { status: 401 });

  let body: { accountId?: string; marketplaceIds?: string[] };
  try {
    body = (await request.json()) as { accountId?: string; marketplaceIds?: string[] };
  } catch {
    return Response.json({ ok: false, error: "Invalid JSON body" }, { status: 400 });
  }
  const accountId = String(body.accountId || "").trim();
  if (!accountId) return Response.json({ ok: false, error: "Missing accountId" }, { status: 400 });
  const access = await requireStaffAccountAccess(userClient, user.id, accountId);
  if (!access.account) return Response.json({ ok: false, error: "Forbidden" }, { status: 403 });

  try {
    const result = await syncAmazonListings({
      supabase: createAdminClient(),
      accountId,
      marketplaceIds: Array.isArray(body.marketplaceIds) ? body.marketplaceIds.map(String) : undefined,
      budgetMs: 240_000,
    });
    return Response.json(result, { status: result.ok ? 200 : 502 });
  } catch (err) {
    const message = err instanceof SpApiError ? `SP-API ${err.status}: ${err.message}` : err instanceof Error ? err.message : String(err);
    return Response.json({ ok: false, error: message }, { status: 502 });
  }
}
