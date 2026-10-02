import Link from "next/link";
import type { ReactNode } from "react";

export type InventoryTabKey = "planner" | "purchase-orders" | "fba-shipments" | "stock" | "daily-sales" | "settings";

const TABS: Array<{ key: InventoryTabKey; label: string; path: string; hint: string }> = [
  { key: "planner", label: "Planner", path: "/inventory", hint: "What to order and what to ship" },
  { key: "purchase-orders", label: "Purchase orders", path: "/inventory/purchase-orders", hint: "Supplier orders → 3PL" },
  { key: "fba-shipments", label: "FBA shipments", path: "/inventory/fba-shipments", hint: "3PL → Amazon" },
  { key: "stock", label: "Stock & ledger", path: "/inventory/stock", hint: "Counts, adjustments, history" },
  { key: "daily-sales", label: "Daily sales", path: "/inventory/daily-sales", hint: "FBM / Temu / TikTok dispatch log" },
  { key: "settings", label: "Settings", path: "/inventory/settings", hint: "Suppliers, cartons, lead times" },
];

export function inventoryHref(path: string, accountId: string, extra?: Record<string, string | undefined>) {
  const params = new URLSearchParams({ accountId });
  for (const [k, v] of Object.entries(extra || {})) if (v) params.set(k, v);
  return `${path}?${params.toString()}`;
}

export function InventoryShell({
  accountId,
  accountName,
  active,
  title,
  description,
  actions,
  children,
}: {
  accountId: string;
  accountName: string;
  active: InventoryTabKey;
  title?: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-slate-600">
            Account: <span className="font-semibold">{accountName}</span>
          </p>
          {title ? <h1 className="mt-1 text-xl font-semibold text-slate-900">{title}</h1> : null}
          {description ? <p className="mt-1 max-w-3xl text-sm text-slate-600">{description}</p> : null}
        </div>
        {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
      </div>
      <nav className="flex gap-1 overflow-x-auto rounded-2xl border border-slate-200 bg-white p-1">
        {TABS.map((tab) => {
          const isActive = tab.key === active;
          return (
            <Link
              key={tab.key}
              href={inventoryHref(tab.path, accountId)}
              title={tab.hint}
              className={`whitespace-nowrap rounded-xl px-3 py-2 text-sm font-medium transition ${
                isActive ? "bg-plum-700 text-white" : "text-slate-600 hover:bg-slate-100"
              }`}
            >
              {tab.label}
            </Link>
          );
        })}
      </nav>
      {children}
    </div>
  );
}
