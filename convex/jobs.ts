import { v } from "convex/values";
import type { Infer } from "convex/values";
import { mutation, query } from "./_generated/server";
import type { QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { jobStatus } from "./schema";
import { applySheetRuns } from "./lib/progress";
import { sheetRunCount } from "./lib/sheets";
import { machineRate, rateValidator } from "./lib/rates";
import { estimateSec } from "./lib/timing";
import { cypcutEstimateValidator } from "./lib/cypcutLog";

const lineView = v.object({
  _id: v.id("jobLines"),
  cadName: v.string(),
  qtyPlanned: v.number(),
  qtyDone: v.number(),
  nomenclatureId: v.union(v.id("nomenclature"), v.null()),
  name: v.union(v.string(), v.null()),
  article: v.union(v.string(), v.null()),
  imageUrl: v.union(v.string(), v.null()),
});

const sheetView = v.object({
  index: v.number(),
  planCount: v.number(),
  width: v.number(),
  height: v.number(),
  previewUrl: v.union(v.string(), v.null()),
  cutLengthMm: v.union(v.number(), v.null()),
  pierces: v.union(v.number(), v.null()),
  estimateSec: v.union(v.number(), v.null()),
  actualSec: v.array(v.number()),
  done: v.number(),
  cypcut: v.union(cypcutEstimateValidator, v.null()),
});

const jobView = v.object({
  _id: v.id("jobs"),
  number: v.string(),
  title: v.string(),
  fileName: v.string(),
  status: jobStatus,
  lastError: v.union(v.string(), v.null()),
  createdAt: v.number(),
  readyCount: v.number(),
  pendingCount: v.number(),
  sheetsDone: v.number(),
  sheetsTotal: v.number(),
  machineId: v.union(v.string(), v.null()),
  lines: v.array(lineView),
  sheets: v.array(sheetView),
  currentSheetIndex: v.union(v.number(), v.null()),
  currentFromCypCut: v.boolean(),
  cypcutDone: v.union(v.array(v.number()), v.null()),
  cypcutLast: v.union(
    v.object({
      sheetIndex: v.union(v.number(), v.null()),
      estimate: cypcutEstimateValidator,
      at: v.number(),
    }),
    v.null(),
  ),
  estimateTotalSec: v.union(v.number(), v.null()),
  estimateLeftSec: v.union(v.number(), v.null()),
  actualTotalSec: v.number(),
  rate: rateValidator,
});

async function viewOf(ctx: QueryCtx, job: Doc<"jobs">) {
  const lines = await ctx.db
    .query("jobLines")
    .withIndex("by_job", (q) => q.eq("jobId", job._id))
    .take(200);
  const views = [];
  for (const line of lines) {
    const card = line.nomenclatureId ? await ctx.db.get(line.nomenclatureId) : null;
    const imageId = card?.imageId ?? line.previewId;
    views.push({
      _id: line._id,
      cadName: line.cadName,
      qtyPlanned: line.qtyPlanned,
      qtyDone: line.qtyDone,
      nomenclatureId: line.nomenclatureId ?? null,
      name: card?.name ?? null,
      article: card?.article ?? null,
      imageUrl: imageId ? await ctx.storage.getUrl(imageId) : null,
    });
  }
  const preset = await ctx.db.get(job.presetId);
  const readyCount = views.filter((line) => line.qtyDone >= line.qtyPlanned).length;

  const rate = await machineRate(ctx, job.machineId);
  const runs = await ctx.db
    .query("cutRuns")
    .withIndex("by_job", (q) => q.eq("jobId", job._id))
    .take(500);
  const estimates = await ctx.db
    .query("cypcutEstimates")
    .withIndex("by_job", (q) => q.eq("jobId", job._id))
    .order("desc")
    .take(200);
  const ordered = [...(preset?.sheets ?? [])].sort((a, b) => a.index - b.index);
  const sheets: Array<Infer<typeof sheetView>> = [];
  let untracked = Math.max(0, (job.sheetsDone ?? 0) - runs.length);
  for (const sheet of ordered) {
    const mine = runs.filter((run) => run.sheetIndex === sheet.index);
    const legacy = Math.min(untracked, Math.max(0, sheet.planCount - mine.length));
    untracked -= legacy;
    const known = sheet.cutLengthMm !== undefined && sheet.pierces !== undefined;
    sheets.push({
      index: sheet.index,
      planCount: sheet.planCount,
      width: sheet.width,
      height: sheet.height,
      previewUrl: sheet.previewId ? await ctx.storage.getUrl(sheet.previewId) : null,
      cutLengthMm: sheet.cutLengthMm ?? null,
      pierces: sheet.pierces ?? null,
      estimateSec: known ? estimateSec(rate, sheet.cutLengthMm ?? 0, sheet.pierces ?? 0) : null,
      actualSec: mine.flatMap((run) => (run.durationSec !== undefined ? [run.durationSec] : [])),
      done: mine.length + legacy,
      cypcut: estimates.find((row) => row.sheetIndex === sheet.index)?.estimate ?? null,
    });
  }
  const sheetsDone = job.sheetsDone ?? 0;
  const allKnown = sheets.length > 0 && sheets.every((sheet) => sheet.estimateSec !== null);
  const sumEstimate = (copies: (sheet: Infer<typeof sheetView>) => number) =>
    sheets.reduce((sum, sheet) => sum + (sheet.estimateSec ?? 0) * copies(sheet), 0);
  const open = job.status !== "done" && job.status !== "cancelled";
  const heartbeat = job.machineId
    ? await ctx.db
        .query("heartbeats")
        .withIndex("by_machine", (q) => q.eq("machineId", job.machineId ?? ""))
        .unique()
    : null;
  const nest = heartbeat?.nest?.programId === job._id ? heartbeat.nest : null;
  const guess = sheets.find((sheet) => sheet.done < sheet.planCount)?.index ?? null;
  return {
    _id: job._id,
    number: job.number,
    title: job.title,
    fileName: job.fileName,
    status: job.status,
    lastError: job.lastError ?? null,
    createdAt: job.createdAt,
    readyCount,
    pendingCount: views.length - readyCount,
    sheetsDone,
    sheetsTotal: Math.max(1, sheetRunCount(preset?.sheets ?? [])),
    machineId: job.machineId ?? null,
    lines: views,
    sheets,
    currentSheetIndex: open ? (nest ? nest.current : guess) : null,
    currentFromCypCut: open && nest !== null && nest.current !== null,
    cypcutDone: open && nest ? nest.done : null,
    cypcutLast: estimates[0]
      ? {
          sheetIndex: estimates[0].sheetIndex ?? null,
          estimate: estimates[0].estimate,
          at: estimates[0].at,
        }
      : null,
    estimateTotalSec: allKnown ? sumEstimate((sheet) => sheet.planCount) : null,
    estimateLeftSec: allKnown && open
      ? sumEstimate((sheet) => Math.max(0, sheet.planCount - sheet.done))
      : null,
    actualTotalSec: runs.reduce((sum, run) => sum + (run.durationSec ?? 0), 0),
    rate,
  };
}

export const list = query({
  args: {},
  returns: v.array(jobView),
  handler: async (ctx) => {
    const jobs = await ctx.db.query("jobs").withIndex("by_created").order("desc").take(50);
    const result = [];
    for (const job of jobs) result.push(await viewOf(ctx, job));
    return result;
  },
});

export const get = query({
  args: { jobId: v.id("jobs") },
  returns: v.union(jobView, v.null()),
  handler: async (ctx, args) => {
    const job = await ctx.db.get(args.jobId);
    if (!job) return null;
    return await viewOf(ctx, job);
  },
});

async function openJob(ctx: QueryCtx, jobId: Id<"jobs">): Promise<Doc<"jobs">> {
  const job = await ctx.db.get(jobId);
  if (!job) throw new Error("Задача не найдена");
  if (job.status === "done" || job.status === "cancelled") {
    throw new Error("Задача уже закрыта");
  }
  return job;
}

export const setQtyDone = mutation({
  args: { lineId: v.id("jobLines"), qtyDone: v.number() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const line = await ctx.db.get(args.lineId);
    if (!line) throw new Error("Строка не найдена");
    const job = await openJob(ctx, line.jobId);
    const qtyDone = Math.max(0, Math.min(args.qtyDone, line.qtyPlanned));
    await ctx.db.patch(args.lineId, { qtyDone });
    if (job.status !== "in_progress") {
      await ctx.db.patch(job._id, { status: "in_progress" });
    }
    return null;
  },
});

export const sheetDone = mutation({
  args: { jobId: v.id("jobs") },
  returns: v.object({ sheetsDone: v.number(), sheetsTotal: v.number() }),
  handler: async (ctx, args) => {
    const job = await openJob(ctx, args.jobId);
    return await applySheetRuns(ctx, job, 1, { source: "operator", at: Date.now() });
  },
});

export const finish = mutation({
  args: { jobId: v.id("jobs") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const job = await ctx.db.get(args.jobId);
    if (!job) throw new Error("Задача не найдена");
    await ctx.db.patch(args.jobId, { status: "done" });
    return null;
  },
});

export const cancel = mutation({
  args: { jobId: v.id("jobs") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const job = await ctx.db.get(args.jobId);
    if (!job) throw new Error("Задача не найдена");
    await ctx.db.patch(args.jobId, { status: "cancelled" });
    return null;
  },
});
