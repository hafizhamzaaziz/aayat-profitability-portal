"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";

export default function DashboardFilters() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const [periodStart, setPeriodStart] = useState(searchParams.get("periodStart") || "");
  const [periodEnd, setPeriodEnd] = useState(searchParams.get("periodEnd") || "");
  const [platform, setPlatform] = useState(searchParams.get("platform") || "all");

  const apply = () => {
    const params = new URLSearchParams(searchParams.toString());
    if (periodStart) params.set("periodStart", periodStart);
    else params.delete("periodStart");
    if (periodEnd) params.set("periodEnd", periodEnd);
    else params.delete("periodEnd");
    if (platform && platform !== "all") params.set("platform", platform);
    else params.delete("platform");
    router.replace(`${pathname}?${params.toString()}`);
  };

  const clear = () => {
    const params = new URLSearchParams(searchParams.toString());
    params.delete("periodStart");
    params.delete("periodEnd");
    params.delete("platform");
    setPeriodStart("");
    setPeriodEnd("");
    setPlatform("all");
    router.replace(`${pathname}?${params.toString()}`);
  };

  return (
    <div className="grid gap-3 rounded-2xl border border-slate-200 bg-white p-4 md:grid-cols-[1fr_1fr_180px_auto_auto]">
      <div>
        <label className="mb-1 block text-xs font-medium uppercase tracking-wide text-slate-500">Period Start</label>
        <input
          type="date"
          value={periodStart}
          onChange={(e) => setPeriodStart(e.target.value)}
          className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm"
        />
      </div>
      <div>
        <label className="mb-1 block text-xs font-medium uppercase tracking-wide text-slate-500">Period End</label>
        <input
          type="date"
          value={periodEnd}
          onChange={(e) => setPeriodEnd(e.target.value)}
          className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm"
        />
      </div>
      <div>
        <label className="mb-1 block text-xs font-medium uppercase tracking-wide text-slate-500">Platform</label>
        <select
          value={platform}
          onChange={(e) => setPlatform(e.target.value)}
          className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm"
        >
          <option value="all">All</option>
          <option value="amazon">Amazon</option>
          <option value="temu">Temu</option>
        </select>
      </div>
      <button
        type="button"
        onClick={apply}
        className="self-end rounded-xl bg-[var(--md-primary)] px-4 py-2 text-sm font-semibold text-white"
      >
        Apply
      </button>
      <button
        type="button"
        onClick={clear}
        className="self-end rounded-xl bg-slate-100 px-4 py-2 text-sm font-semibold text-slate-700"
      >
        Clear
      </button>
    </div>
  );
}
