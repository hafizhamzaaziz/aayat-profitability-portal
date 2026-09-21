"use client";

import { PERIOD_PRESET_LABELS, type PeriodPreset } from "@/lib/utils/period-presets";

const PRESETS: PeriodPreset[] = ["today", "yesterday", "mtd", "this_month_forecast", "last_month", "custom"];

type Props = {
  value: PeriodPreset;
  from: string;
  to: string;
  disabled?: boolean;
  onPreset: (preset: PeriodPreset) => void;
  onCustomChange: (from: string, to: string) => void;
};

export default function PeriodPresetBar({ value, from, to, disabled, onPreset, onCustomChange }: Props) {
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-1.5">
        {PRESETS.map((preset) => {
          const active = value === preset;
          return (
            <button
              key={preset}
              type="button"
              disabled={disabled}
              onClick={() => onPreset(preset)}
              className={`rounded-full px-3 py-1.5 text-xs font-semibold transition-colors disabled:opacity-50 ${
                active
                  ? "bg-[var(--md-primary)] text-white"
                  : "bg-slate-100 text-slate-700 hover:bg-slate-200"
              }`}
            >
              {PERIOD_PRESET_LABELS[preset]}
            </button>
          );
        })}
      </div>
      {value === "custom" ? (
        <div className="flex flex-wrap items-end gap-2">
          <div>
            <label className="mb-1 block text-xs font-medium uppercase tracking-wide text-slate-500">From</label>
            <input
              type="date"
              value={from}
              disabled={disabled}
              onChange={(e) => onCustomChange(e.target.value, to)}
              className="rounded-xl border border-slate-300 px-3 py-2 text-sm disabled:opacity-50"
            />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium uppercase tracking-wide text-slate-500">To</label>
            <input
              type="date"
              value={to}
              disabled={disabled}
              onChange={(e) => onCustomChange(from, e.target.value)}
              className="rounded-xl border border-slate-300 px-3 py-2 text-sm disabled:opacity-50"
            />
          </div>
        </div>
      ) : (
        <p className="text-xs text-slate-500">
          {from} → {to}
          {value === "this_month_forecast" ? " · forecast = MTD pace × days remaining in month" : ""}
        </p>
      )}
    </div>
  );
}
