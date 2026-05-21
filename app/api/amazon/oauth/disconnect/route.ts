import { NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Disconnect an account's Amazon SP-API integration. Deletes the stored
 * refresh token. The seller can also revoke independently from Seller Central
 * → Partner Network → Manage Your Apps.
 */
export async function POST(request: NextRequest) {
  const { accountId, provider } = (await request.json().catch(() => ({}))) as {
    accountId?: string;
    provider?: string;
  };
  if (!accountId) {
    return Response.json({ ok: false, error: "accountId is required" }, { status: 400 });
  }

  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return Response.json({ ok: false, error: "Unauthorized" }, { status: 401 });

  const { data: userRow } = await supabase.from("users").select("role").eq("id", user.id).single();
  if (String(userRow?.role) !== "admin") {
    return Response.json({ ok: false, error: "Only admins can disconnect Amazon integrations." }, { status: 403 });
  }

  const admin = createAdminClient();
  const { error } = await admin
    .from("account_amazon_credentials")
    .delete()
    .eq("account_id", accountId)
    .eq("provider", provider || "sp-api");
  if (error) return Response.json({ ok: false, error: error.message }, { status: 500 });

  return Response.json({ ok: true });
}
