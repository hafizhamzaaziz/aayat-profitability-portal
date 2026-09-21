import { NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { requireAccountAccess, requireStaffAccountAccess } from "@/lib/auth/require-account";
import { computeAmazonRangeMetrics, saveAmazonRangeReport } from "@/lib/dashboard/amazon-range-metrics";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function isoDate(value: string | null): string | null {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  return value;
}

export async function GET(request: NextRequest) {
  const accountId = request.nextUrl.searchParams.get("accountId");
  const from = isoDate(request.nextUrl.searchParams.get("from"));
  const to = isoDate(request.nextUrl.searchParams.get("to"));
  if (!accountId || !from || !to) {
    return Response.json({ ok: false, error: "Missing accountId, from, or to" }, { status: 400 });
  }
  if (from > to) return Response.json({ ok: false, error: "from must be on or before to" }, { status: 400 });

  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return Response.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  const access = await requireAccountAccess(supabase, user.id, accountId);
  if (!access.account) return Response.json({ ok: false, error: "Forbidden" }, { status: 403 });

  const metrics = await computeAmazonRangeMetrics(supabase, accountId, from, to);
  return Response.json({ ok: true, metrics });
}

export async function POST(request: NextRequest) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return Response.json({ ok: false, error: "Unauthorized" }, { status: 401 });

  let body: { accountId?: string; from?: string; to?: string };
  try {
    body = (await request.json()) as { accountId?: string; from?: string; to?: string };
  } catch {
    return Response.json({ ok: false, error: "Invalid JSON body" }, { status: 400 });
  }
  const accountId = String(body.accountId || "").trim();
  const from = isoDate(String(body.from || "").slice(0, 10));
  const to = isoDate(String(body.to || "").slice(0, 10));
  if (!accountId || !from || !to) {
    return Response.json({ ok: false, error: "Missing accountId, from, or to" }, { status: 400 });
  }
  if (from > to) return Response.json({ ok: false, error: "from must be on or before to" }, { status: 400 });

  const access = await requireStaffAccountAccess(supabase, user.id, accountId);
  if (!access.account) return Response.json({ ok: false, error: "Forbidden" }, { status: 403 });

  const result = await saveAmazonRangeReport(supabase, accountId, from, to);
  if (result.error) return Response.json({ ok: false, error: result.error }, { status: 502 });
  return Response.json({ ok: true, id: result.id, metrics: result.metrics });
}
