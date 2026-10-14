import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { ConvexHttpClient } from "convex/browser";
import { anyApi } from "convex/server";

const client = new ConvexHttpClient("http://127.0.0.1:3210");
const [path, title, machineId = "laser-stand"] = process.argv.slice(2);
const fileName = basename(path);
const uploadUrl = await client.mutation(anyApi.presets.generateUploadUrl, {});
const posted = await fetch(uploadUrl, { method: "POST", body: readFileSync(path) });
const { storageId } = await posted.json();
const preview = await client.action(anyApi.presets.inspect, { fileId: storageId, fileName });
console.log(`${preview.kind}: ${preview.lines.length} строк, листов ${preview.sheetCount}`);
console.log(preview.sheets.map((s) => `лист ${s.index}: ${s.parts ? s.parts.map((p) => `${p.cadName}×${p.qty}`).join(", ") : "состав неизвестен"}`).join("\n"));
const missing = preview.lines.filter((line) => !line.nomenclatureId);
if (missing.length > 0) {
  console.log("без карточек:", missing.map((line) => line.cadName).join(", "));
  process.exit(1);
}
const saved = await client.mutation(anyApi.presets.save, {
  title: title ?? fileName.replace(/\.lxds$/i, ""),
  fileName,
  fileId: storageId,
  sha256: preview.sha256,
  thicknessMm: preview.thicknessMm ?? undefined,
  sheets: preview.sheets,
  lines: preview.lines.map((line) => ({ cadName: line.cadName, qty: line.qty, nomenclatureId: line.nomenclatureId })),
  enqueue: true,
  machineId,
});
console.log(saved);
