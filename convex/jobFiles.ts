import { v } from "convex/values";
import { internalAction, internalMutation } from "./_generated/server";
import { internal } from "./_generated/api";
import { sha256Hex } from "./lib/parseLxds";
import { renameSheets } from "./lib/sheetNames";

export const prepare = internalAction({
  args: { jobId: v.id("jobs"), fileId: v.id("_storage"), thicknessMm: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    let renamed: Uint8Array | null = null;
    try {
      const blob = await ctx.storage.get(args.fileId);
      if (blob) renamed = renameSheets(new Uint8Array(await blob.arrayBuffer()), args.thicknessMm);
    } catch (error) {
      console.error(`Не удалось переименовать листы в файле задачи ${args.jobId}:`, error);
    }
    if (!renamed) {
      await ctx.runMutation(internal.jobFiles.attach, { jobId: args.jobId });
      return null;
    }
    const sha256 = await sha256Hex(renamed);
    const copy = new Uint8Array(renamed.byteLength);
    copy.set(renamed);
    const fileId = await ctx.storage.store(new Blob([copy.buffer], { type: "application/octet-stream" }));
    await ctx.runMutation(internal.jobFiles.attach, { jobId: args.jobId, fileId, sha256 });
    return null;
  },
});

export const attach = internalMutation({
  args: {
    jobId: v.id("jobs"),
    fileId: v.optional(v.id("_storage")),
    sha256: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const job = await ctx.db.get(args.jobId);
    if (!job) {
      if (args.fileId) await ctx.storage.delete(args.fileId);
      return null;
    }
    await ctx.db.patch(args.jobId, {
      fileReady: true,
      ...(args.fileId && args.sha256 ? { fileId: args.fileId, sha256: args.sha256 } : {}),
    });
    return null;
  },
});
