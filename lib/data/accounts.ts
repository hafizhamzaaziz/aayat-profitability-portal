import type { SupabaseClient } from "@supabase/supabase-js";
import type { UserRole } from "@/lib/types/auth";

export type MinimalAccount = {
  id: string;
  name: string;
  currency: string;
  vat_rate: number;
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
      .select("id, name, currency, vat_rate, assigned_team_id, assigned_client_id, logo_url")
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
      .select("id, name, currency, vat_rate, assigned_team_id, assigned_client_id, logo_url")
      .eq("assigned_team_id", userId)
      .order("name", { ascending: true }) as unknown as Promise<{ data: MinimalAccount[]; error: unknown }>);

    if (directError) return [];
    const byAccountMappingData =
      accountIds.length > 0
        ? ((await supabase
            .from("accounts")
            .select("id, name, currency, vat_rate, assigned_team_id, assigned_client_id, logo_url")
            .in("id", accountIds)
            .order("name", { ascending: true })) as { data: MinimalAccount[] | null }).data || []
        : [];

    const merged = new Map<string, MinimalAccount>();
    for (const row of directData || []) merged.set(row.id, row);
    for (const row of byAccountMappingData || []) merged.set(row.id, row);
    return Array.from(merged.values()).sort((a, b) => a.name.localeCompare(b.name));
  }

  const { data, error } = await supabase
    .from("accounts")
    .select("id, name, currency, vat_rate, assigned_team_id, assigned_client_id, logo_url")
    .eq("assigned_client_id", userId)
    .order("name", { ascending: true });

  if (error || !data) return [];
  return data as MinimalAccount[];
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
      .select("id, name, currency, vat_rate, assigned_team_id, assigned_client_id, logo_url")
      .eq("id", accountId)
      .maybeSingle();

    if (error || !data) return null;
    return data as MinimalAccount;
  }

  if (role === "team") {
    const { data, error } = await (supabase
      .from("accounts")
      .select("id, name, currency, vat_rate, assigned_team_id, assigned_client_id, logo_url")
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

  const { data, error } = await supabase
    .from("accounts")
    .select("id, name, currency, vat_rate, assigned_team_id, assigned_client_id, logo_url")
    .eq("id", accountId)
    .eq("assigned_client_id", userId)
    .maybeSingle();

  if (error || !data) return null;
  return data as MinimalAccount;
}
