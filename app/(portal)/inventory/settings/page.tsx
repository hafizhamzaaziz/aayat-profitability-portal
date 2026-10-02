import type { Metadata } from "next";
import { loadInventoryWorkspace } from "@/lib/inventory/workspace";
import { getInventoryPageContext } from "../_components/page-context";
import { InventoryShell } from "../_components/inventory-shell";
import SettingsWorkspace from "./settings-workspace";

export const metadata: Metadata = { title: "Inventory settings" };
export const dynamic = "force-dynamic";

export default async function InventorySettingsPage({ searchParams }: { searchParams: { accountId?: string; tab?: string } }) {
  const page = await getInventoryPageContext(searchParams.accountId);
  if (!page.ok) return page.element;
  const { supabase, account, canEdit } = page.ctx;
  const workspace = await loadInventoryWorkspace(supabase, account.id, account.currency);

  return (
    <InventoryShell
      accountId={account.id}
      accountName={account.name}
      active="settings"
      title="Inventory settings"
      description="Lead times, cover targets, suppliers, warehouses and carton profiles. The planner uses these to decide when to order and how much to send to FBA — get them right once and the recommendations take care of themselves."
    >
      <SettingsWorkspace workspace={workspace} accountId={account.id} canEdit={canEdit} initialTab={searchParams.tab} />
    </InventoryShell>
  );
}
