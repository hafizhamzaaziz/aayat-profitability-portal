import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { loadPurchaseOrder } from "@/lib/inventory/documents";
import { loadInventoryWorkspace } from "@/lib/inventory/workspace";
import { getInventoryPageContext } from "../../_components/page-context";
import { InventoryShell, inventoryHref } from "../../_components/inventory-shell";
import PurchaseOrderDetailView from "../purchase-order-detail";

export const metadata: Metadata = { title: "Purchase order" };
export const dynamic = "force-dynamic";

export default async function PurchaseOrderPage({ params, searchParams }: { params: { id: string }; searchParams: { accountId?: string } }) {
  const page = await getInventoryPageContext(searchParams.accountId);
  if (!page.ok) return page.element;
  const { supabase, account, canEdit } = page.ctx;
  const [po, workspace] = await Promise.all([loadPurchaseOrder(supabase, account.id, params.id), loadInventoryWorkspace(supabase, account.id, account.currency)]);
  if (!po) notFound();

  return (
    <InventoryShell
      accountId={account.id}
      accountName={account.name}
      active="purchase-orders"
      title={
        <span>
          {po.poNumber}
          {po.supplierName ? <span className="ml-2 text-base font-normal text-slate-500">· {po.supplierName}</span> : null}
        </span>
      }
      actions={
        <>
          <Link href={inventoryHref("/inventory/purchase-orders", account.id)} className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50">
            ← All purchase orders
          </Link>
          <a href={`/api/inventory/purchase-order/${po.id}/pdf`} target="_blank" rel="noreferrer" className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50">
            Download PDF
          </a>
        </>
      }
    >
      <PurchaseOrderDetailView po={po} workspace={workspace} accountId={account.id} canEdit={canEdit} />
    </InventoryShell>
  );
}
