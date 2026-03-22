"use client";

import { useEffect, useMemo, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import type { UserRole } from "@/lib/types/auth";

type AccountOption = { id: string; name: string };

export default function AccountSwitcher() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const selectedAccountId = searchParams.get("accountId") || "";

  const [accounts, setAccounts] = useState<AccountOption[]>([]);
  const [loading, setLoading] = useState(true);

  const loadAccounts = async () => {
    setLoading(true);
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
    let query = supabase.from("accounts").select("id, name").order("name", { ascending: true });

    if (role === "team") {
      const { data: linkedAccounts } = await supabase
        .from("account_team_members")
        .select("account_id")
        .eq("team_id", user.id);
      const accountIds = Array.from(
        new Set((linkedAccounts || []).map((row) => String((row as { account_id?: string }).account_id || "")).filter(Boolean))
      );
      const { data: direct } = await query.or(`assigned_team_id.eq.${user.id},assigned_team_id.is.null`);
      const { data: byAccountMapping } =
        accountIds.length > 0
          ? await supabase.from("accounts").select("id, name").in("id", accountIds).order("name", { ascending: true })
          : { data: [] as AccountOption[] };
      const merged = new Map<string, AccountOption>();
      (direct || []).forEach((row) => merged.set(String(row.id), row as AccountOption));
      (byAccountMapping || []).forEach((row) => merged.set(String(row.id), row as AccountOption));
      setAccounts(Array.from(merged.values()).sort((a, b) => a.name.localeCompare(b.name)));
      setLoading(false);
      return;
    } else if (role === "client") {
      query = query.eq("assigned_client_id", user.id);
    }

    const { data } = await query;
    setAccounts((data || []) as AccountOption[]);
    setLoading(false);
  };

  useEffect(() => {
    let active = true;

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

  const label = useMemo(() => {
    if (loading) return "Loading accounts...";
    if (accounts.length === 0) return "No accounts assigned";
    return "Current account";
  }, [accounts.length, loading]);

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
        disabled={loading || accounts.length === 0}
        className="rounded-2xl border border-slate-300 bg-white px-3 py-2 text-sm outline-none focus:border-[var(--md-primary)] disabled:cursor-not-allowed disabled:bg-slate-100"
      >
        {accounts.length === 0 ? <option value="">No account</option> : null}
        {accounts.map((account) => (
          <option key={account.id} value={account.id}>
            {account.name}
          </option>
        ))}
      </select>
    </div>
  );
}
