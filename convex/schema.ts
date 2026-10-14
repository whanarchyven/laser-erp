import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";
import { cypcutEstimateValidator } from "./lib/cypcutLog";

export const jobStatus = v.union(
  v.literal("queued"),
  v.literal("delivered"),
  v.literal("loaded"),
  v.literal("in_progress"),
  v.literal("done"),
  v.literal("cancelled"),
  v.literal("failed"),
);

export const nestValidator = v.object({
  programId: v.optional(v.string()),
  current: v.union(v.number(), v.null()),
  done: v.array(v.number()),
  total: v.number(),
});

export const sheetValidator = v.object({
  index: v.number(),
  width: v.number(),
  height: v.number(),
  planCount: v.number(),
  utilization: v.optional(v.number()),
  parts: v.optional(v.array(v.object({ cadName: v.string(), qty: v.number() }))),
  previewId: v.optional(v.id("_storage")),
  cutLengthMm: v.optional(v.number()),
  pierces: v.optional(v.number()),
});

export default defineSchema({
  nomenclature: defineTable({
    name: v.string(),
    article: v.string(),
    description: v.string(),
    imageId: v.optional(v.id("_storage")),
    createdAt: v.number(),
  }).index("by_article", ["article"]),

  cadAliases: defineTable({
    cadKey: v.string(),
    cadName: v.string(),
    nomenclatureId: v.id("nomenclature"),
  }).index("by_key", ["cadKey"]),

  presets: defineTable({
    title: v.string(),
    fileName: v.string(),
    fileId: v.id("_storage"),
    sha256: v.string(),
    thicknessMm: v.optional(v.string()),
    sheetCount: v.number(),
    sheets: v.array(sheetValidator),
    createdAt: v.number(),
  }).index("by_created", ["createdAt"]),

  presetLines: defineTable({
    presetId: v.id("presets"),
    cadName: v.string(),
    qty: v.number(),
    nomenclatureId: v.optional(v.id("nomenclature")),
    previewId: v.optional(v.id("_storage")),
    cutLengthMm: v.optional(v.number()),
    pierces: v.optional(v.number()),
  }).index("by_preset", ["presetId"]),

  jobs: defineTable({
    number: v.string(),
    presetId: v.id("presets"),
    title: v.string(),
    fileName: v.string(),
    fileId: v.id("_storage"),
    sha256: v.string(),
    status: jobStatus,
    lastError: v.optional(v.string()),
    sheetsDone: v.optional(v.number()),
    machineId: v.optional(v.string()),
    createdAt: v.number(),
  })
    .index("by_status", ["status"])
    .index("by_machine_status", ["machineId", "status"])
    .index("by_created", ["createdAt"]),

  jobLines: defineTable({
    jobId: v.id("jobs"),
    cadName: v.string(),
    qtyPlanned: v.number(),
    qtyDone: v.number(),
    nomenclatureId: v.optional(v.id("nomenclature")),
    previewId: v.optional(v.id("_storage")),
  }).index("by_job", ["jobId"]),

  cutRuns: defineTable({
    jobId: v.id("jobs"),
    machineId: v.string(),
    sheetIndex: v.number(),
    cutLengthMm: v.optional(v.number()),
    pierces: v.optional(v.number()),
    durationSec: v.optional(v.number()),
    source: v.union(v.literal("agent"), v.literal("operator")),
    at: v.number(),
  })
    .index("by_job", ["jobId"])
    .index("by_machine", ["machineId", "at"]),

  cypcutEstimates: defineTable({
    jobId: v.id("jobs"),
    machineId: v.string(),
    sheetIndex: v.optional(v.number()),
    estimate: cypcutEstimateValidator,
    at: v.number(),
  }).index("by_job", ["jobId", "at"]),

  counters: defineTable({
    name: v.string(),
    value: v.number(),
  }).index("by_name", ["name"]),

  agentEvents: defineTable({
    eventId: v.string(),
    jobId: v.optional(v.id("jobs")),
    type: v.string(),
    at: v.number(),
  }).index("by_event", ["eventId"]),

  heartbeats: defineTable({
    machineId: v.string(),
    agentVersion: v.string(),
    cypcutRunning: v.boolean(),
    windowTitle: v.string(),
    hostname: v.string(),
    at: v.number(),
    logTail: v.optional(v.array(v.string())),
    panel: v.optional(v.array(v.string())),
    screenId: v.optional(v.id("_storage")),
    screenAt: v.optional(v.number()),
    nest: v.optional(nestValidator),
  }).index("by_machine", ["machineId"]),
});
