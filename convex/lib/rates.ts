import { v } from "convex/values";
import type { QueryCtx } from "../_generated/server";
import { fitRate, type CutRate } from "./timing";

export async function machineRate(ctx: QueryCtx, machineId: string | undefined): Promise<CutRate> {
  if (!machineId) return fitRate([]);
  const runs = await ctx.db
    .query("cutRuns")
    .withIndex("by_machine", (q) => q.eq("machineId", machineId))
    .order("desc")
    .take(100);
  return fitRate(
    runs.flatMap((run) =>
      run.durationSec !== undefined && run.cutLengthMm !== undefined
        ? [{ durationSec: run.durationSec, cutLengthMm: run.cutLengthMm, pierces: run.pierces ?? 0 }]
        : [],
    ),
  );
}

export const rateValidator = v.object({
  secPerMeter: v.number(),
  secPerPierce: v.number(),
  source: v.union(v.literal("default"), v.literal("fact")),
  samples: v.number(),
});
