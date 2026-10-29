/** One uploaded stock-count row after it has been matched to a product. */
export type StockCountRow = {
  mappingId: string;
  label: string;
  fbaUnits: number;
  warehouseUnits: number;
  /** Empty when the carton cell was blank. */
  carton: string | null;
};

export type StockCountDedupe = {
  rows: StockCountRow[];
  mergedLabels: string[];
  error: string | null;
};

function cartonValue(value: string | null): string | null {
  const text = (value || "").trim();
  return text || null;
}

/**
 * One row per product for a stock take. Identical repeats keep the last row.
 * Different FBA, 3PL, or carton values stop the upload — nothing is saved.
 */
export function dedupeStockCountRows(rows: StockCountRow[]): StockCountDedupe {
  const order: string[] = [];
  const groups = new Map<string, StockCountRow[]>();
  for (const row of rows) {
    if (!groups.has(row.mappingId)) order.push(row.mappingId);
    const list = groups.get(row.mappingId) || [];
    list.push(row);
    groups.set(row.mappingId, list);
  }

  const kept: StockCountRow[] = [];
  const mergedLabels: string[] = [];
  const conflicts: string[] = [];
  for (const id of order) {
    const list = groups.get(id) || [];
    const last = list[list.length - 1];
    if (!last) continue;
    if (list.length === 1) {
      kept.push({ ...last, carton: cartonValue(last.carton) });
      continue;
    }
    const fba = new Set(list.map((row) => row.fbaUnits));
    const warehouse = new Set(list.map((row) => row.warehouseUnits));
    const cartons = new Set(list.map((row) => cartonValue(row.carton)));
    const label = last.label || id;
    if (fba.size > 1 || warehouse.size > 1 || cartons.size > 1) {
      conflicts.push(label);
      continue;
    }
    kept.push({ ...last, carton: cartonValue(last.carton) });
    mergedLabels.push(...list.map((row) => row.label || label));
  }

  if (conflicts.length) {
    return { rows: [], mergedLabels: [], error: conflictMessage(conflicts) };
  }
  return { rows: kept, mergedLabels, error: null };
}

export function conflictMessage(labels: string[]): string {
  return `Upload stopped. These products appear more than once with different FBA, 3PL, or carton values: ${listLabels(labels)}.`;
}

export function mergedStockMessage(labels: string[]): string | null {
  if (!labels.length) return null;
  return `Merged duplicate rows for ${listLabels(labels)}. The last row was kept.`;
}

function listLabels(labels: string[]): string {
  const unique = [...new Set(labels.filter(Boolean))];
  const shown = unique.slice(0, 12).join(", ");
  const more = unique.length > 12 ? ` (+${unique.length - 12} more)` : "";
  return `${shown}${more}`;
}
