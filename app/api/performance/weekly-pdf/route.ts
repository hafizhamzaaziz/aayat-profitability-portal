import { NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { renderWeeklyPerformancePdfBuffer } from "@/lib/pdf/performance-weekly-document";
import { addDays, isMonday } from "@/lib/utils/date";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  try {
    const accountId = request.nextUrl.searchParams.get("accountId");
    const weekStart = request.nextUrl.searchParams.get("weekStart");
    if (!accountId || !weekStart) return new Response("Missing accountId or weekStart", { status: 400 });
    if (!isMonday(weekStart)) return new Response("weekStart must be Monday", { status: 400 });

    const supabase = createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return new Response("Unauthorized", { status: 401 });

    const weekEnd = addDays(weekStart, 6);
    const previousWeekStart = addDays(weekStart, -7);
    const previousWeekEnd = addDays(weekStart, -1);

    const { data: account } = await supabase.from("accounts").select("id, name, logo_url").eq("id", accountId).maybeSingle();
    if (!account) return new Response("Account not found", { status: 404 });

    const { data: rows, error: rowsError } = await supabase
      .from("performance_metrics")
      .select("recorded_date, product_name, asin, bsr, review_count, rating, ppc_spend, ppc_sales, total_sales")
      .eq("account_id", accountId)
      .gte("recorded_date", weekStart)
      .lte("recorded_date", weekEnd)
      .order("recorded_date", { ascending: true });
    if (rowsError) return new Response(rowsError.message, { status: 500 });

    const { data: previousRows, error: previousError } = await supabase
      .from("performance_metrics")
      .select("recorded_date, product_name, asin, bsr, review_count, rating, ppc_spend, ppc_sales, total_sales")
      .eq("account_id", accountId)
      .gte("recorded_date", previousWeekStart)
      .lte("recorded_date", previousWeekEnd)
      .order("recorded_date", { ascending: true });
    if (previousError) return new Response(previousError.message, { status: 500 });

    const pdfBytes = await renderWeeklyPerformancePdfBuffer({
      accountName: account.name,
      accountLogoUrl: account.logo_url,
      weekStart,
      weekEnd,
      rows: (rows || []) as never[],
      previousRows: (previousRows || []) as never[],
    });

    return new Response(Buffer.from(pdfBytes) as unknown as BodyInit, {
      status: 200,
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="weekly-performance-${account.name.replace(/[^a-zA-Z0-9-]/g, "-")}-${weekStart}.pdf"`,
      },
    });
  } catch (err) {
    return new Response(err instanceof Error ? err.message : "Weekly PDF export failed.", { status: 500 });
  }
}
