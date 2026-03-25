import type { Metadata } from "next";
import { requireAuth } from "@/lib/auth/guards";
import type { UserRole } from "@/lib/types/auth";
import { getAccountByIdForRole } from "@/lib/data/accounts";
import CogsTable from "./cogs-table";
import SkuMappingsPanel from "./sku-mappings-panel";

export const metadata: Metadata = {
  title: "COGS",
};

export default async function CogsPage({
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
        <p className="text-slate-600">Select an account from the topbar context switcher to load SKU costs.</p>
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
      <SkuMappingsPanel accountId={account.id} canEdit={canEdit} />
      <CogsTable accountId={account.id} canEdit={canEdit} />
    </div>
  );
}
