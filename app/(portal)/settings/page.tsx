import type { Metadata } from "next";
import { requireRole } from "@/lib/auth/guards";
import { getAccountByIdForRole } from "@/lib/data/accounts";
import SettingsTabs from "./settings-tabs";

export const metadata: Metadata = {
  title: "Settings",
};

export default async function SettingsPage({
  searchParams,
}: {
  searchParams: { accountId?: string; amazon?: string; amazon_message?: string };
}) {
  const { supabase, user, role } = await requireRole(["admin", "team"]);
  const accountId = searchParams.accountId;

  const account = accountId ? await getAccountByIdForRole(supabase, accountId, role, user.id) : null;
  const isAdmin = role === "admin";

  const amazonKind: "ok" | "error" | "info" | null =
    searchParams.amazon === "ok"
      ? "ok"
      : searchParams.amazon === "error"
      ? "error"
      : searchParams.amazon === "info"
      ? "info"
      : null;
  const amazonMessage = (searchParams.amazon_message || "").trim();

  return (
    <div className="space-y-4">
      {amazonKind && amazonMessage ? (
        <div
          className={`rounded-2xl border-2 px-3 py-2 text-sm font-semibold ${
            amazonKind === "ok"
              ? "border-emerald-300 bg-emerald-50 text-emerald-900"
              : amazonKind === "error"
              ? "border-red-300 bg-red-50 text-red-900"
              : "border-blue-300 bg-blue-50 text-blue-900"
          }`}
          role="alert"
        >
          {amazonKind === "ok" ? "✓ " : amazonKind === "error" ? "⚠ " : "ℹ "}
          {amazonMessage}
        </div>
      ) : null}

      {accountId && !account ? (
        <p className="rounded-2xl bg-red-50 px-3 py-2 text-sm text-red-700">
          The selected account was not found or you do not have access.
        </p>
      ) : null}
      {!accountId && !isAdmin ? (
        <p className="text-slate-600">
          Select an account from the topbar context switcher to edit logo, currency, VAT, and inventory defaults.
        </p>
      ) : null}

      <SettingsTabs
        account={account}
        isAdmin={isAdmin}
        currentUserId={user.id}
      />
    </div>
  );
}
