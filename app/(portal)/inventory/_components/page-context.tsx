import type { ReactElement } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
import { requireAuth } from "@/lib/auth/guards";
import type { UserRole } from "@/lib/types/auth";
import { getAccountByIdForRole, type MinimalAccount } from "@/lib/data/accounts";

export type InventoryPageContext = {
  supabase: SupabaseClient;
  userId: string;
  role: UserRole;
  account: MinimalAccount;
  canEdit: boolean;
};

export async function getInventoryPageContext(
  accountId: string | undefined
): Promise<{ ok: true; ctx: InventoryPageContext } | { ok: false; element: ReactElement }> {
  const { supabase, user } = await requireAuth();
  const { data: userRow } = await supabase.from("users").select("role").eq("id", user.id).single();
  const role = ((userRow?.role as UserRole) || "client") as UserRole;

  if (!accountId) {
    return {
      ok: false,
      element: (
        <div className="space-y-4">
          <p className="text-slate-600">Select an account from the topbar context switcher to manage inventory.</p>
        </div>
      ),
    };
  }
  const account = await getAccountByIdForRole(supabase, accountId, role, user.id);
  if (!account) {
    return {
      ok: false,
      element: (
        <div className="space-y-4">
          <p className="rounded-2xl bg-red-50 px-3 py-2 text-sm text-red-700">The selected account was not found or you do not have access.</p>
        </div>
      ),
    };
  }
  return {
    ok: true,
    ctx: { supabase, userId: user.id, role, account, canEdit: role === "admin" || role === "team" },
  };
}
