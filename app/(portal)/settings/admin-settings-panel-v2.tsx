"use client";

import { useEffect, useMemo, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import type { UserRole } from "@/lib/types/auth";
import AuditEventsPanel from "./audit-events-panel";

type UserRow = { id: string; full_name: string; email: string; role: UserRole };
type AccountRow = { id: string; name: string; currency: string; vat_rate: number; assigned_client_id: string | null };
type AccountForm = { name: string; currency: string; vatRate: string; assignedClientId: string; assignedTeamIds: string[] };
type UserForm = { fullName: string; email: string; role: UserRole; password: string };

const emptyAccount: AccountForm = { name: "", currency: "£", vatRate: "20", assignedClientId: "", assignedTeamIds: [] };
const emptyUser: UserForm = { fullName: "", email: "", role: "client", password: "" };

export default function AdminSettingsPanelV2({ currentUserId }: { currentUserId: string }) {
  const [accounts, setAccounts] = useState<AccountRow[]>([]);
  const [users, setUsers] = useState<UserRow[]>([]);
  const [accountTeamMap, setAccountTeamMap] = useState<Record<string, string[]>>({});
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

  const loadData = async () => {
    setLoading(true);
    setError(null);
    try {
      const supabase = createClient();
      const [{ data: usersData, error: usersError }, { data: accountsData, error: accountsError }, { data: linksData, error: linksError }] =
        await Promise.all([
          supabase.from("users").select("id, full_name, email, role").order("full_name", { ascending: true }),
          supabase.from("accounts").select("id, name, currency, vat_rate, assigned_client_id").order("name", { ascending: true }),
          supabase.from("account_team_members").select("account_id, team_id"),
        ]);
      if (usersError) throw usersError;
      if (accountsError) throw accountsError;
      if (linksError) throw linksError;

      const nextMap: Record<string, string[]> = {};
      ((linksData || []) as Array<{ account_id: string; team_id: string }>).forEach((row) => {
        if (!nextMap[row.account_id]) nextMap[row.account_id] = [];
        nextMap[row.account_id].push(row.team_id);
      });
      setUsers((usersData || []) as UserRow[]);
      setAccounts((accountsData || []) as AccountRow[]);
      setAccountTeamMap(nextMap);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load admin settings.");
    } finally {
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

  const openCreateAccount = () => {
    setAccountForm(emptyAccount);
    setEditAccountId(null);
    setCreateAccountOpen(true);
  };
  const openEditAccount = (account: AccountRow) => {
    setAccountForm({
      name: account.name,
      currency: account.currency,
      vatRate: String(account.vat_rate),
      assignedClientId: account.assigned_client_id || "",
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
      const payload = {
        name: accountForm.name.trim(),
        currency: accountForm.currency,
        vat_rate: Number(accountForm.vatRate || 0),
        assigned_client_id: accountForm.assignedClientId || null,
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
      } else {
        const { data: latest } = await supabase.from("accounts").select("id").eq("name", accountForm.name.trim()).order("created_at", { ascending: false }).limit(1).maybeSingle();
        if (latest?.id) await syncAccountTeams(String(latest.id), accountForm.assignedTeamIds);
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

      <section className="rounded-2xl border border-slate-200 bg-white p-4">
        <div className="mb-3 flex items-center justify-between"><h4 className="text-lg font-semibold">Accounts Management</h4><button onClick={openCreateAccount} className="rounded-lg bg-[var(--md-primary)] px-3 py-1.5 text-sm font-semibold text-white">Create</button></div>
        {loading ? <p className="text-sm text-slate-500">Loading accounts...</p> : <div className="space-y-2">{accounts.map((a) => <div key={a.id} className="flex items-center justify-between rounded-xl bg-slate-50 px-3 py-2 text-sm"><span>{a.name}</span><div className="flex gap-2"><button onClick={() => openEditAccount(a)} className="rounded-lg bg-slate-100 px-3 py-1 text-xs font-semibold">Edit</button><button onClick={() => void deleteAccount(a.id)} className="rounded-lg bg-red-50 px-3 py-1 text-xs font-semibold text-red-700">Delete</button></div></div>)}</div>}
      </section>

      <section className="rounded-2xl border border-slate-200 bg-white p-4">
        <div className="mb-3 flex items-center justify-between"><h4 className="text-lg font-semibold">Users Management</h4><button onClick={openCreateUser} className="rounded-lg bg-[var(--md-primary)] px-3 py-1.5 text-sm font-semibold text-white">Create</button></div>
        {loading ? (
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

      {(createAccountOpen || editAccountId) ? (
        <Modal title={editAccountId ? "Edit account" : "Create account"} onClose={() => { setCreateAccountOpen(false); setEditAccountId(null); }}>
          <div className="grid gap-3">
            <div><label className="mb-1 block text-sm font-medium text-slate-700">Account Name</label><p className="mb-1 text-xs text-slate-500">Display name used across portal and dropdown.</p><input value={accountForm.name} onChange={(e) => setAccountForm((p) => ({ ...p, name: e.target.value }))} placeholder="Account name" className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm" /></div>
            <div><label className="mb-1 block text-sm font-medium text-slate-700">Currency</label><p className="mb-1 text-xs text-slate-500">Default currency for calculations and reports.</p><select value={accountForm.currency} onChange={(e) => setAccountForm((p) => ({ ...p, currency: e.target.value }))} className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"><option value="£">GBP (£)</option><option value="$">USD ($)</option><option value="€">EUR (€)</option></select></div>
            <div><label className="mb-1 block text-sm font-medium text-slate-700">VAT Rate (%)</label><p className="mb-1 text-xs text-slate-500">Used to derive VAT and net values.</p><input type="number" step="0.01" min={0} max={100} value={accountForm.vatRate} onChange={(e) => setAccountForm((p) => ({ ...p, vatRate: e.target.value }))} placeholder="VAT rate %" className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm" /></div>
            <div><label className="mb-1 block text-sm font-medium text-slate-700">Assigned Client (optional)</label><p className="mb-1 text-xs text-slate-500">Primary client owner of this account.</p><select value={accountForm.assignedClientId} onChange={(e) => setAccountForm((p) => ({ ...p, assignedClientId: e.target.value }))} className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"><option value="">No client</option>{clientUsers.map((c) => <option key={c.id} value={c.id}>{c.full_name}</option>)}</select></div>
            <div><label className="mb-1 block text-sm font-medium text-slate-700">Assigned Team Members</label><p className="mb-1 text-xs text-slate-500">Multiple team users can be assigned to this account.</p><TeamPicker teamUsers={teamUsers} selected={accountForm.assignedTeamIds} onChange={(ids) => setAccountForm((p) => ({ ...p, assignedTeamIds: ids }))} /></div>
            <button onClick={() => void saveAccount()} disabled={saving} className="rounded-lg bg-[var(--md-primary)] px-3 py-2 text-sm font-semibold text-white disabled:opacity-60">{saving ? "Saving..." : "Save"}</button>
          </div>
        </Modal>
      ) : null}

      {(createUserOpen || editUserId) ? (
        <Modal title={editUserId ? "Edit user" : "Create user"} onClose={() => { setCreateUserOpen(false); setEditUserId(null); }}>
          <div className="grid gap-3">
            <div><label className="mb-1 block text-sm font-medium text-slate-700">Full Name</label><p className="mb-1 text-xs text-slate-500">User display name in portal.</p><input value={userForm.fullName} onChange={(e) => setUserForm((p) => ({ ...p, fullName: e.target.value }))} placeholder="Full name" className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm" /></div>
            <div><label className="mb-1 block text-sm font-medium text-slate-700">Email</label><p className="mb-1 text-xs text-slate-500">Login email for this user.</p><input type="email" value={userForm.email} onChange={(e) => setUserForm((p) => ({ ...p, email: e.target.value }))} placeholder="Email" className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm" /></div>
            <div><label className="mb-1 block text-sm font-medium text-slate-700">User Type</label><p className="mb-1 text-xs text-slate-500">Controls permissions in the portal.</p><select value={userForm.role} onChange={(e) => setUserForm((p) => ({ ...p, role: e.target.value as UserRole }))} className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"><option value="admin">Admin</option><option value="team">Team</option><option value="client">Client</option></select></div>
            <div><label className="mb-1 block text-sm font-medium text-slate-700">{editUserId ? "New Password (optional)" : "Temporary Password"}</label><p className="mb-1 text-xs text-slate-500">{editUserId ? "Leave blank to keep existing password." : "User can change later."}</p><input type="password" value={userForm.password} onChange={(e) => setUserForm((p) => ({ ...p, password: e.target.value }))} placeholder={editUserId ? "New password (optional)" : "Temporary password"} className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm" /></div>
            <button onClick={() => void saveUser()} disabled={saving} className="rounded-lg bg-[var(--md-primary)] px-3 py-2 text-sm font-semibold text-white disabled:opacity-60">{saving ? "Saving..." : "Save"}</button>
          </div>
        </Modal>
      ) : null}

      <AuditEventsPanel />
    </div>
  );
}

function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/35 p-4"><div className="w-full max-w-lg rounded-2xl bg-white p-4 shadow-xl"><div className="mb-3 flex items-center justify-between"><h5 className="text-base font-semibold">{title}</h5><button onClick={onClose} className="rounded-md px-2 py-1 text-sm text-slate-600 hover:bg-slate-100">Close</button></div>{children}</div></div>;
}

function TeamPicker({ teamUsers, selected, onChange }: { teamUsers: UserRow[]; selected: string[]; onChange: (ids: string[]) => void }) {
  return <div className="rounded-lg border border-slate-300 p-2"><p className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">Assigned Team Members</p><div className="grid max-h-40 gap-1 overflow-auto">{teamUsers.map((team) => <label key={team.id} className="flex items-center gap-2 rounded px-2 py-1 text-sm hover:bg-slate-50"><input type="checkbox" checked={selected.includes(team.id)} onChange={(e) => e.target.checked ? onChange(Array.from(new Set([...selected, team.id]))) : onChange(selected.filter((id) => id !== team.id))} />{team.full_name}</label>)}</div></div>;
}
