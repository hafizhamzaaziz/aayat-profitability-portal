"use client";

import { useEffect, useMemo, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import FileDropzone from "@/components/ui/file-dropzone";

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
  const [leadTimeDays, setLeadTimeDays] = useState("90");
  const [amazonCoverDays, setAmazonCoverDays] = useState("30");
  const [warehouseCoverDays, setWarehouseCoverDays] = useState("120");
  const [storageCostPerPallet, setStorageCostPerPallet] = useState("0");
  const [storageCostPeriod, setStorageCostPeriod] = useState<"week" | "month">("month");

  useEffect(() => {
    let active = true;
    const loadInventoryDefaults = async () => {
      const supabase = createClient();
      const { data, error: defaultsError } = await supabase
        .from("inventory_defaults")
        .select("lead_time_days, amazon_cover_days, warehouse_cover_days, storage_cost_per_pallet, storage_cost_period")
        .eq("account_id", account.id)
        .maybeSingle();
      if (!active || defaultsError) return;
      if (!data) return;
      const row = data as {
        lead_time_days?: number;
        amazon_cover_days?: number;
        warehouse_cover_days?: number;
        storage_cost_per_pallet?: number;
        storage_cost_period?: "week" | "month";
      };
      setLeadTimeDays(String(row.lead_time_days ?? 90));
      setAmazonCoverDays(String(row.amazon_cover_days ?? 30));
      setWarehouseCoverDays(String(row.warehouse_cover_days ?? 120));
      setStorageCostPerPallet(String(row.storage_cost_per_pallet ?? 0));
      setStorageCostPeriod(row.storage_cost_period || "month");
    };
    void loadInventoryDefaults();
    return () => {
      active = false;
    };
  }, [account.id]);

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

      const { error: defaultsSaveError } = await supabase.from("inventory_defaults").upsert(
        {
          account_id: account.id,
          lead_time_days: Number(leadTimeDays || 0),
          amazon_cover_days: Number(amazonCoverDays || 0),
          warehouse_cover_days: Number(warehouseCoverDays || 0),
          storage_cost_per_pallet: Number(storageCostPerPallet || 0),
          storage_cost_period: storageCostPeriod,
        },
        { onConflict: "account_id" }
      );
      if (defaultsSaveError) throw defaultsSaveError;

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

      <div className="rounded-2xl border border-slate-200 bg-white p-4">
        <p className="mb-3 text-sm font-semibold text-slate-800">Inventory Planning Defaults</p>
        <div className="grid gap-4 md:grid-cols-2">
          <div>
            <label className="mb-1 block text-sm font-medium text-slate-700">Lead Time Default (days)</label>
            <input
              type="number"
              value={leadTimeDays}
              onChange={(event) => setLeadTimeDays(event.target.value)}
              className="w-full rounded-2xl border border-slate-300 bg-white px-3 py-2 text-sm outline-none focus:border-[var(--md-primary)]"
            />
          </div>
          <div>
            <label className="mb-1 block text-sm font-medium text-slate-700">Amazon Cover (days)</label>
            <input
              type="number"
              value={amazonCoverDays}
              onChange={(event) => setAmazonCoverDays(event.target.value)}
              className="w-full rounded-2xl border border-slate-300 bg-white px-3 py-2 text-sm outline-none focus:border-[var(--md-primary)]"
            />
          </div>
          <div>
            <label className="mb-1 block text-sm font-medium text-slate-700">Warehouse Cover (days)</label>
            <input
              type="number"
              value={warehouseCoverDays}
              onChange={(event) => setWarehouseCoverDays(event.target.value)}
              className="w-full rounded-2xl border border-slate-300 bg-white px-3 py-2 text-sm outline-none focus:border-[var(--md-primary)]"
            />
          </div>
          <div>
            <label className="mb-1 block text-sm font-medium text-slate-700">Storage Cost / Pallet</label>
            <div className="grid grid-cols-[1fr_130px] gap-2">
              <input
                type="number"
                step="0.01"
                value={storageCostPerPallet}
                onChange={(event) => setStorageCostPerPallet(event.target.value)}
                className="w-full rounded-2xl border border-slate-300 bg-white px-3 py-2 text-sm outline-none focus:border-[var(--md-primary)]"
              />
              <select
                value={storageCostPeriod}
                onChange={(event) => setStorageCostPeriod(event.target.value as "week" | "month")}
                className="w-full rounded-2xl border border-slate-300 bg-white px-3 py-2 text-sm outline-none focus:border-[var(--md-primary)]"
              >
                <option value="week">Per week</option>
                <option value="month">Per month</option>
              </select>
            </div>
          </div>
        </div>
      </div>

      <div>
        <label className="mb-1 block text-sm font-medium text-slate-700">Account Logo</label>
        <FileDropzone
          accept="image/*"
          onFileSelect={(file) => setLogoFile(file)}
          label="Upload account logo"
          hint="PNG, JPG, WEBP"
          selectedFileName={logoFile?.name}
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
