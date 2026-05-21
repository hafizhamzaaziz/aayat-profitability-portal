const round2 = (value: number) => Math.round(value * 100) / 100;

export type ExpenseLineInput = {
  amount: number;
  includes_vat: boolean;
};

/**
 * Net (P&L) and VAT portions of manual external expenses.
 * Net is subtracted from profit; VAT increases reclaimable input VAT when applicable.
 */
export function computeExpenseTotals(rows: ExpenseLineInput[], vatRatePct: number) {
  const vatRate = (Number(vatRatePct) || 0) / 100;
  let net = 0;
  let vat = 0;
  for (const row of rows) {
    const amount = Number(row.amount || 0);
    if (!amount) continue;
    if (row.includes_vat && vatRate > 0) {
      const vatPart = amount * (vatRate / (1 + vatRate));
      vat += vatPart;
      net += amount - vatPart;
    } else {
      net += amount;
    }
  }
  return { net: round2(net), vat: round2(vat) };
}
