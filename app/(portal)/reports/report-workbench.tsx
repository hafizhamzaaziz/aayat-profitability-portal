"use client";

import { useEffect, useMemo, useState } from "react";
import Papa from "papaparse";
import * as XLSX from "xlsx";
import { createClient } from "@/lib/supabase/client";
import { pushClientNotification } from "@/lib/notifications/client";
import { deriveReportWarnings, validateBreakdown, validatePeriodRange } from "@/lib/reports/guardrails";
import FileDropzone from "@/components/ui/file-dropzone";

type Platform = "amazon" | "temu";

type RowData = Record<string, unknown>;

type ExpenseRow = {
  id: string;
  description: string;
  amount: string;
  includesVat: boolean;
};

type CalculationPreview = {
  grossSales: number;
  totalCogs: number;
  totalFees: number;
  outputVat: number;
  inputVat: number;
  netProfit: number;
  unitsSold: number;
  missingSkus: string[];
  cogsSnapshot: CogsSnapshotEntry[];
  breakdown: {
    platform: Platform;
    summaryLines: Array<{ label: string; value: number }>;
    settlementLabel: string;
    settlementValue: number;
    transferLabel: string;
    transferValue: number;
    pnl: {
      settlementNet: number;
      purchaseCost: number;
      netProfit: number;
    };
    vat: {
      outputVat: number;
      inputVatFees: number;
      inputVatPurchases: number;
      finalVat: number;
    };
  };
};

type CogsVersion = {
  unitCost: number;
  includesVat: boolean;
  effectiveFrom: string;
};

type CogsLookup = Map<string, CogsVersion[]>;

type CogsSnapshotEntry = {
  sku: string;
  quantity: number;
  unit_cost: number;
  includes_vat: boolean;
  effective_from: string;
};

type ReportTransactionPayload = {
  account_id: string;
  report_id: string;
  platform: Platform;
  transaction_date: string | null;
  sku: string | null;
  quantity: number | null;
  raw_row: RowData;
};

type Props = {
  account: {
    id: string;
    name: string;
    currency: string;
    vat_rate: number;
  };
  canProcess: boolean;
};

function parseMoney(value: unknown) {
  if (value === null || value === undefined || value === "") return 0;
  const cleaned = String(value).replace(/[^0-9.-]/g, "");
  return Number.parseFloat(cleaned) || 0;
}

function norm(value: unknown) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function findHeaderExact(row: RowData, target: string) {
  return Object.keys(row).find((key) => norm(key) === target);
}

function findHeaderIncludes(row: RowData, term: string) {
  return Object.keys(row).find((key) => norm(key).includes(term));
}

function findHeaderAnyIncludes(row: RowData, terms: string[]) {
  return Object.keys(row).find((key) => {
    const n = norm(key);
    return terms.some((term) => n.includes(term));
  });
}

function autoPickHeader(headers: string[], terms: string[]) {
  const hit = headers.find((header) => {
    const n = norm(header).replace(/[^a-z]/g, "");
    return terms.some((term) => n.includes(term));
  });
  return hit ?? "";
}

function toIsoDate(input: unknown): string | null {
  if (input == null) return null;
  if (typeof input === "number" && Number.isFinite(input) && input > 1000) {
    // Excel serial date fallback
    const epoch = new Date(Date.UTC(1899, 11, 30));
    const date = new Date(epoch.getTime() + input * 24 * 60 * 60 * 1000);
    return date.toISOString().slice(0, 10);
  }
  const text = String(input).trim();
  if (!text) return null;

  const iso = text.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;

  const dmy = text.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})/);
  if (dmy) {
    const day = Number(dmy[1]);
    const month = Number(dmy[2]);
    const yearRaw = Number(dmy[3]);
    const year = yearRaw < 100 ? 2000 + yearRaw : yearRaw;
    if (day >= 1 && day <= 31 && month >= 1 && month <= 12) {
      return `${year.toString().padStart(4, "0")}-${month.toString().padStart(2, "0")}-${day.toString().padStart(2, "0")}`;
    }
  }

  const dmyDots = text.match(/^(\d{1,2})\.(\d{1,2})\.(\d{2,4})/);
  if (dmyDots) {
    const day = Number(dmyDots[1]);
    const month = Number(dmyDots[2]);
    const yearRaw = Number(dmyDots[3]);
    const year = yearRaw < 100 ? 2000 + yearRaw : yearRaw;
    if (day >= 1 && day <= 31 && month >= 1 && month <= 12) {
      return `${year.toString().padStart(4, "0")}-${month.toString().padStart(2, "0")}-${day.toString().padStart(2, "0")}`;
    }
  }

  const parsed = new Date(text);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString().slice(0, 10);
}

function extractTransactionDate(row: RowData, fallbackIso: string): string {
  const preferred = Object.keys(row).filter((key) => {
    const n = norm(key);
    return (
      n.includes("date") ||
      n.includes("posted") ||
      n.includes("transaction time") ||
      n.includes("order time") ||
      n.includes("settlement")
    );
  });
  for (const key of preferred) {
    const parsed = toIsoDate(row[key]);
    if (parsed) return parsed;
  }
  return fallbackIso;
}

function resolveCogsVersion(cogsLookup: CogsLookup, sku: string, txDateIso: string) {
  const versions = cogsLookup.get(sku);
  if (!versions || versions.length === 0) return null;
  let selected: CogsVersion | null = null;
  for (const version of versions) {
    if (version.effectiveFrom <= txDateIso) {
      selected = version;
    } else {
      break;
    }
  }
  // If no version existed yet on transaction date, fallback to earliest known cost.
  return selected || versions[0] || null;
}

function normalizeReportTransactions(input: {
  rows: RowData[];
  skuCol: string;
  qtyCol: string;
  periodStartIso: string;
  reportId: string;
  accountId: string;
  platform: Platform;
}) {
  return input.rows.map((row) => {
    const selectedSku = String(row[input.skuCol] ?? "")
      .trim()
      .toUpperCase();
    const fallbackSkuKey =
      input.platform === "temu"
        ? findHeaderAnyIncludes(row, ["sku id", "skuid", "temu sku"])
        : findHeaderAnyIncludes(row, ["sku", "seller sku", "merchant sku", "msku"]);
    const fallbackSku = fallbackSkuKey
      ? String(row[fallbackSkuKey] ?? "")
          .trim()
          .toUpperCase()
      : "";
    const sku = input.platform === "temu" ? (fallbackSku || selectedSku) : (selectedSku || fallbackSku);
    const qty = parseMoney(row[input.qtyCol]);
    const txDate = extractTransactionDate(row, input.periodStartIso);
    return {
      account_id: input.accountId,
      report_id: input.reportId,
      platform: input.platform,
      transaction_date: txDate || null,
      sku: sku || null,
      quantity: Number.isFinite(qty) ? qty : null,
      raw_row: row,
    } as ReportTransactionPayload;
  });
}

function computeExpenses(expenses: ExpenseRow[], vatRatePct: number) {
  const vatRate = vatRatePct / 100;
  let net = 0;
  let vat = 0;

  for (const row of expenses) {
    const amount = parseMoney(row.amount);
    if (!amount) continue;

    if (row.includesVat) {
      const vatPart = amount * (vatRate / (1 + vatRate));
      vat += vatPart;
      net += amount - vatPart;
    } else {
      net += amount;
    }
  }

  return { net, vat };
}

function processTemu(
  rows: RowData[],
  skuCol: string,
  qtyCol: string,
  cogsLookup: CogsLookup,
  vatRatePct: number,
  expenses: { net: number; vat: number },
  periodStartIso: string
): CalculationPreview {
  const summary = {
    orders: 0,
    refunds: 0,
    shippingCredits: 0,
    shippingLabels: 0,
    serviceFees: 0,
    penalties: 0,
    other: 0,
    purchaseCost: 0,
    chargebacks: 0,
    sellerRepayment: 0,
    transfers: 0,
    unitsSold: 0,
    purchaseVatFromCogs: 0,
  };

  const missingSkus = new Set<string>();
  const cogsSnapshotMap = new Map<string, CogsSnapshotEntry>();

  for (const row of rows) {
    const typeCol =
      findHeaderExact(row, "transaction type") ||
      findHeaderExact(row, "type") ||
      findHeaderIncludes(row, "transaction type") ||
      findHeaderAnyIncludes(row, ["type"]);
    const amountCol =
      findHeaderExact(row, "total") ||
      findHeaderExact(row, "amount") ||
      findHeaderIncludes(row, "total") ||
      findHeaderIncludes(row, "amount") ||
      findHeaderAnyIncludes(row, ["settlement", "cash", "payment amount"]);
    const serviceFeeCol = findHeaderIncludes(row, "service fee") || findHeaderAnyIncludes(row, ["service fee"]);

    if (!typeCol || !amountCol) continue;

    const type = norm(row[typeCol]).replace(/\s+/g, " ");
    const amount = parseMoney(row[amountCol]);
    const fee = serviceFeeCol ? parseMoney(row[serviceFeeCol]) : 0;

    if (type.includes("order payment") || type === "order" || type.includes("refund")) {
      const sku = String(row[skuCol] ?? "").trim().toUpperCase();
      const qty = parseMoney(row[qtyCol]);
      const txDateIso = extractTransactionDate(row, periodStartIso);

      if ((type.includes("order payment") || type === "order") && sku && qty > 0) {
        summary.unitsSold += Math.abs(qty);
        const cogs = resolveCogsVersion(cogsLookup, sku, txDateIso);
        if (cogs) {
          const snapshotKey = `${sku}|${cogs.unitCost}|${cogs.includesVat ? "1" : "0"}|${cogs.effectiveFrom}`;
          cogsSnapshotMap.set(snapshotKey, {
            sku,
            quantity: (cogsSnapshotMap.get(snapshotKey)?.quantity || 0) + Math.abs(qty),
            unit_cost: cogs.unitCost,
            includes_vat: cogs.includesVat,
            effective_from: cogs.effectiveFrom,
          });
          if (cogs.includesVat) {
            const unitNet = cogs.unitCost / (1 + vatRatePct / 100);
            const unitVat = cogs.unitCost - unitNet;
            summary.purchaseCost += unitNet * Math.abs(qty);
            summary.purchaseVatFromCogs += unitVat * Math.abs(qty);
          } else {
            summary.purchaseCost += cogs.unitCost * Math.abs(qty);
          }
        } else {
          missingSkus.add(sku);
        }
      }
    }

    summary.serviceFees += fee;

    if (type.includes("order payment") || type === "order") summary.orders += amount;
    else if (type.includes("refund")) summary.refunds += amount;
    else if (type.includes("return shipping credit")) summary.shippingCredits += amount;
    else if (type.includes("shipping label") || type.includes("shippinglabel") || type.includes("shipping adjustment")) summary.shippingLabels += amount;
    else if (type.includes("chargeback")) summary.chargebacks += amount;
    else if (type.includes("deduction") || type.includes("penalty") || type.includes("penalties")) summary.penalties += amount;
    else if (type.includes("seller repayment")) summary.sellerRepayment += amount;
    else if (type.includes("transfer")) summary.transfers += amount;
    else summary.other += amount;
  }

  const vatRate = vatRatePct / 100;
  const vatFraction = vatRatePct / (100 + vatRatePct);

  const grossSettlement =
    summary.orders +
    summary.refunds +
    summary.shippingCredits +
    summary.shippingLabels +
    summary.serviceFees +
    summary.penalties +
    summary.chargebacks +
    summary.other;

  const outputVat = grossSettlement * vatFraction;
  const settlementNet = grossSettlement - outputVat;

  const purchaseVat = summary.purchaseVatFromCogs || summary.purchaseCost * vatRate;
  const inputVat = purchaseVat + expenses.vat;
  const finalVat = outputVat - inputVat;
  const netProfit = settlementNet - summary.purchaseCost - expenses.net;

  const totalFees =
    Math.abs(summary.shippingLabels) +
    Math.abs(summary.serviceFees) +
    Math.abs(summary.penalties) +
    Math.abs(summary.chargebacks);

  return {
    grossSales: grossSettlement,
    totalCogs: summary.purchaseCost,
    totalFees,
    outputVat,
    inputVat,
    netProfit,
    unitsSold: summary.unitsSold,
    missingSkus: Array.from(missingSkus),
    cogsSnapshot: Array.from(cogsSnapshotMap.values()),
    breakdown: {
      platform: "temu",
      summaryLines: [
        { label: "Order Payments", value: summary.orders },
        { label: "Return Shipping Credit", value: summary.shippingCredits },
        { label: "Refunds", value: summary.refunds },
        { label: "Service Fees", value: summary.serviceFees },
        { label: "Shipping Labels & Adjustments", value: summary.shippingLabels },
        { label: "Chargebacks", value: summary.chargebacks },
        { label: "Penalties", value: summary.penalties },
        { label: "Seller Repayment", value: summary.sellerRepayment },
      ],
      settlementLabel: "Gross Settlement (Cash)",
      settlementValue: grossSettlement,
      transferLabel: "Transfers",
      transferValue: summary.transfers,
      pnl: {
        settlementNet,
        purchaseCost: summary.purchaseCost,
        netProfit,
      },
      vat: {
        outputVat,
        inputVatFees: 0,
        inputVatPurchases: purchaseVat + expenses.vat,
        finalVat,
      },
    },
  };
}

function processAmazon(
  rows: RowData[],
  skuCol: string,
  qtyCol: string,
  cogsLookup: CogsLookup,
  vatRatePct: number,
  expenses: { net: number; vat: number },
  periodStartIso: string
): CalculationPreview {
  const vatRate = vatRatePct / 100;

  const extractTax = (gross: number) => {
    const net = gross / (1 + vatRate);
    const tax = gross - net;
    return { net, tax };
  };

  const summary = {
    grossCash: 0,
    salesNet: 0,
    sellingFeesNet: 0,
    fbaFeesNet: 0,
    otherTransFeesNet: 0,
    adCostNet: 0,
    serviceFeesNet: 0,
    deliveryNet: 0,
    adjustments: 0,
    refunds: 0,
    transfersToBank: 0,
    fbaInventoryFeeNet: 0,
    purchaseCost: 0,
    inputVatFees: 0,
    netTaxCollected: 0,
    unitsSold: 0,
    purchaseVatFromCogs: 0,
  };

  const missingSkus = new Set<string>();
  const cogsSnapshotMap = new Map<string, CogsSnapshotEntry>();

  for (const row of rows) {
    const getVal = (target: string) => {
      const key = findHeaderExact(row, target);
      return key ? parseMoney(row[key]) : 0;
    };

    const typeKey = findHeaderExact(row, "type") || findHeaderIncludes(row, "transaction type");
    const type = typeKey ? norm(row[typeKey]) : "";
    if (!type) continue;

    const total = getVal("total");
    if (type !== "transfer") summary.grossCash += total;

    if (type === "order") {
      summary.salesNet += getVal("product sales");

      const sell = extractTax(getVal("selling fees"));
      summary.sellingFeesNet += sell.net;
      summary.inputVatFees += Math.abs(sell.tax);

      const fba = extractTax(getVal("fba fees"));
      summary.fbaFeesNet += fba.net;
      summary.inputVatFees += Math.abs(fba.tax);

      const otherT = extractTax(getVal("other transaction fees"));
      summary.otherTransFeesNet += otherT.net;
      summary.inputVatFees += Math.abs(otherT.tax);

      const sku = String(row[skuCol] ?? "").trim().toUpperCase();
      const qty = parseMoney(row[qtyCol]);
      const txDateIso = extractTransactionDate(row, periodStartIso);
      if (sku && qty > 0) {
        summary.unitsSold += qty;
        const cogs = resolveCogsVersion(cogsLookup, sku, txDateIso);
        if (cogs) {
          const snapshotKey = `${sku}|${cogs.unitCost}|${cogs.includesVat ? "1" : "0"}|${cogs.effectiveFrom}`;
          cogsSnapshotMap.set(snapshotKey, {
            sku,
            quantity: (cogsSnapshotMap.get(snapshotKey)?.quantity || 0) + qty,
            unit_cost: cogs.unitCost,
            includes_vat: cogs.includesVat,
            effective_from: cogs.effectiveFrom,
          });
          if (cogs.includesVat) {
            const unitNet = cogs.unitCost / (1 + vatRatePct / 100);
            const unitVat = cogs.unitCost - unitNet;
            summary.purchaseCost += unitNet * qty;
            summary.purchaseVatFromCogs += unitVat * qty;
          } else {
            summary.purchaseCost += cogs.unitCost * qty;
          }
        } else {
          missingSkus.add(sku);
        }
      }
    } else if (type === "refund" || type === "a-to-z guarantee claim") {
      summary.refunds += getVal("product sales");

      const sell = extractTax(getVal("selling fees"));
      summary.sellingFeesNet += sell.net;
      summary.inputVatFees -= sell.tax;

      const fba = extractTax(getVal("fba fees"));
      summary.fbaFeesNet += fba.net;
      summary.inputVatFees -= fba.tax;
    } else if (type === "service fee") {
      summary.serviceFeesNet += getVal("other transaction fees");
      summary.inputVatFees += Math.abs(getVal("other"));
    } else if (type === "delivery services") {
      const del = extractTax(getVal("other"));
      summary.deliveryNet += del.net;
      summary.inputVatFees -= del.tax;
    } else if (type === "fba inventory fee") {
      summary.fbaInventoryFeeNet += getVal("other transaction fees");
      summary.fbaInventoryFeeNet += getVal("other");
    } else if (type === "adjustment") {
      summary.adjustments += getVal("shipping credits");
      summary.adjustments += getVal("gift wrap credits");
      summary.adjustments += getVal("promotional rebates");
      summary.adjustments += getVal("other");
      summary.adjustments += getVal("other transaction fees");
    } else if (type === "transfer") {
      summary.transfersToBank += total;
    }

    summary.netTaxCollected += getVal("product sales tax");
  }

  const settlementNet = summary.grossCash - summary.netTaxCollected + summary.inputVatFees;
  const purchaseVat = summary.purchaseVatFromCogs || summary.purchaseCost * vatRate;
  const outputVat = summary.netTaxCollected;
  const inputVat = summary.inputVatFees + purchaseVat + expenses.vat;
  const finalVat = outputVat - inputVat;
  const netProfit = settlementNet - summary.purchaseCost - expenses.net;

  const totalFees =
    Math.abs(summary.sellingFeesNet) +
    Math.abs(summary.fbaFeesNet) +
    Math.abs(summary.otherTransFeesNet) +
    Math.abs(summary.fbaInventoryFeeNet) +
    Math.abs(summary.serviceFeesNet) +
    Math.abs(summary.deliveryNet);

  return {
    grossSales: summary.grossCash,
    totalCogs: summary.purchaseCost,
    totalFees,
    outputVat,
    inputVat,
    netProfit,
    unitsSold: summary.unitsSold,
    missingSkus: Array.from(missingSkus),
    cogsSnapshot: Array.from(cogsSnapshotMap.values()),
    breakdown: {
      platform: "amazon",
      summaryLines: [
        { label: "Product Sales", value: summary.salesNet },
        { label: "Refunds on Sales", value: summary.refunds },
        { label: "Adjustments & Credits", value: summary.adjustments },
        { label: "Selling Fees", value: summary.sellingFeesNet },
        { label: "FBA Fees", value: summary.fbaFeesNet },
        { label: "FBA Inventory Fee", value: summary.fbaInventoryFeeNet },
        { label: "Other Transaction Fees", value: summary.otherTransFeesNet },
        { label: "Delivery Services", value: summary.deliveryNet },
        { label: "Service Fees", value: summary.serviceFeesNet },
      ],
      settlementLabel: "Net Amazon Settlement",
      settlementValue: settlementNet,
      transferLabel: "Transfers to Bank",
      transferValue: summary.transfersToBank,
      pnl: {
        settlementNet,
        purchaseCost: summary.purchaseCost,
        netProfit,
      },
      vat: {
        outputVat,
        inputVatFees: summary.inputVatFees,
        inputVatPurchases: purchaseVat + expenses.vat,
        finalVat,
      },
    },
  };
}

export default function ReportWorkbench({ account, canProcess }: Props) {
  const todayIso = new Date().toISOString().slice(0, 10);
  const [platform, setPlatform] = useState<Platform>("amazon");
  const [periodStart, setPeriodStart] = useState("");
  const [periodEnd, setPeriodEnd] = useState("");
  const [headers, setHeaders] = useState<string[]>([]);
  const [rows, setRows] = useState<RowData[]>([]);
  const [skuCol, setSkuCol] = useState("");
  const [qtyCol, setQtyCol] = useState("");
  const [fileName, setFileName] = useState("");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<CalculationPreview | null>(null);
  const [expenses, setExpenses] = useState<ExpenseRow[]>([]);
  const [warnings, setWarnings] = useState<string[]>([]);

  const currency = account.currency || "£";

  const canCalculate = useMemo(() => {
    return (
      canProcess &&
      Boolean(periodStart) &&
      Boolean(periodEnd) &&
      rows.length > 0 &&
      Boolean(skuCol) &&
      Boolean(qtyCol)
    );
  }, [canProcess, periodEnd, periodStart, qtyCol, rows.length, skuCol]);

  const previewProductSales = useMemo(() => {
    if (!preview) return 0;
    const label = platform === "amazon" ? "Product Sales" : "Order Payments";
    const fromBreakdown = preview.breakdown.summaryLines.find((line) => line.label === label)?.value;
    return Number(fromBreakdown ?? preview.grossSales ?? 0);
  }, [preview, platform]);

  useEffect(() => {
    if (!headers.length) return;
    const temuSku = autoPickHeader(headers, ["skuid", "temuskuid"]);
    const genericSku = autoPickHeader(headers, ["sku", "asin", "itemid", "reference"]);
    setSkuCol(platform === "temu" ? (temuSku || genericSku) : genericSku);
    setQtyCol(autoPickHeader(headers, ["qty", "quantity", "units"]));
  }, [platform, headers]);

  const parseFile = async (file: File): Promise<RowData[]> => {
    if (file.name.toLowerCase().endsWith(".csv")) {
      return new Promise<RowData[]>((resolve, reject) => {
        Papa.parse<RowData>(file, {
          header: true,
          skipEmptyLines: true,
          complete: (result) => resolve(result.data),
          error: reject,
        });
      });
    }

    const buffer = await file.arrayBuffer();
    const workbook = XLSX.read(buffer, { type: "array" });
    const firstSheet = workbook.SheetNames[0];
    return XLSX.utils.sheet_to_json<RowData>(workbook.Sheets[firstSheet], { defval: "" });
  };

  const onFileChange = async (file: File | null) => {
    if (!file) return;

    setLoading(true);
    setError(null);
    setMessage(null);
    setPreview(null);

    try {
      const parsedRows = await parseFile(file);
      if (!parsedRows.length) {
        throw new Error("File appears to be empty.");
      }

      const nextHeaders = Object.keys(parsedRows[0]);
      setRows(parsedRows);
      setHeaders(nextHeaders);
      setFileName(file.name);
      const temuSku = autoPickHeader(nextHeaders, ["skuid", "temuskuid"]);
      const genericSku = autoPickHeader(nextHeaders, ["sku", "asin", "itemid", "reference"]);
      setSkuCol(platform === "temu" ? (temuSku || genericSku) : genericSku);
      setQtyCol(autoPickHeader(nextHeaders, ["qty", "quantity", "units"]));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to parse file.");
      setRows([]);
      setHeaders([]);
      setFileName("");
      setSkuCol("");
      setQtyCol("");
    } finally {
      setLoading(false);
    }
  };

  const addExpense = () => {
    setExpenses((prev) => [
      ...prev,
      {
        id: crypto.randomUUID(),
        description: "",
        amount: "",
        includesVat: false,
      },
    ]);
  };

  const updateExpense = (id: string, patch: Partial<ExpenseRow>) => {
    setExpenses((prev) => prev.map((expense) => (expense.id === id ? { ...expense, ...patch } : expense)));
  };

  const removeExpense = (id: string) => {
    setExpenses((prev) => prev.filter((expense) => expense.id !== id));
  };

  const runCalculation = async () => {
    if (!canCalculate) return;

    setError(null);
    setMessage(null);
    setLoading(true);
    setWarnings([]);

    try {
      const rangeError = validatePeriodRange(periodStart, periodEnd);
      if (rangeError) throw new Error(rangeError);

      const supabase = createClient();
      const [{ data: cogsRows, error: cogsError }, { data: historyRows, error: historyError }] = await Promise.all([
        supabase.from("cogs").select("sku, unit_cost, includes_vat, effective_from").eq("account_id", account.id),
        supabase
          .from("cogs_history")
          .select("sku, unit_cost, includes_vat, effective_from")
          .eq("account_id", account.id)
          .order("effective_from", { ascending: true }),
      ]);

      if (cogsError) throw cogsError;
      if (historyError) throw historyError;

      const cogsLookup: CogsLookup = new Map();
      (historyRows || []).forEach((row) => {
        const sku = String(row.sku).trim().toUpperCase();
        const list = cogsLookup.get(sku) || [];
        list.push({
          unitCost: Number(row.unit_cost) || 0,
          includesVat: Boolean(row.includes_vat),
          effectiveFrom: String(row.effective_from || todayIso),
        });
        cogsLookup.set(sku, list);
      });
      (cogsRows || []).forEach((row) => {
        const sku = String(row.sku).trim().toUpperCase();
        if (!sku || cogsLookup.has(sku)) return;
        cogsLookup.set(sku, [
          {
            unitCost: Number(row.unit_cost) || 0,
            includesVat: Boolean(row.includes_vat),
            effectiveFrom: String(row.effective_from || todayIso),
          },
        ]);
      });
      cogsLookup.forEach((versions, sku) => {
        const dedup = new Map<string, CogsVersion>();
        versions.forEach((version) => dedup.set(version.effectiveFrom, version));
        cogsLookup.set(
          sku,
          Array.from(dedup.values()).sort((a, b) => (a.effectiveFrom < b.effectiveFrom ? -1 : 1))
        );
      });

      const expenseTotals = computeExpenses(expenses, account.vat_rate);

      const result =
        platform === "amazon"
          ? processAmazon(rows, skuCol, qtyCol, cogsLookup, account.vat_rate, expenseTotals, periodStart)
          : processTemu(rows, skuCol, qtyCol, cogsLookup, account.vat_rate, expenseTotals, periodStart);

      const breakdownError = validateBreakdown(platform, result.breakdown);
      if (breakdownError) throw new Error(breakdownError);

      setPreview(result);
      setWarnings(
        deriveReportWarnings({
          missingSkus: result.missingSkus,
          netProfit: result.netProfit,
          outputVat: result.outputVat,
          inputVat: result.inputVat,
        })
      );
      setMessage("Calculation complete. Review and save report.");
    } catch (err) {
      const text = err instanceof Error ? err.message : "Calculation failed.";
      setError(text);
      await pushClientNotification({
        title: "Report calculation failed",
        body: text,
        level: "error",
        eventKey: `report-calc-fail:${account.id}:${Date.now()}`,
      });
    } finally {
      setLoading(false);
    }
  };

  const saveReport = async () => {
    if (!preview) return;

    setSaving(true);
    setError(null);
    setMessage(null);

    try {
      const rangeError = validatePeriodRange(periodStart, periodEnd);
      if (rangeError) throw new Error(rangeError);
      const breakdownError = validateBreakdown(platform, preview.breakdown);
      if (breakdownError) throw new Error(breakdownError);

      const supabase = createClient();

      const { data: overlaps, error: overlapError } = await supabase
        .from("reports")
        .select("id, period_start, period_end")
        .eq("account_id", account.id)
        .eq("platform", platform)
        .lte("period_start", periodEnd)
        .gte("period_end", periodStart);
      if (overlapError) throw overlapError;
      const conflicting = (overlaps || []).filter(
        (row) => !(String(row.period_start) === periodStart && String(row.period_end) === periodEnd)
      );
      if (conflicting.length > 0) {
        throw new Error("This period overlaps with an existing report. Use non-overlapping dates.");
      }
      const exactMatch = (overlaps || []).find(
        (row) => String(row.period_start) === periodStart && String(row.period_end) === periodEnd
      );
      if (exactMatch) {
        const shouldOverwrite = window.confirm(
          "A report for this same platform and period already exists. Click OK to overwrite it, or Cancel to stop."
        );
        if (!shouldOverwrite) {
          setWarnings((prev) => [
            ...prev.filter((item) => !item.includes("already exists")),
            "A report for this period already exists. Save cancelled to avoid accidental overwrite.",
          ]);
          setMessage("Save cancelled.");
          return;
        }
      }

      const reportPayload = {
        account_id: account.id,
        period_start: periodStart,
        period_end: periodEnd,
        platform,
        gross_sales: Number(preview.grossSales.toFixed(2)),
        total_cogs: Number(preview.totalCogs.toFixed(2)),
        total_fees: Number(preview.totalFees.toFixed(2)),
        output_vat: Number(preview.outputVat.toFixed(2)),
        input_vat: Number(preview.inputVat.toFixed(2)),
        net_profit: Number(preview.netProfit.toFixed(2)),
        breakdown: preview.breakdown,
        cogs_snapshot: preview.cogsSnapshot,
      };

      const { data: reportRow, error: reportError } = await supabase
        .from("reports")
        .upsert(reportPayload, {
          onConflict: "account_id,period_start,period_end,platform",
        })
        .select("id")
        .single();

      if (reportError || !reportRow?.id) {
        throw reportError || new Error("Failed to save report.");
      }

      const reportId = reportRow.id as string;

      // Persist parsed row-level transactions for future inventory forecasting.
      const normalizedTransactions = normalizeReportTransactions({
        rows,
        skuCol,
        qtyCol,
        periodStartIso: periodStart,
        reportId,
        accountId: account.id,
        platform,
      });
      const { error: clearTransactionsError } = await supabase
        .from("report_transactions")
        .delete()
        .eq("report_id", reportId);
      if (clearTransactionsError) throw clearTransactionsError;
      const CHUNK_SIZE = 400;
      for (let i = 0; i < normalizedTransactions.length; i += CHUNK_SIZE) {
        const chunk = normalizedTransactions.slice(i, i + CHUNK_SIZE);
        const { error: txInsertError } = await supabase.from("report_transactions").insert(chunk);
        if (txInsertError) throw txInsertError;
      }

      const { error: clearError } = await supabase.from("expenses").delete().eq("report_id", reportId);
      if (clearError) throw clearError;

      const expensesToSave = expenses
        .map((expense) => ({
          report_id: reportId,
          description: expense.description.trim(),
          amount: Number(parseMoney(expense.amount).toFixed(2)),
          includes_vat: expense.includesVat,
        }))
        .filter((expense) => expense.description.length > 0 || expense.amount > 0);

      if (expensesToSave.length > 0) {
        const { error: expensesError } = await supabase.from("expenses").insert(expensesToSave);
        if (expensesError) throw expensesError;
      }

      setMessage("Report and expenses saved successfully.");
    } catch (err) {
      const text = err instanceof Error ? err.message : "Failed to save report.";
      setError(text);
      await pushClientNotification({
        title: "Report save failed",
        body: text,
        level: "error",
        eventKey: `report-save-fail:${account.id}:${Date.now()}`,
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-6">
      {!canProcess ? (
        <p className="rounded-2xl bg-slate-100 px-3 py-2 text-sm text-slate-700">
          You have client access. Report processing is available for Admin/Team only.
        </p>
      ) : null}

      <div className="grid gap-3 rounded-2xl border border-slate-200 bg-white p-4 md:grid-cols-4">
        <div>
          <label className="mb-1 block text-sm font-medium text-slate-700">Platform</label>
          <select
            value={platform}
            onChange={(event) => setPlatform(event.target.value as Platform)}
            className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm"
            disabled={!canProcess}
          >
            <option value="amazon">Amazon</option>
            <option value="temu">Temu</option>
          </select>
        </div>

        <div>
          <label className="mb-1 block text-sm font-medium text-slate-700">Period Start</label>
          <input
            type="date"
            value={periodStart}
            onChange={(event) => setPeriodStart(event.target.value)}
            className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm"
            disabled={!canProcess}
          />
        </div>

        <div>
          <label className="mb-1 block text-sm font-medium text-slate-700">Period End</label>
          <input
            type="date"
            value={periodEnd}
            onChange={(event) => setPeriodEnd(event.target.value)}
            className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm"
            disabled={!canProcess}
          />
        </div>

        <div>
          <label className="mb-1 block text-sm font-medium text-slate-700">Transaction File</label>
          <FileDropzone
            accept=".csv,.xlsx"
            onFileSelect={(file) => void onFileChange(file)}
            disabled={!canProcess}
            label="Upload transaction file"
            hint="CSV or XLSX"
            selectedFileName={fileName || undefined}
          />
        </div>
      </div>

      <div className="grid gap-3 rounded-2xl border border-slate-200 bg-white p-4 md:grid-cols-3">
        <div>
          <label className="mb-1 block text-sm font-medium text-slate-700">SKU Column</label>
          <select
            value={skuCol}
            onChange={(event) => setSkuCol(event.target.value)}
            className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm"
            disabled={!canProcess || headers.length === 0}
          >
            <option value="">Select column</option>
            {headers.map((header) => (
              <option key={header} value={header}>
                {header}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label className="mb-1 block text-sm font-medium text-slate-700">Quantity Column</label>
          <select
            value={qtyCol}
            onChange={(event) => setQtyCol(event.target.value)}
            className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm"
            disabled={!canProcess || headers.length === 0}
          >
            <option value="">Select column</option>
            {headers.map((header) => (
              <option key={header} value={header}>
                {header}
              </option>
            ))}
          </select>
        </div>

        <div className="flex items-end">
          <button
            type="button"
            onClick={runCalculation}
            disabled={!canCalculate || loading}
            className="w-full rounded-xl bg-[var(--md-primary)] px-4 py-2 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-60"
          >
            {loading ? "Processing..." : "Process & Calculate"}
          </button>
        </div>
      </div>

      <div className="rounded-2xl border border-slate-200 bg-white p-4">
        <div className="mb-3 flex items-center justify-between">
          <h4 className="text-sm font-semibold text-slate-800">External Expenses</h4>
          {canProcess ? (
            <button
              type="button"
              onClick={addExpense}
              className="rounded-lg bg-slate-100 px-3 py-1 text-xs font-semibold text-slate-700"
            >
              Add expense
            </button>
          ) : null}
        </div>

        {expenses.length === 0 ? (
          <p className="text-sm text-slate-500">No external expenses added.</p>
        ) : (
          <div className="space-y-2">
            {expenses.map((expense) => (
              <div key={expense.id} className="grid gap-2 md:grid-cols-[1fr_160px_130px_auto_auto]">
                <input
                  value={expense.description}
                  onChange={(event) => updateExpense(expense.id, { description: event.target.value })}
                  placeholder="Description"
                  disabled={!canProcess}
                  className="rounded-lg border border-slate-300 px-3 py-2 text-sm"
                />
                <input
                  type="number"
                  step="0.01"
                  value={expense.amount}
                  onChange={(event) => updateExpense(expense.id, { amount: event.target.value })}
                  placeholder="Amount"
                  disabled={!canProcess}
                  className="rounded-lg border border-slate-300 px-3 py-2 text-sm"
                />
                <label className="flex items-center gap-2 rounded-lg border border-slate-300 px-3 py-2 text-sm">
                  <input
                    type="checkbox"
                    checked={expense.includesVat}
                    onChange={(event) => updateExpense(expense.id, { includesVat: event.target.checked })}
                    disabled={!canProcess}
                  />
                  Includes VAT
                </label>
                {canProcess ? (
                  <button
                    type="button"
                    onClick={addExpense}
                    className="rounded-lg bg-slate-100 px-3 py-2 text-xs font-semibold text-slate-700"
                  >
                    Add
                  </button>
                ) : null}
                {canProcess ? (
                  <button
                    type="button"
                    onClick={() => removeExpense(expense.id)}
                    className="rounded-lg bg-red-50 px-3 py-2 text-xs font-semibold text-red-700"
                  >
                    Remove
                  </button>
                ) : null}
              </div>
            ))}
          </div>
        )}
        <p className="mt-2 text-xs text-slate-500">After editing expenses, click Process & Calculate to refresh totals.</p>
      </div>

      {fileName ? <p className="text-sm text-slate-600">Loaded file: {fileName}</p> : null}
      {message ? <p className="rounded-2xl bg-green-50 px-3 py-2 text-sm text-green-700">{message}</p> : null}
      {error ? <p className="rounded-2xl bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p> : null}
      {warnings.length > 0 ? (
        <div className="rounded-2xl border border-yellow-200 bg-yellow-50 p-3 text-sm text-yellow-800">
          <p className="mb-1 font-semibold">Data quality warnings</p>
          <ul className="list-disc space-y-0.5 pl-5">
            {warnings.map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
        </div>
      ) : null}

      {preview ? (
        <div className="space-y-4 rounded-2xl border border-slate-200 bg-white p-5">
          <div className="grid gap-3 md:grid-cols-3">
            <div className="rounded-2xl bg-slate-50 p-4">
              <p className="text-xs text-slate-500">Total Product Sales</p>
              <p className="text-xl font-semibold">{currency}{previewProductSales.toFixed(2)}</p>
            </div>
            <div className="rounded-2xl bg-slate-50 p-4">
              <p className="text-xs text-slate-500">Total COGS</p>
              <p className="text-xl font-semibold">{currency}{preview.totalCogs.toFixed(2)}</p>
            </div>
            <div className="rounded-2xl bg-slate-50 p-4">
              <p className="text-xs text-slate-500">Total Fees</p>
              <p className="text-xl font-semibold">{currency}{preview.totalFees.toFixed(2)}</p>
            </div>
            <div className="rounded-2xl bg-slate-50 p-4">
              <p className="text-xs text-slate-500">Output VAT</p>
              <p className="text-xl font-semibold">{currency}{preview.outputVat.toFixed(2)}</p>
            </div>
            <div className="rounded-2xl bg-slate-50 p-4">
              <p className="text-xs text-slate-500">Input VAT</p>
              <p className="text-xl font-semibold">{currency}{preview.inputVat.toFixed(2)}</p>
            </div>
            <div className="rounded-2xl bg-slate-50 p-4">
              <p className="text-xs text-slate-500">Units Sold</p>
              <p className="text-xl font-semibold">{preview.unitsSold.toLocaleString()}</p>
            </div>
          </div>

          <div className="rounded-2xl bg-slate-900 p-4 text-white">
            <p className="text-xs uppercase tracking-wide text-slate-300">Net Profit</p>
            <p className="text-2xl font-semibold">{currency}{preview.netProfit.toFixed(2)}</p>
          </div>

          {preview.missingSkus.length > 0 ? (
            <div className="rounded-2xl bg-yellow-50 p-4 text-sm text-yellow-800">
              Missing COGS for SKUs: {preview.missingSkus.join(", ")}
            </div>
          ) : null}

          {canProcess ? (
            <button
              type="button"
              onClick={saveReport}
              disabled={saving}
              className="rounded-xl bg-[var(--md-primary)] px-5 py-2 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-60"
            >
              {saving ? "Saving report..." : "Save report + expenses"}
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
