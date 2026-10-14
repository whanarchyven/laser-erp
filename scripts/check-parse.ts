import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parseLxds } from "../convex/lib/parseLxds";
import { planSheetRuns } from "../convex/lib/sheets";

const dir = process.argv[2] ?? ".";
for (const name of readdirSync(dir).filter((n) => n.toLowerCase().endsWith(".lxds"))) {
  const parsed = parseLxds(new Uint8Array(readFileSync(join(dir, name))), name);
  const runs = planSheetRuns(parsed.sheets, parsed.parts);
  console.log(`\n${name}: ${parsed.kind}, деталей ${parsed.parts.length}, листов ${runs.length}`);
  runs.forEach((run, i) => {
    const sum = [...run.parts.values()].reduce((a, b) => a + b, 0);
    console.log(`  проход ${i + 1} (лист ${run.sheetIndex}, ${run.exact ? "точно" : "оценка"}): ${sum} шт`);
  });
}
