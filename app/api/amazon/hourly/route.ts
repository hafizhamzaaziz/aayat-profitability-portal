import { NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireCronAuth } from "@/lib/auth/cron";
import { syncAmazonFinanceData } from "@/lib/amazon/ingest/orchestrate";
import { startAdsSync, collectAdsSync } from "@/lib/amazon/ads/ingest";
import { refreshAmazonDashboardSnapshots } from "@/lib/dashboard/amazon-range-metrics";
import { snapshotAmazonPerformance } from "@/lib/amazon/performance/snapshot";
import { updateSyncStatus } from "@/lib/amazon/credentials";
import { addDays, todayIsoUtc } from "@/lib/utils/date";
import { SpApiError } from "@/lib/amazon/spapi";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * Hourly Amazon sync for every connected SP-API account.
 * Pulls a short overlapping Finance/Orders window, queues Ads reports,
 * refreshes dashboard preset snapshots, and (on Mondays) parent-ASIN
 * performance rows.
 *
 *   GET /api/amazon/hourly   Authorization: Bearer ${CRON_SECRET}
 */
export async function GET(request: NextRequest) {
  const denied = requireCronAuth(request);
  if (denied) return denied;

  const admin = createAdminClient();
  const today = todayIsoUtc();
  const lookbackDays = 3;

  const { data: creds, error } = await admin
    .from("account_amazon_credentials")
    .select("account_id, finance_synced_through")
    .eq("provider", "sp-api")
    .not("refresh_token_encrypted", "is", null);
  if (error) return Response.json({ ok: false, error: error.message }, { status: 502 });

  const accountIds = Array.from(new Set((creds || []).map((r) => String(r.account_id)).filter(Boolean)));
  const watermarkByAccount = new Map(
    (creds || []).map((r) => [String(r.account_id), r.finance_synced_through as string | null])
  );

  const { data: adsCreds } = await admin
    .from("account_amazon_credentials")
    .select("account_id")
    .eq("provider", "ads-api")
    .not("refresh_token_encrypted", "is", null);
  const adsAccounts = new Set((adsCreds || []).map((r) => String(r.account_id)));

  const results: Array<Record<string, unknown>> = [];
  for (const accountId of accountIds) {
    const { data: account } = await admin
      .from("accounts")
      .select("id, vat_rate, cogs_vat_reclaim_pct")
      .eq("id", accountId)
      .maybeSingle();
    if (!account) {
      results.push({ accountId, ok: false, error: "Account not found" });
      continue;
    }

    const watermark = watermarkByAccount.get(accountId);
    const from = watermark && /^\d{4}-\d{2}-\d{2}$/.test(watermark)
      ? addDays(watermark, -lookbackDays)
      : addDays(today, -7);
    const vatRatePct = Number(account.vat_rate ?? 20);
    const cogsVatReclaimPct = Number(account.cogs_vat_reclaim_pct ?? 100);

    try {
      const finance = await syncAmazonFinanceData({
        supabase: admin,
        accountId,
        vatRatePct,
        cogsVatReclaimPct,
        options: { from: from > today ? today : from, to: today },
      });

      let ads: unknown = null;
      if (adsAccounts.has(accountId)) {
        try {
          ads = await startAdsSync({
            supabase: admin,
            accountId,
            vatRatePct,
            cogsVatReclaimPct,
            options: { from: from > today ? today : from, to: today },
          });
        } catch (err) {
          ads = { ok: false, error: err instanceof Error ? err.message : String(err) };
        }
      }

      await refreshAmazonDashboardSnapshots(admin, accountId).catch(() => {});
      const isMonday = new Date(`${today}T00:00:00Z`).getUTCDay() === 1;
      let performance: unknown = null;
      if (isMonday) {
        performance = await snapshotAmazonPerformance(admin, accountId).catch((err) => ({
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        }));
      }

      results.push({
        accountId,
        ok: true,
        from,
        to: today,
        finance: { reports: finance.reports?.length, warnings: finance.warnings },
        ads,
        performance,
      });
    } catch (err) {
      const message =
        err instanceof SpApiError
          ? `SP-API ${err.status}: ${err.message}`
          : err instanceof Error
            ? err.message
            : String(err);
      await updateSyncStatus(accountId, { ok: false, error: message }).catch(() => {});
      results.push({ accountId, ok: false, error: message });
    }
  }

  let collect: unknown = null;
  try {
    collect = await collectAdsSync({ supabase: admin, maxToProcess: 40 });
  } catch (err) {
    collect = { ok: false, error: err instanceof Error ? err.message : String(err) };
  }

  const failed = results.filter((r) => !r.ok).length;
  return Response.json(
    {
      ok: failed === 0,
      checked: results.length,
      failed,
      collect,
      results,
    },
    { status: failed === results.length && results.length > 0 ? 503 : 200 }
  );
}
