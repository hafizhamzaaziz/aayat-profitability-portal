import * as XLSX from "xlsx";
import * as fs from "node:fs";

const path = process.argv[2];
if (!path) {
  console.error("Usage: inspect-temu.mts <file.xlsx>");
  process.exit(1);
}

const buffer = fs.readFileSync(path);
const wb = XLSX.read(buffer, { type: "buffer" });

console.log("Sheets:", wb.SheetNames);

for (const sheetName of wb.SheetNames) {
  const ws = wb.Sheets[sheetName];
  const aoa = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, defval: "" }) as unknown[][];
  console.log("\n=== Sheet:", sheetName, "rows:", aoa.length, "===");
  // Print first 30 rows.
  for (let i = 0; i < Math.min(40, aoa.length); i++) {
    const row = aoa[i] as unknown[];
    const truncated = row.map((c) => {
      const s = c == null ? "" : String(c);
      return s.length > 60 ? `${s.slice(0, 60)}…` : s;
    });
    console.log(`row${i}:`, JSON.stringify(truncated));
  }
}
