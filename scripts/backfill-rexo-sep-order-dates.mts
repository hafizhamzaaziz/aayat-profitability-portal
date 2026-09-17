/**
 * One-shot: stamp purchase dates on Rexo Sep SP-API Order rows and refresh
 * inventory_sales_facts_cache. Run with: npx tsx scripts/backfill-rexo-sep-order-dates.mts
 */
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

function loadEnvLocal() {
  const path = resolve(process.cwd(), ".env.local");
  const text = readFileSync(path, "utf8");
  for (const line of text.split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (!m) continue;
    const key = m[1];
    let val = m[2].trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (!process.env[key]) process.env[key] = val;
  }
}

loadEnvLocal();

const ACCOUNT_ID = "e4d1b1d7-2d68-435f-87d1-526ed358edc5";
const FROM = "2026-09-01";
const TO = "2026-09-17";

async function main() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) throw new Error("Missing SUPABASE URL or SERVICE_ROLE_KEY");

  // Dynamic import after env is loaded so encryption/credentials see TOKEN_ENC_KEY.
  const { loadSpApiClient } = await import("../lib/amazon/credentials.ts");
  const { fetchPurchaseDatesByOrderId } = await import("../lib/amazon/ingest/purchase-dates.ts");

  const admin = createClient(url, serviceKey, { auth: { persistSession: false } });

  const { data: rows, error } = await admin
    .from("report_transactions")
    .select("id, raw_row")
    .eq("account_id", ACCOUNT_ID)
    .eq("source", "sp_api")
    .eq("platform", "amazon")
    .gte("transaction_date", FROM)
    .lte("transaction_date", TO)
    .limit(50000);
  if (error) throw error;

  const orderRows = (rows || []).filter((r) => {
    const raw = (r.raw_row || {}) as Record<string, unknown>;
    return String(raw.type || "").trim().toLowerCase() === "order";
  });
  const orderIds = orderRows
    .map((r) => String(((r.raw_row || {}) as Record<string, unknown>)["order id"] || "").trim())
    .filter(Boolean);

  console.log(`Order rows: ${orderRows.length}, unique orders: ${new Set(orderIds).size}`);

  const { client, marketplaceIds } = await loadSpApiClient(ACCOUNT_ID);
  const dates = await fetchPurchaseDatesByOrderId({ client, marketplaceIds, orderIds });
  console.log(`Purchase dates fetched: ${dates.size}`);

  let stamped = 0;
  let alreadyHad = 0;
  let missing = 0;
  const updates: Array<{ id: string; raw_row: Record<string, unknown> }> = [];

  for (const row of orderRows) {
    const raw = { ...((row.raw_row || {}) as Record<string, unknown>) };
    const orderId = String(raw["order id"] || "").trim();
    const existing = String(raw["purchase date"] || "").slice(0, 10);
    if (/^\d{4}-\d{2}-\d{2}$/.test(existing)) {
      alreadyHad += 1;
      continue;
    }
    const purchase = orderId ? dates.get(orderId) : null;
    if (!purchase) {
      missing += 1;
      continue;
    }
    raw["purchase date"] = purchase;
    updates.push({ id: String(row.id), raw_row: raw });
    stamped += 1;
  }

  console.log({ stamped, alreadyHad, missing });

  for (let i = 0; i < updates.length; i += 50) {
    const chunk = updates.slice(i, i + 50);
    await Promise.all(
      chunk.map((u) => admin.from("report_transactions").update({ raw_row: u.raw_row }).eq("id", u.id))
    );
    process.stdout.write(`updated ${Math.min(i + chunk.length, updates.length)}/${updates.length}\r`);
  }
  console.log("\nStamped. Refreshing inventory facts…");

  const { data: refreshed, error: refreshError } = await admin.rpc("refresh_inventory_sales_facts", {
    p_account_id: ACCOUNT_ID,
  });
  if (refreshError) throw refreshError;
  console.log("Facts rows:", refreshed);

  const { data: dayFacts } = await admin
    .from("inventory_sales_facts_cache")
    .select("sale_date, qty, platform")
    .eq("account_id", ACCOUNT_ID)
    .gte("sale_date", FROM)
    .lte("sale_date", TO);

  const byDate = new Map<string, number>();
  for (const r of dayFacts || []) {
    if (!String(r.platform || "").toLowerCase().startsWith("amazon")) continue;
    const d = String(r.sale_date);
    byDate.set(d, (byDate.get(d) || 0) + Number(r.qty || 0));
  }
  console.log("Amazon qty by sale_date (purchase date when stamped):");
  for (const d of Array.from(byDate.keys()).sort()) {
    console.log(`  ${d}: ${byDate.get(d)}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
