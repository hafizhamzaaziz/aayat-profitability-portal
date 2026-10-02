import type { Metadata } from "next";
import { loadInventoryWorkspace } from "@/lib/inventory/workspace";
import { getInventoryPageContext } from "../../_components/page-context";
import { InventoryShell } from "../../_components/inventory-shell";
import PurchaseOrderEditor from "../purchase-order-editor";

export const metadata: Metadata = { title: "New purchase order" };
export const dynamic = "force-dynamic";

export default async function NewPurchaseOrderPage({ searchParams }: { searchParams: { accountId?: string } }) {
  const page = await getInventoryPageContext(searchParams.accountId);
  if (!page.ok) return page.element;
  const { supabase, account, canEdit } = page.ctx;
  if (!canEdit) {
    return (
      <InventoryShell accountId={account.id} accountName={account.name} active="purchase-orders" title="New purchase order">
        <p className="rounded-2xl bg-red-50 px-3 py-2 text-sm text-red-700">Only admin and team users can create purchase orders.</p>
      </InventoryShell>
    );
  }
  const workspace = await loadInventoryWorkspace(supabase, account.id, account.currency);
  return (
    <InventoryShell accountId={account.id} accountName={account.name} active="purchase-orders" title="New purchase order" description="Pick the supplier, add SKUs (the planner's suggested quantities are one click away) and save as a draft or mark it ordered straight away.">
      <PurchaseOrderEditor workspace={workspace} accountId={account.id} />
    </InventoryShell>
  );
}
