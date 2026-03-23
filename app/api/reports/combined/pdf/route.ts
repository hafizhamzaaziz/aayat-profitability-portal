import { NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { renderReportPdfBuffer } from "@/lib/pdf/report-document";
import { addDays } from "@/lib/utils/date";

export const runtime = "nodejs";

type Breakdown = {
  platform: "amazon" | "temu";
  summaryLines: Array<{ label: string; value: number }>;
  settlementLabel: string;
  settlementValue: number;
  transferLabel: string;
  transferValue: number;
  pnl: { settlementNet: number; purchaseCost: number; netProfit: number };
  vat: { outputVat: number; inputVatFees: number; inputVatPurchases: number; finalVat: number };
};

function mergeBreakdowns(rows: Breakdown[]): Breakdown | null {
  if (!rows.length) return null;
  const base = rows[0];
  const summaryMap = new Map<string, number>();
  for (const row of rows) {
    for (const line of row.summaryLines || []) {
      summaryMap.set(line.label, (summaryMap.get(line.label) || 0) + Number(line.value || 0));
    }
  }
  return {
    platform: base.platform,
    summaryLines: Array.from(summaryMap.entries()).map(([label, value]) => ({ label, value })),
    settlementLabel: base.settlementLabel,
    settlementValue: rows.reduce((acc, r) => acc + Number(r.settlementValue || 0), 0),
    transferLabel: base.transferLabel,
    transferValue: rows.reduce((acc, r) => acc + Number(r.transferValue || 0), 0),
    pnl: {
      settlementNet: rows.reduce((acc, r) => acc + Number(r.pnl?.settlementNet || 0), 0),
      purchaseCost: rows.reduce((acc, r) => acc + Number(r.pnl?.purchaseCost || 0), 0),
      netProfit: rows.reduce((acc, r) => acc + Number(r.pnl?.netProfit || 0), 0),
    },
    vat: {
      outputVat: rows.reduce((acc, r) => acc + Number(r.vat?.outputVat || 0), 0),
      inputVatFees: rows.reduce((acc, r) => acc + Number(r.vat?.inputVatFees || 0), 0),
      inputVatPurchases: rows.reduce((acc, r) => acc + Number(r.vat?.inputVatPurchases || 0), 0),
      finalVat: rows.reduce((acc, r) => acc + Number(r.vat?.finalVat || 0), 0),
    },
  };
}

export async function POST(request: NextRequest) {
  const { reportIds, notes } = (await request.json()) as { reportIds?: string[]; notes?: string };
  if (!Array.isArray(reportIds) || reportIds.length < 2) return new Response("Select at least two reports.", { status: 400 });

  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return new Response("Unauthorized", { status: 401 });

  const { data: reports, error } = await supabase.from("reports").select("*").in("id", reportIds);
  if (error || !reports || reports.length !== reportIds.length) return new Response("Some reports were not found.", { status: 404 });

  const first = reports[0];
  if (reports.some((r) => r.platform !== first.platform)) return new Response("Cannot mix Amazon and Temu reports.", { status: 400 });
  if (reports.some((r) => r.account_id !== first.account_id)) return new Response("All reports must belong to same account.", { status: 400 });

  const sorted = [...reports].sort((a, b) => (a.period_start < b.period_start ? -1 : 1));
  for (let i = 1; i < sorted.length; i++) {
    const expectedStart = addDays(sorted[i - 1].period_end, 1);
    if (sorted[i].period_start !== expectedStart) {
      return new Response("Missing dates between selected reports.", { status: 400 });
    }
  }

  const { data: account } = await supabase.from("accounts").select("name, currency, logo_url").eq("id", first.account_id).single();
  if (!account) return new Response("Account not found", { status: 404 });

  const reportIdSet = sorted.map((r) => r.id);
  const { data: expenses } = await supabase
    .from("expenses")
    .select("description, amount, includes_vat")
    .in("report_id", reportIdSet)
    .order("created_at", { ascending: true });

  const { data: performance } =
    first.platform === "amazon"
      ? await supabase
          .from("performance_metrics")
          .select("recorded_date, product_name, bsr, review_count, rating")
          .eq("account_id", first.account_id)
          .gte("recorded_date", sorted[0].period_start)
          .lte("recorded_date", sorted[sorted.length - 1].period_end)
          .order("recorded_date", { ascending: false })
          .limit(12)
      : { data: [] };

  const breakdowns = sorted
    .map((r) => r.breakdown as Breakdown | null)
    .filter((x): x is Breakdown => Boolean(x));

  const mergedBreakdown = mergeBreakdowns(breakdowns);

  const pdfBytes = await renderReportPdfBuffer({
    accountName: account.name,
    accountLogoUrl: account.logo_url,
    currency: account.currency,
    platform: first.platform,
    periodStart: sorted[0].period_start,
    periodEnd: sorted[sorted.length - 1].period_end,
    report: {
      gross_sales: sorted.reduce((acc, r) => acc + Number(r.gross_sales || 0), 0),
      total_cogs: sorted.reduce((acc, r) => acc + Number(r.total_cogs || 0), 0),
      total_fees: sorted.reduce((acc, r) => acc + Number(r.total_fees || 0), 0),
      output_vat: sorted.reduce((acc, r) => acc + Number(r.output_vat || 0), 0),
      input_vat: sorted.reduce((acc, r) => acc + Number(r.input_vat || 0), 0),
      net_profit: sorted.reduce((acc, r) => acc + Number(r.net_profit || 0), 0),
    },
    breakdown: mergedBreakdown,
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
    notes: notes || "",
  });

  return new Response(Buffer.from(pdfBytes) as unknown as BodyInit, {
    status: 200,
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="combined-${account.name.replace(/[^a-zA-Z0-9-]/g, "-")}-${first.platform}.pdf"`,
    },
  });
}
