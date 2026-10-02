"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { PlannerStatus } from "@/lib/inventory/planner";
import { STATUS_LABEL } from "@/lib/inventory/planner";

export const btn = {
  primary: "rounded-lg bg-slate-900 px-3 py-2 text-sm font-semibold text-white hover:bg-slate-800 disabled:opacity-50",
  secondary: "rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50",
  plum: "rounded-lg bg-plum-700 px-3 py-2 text-sm font-semibold text-white hover:bg-plum-600 disabled:opacity-50",
  danger: "rounded-lg border border-red-200 bg-white px-3 py-2 text-sm font-semibold text-red-700 hover:bg-red-50 disabled:opacity-50",
  small: "rounded-md border border-slate-300 bg-white px-2 py-1 text-xs font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50",
  smallPrimary: "rounded-md bg-slate-900 px-2 py-1 text-xs font-semibold text-white hover:bg-slate-800 disabled:opacity-50",
};

export const input = "w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-plum-400 focus:outline-none";
export const inputSm = "w-full rounded-md border border-slate-300 px-2 py-1 text-sm focus:border-plum-400 focus:outline-none";

export function Card({ title, subtitle, actions, children, className = "" }: { title?: ReactNode; subtitle?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`rounded-2xl border border-slate-200 bg-white ${className}`}>
      {title || actions ? (
        <header className="flex flex-wrap items-start justify-between gap-3 border-b border-slate-100 px-4 py-3">
          <div>
            {title ? <h2 className="text-sm font-semibold text-slate-900">{title}</h2> : null}
            {subtitle ? <p className="mt-0.5 text-xs text-slate-500">{subtitle}</p> : null}
          </div>
          {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
        </header>
      ) : null}
      <div className="p-4">{children}</div>
    </section>
  );
}

export function Kpi({ label, value, hint, tone = "default", href }: { label: string; value: ReactNode; hint?: ReactNode; tone?: "default" | "warn" | "danger" | "good"; href?: string }) {
  const toneClass =
    tone === "danger" ? "border-red-200 bg-red-50" : tone === "warn" ? "border-amber-200 bg-amber-50" : tone === "good" ? "border-emerald-200 bg-emerald-50" : "border-slate-200 bg-white";
  const body = (
    <div className={`rounded-2xl border px-4 py-3 ${toneClass}`}>
      <p className="text-xs font-medium uppercase tracking-wide text-slate-500">{label}</p>
      <p className="mt-1 text-2xl font-semibold text-slate-900">{value}</p>
      {hint ? <p className="mt-0.5 text-xs text-slate-500">{hint}</p> : null}
    </div>
  );
  return href ? <Link href={href} className="block hover:opacity-90">{body}</Link> : body;
}

const STATUS_TONE: Record<PlannerStatus, string> = {
  out_of_stock: "bg-red-100 text-red-800 ring-red-200",
  order_now: "bg-red-50 text-red-700 ring-red-200",
  ship_to_fba: "bg-amber-100 text-amber-800 ring-amber-200",
  order_soon: "bg-amber-50 text-amber-700 ring-amber-200",
  needs_count: "bg-slate-100 text-slate-700 ring-slate-200",
  overstock: "bg-violet-50 text-violet-700 ring-violet-200",
  healthy: "bg-emerald-50 text-emerald-700 ring-emerald-200",
  no_sales: "bg-slate-50 text-slate-500 ring-slate-200",
};

export function StatusBadge({ status }: { status: PlannerStatus }) {
  return <span className={`inline-flex whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-semibold ring-1 ${STATUS_TONE[status]}`}>{STATUS_LABEL[status]}</span>;
}

const DOC_TONE: Record<string, string> = {
  draft: "bg-slate-100 text-slate-700",
  ordered: "bg-sky-100 text-sky-800",
  in_production: "bg-indigo-100 text-indigo-800",
  shipped: "bg-amber-100 text-amber-800",
  partially_received: "bg-amber-50 text-amber-700",
  received: "bg-emerald-100 text-emerald-800",
  receiving: "bg-amber-100 text-amber-800",
  closed: "bg-emerald-50 text-emerald-700",
  cancelled: "bg-red-50 text-red-700",
};

export function DocStatus({ status }: { status: string }) {
  return <span className={`inline-flex whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-semibold ${DOC_TONE[status] || "bg-slate-100 text-slate-700"}`}>{status.replace(/_/g, " ")}</span>;
}

export function useMoney(currency: string) {
  return useMemo(() => {
    const fmt = new Intl.NumberFormat("en-GB", { style: "currency", currency: currency || "GBP", maximumFractionDigits: 2 });
    return (v: number | null | undefined) => (v == null || !Number.isFinite(v) ? "—" : fmt.format(v));
  }, [currency]);
}

export function fmtInt(v: number | null | undefined) {
  if (v == null || !Number.isFinite(v)) return "—";
  return new Intl.NumberFormat("en-GB", { maximumFractionDigits: 0 }).format(v);
}

export function fmtDec(v: number | null | undefined, dp = 1) {
  if (v == null || !Number.isFinite(v)) return "—";
  return new Intl.NumberFormat("en-GB", { minimumFractionDigits: dp, maximumFractionDigits: dp }).format(v);
}

export function Notice({ kind, children }: { kind: "ok" | "error" | "info"; children: ReactNode }) {
  const cls = kind === "ok" ? "bg-green-50 text-green-700" : kind === "error" ? "bg-red-50 text-red-700" : "bg-slate-50 text-slate-700";
  return <p className={`rounded-xl px-3 py-2 text-sm ${cls}`}>{children}</p>;
}

export function Field({ label, children, hint, className = "" }: { label: ReactNode; children: ReactNode; hint?: ReactNode; className?: string }) {
  return (
    <label className={`block text-sm ${className}`}>
      <span className="mb-1 block text-xs font-medium text-slate-600">{label}</span>
      {children}
      {hint ? <span className="mt-1 block text-xs text-slate-500">{hint}</span> : null}
    </label>
  );
}

export type SkuOption = { mappingId: string; productName: string; amazonSku: string | null; temuSkuId: string | null; tiktokSku: string | null };

export function skuLabel(s: SkuOption) {
  return s.amazonSku || s.temuSkuId || s.tiktokSku || s.productName;
}

/** Type-ahead SKU picker: matches on any SKU or product name. */
export function SkuPicker({ options, value, onChange, placeholder = "Search SKU or product…", disabled, autoFocus }: { options: SkuOption[]; value: string; onChange: (mappingId: string) => void; placeholder?: string; disabled?: boolean; autoFocus?: boolean }) {
  const selected = options.find((o) => o.mappingId === value) || null;
  const [query, setQuery] = useState(selected ? `${skuLabel(selected)} · ${selected.productName}` : "");
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (selected) setQuery(`${skuLabel(selected)} · ${selected.productName}`);
    else if (!value) setQuery("");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, []);

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = q
      ? options.filter((o) => [o.amazonSku, o.temuSkuId, o.tiktokSku, o.productName].some((v) => String(v || "").toLowerCase().includes(q)))
      : options;
    return list.slice(0, 40);
  }, [options, query]);

  return (
    <div ref={box} className="relative">
      <input
        value={query}
        disabled={disabled}
        autoFocus={autoFocus}
        onFocus={() => setOpen(true)}
        onChange={(e) => {
          setQuery(e.target.value);
          setOpen(true);
          if (value) onChange("");
        }}
        placeholder={placeholder}
        className={inputSm}
      />
      {open && matches.length > 0 ? (
        <ul className="absolute z-20 mt-1 max-h-64 w-full min-w-[18rem] overflow-auto rounded-lg border border-slate-200 bg-white py-1 shadow-lg">
          {matches.map((o) => (
            <li key={o.mappingId}>
              <button
                type="button"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  onChange(o.mappingId);
                  setQuery(`${skuLabel(o)} · ${o.productName}`);
                  setOpen(false);
                }}
                className="flex w-full flex-col items-start px-3 py-1.5 text-left hover:bg-slate-50"
              >
                <span className="text-sm font-medium text-slate-900">{skuLabel(o)}</span>
                <span className="text-xs text-slate-500">{o.productName}{o.temuSkuId && o.amazonSku ? ` · Temu ${o.temuSkuId}` : ""}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

export function Modal({ title, onClose, children, wide }: { title: ReactNode; onClose: () => void; children: ReactNode; wide?: boolean }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-40 flex items-start justify-center overflow-y-auto bg-slate-900/40 p-4 pt-12" onMouseDown={onClose}>
      <div className={`w-full ${wide ? "max-w-5xl" : "max-w-2xl"} rounded-2xl bg-white shadow-xl`} onMouseDown={(e) => e.stopPropagation()}>
        <header className="flex items-center justify-between border-b border-slate-100 px-5 py-3">
          <h3 className="text-sm font-semibold text-slate-900">{title}</h3>
          <button type="button" onClick={onClose} className="rounded-md px-2 py-1 text-sm text-slate-500 hover:bg-slate-100">✕</button>
        </header>
        <div className="p-5">{children}</div>
      </div>
    </div>
  );
}

export function EmptyState({ children }: { children: ReactNode }) {
  return <p className="rounded-xl border border-dashed border-slate-300 px-4 py-6 text-center text-sm text-slate-500">{children}</p>;
}

export function th(extra = "") {
  return `whitespace-nowrap px-2 py-2 text-left text-xs font-semibold uppercase tracking-wide text-slate-500 ${extra}`;
}

export function td(extra = "") {
  return `px-2 py-1.5 align-top text-sm text-slate-800 ${extra}`;
}
