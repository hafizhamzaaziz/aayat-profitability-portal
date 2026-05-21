import * as XLSX from "xlsx";
import { readFileSync } from "node:fs";
const buf = readFileSync("/Users/hamzaaziz/Downloads/Product Ads_Product data details2026-04-29 11_23_All store product data_2026-03-01-2026-03-31.xlsx");
const wb = XLSX.read(buf, { type: "buffer" });
for (const name of wb.SheetNames) {
  console.log("=== Sheet:", name, "===");
  const ws = wb.Sheets[name];
  const aoa = XLSX.utils.sheet_to_json(ws, { header: 1, defval: "" });
  console.log("Total rows:", aoa.length);
  for (let i = 0; i < aoa.length; i += 1) {
    console.log(i, JSON.stringify(aoa[i]));
  }
}
