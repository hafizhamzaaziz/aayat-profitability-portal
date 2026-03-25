import { NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { renderWeeklyPerformancePdfBuffer } from "@/lib/pdf/performance-weekly-document";
import { addDays, currentMondayIsoUtc, isMonday } from "@/lib/utils/date";

export const runtime = "nodejs";

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

    const pdfBytes = await renderWeeklyPerformancePdfBuffer({
      accountName: account.name,
      accountLogoUrl: account.logo_url,
      weekStart: effectiveWeekStart,
      weekEnd,
      previousWeekStart,
      previousWeekEnd,
      rows: rows as never[],
      previousRows: previousRows as never[],
    });

    return new Response(Buffer.from(pdfBytes) as unknown as BodyInit, {
      status: 200,
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="weekly-performance-${account.name.replace(/[^a-zA-Z0-9-]/g, "-")}-${effectiveWeekStart}.pdf"`,
      },
    });
  } catch (err) {
    return new Response(err instanceof Error ? err.message : "Weekly PDF export failed.", { status: 500 });
  }
}
