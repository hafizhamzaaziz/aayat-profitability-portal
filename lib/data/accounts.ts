import type { SupabaseClient } from "@supabase/supabase-js";
import type { UserRole } from "@/lib/types/auth";

export type MinimalAccount = {
  id: string;
  name: string;
  currency: string;
  vat_rate: number;
  cogs_vat_reclaim_pct: number | null;
  assigned_team_id: string | null;
  assigned_client_id: string | null;
  logo_url: string | null;
};

export async function getAccountsForRole(
  supabase: SupabaseClient,
  role: UserRole,
  userId: string
): Promise<MinimalAccount[]> {
  if (role === "admin") {
    const { data, error } = await supabase
      .from("accounts")
      .select("id, name, currency, vat_rate, cogs_vat_reclaim_pct, assigned_team_id, assigned_client_id, logo_url")
      .order("name", { ascending: true });

    if (error || !data) return [];
    return data as MinimalAccount[];
  }

  if (role === "team") {
    const { data: linkedAccounts } = await supabase
      .from("account_team_members")
      .select("account_id")
      .eq("team_id", userId);
    const accountIds = Array.from(
      new Set((linkedAccounts || []).map((row) => String((row as { account_id?: string }).account_id || "")).filter(Boolean))
    );

    const { data: directData, error: directError } = await (supabase
      .from("accounts")
      .select("id, name, currency, vat_rate, cogs_vat_reclaim_pct, assigned_team_id, assigned_client_id, logo_url")
      .eq("assigned_team_id", userId)
      .order("name", { ascending: true }) as unknown as Promise<{ data: MinimalAccount[]; error: unknown }>);

    if (directError) return [];
    const byAccountMappingData =
      accountIds.length > 0
        ? ((await supabase
            .from("accounts")
            .select("id, name, currency, vat_rate, cogs_vat_reclaim_pct, assigned_team_id, assigned_client_id, logo_url")
            .in("id", accountIds)
            .order("name", { ascending: true })) as { data: MinimalAccount[] | null }).data || []
        : [];

    const merged = new Map<string, MinimalAccount>();
    for (const row of directData || []) merged.set(row.id, row);
    for (const row of byAccountMappingData || []) merged.set(row.id, row);
    return Array.from(merged.values()).sort((a, b) => a.name.localeCompare(b.name));
  }

  // Client role — merge legacy accounts.assigned_client_id with new account_client_members join.
  const { data: linkedClientAccounts } = await supabase
    .from("account_client_members")
    .select("account_id")
    .eq("client_id", userId);
  const linkedAccountIds = Array.from(
    new Set(
      (linkedClientAccounts || [])
        .map((row) => String((row as { account_id?: string }).account_id || ""))
        .filter(Boolean)
    )
  );

  const { data: directClientData, error: directClientError } = await supabase
    .from("accounts")
    .select("id, name, currency, vat_rate, cogs_vat_reclaim_pct, assigned_team_id, assigned_client_id, logo_url")
    .eq("assigned_client_id", userId)
    .order("name", { ascending: true });

  if (directClientError) return [];

  const joinedClientData =
    linkedAccountIds.length > 0
      ? (
          (await supabase
            .from("accounts")
            .select("id, name, currency, vat_rate, cogs_vat_reclaim_pct, assigned_team_id, assigned_client_id, logo_url")
            .in("id", linkedAccountIds)
            .order("name", { ascending: true })) as { data: MinimalAccount[] | null }
        ).data || []
      : [];

  const mergedClient = new Map<string, MinimalAccount>();
  for (const row of (directClientData || []) as MinimalAccount[]) mergedClient.set(row.id, row);
  for (const row of joinedClientData) mergedClient.set(row.id, row);
  return Array.from(mergedClient.values()).sort((a, b) => a.name.localeCompare(b.name));
}

export async function getAccountByIdForRole(
  supabase: SupabaseClient,
  accountId: string,
  role: UserRole,
  userId: string
): Promise<MinimalAccount | null> {
  if (role === "admin") {
    const { data, error } = await supabase
      .from("accounts")
      .select("id, name, currency, vat_rate, cogs_vat_reclaim_pct, assigned_team_id, assigned_client_id, logo_url")
      .eq("id", accountId)
      .maybeSingle();

    if (error || !data) return null;
    return data as MinimalAccount;
  }

  if (role === "team") {
    const { data, error } = await (supabase
      .from("accounts")
      .select("id, name, currency, vat_rate, cogs_vat_reclaim_pct, assigned_team_id, assigned_client_id, logo_url")
      .eq("id", accountId)
      .maybeSingle() as unknown as Promise<{ data: MinimalAccount | null; error: unknown }>);

    if (error || !data) return null;
    if (data.assigned_team_id === userId) return data;
    const { data: linkRow } = await supabase
      .from("account_team_members")
      .select("id")
      .eq("team_id", userId)
      .eq("account_id", accountId)
      .maybeSingle();
    if (linkRow) return data;
    return null;
  }

  // Client role — allow access via legacy assigned_client_id OR via account_client_members.
  const { data, error } = await supabase
    .from("accounts")
    .select("id, name, currency, vat_rate, cogs_vat_reclaim_pct, assigned_team_id, assigned_client_id, logo_url")
    .eq("id", accountId)
    .maybeSingle();

  if (error || !data) return null;
  const account = data as MinimalAccount;
  if (account.assigned_client_id === userId) return account;

  const { data: linkRow } = await supabase
    .from("account_client_members")
    .select("id")
    .eq("client_id", userId)
    .eq("account_id", accountId)
    .maybeSingle();
  if (linkRow) return account;
  return null;
}
