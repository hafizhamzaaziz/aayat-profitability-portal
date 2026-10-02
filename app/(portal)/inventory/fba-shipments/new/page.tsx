import type { Metadata } from "next";
import { loadInventoryWorkspace } from "@/lib/inventory/workspace";
import { getInventoryPageContext } from "../../_components/page-context";
import { InventoryShell } from "../../_components/inventory-shell";
import FbaShipmentEditor from "../fba-shipment-editor";

export const metadata: Metadata = { title: "New FBA shipment" };
export const dynamic = "force-dynamic";

export default async function NewFbaShipmentPage({ searchParams }: { searchParams: { accountId?: string } }) {
  const page = await getInventoryPageContext(searchParams.accountId);
  if (!page.ok) return page.element;
  const { supabase, account, canEdit } = page.ctx;
  if (!canEdit) {
    return (
      <InventoryShell accountId={account.id} accountName={account.name} active="fba-shipments" title="New FBA shipment">
        <p className="rounded-2xl bg-red-50 px-3 py-2 text-sm text-red-700">Only admin and team users can create shipments.</p>
      </InventoryShell>
    );
  }
  const workspace = await loadInventoryWorkspace(supabase, account.id, account.currency);
  return (
    <InventoryShell accountId={account.id} accountName={account.name} active="fba-shipments" title="New FBA shipment" description="Add the SKUs going to Amazon. Suggested units bring FBA up to your target cover; cartons and pallets come from the carton profile so the packing list is ready for the 3PL.">
      <FbaShipmentEditor workspace={workspace} accountId={account.id} />
    </InventoryShell>
  );
}
