"use client";

import { useMemo, useState } from "react";
import { createClient } from "@/lib/supabase/client";

type Props = {
  account: {
    id: string;
    name: string;
    currency: string;
    vat_rate: number;
    logo_url: string | null;
  };
};

export default function AccountSettingsForm({ account }: Props) {
  const [currency, setCurrency] = useState(account.currency || "£");
  const [vatRate, setVatRate] = useState(String(account.vat_rate ?? 20));
  const [logoUrl, setLogoUrl] = useState(account.logo_url || "");
  const [logoFile, setLogoFile] = useState<File | null>(null);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const previewLogo = useMemo(() => {
    if (logoFile) {
      return URL.createObjectURL(logoFile);
    }
    return logoUrl;
  }, [logoFile, logoUrl]);

  const saveSettings = async () => {
    setSaving(true);
    setMessage(null);
    setError(null);

    try {
      const supabase = createClient();
      let nextLogoUrl = logoUrl;

      if (logoFile) {
        const extension = logoFile.name.split(".").pop() || "png";
        const filePath = `${account.id}/${Date.now()}.${extension}`;

        const { error: uploadError } = await supabase.storage
          .from("account_logos")
          .upload(filePath, logoFile, { upsert: true });

        if (uploadError) {
          throw uploadError;
        }

        const { data } = supabase.storage.from("account_logos").getPublicUrl(filePath);
        nextLogoUrl = data.publicUrl;
      }

      const { error: updateError } = await supabase
        .from("accounts")
        .update({
          currency,
          vat_rate: Number(vatRate),
          logo_url: nextLogoUrl || null,
        })
        .eq("id", account.id);

      if (updateError) {
        throw updateError;
      }

      setLogoUrl(nextLogoUrl || "");
      setLogoFile(null);
      setMessage("Account settings updated successfully.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save account settings.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-5">
      <div className="rounded-2xl border border-slate-200 bg-white p-4">
        <p className="text-xs uppercase tracking-wide text-slate-500">Selected account</p>
        <p className="mt-1 text-lg font-semibold">{account.name}</p>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <div>
          <label className="mb-1 block text-sm font-medium text-slate-700">Currency</label>
          <select
            value={currency}
            onChange={(event) => setCurrency(event.target.value)}
            className="w-full rounded-2xl border border-slate-300 bg-white px-3 py-2 text-sm outline-none focus:border-[var(--md-primary)]"
          >
            <option value="£">GBP (£)</option>
            <option value="$">USD ($)</option>
            <option value="€">EUR (€)</option>
          </select>
        </div>

        <div>
          <label className="mb-1 block text-sm font-medium text-slate-700">VAT Rate (%)</label>
          <input
            type="number"
            min={0}
            max={100}
            step="0.01"
            value={vatRate}
            onChange={(event) => setVatRate(event.target.value)}
            className="w-full rounded-2xl border border-slate-300 bg-white px-3 py-2 text-sm outline-none focus:border-[var(--md-primary)]"
          />
        </div>
      </div>

      <div>
        <label className="mb-1 block text-sm font-medium text-slate-700">Account Logo</label>
        <input
          type="file"
          accept="image/*"
          onChange={(event) => setLogoFile(event.target.files?.[0] ?? null)}
          className="w-full rounded-2xl border border-slate-300 bg-white px-3 py-2 text-sm"
        />
        {previewLogo ? (
          <div className="mt-3 inline-flex rounded-2xl border border-slate-200 bg-white p-3">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={previewLogo} alt="Account logo preview" className="h-14 w-auto object-contain" />
          </div>
        ) : (
          <p className="mt-2 text-sm text-slate-500">No logo uploaded yet.</p>
        )}
      </div>

      {message ? <p className="rounded-2xl bg-green-50 px-3 py-2 text-sm text-green-700">{message}</p> : null}
      {error ? <p className="rounded-2xl bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p> : null}

      <button
        type="button"
        onClick={saveSettings}
        disabled={saving}
        className="rounded-2xl bg-[var(--md-primary)] px-4 py-2 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-60"
      >
        {saving ? "Saving..." : "Save account settings"}
      </button>
    </div>
  );
}
