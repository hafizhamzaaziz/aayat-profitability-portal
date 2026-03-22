"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import Image from "next/image";
import { useRouter, usePathname, useSearchParams } from "next/navigation";
import AccountSwitcher from "@/components/layout/account-switcher";
import { createClient } from "@/lib/supabase/client";
import type { UserRole } from "@/lib/types/auth";

type NavItem = { href: string; label: string; emoji: string };

const navItems: NavItem[] = [
  { href: "/dashboard", label: "Dashboard", emoji: "📊" },
  { href: "/reports", label: "Reports", emoji: "🧾" },
  { href: "/cogs", label: "COGS", emoji: "📦" },
  { href: "/performance", label: "Performance", emoji: "📈" },
  { href: "/settings", label: "Settings", emoji: "⚙️" },
];

export default function AppShell({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const accountId = searchParams.get("accountId");
  const [role, setRole] = useState<UserRole>("client");

  useEffect(() => {
    let mounted = true;
    const loadRole = async () => {
      const supabase = createClient();
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user || !mounted) return;
      const { data } = await supabase.from("users").select("role").eq("id", user.id).maybeSingle();
      if (!mounted) return;
      setRole(((data?.role as UserRole) || "client") as UserRole);
    };
    void loadRole();
    return () => {
      mounted = false;
    };
  }, []);

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
              <AccountSwitcher />
            </div>
          </header>

          <main className="md-card">{children}</main>
        </section>
      </div>
    </div>
  );
}
