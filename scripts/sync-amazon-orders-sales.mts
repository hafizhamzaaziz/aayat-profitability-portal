/**
 * Overlay Amazon inventory facts from Orders API for a date window.
 * Usage: npx tsx scripts/sync-amazon-orders-sales.mts [from] [to] [accountId]
 */
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

function loadEnvLocal() {
  const text = readFileSync(resolve(process.cwd(), ".env.local"), "utf8");
  for (const line of text.split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (!m) continue;
    let val = m[2].trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (!process.env[m[1]]) process.env[m[1]] = val;
  }
}

loadEnvLocal();

async function main() {
  const from = process.argv[2] || "2026-09-16";
  const to = process.argv[3] || from;
  const accountId = process.argv[4] || "e4d1b1d7-2d68-435f-87d1-526ed358edc5";
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) throw new Error("Missing Supabase env");

  const { syncAmazonInventorySalesFromOrders } = await import("../lib/amazon/ingest/orders-sales.ts");
  const admin = createClient(url, serviceKey, { auth: { persistSession: false } });
  console.log(`Syncing Orders API sales ${from} → ${to} for ${accountId}`);
  const result = await syncAmazonInventorySalesFromOrders({ supabase: admin, accountId, from, to });
  console.log(JSON.stringify(result, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
