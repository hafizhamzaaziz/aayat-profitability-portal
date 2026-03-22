import type { Metadata } from "next";
import { requireAuth } from "@/lib/auth/guards";
import type { UserRole } from "@/lib/types/auth";
import { getAccountByIdForRole } from "@/lib/data/accounts";
import PerformanceTracker from "./performance-tracker";

export const metadata: Metadata = {
  title: "Performance",
};

export default async function PerformancePage({
  searchParams,
}: {
  searchParams: { accountId?: string };
}) {
  const { supabase, user } = await requireAuth();

  const { data: userRow } = await supabase
    .from("users")
    .select("role")
    .eq("id", user.id)
    .single();

  const role = ((userRow?.role as UserRole) || "client") as UserRole;
  const accountId = searchParams.accountId;

  if (!accountId) {
    return (
      <div className="space-y-4">
        <p className="text-slate-600">Select an account from the topbar context switcher to view and manage metrics.</p>
      </div>
    );
  }

  const account = await getAccountByIdForRole(supabase, accountId, role, user.id);

  if (!account) {
    return (
      <div className="space-y-4">
        <p className="rounded-2xl bg-red-50 px-3 py-2 text-sm text-red-700">
          The selected account was not found or you do not have access.
        </p>
      </div>
    );
  }

  const canEdit = role === "admin" || role === "team";

  return (
    <div className="space-y-4">
      <p className="text-slate-600">
        Account: <span className="font-semibold">{account.name}</span>
      </p>
      <PerformanceTracker accountId={account.id} canEdit={canEdit} />
    </div>
  );
}
