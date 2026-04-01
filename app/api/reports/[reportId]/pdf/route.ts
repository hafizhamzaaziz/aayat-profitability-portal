import { NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { renderReportPdfBuffer } from "@/lib/pdf/report-document";

export const runtime = "nodejs";

export async function GET(
  request: NextRequest,
  { params }: { params: { reportId: string } }
) {
  const reportId = params.reportId;
  const notes = request.nextUrl.searchParams.get("notes") || "";

  const supabase = createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return new Response("Unauthorized", { status: 401 });
  }

  const { data: report, error: reportError } = await supabase
    .from("reports")
    .select("*")
    .eq("id", reportId)
    .single();

  if (reportError || !report) {
    return new Response("Report not found", { status: 404 });
  }

  const { data: account } = await supabase
    .from("accounts")
    .select("id, name, currency, vat_rate, logo_url")
    .eq("id", report.account_id)
    .single();

  if (!account) {
    return new Response("Account not found", { status: 404 });
  }

  const { data: expenses } = await supabase
    .from("expenses")
    .select("description, amount, includes_vat")
    .eq("report_id", report.id)
    .order("created_at", { ascending: true });

  const { data: performance } =
    report.platform === "amazon"
      ? await supabase
          .from("performance_metrics")
          .select("recorded_date, product_name, bsr, review_count, rating")
          .eq("account_id", report.account_id)
          .gte("recorded_date", report.period_start)
          .lte("recorded_date", report.period_end)
          .order("recorded_date", { ascending: false })
          .limit(12)
      : { data: [] };

  const pdfBytes = await renderReportPdfBuffer({
    accountName: account.name,
    accountLogoUrl: account.logo_url,
    currency: account.currency,
    vatRate: Number(account.vat_rate || 0),
    platform: report.platform,
    periodStart: report.period_start,
    periodEnd: report.period_end,
    report: {
      gross_sales: Number(report.gross_sales || 0),
      total_cogs: Number(report.total_cogs || 0),
      total_fees: Number(report.total_fees || 0),
      output_vat: Number(report.output_vat || 0),
      input_vat: Number(report.input_vat || 0),
      net_profit: Number(report.net_profit || 0),
    },
    breakdown: report.breakdown ?? null,
    expenses: (expenses || []).map((e) => ({
      description: e.description,
      amount: Number(e.amount || 0),
      includes_vat: Boolean(e.includes_vat),
    })),
    performance: (performance || []).map((p) => ({
      recorded_date: p.recorded_date,
      product_name: p.product_name,
      bsr: p.bsr,
      review_count: p.review_count,
      rating: p.rating,
    })),
    notes,
  });

  const filename = `profitability-report-${account.name.replace(/[^a-zA-Z0-9-]/g, "-")}-${report.platform}.pdf`;

  const nodeBuffer = Buffer.from(pdfBytes);

  return new Response(nodeBuffer as unknown as BodyInit, {
    status: 200,
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="${filename}"`,
    },
  });
}
