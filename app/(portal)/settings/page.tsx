import type { Metadata } from "next";
import { requireRole } from "@/lib/auth/guards";
import { getAccountByIdForRole } from "@/lib/data/accounts";
import AccountSettingsForm from "./account-settings-form";
import AdminSettingsPanelV2 from "./admin-settings-panel-v2";

export const metadata: Metadata = {
  title: "Settings",
};

export default async function SettingsPage({
  searchParams,
}: {
  searchParams: { accountId?: string };
}) {
  const { supabase, user, role } = await requireRole(["admin", "team"]);
  const accountId = searchParams.accountId;

  const account = accountId ? await getAccountByIdForRole(supabase, accountId, role, user.id) : null;

  return (
    <div className="space-y-4">
      {accountId && !account ? (
        <p className="rounded-2xl bg-red-50 px-3 py-2 text-sm text-red-700">
          The selected account was not found or you do not have access.
        </p>
      ) : null}
      {!accountId ? (
        <p className="text-slate-600">Select an account from the topbar context switcher to edit logo, currency, VAT, and inventory defaults.</p>
      ) : null}
      {account ? (
        <>
          <p className="text-slate-600">Update account currency/VAT, inventory planning defaults, and upload or replace the account logo.</p>
          <AccountSettingsForm account={account} />
        </>
      ) : null}
      {role === "admin" ? <AdminSettingsPanelV2 currentUserId={user.id} /> : null}
    </div>
  );
}
