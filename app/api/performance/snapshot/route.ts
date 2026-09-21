import { NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireStaffAccountAccess } from "@/lib/auth/require-account";
import { snapshotAmazonPerformance } from "@/lib/amazon/performance/snapshot";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function POST(request: NextRequest) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return Response.json({ ok: false, error: "Unauthorized" }, { status: 401 });

  let body: { accountId?: string };
  try {
    body = (await request.json()) as { accountId?: string };
  } catch {
    return Response.json({ ok: false, error: "Invalid JSON body" }, { status: 400 });
  }
  const accountId = String(body.accountId || "").trim();
  if (!accountId) return Response.json({ ok: false, error: "Missing accountId" }, { status: 400 });

  const access = await requireStaffAccountAccess(supabase, user.id, accountId);
  if (!access.account) return Response.json({ ok: false, error: "Forbidden" }, { status: 403 });

  const admin = createAdminClient();
  try {
    const result = await snapshotAmazonPerformance(admin, accountId);
    return Response.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return Response.json({ ok: false, error: message }, { status: 502 });
  }
}
