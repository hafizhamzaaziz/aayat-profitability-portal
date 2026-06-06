"use client";

import { useEffect, useState } from "react";
import Papa from "papaparse";
import * as XLSX from "xlsx";
import { createClient } from "@/lib/supabase/client";
import FileDropzone from "@/components/ui/file-dropzone";

type MappingRow = {
  id: string;
  sku_catalog_id: string;
  product_name: string;
  amazon_sku: string | null;
  temu_sku_id: string | null;
  tiktok_seller_sku: string | null;
  /** Temu parent listing identifier (Goods ID). Stored on sku_catalog (one
   *  per product), surfaced here for convenience so the variant row can
   *  display + edit it without a join. */
  temu_goods_id: string | null;
  lead_time_days: number | null;
  created_at: string;
};

type Props = {
  accountId: string;
  canEdit: boolean;
};

function normalizeProductName(input: unknown) {
  return String(input ?? "")
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeSkuToken(input: unknown) {
  const raw = String(input ?? "")
    .replace(/\u00a0/g, " ")
    .trim()
    .toUpperCase();
  if (!raw) return "";
  if (/^\d+\.0+$/.test(raw)) return raw.replace(/\.0+$/, "");
  return raw;
}

function shortenText(text: string, max = 30) {
  if (!text) return "";
  return text.length > max ? `${text.slice(0, max - 3)}...` : text;
}

export default function SkuMappingsPanel({ accountId, canEdit }: Props) {
  const PAGE_SIZE = 20;
  const [rows, setRows] = useState<MappingRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [searchActive, setSearchActive] = useState("");
  const [offset, setOffset] = useState(0);
  const [totalCount, setTotalCount] = useState(0);
  const [bulkFileName, setBulkFileName] = useState("");
  const [bulkRows, setBulkRows] = useState<Record<string, unknown>[]>([]);
  const [bulkHeaders, setBulkHeaders] = useState<string[]>([]);
  const [bulkLoading, setBulkLoading] = useState(false);
  const [productCol, setProductCol] = useState("");
  const [amazonSkuCol, setAmazonSkuCol] = useState("");
  const [temuSkuCol, setTemuSkuCol] = useState("");
  const [temuGoodsIdCol, setTemuGoodsIdCol] = useState("");
  const [tiktokSkuCol, setTiktokSkuCol] = useState("");
  const [leadTimeCol, setLeadTimeCol] = useState("");

  const loadRows = async () => {
    setLoading(true);
    setError(null);
    const supabase = createClient();
    const trimmedSearch = searchActive.trim();

    let dataQuery = supabase
      .from("sku_mappings")
      .select("id, sku_catalog_id, amazon_sku, temu_sku_id, tiktok_seller_sku, lead_time_days, created_at, sku_catalog:sku_catalog_id(product_name, temu_goods_id)")
      .eq("account_id", accountId)
      .order("created_at", { ascending: false });
    let countQuery = supabase.from("sku_mappings").select("id", { count: "exact", head: true }).eq("account_id", accountId);

    if (trimmedSearch) {
      // Resolve product-name matches first → list of sku_catalog_id values.
      const needle = `%${trimmedSearch.replace(/[%,]/g, "")}%`;
      const { data: catalogMatches } = await supabase
        .from("sku_catalog")
        .select("id")
        .eq("account_id", accountId)
        .ilike("product_name", needle);
      const matchingCatalogIds = ((catalogMatches || []) as Array<{ id: string }>).map((row) => row.id);

      const orParts = [
        `amazon_sku.ilike.${needle}`,
        `temu_sku_id.ilike.${needle}`,
        `tiktok_seller_sku.ilike.${needle}`,
      ];
      if (matchingCatalogIds.length > 0) {
        orParts.push(`sku_catalog_id.in.(${matchingCatalogIds.join(",")})`);
      }
      const orFilter = orParts.join(",");
      dataQuery = dataQuery.or(orFilter).range(0, 499);
      countQuery = countQuery.or(orFilter);
    } else {
      dataQuery = dataQuery.range(offset, offset + PAGE_SIZE - 1);
    }

    const [{ data, error: fetchError }, { count }] = await Promise.all([dataQuery, countQuery]);
    if (fetchError) {
      setError(fetchError.message);
      setLoading(false);
      return;
    }
    const mapped = (data || []).map((row) => {
      const rec = row as unknown as {
        id: string;
        sku_catalog_id: string;
        amazon_sku: string | null;
        temu_sku_id: string | null;
        tiktok_seller_sku: string | null;
        lead_time_days: number | null;
        created_at: string;
        sku_catalog?: { product_name?: string; temu_goods_id?: string | null } | null;
      };
      return {
        id: rec.id,
        sku_catalog_id: rec.sku_catalog_id,
        product_name: rec.sku_catalog?.product_name || "Unnamed product",
        amazon_sku: rec.amazon_sku,
        temu_sku_id: rec.temu_sku_id,
        tiktok_seller_sku: rec.tiktok_seller_sku,
        temu_goods_id: rec.sku_catalog?.temu_goods_id ?? null,
        lead_time_days: rec.lead_time_days,
        created_at: rec.created_at,
      } as MappingRow;
    });
    setRows(mapped);
    setTotalCount(Number(count || (trimmedSearch ? mapped.length : 0)));
    setLoading(false);
  };

  useEffect(() => {
    void loadRows();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accountId, offset, searchActive]);

  useEffect(() => {
    const handle = setTimeout(() => {
      setSearchActive(search.trim());
      setOffset(0);
    }, 250);
    return () => clearTimeout(handle);
  }, [search]);

  const filtered = rows;

  const totalPages = Math.max(1, Math.ceil(totalCount / PAGE_SIZE));
  const currentPage = Math.floor(offset / PAGE_SIZE) + 1;

  const norm = (value: unknown) =>
    String(value ?? "")
      .trim()
      .toLowerCase()
      .replace(/\s+/g, " ");

  const pickColumn = (headers: string[], terms: string[]) => {
    return (
      headers.find((header) => {
        const compact = norm(header).replace(/[^a-z0-9]/g, "");
        return terms.some((term) => compact.includes(term));
      }) || ""
    );
  };

  const parseUploadFile = async (file: File): Promise<Record<string, unknown>[]> => {
    const lowered = file.name.toLowerCase();
    if (lowered.endsWith(".csv")) {
      return new Promise((resolve, reject) => {
        Papa.parse<Record<string, unknown>>(file, {
          header: true,
          skipEmptyLines: true,
          complete: (result) => resolve(result.data),
          error: reject,
        });
      });
    }

    const buffer = await file.arrayBuffer();
    const workbook = XLSX.read(buffer, { type: "array" });
    const firstSheet = workbook.SheetNames[0];
    const sheet = workbook.Sheets[firstSheet];
    return XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: "" });
  };

  const onBulkFileChange = async (file: File | null) => {
    if (!file) return;
    setError(null);
    setMessage(null);
    setBulkLoading(true);
    try {
      const parsedRows = await parseUploadFile(file);
      if (!parsedRows.length) throw new Error("Uploaded file is empty.");
      const headers = Object.keys(parsedRows[0] || {});
      setBulkRows(parsedRows);
      setBulkHeaders(headers);
      setBulkFileName(file.name);
      setProductCol(pickColumn(headers, ["productname", "product", "title", "name", "goodsname"]));
      setAmazonSkuCol(pickColumn(headers, ["amazonsku"]));
      setTemuSkuCol(pickColumn(headers, ["temuskuid", "temusku", "skuid"]));
      setTemuGoodsIdCol(pickColumn(headers, ["temugoodsid", "goodsid", "temugoods", "parentgoods"]));
      setTiktokSkuCol(pickColumn(headers, ["tiktoksellersku", "tiktoksku", "sellersku"]));
      setLeadTimeCol(pickColumn(headers, ["leadtimedays", "leadtime", "lead"]));
      setMessage("File loaded. Confirm column mapping and click Import Mappings.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to read mapping file.");
    } finally {
      setBulkLoading(false);
    }
  };

  const runBulkImport = async () => {
    if (!canEdit) return;
    if (!bulkRows.length) {
      setError("Upload a file first.");
      return;
    }
    if (!productCol) {
      setError("Product Name column is required.");
      return;
    }

    setError(null);
    setMessage(null);
    setBulkLoading(true);

    try {
      const supabase = createClient();
      const { data: existingData, error: existingError } = await supabase
        .from("sku_mappings")
        .select("id, sku_catalog_id, amazon_sku, temu_sku_id, tiktok_seller_sku")
        .eq("account_id", accountId);
      if (existingError) throw existingError;

      const byAmazon = new Map<string, { id: string; sku_catalog_id: string }>();
      const byTemu = new Map<string, { id: string; sku_catalog_id: string }>();
      const byTiktok = new Map<string, { id: string; sku_catalog_id: string }>();
      const byCatalog = new Map<
        string,
        { id: string; amazon_sku: string | null; temu_sku_id: string | null; tiktok_seller_sku: string | null }[]
      >();
      (existingData || []).forEach((row) => {
        const rec = row as {
          id?: string;
          sku_catalog_id?: string;
          amazon_sku?: string | null;
          temu_sku_id?: string | null;
          tiktok_seller_sku?: string | null;
        };
        if (!rec.id || !rec.sku_catalog_id) return;
        const payload = { id: rec.id, sku_catalog_id: rec.sku_catalog_id };
        if (rec.amazon_sku) byAmazon.set(rec.amazon_sku.trim().toUpperCase(), payload);
        if (rec.temu_sku_id) byTemu.set(rec.temu_sku_id.trim().toUpperCase(), payload);
        if (rec.tiktok_seller_sku) byTiktok.set(rec.tiktok_seller_sku.trim().toUpperCase(), payload);
        const list = byCatalog.get(rec.sku_catalog_id) || [];
        list.push({
          id: rec.id,
          amazon_sku: rec.amazon_sku || null,
          temu_sku_id: rec.temu_sku_id || null,
          tiktok_seller_sku: rec.tiktok_seller_sku || null,
        });
        byCatalog.set(rec.sku_catalog_id, list);
      });

      let created = 0;
      let updated = 0;
      let skipped = 0;

      for (const row of bulkRows) {
        const productName = normalizeProductName(row[productCol] ?? "");
        const amazonSku = amazonSkuCol ? normalizeSkuToken(row[amazonSkuCol] ?? "") : "";
        const temuSkuId = temuSkuCol ? normalizeSkuToken(row[temuSkuCol] ?? "") : "";
        const temuGoodsId = temuGoodsIdCol ? normalizeSkuToken(row[temuGoodsIdCol] ?? "") : "";
        const tiktokSellerSku = tiktokSkuCol ? normalizeSkuToken(row[tiktokSkuCol] ?? "") : "";
        const leadTimeRaw = leadTimeCol ? String(row[leadTimeCol] ?? "").trim() : "";
        const leadTimeDays = leadTimeRaw ? Number(leadTimeRaw) : null;
        if (!productName || (!amazonSku && !temuSkuId && !tiktokSellerSku)) {
          skipped += 1;
          continue;
        }

        const existing =
          (amazonSku && byAmazon.get(amazonSku)) ||
          (temuSkuId && byTemu.get(temuSkuId)) ||
          (tiktokSellerSku && byTiktok.get(tiktokSellerSku)) ||
          null;

        if (existing) {
          const catalogPatch: Record<string, unknown> = { product_name: productName };
          if (temuGoodsId) catalogPatch.temu_goods_id = temuGoodsId;
          const { error: catalogError } = await supabase
            .from("sku_catalog")
            .update(catalogPatch)
            .eq("id", existing.sku_catalog_id);
          if (catalogError) throw catalogError;

          const { error: mappingError } = await supabase
            .from("sku_mappings")
            .update({
              amazon_sku: amazonSku || null,
              temu_sku_id: temuSkuId || null,
              tiktok_seller_sku: tiktokSellerSku || null,
              lead_time_days: Number.isFinite(leadTimeDays) ? leadTimeDays : null,
            })
            .eq("id", existing.id);
          if (mappingError) throw mappingError;
          updated += 1;
        } else {
          const { data: existingCatalog, error: existingCatalogError } = await supabase
            .from("sku_catalog")
            .select("id")
            .eq("account_id", accountId)
            .eq("product_name", productName)
            .maybeSingle();
          if (existingCatalogError) throw existingCatalogError;
          let catalogId = existingCatalog?.id ? String(existingCatalog.id) : "";
          if (!catalogId) {
            const insertPayload: Record<string, unknown> = {
              account_id: accountId,
              product_name: productName,
            };
            if (temuGoodsId) insertPayload.temu_goods_id = temuGoodsId;
            const { data: catalog, error: catalogError } = await supabase
              .from("sku_catalog")
              .insert(insertPayload)
              .select("id")
              .single();
            if (catalogError || !catalog?.id) throw catalogError || new Error("Failed to create product.");
            catalogId = String(catalog.id);
          } else if (temuGoodsId) {
            await supabase.from("sku_catalog").update({ temu_goods_id: temuGoodsId }).eq("id", catalogId);
          }

          const reusable = (byCatalog.get(catalogId) || []).find(
            (m) =>
              (!m.amazon_sku && Boolean(amazonSku)) ||
              (!m.temu_sku_id && Boolean(temuSkuId)) ||
              (!m.tiktok_seller_sku && Boolean(tiktokSellerSku))
          );
          if (reusable) {
            const { error: mappingPatchError } = await supabase
              .from("sku_mappings")
              .update({
                amazon_sku: amazonSku || null,
                temu_sku_id: temuSkuId || null,
                tiktok_seller_sku: tiktokSellerSku || null,
                lead_time_days: Number.isFinite(leadTimeDays) ? leadTimeDays : null,
              })
              .eq("id", reusable.id);
            if (mappingPatchError) throw mappingPatchError;
            const payload = { id: reusable.id, sku_catalog_id: catalogId };
            if (amazonSku) byAmazon.set(amazonSku, payload);
            if (temuSkuId) byTemu.set(temuSkuId, payload);
            if (tiktokSellerSku) byTiktok.set(tiktokSellerSku, payload);
            updated += 1;
            continue;
          }

          const { data: mapping, error: mappingError } = await supabase
            .from("sku_mappings")
            .insert({
              account_id: accountId,
              sku_catalog_id: catalogId,
              amazon_sku: amazonSku || null,
              temu_sku_id: temuSkuId || null,
              tiktok_seller_sku: tiktokSellerSku || null,
              lead_time_days: Number.isFinite(leadTimeDays) ? leadTimeDays : null,
            })
            .select("id")
            .single();
          if (mappingError || !mapping?.id) throw mappingError || new Error("Failed to create mapping.");
          const payload = { id: String(mapping.id), sku_catalog_id: catalogId };
          if (amazonSku) byAmazon.set(amazonSku, payload);
          if (temuSkuId) byTemu.set(temuSkuId, payload);
          if (tiktokSellerSku) byTiktok.set(tiktokSellerSku, payload);
          const nextList = byCatalog.get(catalogId) || [];
          nextList.push({
            id: String(mapping.id),
            amazon_sku: amazonSku || null,
            temu_sku_id: temuSkuId || null,
            tiktok_seller_sku: tiktokSellerSku || null,
          });
          byCatalog.set(catalogId, nextList);
          created += 1;
        }
      }

      setMessage(`Bulk mapping import complete. Created: ${created}, Updated: ${updated}, Skipped: ${skipped}.`);
      await loadRows();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Bulk mapping import failed.");
    } finally {
      setBulkLoading(false);
    }
  };

  const saveRow = async (row: MappingRow) => {
    if (!canEdit) return;
    const supabase = createClient();
    const normalizedName = normalizeProductName(row.product_name);
    const { data: sameNameCatalog, error: sameNameCatalogError } = await supabase
      .from("sku_catalog")
      .select("id")
      .eq("account_id", accountId)
      .eq("product_name", normalizedName)
      .maybeSingle();
    if (sameNameCatalogError) {
      setError(sameNameCatalogError.message);
      return;
    }
    let targetCatalogId = row.sku_catalog_id;
    const normalizedTemuGoodsId = normalizeSkuToken(row.temu_goods_id || "");
    if (sameNameCatalog?.id) {
      targetCatalogId = String(sameNameCatalog.id);
      if (normalizedTemuGoodsId) {
        await supabase
          .from("sku_catalog")
          .update({ temu_goods_id: normalizedTemuGoodsId })
          .eq("id", targetCatalogId);
      }
    } else {
      const { error: catalogError } = await supabase
        .from("sku_catalog")
        .update({ product_name: normalizedName, temu_goods_id: normalizedTemuGoodsId || null })
        .eq("id", row.sku_catalog_id);
      if (catalogError) {
        setError(catalogError.message);
        return;
      }
    }
    const { error: mappingError } = await supabase
      .from("sku_mappings")
      .update({
        sku_catalog_id: targetCatalogId,
        amazon_sku: normalizeSkuToken(row.amazon_sku || "") || null,
        temu_sku_id: normalizeSkuToken(row.temu_sku_id || "") || null,
        tiktok_seller_sku: normalizeSkuToken(row.tiktok_seller_sku || "") || null,
        lead_time_days: row.lead_time_days ?? null,
      })
      .eq("id", row.id);
    if (mappingError) {
      setError(mappingError.message);
      return;
    }
    setMessage("SKU mapping updated.");
    await loadRows();
  };

  const deleteRow = async (row: MappingRow) => {
    if (!canEdit) return;
    const supabase = createClient();
    const { error: mappingError } = await supabase.from("sku_mappings").delete().eq("id", row.id);
    if (mappingError) {
      setError(mappingError.message);
      return;
    }
    await supabase.from("sku_catalog").delete().eq("id", row.sku_catalog_id);
    setMessage("SKU mapping deleted.");
    await loadRows();
  };

  return (
    <section className="space-y-3 rounded-2xl border border-slate-200 bg-white p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-slate-800">SKU Mapping (Amazon SKU ↔ Temu SKU ID ↔ TikTok Seller SKU)</h3>
        <div className="flex flex-wrap items-center gap-2">
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search product or SKU"
            className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm sm:w-72"
          />
          {searchActive ? (
            <>
              <button
                type="button"
                onClick={() => setSearch("")}
                className="rounded-lg bg-slate-100 px-3 py-2 text-xs font-semibold text-slate-700"
              >
                Clear
              </button>
              <span className="text-xs text-slate-500">
                {rows.length} match{rows.length === 1 ? "" : "es"}
              </span>
            </>
          ) : null}
        </div>
      </div>

      {canEdit ? (
        <div className="space-y-3 rounded-xl border border-slate-200 bg-slate-50 p-3">
          <p className="text-xs text-slate-600">
            Bulk upload CSV/XLSX with columns: <span className="font-semibold">Product Name, Amazon SKU, Temu SKU ID, Temu Goods ID, TikTok Seller SKU, Lead Time</span>.
          </p>
          <div className="grid gap-3 md:grid-cols-[1fr_auto]">
            <FileDropzone
              accept=".csv,.xlsx,.xls"
              onFileSelect={(file) => void onBulkFileChange(file)}
              disabled={bulkLoading}
              label="Upload SKU Mapping file"
              hint="CSV/XLSX"
              selectedFileName={bulkFileName || undefined}
            />
            <div className="flex items-end">
              <button
                type="button"
                onClick={() => void runBulkImport()}
                disabled={bulkLoading || !bulkRows.length}
                className="rounded-lg bg-[var(--md-primary)] px-4 py-2 text-sm font-semibold text-white disabled:opacity-60"
              >
                {bulkLoading ? "Importing..." : "Import Mappings"}
              </button>
            </div>
          </div>
          {bulkRows.length > 0 ? (
            <div className="grid gap-2 md:grid-cols-6">
              <label className="text-xs text-slate-600">
                <span className="mb-1 block uppercase tracking-wide text-slate-500">Product Name Column</span>
                <select
                  value={productCol}
                  onChange={(e) => setProductCol(e.target.value)}
                  className="w-full rounded-lg border border-slate-300 px-2 py-2 text-sm"
                >
                  <option value="">Select column</option>
                  {bulkHeaders.map((header) => (
                    <option key={header} value={header}>
                      {header}
                    </option>
                  ))}
                </select>
              </label>
              <label className="text-xs text-slate-600">
                <span className="mb-1 block uppercase tracking-wide text-slate-500">Amazon SKU Column</span>
                <select
                  value={amazonSkuCol}
                  onChange={(e) => setAmazonSkuCol(e.target.value)}
                  className="w-full rounded-lg border border-slate-300 px-2 py-2 text-sm"
                >
                  <option value="">Select column</option>
                  {bulkHeaders.map((header) => (
                    <option key={header} value={header}>
                      {header}
                    </option>
                  ))}
                </select>
              </label>
              <label className="text-xs text-slate-600">
                <span className="mb-1 block uppercase tracking-wide text-slate-500">Temu SKU ID Column</span>
                <select
                  value={temuSkuCol}
                  onChange={(e) => setTemuSkuCol(e.target.value)}
                  className="w-full rounded-lg border border-slate-300 px-2 py-2 text-sm"
                >
                  <option value="">Select column</option>
                  {bulkHeaders.map((header) => (
                    <option key={header} value={header}>
                      {header}
                    </option>
                  ))}
                </select>
              </label>
              <label className="text-xs text-slate-600">
                <span className="mb-1 block uppercase tracking-wide text-slate-500">Temu Goods ID Column</span>
                <select
                  value={temuGoodsIdCol}
                  onChange={(e) => setTemuGoodsIdCol(e.target.value)}
                  className="w-full rounded-lg border border-slate-300 px-2 py-2 text-sm"
                >
                  <option value="">Select column</option>
                  {bulkHeaders.map((header) => (
                    <option key={header} value={header}>
                      {header}
                    </option>
                  ))}
                </select>
              </label>
              <label className="text-xs text-slate-600">
                <span className="mb-1 block uppercase tracking-wide text-slate-500">TikTok Seller SKU Column</span>
                <select
                  value={tiktokSkuCol}
                  onChange={(e) => setTiktokSkuCol(e.target.value)}
                  className="w-full rounded-lg border border-slate-300 px-2 py-2 text-sm"
                >
                  <option value="">Select column</option>
                  {bulkHeaders.map((header) => (
                    <option key={header} value={header}>
                      {header}
                    </option>
                  ))}
                </select>
              </label>
              <label className="text-xs text-slate-600">
                <span className="mb-1 block uppercase tracking-wide text-slate-500">Lead Time Column</span>
                <select
                  value={leadTimeCol}
                  onChange={(e) => setLeadTimeCol(e.target.value)}
                  className="w-full rounded-lg border border-slate-300 px-2 py-2 text-sm"
                >
                  <option value="">Select column</option>
                  {bulkHeaders.map((header) => (
                    <option key={header} value={header}>
                      {header}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          ) : null}
        </div>
      ) : null}

      {message ? <p className="rounded-xl bg-green-50 px-3 py-2 text-sm text-green-700">{message}</p> : null}
      {error ? <p className="rounded-xl bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p> : null}

      <div className="overflow-x-auto rounded-xl border border-slate-200">
        <table className="min-w-full text-sm">
          <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
            <tr>
              <th className="px-3 py-2">Product</th>
              <th className="px-3 py-2">Amazon SKU</th>
              <th className="px-3 py-2">Temu SKU ID</th>
              <th className="px-3 py-2">Temu Goods ID</th>
              <th className="px-3 py-2">TikTok Seller SKU</th>
              <th className="px-3 py-2">Lead Time (days)</th>
              {canEdit ? <th className="px-3 py-2">Actions</th> : null}
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td className="px-3 py-3 text-slate-500" colSpan={canEdit ? 7 : 6}>
                  Loading mappings...
                </td>
              </tr>
            ) : filtered.length === 0 ? (
              <tr>
                <td className="px-3 py-3 text-slate-500" colSpan={canEdit ? 7 : 6}>
                  No mappings found.
                </td>
              </tr>
            ) : (
              filtered.map((row, idx) => (
                <EditableMappingRow
                  key={row.id}
                  row={row}
                  canEdit={canEdit}
                  onChange={(patch) => {
                    setRows((prev) => {
                      const next = [...prev];
                      const targetIdx = next.findIndex((r) => r.id === row.id);
                      if (targetIdx < 0) return prev;
                      next[targetIdx] = { ...next[targetIdx], ...patch };
                      return next;
                    });
                  }}
                  onSave={() => void saveRow(rows.find((r) => r.id === row.id) || row)}
                  onDelete={() => void deleteRow(row)}
                  className={idx % 2 ? "bg-white" : "bg-slate-50/30"}
                />
              ))
            )}
          </tbody>
        </table>
      </div>
      {searchActive ? null : (
      <div className="flex flex-wrap items-center justify-end gap-2">
        <span className="text-xs text-slate-500">
          Page {currentPage} of {totalPages} ({totalCount} items)
        </span>
        <select
          value={currentPage}
          onChange={(e) => setOffset((Number(e.target.value) - 1) * PAGE_SIZE)}
          className="rounded-lg border border-slate-300 px-2 py-1.5 text-xs"
        >
          {Array.from({ length: totalPages }, (_, idx) => idx + 1).map((page) => (
            <option key={page} value={page}>
              {page}
            </option>
          ))}
        </select>
        <button
          type="button"
          onClick={() => setOffset((prev) => Math.max(0, prev - PAGE_SIZE))}
          disabled={offset === 0 || loading}
          className="rounded-lg bg-slate-100 px-3 py-1.5 text-xs font-semibold text-slate-700 disabled:opacity-50"
        >
          Previous
        </button>
        <button
          type="button"
          onClick={() => setOffset((prev) => prev + PAGE_SIZE)}
          disabled={currentPage >= totalPages || loading}
          className="rounded-lg bg-slate-100 px-3 py-1.5 text-xs font-semibold text-slate-700 disabled:opacity-50"
        >
          Next
        </button>
      </div>
      )}
    </section>
  );
}

function EditableMappingRow({
  row,
  canEdit,
  onChange,
  onSave,
  onDelete,
  className,
}: {
  row: MappingRow;
  canEdit: boolean;
  onChange: (patch: Partial<MappingRow>) => void;
  onSave: () => void;
  onDelete: () => void;
  className?: string;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  return (
    <tr className={className}>
      <td className="px-3 py-2">
        {canEdit ? (
          <input
            value={row.product_name}
            onChange={(e) => onChange({ product_name: e.target.value })}
            className="w-full rounded-lg border border-slate-300 px-2 py-1"
          />
        ) : (
          <span title={row.product_name}>{shortenText(row.product_name)}</span>
        )}
      </td>
      <td className="px-3 py-2">
        {canEdit ? (
          <input
            value={row.amazon_sku || ""}
            onChange={(e) => onChange({ amazon_sku: e.target.value.toUpperCase() || null })}
            className="w-full rounded-lg border border-slate-300 px-2 py-1"
          />
        ) : (
          row.amazon_sku || "-"
        )}
      </td>
      <td className="px-3 py-2">
        {canEdit ? (
          <input
            value={row.temu_sku_id || ""}
            onChange={(e) => onChange({ temu_sku_id: e.target.value.toUpperCase() || null })}
            className="w-full rounded-lg border border-slate-300 px-2 py-1"
          />
        ) : (
          row.temu_sku_id || "-"
        )}
      </td>
      <td className="px-3 py-2">
        {canEdit ? (
          <input
            value={row.temu_goods_id || ""}
            onChange={(e) => onChange({ temu_goods_id: e.target.value.toUpperCase() || null })}
            className="w-full rounded-lg border border-slate-300 px-2 py-1"
            placeholder="Goods ID"
          />
        ) : (
          row.temu_goods_id || "-"
        )}
      </td>
      <td className="px-3 py-2">
        {canEdit ? (
          <input
            value={row.tiktok_seller_sku || ""}
            onChange={(e) => onChange({ tiktok_seller_sku: e.target.value.toUpperCase() || null })}
            className="w-full rounded-lg border border-slate-300 px-2 py-1"
            placeholder="Seller SKU"
          />
        ) : (
          row.tiktok_seller_sku || "-"
        )}
      </td>
      <td className="px-3 py-2">
        {canEdit ? (
          <input
            type="number"
            value={row.lead_time_days ?? ""}
            onChange={(e) => onChange({ lead_time_days: e.target.value ? Number(e.target.value) : null })}
            className="w-full rounded-lg border border-slate-300 px-2 py-1"
          />
        ) : (
          row.lead_time_days ?? "-"
        )}
      </td>
      {canEdit ? (
        <td className="px-3 py-2">
          <div className="relative inline-block">
            <button
              type="button"
              onClick={() => setMenuOpen((prev) => !prev)}
              className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-slate-300 bg-white text-base font-semibold text-slate-700"
              aria-label="Open row actions"
            >
              ⋮
            </button>
            {menuOpen ? (
              <div className="absolute right-0 z-20 mt-2 min-w-[130px] rounded-lg border border-slate-200 bg-white p-1 shadow-lg">
                <button
                  type="button"
                  onClick={() => {
                    setMenuOpen(false);
                    onSave();
                  }}
                  className="block w-full rounded-md px-3 py-1.5 text-left text-xs font-semibold text-slate-700 hover:bg-slate-100"
                >
                  Save
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setMenuOpen(false);
                    onDelete();
                  }}
                  className="block w-full rounded-md px-3 py-1.5 text-left text-xs font-semibold text-red-700 hover:bg-red-50"
                >
                  Delete
                </button>
              </div>
            ) : null}
          </div>
        </td>
      ) : null}
    </tr>
  );
}
