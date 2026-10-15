import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { machineRate, rateValidator } from "./lib/rates";
import { nestValidator } from "./schema";
import { cypcutEstimateValidator, parseCypCutEstimate } from "./lib/cypcutLog";

export const machines = query({
  args: {},
  returns: v.array(
    v.object({
      machineId: v.string(),
      agentVersion: v.string(),
      cypcutRunning: v.boolean(),
      windowTitle: v.string(),
      hostname: v.string(),
      at: v.number(),
      logTail: v.array(v.string()),
      panel: v.array(v.string()),
      screenUrl: v.union(v.string(), v.null()),
      screenAt: v.union(v.number(), v.null()),
      rate: rateValidator,
      nest: v.union(nestValidator, v.null()),
      cypcutEstimate: v.union(cypcutEstimateValidator, v.null()),
      debug: v.array(v.string()),
      machineState: v.union(v.string(), v.null()),
      alarms: v.array(v.string()),
      events: v.array(
        v.object({
          type: v.string(),
          text: v.string(),
          sheetIndex: v.union(v.number(), v.null()),
          at: v.number(),
        }),
      ),
    }),
  ),
  handler: async (ctx) => {
    const rows = await ctx.db.query("heartbeats").withIndex("by_machine").take(50);
    const result = [];
    for (const row of rows) {
      result.push({
        machineId: row.machineId,
        agentVersion: row.agentVersion,
        cypcutRunning: row.cypcutRunning,
        windowTitle: row.windowTitle,
        hostname: row.hostname,
        at: row.at,
        logTail: row.logTail ?? [],
        panel: row.panel ?? [],
        screenUrl: row.screenId ? await ctx.storage.getUrl(row.screenId) : null,
        screenAt: row.screenAt ?? null,
        rate: await machineRate(ctx, row.machineId),
        nest: row.nest ?? null,
        cypcutEstimate: parseCypCutEstimate(row.logTail ?? []),
        debug: row.debug ?? [],
        machineState: row.machineState ?? null,
        alarms: row.alarms ?? [],
        events: (
          await ctx.db
            .query("machineEvents")
            .withIndex("by_machine", (q) => q.eq("machineId", row.machineId))
            .order("desc")
            .take(20)
        ).map((event) => ({
          type: event.type,
          text: event.text,
          sheetIndex: event.sheetIndex ?? null,
          at: event.at,
        })),
      });
    }
    return result;
  },
});

const openStatuses = ["queued", "delivered", "loaded", "in_progress"] as const;

export const removeMachine = mutation({
  args: { machineId: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    let open = 0;
    for (const status of openStatuses) {
      open += (
        await ctx.db
          .query("jobs")
          .withIndex("by_machine_status", (q) => q.eq("machineId", args.machineId).eq("status", status))
          .take(100)
      ).length;
    }
    if (open > 0) {
      throw new Error(`У станка ${open} незакрытых задач. Закройте или отмените их, потом удаляйте станок.`);
    }
    const row = await ctx.db
      .query("heartbeats")
      .withIndex("by_machine", (q) => q.eq("machineId", args.machineId))
      .unique();
    for (const event of await ctx.db
      .query("machineEvents")
      .withIndex("by_machine", (q) => q.eq("machineId", args.machineId))
      .take(500)) {
      await ctx.db.delete(event._id);
    }
    if (!row) return null;
    if (row.screenId) await ctx.storage.delete(row.screenId);
    await ctx.db.delete(row._id);
    return null;
  },
});
