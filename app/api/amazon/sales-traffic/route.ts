import { NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireStaffAccountAccess } from "@/lib/auth/require-account";
import { refreshParentItemCards } from "@/lib/dashboard/parent-item";
import { snapshotAmazonPerformance } from "@/lib/amazon/performance/snapshot";
import { SpApiError } from "@/lib/amazon/spapi";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * Pull Amazon's parent-item sales and traffic report into dashboard cards
 * and replace this week's performance rows with those parent ASINs.
 */
export async function POST(request: NextRequest) {
  const userClient = createClient();
  const {
    data: { user },
  } = await userClient.auth.getUser();
  if (!user) return Response.json({ ok: false, error: "Unauthorized" }, { status: 401 });

  let body: { accountId?: string };
  try {
    body = (await request.json()) as { accountId?: string };
  } catch {
    return Response.json({ ok: false, error: "Invalid JSON body" }, { status: 400 });
  }
  const accountId = String(body.accountId || "").trim();
  if (!accountId) return Response.json({ ok: false, error: "Missing accountId" }, { status: 400 });
  const access = await requireStaffAccountAccess(userClient, user.id, accountId);
  if (!access.account) return Response.json({ ok: false, error: "Forbidden" }, { status: 403 });

  const admin = createAdminClient();
  const { data: account } = await admin.from("accounts").select("vat_rate").eq("id", accountId).maybeSingle();
  const vatRatePct = Number(account?.vat_rate ?? 20);

  try {
    const cards = await refreshParentItemCards({ supabase: admin, accountId, vatRatePct });
    const performance = await snapshotAmazonPerformance(admin, accountId).catch((err) => ({
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    }));
    return Response.json({
      ok: true,
      cards: cards.map((card) => ({
        preset: card.preset,
        from: card.from,
        to: card.to,
        sales: card.sales,
        vat: card.vat,
        units: card.units,
        orders: card.orders,
        refunds: card.refunds,
        products: card.products.length,
      })),
      performance,
    });
  } catch (err) {
    const message = err instanceof SpApiError ? `${err.status}: ${err.message}` : err instanceof Error ? err.message : String(err);
    return Response.json({ ok: false, error: message }, { status: 502 });
  }
}
