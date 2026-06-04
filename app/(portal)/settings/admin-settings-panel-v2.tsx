"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { createClient } from "@/lib/supabase/client";
import type { UserRole } from "@/lib/types/auth";
import AuditEventsPanel from "./audit-events-panel";

type UserRow = { id: string; full_name: string; email: string; role: UserRole };
type AccountRow = { id: string; name: string; currency: string; vat_rate: number; assigned_client_id: string | null };
type AccountForm = { name: string; currency: string; vatRate: string; assignedClientIds: string[]; assignedTeamIds: string[] };
type UserForm = { fullName: string; email: string; role: UserRole; password: string };
type AmazonCredential = {
  account_id: string;
  provider: string;
  selling_partner_id: string | null;
  connected_at: string;
  last_synced_at: string | null;
  last_sync_error: string | null;
};
type AmazonAdsCredential = {
  account_id: string;
  provider: string;
  connected_at: string;
  last_synced_at: string | null;
  last_sync_error: string | null;
  ads_profile_ids: Record<string, number>;
  ads_advertiser_name: string | null;
};

const emptyAccount: AccountForm = { name: "", currency: "£", vatRate: "20", assignedClientIds: [], assignedTeamIds: [] };
const emptyUser: UserForm = { fullName: "", email: "", role: "client", password: "" };

export default function AdminSettingsPanelV2({
  currentUserId,
  view = "all",
}: {
  currentUserId: string;
  view?: "all" | "accounts" | "users" | "audit";
}) {
  const [accounts, setAccounts] = useState<AccountRow[]>([]);
  const [users, setUsers] = useState<UserRow[]>([]);
  const [accountTeamMap, setAccountTeamMap] = useState<Record<string, string[]>>({});
  const [accountClientMap, setAccountClientMap] = useState<Record<string, string[]>>({});
  const [amazonCredsByAccount, setAmazonCredsByAccount] = useState<Record<string, AmazonCredential>>({});
  const [adsCredsByAccount, setAdsCredsByAccount] = useState<Record<string, AmazonAdsCredential>>({});
  const [amazonMarketplace, setAmazonMarketplace] = useState<string>("uk");
  const [adsRegion, setAdsRegion] = useState<string>("eu");
  const [disconnectingAmazon, setDisconnectingAmazon] = useState(false);
  const [disconnectingAds, setDisconnectingAds] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [createAccountOpen, setCreateAccountOpen] = useState(false);
  const [editAccountId, setEditAccountId] = useState<string | null>(null);
  const [accountForm, setAccountForm] = useState<AccountForm>(emptyAccount);
  const [createUserOpen, setCreateUserOpen] = useState(false);
  const [editUserId, setEditUserId] = useState<string | null>(null);
  const [userForm, setUserForm] = useState<UserForm>(emptyUser);

  const teamUsers = useMemo(() => users.filter((u) => u.role === "team"), [users]);
  const clientUsers = useMemo(() => users.filter((u) => u.role === "client"), [users]);

  const notifyAccountsUpdated = () => window.dispatchEvent(new Event("accounts-updated"));

  // `loading` is the first-paint skeleton — only true until the very first
  // load completes. Subsequent refreshes (after save/delete/disconnect) keep
  // the existing list visible to avoid the modal flashing + scroll jumping
  // every time we re-fetch.
  const loadData = async () => {
    setError(null);
    try {
      const supabase = createClient();
      const [
        { data: usersData, error: usersError },
        { data: accountsData, error: accountsError },
        { data: linksData, error: linksError },
        { data: clientLinksData, error: clientLinksError },
        { data: amazonCredsData, error: amazonCredsError },
      ] = await Promise.all([
        supabase.from("users").select("id, full_name, email, role").order("full_name", { ascending: true }),
        supabase.from("accounts").select("id, name, currency, vat_rate, assigned_client_id").order("name", { ascending: true }),
        supabase.from("account_team_members").select("account_id, team_id"),
        supabase.from("account_client_members").select("account_id, client_id"),
        supabase
          .from("account_amazon_credentials")
          .select("account_id, provider, selling_partner_id, connected_at, last_synced_at, last_sync_error, ads_profile_ids, ads_advertiser_name")
          .in("provider", ["sp-api", "ads-api"]),
      ]);
      if (usersError) throw usersError;
      if (accountsError) throw accountsError;
      if (linksError) throw linksError;
      if (clientLinksError) throw clientLinksError;
      // Soft-fail if credentials can't be read (e.g. table doesn't exist yet
      // in older environments). The Amazon panel will simply show "Not connected".
      if (amazonCredsError) console.warn("Failed to load Amazon credentials:", amazonCredsError.message);

      const nextMap: Record<string, string[]> = {};
      ((linksData || []) as Array<{ account_id: string; team_id: string }>).forEach((row) => {
        if (!nextMap[row.account_id]) nextMap[row.account_id] = [];
        nextMap[row.account_id].push(row.team_id);
      });
      const nextClientMap: Record<string, string[]> = {};
      ((clientLinksData || []) as Array<{ account_id: string; client_id: string }>).forEach((row) => {
        if (!nextClientMap[row.account_id]) nextClientMap[row.account_id] = [];
        nextClientMap[row.account_id].push(row.client_id);
      });
      const nextAmazonMap: Record<string, AmazonCredential> = {};
      const nextAdsMap: Record<string, AmazonAdsCredential> = {};
      // The query returns both providers in one shot; split them out so each
      // panel can render its own connected state and creds independently.
      ((amazonCredsData || []) as Array<AmazonCredential & { provider: string; ads_profile_ids?: Record<string, number>; ads_advertiser_name?: string | null }>).forEach(
        (row) => {
          if (row.provider === "ads-api") {
            nextAdsMap[row.account_id] = {
              account_id: row.account_id,
              provider: row.provider,
              connected_at: row.connected_at,
              last_synced_at: row.last_synced_at,
              last_sync_error: row.last_sync_error,
              ads_profile_ids: (row.ads_profile_ids || {}) as Record<string, number>,
              ads_advertiser_name: (row.ads_advertiser_name ?? null) as string | null,
            };
          } else {
            nextAmazonMap[row.account_id] = row;
          }
        }
      );
      setUsers((usersData || []) as UserRow[]);
      setAccounts((accountsData || []) as AccountRow[]);
      setAccountTeamMap(nextMap);
      setAccountClientMap(nextClientMap);
      setAmazonCredsByAccount(nextAmazonMap);
      setAdsCredsByAccount(nextAdsMap);
      setLoading(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load admin settings.");
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadData();
  }, []);

  const syncAccountTeams = async (accountId: string, teamIds: string[]) => {
    const supabase = createClient();
    await supabase.from("account_team_members").delete().eq("account_id", accountId);
    if (!teamIds.length) return;
    const payload = Array.from(new Set(teamIds)).map((teamId) => ({ account_id: accountId, team_id: teamId }));
    const { error: insertError } = await supabase.from("account_team_members").insert(payload);
    if (insertError) throw insertError;
  };

  const syncAccountClients = async (accountId: string, clientIds: string[]) => {
    const supabase = createClient();
    await supabase.from("account_client_members").delete().eq("account_id", accountId);
    if (!clientIds.length) return;
    const payload = Array.from(new Set(clientIds)).map((clientId) => ({ account_id: accountId, client_id: clientId }));
    const { error: insertError } = await supabase.from("account_client_members").insert(payload);
    if (insertError) throw insertError;
  };

  const openCreateAccount = () => {
    setAccountForm(emptyAccount);
    setEditAccountId(null);
    setCreateAccountOpen(true);
  };
  const openEditAccount = (account: AccountRow) => {
    const fromJoin = accountClientMap[account.id] || [];
    const merged = Array.from(
      new Set(account.assigned_client_id ? [...fromJoin, account.assigned_client_id] : fromJoin)
    );
    setAccountForm({
      name: account.name,
      currency: account.currency,
      vatRate: String(account.vat_rate),
      assignedClientIds: merged,
      assignedTeamIds: accountTeamMap[account.id] || [],
    });
    setEditAccountId(account.id);
  };
  const openCreateUser = () => {
    setUserForm(emptyUser);
    setEditUserId(null);
    setCreateUserOpen(true);
  };
  const openEditUser = (user: UserRow) => {
    setUserForm({
      fullName: user.full_name,
      email: user.email,
      role: user.role,
      password: "",
    });
    setEditUserId(user.id);
  };

  const saveAccount = async () => {
    setSaving(true);
    setMessage(null);
    setError(null);
    try {
      const supabase = createClient();
      // Keep the legacy single-FK column populated with the first assigned client (for any
      // code path that still reads accounts.assigned_client_id). The account_client_members
      // join table is the source of truth.
      const primaryClient = accountForm.assignedClientIds[0] || null;
      const payload = {
        name: accountForm.name.trim(),
        currency: accountForm.currency,
        vat_rate: Number(accountForm.vatRate || 0),
        assigned_client_id: primaryClient,
      };
      if (editAccountId) {
        const { error: updateError } = await supabase.from("accounts").update(payload).eq("id", editAccountId);
        if (updateError) throw updateError;
      } else {
        const { data: inserted, error: insertError } = await supabase.from("accounts").insert(payload).select("id").single();
        if (insertError) throw insertError;
        if (inserted?.id) setEditAccountId(String(inserted.id));
      }
      if (editAccountId) {
        await syncAccountTeams(editAccountId, accountForm.assignedTeamIds);
        await syncAccountClients(editAccountId, accountForm.assignedClientIds);
      } else {
        const { data: latest } = await supabase.from("accounts").select("id").eq("name", accountForm.name.trim()).order("created_at", { ascending: false }).limit(1).maybeSingle();
        if (latest?.id) {
          await syncAccountTeams(String(latest.id), accountForm.assignedTeamIds);
          await syncAccountClients(String(latest.id), accountForm.assignedClientIds);
        }
      }
      setCreateAccountOpen(false);
      setMessage(editAccountId ? "Account updated." : "Account created.");
      await loadData();
      notifyAccountsUpdated();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save account.");
    } finally {
      setSaving(false);
    }
  };

  const saveUser = async () => {
    setSaving(true);
    setMessage(null);
    setError(null);
    try {
      if (editUserId) {
        const response = await fetch("/api/admin/users", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            userId: editUserId,
            fullName: userForm.fullName.trim(),
            email: userForm.email.trim().toLowerCase(),
            role: userForm.role,
            password: userForm.password.trim() || undefined,
          }),
        });
        if (!response.ok) throw new Error((await response.text()) || "Failed to update user.");
      } else {
        const response = await fetch("/api/admin/users", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            fullName: userForm.fullName.trim(),
            email: userForm.email.trim().toLowerCase(),
            password: userForm.password,
            role: userForm.role,
          }),
        });
        if (!response.ok) throw new Error((await response.text()) || "Failed to create user.");
      }
      setCreateUserOpen(false);
      setMessage(editUserId ? "User updated." : "User created.");
      await loadData();
      notifyAccountsUpdated();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save user.");
    } finally {
      setSaving(false);
    }
  };

  const deleteAccount = async (id: string) => {
    if (!window.confirm("Delete this account and all related data?")) return;
    const supabase = createClient();
    const { error: deleteError } = await supabase.from("accounts").delete().eq("id", id);
    if (deleteError) return setError(deleteError.message);
    setMessage("Account deleted.");
    await loadData();
    notifyAccountsUpdated();
  };

  const deleteUser = async (id: string) => {
    if (!window.confirm("Delete this user?")) return;
    const response = await fetch("/api/admin/users", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId: id }),
    });
    if (!response.ok) return setError((await response.text()) || "Failed to delete user.");
    setMessage("User deleted.");
    await loadData();
    notifyAccountsUpdated();
  };

  return (
    <div className="space-y-4">
      {message ? <p className="rounded-2xl bg-green-50 px-3 py-2 text-sm text-green-700">{message}</p> : null}
      {error ? <p className="rounded-2xl bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p> : null}

      {view === "all" || view === "accounts" ? (
      <section className="rounded-2xl border border-slate-200 bg-white p-4">
        <div className="mb-3 flex items-center justify-between"><h4 className="text-lg font-semibold">Accounts Management</h4><button onClick={openCreateAccount} className="rounded-lg bg-[var(--md-primary)] px-3 py-1.5 text-sm font-semibold text-white">Create</button></div>
        {loading && accounts.length === 0 ? <p className="text-sm text-slate-500">Loading accounts...</p> : <div className="space-y-2">{accounts.map((a) => <div key={a.id} className="flex items-center justify-between rounded-xl bg-slate-50 px-3 py-2 text-sm"><span>{a.name}</span><div className="flex gap-2"><button onClick={() => openEditAccount(a)} className="rounded-lg bg-slate-100 px-3 py-1 text-xs font-semibold">Edit</button><button onClick={() => void deleteAccount(a.id)} className="rounded-lg bg-red-50 px-3 py-1 text-xs font-semibold text-red-700">Delete</button></div></div>)}</div>}
      </section>
      ) : null}

      {view === "all" || view === "users" ? (
      <section className="rounded-2xl border border-slate-200 bg-white p-4">
        <div className="mb-3 flex items-center justify-between"><h4 className="text-lg font-semibold">Users Management</h4><button onClick={openCreateUser} className="rounded-lg bg-[var(--md-primary)] px-3 py-1.5 text-sm font-semibold text-white">Create</button></div>
        {loading && users.length === 0 ? (
          <p className="text-sm text-slate-500">Loading users...</p>
        ) : (
          <div className="overflow-x-auto rounded-xl border border-slate-200">
            <table className="min-w-full text-sm">
              <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="px-3 py-2">Name</th>
                  <th className="px-3 py-2">Email</th>
                  <th className="px-3 py-2">Role</th>
                  <th className="px-3 py-2">Actions</th>
                </tr>
              </thead>
              <tbody>
                {users.map((u) => (
                  <tr key={u.id} className="border-t border-slate-100">
                    <td className="px-3 py-2">{u.full_name}</td>
                    <td className="px-3 py-2 text-slate-600">{u.email}</td>
                    <td className="px-3 py-2">
                      <span
                        className={`rounded-full px-2 py-0.5 text-xs font-semibold capitalize ${
                          u.role === "admin"
                            ? "bg-violet-100 text-violet-700"
                            : u.role === "team"
                              ? "bg-blue-100 text-blue-700"
                              : "bg-emerald-100 text-emerald-700"
                        }`}
                      >
                        {u.role}
                      </span>
                    </td>
                    <td className="px-3 py-2">
                      <div className="flex gap-2">
                        <button onClick={() => openEditUser(u)} className="rounded-lg bg-slate-100 px-3 py-1 text-xs font-semibold">Edit</button>
                        <button
                          disabled={u.id === currentUserId}
                          onClick={() => void deleteUser(u.id)}
                          className="rounded-lg bg-red-50 px-3 py-1 text-xs font-semibold text-red-700 disabled:opacity-50"
                        >
                          {u.id === currentUserId ? "Current admin" : "Delete"}
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      ) : null}

      {(createAccountOpen || editAccountId) ? (
        <Modal
          title={editAccountId ? "Edit account" : "Create account"}
          size="lg"
          onClose={() => {
            setCreateAccountOpen(false);
            setEditAccountId(null);
          }}
          footer={
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => {
                  setCreateAccountOpen(false);
                  setEditAccountId(null);
                }}
                className="rounded-lg bg-slate-100 px-4 py-2 text-sm font-semibold text-slate-700"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void saveAccount()}
                disabled={saving}
                className="rounded-lg bg-[var(--md-primary)] px-4 py-2 text-sm font-semibold text-white disabled:opacity-60"
              >
                {saving ? "Saving..." : "Save"}
              </button>
            </div>
          }
        >
          <div className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="sm:col-span-2">
                <label className="mb-1 block text-sm font-medium text-slate-700">Account Name</label>
                <p className="mb-1 text-xs text-slate-500">Display name used across portal and dropdown.</p>
                <input
                  value={accountForm.name}
                  onChange={(e) => setAccountForm((p) => ({ ...p, name: e.target.value }))}
                  placeholder="Account name"
                  className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                />
              </div>
              <div>
                <label className="mb-1 block text-sm font-medium text-slate-700">Currency</label>
                <p className="mb-1 text-xs text-slate-500">Used in calculations and reports.</p>
                <select
                  value={accountForm.currency}
                  onChange={(e) => setAccountForm((p) => ({ ...p, currency: e.target.value }))}
                  className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                >
                  <option value="£">GBP (£)</option>
                  <option value="$">USD ($)</option>
                  <option value="€">EUR (€)</option>
                </select>
              </div>
              <div>
                <label className="mb-1 block text-sm font-medium text-slate-700">VAT Rate (%)</label>
                <p className="mb-1 text-xs text-slate-500">Used to derive VAT and net values.</p>
                <input
                  type="number"
                  step="0.01"
                  min={0}
                  max={100}
                  value={accountForm.vatRate}
                  onChange={(e) => setAccountForm((p) => ({ ...p, vatRate: e.target.value }))}
                  placeholder="VAT rate %"
                  className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                />
              </div>
            </div>
            <div className="grid gap-3 lg:grid-cols-2">
              <div>
                <label className="mb-1 block text-sm font-medium text-slate-700">Assigned Clients</label>
                <p className="mb-1 text-xs text-slate-500">Reports sent by email will go to every selected client.</p>
                <ClientPicker
                  clientUsers={clientUsers}
                  selected={accountForm.assignedClientIds}
                  onChange={(ids) => setAccountForm((p) => ({ ...p, assignedClientIds: ids }))}
                />
              </div>
              <div>
                <label className="mb-1 block text-sm font-medium text-slate-700">Assigned Team Members</label>
                <p className="mb-1 text-xs text-slate-500">Multiple team users can be assigned to this account.</p>
                <TeamPicker
                  teamUsers={teamUsers}
                  selected={accountForm.assignedTeamIds}
                  onChange={(ids) => setAccountForm((p) => ({ ...p, assignedTeamIds: ids }))}
                />
              </div>
            </div>

            {editAccountId ? (
              <div className="space-y-3">
                <AmazonConnectionPanel
                  accountId={editAccountId}
                  credential={amazonCredsByAccount[editAccountId] || null}
                  marketplace={amazonMarketplace}
                  onMarketplaceChange={setAmazonMarketplace}
                  disconnecting={disconnectingAmazon}
                  onSavedManual={async (accountName) => {
                    setMessage(`Amazon SP-API refresh token saved for ${accountName}.`);
                    setError(null);
                    await loadData();
                  }}
                  onDisconnect={async () => {
                    if (!confirm("Disconnect Amazon SP-API for this account? You can reconnect anytime.")) return;
                    setDisconnectingAmazon(true);
                    setMessage(null);
                    setError(null);
                    try {
                      const res = await fetch("/api/amazon/oauth/disconnect", {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ accountId: editAccountId, provider: "sp-api" }),
                      });
                      const json = await res.json();
                      if (!res.ok || !json.ok) throw new Error(json.error || "Failed to disconnect.");
                      setMessage("Amazon SP-API disconnected.");
                      await loadData();
                    } catch (err) {
                      setError(err instanceof Error ? err.message : "Failed to disconnect Amazon.");
                    } finally {
                      setDisconnectingAmazon(false);
                    }
                  }}
                />
                <AmazonAdsConnectionPanel
                  accountId={editAccountId}
                  credential={adsCredsByAccount[editAccountId] || null}
                  region={adsRegion}
                  onRegionChange={setAdsRegion}
                  disconnecting={disconnectingAds}
                  onSavedManual={async (accountName) => {
                    setMessage(`Amazon Ads refresh token saved for ${accountName}.`);
                    setError(null);
                    await loadData();
                  }}
                  onRefresh={async () => {
                    await loadData();
                  }}
                  onDisconnect={async () => {
                    if (!confirm("Disconnect Amazon Ads for this account? You can reconnect anytime.")) return;
                    setDisconnectingAds(true);
                    setMessage(null);
                    setError(null);
                    try {
                      const res = await fetch("/api/amazon/oauth/disconnect", {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ accountId: editAccountId, provider: "ads-api" }),
                      });
                      const json = await res.json();
                      if (!res.ok || !json.ok) throw new Error(json.error || "Failed to disconnect.");
                      setMessage("Amazon Ads disconnected.");
                      await loadData();
                    } catch (err) {
                      setError(err instanceof Error ? err.message : "Failed to disconnect Amazon Ads.");
                    } finally {
                      setDisconnectingAds(false);
                    }
                  }}
                />
              </div>
            ) : (
              <div className="rounded-xl border border-dashed border-slate-300 bg-slate-50 px-3 py-3 text-xs text-slate-600">
                Save the account first, then re-open it to connect Amazon SP-API.
              </div>
            )}
          </div>
        </Modal>
      ) : null}

      {(createUserOpen || editUserId) ? (
        <Modal
          title={editUserId ? "Edit user" : "Create user"}
          onClose={() => {
            setCreateUserOpen(false);
            setEditUserId(null);
          }}
          footer={
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => {
                  setCreateUserOpen(false);
                  setEditUserId(null);
                }}
                className="rounded-lg bg-slate-100 px-4 py-2 text-sm font-semibold text-slate-700"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void saveUser()}
                disabled={saving}
                className="rounded-lg bg-[var(--md-primary)] px-4 py-2 text-sm font-semibold text-white disabled:opacity-60"
              >
                {saving ? "Saving..." : "Save"}
              </button>
            </div>
          }
        >
          <div className="grid gap-3">
            <div>
              <label className="mb-1 block text-sm font-medium text-slate-700">Full Name</label>
              <p className="mb-1 text-xs text-slate-500">User display name in portal.</p>
              <input
                value={userForm.fullName}
                onChange={(e) => setUserForm((p) => ({ ...p, fullName: e.target.value }))}
                placeholder="Full name"
                className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
              />
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium text-slate-700">Email</label>
              <p className="mb-1 text-xs text-slate-500">Login email for this user.</p>
              <input
                type="email"
                value={userForm.email}
                onChange={(e) => setUserForm((p) => ({ ...p, email: e.target.value }))}
                placeholder="Email"
                className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
              />
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium text-slate-700">User Type</label>
              <p className="mb-1 text-xs text-slate-500">Controls permissions in the portal.</p>
              <select
                value={userForm.role}
                onChange={(e) => setUserForm((p) => ({ ...p, role: e.target.value as UserRole }))}
                className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
              >
                <option value="admin">Admin</option>
                <option value="team">Team</option>
                <option value="client">Client</option>
              </select>
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium text-slate-700">
                {editUserId ? "New Password (optional)" : "Temporary Password"}
              </label>
              <p className="mb-1 text-xs text-slate-500">
                {editUserId ? "Leave blank to keep existing password." : "User can change later."}
              </p>
              <input
                type="password"
                value={userForm.password}
                onChange={(e) => setUserForm((p) => ({ ...p, password: e.target.value }))}
                placeholder={editUserId ? "New password (optional)" : "Temporary password"}
                className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
              />
            </div>
          </div>
        </Modal>
      ) : null}

      {view === "all" || view === "audit" ? <AuditEventsPanel /> : null}
    </div>
  );
}

function Modal({
  title,
  onClose,
  children,
  footer,
  size = "md",
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  footer?: React.ReactNode;
  size?: "md" | "lg";
}) {
  const widthClass = size === "lg" ? "max-w-3xl" : "max-w-lg";
  // Render via a portal to document.body so the dialog lives OUTSIDE the
  // Accounts Management section entirely. Previously the modal was nested
  // inside the section's React subtree, so any re-render of that section
  // (loadData refreshes, credential props arriving, sync results) could
  // reflow the page underneath and visibly jolt the modal.
  //
  // Combined with: `items-start` + fixed top offset (no re-centering as
  // content height changes) and a fixed h-[90vh] outer box (only the inner
  // region scrolls). Together these eliminate the flashing/jumping.
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    setMounted(true);
    // Lock background scroll while the modal is open so the page underneath
    // can't shift and drag the modal with it.
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prevOverflow;
    };
  }, []);
  if (!mounted) return null;

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/45 p-4 pt-[5vh] pb-[5vh]"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
    >
      <div
        className={`flex h-[90vh] w-full ${widthClass} flex-col overflow-hidden rounded-2xl bg-white shadow-2xl`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex flex-shrink-0 items-center justify-between border-b border-slate-200 px-5 py-3">
          <h5 className="text-base font-semibold text-slate-900">{title}</h5>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close dialog"
            className="rounded-md px-2 py-1 text-sm text-slate-600 hover:bg-slate-100"
          >
            ✕
          </button>
        </div>
        <div className="flex-1 overflow-y-auto px-5 py-4">{children}</div>
        {footer ? (
          <div className="flex-shrink-0 border-t border-slate-200 bg-slate-50 px-5 py-3">{footer}</div>
        ) : null}
      </div>
    </div>,
    document.body
  );
}

function TeamPicker({ teamUsers, selected, onChange }: { teamUsers: UserRow[]; selected: string[]; onChange: (ids: string[]) => void }) {
  return <div className="rounded-lg border border-slate-300 p-2"><p className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">Assigned Team Members</p><div className="grid max-h-40 gap-1 overflow-auto">{teamUsers.map((team) => <label key={team.id} className="flex items-center gap-2 rounded px-2 py-1 text-sm hover:bg-slate-50"><input type="checkbox" checked={selected.includes(team.id)} onChange={(e) => e.target.checked ? onChange(Array.from(new Set([...selected, team.id]))) : onChange(selected.filter((id) => id !== team.id))} />{team.full_name}</label>)}</div></div>;
}

function AmazonConnectionPanel({
  accountId,
  credential,
  marketplace,
  onMarketplaceChange,
  disconnecting,
  onDisconnect,
  onSavedManual,
}: {
  accountId: string;
  credential: AmazonCredential | null;
  marketplace: string;
  onMarketplaceChange: (value: string) => void;
  disconnecting: boolean;
  onDisconnect: () => void;
  onSavedManual: (accountName: string) => void;
}) {
  const connected = Boolean(credential);
  const [showManual, setShowManual] = useState(false);
  const [manualToken, setManualToken] = useState("");
  const [manualSellerId, setManualSellerId] = useState("");
  const [manualSaving, setManualSaving] = useState(false);
  const [manualError, setManualError] = useState<string | null>(null);

  type TestResult = {
    ok: boolean;
    error?: string;
    region?: string;
    sellingPartnerId?: string | null;
    marketplaces?: Array<{ id: string; name: string; country: string; currency: string; participating: boolean; suspended: boolean }>;
    sampleOrders?: { windowDays: number; countOnFirstPage: number; first: { id: string; status: string; purchaseDate: string } | null; error: string | null };
  };
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<TestResult | null>(null);

  type SyncReport = {
    reportId: string;
    periodStart: string;
    periodEnd: string;
    rowsInserted: number;
    netProfit: number;
    outputVat: number;
    inputVat: number;
  };
  type SyncResult =
    | {
        ok: true;
        range: { from: string; to: string };
        totalEvents: number;
        totalRows: number;
        reports: SyncReport[];
        warnings: string[];
      }
    | { ok: false; error: string };
  const today = new Date().toISOString().slice(0, 10);
  const ninetyDaysAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const [syncFrom, setSyncFrom] = useState(ninetyDaysAgo);
  const [syncTo, setSyncTo] = useState(today);
  const [syncing, setSyncing] = useState(false);
  const [syncResult, setSyncResult] = useState<SyncResult | null>(null);

  const runSync = async () => {
    setSyncing(true);
    setSyncResult(null);
    try {
      const res = await fetch("/api/amazon/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accountId, from: syncFrom, to: syncTo }),
      });
      const json = (await res.json()) as SyncResult;
      setSyncResult(json);
    } catch (err) {
      setSyncResult({ ok: false, error: err instanceof Error ? err.message : "Network error." });
    } finally {
      setSyncing(false);
    }
  };

  const runSmokeTest = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const res = await fetch(`/api/amazon/test?accountId=${encodeURIComponent(accountId)}`);
      const json = (await res.json()) as TestResult;
      setTestResult(json);
    } catch (err) {
      setTestResult({ ok: false, error: err instanceof Error ? err.message : "Network error." });
    } finally {
      setTesting(false);
    }
  };

  const saveManualToken = async () => {
    setManualSaving(true);
    setManualError(null);
    try {
      const res = await fetch("/api/amazon/oauth/manual-token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          accountId,
          refreshToken: manualToken.trim(),
          sellingPartnerId: manualSellerId.trim() || undefined,
        }),
      });
      const json = await res.json();
      if (!res.ok || !json.ok) throw new Error(json.error || `HTTP ${res.status}`);
      setManualToken("");
      setManualSellerId("");
      setShowManual(false);
      onSavedManual(json.accountName);
    } catch (err) {
      setManualError(err instanceof Error ? err.message : "Failed to save refresh token.");
    } finally {
      setManualSaving(false);
    }
  };

  // We deliberately use a full page navigation rather than window.open so the
  // existing browser session (and Supabase auth cookies) are preserved through
  // the round-trip. Amazon will land back on /settings via our callback.
  const connectHref = `/api/amazon/oauth/start?accountId=${encodeURIComponent(accountId)}&marketplace=${encodeURIComponent(marketplace)}`;
  return (
    <div className="rounded-xl border border-slate-200 bg-white px-4 py-3">
      <div className="mb-2 flex items-center justify-between">
        <div>
          <h6 className="text-sm font-semibold text-slate-900">Amazon SP-API Connection</h6>
          <p className="text-xs text-slate-500">
            Allows the portal to pull Finance, Orders and Inventory data directly from this seller&apos;s Amazon account.
          </p>
        </div>
        <span
          className={`rounded-full px-2 py-0.5 text-xs font-semibold ${
            connected ? "bg-emerald-100 text-emerald-800" : "bg-slate-100 text-slate-600"
          }`}
        >
          {connected ? "Connected" : "Not connected"}
        </span>
      </div>

      {connected && credential ? (
        <div className="space-y-1 text-xs text-slate-600">
          {credential.selling_partner_id ? (
            <div>
              <span className="text-slate-500">Seller ID: </span>
              <code className="rounded bg-slate-100 px-1 py-0.5">{credential.selling_partner_id}</code>
            </div>
          ) : null}
          <div>
            <span className="text-slate-500">Connected: </span>
            {new Date(credential.connected_at).toLocaleString()}
          </div>
          <div>
            <span className="text-slate-500">Last sync: </span>
            {credential.last_synced_at ? new Date(credential.last_synced_at).toLocaleString() : "—"}
          </div>
          {credential.last_sync_error ? (
            <div className="mt-1 rounded bg-red-50 px-2 py-1 text-red-700">
              Last sync error: {credential.last_sync_error}
            </div>
          ) : null}
        </div>
      ) : (
        <p className="text-xs text-slate-600">
          Click <strong>Connect Amazon</strong> below to authorize. You&apos;ll be sent to Seller Central, asked to log in
          (use the seller&apos;s own credentials) and approve the app. After approval, you&apos;ll be redirected back here.
        </p>
      )}

      <div className="mt-3 flex flex-wrap items-end gap-2">
        <div>
          <label className="mb-1 block text-xs font-medium text-slate-700">Marketplace</label>
          <select
            value={marketplace}
            onChange={(e) => onMarketplaceChange(e.target.value)}
            className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm"
            disabled={connected}
          >
            <option value="uk">United Kingdom</option>
            <option value="de">Germany</option>
            <option value="fr">France</option>
            <option value="it">Italy</option>
            <option value="es">Spain</option>
            <option value="nl">Netherlands</option>
            <option value="us">United States</option>
          </select>
        </div>

        {connected ? (
          <button
            type="button"
            onClick={onDisconnect}
            disabled={disconnecting}
            className="rounded-lg bg-red-50 px-4 py-2 text-sm font-semibold text-red-700 disabled:opacity-60"
          >
            {disconnecting ? "Disconnecting..." : "Disconnect Amazon"}
          </button>
        ) : (
          <>
            <a
              href={connectHref}
              className="rounded-lg bg-[var(--md-primary)] px-4 py-2 text-sm font-semibold text-white hover:opacity-90"
            >
              Connect Amazon
            </a>
            <button
              type="button"
              onClick={async () => {
                const url = `${window.location.origin}${connectHref}`;
                try {
                  await navigator.clipboard.writeText(url);
                  alert("Authorization link copied. Send it to the seller — it expires in 30 minutes.");
                } catch {
                  prompt("Copy this authorization link and send to the seller:", url);
                }
              }}
              className="rounded-lg bg-slate-100 px-3 py-2 text-xs font-semibold text-slate-700"
              title="Copy a one-time authorization link for this account that you can email to the seller."
            >
              Copy invite link
            </button>
          </>
        )}
      </div>

      {connected ? (
        <div className="mt-3 border-t border-slate-200 pt-3">
          <div className="mb-2 flex items-center justify-between">
            <p className="text-xs font-semibold text-slate-700">Connectivity smoke test</p>
            <button
              type="button"
              onClick={() => void runSmokeTest()}
              disabled={testing}
              className="rounded-lg bg-slate-100 px-3 py-1.5 text-xs font-semibold text-slate-700 disabled:opacity-60"
            >
              {testing ? "Testing…" : "Test SP-API"}
            </button>
          </div>
          {testResult ? (
            testResult.ok ? (
              <div className="space-y-1 rounded-lg bg-emerald-50 px-3 py-2 text-xs text-emerald-900">
                <div>
                  <strong>✓ SP-API responded.</strong> Region <code>{testResult.region}</code>
                  {testResult.sellingPartnerId ? (
                    <> · Seller <code>{testResult.sellingPartnerId}</code></>
                  ) : null}
                </div>
                {testResult.marketplaces && testResult.marketplaces.length > 0 ? (
                  <div>
                    Marketplaces participating:{" "}
                    {testResult.marketplaces
                      .filter((m) => m.participating)
                      .map((m) => `${m.country} (${m.currency})`)
                      .join(", ") || "—"}
                  </div>
                ) : null}
                {testResult.sampleOrders ? (
                  testResult.sampleOrders.error ? (
                    <div className="text-amber-800">
                      Orders sample failed: {testResult.sampleOrders.error}
                    </div>
                  ) : (
                    <div>
                      Orders (last {testResult.sampleOrders.windowDays}d, first page):{" "}
                      {testResult.sampleOrders.countOnFirstPage}
                      {testResult.sampleOrders.first ? (
                        <>
                          {" "}
                          · most recent <code>{testResult.sampleOrders.first.id}</code> (
                          {testResult.sampleOrders.first.status})
                        </>
                      ) : null}
                    </div>
                  )
                ) : null}
              </div>
            ) : (
              <div className="rounded-lg bg-red-50 px-3 py-2 text-xs text-red-800">
                <strong>✗ Test failed.</strong>
                <div className="mt-1 break-all font-mono">{testResult.error}</div>
              </div>
            )
          ) : (
            <p className="text-xs text-slate-500">
              Validates the stored refresh token by calling getMarketplaceParticipations and a one-page
              orders sample. Also refreshes the connection&apos;s sync status.
            </p>
          )}
        </div>
      ) : null}

      {connected ? (
        <div className="mt-3 border-t border-slate-200 pt-3">
          <div className="mb-2 flex items-center justify-between">
            <div>
              <p className="text-xs font-semibold text-slate-700">Sync data from Amazon</p>
              <p className="text-xs text-slate-500">
                Pulls Finance events (orders, refunds, fees, adjustments) from SP-API and creates one
                report per calendar month. Tagged <code className="rounded bg-slate-100 px-1">sp_api</code>{" "}
                so manual uploads aren&apos;t overwritten.
              </p>
            </div>
          </div>
          <div className="flex flex-wrap items-end gap-2">
            <div>
              <label className="mb-1 block text-xs font-medium text-slate-700">From</label>
              <input
                type="date"
                value={syncFrom}
                onChange={(e) => setSyncFrom(e.target.value)}
                className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-slate-700">To</label>
              <input
                type="date"
                value={syncTo}
                onChange={(e) => setSyncTo(e.target.value)}
                className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm"
              />
            </div>
            <button
              type="button"
              onClick={() => void runSync()}
              disabled={syncing || !syncFrom || !syncTo || syncFrom > syncTo}
              className="rounded-lg bg-[var(--md-primary)] px-4 py-2 text-sm font-semibold text-white disabled:opacity-60"
              title="Backfill financial events for the chosen date range."
            >
              {syncing ? "Syncing… (may take 1–3 min)" : "Sync from Amazon"}
            </button>
          </div>
          {syncResult ? (
            syncResult.ok ? (
              <div className="mt-3 space-y-1 rounded-lg bg-emerald-50 px-3 py-2 text-xs text-emerald-900">
                <div>
                  <strong>✓ Sync complete.</strong> {syncResult.totalRows.toLocaleString()} transactions ingested
                  from {syncResult.totalEvents.toLocaleString()} events ({syncResult.range.from} → {syncResult.range.to}).
                </div>
                {syncResult.reports.length > 0 ? (
                  <ul className="ml-4 list-disc space-y-0.5">
                    {syncResult.reports.map((r) => (
                      <li key={r.reportId}>
                        <strong>{r.periodStart}</strong> → {r.periodEnd}: {r.rowsInserted.toLocaleString()} rows ingested
                      </li>
                    ))}
                  </ul>
                ) : (
                  <div>No financial events were returned in this range.</div>
                )}
                {syncResult.warnings.length > 0 ? (
                  <div className="mt-1 rounded bg-amber-50 px-2 py-1 text-amber-800">
                    {syncResult.warnings.map((w, i) => (
                      <div key={i}>• {w}</div>
                    ))}
                  </div>
                ) : null}
                <div className="mt-1">
                  Open the <a href="/reports" className="font-semibold underline">Reports</a> page to review or
                  download PDFs. Reports created here are tagged <strong>sp_api</strong>.
                </div>
              </div>
            ) : (
              <div className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-800">
                <strong>✗ Sync failed.</strong>
                <div className="mt-1 break-all font-mono">{syncResult.error}</div>
              </div>
            )
          ) : null}
        </div>
      ) : null}

      <div className="mt-3 border-t border-slate-200 pt-2">
        <button
          type="button"
          onClick={() => setShowManual((v) => !v)}
          className="text-xs font-semibold text-slate-600 hover:text-slate-900"
        >
          {showManual ? "▾" : "▸"} Advanced: paste refresh token manually
        </button>
        {showManual ? (
          <div className="mt-2 space-y-2 rounded-lg bg-slate-50 p-3">
            <p className="text-xs text-slate-600">
              For developer self-authorization (when Amazon shows the refresh token on screen instead of
              redirecting). The token is validated against Amazon LWA before being stored. Saving this
              {connected ? " will REPLACE the existing connection." : " creates a connection without going through OAuth."}
            </p>
            <div>
              <label className="mb-1 block text-xs font-medium text-slate-700">
                Refresh token (starts with <code>Atzr|</code>)
              </label>
              <textarea
                value={manualToken}
                onChange={(e) => setManualToken(e.target.value)}
                rows={3}
                placeholder="Atzr|IwEBI..."
                className="w-full rounded-lg border border-slate-300 px-2 py-1.5 font-mono text-xs"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-slate-700">
                Selling Partner ID (optional, format <code>A2EUQ…</code>)
              </label>
              <input
                value={manualSellerId}
                onChange={(e) => setManualSellerId(e.target.value)}
                placeholder="A2EUQ1WTGCTBG2"
                className="w-full rounded-lg border border-slate-300 px-2 py-1.5 text-xs"
              />
            </div>
            {manualError ? (
              <div className="rounded bg-red-50 px-2 py-1 text-xs text-red-700">{manualError}</div>
            ) : null}
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => void saveManualToken()}
                disabled={manualSaving || !manualToken.trim()}
                className="rounded-lg bg-[var(--md-primary)] px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-60"
              >
                {manualSaving ? "Validating with Amazon…" : "Validate & save"}
              </button>
              <button
                type="button"
                onClick={() => {
                  setShowManual(false);
                  setManualToken("");
                  setManualSellerId("");
                  setManualError(null);
                }}
                className="rounded-lg bg-slate-200 px-3 py-1.5 text-xs font-semibold text-slate-700"
              >
                Cancel
              </button>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function AmazonAdsConnectionPanel({
  accountId,
  credential,
  region,
  onRegionChange,
  disconnecting,
  onDisconnect,
  onSavedManual,
  onRefresh,
}: {
  accountId: string;
  credential: AmazonAdsCredential | null;
  region: string;
  onRegionChange: (value: string) => void;
  disconnecting: boolean;
  onDisconnect: () => void;
  onSavedManual: (accountName: string) => void;
  onRefresh: () => Promise<void>;
}) {
  const connected = Boolean(credential);
  const [showManual, setShowManual] = useState(false);
  const [manualToken, setManualToken] = useState("");
  const [manualSaving, setManualSaving] = useState(false);
  const [manualError, setManualError] = useState<string | null>(null);

  type AdsTestResult = {
    ok: boolean;
    error?: string;
    region?: string;
    profileCount?: number;
    profiles?: Array<{
      profileId: number;
      countryCode: string;
      currencyCode: string;
      marketplaceId: string;
      accountType: string;
      accountName: string;
    }>;
    selectedProfileIds?: Record<string, number>;
    advertiserOptions?: string[];
    selectedAdvertiser?: string | null;
  };
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<AdsTestResult | null>(null);
  const [pinningAdvertiser, setPinningAdvertiser] = useState(false);

  type AdsSyncReport = {
    reportId: string;
    periodStart: string;
    periodEnd: string;
    reportCreated: boolean;
    skuCount: number;
    totalSpendExvat: number;
  };
  type SyncPhase = "idle" | "starting" | "collecting" | "done" | "error";
  type SyncState = {
    phase: SyncPhase;
    range: { from: string; to: string } | null;
    jobsRequested: number;
    pending: number;
    completed: number;
    failed: number;
    reports: AdsSyncReport[];
    warnings: string[];
    error: string | null;
  };
  const emptySyncState: SyncState = {
    phase: "idle",
    range: null,
    jobsRequested: 0,
    pending: 0,
    completed: 0,
    failed: 0,
    reports: [],
    warnings: [],
    error: null,
  };
  const today = new Date().toISOString().slice(0, 10);
  const ninetyDaysAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const [syncFrom, setSyncFrom] = useState(ninetyDaysAgo);
  const [syncTo, setSyncTo] = useState(today);
  const [sync, setSync] = useState<SyncState>(emptySyncState);
  const syncing = sync.phase === "starting" || sync.phase === "collecting";

  // Marketplaces available from the discovered profiles. Defaulting the sync to
  // only the marketplaces that actually carry ad spend (typically UK) keeps the
  // number of async reports Amazon has to generate small — and the sync fast.
  const adsCountries = credential ? Object.keys(credential.ads_profile_ids || {}).sort() : [];
  const adsCountryKey = adsCountries.join(",");
  const [selectedCountries, setSelectedCountries] = useState<string[]>([]);
  const countriesInit = useRef(false);
  useEffect(() => {
    if (!countriesInit.current && adsCountries.length > 0) {
      countriesInit.current = true;
      setSelectedCountries(adsCountries.includes("UK") ? ["UK"] : adsCountries);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [adsCountryKey]);
  const toggleCountry = (c: string) =>
    setSelectedCountries((prev) => (prev.includes(c) ? prev.filter((x) => x !== c) : [...prev, c]));
  // Cancellation flag so polling stops if the component unmounts / modal closes.
  const syncCancelled = useRef(false);
  useEffect(() => {
    return () => {
      syncCancelled.current = true;
    };
  }, []);

  const runSync = async () => {
    syncCancelled.current = false;
    setSync({ ...emptySyncState, phase: "starting" });
    try {
      // Phase 1 — request the reports (returns fast).
      const res = await fetch("/api/amazon/ads/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          accountId,
          from: syncFrom,
          to: syncTo,
          countryCodes: selectedCountries.length ? selectedCountries : undefined,
        }),
      });
      const start = (await res.json()) as
        | { ok: true; batchId: string; jobsRequested: number; range: { from: string; to: string }; warnings: string[] }
        | { ok: false; error: string };
      if (!start.ok) {
        setSync({ ...emptySyncState, phase: "error", error: start.error });
        return;
      }
      if (start.jobsRequested === 0) {
        setSync({
          ...emptySyncState,
          phase: "done",
          range: start.range,
          warnings: start.warnings.length ? start.warnings : ["No reports could be requested for this range."],
        });
        return;
      }

      const reports: AdsSyncReport[] = [];
      const warnings = [...start.warnings];
      setSync({
        ...emptySyncState,
        phase: "collecting",
        range: start.range,
        jobsRequested: start.jobsRequested,
        pending: start.jobsRequested,
        warnings,
      });

      // Phase 2 — poll the collect endpoint until no jobs remain pending.
      const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
      const maxAttempts = 80; // ~13 min at 10s spacing — generous headroom.
      for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
        if (syncCancelled.current) return;
        await sleep(10000);
        if (syncCancelled.current) return;
        const cres = await fetch("/api/amazon/ads/collect", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ accountId }),
        });
        const c = (await cres.json()) as
          | {
              ok: true;
              pending: number;
              completed: number;
              failed: number;
              finalized: boolean;
              reports: AdsSyncReport[];
              warnings: string[];
            }
          | { ok: false; error: string };
        if (!c.ok) {
          // A transient collect error shouldn't abort — keep polling, but
          // surface it.
          warnings.push(`Collect attempt failed: ${c.error}`);
          setSync((s) => ({ ...s, warnings: [...warnings] }));
          continue;
        }
        for (const r of c.reports) {
          if (!reports.some((x) => x.reportId === r.reportId)) reports.push(r);
        }
        for (const w of c.warnings) if (!warnings.includes(w)) warnings.push(w);
        setSync((s) => ({
          ...s,
          phase: c.pending > 0 ? "collecting" : "done",
          pending: c.pending,
          completed: s.completed + c.completed,
          failed: s.failed + c.failed,
          reports: [...reports],
          warnings: [...warnings],
        }));
        if (c.pending === 0) return;
      }
      setSync((s) => ({
        ...s,
        phase: "done",
        warnings: [
          ...s.warnings,
          "Still collecting in the background — Amazon hasn't finished generating all reports. They'll be ingested automatically; re-open this panel later to confirm.",
        ],
      }));
    } catch (err) {
      setSync((s) => ({ ...s, phase: "error", error: err instanceof Error ? err.message : "Network error." }));
    }
  };

  const runSmokeTest = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const res = await fetch(`/api/amazon/ads/test?accountId=${encodeURIComponent(accountId)}`);
      const json = (await res.json()) as AdsTestResult;
      setTestResult(json);
    } catch (err) {
      setTestResult({ ok: false, error: err instanceof Error ? err.message : "Network error." });
    } finally {
      setTesting(false);
    }
  };

  // Pin the credential to one advertiser (seller). For agency connections this
  // is what stops the sync pulling every seller in the agency — only the chosen
  // advertiser's per-marketplace profiles are stored.
  const pinAdvertiser = async (advertiser: string) => {
    setPinningAdvertiser(true);
    try {
      const res = await fetch(
        `/api/amazon/ads/test?accountId=${encodeURIComponent(accountId)}&advertiser=${encodeURIComponent(advertiser)}`
      );
      const json = (await res.json()) as AdsTestResult;
      setTestResult(json);
      await onRefresh();
    } catch (err) {
      setTestResult({ ok: false, error: err instanceof Error ? err.message : "Network error." });
    } finally {
      setPinningAdvertiser(false);
    }
  };

  const saveManualToken = async () => {
    setManualSaving(true);
    setManualError(null);
    try {
      const res = await fetch("/api/amazon/ads/oauth/manual-token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accountId, refreshToken: manualToken.trim() }),
      });
      const json = await res.json();
      if (!res.ok || !json.ok) throw new Error(json.error || `HTTP ${res.status}`);
      setManualToken("");
      setShowManual(false);
      onSavedManual(json.accountName);
    } catch (err) {
      setManualError(err instanceof Error ? err.message : "Failed to save refresh token.");
    } finally {
      setManualSaving(false);
    }
  };

  const connectHref = `/api/amazon/ads/oauth/start?accountId=${encodeURIComponent(accountId)}&region=${encodeURIComponent(region)}`;
  const profileCount = credential ? Object.keys(credential.ads_profile_ids || {}).length : 0;

  return (
    <div className="rounded-xl border border-slate-200 bg-white px-4 py-3">
      <div className="mb-2 flex items-center justify-between">
        <div>
          <h6 className="text-sm font-semibold text-slate-900">Amazon Ads API Connection</h6>
          <p className="text-xs text-slate-500">
            Pulls Sponsored Products spend (per-SKU, per-day) so the portal can reconcile ad spend
            against sales without uploading the Ads CSV each month.
          </p>
        </div>
        <span
          className={`rounded-full px-2 py-0.5 text-xs font-semibold ${
            connected ? "bg-emerald-100 text-emerald-800" : "bg-slate-100 text-slate-600"
          }`}
        >
          {connected ? "Connected" : "Not connected"}
        </span>
      </div>

      {connected && credential ? (
        <div className="space-y-1 text-xs text-slate-600">
          {credential.ads_advertiser_name ? (
            <div>
              <span className="text-slate-500">Advertiser: </span>
              <span className="font-semibold text-slate-800">{credential.ads_advertiser_name}</span>
            </div>
          ) : null}
          <div>
            <span className="text-slate-500">Profiles: </span>
            {profileCount > 0
              ? Object.entries(credential.ads_profile_ids)
                  .map(([country, id]) => `${country} (${id})`)
                  .join(", ")
              : "—"}
          </div>
          <div>
            <span className="text-slate-500">Connected: </span>
            {new Date(credential.connected_at).toLocaleString()}
          </div>
          <div>
            <span className="text-slate-500">Last sync: </span>
            {credential.last_synced_at ? new Date(credential.last_synced_at).toLocaleString() : "—"}
          </div>
          {credential.last_sync_error ? (
            <div className="mt-1 rounded bg-red-50 px-2 py-1 text-red-700">
              Last sync error: {credential.last_sync_error}
            </div>
          ) : null}
        </div>
      ) : (
        <p className="text-xs text-slate-600">
          Click <strong>Connect Amazon Ads</strong>. You&apos;ll be sent to Amazon Ads to sign in and
          approve the app. After approval, profiles for each marketplace will be auto-discovered.
        </p>
      )}

      <div className="mt-3 flex flex-wrap items-end gap-2">
        <div>
          <label className="mb-1 block text-xs font-medium text-slate-700">Region</label>
          <select
            value={region}
            onChange={(e) => onRegionChange(e.target.value)}
            className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm"
            disabled={connected}
          >
            <option value="eu">EU (UK, DE, FR, IT, ES, NL)</option>
            <option value="na">North America (US, CA, MX)</option>
            <option value="fe">Far East (JP, AU)</option>
          </select>
        </div>

        {connected ? (
          <button
            type="button"
            onClick={onDisconnect}
            disabled={disconnecting}
            className="rounded-lg bg-red-50 px-4 py-2 text-sm font-semibold text-red-700 disabled:opacity-60"
          >
            {disconnecting ? "Disconnecting..." : "Disconnect Ads"}
          </button>
        ) : (
          <a
            href={connectHref}
            className="rounded-lg bg-[var(--md-primary)] px-4 py-2 text-sm font-semibold text-white hover:opacity-90"
          >
            Connect Amazon Ads
          </a>
        )}
      </div>

      {connected ? (
        <div className="mt-3 border-t border-slate-200 pt-3">
          <div className="mb-2 flex items-center justify-between">
            <p className="text-xs font-semibold text-slate-700">Profile discovery / smoke test</p>
            <button
              type="button"
              onClick={() => void runSmokeTest()}
              disabled={testing}
              className="rounded-lg bg-slate-100 px-3 py-1.5 text-xs font-semibold text-slate-700 disabled:opacity-60"
            >
              {testing ? "Testing…" : "Test Ads API"}
            </button>
          </div>
          {testResult ? (
            testResult.ok ? (
              <div className="space-y-1 rounded-lg bg-emerald-50 px-3 py-2 text-xs text-emerald-900">
                <div>
                  <strong>✓ Ads API responded.</strong> Region <code>{testResult.region}</code> ·{" "}
                  {testResult.profileCount} profile{testResult.profileCount === 1 ? "" : "s"} discovered
                </div>
                {testResult.advertiserOptions && testResult.advertiserOptions.length > 1 ? (
                  <div className="mt-2 rounded-lg border border-emerald-200 bg-white px-3 py-2 text-slate-700">
                    <p className="mb-1 font-semibold text-slate-800">
                      This connection sees {testResult.advertiserOptions.length} advertisers (agency account)
                    </p>
                    <p className="mb-2 text-[11px] text-slate-500">
                      Pick the one advertiser this portal account belongs to. Only its per-marketplace
                      profiles will be stored and synced.
                    </p>
                    <select
                      value={testResult.selectedAdvertiser || credential?.ads_advertiser_name || ""}
                      onChange={(e) => {
                        if (e.target.value) void pinAdvertiser(e.target.value);
                      }}
                      disabled={pinningAdvertiser}
                      className="w-full rounded-lg border border-slate-300 px-3 py-1.5 text-sm disabled:opacity-60"
                    >
                      <option value="">{pinningAdvertiser ? "Saving…" : "Select advertiser…"}</option>
                      {testResult.advertiserOptions.map((name) => (
                        <option key={name} value={name}>
                          {name}
                        </option>
                      ))}
                    </select>
                    {(testResult.selectedAdvertiser || credential?.ads_advertiser_name) ? (
                      <p className="mt-1 text-[11px] text-emerald-700">
                        Pinned to <strong>{testResult.selectedAdvertiser || credential?.ads_advertiser_name}</strong> ·{" "}
                        {Object.keys(testResult.selectedProfileIds || {}).length} marketplace
                        {Object.keys(testResult.selectedProfileIds || {}).length === 1 ? "" : "s"}
                      </p>
                    ) : null}
                  </div>
                ) : null}
                {testResult.profiles && testResult.profiles.length > 0 ? (
                  <details className="mt-1">
                    <summary className="cursor-pointer text-[11px] text-emerald-800">
                      Show all {testResult.profiles.length} discovered profiles
                    </summary>
                    <ul className="ml-4 mt-1 list-disc space-y-0.5">
                      {testResult.profiles.map((p) => (
                        <li key={p.profileId}>
                          <strong>{p.countryCode}</strong> · {p.accountName} ({p.accountType},{" "}
                          {p.currencyCode}) · profile <code>{p.profileId}</code>
                        </li>
                      ))}
                    </ul>
                  </details>
                ) : null}
              </div>
            ) : (
              <div className="rounded-lg bg-red-50 px-3 py-2 text-xs text-red-800">
                <strong>✗ Test failed.</strong>
                <div className="mt-1 break-all font-mono">{testResult.error}</div>
              </div>
            )
          ) : (
            <p className="text-xs text-slate-500">
              Validates the stored refresh token by calling listProfiles and refreshes the
              per-marketplace profile map.
            </p>
          )}
        </div>
      ) : null}

      {connected ? (
        <div className="mt-3 border-t border-slate-200 pt-3">
          <div className="mb-2">
            <p className="text-xs font-semibold text-slate-700">Sync ad spend from Amazon</p>
            <p className="text-xs text-slate-500">
              Pulls Sponsored Products spend (per-SKU, per-day) for the window and folds it into
              one report per month. Replaces any existing ads data for the same months.
            </p>
          </div>
          {adsCountries.length > 0 ? (
            <div className="mb-3">
              <div className="mb-1 flex items-center justify-between">
                <label className="block text-xs font-medium text-slate-700">Marketplaces</label>
                <div className="flex gap-2 text-[11px]">
                  <button
                    type="button"
                    onClick={() => setSelectedCountries(adsCountries)}
                    className="font-semibold text-[var(--md-primary)] hover:underline"
                  >
                    Select all
                  </button>
                  <span className="text-slate-300">|</span>
                  <button
                    type="button"
                    onClick={() => setSelectedCountries(adsCountries.includes("UK") ? ["UK"] : adsCountries.slice(0, 1))}
                    className="font-semibold text-slate-500 hover:underline"
                  >
                    UK only
                  </button>
                </div>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {adsCountries.map((c) => {
                  const active = selectedCountries.includes(c);
                  return (
                    <button
                      key={c}
                      type="button"
                      onClick={() => toggleCountry(c)}
                      className={`rounded-full px-2.5 py-1 text-xs font-semibold transition-colors ${
                        active
                          ? "bg-[var(--md-primary)] text-white"
                          : "bg-slate-100 text-slate-600 hover:bg-slate-200"
                      }`}
                    >
                      {c}
                    </button>
                  );
                })}
              </div>
              <p className="mt-1 text-[11px] text-slate-400">
                Fewer marketplaces = far fewer reports for Amazon to generate, so the sync finishes
                much faster. Only include marketplaces where you actually run Sponsored Products.
              </p>
            </div>
          ) : null}
          <div className="flex flex-wrap items-end gap-2">
            <div>
              <label className="mb-1 block text-xs font-medium text-slate-700">From</label>
              <input
                type="date"
                value={syncFrom}
                onChange={(e) => setSyncFrom(e.target.value)}
                className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-slate-700">To</label>
              <input
                type="date"
                value={syncTo}
                onChange={(e) => setSyncTo(e.target.value)}
                className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm"
              />
            </div>
            <button
              type="button"
              onClick={() => void runSync()}
              disabled={syncing || !syncFrom || !syncTo || syncFrom > syncTo || selectedCountries.length === 0}
              className="rounded-lg bg-[var(--md-primary)] px-4 py-2 text-sm font-semibold text-white disabled:opacity-60"
            >
              {sync.phase === "starting"
                ? "Requesting reports…"
                : sync.phase === "collecting"
                  ? "Collecting…"
                  : "Sync ads from Amazon"}
            </button>
          </div>
          <p className="mt-1 text-[11px] text-slate-400">
            Amazon generates ad reports asynchronously and may take several minutes. You can leave this
            panel — collection continues automatically in the background.
          </p>
          {sync.phase === "collecting" ? (
            <div className="mt-3 space-y-1 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-900">
              <div className="flex items-center gap-2">
                <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-amber-400 border-t-transparent" />
                <strong>Collecting reports from Amazon…</strong>
              </div>
              <div>
                {sync.jobsRequested - sync.pending} of {sync.jobsRequested} reports ready
                {sync.failed > 0 ? ` · ${sync.failed} failed` : ""}
                {sync.range ? ` (${sync.range.from} → ${sync.range.to})` : ""}
              </div>
              {sync.reports.length > 0 ? (
                <ul className="ml-4 list-disc space-y-0.5">
                  {sync.reports.map((r) => (
                    <li key={r.reportId}>
                      <strong>{r.periodStart}</strong> → {r.periodEnd}: £
                      {r.totalSpendExvat.toLocaleString(undefined, {
                        minimumFractionDigits: 2,
                        maximumFractionDigits: 2,
                      })}{" "}
                      ex-VAT ingested
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          ) : sync.phase === "done" ? (
            <div className="mt-3 space-y-1 rounded-lg bg-emerald-50 px-3 py-2 text-xs text-emerald-900">
              <div>
                <strong>✓ Sync complete.</strong>{" "}
                {sync.jobsRequested > 0
                  ? `${sync.jobsRequested - sync.pending} of ${sync.jobsRequested} reports collected`
                  : ""}
                {sync.range ? ` (${sync.range.from} → ${sync.range.to})` : ""}
              </div>
              {sync.reports.length > 0 ? (
                <ul className="ml-4 list-disc space-y-0.5">
                  {sync.reports.map((r) => (
                    <li key={r.reportId}>
                      <strong>{r.periodStart}</strong> → {r.periodEnd}: {r.skuCount.toLocaleString()} SKU
                      {r.skuCount === 1 ? "" : "s"}, £
                      {r.totalSpendExvat.toLocaleString(undefined, {
                        minimumFractionDigits: 2,
                        maximumFractionDigits: 2,
                      })}
                      {" ex-VAT"}
                      {r.reportCreated ? " · new report created" : ""}
                    </li>
                  ))}
                </ul>
              ) : (
                <div>No ad spend found in this date range.</div>
              )}
              {sync.warnings.length > 0 ? (
                <div className="mt-1 rounded bg-amber-50 px-2 py-1 text-amber-800">
                  {sync.warnings.map((w, i) => (
                    <div key={i}>• {w}</div>
                  ))}
                </div>
              ) : null}
            </div>
          ) : sync.phase === "error" ? (
            <div className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-800">
              <strong>✗ Sync failed.</strong>
              <div className="mt-1 break-all font-mono">{sync.error}</div>
            </div>
          ) : null}
        </div>
      ) : null}

      <div className="mt-3 border-t border-slate-200 pt-2">
        <button
          type="button"
          onClick={() => setShowManual((v) => !v)}
          className="text-xs font-semibold text-slate-600 hover:text-slate-900"
        >
          {showManual ? "▾" : "▸"} Advanced: paste refresh token manually
        </button>
        {showManual ? (
          <div className="mt-2 space-y-2 rounded-lg bg-slate-50 p-3">
            <p className="text-xs text-slate-600">
              For developer self-authorization (when Amazon shows the refresh token directly in the
              Ads LWA console). Validated against Amazon before being stored. Saving this
              {connected ? " will REPLACE the existing connection." : " creates a connection without OAuth."}
            </p>
            <div>
              <label className="mb-1 block text-xs font-medium text-slate-700">
                Refresh token (starts with <code>Atzr|</code>)
              </label>
              <textarea
                value={manualToken}
                onChange={(e) => setManualToken(e.target.value)}
                rows={3}
                placeholder="Atzr|IwEBI..."
                className="w-full rounded-lg border border-slate-300 px-2 py-1.5 font-mono text-xs"
              />
            </div>
            {manualError ? (
              <div className="rounded bg-red-50 px-2 py-1 text-xs text-red-700">{manualError}</div>
            ) : null}
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => void saveManualToken()}
                disabled={manualSaving || !manualToken.trim()}
                className="rounded-lg bg-[var(--md-primary)] px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-60"
              >
                {manualSaving ? "Validating with Amazon…" : "Validate & save"}
              </button>
              <button
                type="button"
                onClick={() => {
                  setShowManual(false);
                  setManualToken("");
                  setManualError(null);
                }}
                className="rounded-lg bg-slate-200 px-3 py-1.5 text-xs font-semibold text-slate-700"
              >
                Cancel
              </button>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function ClientPicker({ clientUsers, selected, onChange }: { clientUsers: UserRow[]; selected: string[]; onChange: (ids: string[]) => void }) {
  if (clientUsers.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-slate-300 p-3 text-xs text-slate-500">
        No client users exist yet. Create one under Users Management first.
      </div>
    );
  }
  return (
    <div className="rounded-lg border border-slate-300 p-2">
      <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">Assigned Clients ({selected.length} selected)</p>
      <div className="grid max-h-40 gap-1 overflow-auto">
        {clientUsers.map((client) => (
          <label key={client.id} className="flex items-center gap-2 rounded px-2 py-1 text-sm hover:bg-slate-50">
            <input
              type="checkbox"
              checked={selected.includes(client.id)}
              onChange={(e) =>
                e.target.checked
                  ? onChange(Array.from(new Set([...selected, client.id])))
                  : onChange(selected.filter((id) => id !== client.id))
              }
            />
            <span className="flex-1">{client.full_name}</span>
            <span className="text-xs text-slate-500">{client.email}</span>
          </label>
        ))}
      </div>
    </div>
  );
}
