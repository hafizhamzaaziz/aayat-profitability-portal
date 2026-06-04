import { NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { renderReportPdfBuffer } from "@/lib/pdf/report-document";
import { computeExpenseOccurrencesForPeriod, type ExpenseLedgerRow } from "@/lib/reports/expense-ledger";
import { computeExpenseTotals } from "@/lib/reports/expense-totals";
import { getClientRecipientsForAccount, isEmailConfigured, sendPdfEmail } from "@/lib/email/mailer";
import { formatMoney, formatPeriodLabel, platformLabel } from "@/lib/email/format-helpers";

export const runtime = "nodejs";

export async function GET(
  request: NextRequest,
  { params }: { params: { reportId: string } }
) {
  const reportId = params.reportId;
  const notesQuery = (request.nextUrl.searchParams.get("notes") || "").trim();
  const emailMode = request.nextUrl.searchParams.get("email") === "1";

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

  const { data: ledgerRows } = await supabase
    .from("expense_ledger")
    .select("id, account_id, description, expense_date, amount, includes_vat, marketplace, expense_type, recurring_end_date")
    .eq("account_id", report.account_id)
    .lte("expense_date", report.period_end)
    .or(`recurring_end_date.is.null,recurring_end_date.gte.${report.period_start}`);
  const expenses = computeExpenseOccurrencesForPeriod({
    rows: (ledgerRows || []) as ExpenseLedgerRow[],
    platform: report.platform,
    periodStart: report.period_start,
    periodEnd: report.period_end,
  });
  const expenseTotals = computeExpenseTotals(
    expenses.map((e) => ({ amount: Number(e.amount || 0), includes_vat: Boolean(e.includes_vat) })),
    Number(account.vat_rate || 0)
  );
  const breakdownObj = (report.breakdown || {}) as {
    perSkuRollup?: { marketplaceNetProfitSum?: number; externalExpensesNet?: number };
  };
  const marketplaceOperatingProfit =
    typeof breakdownObj.perSkuRollup?.marketplaceNetProfitSum === "number"
      ? Number(breakdownObj.perSkuRollup.marketplaceNetProfitSum)
      : Number(report.net_profit || 0) + Number(breakdownObj.perSkuRollup?.externalExpensesNet || 0);
  const liveNetProfit = Number((marketplaceOperatingProfit - expenseTotals.net).toFixed(2));

  // Fetch performance metrics for both the current period and the immediately
  // preceding period of equal length, for month-vs-month comparison.
  const periodStartMs = new Date(`${report.period_start}T00:00:00Z`).getTime();
  const periodEndMs = new Date(`${report.period_end}T00:00:00Z`).getTime();
  const periodDays = Math.max(1, Math.round((periodEndMs - periodStartMs) / 86400000) + 1);
  const previousStart = new Date(periodStartMs - periodDays * 86400000).toISOString().slice(0, 10);
  const previousEnd = new Date(periodStartMs - 86400000).toISOString().slice(0, 10);

  const performanceFields =
    "recorded_date, product_name, asin, bsr, review_count, rating, ppc_spend, ppc_sales, total_sales";
  // Temu rows are stored in the same table and distinguished by a "TEMU:" asin
  // prefix. Keep only this platform's rows so an Amazon report never shows Temu
  // performance metrics (and vice versa).
  const matchesPlatform = (asin: unknown) => {
    const isTemu = String(asin || "").toUpperCase().startsWith("TEMU:");
    return report.platform === "temu" ? isTemu : !isTemu;
  };
  const [{ data: performance }, { data: performancePrevious }] =
    report.platform === "amazon"
      ? await Promise.all([
          supabase
            .from("performance_metrics")
            .select(performanceFields)
            .eq("account_id", report.account_id)
            .gte("recorded_date", report.period_start)
            .lte("recorded_date", report.period_end)
            .order("recorded_date", { ascending: false }),
          supabase
            .from("performance_metrics")
            .select(performanceFields)
            .eq("account_id", report.account_id)
            .gte("recorded_date", previousStart)
            .lte("recorded_date", previousEnd)
            .order("recorded_date", { ascending: false }),
        ])
      : [{ data: [] }, { data: [] }];

  const { data: skuRows } = await supabase
    .from("report_sku_breakdowns")
    .select("sku, description, units, net_sales, cogs, advertising_alloc, net_profit")
    .eq("report_id", report.id)
    .order("net_profit", { ascending: false });

  const { data: adMeta } =
    report.platform === "amazon"
      ? await supabase
          .from("report_ad_meta")
          .select("source_filename, total_spend_exvat, blank_sku_spend, matched_sku_count, unmatched_sku_count")
          .eq("report_id", report.id)
          .maybeSingle()
      : { data: null };

  const breakdownNotes =
    report.breakdown &&
    typeof (report.breakdown as { manualNotesPdf?: unknown }).manualNotesPdf === "string"
      ? String((report.breakdown as { manualNotesPdf: string }).manualNotesPdf).trim()
      : "";
  const notesForPdf = notesQuery || breakdownNotes;

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
      net_profit: liveNetProfit,
    },
    breakdown: report.breakdown ?? null,
    expenses: (expenses || []).map((e) => ({
      description: e.description,
      amount: Number(e.amount || 0),
      includes_vat: Boolean(e.includes_vat),
    })),
    performance: (performance || []).filter((p) => matchesPlatform(p.asin)).map((p) => ({
      recorded_date: p.recorded_date,
      product_name: p.product_name,
      bsr: p.bsr,
      review_count: p.review_count,
      rating: p.rating,
      ppc_spend: p.ppc_spend ?? null,
      ppc_sales: p.ppc_sales ?? null,
      total_sales: p.total_sales ?? null,
    })),
    performancePrevious: (performancePrevious || []).filter((p) => matchesPlatform(p.asin)).map((p) => ({
      recorded_date: p.recorded_date,
      product_name: p.product_name,
      bsr: p.bsr,
      review_count: p.review_count,
      rating: p.rating,
      ppc_spend: p.ppc_spend ?? null,
      ppc_sales: p.ppc_sales ?? null,
      total_sales: p.total_sales ?? null,
    })),
    skuLines: (skuRows || []).map((row) => ({
      sku: row.sku,
      description: row.description,
      units: Number(row.units || 0),
      netSales: Number(row.net_sales || 0),
      cogs: Number(row.cogs || 0),
      advertisingAlloc: Number(row.advertising_alloc || 0),
      netProfit: Number(row.net_profit || 0),
      netMargin: Number(row.net_sales) ? Number(row.net_profit || 0) / Number(row.net_sales) : 0,
    })),
    adMeta: adMeta
      ? {
          source_filename: adMeta.source_filename,
          total_spend_exvat: Number(adMeta.total_spend_exvat || 0),
          blank_sku_spend: Number(adMeta.blank_sku_spend || 0),
          matched_sku_count: Number(adMeta.matched_sku_count || 0),
          unmatched_sku_count: Number(adMeta.unmatched_sku_count || 0),
        }
      : null,
    notes: notesForPdf,
    warnings: Array.isArray((report.breakdown as { warnings?: unknown } | null)?.warnings)
      ? ((report.breakdown as { warnings: string[] }).warnings || []).map((w) => String(w))
      : [],
  });

  const filename = `profitability-report-${account.name.replace(/[^a-zA-Z0-9-]/g, "-")}-${report.platform}-${report.period_start}.pdf`;

  if (emailMode) {
    if (!isEmailConfigured()) {
      return Response.json(
        { ok: false, error: "Email is not configured. Set RESEND_API_KEY in your environment." },
        { status: 503 }
      );
    }
    const recipients = await getClientRecipientsForAccount(supabase, String(report.account_id));
    if (recipients.length === 0) {
      return Response.json(
        { ok: false, error: "No client recipients are assigned to this account. Add one under Settings → Accounts Management." },
        { status: 400 }
      );
    }
    const periodLabel = formatPeriodLabel(report.period_start, report.period_end);
    // Pull true product sales / order payments from the breakdown rather than
    // gross_sales (which represents Net Amazon Settlement / Net Temu Settlement).
    const salesLabel = report.platform === "amazon" ? "Product Sales" : "Order Payments";
    const summaryLines =
      ((report.breakdown as { summaryLines?: Array<{ label: string; value: number }> } | null)?.summaryLines) || [];
    const productSales = Number(
      summaryLines.find((line) => line.label === salesLabel)?.value ?? report.gross_sales ?? 0
    );
    const result = await sendPdfEmail({
      recipients,
      accountName: account.name,
      periodLabel: `${platformLabel(report.platform)} • ${periodLabel}`,
      subject: `${account.name} — ${platformLabel(report.platform)} profitability report (${periodLabel})`,
      intro: `Please find attached the ${platformLabel(report.platform)} profitability report for ${account.name} covering ${periodLabel}.`,
      highlights: [
        `Net profit: ${formatMoney(Number(liveNetProfit || 0), account.currency)}`,
        `${salesLabel}: ${formatMoney(productSales, account.currency)}`,
        `Total fees: ${formatMoney(Number(report.total_fees || 0), account.currency)}`,
      ],
      pdfFilename: filename,
      pdfBuffer: pdfBytes,
    });
    return Response.json({ ok: true, ...result });
  }

  const nodeBuffer = Buffer.from(pdfBytes);

  return new Response(nodeBuffer as unknown as BodyInit, {
    status: 200,
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="${filename}"`,
    },
  });
}
