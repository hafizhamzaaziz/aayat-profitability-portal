import { NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { requireAccountAccess } from "@/lib/auth/require-account";
import { loadFbaShipment } from "@/lib/inventory/documents";
import { renderFbaPackingListPdf } from "@/lib/pdf/inventory-documents";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_request: NextRequest, context: { params: { id: string } }) {
  try {
    const id = context.params.id;
    if (!id) return new Response("Missing shipment id.", { status: 400 });

    const supabase = createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return new Response("Unauthorized", { status: 401 });

    const { data: head, error: headError } = await supabase.from("fba_shipments").select("id, account_id, source_warehouse_id").eq("id", id).maybeSingle();
    if (headError) return new Response(headError.message, { status: 500 });
    if (!head) return new Response("Shipment not found.", { status: 404 });

    const accountId = String(head.account_id);
    const access = await requireAccountAccess(supabase, user.id, accountId);
    if (!access.account) return new Response("Forbidden", { status: 403 });

    const [shipment, { data: account }, { data: warehouse }, { data: fba }] = await Promise.all([
      loadFbaShipment(supabase, accountId, id),
      supabase.from("accounts").select("id, name, logo_url").eq("id", accountId).maybeSingle(),
      head.source_warehouse_id ? supabase.from("inventory_warehouses").select("name").eq("id", head.source_warehouse_id).maybeSingle() : Promise.resolve({ data: null }),
      supabase.from("amazon_fba_inventory").select("sku, fnsku").eq("account_id", accountId),
    ]);
    if (!shipment || !account) return new Response("Shipment not found.", { status: 404 });
    const fnskuBySku = new Map((fba || []).map((r) => [String(r.sku).trim().toUpperCase(), (r as { fnsku?: string | null }).fnsku || null]));

    const useSent = shipment.status !== "draft";
    const render = (logo: string | null) =>
      renderFbaPackingListPdf({
        accountName: account.name,
        accountLogoUrl: logo,
        shipmentName: shipment.name,
        amazonShipmentId: shipment.amazonShipmentId,
        status: shipment.status,
        sourceWarehouse: warehouse ? String(warehouse.name) : null,
        shipDate: shipment.shipDate,
        expectedArrivalDate: shipment.expectedArrivalDate,
        carrier: shipment.carrier,
        trackingRef: shipment.trackingRef,
        poNumber: shipment.poNumber,
        notes: shipment.notes,
        items: shipment.items.map((it) => ({
          productName: it.productName,
          sku: it.sku,
          asin: it.asin,
          fnsku: fnskuBySku.get(it.sku.trim().toUpperCase()) || null,
          units: useSent ? it.sentUnits : it.plannedUnits,
          unitsPerBox: it.unitsPerBox,
          boxes: it.boxes,
          pallets: it.pallets,
          notes: it.notes,
        })),
      });

    let bytes: Uint8Array;
    try {
      bytes = await render(account.logo_url);
    } catch (err) {
      console.error("[fba-shipment-pdf] render with logo failed:", err);
      bytes = await render(null);
    }

    const safeName = shipment.name.replace(/[^a-z0-9-_]+/gi, "-");
    return new Response(Buffer.from(bytes) as unknown as BodyInit, {
      status: 200,
      headers: { "Content-Type": "application/pdf", "Content-Disposition": `inline; filename="packing-list-${safeName}.pdf"` },
    });
  } catch (error) {
    console.error("[fba-shipment-pdf] fatal:", error);
    return new Response(error instanceof Error ? error.message : "Unexpected PDF error.", { status: 500 });
  }
}
