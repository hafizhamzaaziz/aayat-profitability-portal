import { NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { renderReportPdfBuffer } from "@/lib/pdf/report-document";
import { addDays } from "@/lib/utils/date";
import { validateBreakdown, validatePeriodRange } from "@/lib/reports/guardrails";
import { computeExpenseOccurrencesForPeriod, type ExpenseLedgerRow } from "@/lib/reports/expense-ledger";
import { computeExpenseTotals } from "@/lib/reports/expense-totals";
import { getClientRecipientsForAccount, isEmailConfigured, sendPdfEmail } from "@/lib/email/mailer";
import { formatMoney, formatPeriodLabel, platformLabel } from "@/lib/email/format-helpers";

export const runtime = "nodejs";

type Breakdown = {
  platform: "amazon" | "temu";
  summaryLines: Array<{ label: string; value: number }>;
  settlementLabel: string;
  settlementValue: number;
  transferLabel: string;
  transferValue: number;
  pnl: {
    settlementNet: number;
    purchaseCost: number;
    netProfit: number;
    coreOperatingProfit?: number;
    adjustmentsNet?: number;
  };
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
      coreOperatingProfit: rows.reduce((acc, r) => acc + Number(r.pnl?.coreOperatingProfit || 0), 0),
      adjustmentsNet: rows.reduce((acc, r) => acc + Number(r.pnl?.adjustmentsNet || 0), 0),
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
  try {
    const { reportIds, notes, mode } = (await request.json()) as {
      reportIds?: string[];
      notes?: string;
      mode?: "download" | "email";
    };
    const emailMode = mode === "email";
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
    for (const report of sorted) {
      const rangeError = validatePeriodRange(String(report.period_start), String(report.period_end));
      if (rangeError) return new Response(`Invalid report period found: ${rangeError}`, { status: 400 });
    }
    for (let i = 1; i < sorted.length; i++) {
      const expectedStart = addDays(sorted[i - 1].period_end, 1);
      if (sorted[i].period_start !== expectedStart) {
        return new Response("Missing dates between selected reports.", { status: 400 });
      }
    }

    const { data: account } = await supabase.from("accounts").select("name, currency, vat_rate, logo_url").eq("id", first.account_id).single();
    if (!account) return new Response("Account not found", { status: 404 });

    const combinedStart = sorted[0].period_start;
    const combinedEnd = sorted[sorted.length - 1].period_end;
    const reportIdSet = sorted.map((r) => r.id);
    const { data: ledgerRows } = await supabase
      .from("expense_ledger")
      .select("id, account_id, description, expense_date, amount, includes_vat, marketplace, expense_type, recurring_end_date")
      .eq("account_id", first.account_id)
      .lte("expense_date", combinedEnd)
      .or(`recurring_end_date.is.null,recurring_end_date.gte.${combinedStart}`);
    const expenses = computeExpenseOccurrencesForPeriod({
      rows: (ledgerRows || []) as ExpenseLedgerRow[],
      platform: first.platform,
      periodStart: combinedStart,
      periodEnd: combinedEnd,
    });
    const expenseTotals = computeExpenseTotals(
      expenses.map((e) => ({ amount: Number(e.amount || 0), includes_vat: Boolean(e.includes_vat) })),
      Number(account.vat_rate || 0)
    );
    const marketplaceOperatingProfitSum = sorted.reduce((acc, r) => {
      const breakdown = (r.breakdown || {}) as {
        perSkuRollup?: { marketplaceNetProfitSum?: number; externalExpensesNet?: number };
      };
      const market =
        typeof breakdown.perSkuRollup?.marketplaceNetProfitSum === "number"
          ? Number(breakdown.perSkuRollup.marketplaceNetProfitSum)
          : Number(r.net_profit || 0) + Number(breakdown.perSkuRollup?.externalExpensesNet || 0);
      return acc + market;
    }, 0);
    const liveNetProfitCombined = Number((marketplaceOperatingProfitSum - expenseTotals.net).toFixed(2));
    const combinedStartMs = new Date(`${combinedStart}T00:00:00Z`).getTime();
    const combinedEndMs = new Date(`${combinedEnd}T00:00:00Z`).getTime();
    const combinedDays = Math.max(1, Math.round((combinedEndMs - combinedStartMs) / 86400000) + 1);
    const previousStart = new Date(combinedStartMs - combinedDays * 86400000).toISOString().slice(0, 10);
    const previousEnd = new Date(combinedStartMs - 86400000).toISOString().slice(0, 10);

    const performanceFields =
      "recorded_date, product_name, asin, bsr, review_count, rating, ppc_spend, ppc_sales, total_sales";
    // Temu rows share this table and are distinguished by a "TEMU:" asin prefix.
    // Keep only this platform's rows so the combined report never mixes platforms.
    const matchesPlatform = (asin: unknown) => {
      const isTemu = String(asin || "").toUpperCase().startsWith("TEMU:");
      return first.platform === "temu" ? isTemu : !isTemu;
    };
    const [{ data: performance }, { data: performancePrevious }] =
      first.platform === "amazon"
        ? await Promise.all([
            supabase
              .from("performance_metrics")
              .select(performanceFields)
              .eq("account_id", first.account_id)
              .gte("recorded_date", combinedStart)
              .lte("recorded_date", combinedEnd)
              .order("recorded_date", { ascending: false }),
            supabase
              .from("performance_metrics")
              .select(performanceFields)
              .eq("account_id", first.account_id)
              .gte("recorded_date", previousStart)
              .lte("recorded_date", previousEnd)
              .order("recorded_date", { ascending: false }),
          ])
        : [{ data: [] }, { data: [] }];

    // Aggregate per-SKU across all selected reports for the combined PDF
    const { data: combinedSkuRows } = await supabase
      .from("report_sku_breakdowns")
      .select("sku, description, units, net_sales, cogs, advertising_alloc, net_profit")
      .in("report_id", reportIdSet);
    const aggSku = new Map<
      string,
      { sku: string; description: string | null; units: number; netSales: number; cogs: number; advertisingAlloc: number; netProfit: number }
    >();
    for (const row of combinedSkuRows || []) {
      const key = String(row.sku);
      const existing = aggSku.get(key);
      if (existing) {
        existing.units += Number(row.units || 0);
        existing.netSales += Number(row.net_sales || 0);
        existing.cogs += Number(row.cogs || 0);
        existing.advertisingAlloc += Number(row.advertising_alloc || 0);
        existing.netProfit += Number(row.net_profit || 0);
      } else {
        aggSku.set(key, {
          sku: key,
          description: row.description ?? null,
          units: Number(row.units || 0),
          netSales: Number(row.net_sales || 0),
          cogs: Number(row.cogs || 0),
          advertisingAlloc: Number(row.advertising_alloc || 0),
          netProfit: Number(row.net_profit || 0),
        });
      }
    }
    const combinedSkuLines = Array.from(aggSku.values()).map((row) => ({
      ...row,
      netMargin: row.netSales !== 0 ? row.netProfit / row.netSales : 0,
    }));

    const breakdowns = sorted
      .map((r) => r.breakdown as Breakdown | null)
      .filter((x): x is Breakdown => Boolean(x));
    for (const breakdown of breakdowns) {
      const validation = validateBreakdown(first.platform as "amazon" | "temu", breakdown);
      if (validation) return new Response(`Invalid breakdown in selected reports: ${validation}`, { status: 400 });
    }

    const mergedBreakdown = mergeBreakdowns(breakdowns);

    const pdfBytes = await renderReportPdfBuffer({
      accountName: account.name,
      accountLogoUrl: account.logo_url,
      currency: account.currency,
      vatRate: Number(account.vat_rate || 0),
      platform: first.platform,
      periodStart: sorted[0].period_start,
      periodEnd: sorted[sorted.length - 1].period_end,
      report: {
        gross_sales: sorted.reduce((acc, r) => acc + Number(r.gross_sales || 0), 0),
        total_cogs: sorted.reduce((acc, r) => acc + Number(r.total_cogs || 0), 0),
        total_fees: sorted.reduce((acc, r) => acc + Number(r.total_fees || 0), 0),
        output_vat: sorted.reduce((acc, r) => acc + Number(r.output_vat || 0), 0),
        input_vat: sorted.reduce((acc, r) => acc + Number(r.input_vat || 0), 0),
        net_profit: liveNetProfitCombined,
      },
      breakdown: mergedBreakdown,
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
      skuLines: combinedSkuLines,
      adMeta: null,
      notes: notes || "",
      warnings: (() => {
        const seen = new Set<string>();
        const out: string[] = [];
        for (const r of sorted) {
          const list = (r.breakdown as { warnings?: unknown } | null)?.warnings;
          if (!Array.isArray(list)) continue;
          for (const w of list) {
            const s = String(w);
            if (!seen.has(s) && s.trim().length > 0) {
              seen.add(s);
              out.push(s);
            }
          }
        }
        return out;
      })(),
    });

    const filename = `combined-${account.name.replace(/[^a-zA-Z0-9-]/g, "-")}-${first.platform}-${combinedStart}-to-${combinedEnd}.pdf`;

    if (emailMode) {
      if (!isEmailConfigured()) {
        return Response.json(
          { ok: false, error: "Email is not configured. Set RESEND_API_KEY in your environment." },
          { status: 503 }
        );
      }
      const recipients = await getClientRecipientsForAccount(supabase, String(first.account_id));
      if (recipients.length === 0) {
        return Response.json(
          { ok: false, error: "No client recipients are assigned to this account. Add one under Settings → Accounts Management." },
          { status: 400 }
        );
      }
      const periodLabel = formatPeriodLabel(combinedStart, combinedEnd);
      // Pull true product sales / order payments from per-report breakdowns rather
      // than gross_sales (which is Net Amazon/Temu Settlement on the report screen).
      const salesLabel = first.platform === "amazon" ? "Product Sales" : "Order Payments";
      const productSalesTotal = sorted.reduce((acc, r) => {
        const lines =
          ((r.breakdown as { summaryLines?: Array<{ label: string; value: number }> } | null)?.summaryLines) || [];
        const fromBreakdown = lines.find((line) => line.label === salesLabel)?.value;
        return acc + Number(fromBreakdown ?? r.gross_sales ?? 0);
      }, 0);
      const result = await sendPdfEmail({
        recipients,
        accountName: account.name,
        periodLabel: `${platformLabel(first.platform)} • ${periodLabel}`,
        subject: `${account.name} — ${platformLabel(first.platform)} combined profitability report (${periodLabel})`,
        intro: `Please find attached the combined ${platformLabel(first.platform)} profitability report for ${account.name}, covering ${periodLabel} (${sorted.length} consecutive periods).`,
        highlights: [
          `Net profit: ${formatMoney(liveNetProfitCombined, account.currency)}`,
          `${salesLabel}: ${formatMoney(productSalesTotal, account.currency)}`,
          `Reports combined: ${sorted.length}`,
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
    return new Response(err instanceof Error ? err.message : "Failed to generate combined PDF.", { status: 500 });
  }
}
