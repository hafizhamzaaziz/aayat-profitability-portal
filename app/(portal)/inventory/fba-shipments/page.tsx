import type { Metadata } from "next";
import Link from "next/link";
import { loadFbaShipments } from "@/lib/inventory/documents";
import { getInventoryPageContext } from "../_components/page-context";
import { InventoryShell, inventoryHref } from "../_components/inventory-shell";
import FbaShipmentList from "./fba-shipment-list";

export const metadata: Metadata = { title: "FBA shipments" };
export const dynamic = "force-dynamic";

export default async function FbaShipmentsPage({ searchParams }: { searchParams: { accountId?: string } }) {
  const page = await getInventoryPageContext(searchParams.accountId);
  if (!page.ok) return page.element;
  const { supabase, account, canEdit } = page.ctx;
  const shipments = await loadFbaShipments(supabase, account.id);

  return (
    <InventoryShell
      accountId={account.id}
      accountName={account.name}
      active="fba-shipments"
      title="FBA shipments"
      description="Stock moving from the 3PL to Amazon. Build the shipment here (cartons and pallets from your carton profiles), create it in Seller Central, paste the FBA shipment ID, mark it shipped — the units leave the warehouse and sit “in transit” until you record what Amazon checked in."
      actions={
        canEdit ? (
          <Link href={inventoryHref("/inventory/fba-shipments/new", account.id)} className="rounded-lg bg-slate-900 px-3 py-2 text-sm font-semibold text-white hover:bg-slate-800">
            New FBA shipment
          </Link>
        ) : null
      }
    >
      <FbaShipmentList shipments={shipments} accountId={account.id} />
    </InventoryShell>
  );
}
