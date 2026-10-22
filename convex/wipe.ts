import { v } from "convex/values";
import { internalMutation } from "./_generated/server";

const tables = [
  "nomenclature",
  "cadAliases",
  "presets",
  "presetLines",
  "jobs",
  "jobLines",
  "cutRuns",
  "cypcutEstimates",
  "counters",
  "agentEvents",
  "machineEvents",
  "heartbeats",
] as const;

export const batch = internalMutation({
  args: {},
  returns: v.number(),
  handler: async (ctx) => {
    let removed = 0;
    for (const table of tables) {
      for (const doc of await ctx.db.query(table).take(200)) {
        await ctx.db.delete(doc._id);
        removed++;
      }
    }
    for (const file of await ctx.db.system.query("_storage").take(100)) {
      await ctx.storage.delete(file._id);
      removed++;
    }
    return removed;
  },
});
