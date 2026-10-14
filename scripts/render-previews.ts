import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { parseLxds } from "../convex/lib/parseLxds";

const file = process.argv[2];
const out = process.argv[3] ?? "tmp/previews";
if (!file) throw new Error("usage: render-previews <file.lxds> [outDir]");
mkdirSync(out, { recursive: true });
const parsed = parseLxds(new Uint8Array(readFileSync(file)), basename(file));
const cells: string[] = [];
for (const [index, d] of parsed.drawings.sheets) {
  console.log(`лист ${index}: ${d.width}x${d.height}, рез ${(d.cutLengthMm / 1000).toFixed(1)} м, пробивок ${d.pierces}, svg ${d.svg.length} б`);
  writeFileSync(join(out, `sheet-${index}.svg`), d.svg);
  cells.push(`<figure><img src="sheet-${index}.svg" style="height:420px"><figcaption>Лист ${index}</figcaption></figure>`);
}
parsed.parts.forEach((part, i) => {
  const d = parsed.drawings.parts.get(part.cadName);
  if (!d) {
    console.log(`деталь ${part.cadName}: нет геометрии`);
    return;
  }
  console.log(`деталь ${part.cadName}: ${d.width}x${d.height}, рез ${(d.cutLengthMm / 1000).toFixed(2)} м, пробивок ${d.pierces}`);
  writeFileSync(join(out, `part-${i}.svg`), d.svg);
  cells.push(`<figure><img src="part-${i}.svg" style="height:200px;max-width:300px"><figcaption>${part.cadName}</figcaption></figure>`);
});
writeFileSync(
  join(out, "index.html"),
  `<meta charset="utf-8"><body style="display:flex;flex-wrap:wrap;gap:12px;font:12px sans-serif">${cells.join("")}</body>`,
);
