import { NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { requireAccountAccess } from "@/lib/auth/require-account";
import { loadPurchaseOrder } from "@/lib/inventory/documents";
import { renderPurchaseOrderPdf } from "@/lib/pdf/inventory-documents";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_request: NextRequest, context: { params: { id: string } }) {
  try {
    const id = context.params.id;
    if (!id) return new Response("Missing purchase order id.", { status: 400 });

    const supabase = createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return new Response("Unauthorized", { status: 401 });

    const { data: head, error: headError } = await supabase.from("purchase_orders").select("id, account_id, supplier_id, destination_warehouse_id").eq("id", id).maybeSingle();
    if (headError) return new Response(headError.message, { status: 500 });
    if (!head) return new Response("Purchase order not found.", { status: 404 });

    const accountId = String(head.account_id);
    const access = await requireAccountAccess(supabase, user.id, accountId);
    if (!access.account) return new Response("Forbidden", { status: 403 });

    const [po, { data: account }, { data: supplier }, { data: warehouse }, { data: mappings }] = await Promise.all([
      loadPurchaseOrder(supabase, accountId, id),
      supabase.from("accounts").select("id, name, logo_url").eq("id", accountId).maybeSingle(),
      head.supplier_id ? supabase.from("inventory_suppliers").select("name, contact_name, email, phone, country, payment_terms").eq("id", head.supplier_id).maybeSingle() : Promise.resolve({ data: null }),
      head.destination_warehouse_id ? supabase.from("inventory_warehouses").select("name").eq("id", head.destination_warehouse_id).maybeSingle() : Promise.resolve({ data: null }),
      supabase.from("sku_mappings").select("id, asin").eq("account_id", accountId),
    ]);
    if (!po || !account) return new Response("Purchase order not found.", { status: 404 });
    const asinByMapping = new Map((mappings || []).map((m) => [String(m.id), (m as { asin?: string | null }).asin || null]));

    const render = (logo: string | null) =>
      renderPurchaseOrderPdf({
        accountName: account.name,
        accountLogoUrl: logo,
        poNumber: po.poNumber,
        status: po.status,
        orderDate: po.orderDate,
        expectedReadyDate: po.expectedReadyDate,
        expectedArrivalDate: po.expectedArrivalDate,
        currency: po.currency,
        supplier: supplier
          ? {
              name: String(supplier.name),
              contactName: (supplier as { contact_name?: string | null }).contact_name || null,
              email: (supplier as { email?: string | null }).email || null,
              phone: (supplier as { phone?: string | null }).phone || null,
              country: (supplier as { country?: string | null }).country || null,
              paymentTerms: (supplier as { payment_terms?: string | null }).payment_terms || null,
            }
          : po.supplierName
            ? { name: po.supplierName, contactName: null, email: null, phone: null, country: null, paymentTerms: null }
            : null,
        shipTo: warehouse ? String(warehouse.name) : null,
        trackingRef: po.trackingRef,
        notes: po.notes,
        freightCost: po.freightCost,
        dutyCost: po.dutyCost,
        otherCost: po.otherCost,
        items: po.items.map((it) => ({
          productName: it.productName,
          sku: it.sku,
          asin: asinByMapping.get(it.mappingId) || null,
          orderedUnits: it.orderedUnits,
          receivedUnits: it.receivedUnits,
          unitCost: it.unitCost,
          unitsPerBox: it.unitsPerBox,
          notes: it.notes,
        })),
      });

    let bytes: Uint8Array;
    try {
      bytes = await render(account.logo_url);
    } catch (err) {
      console.error("[purchase-order-pdf] render with logo failed:", err);
      bytes = await render(null);
    }

    return new Response(Buffer.from(bytes) as unknown as BodyInit, {
      status: 200,
      headers: { "Content-Type": "application/pdf", "Content-Disposition": `inline; filename="${po.poNumber}.pdf"` },
    });
  } catch (error) {
    console.error("[purchase-order-pdf] fatal:", error);
    return new Response(error instanceof Error ? error.message : "Unexpected PDF error.", { status: 500 });
  }
}
