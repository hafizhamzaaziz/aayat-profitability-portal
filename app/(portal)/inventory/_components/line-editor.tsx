"use client";

import { useMemo } from "react";
import { palletEstimate } from "@/lib/inventory/pallets";
import type { PlannerRow } from "@/lib/inventory/planner";
import type { PackProfileRef, SkuSummary } from "@/lib/inventory/workspace";
import { SkuPicker, btn, fmtDec, fmtInt, inputSm, td, th } from "./ui";

export type EditableLine = {
  key: string;
  id?: string;
  mappingId: string;
  units: string;
  unitCost: string;
  packProfileId: string;
  notes: string;
  /** Units already received/sent — units cannot drop below this. */
  minUnits?: number;
};

export function newLine(partial?: Partial<EditableLine>): EditableLine {
  return {
    key: Math.random().toString(36).slice(2),
    mappingId: "",
    units: "",
    unitCost: "",
    packProfileId: "",
    notes: "",
    ...partial,
  };
}

export function lineBoxes(line: EditableLine, packById: Map<string, PackProfileRef>) {
  const pack = line.packProfileId ? packById.get(line.packProfileId) : null;
  const units = Number(line.units) || 0;
  if (!pack || units <= 0) return { boxes: null as number | null, pallets: null as number | null, unitsPerBox: pack?.unitsPerBox || null };
  const est = palletEstimate(pack, units);
  return { boxes: est.plannedBoxes, pallets: est.pallets, unitsPerBox: pack.unitsPerBox };
}

export function LineEditor({
  mode,
  lines,
  onChange,
  skus,
  packProfiles,
  rows,
  disabled,
  currency,
}: {
  mode: "po" | "fba";
  lines: EditableLine[];
  onChange: (lines: EditableLine[]) => void;
  skus: SkuSummary[];
  packProfiles: PackProfileRef[];
  rows: PlannerRow[];
  disabled?: boolean;
  currency: string;
}) {
  const packById = useMemo(() => new Map(packProfiles.map((p) => [p.id, p])), [packProfiles]);
  const skuById = useMemo(() => new Map(skus.map((s) => [s.mappingId, s])), [skus]);
  const rowById = useMemo(() => new Map(rows.map((r) => [r.mappingId, r])), [rows]);
  const money = useMemo(() => new Intl.NumberFormat("en-GB", { style: "currency", currency: currency || "GBP" }), [currency]);

  function update(key: string, patch: Partial<EditableLine>) {
    onChange(lines.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  }

  function pickSku(key: string, mappingId: string) {
    const sku = skuById.get(mappingId);
    const row = rowById.get(mappingId);
    const suggested = row ? (mode === "po" ? row.recommendedOrderUnits : row.recommendedFbaUnits) : 0;
    update(key, {
      mappingId,
      packProfileId: sku?.defaultPackProfileId || "",
      unitCost: mode === "po" && sku ? String(sku.unitCost || "") : "",
      units: suggested > 0 ? String(suggested) : "",
    });
  }

  const totals = lines.reduce(
    (acc, l) => {
      const units = Number(l.units) || 0;
      const { boxes, pallets } = lineBoxes(l, packById);
      acc.units += units;
      acc.boxes += boxes || 0;
      acc.pallets += pallets || 0;
      acc.value += units * (Number(l.unitCost) || 0);
      return acc;
    },
    { units: 0, boxes: 0, pallets: 0, value: 0 }
  );

  const usedIds = new Set(lines.map((l) => l.mappingId).filter(Boolean));

  return (
    <div className="overflow-x-auto">
      <table className="min-w-full">
        <thead>
          <tr className="bg-slate-50">
            <th className={th("min-w-[18rem]")}>SKU</th>
            <th className={th("text-right")}>Suggested</th>
            <th className={th("text-right")}>Units</th>
            <th className={th()}>Carton</th>
            <th className={th("text-right")}>Cartons</th>
            <th className={th("text-right")}>Pallets</th>
            {mode === "po" ? <th className={th("text-right")}>Unit cost</th> : null}
            {mode === "po" ? <th className={th("text-right")}>Line total</th> : null}
            <th className={th()}>Notes</th>
            <th className={th()} />
          </tr>
        </thead>
        <tbody>
          {lines.map((l) => {
            const row = rowById.get(l.mappingId);
            const sku = skuById.get(l.mappingId);
            const suggested = row ? (mode === "po" ? row.recommendedOrderUnits : row.recommendedFbaUnits) : null;
            const { boxes, pallets, unitsPerBox } = lineBoxes(l, packById);
            const units = Number(l.units) || 0;
            const tooLow = l.minUnits != null && units < l.minUnits;
            return (
              <tr key={l.key} className="border-t border-slate-100">
                <td className={td()}>
                  {l.id || disabled ? (
                    <div>
                      <span className="block font-medium text-slate-900">{sku ? sku.amazonSku || sku.temuSkuId || sku.tiktokSku : "—"}</span>
                      <span className="block text-xs text-slate-500">{sku?.productName}</span>
                    </div>
                  ) : (
                    <SkuPicker options={skus.filter((s) => s.mappingId === l.mappingId || !usedIds.has(s.mappingId))} value={l.mappingId} onChange={(id) => pickSku(l.key, id)} />
                  )}
                  {sku && mode === "fba" && row ? (
                    <span className="block text-xs text-slate-500">
                      3PL {row.warehouseOnHand == null ? "—" : fmtInt(row.warehouseOnHand)} · FBA {row.fbaOnHand == null ? "—" : fmtInt(row.fbaOnHand)}
                      {row.fbaInTransit ? ` (+${row.fbaInTransit} transit)` : ""} · {fmtDec(row.fbaVelocity, 1)}/day FBA
                    </span>
                  ) : null}
                  {sku && mode === "po" && row ? (
                    <span className="block text-xs text-slate-500">
                      Pipeline {fmtInt(row.pipelineUnits)} · {fmtDec(row.totalVelocity, 1)}/day · cover {row.totalDaysOfCover == null ? "—" : `${fmtDec(row.totalDaysOfCover, 0)}d`}
                      {sku.moq ? ` · MOQ ${sku.moq}` : ""}
                    </span>
                  ) : null}
                </td>
                <td className={td("text-right")}>
                  {suggested != null && suggested > 0 ? (
                    <button type="button" disabled={disabled} onClick={() => update(l.key, { units: String(suggested) })} className="text-sm font-medium text-plum-700 hover:underline disabled:no-underline" title="Use suggested units">
                      {fmtInt(suggested)}
                    </button>
                  ) : (
                    <span className="text-slate-400">—</span>
                  )}
                </td>
                <td className={td("w-28 text-right")}>
                  <input value={l.units} onChange={(e) => update(l.key, { units: e.target.value })} className={`${inputSm} text-right ${tooLow ? "border-red-400" : ""}`} inputMode="numeric" disabled={disabled} />
                  {l.minUnits ? <span className="block text-right text-[11px] text-slate-500">{l.minUnits} already received</span> : null}
                </td>
                <td className={td("w-44")}>
                  <select value={l.packProfileId} onChange={(e) => update(l.key, { packProfileId: e.target.value })} className={inputSm} disabled={disabled}>
                    <option value="">— none —</option>
                    {packProfiles.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.profileName} ({p.unitsPerBox}/ctn)
                      </option>
                    ))}
                  </select>
                </td>
                <td className={td("text-right")}>
                  {boxes == null ? <span className="text-slate-400">—</span> : fmtInt(boxes)}
                  {unitsPerBox && units > 0 && units % unitsPerBox !== 0 ? <span className="block text-[11px] text-amber-700">not a full carton</span> : null}
                </td>
                <td className={td("text-right")}>{pallets == null ? <span className="text-slate-400">—</span> : fmtDec(pallets, 2)}</td>
                {mode === "po" ? (
                  <td className={td("w-28 text-right")}>
                    <input value={l.unitCost} onChange={(e) => update(l.key, { unitCost: e.target.value })} className={`${inputSm} text-right`} inputMode="decimal" disabled={disabled} />
                  </td>
                ) : null}
                {mode === "po" ? <td className={td("text-right whitespace-nowrap")}>{money.format(units * (Number(l.unitCost) || 0))}</td> : null}
                <td className={td("w-40")}>
                  <input value={l.notes} onChange={(e) => update(l.key, { notes: e.target.value })} className={inputSm} disabled={disabled} placeholder="optional" />
                </td>
                <td className={td()}>
                  {!disabled && !(l.minUnits && l.minUnits > 0) ? (
                    <button type="button" onClick={() => onChange(lines.filter((x) => x.key !== l.key))} className="text-xs text-slate-500 hover:text-red-600">
                      Remove
                    </button>
                  ) : null}
                </td>
              </tr>
            );
          })}
          {lines.length === 0 ? (
            <tr>
              <td colSpan={mode === "po" ? 10 : 8} className="px-3 py-6 text-center text-sm text-slate-500">No lines yet.</td>
            </tr>
          ) : null}
        </tbody>
        <tfoot>
          <tr className="border-t-2 border-slate-200 bg-slate-50 text-sm font-semibold text-slate-800">
            <td className={td()}>{lines.filter((l) => l.mappingId).length} SKU{lines.length === 1 ? "" : "s"}</td>
            <td />
            <td className={td("text-right")}>{fmtInt(totals.units)}</td>
            <td />
            <td className={td("text-right")}>{fmtInt(totals.boxes)}</td>
            <td className={td("text-right")}>{fmtDec(totals.pallets, 2)}</td>
            {mode === "po" ? <td /> : null}
            {mode === "po" ? <td className={td("text-right")}>{money.format(totals.value)}</td> : null}
            <td colSpan={2} className={td("text-right")}>
              {!disabled ? (
                <button type="button" onClick={() => onChange([...lines, newLine()])} className={btn.small}>
                  + Add SKU
                </button>
              ) : null}
            </td>
          </tr>
        </tfoot>
      </table>
    </div>
  );
}
