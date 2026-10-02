import type { Metadata } from "next";
import { loadInventoryWorkspace } from "@/lib/inventory/workspace";
import { getInventoryPageContext } from "./_components/page-context";
import { InventoryShell } from "./_components/inventory-shell";
import PlannerWorkspace from "./planner-workspace";

export const metadata: Metadata = { title: "Inventory planner" };
export const dynamic = "force-dynamic";

export default async function InventoryPage({ searchParams }: { searchParams: { accountId?: string } }) {
  const page = await getInventoryPageContext(searchParams.accountId);
  if (!page.ok) return page.element;
  const { supabase, account, canEdit } = page.ctx;
  const workspace = await loadInventoryWorkspace(supabase, account.id, account.currency);

  return (
    <InventoryShell
      accountId={account.id}
      accountName={account.name}
      active="planner"
      title="Inventory planner"
      description="Every SKU across the whole pipeline — on order at the supplier, at the 3PL, in transit to Amazon and live at FBA — with what to order and what to ship next, worked out from real sales velocity and your lead times."
    >
      <PlannerWorkspace workspace={workspace} accountId={account.id} canEdit={canEdit} />
    </InventoryShell>
  );
}
