import { NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { renderInventoryShipmentPdfBuffer } from "@/lib/pdf/inventory-shipment-document";

export const runtime = "nodejs";

export async function GET(
  _request: NextRequest,
  context: { params: { planId: string } }
) {
  const planId = context.params.planId;
  if (!planId) return new Response("Missing plan id.", { status: 400 });

  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return new Response("Unauthorized", { status: 401 });

  const { data: plan, error: planError } = await supabase
    .from("shipment_plans")
    .select("id, account_id, plan_date, plan_type, title, notes, orientation")
    .eq("id", planId)
    .maybeSingle();
  if (planError) return new Response(planError.message, { status: 500 });
  if (!plan) return new Response("Shipment plan not found.", { status: 404 });

  const { data: account, error: accountError } = await supabase
    .from("accounts")
    .select("id, name, logo_url")
    .eq("id", plan.account_id)
    .maybeSingle();
  if (accountError) return new Response(accountError.message, { status: 500 });
  if (!account) return new Response("Account not found.", { status: 404 });

  const { data: items, error: itemsError } = await supabase
    .from("shipment_plan_items")
    .select(
      "suggested_units, planned_units, units_per_box, planned_boxes, pallets, lead_time_days, sku_mapping:sku_mapping_id(amazon_sku, temu_sku_id, sku_catalog:sku_catalog_id(product_name))"
    )
    .eq("shipment_plan_id", planId)
    .order("created_at", { ascending: true });
  if (itemsError) return new Response(itemsError.message, { status: 500 });

  const normalizedItems = (items || []).map((row) => {
    const rec = row as unknown as {
      suggested_units: number;
      planned_units: number;
      units_per_box: number;
      planned_boxes: number;
      pallets: number;
      lead_time_days: number | null;
      sku_mapping?: {
        amazon_sku?: string | null;
        temu_sku_id?: string | null;
        sku_catalog?: { product_name?: string } | null;
      } | null;
    };
    return {
      product_name: rec.sku_mapping?.sku_catalog?.product_name || "Unnamed product",
      amazon_sku: rec.sku_mapping?.amazon_sku || null,
      temu_sku_id: rec.sku_mapping?.temu_sku_id || null,
      suggested_units: Number(rec.suggested_units || 0),
      planned_units: Number(rec.planned_units || 0),
      units_per_box: Number(rec.units_per_box || 0),
      planned_boxes: Number(rec.planned_boxes || 0),
      pallets: Number(rec.pallets || 0),
      lead_time_days: rec.lead_time_days == null ? null : Number(rec.lead_time_days),
    };
  });

  const orientation = (normalizedItems.length > 8 ? "landscape" : plan.orientation) as "portrait" | "landscape";
  const pdfBytes = await renderInventoryShipmentPdfBuffer({
    accountName: account.name,
    accountLogoUrl: account.logo_url,
    title: plan.title,
    planDate: String(plan.plan_date),
    planType: String(plan.plan_type),
    notes: plan.notes || "",
    orientation,
    items: normalizedItems,
  });

  return new Response(Buffer.from(pdfBytes) as unknown as BodyInit, {
    status: 200,
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="shipment-plan-${planId}.pdf"`,
    },
  });
}
