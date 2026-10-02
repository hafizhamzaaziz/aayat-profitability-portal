import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { loadFbaShipment } from "@/lib/inventory/documents";
import { loadInventoryWorkspace } from "@/lib/inventory/workspace";
import { getInventoryPageContext } from "../../_components/page-context";
import { InventoryShell, inventoryHref } from "../../_components/inventory-shell";
import FbaShipmentDetailView from "../fba-shipment-detail";

export const metadata: Metadata = { title: "FBA shipment" };
export const dynamic = "force-dynamic";

export default async function FbaShipmentPage({ params, searchParams }: { params: { id: string }; searchParams: { accountId?: string } }) {
  const page = await getInventoryPageContext(searchParams.accountId);
  if (!page.ok) return page.element;
  const { supabase, account, canEdit } = page.ctx;
  const [shipment, workspace] = await Promise.all([loadFbaShipment(supabase, account.id, params.id), loadInventoryWorkspace(supabase, account.id, account.currency)]);
  if (!shipment) notFound();

  return (
    <InventoryShell
      accountId={account.id}
      accountName={account.name}
      active="fba-shipments"
      title={
        <span>
          {shipment.name}
          {shipment.amazonShipmentId ? <span className="ml-2 font-mono text-base font-normal text-slate-500">{shipment.amazonShipmentId}</span> : null}
        </span>
      }
      actions={
        <>
          <Link href={inventoryHref("/inventory/fba-shipments", account.id)} className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50">
            ← All shipments
          </Link>
          <a href={`/api/inventory/fba-shipment/${shipment.id}/pdf`} target="_blank" rel="noreferrer" className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50">
            Packing list PDF
          </a>
        </>
      }
    >
      <FbaShipmentDetailView shipment={shipment} workspace={workspace} accountId={account.id} canEdit={canEdit} />
    </InventoryShell>
  );
}
