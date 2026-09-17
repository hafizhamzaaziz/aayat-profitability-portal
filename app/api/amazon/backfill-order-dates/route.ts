import { NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { backfillAmazonOrderDates } from "@/lib/amazon/ingest/order-dates";
import { todayIsoUtc } from "@/lib/utils/date";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

type Body = {
  accountId?: string;
  from?: string;
  to?: string;
  allConnected?: boolean;
};

function toIsoDate(value: unknown): string | null {
  if (typeof value !== "string") return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  return value;
}

/**
 * POST /api/amazon/backfill-order-dates
 *   body: { accountId, from?, to? } or { allConnected: true, from?, to? }
 *
 * Looks up PurchaseDate via Orders API for existing SP-API Amazon Order
 * lines, writes it to transaction_date (facts cache sale_date), keeps
 * raw_row["date/time"] as posted/settlement, then refresh_inventory_sales_facts.
 *
 * Use this for Rexo 2026-09-16 (81 posted units → ~42 ordered) without
 * re-pulling the Finance API. Admin/team only.
 */
export async function POST(request: NextRequest) {
  const userClient = createClient();
  const {
    data: { user },
  } = await userClient.auth.getUser();
  if (!user) return Response.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  const { data: userRow } = await userClient.from("users").select("role").eq("id", user.id).single();
  const role = String(userRow?.role || "client");
  if (role !== "admin" && role !== "team") {
    return Response.json({ ok: false, error: "Forbidden" }, { status: 403 });
  }

  let body: Body;
  try {
    body = (await request.json()) as Body;
  } catch {
    return Response.json({ ok: false, error: "Invalid JSON body" }, { status: 400 });
  }

  const today = todayIsoUtc();
  const from = toIsoDate(body.from) || `${today.slice(0, 8)}01`;
  const to = toIsoDate(body.to) || today;
  if (from > to) return Response.json({ ok: false, error: "from must be on or before to" }, { status: 400 });

  const admin = createAdminClient();
  const accountIds: string[] = [];
  if (body.allConnected) {
    const { data, error } = await admin
      .from("account_amazon_credentials")
      .select("account_id")
      .eq("provider", "sp-api")
      .not("refresh_token_encrypted", "is", null);
    if (error) return Response.json({ ok: false, error: error.message }, { status: 502 });
    for (const row of data || []) accountIds.push(String(row.account_id));
  } else {
    const accountId = String(body.accountId || "").trim();
    if (!accountId) return Response.json({ ok: false, error: "Missing accountId" }, { status: 400 });
    accountIds.push(accountId);
  }

  const results = [];
  for (const accountId of accountIds) {
    try {
      const result = await backfillAmazonOrderDates({ supabase: admin, accountId, from, to });
      results.push(result);
    } catch (err) {
      results.push({
        ok: false as const,
        accountId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return Response.json({
    ok: results.some((r) => r.ok === true),
    from,
    to,
    results,
  });
}
