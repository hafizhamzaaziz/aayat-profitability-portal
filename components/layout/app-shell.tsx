"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import Image from "next/image";
import { useRouter, usePathname, useSearchParams } from "next/navigation";
import AccountSwitcher from "@/components/layout/account-switcher";
import { createClient } from "@/lib/supabase/client";
import type { UserRole } from "@/lib/types/auth";

type NavItem = { href: string; label: string; emoji: string };
type NotificationRow = {
  id: string;
  title: string;
  body: string;
  level: "info" | "warning" | "error" | "success";
  link: string | null;
  read_at: string | null;
  created_at: string;
};

function BellIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.9" aria-hidden="true">
      <path d="M15 17h5l-1.4-1.4A2 2 0 0 1 18 14.2V10a6 6 0 1 0-12 0v4.2a2 2 0 0 1-.6 1.4L4 17h5m6 0a3 3 0 1 1-6 0" />
    </svg>
  );
}

const navItems: NavItem[] = [
  { href: "/dashboard", label: "Dashboard", emoji: "📊" },
  { href: "/reports", label: "Reports", emoji: "🧾" },
  { href: "/cogs", label: "COGS", emoji: "📦" },
  { href: "/performance", label: "Performance", emoji: "📈" },
  { href: "/inventory", label: "Inventory", emoji: "🏷️" },
  { href: "/settings", label: "Settings", emoji: "⚙️" },
];

export default function AppShell({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const accountId = searchParams.get("accountId");
  const [role, setRole] = useState<UserRole>("client");
  const [currentUserId, setCurrentUserId] = useState<string | null>(null);
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const [notifications, setNotifications] = useState<NotificationRow[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);

  useEffect(() => {
    let mounted = true;
    const loadRole = async () => {
      const supabase = createClient();
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user || !mounted) return;
      setCurrentUserId(user.id);
      const { data } = await supabase.from("users").select("role").eq("id", user.id).maybeSingle();
      if (!mounted) return;
      setRole(((data?.role as UserRole) || "client") as UserRole);
    };
    void loadRole();
    return () => {
      mounted = false;
    };
  }, []);

  const loadNotifications = useCallback(async () => {
    if (!currentUserId) return;
    const supabase = createClient();
    const { data, error } = await supabase
      .from("notifications")
      .select("id, title, body, level, link, read_at, created_at")
      .eq("user_id", currentUserId)
      .order("created_at", { ascending: false })
      .limit(12);
    if (error) return;
    const next = (data || []) as NotificationRow[];
    setNotifications(next);
    setUnreadCount(next.filter((n) => !n.read_at).length);
  }, [currentUserId]);

  useEffect(() => {
    if (!currentUserId) return;
    void loadNotifications();
  }, [currentUserId, loadNotifications]);

  useEffect(() => {
    if (!notificationsOpen) return;
    void loadNotifications();
  }, [notificationsOpen, loadNotifications]);

  const markNotificationRead = async (id: string, link?: string | null) => {
    const supabase = createClient();
    await supabase
      .from("notifications")
      .update({ read_at: new Date().toISOString() })
      .eq("id", id)
      .is("read_at", null);
    await loadNotifications();
    setNotificationsOpen(false);
    if (link) router.push(link);
  };

  const visibleNavItems = useMemo(() => {
    if (role === "admin") return navItems;
    return navItems.filter((item) => item.href !== "/settings");
  }, [role]);

  const currentTab = visibleNavItems.find((item) => pathname === item.href || pathname.startsWith(`${item.href}/`));

  const withAccount = (href: string) => {
    if (!accountId) return href;
    return `${href}?accountId=${accountId}`;
  };

  const onLogout = async () => {
    const supabase = createClient();
    await supabase.auth.signOut();
    router.push("/login");
    router.refresh();
  };

  return (
    <div className="min-h-screen p-4 md:p-6">
      <div className="mx-auto grid max-w-7xl gap-4 md:grid-cols-[260px_1fr]">
        <aside className="md-card h-fit">
          <div className="mb-6">
            <Image
              src="/aayat-logo.png"
              alt="Aayat logo"
              width={160}
              height={160}
              className="mb-3 h-auto w-28"
              priority
            />
            <p className="md-chip mb-2">Aayat.co</p>
            <h1 className="text-xl font-semibold tracking-tight">Profitability Portal</h1>
            <p className="mt-2 text-sm text-slate-600">Amazon & Temu insights</p>
          </div>
          <nav className="space-y-2">
            {visibleNavItems.map((item) => {
              const active = pathname === item.href;
              return (
                <Link
                  key={item.href}
                  href={withAccount(item.href)}
                  prefetch
                  className={`flex items-center gap-3 rounded-2xl px-4 py-3 text-sm font-medium transition ${
                    active
                      ? "bg-[var(--md-primary)] text-[var(--md-on-primary)]"
                      : "bg-white text-slate-700 hover:bg-[var(--md-primary-container)]"
                  }`}
                >
                  <span>{item.emoji}</span>
                  <span>{item.label}</span>
                </Link>
              );
            })}
          </nav>
          <button
            type="button"
            onClick={onLogout}
            className="mt-4 w-full rounded-2xl border border-slate-300 bg-white px-4 py-3 text-sm font-semibold text-slate-700 hover:bg-slate-50"
          >
            Logout
          </button>
        </aside>

        <section className="space-y-4">
          <header className="md-card flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="text-xs uppercase tracking-wide text-slate-500">Workspace</p>
              <h2 className="text-lg font-semibold">{currentTab?.label ?? "Portal"}</h2>
            </div>
            <div className="flex items-center gap-3">
              <div className="relative">
                <button
                  type="button"
                  onClick={() => setNotificationsOpen((v) => !v)}
                  aria-label="Open notifications"
                  className="relative inline-flex h-10 w-10 items-center justify-center rounded-full border border-slate-300 bg-white text-slate-700 transition hover:bg-slate-50"
                >
                  <BellIcon />
                  {unreadCount > 0 ? (
                    <span className="absolute -right-1 -top-1 min-w-[20px] rounded-full bg-[var(--md-primary)] px-1.5 py-0.5 text-center text-[10px] font-semibold text-white">
                      {unreadCount > 99 ? "99+" : unreadCount}
                    </span>
                  ) : null}
                </button>
                {notificationsOpen ? (
                  <div className="absolute right-0 z-50 mt-2 w-[340px] max-w-[90vw] rounded-2xl border border-slate-200 bg-white p-2 shadow-xl">
                    {notifications.length === 0 ? (
                      <p className="px-3 py-2 text-sm text-slate-500">No notifications.</p>
                    ) : (
                      <div className="max-h-80 space-y-1 overflow-auto">
                        {notifications.map((notification) => (
                          <button
                            key={notification.id}
                            type="button"
                            onClick={() => void markNotificationRead(notification.id, notification.link)}
                            className={`w-full rounded-xl px-3 py-2 text-left text-sm ${
                              notification.read_at ? "bg-slate-50 text-slate-600" : "bg-[var(--md-primary-container)] text-slate-800"
                            }`}
                          >
                            <p className="font-semibold">{notification.title}</p>
                            <p className="mt-0.5 text-xs">{notification.body}</p>
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                ) : null}
              </div>
              <AccountSwitcher />
            </div>
          </header>

          <main className="md-card">{children}</main>
        </section>
      </div>
    </div>
  );
}
