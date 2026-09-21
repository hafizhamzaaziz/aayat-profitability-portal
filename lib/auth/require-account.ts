import type { SupabaseClient } from "@supabase/supabase-js";
import { getAccountByIdForRole, type MinimalAccount } from "@/lib/data/accounts";
import type { UserRole } from "@/lib/types/auth";

export async function requireAccountAccess(
  supabase: SupabaseClient,
  userId: string,
  accountId: string
): Promise<{ role: UserRole; account: MinimalAccount } | { role: UserRole; account: null }> {
  const { data: userRow } = await supabase.from("users").select("role").eq("id", userId).single();
  const role = ((userRow?.role as UserRole) || "client") as UserRole;
  const account = await getAccountByIdForRole(supabase, accountId, role, userId);
  return { role, account };
}

/** Admin/team only, and only for accounts the caller can actually see. */
export async function requireStaffAccountAccess(
  supabase: SupabaseClient,
  userId: string,
  accountId: string
): Promise<{ role: UserRole; account: MinimalAccount } | { role: UserRole; account: null }> {
  const access = await requireAccountAccess(supabase, userId, accountId);
  if (!access.account || (access.role !== "admin" && access.role !== "team")) {
    return { role: access.role, account: null };
  }
  return access;
}
