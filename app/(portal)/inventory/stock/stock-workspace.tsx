"use client";

import Link from "next/link";
import { useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { InventoryWorkspace } from "@/lib/inventory/workspace";
import { formatUkDate } from "@/lib/utils/date";
import { dedupeStockCountRows, mergedStockMessage, type StockCountRow } from "@/lib/inventory/stock-csv";
import { recordStockTake, refreshFbaStock, updateSkuPlanning, bulkUpdateSkuPlanning } from "../actions";
import { inventoryHref } from "../_components/inventory-shell";
import { Card, EmptyState, Kpi, Notice, SortHeader, BusyOverlay, ProductCell, btn, fmtInt, inputSm, td, th, useMoney } from "../_components/ui";

type Mode = "view" | "count";
type StockSort = "product" | "fba" | "transit" | "wh" | "onOrder" | "draft" | "value" | "count";

export default function StockWorkspace({ workspace, accountId, canEdit }: { workspace: InventoryWorkspace; accountId: string; canEdit: boolean }) {
  const router = useRouter();
  const money = useMoney(workspace.currency);
  const [pending, startTransition] = useTransition();
  const [notice, setNotice] = useState<{ kind: "ok" | "error" | "info"; text: string } | null>(null);
  const [mode, setMode] = useState<Mode>("view");
  const [search, setSearch] = useState("");
  const [onlyDrift, setOnlyDrift] = useState(false);
  const [countDate, setCountDate] = useState(workspace.today);
  const [countNotes, setCountNotes] = useState("");
  const [counts, setCounts] = useState<Record<string, { fba: string; wh: string }>>({});
  const [stockSort, setStockSort] = useState<{ key: StockSort; dir: "asc" | "desc" }>({ key: "product", dir: "asc" });
  const fileRef = useRef<HTMLInputElement>(null);

  const skuById = useMemo(() => new Map(workspace.skus.map((s) => [s.mappingId, s])), [workspace.skus]);
  const rowById = useMemo(() => new Map(workspace.rows.map((r) => [r.mappingId, r])), [workspace.rows]);

  const stockRows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return workspace.skus
      .filter((s) => {
        if (q && !`${s.productName} ${s.amazonSku || ""} ${s.asin || ""} ${s.temuSkuId || ""} ${s.tiktokSku || ""}`.toLowerCase().includes(q)) return false;
        if (onlyDrift) {
          const drift = (s.warehouseRaw != null && s.warehouseRaw < 0) || (s.fbaRaw != null && s.fbaRaw < 0 && s.fbaSource !== "live");
          if (!drift) return false;
        }
        return true;
      })
      .map((s) => ({ sku: s, row: rowById.get(s.mappingId)! }))
      .sort((a, b) => {
        const dir = stockSort.dir === "asc" ? 1 : -1;
        const num = (v: number | null | undefined) => (v == null ? null : v);
        const pick = (side: typeof a): string | number | null => {
          switch (stockSort.key) {
            case "product":
              return side.sku.productName.toLowerCase();
            case "fba":
              return num(side.row.fbaOnHand);
            case "transit":
              return side.row.fbaInTransit;
            case "wh":
              return num(side.row.warehouseOnHand);
            case "onOrder":
              return side.row.onOrder;
            case "draft":
              return side.row.plannedToFba;
            case "value":
              return side.row.stockValue;
            case "count":
              return side.sku.baselineDate || null;
          }
        };
        const av = pick(a);
        const bv = pick(b);
        if (av == null && bv == null) return a.sku.productName.localeCompare(b.sku.productName);
        if (av == null) return 1;
        if (bv == null) return -1;
        if (typeof av === "number" && typeof bv === "number") return (av - bv) * dir;
        return String(av).localeCompare(String(bv)) * dir;
      });
  }, [workspace.skus, rowById, search, onlyDrift, stockSort]);

  const totals = useMemo(() => {
    let fba = 0, transit = 0, wh = 0, onOrder = 0, value = 0, uncounted = 0, drift = 0;
    for (const r of workspace.rows) {
      fba += r.fbaOnHand || 0;
      transit += r.fbaInTransit;
      wh += r.warehouseOnHand || 0;
      onOrder += r.onOrder;
      value += r.stockValue;
      const s = skuById.get(r.mappingId);
      if (s && s.isPlanned && s.fbaSource === "none" && s.warehouseSource === "none") uncounted += 1;
      if (s && ((s.warehouseRaw != null && s.warehouseRaw < 0) || (s.fbaRaw != null && s.fbaRaw < 0 && s.fbaSource !== "live"))) drift += 1;
    }
    return { fba, transit, wh, onOrder, value, uncounted, drift };
  }, [workspace.rows, skuById]);

  function startCount() {
    const init: Record<string, { fba: string; wh: string }> = {};
    for (const s of workspace.skus) {
      const r = rowById.get(s.mappingId);
      init[s.mappingId] = { fba: r?.fbaOnHand == null ? "" : String(r.fbaOnHand), wh: r?.warehouseOnHand == null ? "" : String(r.warehouseOnHand) };
    }
    setCounts(init);
    setMode("count");
  }

  function saveCount() {
    const entries = workspace.skus
      .map((s) => {
        const c = counts[s.mappingId];
        if (!c) return null;
        const r = rowById.get(s.mappingId);
        const fbaChanged = c.fba !== (r?.fbaOnHand == null ? "" : String(r.fbaOnHand));
        const whChanged = c.wh !== (r?.warehouseOnHand == null ? "" : String(r.warehouseOnHand));
        if (!fbaChanged && !whChanged) return null;
        if (c.fba === "" && c.wh === "") return null;
        return { mappingId: s.mappingId, fbaUnits: Number(c.fba) || (fbaChanged ? 0 : r?.fbaOnHand || 0), warehouseUnits: Number(c.wh) || (whChanged ? 0 : r?.warehouseOnHand || 0) };
      })
      .filter((e): e is { mappingId: string; fbaUnits: number; warehouseUnits: number } => !!e);
    if (entries.length === 0) {
      setNotice({ kind: "info", text: "No counts were changed." });
      setMode("view");
      return;
    }
    if (!countNotes.trim()) {
      setNotice({ kind: "error", text: "Add a reason for this stock take." });
      return;
    }
    startTransition(async () => {
      const res = await recordStockTake(accountId, { date: countDate, entries, notes: countNotes || null });
      if (!res.ok) setNotice({ kind: "error", text: res.error });
      else {
        setNotice({ kind: "ok", text: `Stock take saved for ${res.data?.saved} SKU${res.data?.saved === 1 ? "" : "s"}. The planner now works forward from these counts.` });
        setMode("view");
        setCountNotes("");
      }
      router.refresh();
    });
  }

  function refreshFba() {
    startTransition(async () => {
      const res = await refreshFbaStock(accountId);
      if (!res.ok) setNotice({ kind: "error", text: res.error });
      else setNotice({ kind: "ok", text: `Live FBA stock refreshed for ${"skus" in (res.data || {}) ? (res.data as { skus: number }).skus : 0} SKUs.` });
      router.refresh();
    });
  }

  function exportCsv() {
    const packName = new Map(workspace.packProfiles.map((p) => [p.id, p.profileName]));
    const head = ["Product ID", "Amazon SKU", "Product", "ASIN", "FBA units", "3PL units", "Carton"];
    const seen = new Set<string>();
    const lines: Array<Array<string | number>> = [];
    for (const { sku, row } of stockRows) {
      if (seen.has(sku.mappingId)) continue;
      seen.add(sku.mappingId);
      lines.push([
        sku.mappingId,
        sku.amazonSku || sku.temuSkuId || sku.tiktokSku || "",
        sku.productName,
        sku.asin || "",
        row.fbaOnHand ?? "",
        row.warehouseOnHand ?? "",
        sku.defaultPackProfileId ? packName.get(sku.defaultPackProfileId) || "" : "",
      ]);
    }
    const csv = [head, ...lines].map((r) => r.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(",")).join("\n");
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
    a.download = `stock-${workspace.today}.csv`;
    a.click();
  }

  function toggleStock(key: StockSort) {
    setStockSort((s) => (s.key === key ? { key, dir: s.dir === "asc" ? "desc" : "asc" } : { key, dir: key === "product" || key === "count" ? "asc" : "desc" }));
  }

  function saveEntries(entries: Array<{ mappingId: string; fbaUnits: number; warehouseUnits: number }>, note: string, okText: string) {
    if (entries.length === 0) {
      setNotice({ kind: "info", text: "Nothing to save." });
      return;
    }
    startTransition(async () => {
      try {
        const res = await recordStockTake(accountId, { date: workspace.today, entries, notes: note });
        if (!res.ok) {
          setNotice({ kind: "error", text: res.error });
          return;
        }
        setNotice({ kind: "ok", text: okText });
        setMode("view");
        router.refresh();
      } catch (err) {
        setNotice({ kind: "error", text: err instanceof Error && err.message ? err.message : "Could not save the stock take." });
      }
    });
  }

  function setCarton(mappingId: string, packId: string) {
    startTransition(async () => {
      const res = await updateSkuPlanning(accountId, mappingId, { defaultPackProfileId: packId || null });
      if (!res.ok) setNotice({ kind: "error", text: res.error });
      else router.refresh();
    });
  }

  function zeroAll3pl() {
    if (!confirm("Set 3PL stock to 0 for every SKU, as of today? FBA numbers stay as they are. This is the fresh starting count.")) return;
    const entries = workspace.skus.map((s) => ({
      mappingId: s.mappingId,
      fbaUnits: rowById.get(s.mappingId)?.fbaOnHand ?? 0,
      warehouseUnits: 0,
    }));
    saveEntries(entries, "Starting 3PL count set to 0", `3PL stock set to 0 for ${entries.length.toLocaleString("en-GB")} SKUs.`);
  }

  async function uploadCounts(file: File) {
    const text = await file.text();
    const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    if (lines.length < 2) {
      setNotice({ kind: "error", text: "The file needs a header row and at least one SKU." });
      return;
    }
    const cells = (line: string) => {
      const out: string[] = [];
      let cur = "";
      let quoted = false;
      for (const ch of line) {
        if (ch === '"') quoted = !quoted;
        else if (ch === "," && !quoted) {
          out.push(cur.trim());
          cur = "";
        } else cur += ch;
      }
      out.push(cur.trim());
      return out;
    };
    const header = cells(lines[0]).map((h) => h.toLowerCase());
    const idIdx = header.findIndex((h) => h === "product id" || h === "mapping id");
    const skuIdx = header.findIndex((h) => h === "amazon sku" || h === "sku" || (h.includes("sku") && !h.includes("product")));
    const whIdx = header.findIndex((h) => h.includes("3pl") || h.includes("warehouse"));
    const fbaIdx = header.findIndex((h) => h.includes("fba"));
    const cartonIdx = header.findIndex((h) => h.includes("carton") || h.includes("box"));
    if ((skuIdx < 0 && idIdx < 0) || whIdx < 0) {
      setNotice({ kind: "error", text: "Use columns Amazon SKU (or Product ID) and 3PL units. Download the CSV first and edit that." });
      return;
    }
    const knownIds = new Set(workspace.skus.map((s) => s.mappingId));
    const labelById = new Map(workspace.skus.map((s) => [s.mappingId, s.productName || s.amazonSku || s.temuSkuId || s.tiktokSku || s.mappingId]));
    const skuIndex = new Map<string, string[]>();
    for (const s of workspace.skus) {
      for (const key of [s.amazonSku, s.temuSkuId, s.tiktokSku]) {
        const norm = String(key || "").trim().toUpperCase();
        if (!norm) continue;
        const list = skuIndex.get(norm) || [];
        if (!list.includes(s.mappingId)) list.push(s.mappingId);
        skuIndex.set(norm, list);
      }
    }
    const parsed: StockCountRow[] = [];
    const missing: string[] = [];
    const ambiguous: string[] = [];
    for (const line of lines.slice(1)) {
      const cols = cells(line);
      const productId = idIdx >= 0 ? String(cols[idIdx] || "").trim() : "";
      const sku = skuIdx >= 0 ? String(cols[skuIdx] || "").trim() : "";
      if (!productId && !sku) continue;
      let mappingId = "";
      if (productId && knownIds.has(productId)) mappingId = productId;
      else if (productId) {
        missing.push(sku || productId);
        continue;
      } else {
        const hits = skuIndex.get(sku.toUpperCase()) || [];
        if (hits.length === 1) mappingId = hits[0];
        else if (hits.length > 1) {
          ambiguous.push(sku);
          continue;
        } else {
          missing.push(sku);
          continue;
        }
      }
      const current = rowById.get(mappingId);
      const warehouseUnits = Number(cols[whIdx]);
      const fbaUnits = fbaIdx >= 0 && cols[fbaIdx] !== "" ? Number(cols[fbaIdx]) : current?.fbaOnHand ?? 0;
      if (!Number.isFinite(warehouseUnits) || warehouseUnits < 0) continue;
      parsed.push({
        mappingId,
        label: sku || labelById.get(mappingId) || mappingId,
        fbaUnits: Number.isFinite(fbaUnits) ? Math.max(0, fbaUnits) : 0,
        warehouseUnits,
        carton: cartonIdx >= 0 ? String(cols[cartonIdx] || "").trim() || null : null,
      });
    }
    if (ambiguous.length) {
      const shown = [...new Set(ambiguous)].slice(0, 12).join(", ");
      setNotice({
        kind: "error",
        text: `These SKUs match more than one product, so nothing was saved: ${shown}. Download a fresh CSV (each row has a product id) and upload that file.`,
      });
      return;
    }
    const deduped = dedupeStockCountRows(parsed);
    if (deduped.error) {
      setNotice({ kind: "error", text: deduped.error });
      return;
    }
    const packByName = new Map(workspace.packProfiles.map((p) => [p.profileName.trim().toLowerCase(), p.id]));
    const entries = deduped.rows.map((row) => ({ mappingId: row.mappingId, fbaUnits: row.fbaUnits, warehouseUnits: row.warehouseUnits }));
    const packs: Array<{ mappingId: string; defaultPackProfileId: string | null }> = [];
    const unknownCartons = new Set<string>();
    if (cartonIdx >= 0) {
      for (const row of deduped.rows) {
        const raw = (row.carton || "").trim();
        if (!raw) continue;
        const key = raw.toLowerCase();
        if (key === "none" || key === "-") packs.push({ mappingId: row.mappingId, defaultPackProfileId: null });
        else {
          const packId = packByName.get(key);
          if (!packId) unknownCartons.add(raw);
          else packs.push({ mappingId: row.mappingId, defaultPackProfileId: packId });
        }
      }
    }
    if (entries.length === 0 && packs.length === 0) {
      setNotice({ kind: "error", text: missing.length ? `No rows matched a product. First unknown: ${missing[0]}.` : "No usable rows in the file." });
      return;
    }
    const merged = mergedStockMessage(deduped.mergedLabels);
    const extra = [
      merged || "",
      missing.length ? `${missing.length} SKUs were not recognised.` : "",
      unknownCartons.size ? `Unknown carton: ${Array.from(unknownCartons).slice(0, 3).join(", ")}. Create it under Inventory → Settings → Carton profiles.` : "",
    ].filter(Boolean).join(" ");
    startTransition(async () => {
      try {
        if (entries.length) {
          const res = await recordStockTake(accountId, { date: workspace.today, entries, notes: "Counts uploaded from CSV" });
          if (!res.ok) {
            setNotice({ kind: "error", text: res.error });
            return;
          }
        }
        if (packs.length) {
          const res = await bulkUpdateSkuPlanning(accountId, packs);
          if (!res.ok) {
            setNotice({ kind: "error", text: entries.length ? `Stock counts were saved, but carton sizes were not: ${res.error}` : res.error });
            if (entries.length) router.refresh();
            return;
          }
        }
        setNotice({
          kind: "ok",
          text: `Saved ${entries.length.toLocaleString("en-GB")} stock row${entries.length === 1 ? "" : "s"}${packs.length ? ` and ${packs.length.toLocaleString("en-GB")} carton${packs.length === 1 ? "" : "s"}` : ""}.${extra ? ` ${extra}` : ""}`,
        });
        setMode("view");
        router.refresh();
      } catch (err) {
        setNotice({ kind: "error", text: err instanceof Error && err.message ? err.message : "Could not save the stock take." });
      }
    });
  }

  return (
    <div className="space-y-4">
      <BusyOverlay show={pending} label="Saving stock…" />
      {notice ? <Notice kind={notice.kind}>{notice.text}</Notice> : null}

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <Kpi label="FBA on hand" value={fmtInt(totals.fba)} hint={workspace.fbaLive.fresh ? `live · ${workspace.fbaLive.snapshotAt ? new Date(workspace.fbaLive.snapshotAt).toLocaleString("en-GB", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }) : ""}` : "from stock takes + logged sales"} />
        <Kpi label="In transit to FBA" value={fmtInt(totals.transit)} hint="shipped, not yet checked in" href={inventoryHref("/inventory/fba-shipments", accountId)} />
        <Kpi label="3PL on hand" value={fmtInt(totals.wh)} hint={workspace.warehouses.map((w) => w.name).join(", ") || "no warehouse yet"} />
        <Kpi label="On order" value={fmtInt(totals.onOrder)} hint="open purchase orders" href={inventoryHref("/inventory/purchase-orders", accountId)} />
        <Kpi label="Stock value" value={money(totals.value)} hint="at current COGS, excl. VAT" />
        <Kpi label="Needs attention" value={fmtInt(totals.uncounted + totals.drift)} hint={`${totals.uncounted} never counted · ${totals.drift} drifted below zero`} tone={totals.uncounted + totals.drift > 0 ? "warn" : "good"} />
      </div>

      <Card
        title={mode === "count" ? "Stock take" : "Stock by location"}
        subtitle={
          mode === "count"
            ? "Type the physical counts. Only rows you change are saved. 3PL is the warehouse. FBA stays manual until Amazon grants the Fulfillment role."
            : "3PL stock is the same Amazon SKU as COGS. Set the carton on each row, or put the carton name in the CSV. New box sizes are created under Inventory → Settings → Carton profiles."
        }
        actions={
          mode === "count" ? (
            <>
              <input type="date" value={countDate} onChange={(e) => setCountDate(e.target.value)} className={inputSm} style={{ width: 150 }} />
              <input value={countNotes} onChange={(e) => setCountNotes(e.target.value)} placeholder="Why are these counts changing?" className={inputSm} style={{ width: 240 }} />
              <button type="button" className={btn.small} onClick={() => { setCounts((c) => { const next = { ...c }; for (const s of workspace.skus) next[s.mappingId] = { fba: next[s.mappingId]?.fba ?? "", wh: "0" }; return next; }); }}>Fill 3PL with 0</button>
              <button type="button" className={btn.small} onClick={() => setMode("view")} disabled={pending}>Cancel</button>
              <button type="button" className={btn.smallPrimary} onClick={saveCount} disabled={pending}>{pending ? "Saving…" : "Save stock take"}</button>
            </>
          ) : (
            <>
              <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search…" className={inputSm} style={{ width: 180 }} />
              <label className="flex items-center gap-1 text-xs text-slate-600"><input type="checkbox" checked={onlyDrift} onChange={(e) => setOnlyDrift(e.target.checked)} /> drifted only</label>
              <button type="button" className={btn.small} onClick={exportCsv}>Download CSV</button>
              {canEdit ? <button type="button" className={btn.small} onClick={() => fileRef.current?.click()} disabled={pending}>Upload counts</button> : null}
              {canEdit ? <button type="button" className={btn.small} onClick={refreshFba} disabled={pending}>Refresh FBA</button> : null}
              {canEdit ? <button type="button" className={btn.small} onClick={zeroAll3pl} disabled={pending}>Set all 3PL to 0</button> : null}
              {canEdit ? <button type="button" className={btn.smallPrimary} onClick={startCount}>Edit counts</button> : null}
              <input ref={fileRef} type="file" accept=".csv,text/csv" className="hidden" onChange={(e) => { const file = e.target.files?.[0]; e.target.value = ""; if (file) void uploadCounts(file); }} />
            </>
          )
        }
      >
        {stockRows.length === 0 ? (
          <EmptyState>No SKUs match.</EmptyState>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead>
                <tr className="bg-slate-50">
                  <SortHeader label="Product" active={stockSort.key === "product"} dir={stockSort.dir} onClick={() => toggleStock("product")} />
                  <SortHeader label="FBA" align="right" active={stockSort.key === "fba"} dir={stockSort.dir} onClick={() => toggleStock("fba")} />
                  <SortHeader label="In transit" align="right" active={stockSort.key === "transit"} dir={stockSort.dir} onClick={() => toggleStock("transit")} />
                  <SortHeader label="3PL" align="right" active={stockSort.key === "wh"} dir={stockSort.dir} onClick={() => toggleStock("wh")} />
                  <th className={th()}>Carton</th>
                  <SortHeader label="On order" align="right" active={stockSort.key === "onOrder"} dir={stockSort.dir} onClick={() => toggleStock("onOrder")} />
                  <SortHeader label="Draft to FBA" align="right" active={stockSort.key === "draft"} dir={stockSort.dir} onClick={() => toggleStock("draft")} />
                  <SortHeader label="Value" align="right" active={stockSort.key === "value"} dir={stockSort.dir} onClick={() => toggleStock("value")} />
                  <SortHeader label="Last count" active={stockSort.key === "count"} dir={stockSort.dir} onClick={() => toggleStock("count")} />
                </tr>
              </thead>
              <tbody>
                {stockRows.map(({ sku, row }) => {
                  const whDrift = sku.warehouseRaw != null && sku.warehouseRaw < 0;
                  const fbaDrift = sku.fbaRaw != null && sku.fbaRaw < 0 && sku.fbaSource !== "live";
                  const c = counts[sku.mappingId];
                  return (
                    <tr key={sku.mappingId} className={`border-t border-slate-100 ${!sku.isPlanned ? "opacity-60" : ""}`}>
                      <td className={td()}>
                        <ProductCell productName={sku.productName} amazonSku={sku.amazonSku} asin={sku.asin} temuSkuId={sku.temuSkuId} tiktokSku={sku.tiktokSku} extra={!sku.isPlanned ? <span className="block text-xs text-slate-400">excluded from planning</span> : null} />
                      </td>
                      <td className={td("text-right")}>
                        {mode === "count" ? (
                          <input value={c?.fba ?? ""} onChange={(e) => setCounts({ ...counts, [sku.mappingId]: { ...c, fba: e.target.value, wh: c?.wh ?? "" } })} className={`${inputSm} w-24 text-right`} inputMode="numeric" disabled={sku.fbaSource === "live"} title={sku.fbaSource === "live" ? "Live from Amazon — not editable" : ""} />
                        ) : (
                          <>
                            <span className={fbaDrift ? "font-semibold text-rose-700" : ""}>{row.fbaOnHand == null ? <span className="text-slate-400">—</span> : fmtInt(row.fbaOnHand)}</span>
                            <span className="block text-[11px] text-slate-400">{sku.fbaSource === "live" ? "live" : sku.fbaSource === "count" ? (fbaDrift ? `drift ${sku.fbaRaw}` : "count") : "no count"}</span>
                          </>
                        )}
                      </td>
                      <td className={td("text-right")}>{row.fbaInTransit ? fmtInt(row.fbaInTransit) : <span className="text-slate-300">0</span>}</td>
                      <td className={td("text-right")}>
                        {mode === "count" ? (
                          <input value={c?.wh ?? ""} onChange={(e) => setCounts({ ...counts, [sku.mappingId]: { ...c, wh: e.target.value, fba: c?.fba ?? "" } })} className={`${inputSm} w-24 text-right`} inputMode="numeric" />
                        ) : (
                          <>
                            <span className={whDrift ? "font-semibold text-rose-700" : ""}>{row.warehouseOnHand == null ? <span className="text-slate-400">—</span> : fmtInt(row.warehouseOnHand)}</span>
                            {whDrift ? <span className="block text-[11px] text-rose-600">drift {sku.warehouseRaw}</span> : null}
                            {!whDrift && sku.unitsPerBox && row.warehouseOnHand ? <span className="block text-[11px] text-slate-400">{Math.ceil(row.warehouseOnHand / sku.unitsPerBox)} boxes</span> : null}
                          </>
                        )}
                      </td>
                      <td className={td()}>
                        {workspace.packProfiles.length === 0 ? (
                          <Link href={inventoryHref("/inventory/settings", accountId, { tab: "cartons" })} className="text-xs text-plum-700 hover:underline">Add a carton</Link>
                        ) : (
                          <select value={sku.defaultPackProfileId || ""} onChange={(e) => setCarton(sku.mappingId, e.target.value)} className={inputSm} disabled={!canEdit || pending} style={{ minWidth: 150 }}>
                            <option value="">No carton</option>
                            {workspace.packProfiles.map((p) => (
                              <option key={p.id} value={p.id}>{p.profileName} ({p.unitsPerBox}/box)</option>
                            ))}
                          </select>
                        )}
                      </td>
                      <td className={td("text-right")}>{row.onOrder ? fmtInt(row.onOrder) : <span className="text-slate-300">0</span>}</td>
                      <td className={td("text-right")}>{row.plannedToFba ? fmtInt(row.plannedToFba) : <span className="text-slate-300">0</span>}</td>
                      <td className={td("text-right")}>{money(row.stockValue)}</td>
                      <td className={td("text-xs text-slate-500")}>{sku.baselineDate ? formatUkDate(sku.baselineDate) : "never"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

    </div>
  );
}
