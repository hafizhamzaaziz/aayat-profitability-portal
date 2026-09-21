"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useTransition } from "react";
import PeriodPresetBar from "@/components/ui/period-preset-bar";
import { parsePeriodPreset, resolvePeriod, type PeriodPreset } from "@/lib/utils/period-presets";

export default function DashboardFilters() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [pending, startTransition] = useTransition();

  const preset = parsePeriodPreset(searchParams.get("period"));
  const resolved = resolvePeriod({
    preset: searchParams.get("period"),
    from: searchParams.get("periodStart"),
    to: searchParams.get("periodEnd"),
  });
  const platform = searchParams.get("platform") || "all";

  const replace = (next: { period?: PeriodPreset; from?: string; to?: string; platform?: string }) => {
    const params = new URLSearchParams(searchParams.toString());
    const period = next.period ?? preset;
    params.set("period", period);
    if (period === "custom") {
      const from = next.from ?? resolved.from;
      const to = next.to ?? resolved.to;
      params.set("periodStart", from);
      params.set("periodEnd", to);
    } else {
      params.delete("periodStart");
      params.delete("periodEnd");
    }
    const plat = next.platform ?? platform;
    if (plat && plat !== "all") params.set("platform", plat);
    else params.delete("platform");
    startTransition(() => {
      router.replace(`${pathname}?${params.toString()}`);
    });
  };

  return (
    <div className={`space-y-3 rounded-2xl border border-slate-200 bg-white p-4 ${pending ? "opacity-70" : ""}`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <PeriodPresetBar
          value={preset}
          from={resolved.from}
          to={resolved.to}
          disabled={pending}
          onPreset={(next) => replace({ period: next })}
          onCustomChange={(from, to) => replace({ period: "custom", from, to })}
        />
        <div className="min-w-[160px]">
          <label className="mb-1 block text-xs font-medium uppercase tracking-wide text-slate-500">Platform</label>
          <select
            value={platform}
            disabled={pending}
            onChange={(e) => replace({ platform: e.target.value })}
            className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm disabled:opacity-50"
          >
            <option value="all">All</option>
            <option value="amazon">Amazon</option>
            <option value="temu">Temu</option>
            <option value="tiktok">TikTok</option>
          </select>
        </div>
      </div>
      {pending ? <p className="text-xs font-medium text-slate-500">Updating period…</p> : null}
    </div>
  );
}
