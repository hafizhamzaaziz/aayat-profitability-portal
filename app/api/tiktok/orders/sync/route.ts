import { NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { loadTiktokClient, updateTiktokSyncStatus } from "@/lib/tiktok/credentials";
import { fetchTiktokOrderRows } from "@/lib/tiktok/orders";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

type SyncBody = {
  accountId?: string;
  from?: string; // YYYY-MM-DD (inclusive)
  to?: string; // YYYY-MM-DD (inclusive)
};

function toIsoDate(value: unknown): string | null {
  if (typeof value !== "string") return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  return value;
}

/**
 * POST /api/tiktok/orders/sync
 *   body: { accountId, from, to }
 *
 * Pulls TikTok Shop orders created within [from 00:00, to+1 00:00) and returns
 * them as normalized rows (same shape as the "All orders" export). The report
 * workbench feeds these straight into the existing TikTok P&L engine — nothing
 * is persisted here, so the user still reviews the preview and clicks Save.
 *
 * Admin/team only.
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

  let body: SyncBody;
  try {
    body = (await request.json()) as SyncBody;
  } catch {
    return Response.json({ ok: false, error: "Invalid JSON body" }, { status: 400 });
  }
  const accountId = String(body.accountId || "").trim();
  if (!accountId) return Response.json({ ok: false, error: "Missing accountId" }, { status: 400 });

  const from = toIsoDate(body.from);
  const to = toIsoDate(body.to);
  if (!from || !to) {
    return Response.json({ ok: false, error: "from and to must be YYYY-MM-DD" }, { status: 400 });
  }
  if (from > to) return Response.json({ ok: false, error: "from must be on or before to" }, { status: 400 });

  const admin = createAdminClient();
  const { data: account, error: acctError } = await admin
    .from("accounts")
    .select("id, name")
    .eq("id", accountId)
    .single();
  if (acctError || !account) {
    return Response.json({ ok: false, error: "Account not found" }, { status: 404 });
  }

  // Inclusive day range → [from 00:00, to+1 day 00:00) in UTC.
  const fromIso = `${from}T00:00:00.000Z`;
  const toNextDay = new Date(`${to}T00:00:00.000Z`);
  toNextDay.setUTCDate(toNextDay.getUTCDate() + 1);
  const toIso = toNextDay.toISOString();

  try {
    const { client, shopName } = await loadTiktokClient(accountId);
    const { rows, orderCount, pages } = await fetchTiktokOrderRows(client, fromIso, toIso);
    await updateTiktokSyncStatus(accountId, { ok: true });
    return Response.json({
      ok: true,
      rows,
      orderCount,
      lineCount: rows.length,
      pages,
      shopName,
      range: { from, to },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await updateTiktokSyncStatus(accountId, { ok: false, error: message });
    return Response.json({ ok: false, error: message }, { status: 502 });
  }
}
