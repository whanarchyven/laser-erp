import type { MutationCtx } from "../_generated/server";
import type { Doc } from "../_generated/dataModel";
import { cadKey } from "./cad";
import { planSheetRuns, sheetRunCount } from "./sheets";
import type { SheetRun } from "./sheets";

export async function applySheetRuns(
  ctx: MutationCtx,
  job: Doc<"jobs">,
  runs: number,
  options: {
    source: "agent" | "operator";
    at: number;
    durations?: number[];
    sheetIndex?: number;
  },
): Promise<{ sheetsDone: number; sheetsTotal: number }> {
  const preset = await ctx.db.get(job.presetId);
  const sheets = preset?.sheets ?? [];
  const lines = await ctx.db
    .query("jobLines")
    .withIndex("by_job", (q) => q.eq("jobId", job._id))
    .take(200);
  const history = await ctx.db
    .query("cutRuns")
    .withIndex("by_job", (q) => q.eq("jobId", job._id))
    .take(500);
  const sheetsTotal = Math.max(1, sheetRunCount(sheets));
  const before = Math.min(job.sheetsDone ?? 0, sheetsTotal);
  const want = Math.min(Math.max(0, Math.floor(runs)), sheetsTotal - before);
  if (want === 0) return { sheetsDone: before, sheetsTotal };

  const plan = planSheetRuns(
    sheets,
    lines.map((line) => ({ cadName: line.cadName, qty: line.qtyPlanned })),
  );
  const used = new Map<number, number>();
  for (const run of history) used.set(run.sheetIndex, (used.get(run.sheetIndex) ?? 0) + 1);
  const tracked: SheetRun[] = [];
  for (const run of plan) {
    const count = used.get(run.sheetIndex) ?? 0;
    if (count > 0) used.set(run.sheetIndex, count - 1);
    else tracked.push(run);
  }
  const untracked = Math.max(0, before - history.length);
  const applied =
    options.sheetIndex === undefined
      ? tracked.slice(untracked, untracked + want)
      : tracked.filter((run) => run.sheetIndex === options.sheetIndex).slice(0, want);
  if (applied.length === 0) return { sheetsDone: before, sheetsTotal };
  const after = before + applied.length;

  const added = new Map<string, number>();
  for (const run of applied) {
    for (const [key, qty] of run.parts) added.set(key, (added.get(key) ?? 0) + qty);
  }
  const finished = after >= sheetsTotal;
  for (const line of lines) {
    const extra = added.get(cadKey(line.cadName)) ?? 0;
    const qtyDone = finished
      ? line.qtyPlanned
      : Math.min(line.qtyPlanned, line.qtyDone + extra);
    if (qtyDone !== line.qtyDone) await ctx.db.patch(line._id, { qtyDone });
  }

  const durations = options.durations ?? [];
  for (const [i, run] of applied.entries()) {
    const sheet = sheets.find((s) => s.index === run.sheetIndex);
    const durationSec = durations.length === applied.length ? durations[i] : undefined;
    await ctx.db.insert("cutRuns", {
      jobId: job._id,
      machineId: job.machineId ?? "",
      sheetIndex: run.sheetIndex,
      cutLengthMm: sheet?.cutLengthMm,
      pierces: sheet?.pierces,
      durationSec,
      source: options.source,
      at: options.at,
    });
  }

  await ctx.db.patch(job._id, {
    sheetsDone: after,
    status: finished ? "done" : "in_progress",
  });
  return { sheetsDone: after, sheetsTotal };
}
