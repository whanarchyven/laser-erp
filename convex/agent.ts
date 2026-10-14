import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";
import type { QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { applySheetRuns } from "./lib/progress";
import { parseDurationSec } from "./lib/timing";
import { nestValidator } from "./schema";
import { parseCypCutEstimate } from "./lib/cypcutLog";

const programValidator = v.object({
  programId: v.id("jobs"),
  programNumber: v.string(),
  title: v.string(),
  status: v.string(),
  fileName: v.string(),
  sha256: v.string(),
  createdAt: v.number(),
});

const agentStatuses = ["queued", "delivered", "loaded", "in_progress", "cancelled"] as const;

async function machineJobs(ctx: QueryCtx, machineId: string): Promise<Doc<"jobs">[]> {
  const jobs: Doc<"jobs">[] = [];
  for (const target of [machineId, undefined]) {
    for (const status of agentStatuses) {
      jobs.push(
        ...(await ctx.db
          .query("jobs")
          .withIndex("by_machine_status", (q) => q.eq("machineId", target).eq("status", status))
          .take(50)),
      );
    }
  }
  return jobs;
}

export const programsForAgent = internalQuery({
  args: { machineId: v.string() },
  returns: v.array(programValidator),
  handler: async (ctx, args) => {
    const jobs = await machineJobs(ctx, args.machineId);
    return jobs
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((job) => ({
        programId: job._id,
        programNumber: job.number,
        title: job.title,
        status: job.status,
        fileName: job.fileName,
        sha256: job.sha256,
        createdAt: job.createdAt,
      }));
  },
});

export const fileForAgent = internalQuery({
  args: { programId: v.id("jobs") },
  returns: v.union(
    v.object({
      fileId: v.id("_storage"),
      fileName: v.string(),
      sha256: v.string(),
    }),
    v.null(),
  ),
  handler: async (ctx, args) => {
    const job = await ctx.db.get(args.programId);
    if (!job) return null;
    return { fileId: job.fileId, fileName: job.fileName, sha256: job.sha256 };
  },
});

export const applyEvents = internalMutation({
  args: {
    events: v.array(
      v.object({
        eventId: v.string(),
        programId: v.optional(v.string()),
        type: v.string(),
        at: v.number(),
        count: v.optional(v.number()),
        detail: v.optional(v.string()),
        sheetIndex: v.optional(v.number()),
      }),
    ),
  },
  returns: v.object({
    accepted: v.array(v.string()),
    duplicates: v.array(v.string()),
  }),
  handler: async (ctx, args) => {
    const accepted: string[] = [];
    const duplicates: string[] = [];
    for (const event of args.events) {
      const seen = await ctx.db
        .query("agentEvents")
        .withIndex("by_event", (q) => q.eq("eventId", event.eventId))
        .unique();
      if (seen) {
        duplicates.push(event.eventId);
        continue;
      }
      let jobId: Id<"jobs"> | undefined;
      if (event.programId) {
        let job: Doc<"jobs"> | null = null;
        try {
          job = await ctx.db.get(event.programId as Id<"jobs">);
        } catch {
          job = null;
        }
        if (job) {
          jobId = job._id;
          const waiting = job.status === "queued" || job.status === "delivered";
          if (event.type === "delivered" && job.status === "queued") {
            await ctx.db.patch(job._id, { status: "delivered" });
          }
          if (event.type === "loaded" && waiting) {
            await ctx.db.patch(job._id, { status: "loaded" });
          }
          if (event.type === "in_progress" && (waiting || job.status === "loaded")) {
            await ctx.db.patch(job._id, { status: "in_progress" });
          }
          if (event.type === "run_started" && job.status !== "cancelled" && job.status !== "done") {
            const estimate = parseCypCutEstimate((event.detail ?? "").split("\n"));
            if (estimate) {
              await ctx.db.insert("cypcutEstimates", {
                jobId: job._id,
                machineId: job.machineId ?? "",
                sheetIndex: event.sheetIndex,
                estimate,
                at: event.at,
              });
            }
            if (job.status !== "in_progress") await ctx.db.patch(job._id, { status: "in_progress" });
          }
          if (event.type === "run_finished" && job.status !== "cancelled" && job.status !== "done") {
            const durations = (event.detail ?? "")
              .split("\n")
              .map((line) => (line.trim() ? parseDurationSec(line) : null))
              .filter((sec): sec is number => sec !== null);
            await applySheetRuns(ctx, job, event.count ?? 1, {
              source: "agent",
              at: event.at,
              durations,
              sheetIndex: event.sheetIndex,
            });
          }
          if (event.type === "failed") {
            await ctx.db.patch(job._id, {
              status: "failed",
              lastError: event.detail ?? "Агент сообщил об ошибке",
            });
          }
        }
      }
      await ctx.db.insert("agentEvents", {
        eventId: event.eventId,
        jobId,
        type: event.type,
        at: event.at,
      });
      accepted.push(event.eventId);
    }
    return { accepted, duplicates };
  },
});

export const recordHeartbeat = internalMutation({
  args: {
    machineId: v.string(),
    agentVersion: v.string(),
    cypcutRunning: v.boolean(),
    windowTitle: v.string(),
    hostname: v.string(),
    at: v.number(),
    logTail: v.optional(v.array(v.string())),
    panel: v.optional(v.array(v.string())),
    nest: v.optional(nestValidator),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("heartbeats")
      .withIndex("by_machine", (q) => q.eq("machineId", args.machineId))
      .unique();
    if (existing) {
      await ctx.db.patch(existing._id, {
        agentVersion: args.agentVersion,
        cypcutRunning: args.cypcutRunning,
        windowTitle: args.windowTitle,
        hostname: args.hostname,
        at: args.at,
        ...(args.logTail ? { logTail: args.logTail } : {}),
        ...(args.panel ? { panel: args.panel } : {}),
        nest: args.nest,
      });
    } else {
      await ctx.db.insert("heartbeats", args);
    }

    const title = args.windowTitle.toLowerCase();
    if (!args.cypcutRunning || title.length === 0) return null;
    const active = (await machineJobs(ctx, args.machineId)).filter(
      (job) => job.status === "queued" || job.status === "delivered",
    );
    for (const job of active) {
      const stem = job.fileName.replace(/\.lxds$/i, "").toLowerCase();
      if (stem.length > 0 && title.includes(stem)) {
        await ctx.db.patch(job._id, { status: "loaded" });
      }
    }
    return null;
  },
});

export const recordScreen = internalMutation({
  args: { machineId: v.string(), screenId: v.id("_storage"), at: v.number() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("heartbeats")
      .withIndex("by_machine", (q) => q.eq("machineId", args.machineId))
      .unique();
    if (!existing) {
      await ctx.storage.delete(args.screenId);
      return null;
    }
    if (existing.screenId) await ctx.storage.delete(existing.screenId);
    await ctx.db.patch(existing._id, { screenId: args.screenId, screenAt: args.at });
    return null;
  },
});
