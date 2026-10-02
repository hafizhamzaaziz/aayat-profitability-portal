import type { Metadata } from "next";
import { loadInventoryWorkspace } from "@/lib/inventory/workspace";
import { fetchAllRows } from "@/lib/supabase/fetch-all";
import { addDays, todayIsoUtc } from "@/lib/utils/date";
import { getInventoryPageContext } from "../_components/page-context";
import { InventoryShell } from "../_components/inventory-shell";
import DailySalesWorkspace, { type DailySaleRow } from "./daily-sales-workspace";

export const metadata: Metadata = { title: "Daily sales" };
export const dynamic = "force-dynamic";

function isIso(v: string | undefined) {
  return !!v && /^\d{4}-\d{2}-\d{2}$/.test(v);
}

export default async function DailySalesPage({ searchParams }: { searchParams: { accountId?: string; from?: string; to?: string } }) {
  const page = await getInventoryPageContext(searchParams.accountId);
  if (!page.ok) return page.element;
  const { supabase, account, canEdit } = page.ctx;

  const today = todayIsoUtc();
  const to = isIso(searchParams.to) ? searchParams.to! : today;
  const from = isIso(searchParams.from) ? searchParams.from! : addDays(to, -13);

  const [workspace, rowsRes] = await Promise.all([
    loadInventoryWorkspace(supabase, account.id, account.currency),
    fetchAllRows<Record<string, unknown>>((a, b) =>
      supabase
        .from("inventory_daily_sales")
        .select("id, sku_mapping_id, sale_date, platform, channel, warehouse_id, sold_units, returns_units, collected_units, notes, source")
        .eq("account_id", account.id)
        .gte("sale_date", from)
        .lte("sale_date", to)
        .order("sale_date", { ascending: false })
        .order("id", { ascending: true })
        .range(a, b)
    ),
  ]);

  const rows: DailySaleRow[] = (rowsRes.data || []).map((r) => ({
    id: String(r.id),
    mappingId: String(r.sku_mapping_id),
    saleDate: String(r.sale_date),
    platform: String(r.platform) as DailySaleRow["platform"],
    channel: (r.channel as DailySaleRow["channel"]) || null,
    warehouseId: r.warehouse_id ? String(r.warehouse_id) : null,
    soldUnits: Number(r.sold_units || 0),
    returnsUnits: Number(r.returns_units || 0),
    collectedUnits: Number(r.collected_units || 0),
    notes: (r.notes as string | null) || null,
    source: String(r.source || "manual"),
  }));

  return (
    <InventoryShell
      accountId={account.id}
      accountName={account.name}
      active="daily-sales"
      title="Daily sales"
      description="Units dispatched each day. Amazon FBA and FBM rows arrive automatically from the connected account; Temu, TikTok and anything else the 3PL ships by hand are logged here. FBM, Temu and TikTok reduce the warehouse they are assigned to; FBA reduces Amazon stock."
    >
      <DailySalesWorkspace workspace={workspace} accountId={account.id} canEdit={canEdit} rows={rows} from={from} to={to} error={rowsRes.error?.message || null} />
    </InventoryShell>
  );
}
