import type { Metadata } from "next";
import { loadInventoryWorkspace } from "@/lib/inventory/workspace";
import { getInventoryPageContext } from "../_components/page-context";
import { InventoryShell } from "../_components/inventory-shell";
import StockWorkspace from "./stock-workspace";

export const metadata: Metadata = { title: "Stock & ledger" };
export const dynamic = "force-dynamic";

export default async function StockPage({ searchParams }: { searchParams: { accountId?: string } }) {
  const page = await getInventoryPageContext(searchParams.accountId);
  if (!page.ok) return page.element;
  const { account, canEdit, supabase } = page.ctx;
  const workspace = await loadInventoryWorkspace(supabase, account.id, account.currency);

  return (
    <InventoryShell
      accountId={account.id}
      accountName={account.name}
      active="stock"
      title="Stock & ledger"
      description="Current stock in every location. Record a stock take when a count differs from what Daybook expects."
    >
      <StockWorkspace workspace={workspace} accountId={account.id} canEdit={canEdit} />
    </InventoryShell>
  );
}
