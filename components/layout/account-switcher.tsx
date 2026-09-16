"use client";

import { useEffect, useMemo, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import type { UserRole } from "@/lib/types/auth";

type AccountOption = { id: string; name: string };

const ACCOUNTS_CACHE_KEY = "portal-account-options";

export default function AccountSwitcher() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const selectedAccountId = searchParams.get("accountId") || "";

  const [accounts, setAccounts] = useState<AccountOption[]>([]);
  const [loading, setLoading] = useState(true);

  const persistAccounts = (next: AccountOption[]) => {
    setAccounts(next);
    try {
      sessionStorage.setItem(ACCOUNTS_CACHE_KEY, JSON.stringify(next));
    } catch {
      /* ignore quota / private-mode failures */
    }
  };

  const loadAccounts = async () => {
    const supabase = createClient();

    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      setAccounts([]);
      setLoading(false);
      return;
    }

    const { data: userRow } = await supabase
      .from("users")
      .select("role")
      .eq("id", user.id)
      .single();

    const role = (userRow?.role || "client") as UserRole;
    const query = supabase.from("accounts").select("id, name").order("name", { ascending: true });

    if (role === "team") {
      const { data: linkedAccounts } = await supabase
        .from("account_team_members")
        .select("account_id")
        .eq("team_id", user.id);
      const accountIds = Array.from(
        new Set((linkedAccounts || []).map((row) => String((row as { account_id?: string }).account_id || "")).filter(Boolean))
      );
      const { data: direct } = await query.eq("assigned_team_id", user.id);
      const { data: byAccountMapping } =
        accountIds.length > 0
          ? await supabase.from("accounts").select("id, name").in("id", accountIds).order("name", { ascending: true })
          : { data: [] as AccountOption[] };
      const merged = new Map<string, AccountOption>();
      (direct || []).forEach((row) => merged.set(String(row.id), row as AccountOption));
      (byAccountMapping || []).forEach((row) => merged.set(String(row.id), row as AccountOption));
      persistAccounts(Array.from(merged.values()).sort((a, b) => a.name.localeCompare(b.name)));
      setLoading(false);
      return;
    } else if (role === "client") {
      const { data: linkedClientAccounts } = await supabase
        .from("account_client_members")
        .select("account_id")
        .eq("client_id", user.id);
      const clientAccountIds = Array.from(
        new Set(
          (linkedClientAccounts || [])
            .map((row) => String((row as { account_id?: string }).account_id || ""))
            .filter(Boolean)
        )
      );
      const { data: directClient } = await query.eq("assigned_client_id", user.id);
      const { data: byClientMapping } =
        clientAccountIds.length > 0
          ? await supabase.from("accounts").select("id, name").in("id", clientAccountIds).order("name", { ascending: true })
          : { data: [] as AccountOption[] };
      const mergedClient = new Map<string, AccountOption>();
      (directClient || []).forEach((row) => mergedClient.set(String(row.id), row as AccountOption));
      (byClientMapping || []).forEach((row) => mergedClient.set(String(row.id), row as AccountOption));
      persistAccounts(Array.from(mergedClient.values()).sort((a, b) => a.name.localeCompare(b.name)));
      setLoading(false);
      return;
    }

    const { data } = await query;
    persistAccounts((data || []) as AccountOption[]);
    setLoading(false);
  };

  useEffect(() => {
    let active = true;

    try {
      const raw = sessionStorage.getItem(ACCOUNTS_CACHE_KEY);
      if (raw) {
        const cached = JSON.parse(raw) as AccountOption[];
        if (Array.isArray(cached) && cached.length > 0) {
          setAccounts(cached);
          setLoading(false);
        }
      }
    } catch {
      /* ignore invalid cache */
    }

    void loadAccounts();

    const onRefresh = () => {
      if (!active) return;
      void loadAccounts();
    };
    window.addEventListener("accounts-updated", onRefresh);

    return () => {
      active = false;
      window.removeEventListener("accounts-updated", onRefresh);
    };
    // Load once on mount to avoid repeated fetches while switching tabs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (loading || selectedAccountId || accounts.length === 0) return;
    const params = new URLSearchParams(searchParams.toString());
    params.set("accountId", accounts[0].id);
    router.replace(`${pathname}?${params.toString()}`);
  }, [accounts, loading, pathname, router, searchParams, selectedAccountId]);

  const selectedAccount = accounts.find((account) => account.id === selectedAccountId);
  const label = useMemo(() => {
    if (selectedAccountId || accounts.length > 0) return "Current account";
    if (loading) return "Loading accounts...";
    return "No accounts assigned";
  }, [accounts.length, loading, selectedAccountId]);

  const onChange = (accountId: string) => {
    const params = new URLSearchParams(searchParams.toString());
    params.set("accountId", accountId);
    router.replace(`${pathname}?${params.toString()}`);
  };

  return (
    <div className="flex min-w-[220px] flex-col gap-1">
      <label className="text-xs font-medium uppercase tracking-wide text-slate-500">{label}</label>
      <select
        value={selectedAccountId}
        onChange={(event) => onChange(event.target.value)}
        disabled={accounts.length === 0 && !selectedAccountId}
        className="rounded-2xl border border-slate-300 bg-white px-3 py-2 text-sm outline-none focus:border-[var(--md-primary)] disabled:cursor-not-allowed disabled:bg-slate-100"
      >
        {selectedAccountId && !selectedAccount ? (
          <option value={selectedAccountId}>{loading ? "Current account" : "Selected account"}</option>
        ) : null}
        {accounts.length === 0 && !selectedAccountId ? <option value="">No account</option> : null}
        {accounts.map((account) => (
          <option key={account.id} value={account.id}>
            {account.name}
          </option>
        ))}
      </select>
    </div>
  );
}
