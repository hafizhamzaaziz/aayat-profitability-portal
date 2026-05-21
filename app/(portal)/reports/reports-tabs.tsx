"use client";

import { useState, type ReactNode } from "react";

type TabId = "generate" | "saved";

type Props = {
  generate: ReactNode;
  saved: ReactNode;
  initialTab?: TabId;
  /** When false, the Generate tab is hidden (e.g. client role). */
  showGenerate?: boolean;
};

export default function ReportsTabs({ generate, saved, initialTab = "generate", showGenerate = true }: Props) {
  const [tab, setTab] = useState<TabId>(showGenerate ? initialTab : "saved");

  const tabClass = (active: boolean) =>
    `flex-1 rounded-xl px-4 py-2 text-sm font-semibold transition-colors ${
      active
        ? "bg-[var(--md-primary)] text-white shadow"
        : "bg-slate-100 text-slate-700 hover:bg-slate-200"
    }`;

  return (
    <div className="space-y-4">
      <div className="flex gap-2 rounded-2xl border border-slate-200 bg-white p-1.5">
        {showGenerate ? (
          <button type="button" onClick={() => setTab("generate")} className={tabClass(tab === "generate")}>
            New Report
          </button>
        ) : null}
        <button type="button" onClick={() => setTab("saved")} className={tabClass(tab === "saved")}>
          Saved Reports
        </button>
      </div>
      <div className={tab === "generate" && showGenerate ? "block" : "hidden"}>{generate}</div>
      <div className={tab === "saved" || !showGenerate ? "block" : "hidden"}>{saved}</div>
    </div>
  );
}
