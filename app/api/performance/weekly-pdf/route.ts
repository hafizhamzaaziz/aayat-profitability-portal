import { NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { renderWeeklyPerformancePdfBuffer } from "@/lib/pdf/performance-weekly-document";
import { addDays, currentMondayIsoUtc, isMonday } from "@/lib/utils/date";
import { getClientRecipientsForAccount, isEmailConfigured, sendPdfEmail } from "@/lib/email/mailer";
import { formatPeriodLabel, platformLabel } from "@/lib/email/format-helpers";

export const runtime = "nodejs";

const TEMU_PREFIX = "TEMU:";

type Platform = "amazon" | "temu";

type RawMetric = {
  recorded_date: string;
  product_name: string;
  asin: string | null;
  bsr: number | null;
  review_count: number | null;
  rating: number | null;
  ppc_spend: number | null;
  ppc_sales: number | null;
  total_sales: number | null;
};

function inferPlatformFromIdentifier(identifier: string | null): Platform {
  return String(identifier || "").toUpperCase().startsWith(TEMU_PREFIX) ? "temu" : "amazon";
}

function decodeIdentifier(identifier: string | null) {
  const value = String(identifier || "").trim().toUpperCase();
  if (value.startsWith(TEMU_PREFIX)) return value.slice(TEMU_PREFIX.length);
  return value;
}

function keyFor(row: RawMetric) {
  return `${decodeIdentifier(row.asin)}::${row.product_name.trim().toLowerCase()}`;
}

function dedupeByKey(rows: RawMetric[]) {
  const out = new Map<string, RawMetric>();
  for (const row of rows) {
    const key = keyFor(row);
    if (!out.has(key)) out.set(key, row);
  }
  return Array.from(out.values());
}

function filterByPlatform(rows: RawMetric[], platform: Platform) {
  return rows.filter((row) => inferPlatformFromIdentifier(row.asin) === platform);
}

async function fetchWeekRowsWithLegacyFallback(input: {
  supabase: ReturnType<typeof createClient>;
  accountId: string;
  weekStart: string;
  weekEnd: string;
}) {
  const { supabase, accountId, weekStart, weekEnd } = input;
  const baseSelect = "recorded_date, product_name, asin, bsr, review_count, rating, ppc_spend, ppc_sales, total_sales";

  const { data: rows, error } = await supabase
    .from("performance_metrics")
    .select(baseSelect)
    .eq("account_id", accountId)
    .gte("recorded_date", weekStart)
    .lte("recorded_date", weekEnd)
    .order("recorded_date", { ascending: true });
  if (error) throw error;
  if ((rows || []).length > 0) return rows || [];

  // Backward-compatibility for rows created before week-lock fix:
  // users entered last week's data during the next week, so recorded_date was next Monday.
  const fallbackStart = addDays(weekStart, 7);
  const fallbackEnd = addDays(weekEnd, 7);
  const { data: fallbackRows, error: fallbackError } = await supabase
    .from("performance_metrics")
    .select(baseSelect)
    .eq("account_id", accountId)
    .eq("recorded_date", fallbackStart)
    .gte("created_at", `${fallbackStart}T00:00:00`)
    .lte("created_at", `${fallbackEnd}T23:59:59`)
    .order("recorded_date", { ascending: true });
  if (fallbackError) throw fallbackError;
  return fallbackRows || [];
}

export async function GET(request: NextRequest) {
  try {
    const accountId = request.nextUrl.searchParams.get("accountId");
    const weekStart = request.nextUrl.searchParams.get("weekStart");
    const platformParam = request.nextUrl.searchParams.get("platform");
    const selectedPlatform = platformParam === "temu" || platformParam === "all" ? platformParam : "amazon";
    const emailMode = request.nextUrl.searchParams.get("email") === "1";
    if (!accountId || !weekStart) return new Response("Missing accountId or weekStart", { status: 400 });
    if (!isMonday(weekStart)) return new Response("weekStart must be Monday", { status: 400 });

    // Weekly report should always be a completed week.
    // If caller selects current/future week start, use the previous completed week.
    const currentMonday = currentMondayIsoUtc();
    const effectiveWeekStart = weekStart >= currentMonday ? addDays(currentMonday, -7) : weekStart;

    const supabase = createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return new Response("Unauthorized", { status: 401 });

    const weekEnd = addDays(effectiveWeekStart, 6);
    const previousWeekStart = addDays(effectiveWeekStart, -7);
    const previousWeekEnd = addDays(effectiveWeekStart, -1);

    const { data: account } = await supabase.from("accounts").select("id, name, logo_url").eq("id", accountId).maybeSingle();
    if (!account) return new Response("Account not found", { status: 404 });

    const [rows, previousRows] = await Promise.all([
      fetchWeekRowsWithLegacyFallback({
        supabase,
        accountId,
        weekStart: effectiveWeekStart,
        weekEnd,
      }),
      fetchWeekRowsWithLegacyFallback({
        supabase,
        accountId,
        weekStart: previousWeekStart,
        weekEnd: previousWeekEnd,
      }),
    ]);

    const currentRows = rows as RawMetric[];
    const previousWeekRows = previousRows as RawMetric[];

    const amazonRows = dedupeByKey(filterByPlatform(currentRows, "amazon"));
    const amazonPreviousRows = dedupeByKey(filterByPlatform(previousWeekRows, "amazon"));
    const temuRows = dedupeByKey(filterByPlatform(currentRows, "temu"));
    const temuPreviousRows = dedupeByKey(filterByPlatform(previousWeekRows, "temu"));

    const sections =
      selectedPlatform === "all"
        ? [
            { platform: "amazon" as const, rows: amazonRows, previousRows: amazonPreviousRows },
            { platform: "temu" as const, rows: temuRows, previousRows: temuPreviousRows },
          ]
        : selectedPlatform === "temu"
          ? [{ platform: "temu" as const, rows: temuRows, previousRows: temuPreviousRows }]
          : [{ platform: "amazon" as const, rows: amazonRows, previousRows: amazonPreviousRows }];

    const pdfBytes = await renderWeeklyPerformancePdfBuffer({
      accountName: account.name,
      accountLogoUrl: account.logo_url,
      weekStart: effectiveWeekStart,
      weekEnd,
      previousWeekStart,
      previousWeekEnd,
      sections: sections as never[],
    });

    const filename = `weekly-performance-${selectedPlatform}-${account.name.replace(/[^a-zA-Z0-9-]/g, "-")}-${effectiveWeekStart}.pdf`;

    if (emailMode) {
      if (!isEmailConfigured()) {
        return Response.json(
          { ok: false, error: "Email is not configured. Set RESEND_API_KEY in your environment." },
          { status: 503 }
        );
      }
      const recipients = await getClientRecipientsForAccount(supabase, accountId);
      if (recipients.length === 0) {
        return Response.json(
          { ok: false, error: "No client recipients are assigned to this account. Add one under Settings → Accounts Management." },
          { status: 400 }
        );
      }
      const weekLabel = formatPeriodLabel(effectiveWeekStart, weekEnd);
      const platformText = platformLabel(selectedPlatform);
      const totalProducts =
        selectedPlatform === "all"
          ? amazonRows.length + temuRows.length
          : selectedPlatform === "temu"
            ? temuRows.length
            : amazonRows.length;
      const result = await sendPdfEmail({
        recipients,
        accountName: account.name,
        periodLabel: `${platformText} • ${weekLabel}`,
        subject: `${account.name} — Weekly performance (${platformText}, ${weekLabel})`,
        intro: `Please find attached the weekly performance report for ${account.name} (${platformText}), covering ${weekLabel}. The previous week (${formatPeriodLabel(previousWeekStart, previousWeekEnd)}) is included for comparison.`,
        highlights: [
          `Products tracked this week: ${totalProducts}`,
          `Platform: ${platformText}`,
        ],
        pdfFilename: filename,
        pdfBuffer: pdfBytes,
      });
      return Response.json({ ok: true, ...result });
    }

    return new Response(Buffer.from(pdfBytes) as unknown as BodyInit, {
      status: 200,
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="${filename}"`,
      },
    });
  } catch (err) {
    return new Response(err instanceof Error ? err.message : "Weekly PDF export failed.", { status: 500 });
  }
}
