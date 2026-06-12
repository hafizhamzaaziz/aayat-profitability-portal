"use client";

import { useEffect, useState } from "react";
import AdminSettingsPanelV2 from "./admin-settings-panel-v2";
import AuditEventsPanel from "./audit-events-panel";

type TabId = "accounts" | "users" | "audit";

const STORAGE_KEY = "settings.activeTab";

export default function SettingsTabs({
  isAdmin,
  currentUserId,
}: {
  isAdmin: boolean;
  currentUserId: string;
}) {
  const [active, setActive] = useState<TabId>("accounts");

  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(STORAGE_KEY) as TabId | null;
      if (saved && tabs.some((t) => t.id === saved && t.visible)) setActive(saved);
    } catch {
      // ignore — localStorage may be unavailable in some environments
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const tabs: Array<{ id: TabId; label: string; visible: boolean }> = [
    { id: "accounts", label: "Accounts Management", visible: isAdmin },
    { id: "users", label: "Users Management", visible: isAdmin },
    { id: "audit", label: "Audit Trail", visible: isAdmin },
  ];
  const visibleTabs = tabs.filter((t) => t.visible);

  if (visibleTabs.length === 0) {
    return (
      <p className="rounded-2xl bg-slate-50 px-3 py-2 text-sm text-slate-600">
        No settings available for your role.
      </p>
    );
  }

  const switchTo = (id: TabId) => {
    setActive(id);
    try {
      window.localStorage.setItem(STORAGE_KEY, id);
    } catch {
      // ignore
    }
  };

  return (
    <div className="space-y-3">
      <section className="rounded-2xl border border-slate-200 bg-white p-2">
        <div className="flex flex-wrap gap-2">
          {visibleTabs.map((tab) => (
            <button
              key={tab.id}
              type="button"
              onClick={() => switchTo(tab.id)}
              className={`rounded-xl px-3 py-2 text-sm font-semibold ${
                active === tab.id
                  ? "bg-[var(--md-primary)] text-white"
                  : "bg-slate-100 text-slate-700"
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>
      </section>

      {active === "accounts" && isAdmin ? (
        <AdminSettingsPanelV2 currentUserId={currentUserId} view="accounts" />
      ) : null}
      {active === "users" && isAdmin ? (
        <AdminSettingsPanelV2 currentUserId={currentUserId} view="users" />
      ) : null}
      {active === "audit" && isAdmin ? <AuditEventsPanel /> : null}
    </div>
  );
}
