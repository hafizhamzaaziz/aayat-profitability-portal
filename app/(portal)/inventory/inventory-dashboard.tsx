"use client";

import { useEffect, useMemo, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import Papa from "papaparse";
import * as XLSX from "xlsx";
import FileDropzone from "@/components/ui/file-dropzone";
import {
  buildInventoryRows,
  type CogsRow,
  type InventoryDefaults,
  type InventoryLevelRow,
  type MonthlySalesRow,
  palletEstimate,
  type PackProfile,
  type SkuRef,
} from "@/lib/inventory/engine";
import { formatUkDate, todayIsoUtc } from "@/lib/utils/date";

type Props = {
  accountId: string;
  canEdit: boolean;
  currency: string;
};

type PlanRowOverride = {
  plannedUnits: number;
  plannedBoxes: number;
};

type InventoryTab = "overview" | "stock-intake" | "shipment-planning";
type IntakeAction = "supplier_inbound" | "seller_returns" | "b2b_wholesale" | "amazon_transfer";

const DEFAULTS: InventoryDefaults = {
  leadTimeDays: 90,
  amazonCoverDays: 30,
  warehouseCoverDays: 120,
  storageCostPerPallet: 0,
  storageCostPeriod: "month",
};

function monthStartIso(input: string) {
  if (!input) return `${todayIsoUtc().slice(0, 7)}-01`;
  return `${input.slice(0, 7)}-01`;
}

export default function InventoryDashboard({ accountId, canEdit, currency }: Props) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [activeTab, setActiveTab] = useState<InventoryTab>("overview");

  const [mappings, setMappings] = useState<SkuRef[]>([]);
  const [cogs, setCogs] = useState<CogsRow[]>([]);
  const [salesRows, setSalesRows] = useState<MonthlySalesRow[]>([]);
  const [levels, setLevels] = useState<InventoryLevelRow[]>([]);
  const [packProfiles, setPackProfiles] = useState<PackProfile[]>([]);
  const [defaults, setDefaults] = useState<InventoryDefaults>(DEFAULTS);

  const [salesMonthInput, setSalesMonthInput] = useState(todayIsoUtc().slice(0, 7));
  const [salesDraft, setSalesDraft] = useState<Record<string, { amazonUnits: number; temuUnits: number }>>({});

  const [stockDate, setStockDate] = useState(todayIsoUtc());
  const [stockDraft, setStockDraft] = useState<Record<string, { amazonUnits: number; warehouseUnits: number }>>({});

  const [intake, setIntake] = useState({
    mappingId: "",
    actionType: "supplier_inbound" as IntakeAction,
    destination: "warehouse" as "warehouse" | "amazon",
    units: "",
    boxes: "",
    profileId: "",
    movementDate: todayIsoUtc(),
    notes: "",
  });

  const [newProfile, setNewProfile] = useState({
    profileName: "",
    unitsPerBox: "",
    boxLength: "",
    boxWidth: "",
    boxHeight: "",
    dimensionUnit: "cm" as "mm" | "cm" | "in",
    boxWeight: "",
    weightUnit: "kg" as "kg" | "lb",
  });

  const [selectedMappingIds, setSelectedMappingIds] = useState<string[]>([]);
  const [planType, setPlanType] = useState<"amazon_requirement" | "warehouse_requirement">("amazon_requirement");
  const [planTitle, setPlanTitle] = useState("Weekly replenishment plan");
  const [planNotes, setPlanNotes] = useState("");
  const [profileByMapping, setProfileByMapping] = useState<Record<string, string>>({});
  const [overrides, setOverrides] = useState<Record<string, PlanRowOverride>>({});
  const [savedPlanId, setSavedPlanId] = useState<string | null>(null);

  const nowIso = todayIsoUtc();

  const loadAll = async () => {
    setLoading(true);
    setError(null);
    const supabase = createClient();

    const [mappingRes, defaultsRes, salesRes, levelRes, cogsRes, profilesRes] = await Promise.all([
      supabase
        .from("sku_mappings")
        .select("id, amazon_sku, temu_sku_id, lead_time_days, sku_catalog:sku_catalog_id(product_name)")
        .eq("account_id", accountId)
        .order("created_at", { ascending: false }),
      supabase.from("inventory_defaults").select("*").eq("account_id", accountId).maybeSingle(),
      supabase
        .from("sku_monthly_sales")
        .select("sku_mapping_id, month_start, amazon_units, temu_units")
        .eq("account_id", accountId),
      supabase
        .from("inventory_levels")
        .select("sku_mapping_id, level_date, amazon_units, warehouse_units")
        .eq("account_id", accountId),
      supabase.from("cogs").select("sku, unit_cost, sku_mapping_id").eq("account_id", accountId),
      supabase
        .from("pack_profiles")
        .select("id, profile_name, units_per_box, box_length, box_width, box_height, dimension_unit, box_weight, weight_unit")
        .eq("account_id", accountId)
        .order("created_at", { ascending: false }),
    ]);

    if (mappingRes.error) {
      setError(mappingRes.error.message);
      setLoading(false);
      return;
    }
    if (defaultsRes.error && defaultsRes.error.code !== "PGRST116") {
      setError(defaultsRes.error.message);
      setLoading(false);
      return;
    }
    if (salesRes.error) {
      setError(salesRes.error.message);
      setLoading(false);
      return;
    }
    if (levelRes.error) {
      setError(levelRes.error.message);
      setLoading(false);
      return;
    }
    if (cogsRes.error) {
      setError(cogsRes.error.message);
      setLoading(false);
      return;
    }
    if (profilesRes.error) {
      setError(profilesRes.error.message);
      setLoading(false);
      return;
    }

    const nextMappings: SkuRef[] = (mappingRes.data || []).map((row) => {
      const rec = row as unknown as {
        id: string;
        amazon_sku: string | null;
        temu_sku_id: string | null;
        lead_time_days: number | null;
        sku_catalog?: { product_name?: string } | null;
      };
      return {
        mappingId: rec.id,
        productName: rec.sku_catalog?.product_name || "Unnamed product",
        amazonSku: rec.amazon_sku,
        temuSkuId: rec.temu_sku_id,
        leadTimeDays: rec.lead_time_days,
      };
    });
    setMappings(nextMappings);

    const defaultsRow = defaultsRes.data as
      | {
          lead_time_days?: number;
          amazon_cover_days?: number;
          warehouse_cover_days?: number;
          storage_cost_per_pallet?: number;
          storage_cost_period?: "week" | "month";
        }
      | null;
    setDefaults({
      leadTimeDays: Number(defaultsRow?.lead_time_days ?? DEFAULTS.leadTimeDays),
      amazonCoverDays: Number(defaultsRow?.amazon_cover_days ?? DEFAULTS.amazonCoverDays),
      warehouseCoverDays: Number(defaultsRow?.warehouse_cover_days ?? DEFAULTS.warehouseCoverDays),
      storageCostPerPallet: Number(defaultsRow?.storage_cost_per_pallet ?? DEFAULTS.storageCostPerPallet),
      storageCostPeriod: defaultsRow?.storage_cost_period || DEFAULTS.storageCostPeriod,
    });

    setSalesRows(
      (salesRes.data || []).map((row) => {
        const rec = row as unknown as {
          sku_mapping_id: string;
          month_start: string;
          amazon_units: number;
          temu_units: number;
        };
        return {
          mappingId: rec.sku_mapping_id,
          monthStart: rec.month_start,
          amazonUnits: Number(rec.amazon_units || 0),
          temuUnits: Number(rec.temu_units || 0),
        };
      })
    );

    setLevels(
      (levelRes.data || []).map((row) => {
        const rec = row as unknown as {
          sku_mapping_id: string;
          level_date: string;
          amazon_units: number;
          warehouse_units: number;
        };
        return {
          mappingId: rec.sku_mapping_id,
          levelDate: rec.level_date,
          amazonUnits: Number(rec.amazon_units || 0),
          warehouseUnits: Number(rec.warehouse_units || 0),
        };
      })
    );

    const mappingById = new Map(nextMappings.map((m) => [m.mappingId, m]));
    setCogs(
      (cogsRes.data || []).map((row) => {
        const rec = row as unknown as { sku: string; unit_cost: number; sku_mapping_id: string | null };
        const mapping = rec.sku_mapping_id ? mappingById.get(rec.sku_mapping_id) : null;
        return {
          amazonSku: mapping?.amazonSku || rec.sku,
          temuSkuId: mapping?.temuSkuId || null,
          unitCost: Number(rec.unit_cost || 0),
        };
      })
    );

    setPackProfiles(
      (profilesRes.data || []).map((row) => {
        const rec = row as unknown as {
          id: string;
          profile_name: string;
          units_per_box: number;
          box_length: number;
          box_width: number;
          box_height: number;
          dimension_unit: "mm" | "cm" | "in";
          box_weight: number | null;
          weight_unit: "kg" | "lb";
        };
        return {
          id: rec.id,
          profileName: rec.profile_name,
          unitsPerBox: Number(rec.units_per_box),
          boxLength: Number(rec.box_length),
          boxWidth: Number(rec.box_width),
          boxHeight: Number(rec.box_height),
          dimensionUnit: rec.dimension_unit,
          boxWeight: rec.box_weight == null ? null : Number(rec.box_weight),
          weightUnit: rec.weight_unit,
        };
      })
    );

    setLoading(false);
  };

  useEffect(() => {
    void loadAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accountId]);

  const computedRows = useMemo(() => {
    return buildInventoryRows({
      mappings,
      monthlySales: salesRows,
      levels,
      cogs,
      defaults,
      nowIso,
    });
  }, [mappings, salesRows, levels, cogs, defaults, nowIso]);

  const visibleRows = useMemo(() => {
    if (!search.trim()) return computedRows;
    const q = search.trim().toLowerCase();
    return computedRows.filter((row) => {
      return (
        row.productName.toLowerCase().includes(q) ||
        String(row.amazonSku || "")
          .toLowerCase()
          .includes(q) ||
        String(row.temuSkuId || "")
          .toLowerCase()
          .includes(q)
      );
    });
  }, [computedRows, search]);

  const selectedRows = useMemo(() => {
    return computedRows.filter((row) => selectedMappingIds.includes(row.mappingId));
  }, [computedRows, selectedMappingIds]);

  const saveDefaults = async () => {
    if (!canEdit) return;
    const supabase = createClient();
    const { error: saveError } = await supabase.from("inventory_defaults").upsert(
      {
        account_id: accountId,
        lead_time_days: defaults.leadTimeDays,
        amazon_cover_days: defaults.amazonCoverDays,
        warehouse_cover_days: defaults.warehouseCoverDays,
        storage_cost_per_pallet: defaults.storageCostPerPallet,
        storage_cost_period: defaults.storageCostPeriod,
      },
      { onConflict: "account_id" }
    );
    if (saveError) {
      setError(saveError.message);
      return;
    }
    setMessage("Inventory defaults saved.");
  };

  const saveMonthlySales = async () => {
    if (!canEdit) return;
    const monthStart = monthStartIso(salesMonthInput);
    const supabase = createClient();
    const payload = Object.entries(salesDraft).map(([mappingId, values]) => ({
      account_id: accountId,
      sku_mapping_id: mappingId,
      month_start: monthStart,
      amazon_units: Number(values.amazonUnits || 0),
      temu_units: Number(values.temuUnits || 0),
    }));
    if (payload.length === 0) {
      setError("Enter at least one SKU row before saving monthly sales.");
      return;
    }
    const { error: saveError } = await supabase.from("sku_monthly_sales").upsert(payload, {
      onConflict: "account_id,sku_mapping_id,month_start",
    });
    if (saveError) {
      setError(saveError.message);
      return;
    }
    setMessage("Monthly sales saved.");
    setSalesDraft({});
    await loadAll();
  };

  const uploadMonthlySalesFile = async (file: File | null) => {
    if (!canEdit || !file) return;
    setError(null);
    setMessage(null);
    const supabase = createClient();
    const lowered = file.name.toLowerCase();
    let rows: Record<string, unknown>[] = [];

    if (lowered.endsWith(".csv")) {
      rows = await new Promise<Record<string, unknown>[]>((resolve, reject) => {
        Papa.parse<Record<string, unknown>>(file, {
          header: true,
          skipEmptyLines: true,
          complete: (result) => resolve(result.data),
          error: reject,
        });
      });
    } else {
      const buffer = await file.arrayBuffer();
      const workbook = XLSX.read(buffer, { type: "array" });
      const firstSheet = workbook.SheetNames[0];
      rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(workbook.Sheets[firstSheet], { defval: "" });
    }

    if (rows.length === 0) {
      setError("Uploaded monthly sales file is empty.");
      return;
    }

    const mappingByAmazon = new Map(
      mappings
        .filter((m) => m.amazonSku)
        .map((m) => [String(m.amazonSku).trim().toUpperCase(), m.mappingId])
    );
    const mappingByTemu = new Map(
      mappings
        .filter((m) => m.temuSkuId)
        .map((m) => [String(m.temuSkuId).trim().toUpperCase(), m.mappingId])
    );

    const payload: Array<{
      account_id: string;
      sku_mapping_id: string;
      month_start: string;
      amazon_units: number;
      temu_units: number;
    }> = [];

    for (const row of rows) {
      const amazonSku = String(row.amazon_sku ?? row["amazon sku"] ?? "").trim().toUpperCase();
      const temuSkuId = String(row.temu_sku_id ?? row["temu sku id"] ?? "").trim().toUpperCase();
      const monthRaw = String(row.month_start ?? row.month ?? "").trim();
      const monthStart = monthRaw ? monthStartIso(monthRaw) : monthStartIso(salesMonthInput);
      const amazonUnits = Number(row.amazon_units ?? row["amazon units"] ?? 0) || 0;
      const temuUnits = Number(row.temu_units ?? row["temu units"] ?? 0) || 0;
      if (amazonUnits < 0 || temuUnits < 0) continue;

      const mappingId = (amazonSku ? mappingByAmazon.get(amazonSku) : null) || (temuSkuId ? mappingByTemu.get(temuSkuId) : null);
      if (!mappingId) continue;
      payload.push({
        account_id: accountId,
        sku_mapping_id: mappingId,
        month_start: monthStart,
        amazon_units: amazonUnits,
        temu_units: temuUnits,
      });
    }

    if (payload.length === 0) {
      setError("No valid monthly sales rows found. Expected columns: amazon_sku and/or temu_sku_id, amazon_units, temu_units.");
      return;
    }

    const { error: uploadError } = await supabase.from("sku_monthly_sales").upsert(payload, {
      onConflict: "account_id,sku_mapping_id,month_start",
    });
    if (uploadError) {
      setError(uploadError.message);
      return;
    }
    setMessage(`Monthly sales uploaded: ${payload.length} rows.`);
    await loadAll();
  };

  const saveStockSnapshot = async () => {
    if (!canEdit) return;
    const supabase = createClient();
    const payload = Object.entries(stockDraft).map(([mappingId, values]) => ({
      account_id: accountId,
      sku_mapping_id: mappingId,
      level_date: stockDate,
      amazon_units: Number(values.amazonUnits || 0),
      warehouse_units: Number(values.warehouseUnits || 0),
    }));
    if (payload.length === 0) {
      setError("Enter at least one stock row before saving snapshot.");
      return;
    }
    const { error: saveError } = await supabase.from("inventory_levels").upsert(payload, {
      onConflict: "account_id,sku_mapping_id,level_date",
    });
    if (saveError) {
      setError(saveError.message);
      return;
    }
    setMessage("Stock snapshot saved.");
    setStockDraft({});
    await loadAll();
  };

  const addPackProfile = async () => {
    if (!canEdit) return;
    if (!newProfile.profileName.trim() || !newProfile.unitsPerBox || !newProfile.boxLength || !newProfile.boxWidth || !newProfile.boxHeight) {
      setError("Profile name, units/box and dimensions are required.");
      return;
    }
    const supabase = createClient();
    const { error: saveError } = await supabase.from("pack_profiles").insert({
      account_id: accountId,
      profile_name: newProfile.profileName.trim(),
      units_per_box: Number(newProfile.unitsPerBox),
      box_length: Number(newProfile.boxLength),
      box_width: Number(newProfile.boxWidth),
      box_height: Number(newProfile.boxHeight),
      dimension_unit: newProfile.dimensionUnit,
      box_weight: newProfile.boxWeight ? Number(newProfile.boxWeight) : null,
      weight_unit: newProfile.weightUnit,
    });
    if (saveError) {
      setError(saveError.message);
      return;
    }
    setMessage("Pack profile saved.");
    setNewProfile({
      profileName: "",
      unitsPerBox: "",
      boxLength: "",
      boxWidth: "",
      boxHeight: "",
      dimensionUnit: "cm",
      boxWeight: "",
      weightUnit: "kg",
    });
    await loadAll();
  };

  const recordStockIntake = async () => {
    if (!canEdit) return;
    if (!intake.mappingId) {
      setError("Select SKU before recording stock.");
      return;
    }
    const profile = packProfiles.find((p) => p.id === intake.profileId);
    const unitsFromBoxes = profile && intake.boxes ? Number(intake.boxes) * profile.unitsPerBox : 0;
    const units = Math.max(0, Number(intake.units || 0), unitsFromBoxes);
    if (!units) {
      setError("Enter units or boxes.");
      return;
    }
    const supabase = createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();

    let movementType: "inbound" | "outbound" | "adjustment" | "amazon_transfer" = "inbound";
    let amazonDelta = 0;
    let warehouseDelta = 0;
    if (intake.actionType === "supplier_inbound") {
      movementType = "inbound";
      if (intake.destination === "amazon") amazonDelta = units;
      else warehouseDelta = units;
    } else if (intake.actionType === "seller_returns") {
      movementType = "adjustment";
      warehouseDelta = units;
    } else if (intake.actionType === "b2b_wholesale") {
      movementType = "outbound";
      warehouseDelta = -units;
    } else {
      movementType = "amazon_transfer";
      warehouseDelta = -units;
      amazonDelta = units;
    }

    const latest = levels
      .filter((row) => row.mappingId === intake.mappingId)
      .sort((a, b) => (a.levelDate < b.levelDate ? 1 : -1))[0];
    const nextAmazonUnits = Number(latest?.amazonUnits || 0) + amazonDelta;
    const nextWarehouseUnits = Number(latest?.warehouseUnits || 0) + warehouseDelta;
    if (nextAmazonUnits < 0 || nextWarehouseUnits < 0) {
      setError("Stock action would result in negative inventory. Check quantities.");
      return;
    }

    const notePrefix =
      intake.actionType === "supplier_inbound"
        ? intake.destination === "amazon"
          ? "Supplier inbound to Amazon"
          : "Supplier inbound to warehouse"
        : intake.actionType === "seller_returns"
          ? "Seller returns to warehouse"
          : intake.actionType === "b2b_wholesale"
            ? "B2B/wholesale deduction"
            : "Warehouse to Amazon transfer";

    const { error: movementError } = await supabase.from("inventory_movements").insert({
      account_id: accountId,
      sku_mapping_id: intake.mappingId,
      movement_date: intake.movementDate,
      movement_type: movementType,
      units_delta: warehouseDelta !== 0 ? warehouseDelta : amazonDelta,
      boxes: intake.boxes ? Number(intake.boxes) : null,
      pack_profile_id: intake.profileId || null,
      notes: `${notePrefix}${intake.notes.trim() ? ` - ${intake.notes.trim()}` : ""}`,
      created_by: user?.id || null,
    });
    if (movementError) {
      setError(movementError.message);
      return;
    }

    const { error: levelError } = await supabase.from("inventory_levels").upsert(
      {
        account_id: accountId,
        sku_mapping_id: intake.mappingId,
        level_date: intake.movementDate,
        amazon_units: nextAmazonUnits,
        warehouse_units: nextWarehouseUnits,
      },
      { onConflict: "account_id,sku_mapping_id,level_date" }
    );
    if (levelError) {
      setError(levelError.message);
      return;
    }
    setMessage("Stock intake recorded.");
    setIntake({
      mappingId: "",
      actionType: "supplier_inbound",
      destination: "warehouse",
      units: "",
      boxes: "",
      profileId: "",
      movementDate: todayIsoUtc(),
      notes: "",
    });
    await loadAll();
  };

  const intakeEstimate = useMemo(() => {
    const profile = packProfiles.find((p) => p.id === intake.profileId);
    if (!profile) return null;
    const units = Math.max(0, Number(intake.units || 0));
    return palletEstimate(profile, units);
  }, [packProfiles, intake.profileId, intake.units]);

  const selectedTotalPallets = useMemo(() => {
    return selectedRows.reduce((acc, row) => {
      const profile = packProfiles.find((p) => p.id === profileByMapping[row.mappingId]);
      if (!profile) return acc;
      const override = overrides[row.mappingId];
      const suggested = planType === "amazon_requirement" ? row.suggestedAmazonUnits : row.suggestedWarehouseUnits;
      const plannedUnits = Math.max(0, Number(override?.plannedUnits ?? suggested));
      const plannedBoxes = Math.max(
        0,
        Number(override?.plannedBoxes ?? Math.ceil(plannedUnits / Math.max(1, profile.unitsPerBox)))
      );
      const estimate = palletEstimate(profile, plannedBoxes * Math.max(1, profile.unitsPerBox));
      return acc + estimate.pallets;
    }, 0);
  }, [selectedRows, packProfiles, profileByMapping, overrides, planType]);

  const saveShipmentPlan = async () => {
    if (!canEdit) return;
    if (selectedRows.length === 0) {
      setError("Select at least one SKU to create shipment plan.");
      return;
    }
    const supabase = createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();

    const orientation = selectedRows.length > 8 ? "landscape" : "portrait";
    const { data: plan, error: planError } = await supabase
      .from("shipment_plans")
      .insert({
        account_id: accountId,
        plan_type: planType,
        title: planTitle.trim() || "Shipment plan",
        notes: planNotes.trim() || null,
        orientation,
        created_by: user?.id || null,
      })
      .select("id")
      .single();
    if (planError || !plan?.id) {
      setError(planError?.message || "Failed to create shipment plan.");
      return;
    }

    const items = selectedRows.map((row) => {
      const profile = packProfiles.find((p) => p.id === profileByMapping[row.mappingId]);
      const suggested = planType === "amazon_requirement" ? row.suggestedAmazonUnits : row.suggestedWarehouseUnits;
      const plannedUnits = Math.max(0, Number(overrides[row.mappingId]?.plannedUnits ?? suggested));
      const estimate = profile ? palletEstimate(profile, plannedUnits) : { plannedBoxes: 0, pallets: 0, unitsPerBox: 1 };
      const plannedBoxes = Math.max(0, Number(overrides[row.mappingId]?.plannedBoxes ?? estimate.plannedBoxes));
      const pallets = profile
        ? palletEstimate(profile, profile.unitsPerBox > 0 ? plannedBoxes * profile.unitsPerBox : plannedUnits).pallets
        : estimate.pallets;
      const leadTimeDays = mappings.find((m) => m.mappingId === row.mappingId)?.leadTimeDays ?? defaults.leadTimeDays;
      return {
        shipment_plan_id: plan.id,
        sku_mapping_id: row.mappingId,
        suggested_units: suggested,
        planned_units: plannedUnits,
        units_per_box: estimate.unitsPerBox,
        planned_boxes: plannedBoxes,
        pallets,
        amazon_units_snapshot: row.amazonUnitsOnHand,
        warehouse_units_snapshot: row.warehouseUnitsOnHand,
        lead_time_days: leadTimeDays,
      };
    });
    const { error: itemsError } = await supabase.from("shipment_plan_items").insert(items);
    if (itemsError) {
      setError(itemsError.message);
      return;
    }
    setSavedPlanId(String(plan.id));
    setMessage("Shipment plan saved.");
  };

  const downloadPlanPdf = async (planId: string) => {
    const response = await fetch(`/api/inventory/shipment-plan/${encodeURIComponent(planId)}/pdf`);
    if (!response.ok) {
      setError(`Shipment PDF failed (${response.status})`);
      return;
    }
    const blob = await response.blob();
    const objectUrl = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = objectUrl;
    a.download = `inventory-shipment-plan-${planId}.pdf`;
    a.click();
    URL.revokeObjectURL(objectUrl);
    setMessage("Shipment plan PDF downloaded.");
  };

  if (loading) return <p className="text-sm text-slate-500">Loading inventory workspace...</p>;

  return (
    <div className="space-y-4">
      {message ? <p className="rounded-xl bg-green-50 px-3 py-2 text-sm text-green-700">{message}</p> : null}
      {error ? <p className="rounded-xl bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p> : null}

      <section className="grid gap-3 rounded-2xl border border-slate-200 bg-white p-4 md:grid-cols-5">
        <label className="text-xs text-slate-600">
          <span className="mb-1 block uppercase tracking-wide text-slate-500">Lead Time Default (days)</span>
          <input
            type="number"
            value={defaults.leadTimeDays}
            onChange={(e) => setDefaults((prev) => ({ ...prev, leadTimeDays: Number(e.target.value || 0) }))}
            disabled={!canEdit}
            className="w-full rounded-lg border border-slate-300 px-2 py-2 text-sm disabled:bg-slate-100"
          />
        </label>
        <label className="text-xs text-slate-600">
          <span className="mb-1 block uppercase tracking-wide text-slate-500">Amazon Cover (days)</span>
          <input
            type="number"
            value={defaults.amazonCoverDays}
            onChange={(e) => setDefaults((prev) => ({ ...prev, amazonCoverDays: Number(e.target.value || 0) }))}
            disabled={!canEdit}
            className="w-full rounded-lg border border-slate-300 px-2 py-2 text-sm disabled:bg-slate-100"
          />
        </label>
        <label className="text-xs text-slate-600">
          <span className="mb-1 block uppercase tracking-wide text-slate-500">Warehouse Cover (days)</span>
          <input
            type="number"
            value={defaults.warehouseCoverDays}
            onChange={(e) => setDefaults((prev) => ({ ...prev, warehouseCoverDays: Number(e.target.value || 0) }))}
            disabled={!canEdit}
            className="w-full rounded-lg border border-slate-300 px-2 py-2 text-sm disabled:bg-slate-100"
          />
        </label>
        <label className="text-xs text-slate-600">
          <span className="mb-1 block uppercase tracking-wide text-slate-500">Storage Cost / Pallet</span>
          <input
            type="number"
            step="0.01"
            value={defaults.storageCostPerPallet}
            onChange={(e) => setDefaults((prev) => ({ ...prev, storageCostPerPallet: Number(e.target.value || 0) }))}
            disabled={!canEdit}
            className="w-full rounded-lg border border-slate-300 px-2 py-2 text-sm disabled:bg-slate-100"
          />
        </label>
        <div className="flex items-end gap-2">
          <select
            value={defaults.storageCostPeriod}
            onChange={(e) =>
              setDefaults((prev) => ({ ...prev, storageCostPeriod: (e.target.value as "week" | "month") || "month" }))
            }
            disabled={!canEdit}
            className="rounded-lg border border-slate-300 px-3 py-2 text-sm disabled:bg-slate-100"
          >
            <option value="week">Per week</option>
            <option value="month">Per month</option>
          </select>
          {canEdit ? (
            <button onClick={() => void saveDefaults()} className="rounded-lg bg-[var(--md-primary)] px-3 py-2 text-sm font-semibold text-white">
              Save defaults
            </button>
          ) : null}
        </div>
      </section>

      <section className="rounded-2xl border border-slate-200 bg-white p-2">
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => setActiveTab("overview")}
            className={`rounded-xl px-3 py-2 text-sm font-semibold ${activeTab === "overview" ? "bg-[var(--md-primary)] text-white" : "bg-slate-100 text-slate-700"}`}
          >
            Overview & Velocity
          </button>
          <button
            type="button"
            onClick={() => setActiveTab("stock-intake")}
            className={`rounded-xl px-3 py-2 text-sm font-semibold ${activeTab === "stock-intake" ? "bg-[var(--md-primary)] text-white" : "bg-slate-100 text-slate-700"}`}
          >
            Stock Intake & Pallet Calculator
          </button>
          <button
            type="button"
            onClick={() => setActiveTab("shipment-planning")}
            className={`rounded-xl px-3 py-2 text-sm font-semibold ${activeTab === "shipment-planning" ? "bg-[var(--md-primary)] text-white" : "bg-slate-100 text-slate-700"}`}
          >
            Shipment Planning
          </button>
        </div>
      </section>

      {activeTab === "overview" ? (
        <section className="space-y-3 rounded-2xl border border-slate-200 bg-white p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-sm font-semibold text-slate-800">Overview & Velocity</h3>
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search SKU or product"
              className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm sm:w-72"
            />
          </div>
          {canEdit ? (
            <div className="flex flex-wrap items-end gap-2 rounded-xl border border-slate-200 bg-slate-50 p-3">
              <label className="text-xs text-slate-600">
                <span className="mb-1 block uppercase tracking-wide text-slate-500">Stock Date</span>
                <input type="date" value={stockDate} onChange={(e) => setStockDate(e.target.value)} className="rounded-lg border border-slate-300 px-2 py-2 text-sm" />
              </label>
              <button onClick={() => void saveStockSnapshot()} className="rounded-lg bg-[var(--md-primary)] px-3 py-2 text-sm font-semibold text-white">
                Save Stock Updates
              </button>
              <p className="text-xs text-slate-500">3PL stock auto-updates based on intake, transfers, and deductions.</p>
            </div>
          ) : null}
          <div className="overflow-x-auto rounded-xl border border-slate-200">
          <table className="min-w-full text-xs">
            <thead className="bg-slate-50 text-left uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-2 py-2">Select</th>
                <th className="px-2 py-2">Product</th>
                <th className="px-2 py-2">Amazon SKU</th>
                <th className="px-2 py-2">Temu SKU ID</th>
                <th className="px-2 py-2">Prev Mo Amazon</th>
                <th className="px-2 py-2">Prev Mo Temu</th>
                <th className="px-2 py-2">Prev Mo Combined</th>
                <th className="px-2 py-2">YTD Units</th>
                <th className="px-2 py-2">Avg/Mo</th>
                <th className="px-2 py-2">Amazon Stock</th>
                <th className="px-2 py-2">3PL Stock</th>
                <th className="px-2 py-2">Amazon Days Left</th>
                <th className="px-2 py-2">3PL Days Left</th>
                <th className="px-2 py-2">Stock Value</th>
                <th className="px-2 py-2">Potential Sales</th>
                <th className="px-2 py-2">Potential Profit</th>
              </tr>
            </thead>
            <tbody>
              {visibleRows.length === 0 ? (
                <tr>
                  <td className="px-2 py-3 text-slate-500" colSpan={16}>
                    No SKU mappings found yet. Create mappings in COGS first.
                  </td>
                </tr>
              ) : (
                visibleRows.map((row) => (
                  <tr key={row.mappingId} className="border-t border-slate-100">
                    <td className="px-2 py-2">
                      <input
                        type="checkbox"
                        checked={selectedMappingIds.includes(row.mappingId)}
                        onChange={(e) =>
                          setSelectedMappingIds((prev) =>
                            e.target.checked ? [...new Set([...prev, row.mappingId])] : prev.filter((id) => id !== row.mappingId)
                          )
                        }
                      />
                    </td>
                    <td className="px-2 py-2 font-medium">{row.productName}</td>
                    <td className="px-2 py-2">{row.amazonSku || "-"}</td>
                    <td className="px-2 py-2">{row.temuSkuId || "-"}</td>
                    <td className="px-2 py-2">{row.prevMonthAmazonUnits}</td>
                    <td className="px-2 py-2">{row.prevMonthTemuUnits}</td>
                    <td className="px-2 py-2">{row.prevMonthAmazonUnits + row.prevMonthTemuUnits}</td>
                    <td className="px-2 py-2">{row.yearTotalUnits}</td>
                    <td className="px-2 py-2">{row.yearAvgPerMonth}</td>
                    <td className="px-2 py-2">
                      {canEdit ? (
                        <input
                          type="number"
                          value={stockDraft[row.mappingId]?.amazonUnits ?? row.amazonUnitsOnHand}
                          onChange={(e) =>
                            setStockDraft((prev) => ({
                              ...prev,
                              [row.mappingId]: {
                                amazonUnits: Number(e.target.value || 0),
                                warehouseUnits: prev[row.mappingId]?.warehouseUnits ?? row.warehouseUnitsOnHand,
                              },
                            }))
                          }
                          className="w-20 rounded-lg border border-slate-300 px-2 py-1"
                        />
                      ) : (
                        row.amazonUnitsOnHand
                      )}
                    </td>
                    <td className="px-2 py-2">
                      {canEdit ? (
                        <input
                          type="number"
                          value={stockDraft[row.mappingId]?.warehouseUnits ?? row.warehouseUnitsOnHand}
                          onChange={(e) =>
                            setStockDraft((prev) => ({
                              ...prev,
                              [row.mappingId]: {
                                amazonUnits: prev[row.mappingId]?.amazonUnits ?? row.amazonUnitsOnHand,
                                warehouseUnits: Number(e.target.value || 0),
                              },
                            }))
                          }
                          className="w-20 rounded-lg border border-slate-300 px-2 py-1"
                        />
                      ) : (
                        row.warehouseUnitsOnHand
                      )}
                    </td>
                    <td className="px-2 py-2">{row.amazonDaysLeft == null ? "-" : row.amazonDaysLeft}</td>
                    <td className="px-2 py-2">{row.warehouseDaysLeft == null ? "-" : row.warehouseDaysLeft}</td>
                    <td className="px-2 py-2">
                      {currency}
                      {row.stockValue.toFixed(2)}
                    </td>
                    <td className="px-2 py-2">{row.potentialSalesUnits.toFixed(0)}</td>
                    <td className="px-2 py-2">{row.potentialProfitUnits.toFixed(0)}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
          {canEdit ? (
            <section className="space-y-2 rounded-2xl border border-slate-200 bg-slate-50 p-4">
              <h4 className="text-sm font-semibold text-slate-800">Monthly Units Sold (Start-Now)</h4>
              <div className="flex flex-wrap items-end gap-2">
                <label className="text-xs text-slate-600">
                  <span className="mb-1 block uppercase tracking-wide text-slate-500">Month</span>
                  <input
                    type="month"
                    value={salesMonthInput}
                    onChange={(e) => setSalesMonthInput(e.target.value)}
                    className="rounded-lg border border-slate-300 px-2 py-2 text-sm"
                  />
                </label>
                <button onClick={() => void saveMonthlySales()} className="rounded-lg bg-[var(--md-primary)] px-3 py-2 text-sm font-semibold text-white">
                  Save Month
                </button>
                <div className="min-w-[220px]">
                  <FileDropzone
                    accept=".csv,.xlsx,.xls"
                    onFileSelect={(file) => void uploadMonthlySalesFile(file)}
                    label="Upload monthly sales"
                    hint="CSV/XLS/XLSX"
                  />
                </div>
              </div>
              <div className="grid gap-2 md:grid-cols-2">
                {mappings.map((mapping) => {
                  const value = salesDraft[mapping.mappingId] || { amazonUnits: 0, temuUnits: 0 };
                  return (
                    <div key={mapping.mappingId} className="grid gap-2 rounded-xl border border-slate-200 bg-white p-2 md:grid-cols-[1fr_130px_130px]">
                      <p className="text-xs font-semibold text-slate-700">{mapping.productName}</p>
                      <input
                        type="number"
                        value={value.amazonUnits}
                        onChange={(e) =>
                          setSalesDraft((prev) => ({
                            ...prev,
                            [mapping.mappingId]: { ...value, amazonUnits: Number(e.target.value || 0) },
                          }))
                        }
                        className="rounded-lg border border-slate-300 px-2 py-1 text-xs"
                        placeholder="Amazon units"
                      />
                      <input
                        type="number"
                        value={value.temuUnits}
                        onChange={(e) =>
                          setSalesDraft((prev) => ({
                            ...prev,
                            [mapping.mappingId]: { ...value, temuUnits: Number(e.target.value || 0) },
                          }))
                        }
                        className="rounded-lg border border-slate-300 px-2 py-1 text-xs"
                        placeholder="Temu units"
                      />
                    </div>
                  );
                })}
              </div>
            </section>
          ) : null}
        </section>
      ) : null}

      {activeTab === "stock-intake" && canEdit ? (
        <>
          <section className="space-y-2 rounded-2xl border border-slate-200 bg-white p-4">
            <h3 className="text-sm font-semibold text-slate-800">Pack Profiles + Stock Intake</h3>
            <div className="grid gap-2 md:grid-cols-8">
              <input value={newProfile.profileName} onChange={(e) => setNewProfile((p) => ({ ...p, profileName: e.target.value }))} placeholder="Profile name" className="rounded-lg border border-slate-300 px-2 py-2 text-sm md:col-span-2" />
              <input value={newProfile.unitsPerBox} onChange={(e) => setNewProfile((p) => ({ ...p, unitsPerBox: e.target.value }))} type="number" placeholder="Units/box" className="rounded-lg border border-slate-300 px-2 py-2 text-sm" />
              <input value={newProfile.boxLength} onChange={(e) => setNewProfile((p) => ({ ...p, boxLength: e.target.value }))} type="number" placeholder="Length" className="rounded-lg border border-slate-300 px-2 py-2 text-sm" />
              <input value={newProfile.boxWidth} onChange={(e) => setNewProfile((p) => ({ ...p, boxWidth: e.target.value }))} type="number" placeholder="Width" className="rounded-lg border border-slate-300 px-2 py-2 text-sm" />
              <input value={newProfile.boxHeight} onChange={(e) => setNewProfile((p) => ({ ...p, boxHeight: e.target.value }))} type="number" placeholder="Height" className="rounded-lg border border-slate-300 px-2 py-2 text-sm" />
              <select value={newProfile.dimensionUnit} onChange={(e) => setNewProfile((p) => ({ ...p, dimensionUnit: e.target.value as "mm" | "cm" | "in" }))} className="rounded-lg border border-slate-300 px-2 py-2 text-sm">
                <option value="mm">mm</option>
                <option value="cm">cm</option>
                <option value="in">in</option>
              </select>
              <button onClick={() => void addPackProfile()} className="rounded-lg bg-[var(--md-primary)] px-3 py-2 text-sm font-semibold text-white">
                Save profile
              </button>
            </div>

            <div className="grid gap-2 rounded-xl border border-slate-200 bg-slate-50 p-3 md:grid-cols-[1fr_160px_120px_120px_1fr_140px_auto]">
              <select value={intake.mappingId} onChange={(e) => setIntake((prev) => ({ ...prev, mappingId: e.target.value }))} className="rounded-lg border border-slate-300 px-2 py-2 text-sm">
                <option value="">Select SKU</option>
                {mappings.map((m) => (
                  <option key={m.mappingId} value={m.mappingId}>
                    {m.productName}
                  </option>
                ))}
              </select>
              <select
                value={intake.actionType}
                onChange={(e) => setIntake((prev) => ({ ...prev, actionType: e.target.value as IntakeAction }))}
                className="rounded-lg border border-slate-300 px-2 py-2 text-sm"
              >
                <option value="supplier_inbound">Supplier inbound</option>
                <option value="seller_returns">Seller returns</option>
                <option value="b2b_wholesale">B2B/Wholesale deduction</option>
                <option value="amazon_transfer">Transfer warehouse to Amazon</option>
              </select>
              {intake.actionType === "supplier_inbound" ? (
                <select value={intake.destination} onChange={(e) => setIntake((prev) => ({ ...prev, destination: e.target.value as "warehouse" | "amazon" }))} className="rounded-lg border border-slate-300 px-2 py-2 text-sm">
                  <option value="warehouse">To warehouse</option>
                  <option value="amazon">To Amazon</option>
                </select>
              ) : (
                <div className="rounded-lg border border-slate-200 bg-white px-2 py-2 text-xs text-slate-500">
                  {intake.actionType === "seller_returns"
                    ? "Destination: 3PL warehouse"
                    : intake.actionType === "b2b_wholesale"
                      ? "Source: 3PL warehouse"
                      : "From 3PL to Amazon"}
                </div>
              )}
              <input type="number" value={intake.units} onChange={(e) => setIntake((prev) => ({ ...prev, units: e.target.value }))} placeholder="Units" className="rounded-lg border border-slate-300 px-2 py-2 text-sm" />
              <input type="number" value={intake.boxes} onChange={(e) => setIntake((prev) => ({ ...prev, boxes: e.target.value }))} placeholder="Boxes" className="rounded-lg border border-slate-300 px-2 py-2 text-sm" />
              <select value={intake.profileId} onChange={(e) => setIntake((prev) => ({ ...prev, profileId: e.target.value }))} className="rounded-lg border border-slate-300 px-2 py-2 text-sm">
                <option value="">Select box profile</option>
                {packProfiles.map((profile) => (
                  <option key={profile.id} value={profile.id}>
                    {profile.profileName}
                  </option>
                ))}
              </select>
              <input type="date" value={intake.movementDate} onChange={(e) => setIntake((prev) => ({ ...prev, movementDate: e.target.value }))} className="rounded-lg border border-slate-300 px-2 py-2 text-sm" />
              <button onClick={() => void recordStockIntake()} className="rounded-lg bg-slate-900 px-3 py-2 text-sm font-semibold text-white">
                Apply action
              </button>
            </div>
            {intakeEstimate ? (
              <p className="text-xs text-slate-600">
                Pallet estimate: <span className="font-semibold">{intakeEstimate.plannedBoxes}</span> boxes,{" "}
                <span className="font-semibold">{intakeEstimate.boxesPerPallet}</span> boxes/pallet,{" "}
                <span className="font-semibold">{intakeEstimate.pallets.toFixed(2)}</span> pallets.
              </p>
            ) : (
              <p className="text-xs text-slate-500">Select a box profile to view pallet estimate on a 1000x1200mm pallet (max total height 1800mm).</p>
            )}
          </section>
        </>
      ) : null}

      {activeTab === "shipment-planning" ? (
      <section className="space-y-2 rounded-2xl border border-slate-200 bg-white p-4">
        <h3 className="text-sm font-semibold text-slate-800">Shipment Planning (Multi-SKU)</h3>
        <div className="grid gap-2 md:grid-cols-[1fr_1fr_1fr_auto]">
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setPlanType("amazon_requirement")}
              className={`rounded-lg px-3 py-2 text-sm font-semibold ${planType === "amazon_requirement" ? "bg-[var(--md-primary)] text-white" : "bg-slate-100 text-slate-700"}`}
            >
              Send to Amazon
            </button>
            <button
              type="button"
              onClick={() => setPlanType("warehouse_requirement")}
              className={`rounded-lg px-3 py-2 text-sm font-semibold ${planType === "warehouse_requirement" ? "bg-[var(--md-primary)] text-white" : "bg-slate-100 text-slate-700"}`}
            >
              Order from Supplier
            </button>
          </div>
          <input value={planTitle} onChange={(e) => setPlanTitle(e.target.value)} placeholder="Plan title" className="rounded-lg border border-slate-300 px-2 py-2 text-sm" />
          <input value={planNotes} onChange={(e) => setPlanNotes(e.target.value)} placeholder="Notes" className="rounded-lg border border-slate-300 px-2 py-2 text-sm" />
          {canEdit ? (
            <button onClick={() => void saveShipmentPlan()} className="rounded-lg bg-[var(--md-primary)] px-3 py-2 text-sm font-semibold text-white">
              Save plan
            </button>
          ) : null}
        </div>

        <div className="overflow-x-auto rounded-xl border border-slate-200">
          <table className="min-w-full text-xs">
            <thead className="bg-slate-50 text-left uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-2 py-2">Product</th>
                <th className="px-2 py-2">Suggested Units</th>
                <th className="px-2 py-2">Planned Units</th>
                <th className="px-2 py-2">Box Profile</th>
                <th className="px-2 py-2">Planned Boxes</th>
                <th className="px-2 py-2">Pallets</th>
                <th className="px-2 py-2">Lead Time</th>
              </tr>
            </thead>
            <tbody>
              {selectedRows.length === 0 ? (
                <tr>
                  <td className="px-2 py-3 text-slate-500" colSpan={7}>
                    Select SKUs from Inventory Overview above to build shipment plan.
                  </td>
                </tr>
              ) : (
                selectedRows.map((row) => {
                  const profile = packProfiles.find((p) => p.id === profileByMapping[row.mappingId]);
                  const suggested = planType === "amazon_requirement" ? row.suggestedAmazonUnits : row.suggestedWarehouseUnits;
                  const plannedUnits = Number(overrides[row.mappingId]?.plannedUnits ?? suggested);
                  const estimate = profile ? palletEstimate(profile, plannedUnits) : { plannedBoxes: 0, pallets: 0, unitsPerBox: 1 };
                  const overrideBoxes = Number(overrides[row.mappingId]?.plannedBoxes ?? estimate.plannedBoxes);
                  return (
                    <tr key={row.mappingId} className="border-t border-slate-100">
                      <td className="px-2 py-2">{row.productName}</td>
                      <td className="px-2 py-2">{suggested}</td>
                      <td className="px-2 py-2">
                        {canEdit ? (
                          <input
                            type="number"
                            value={plannedUnits}
                            onChange={(e) =>
                              setOverrides((prev) => ({
                                ...prev,
                                [row.mappingId]: {
                                  plannedUnits: Number(e.target.value || 0),
                                  plannedBoxes:
                                    profile && profile.unitsPerBox > 0
                                      ? Math.ceil(Number(e.target.value || 0) / profile.unitsPerBox)
                                      : 0,
                                },
                              }))
                            }
                            className="w-24 rounded-lg border border-slate-300 px-2 py-1"
                          />
                        ) : (
                          plannedUnits
                        )}
                      </td>
                      <td className="px-2 py-2">
                        {canEdit ? (
                          <select
                            value={profileByMapping[row.mappingId] || ""}
                            onChange={(e) => {
                              const nextProfileId = e.target.value;
                              setProfileByMapping((prev) => ({ ...prev, [row.mappingId]: nextProfileId }));
                              const selectedProfile = packProfiles.find((p) => p.id === nextProfileId);
                              if (selectedProfile) {
                                setOverrides((prev) => ({
                                  ...prev,
                                  [row.mappingId]: {
                                    plannedUnits: Number(prev[row.mappingId]?.plannedUnits ?? suggested),
                                    plannedBoxes: Math.ceil(
                                      Number(prev[row.mappingId]?.plannedUnits ?? suggested) / selectedProfile.unitsPerBox
                                    ),
                                  },
                                }));
                              }
                            }}
                            className="rounded-lg border border-slate-300 px-2 py-1"
                          >
                            <option value="">Select profile</option>
                            {packProfiles.map((p) => (
                              <option key={p.id} value={p.id}>
                                {p.profileName}
                              </option>
                            ))}
                          </select>
                        ) : (
                          profile?.profileName || "-"
                        )}
                      </td>
                      <td className="px-2 py-2">
                        {canEdit ? (
                          <input
                            type="number"
                            value={overrideBoxes}
                            onChange={(e) =>
                              setOverrides((prev) => ({
                                ...prev,
                                [row.mappingId]: {
                                  plannedBoxes: Number(e.target.value || 0),
                                  plannedUnits: profile ? Number(e.target.value || 0) * profile.unitsPerBox : Number(e.target.value || 0),
                                },
                              }))
                            }
                            className="w-24 rounded-lg border border-slate-300 px-2 py-1"
                          />
                        ) : (
                          overrideBoxes
                        )}
                      </td>
                      <td className="px-2 py-2">{estimate.pallets.toFixed(2)}</td>
                      <td className="px-2 py-2">{mappings.find((m) => m.mappingId === row.mappingId)?.leadTimeDays ?? defaults.leadTimeDays} days</td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-sm text-slate-700">
            Total pallets: <span className="font-semibold">{selectedTotalPallets.toFixed(2)}</span> | Storage cost estimate ({defaults.storageCostPeriod}):{" "}
            <span className="font-semibold">
              {currency}
              {(selectedTotalPallets * defaults.storageCostPerPallet).toFixed(2)}
            </span>
          </p>
          {savedPlanId ? (
            <button onClick={() => void downloadPlanPdf(savedPlanId)} className="rounded-lg bg-slate-900 px-3 py-2 text-sm font-semibold text-white">
              Download Shipment PDF
            </button>
          ) : null}
        </div>
      </section>
      ) : null}

      {!canEdit ? (
        <p className="rounded-xl bg-slate-100 px-3 py-2 text-sm text-slate-700">
          Client access is read-only for inventory. Admin and Team can create or update inventory records.
        </p>
      ) : null}

      <p className="text-xs text-slate-500">Today: {formatUkDate(todayIsoUtc())}</p>
    </div>
  );
}
