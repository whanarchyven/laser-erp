import { v } from "convex/values";
import type { Infer } from "convex/values";
import { parseDurationSec } from "./timing";

export const cypcutEstimateValidator = v.object({
  cutLengthMm: v.optional(v.number()),
  moveLengthMm: v.optional(v.number()),
  pierces: v.optional(v.number()),
  processSec: v.optional(v.number()),
  moveSec: v.optional(v.number()),
  delaySec: v.optional(v.number()),
  totalSec: v.number(),
});

export type CypCutEstimate = Infer<typeof cypcutEstimateValidator>;

export const TOTAL_MARK = /Total time\s*\(estimated\)/i;
const CUT_MARK = /Cut Length/i;

function length(line: string, label: RegExp): number | undefined {
  const match = new RegExp(`${label.source}\\s*[:：]?\\s*([\\d.,]+)\\s*mm`, "i").exec(line);
  if (!match?.[1]) return undefined;
  const value = Number(match[1].replace(",", "."));
  return Number.isFinite(value) ? value : undefined;
}

function duration(line: string, label: RegExp): number | undefined {
  const match = new RegExp(`${label.source}\\s*[:：]?\\s*([\\dhmins.,:]+?s)(?=\\s*,\\s*[A-Za-z]|\\s*$)`, "i").exec(line);
  if (!match?.[1]) return undefined;
  return parseDurationSec(match[1]) ?? undefined;
}

export function parseCypCutEstimate(lines: string[]): CypCutEstimate | null {
  let totalAt = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (TOTAL_MARK.test(lines[i] ?? "")) {
      totalAt = i;
      break;
    }
  }
  if (totalAt < 0) return null;
  const timeLine = lines[totalAt] ?? "";
  const totalSec = duration(timeLine, TOTAL_MARK);
  if (totalSec === undefined) return null;
  let cutLine = "";
  for (let i = totalAt; i >= Math.max(0, totalAt - 5); i--) {
    if (CUT_MARK.test(lines[i] ?? "")) {
      cutLine = lines[i] ?? "";
      break;
    }
  }
  const pierces = /Piercing Count\s*[:：]?\s*(\d+)/i.exec(cutLine)?.[1];
  return {
    cutLengthMm: length(cutLine, /Cut Length/),
    moveLengthMm: length(cutLine, /Vacant Move Length/),
    pierces: pierces !== undefined ? Number(pierces) : undefined,
    processSec: duration(timeLine, /Processing time\s*\(estimated\)/),
    moveSec: duration(timeLine, /Move time\s*\(estimated\)/),
    delaySec: duration(timeLine, /Delay Time/),
    totalSec,
  };
}
