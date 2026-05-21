import { NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { renderInventoryDailySalesPdfBuffer } from "@/lib/pdf/inventory-daily-sales-document";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  try {
    const accountId = String(request.nextUrl.searchParams.get("accountId") || "");
    const from = String(request.nextUrl.searchParams.get("from") || "");
    const to = String(request.nextUrl.searchParams.get("to") || "");
    const platform = String(request.nextUrl.searchParams.get("platform") || "all");
    const warehouseId = String(request.nextUrl.searchParams.get("warehouseId") || "all");
    const mappingId = String(request.nextUrl.searchParams.get("mappingId") || "all");
    const skuSearch = String(request.nextUrl.searchParams.get("skuSearch") || "").trim().toLowerCase();
    if (!accountId || !from || !to) return new Response("Missing filters.", { status: 400 });

    const supabase = createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return new Response("Unauthorized", { status: 401 });

    const { data: account, error: accountError } = await supabase
      .from("accounts")
      .select("id, name, currency, vat_rate, logo_url")
      .eq("id", accountId)
      .maybeSingle();
    if (accountError || !account) return new Response("Account not found.", { status: 404 });

    let salesQueryWithSoldUnits = supabase
      .from("inventory_daily_sales")
      .select("sku_mapping_id, sale_date, platform, warehouse_id, sold_units, returns_units, collected_units, notes")
      .eq("account_id", accountId)
      .gte("sale_date", from)
      .lte("sale_date", to)
      .order("sale_date", { ascending: true });
    if (platform !== "all") salesQueryWithSoldUnits = salesQueryWithSoldUnits.eq("platform", platform);
    if (warehouseId !== "all") salesQueryWithSoldUnits = salesQueryWithSoldUnits.eq("warehouse_id", warehouseId);
    if (mappingId !== "all") salesQueryWithSoldUnits = salesQueryWithSoldUnits.eq("sku_mapping_id", mappingId);

    const [{ data: rowsWithSoldUnits, error: rowsError }, { data: cogsRows }, { data: warehouseRows }, { data: mappingRows }] = await Promise.all([
      salesQueryWithSoldUnits,
      supabase.from("cogs").select("sku, unit_cost, sku_mapping_id").eq("account_id", accountId),
      supabase.from("inventory_warehouses").select("id, name").eq("account_id", accountId),
      supabase
        .from("sku_mappings")
        .select("id, amazon_sku, temu_sku_id, sku_catalog:sku_catalog_id(product_name)")
        .eq("account_id", accountId),
    ]);

    let rows = rowsWithSoldUnits;
    if (rowsError) {
      const message = String(rowsError.message || "").toLowerCase();
      const soldUnitsMissing = message.includes("sold_units") && (message.includes("column") || message.includes("does not exist"));
      if (!soldUnitsMissing) return new Response(rowsError.message, { status: 500 });

      let fallback = supabase
        .from("inventory_daily_sales")
        .select("sku_mapping_id, sale_date, platform, warehouse_id, returns_units, collected_units, notes")
        .eq("account_id", accountId)
        .gte("sale_date", from)
        .lte("sale_date", to)
        .order("sale_date", { ascending: true });
      if (platform !== "all") fallback = fallback.eq("platform", platform);
      if (warehouseId !== "all") fallback = fallback.eq("warehouse_id", warehouseId);
      if (mappingId !== "all") fallback = fallback.eq("sku_mapping_id", mappingId);
      const fallbackRes = await fallback;
      if (fallbackRes.error) return new Response(fallbackRes.error.message, { status: 500 });
      rows = (fallbackRes.data || []).map((row) => ({ ...row, sold_units: 0 }));
    }

    const warehouseById = new Map((warehouseRows || []).map((w) => [String((w as { id: string }).id), String((w as { name: string }).name || "")]));
    const cogsByMapping = new Map(
      (cogsRows || []).map((c) => [String((c as { sku_mapping_id?: string | null }).sku_mapping_id || ""), Number((c as { unit_cost: number }).unit_cost || 0)])
    );
    const mappingById = new Map(
      (mappingRows || []).map((m) => [
        String((m as { id: string }).id),
        {
          amazonSku: String((m as { amazon_sku?: string | null }).amazon_sku || ""),
          temuSkuId: String((m as { temu_sku_id?: string | null }).temu_sku_id || ""),
          productName: String(
            ((m as { sku_catalog?: { product_name?: string } | null }).sku_catalog as { product_name?: string } | null)?.product_name || "Unnamed product"
          ),
        },
      ])
    );

    const vatRate = Number(account.vat_rate || 20) / 100;
    const normalizedRows = (rows || [])
      .map((row) => {
        const rec = row as unknown as {
          sku_mapping_id: string;
          sale_date: string;
          platform: string;
          warehouse_id: string | null;
          sold_units?: number;
          returns_units: number;
          collected_units: number;
          notes: string | null;
        };
        const mapping = mappingById.get(String(rec.sku_mapping_id || ""));
        const sku = mapping?.amazonSku || mapping?.temuSkuId || "-";
        const productName = mapping?.productName || "Unnamed product";
        const cost = cogsByMapping.get(String(rec.sku_mapping_id || "")) || 0;
        const soldUnits = Number(rec.sold_units || 0);
        const excl = Number((soldUnits * cost).toFixed(2));
        const incl = Number((excl * (1 + vatRate)).toFixed(2));
        return {
          sale_date: rec.sale_date,
          product_name: productName,
          sku,
          platform: rec.platform,
          warehouse: rec.warehouse_id ? warehouseById.get(String(rec.warehouse_id)) || "-" : "-",
          sold_units: soldUnits,
          returns_units: Number(rec.returns_units || 0),
          collected_units: Number(rec.collected_units || 0),
          excl_vat: excl,
          incl_vat: incl,
          notes: rec.notes || "",
        };
      })
      .filter((row) => {
        if (!skuSearch) return true;
        return row.product_name.toLowerCase().includes(skuSearch) || row.sku.toLowerCase().includes(skuSearch);
      });

    let pdfBytes: Uint8Array;
    try {
      pdfBytes = await renderInventoryDailySalesPdfBuffer({
        accountName: account.name,
        accountLogoUrl: account.logo_url,
        from,
        to,
        rows: normalizedRows,
        currency: account.currency || "£",
      });
    } catch (renderError) {
      console.error("[daily-sales-pdf] render with logo failed:", renderError);
      pdfBytes = await renderInventoryDailySalesPdfBuffer({
        accountName: account.name,
        accountLogoUrl: null,
        from,
        to,
        rows: normalizedRows,
        currency: account.currency || "£",
      });
    }

    return new Response(Buffer.from(pdfBytes) as unknown as BodyInit, {
      status: 200,
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="daily-sales-${from}_${to}.pdf"`,
      },
    });
  } catch (error) {
    console.error("[daily-sales-pdf] fatal:", error);
    const message = error instanceof Error ? error.message : "Unexpected PDF error.";
    return new Response(message, { status: 500 });
  }
}
