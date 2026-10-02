import type { Metadata } from "next";
import Link from "next/link";
import { loadPurchaseOrders } from "@/lib/inventory/documents";
import { getInventoryPageContext } from "../_components/page-context";
import { InventoryShell, inventoryHref } from "../_components/inventory-shell";
import PurchaseOrderList from "./purchase-order-list";

export const metadata: Metadata = { title: "Purchase orders" };
export const dynamic = "force-dynamic";

export default async function PurchaseOrdersPage({ searchParams }: { searchParams: { accountId?: string } }) {
  const page = await getInventoryPageContext(searchParams.accountId);
  if (!page.ok) return page.element;
  const { supabase, account, canEdit } = page.ctx;
  const orders = await loadPurchaseOrders(supabase, account.id);

  return (
    <InventoryShell
      accountId={account.id}
      accountName={account.name}
      active="purchase-orders"
      title="Purchase orders"
      description="Orders placed with your manufacturers. Move each one through draft → ordered → in production → shipped, then receive the cartons into the 3PL (partial deliveries are fine). Closing a PO with freight and duty gives you the true landed cost per unit to apply to COGS."
      actions={
        canEdit ? (
          <Link href={inventoryHref("/inventory/purchase-orders/new", account.id)} className="rounded-lg bg-slate-900 px-3 py-2 text-sm font-semibold text-white hover:bg-slate-800">
            New purchase order
          </Link>
        ) : null
      }
    >
      <PurchaseOrderList orders={orders} accountId={account.id} currency={account.currency} />
    </InventoryShell>
  );
}
