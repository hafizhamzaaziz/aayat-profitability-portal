"use client";

import { useState, type ReactNode } from "react";

type TabId = "saved" | "generate" | "compare";

type Props = {
  generate: ReactNode;
  saved: ReactNode;
  compare?: ReactNode;
  initialTab?: TabId;
  showGenerate?: boolean;
  showCompare?: boolean;
};

export default function ReportsTabs({
  generate,
  saved,
  compare,
  initialTab = "saved",
  showGenerate = true,
  showCompare = false,
}: Props) {
  const [tab, setTab] = useState<TabId>(showGenerate || showCompare ? initialTab : "saved");

  const tabClass = (active: boolean) =>
    `flex-1 rounded-xl px-4 py-2 text-sm font-semibold transition-colors ${
      active
        ? "bg-[var(--md-primary)] text-white shadow"
        : "bg-slate-100 text-slate-700 hover:bg-slate-200"
    }`;

  return (
    <div className="space-y-4">
      <div className="flex gap-2 rounded-2xl border border-slate-200 bg-white p-1.5">
        <button type="button" onClick={() => setTab("saved")} className={tabClass(tab === "saved")}>
          Saved Reports
        </button>
        {showGenerate ? (
          <button type="button" onClick={() => setTab("generate")} className={tabClass(tab === "generate")}>
            New Report
          </button>
        ) : null}
        {showCompare ? (
          <button type="button" onClick={() => setTab("compare")} className={tabClass(tab === "compare")}>
            Compare Amazon
          </button>
        ) : null}
      </div>
      <div className={tab === "generate" && showGenerate ? "block" : "hidden"}>{generate}</div>
      <div className={tab === "compare" && showCompare ? "block" : "hidden"}>{compare}</div>
      <div className={tab === "saved" || (!showGenerate && !showCompare) ? "block" : "hidden"}>{saved}</div>
    </div>
  );
}
