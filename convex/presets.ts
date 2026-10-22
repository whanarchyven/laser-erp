import { v, type Infer } from "convex/values";
import { action, mutation, query } from "./_generated/server";
import type { ActionCtx } from "./_generated/server";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { rememberAlias } from "./nomenclature";
import { parseLxds, sha256Hex } from "./lib/parseLxds";
import { sheetValidator } from "./schema";
import { normalizeThickness } from "./lib/sheetNames";

const previewLine = v.object({
  cadName: v.string(),
  qty: v.number(),
  nomenclatureId: v.union(v.id("nomenclature"), v.null()),
  name: v.union(v.string(), v.null()),
  article: v.union(v.string(), v.null()),
  imageUrl: v.union(v.string(), v.null()),
  previewId: v.union(v.id("_storage"), v.null()),
  previewUrl: v.union(v.string(), v.null()),
  cutLengthMm: v.union(v.number(), v.null()),
  pierces: v.union(v.number(), v.null()),
});

async function storeSvg(ctx: ActionCtx, svg: string) {
  const id = await ctx.storage.store(new Blob([svg], { type: "image/svg+xml" }));
  return { id, url: await ctx.storage.getUrl(id) };
}

export const generateUploadUrl = mutation({
  args: {},
  returns: v.string(),
  handler: async (ctx) => {
    return await ctx.storage.generateUploadUrl();
  },
});

export const inspect = action({
  args: { fileId: v.id("_storage"), fileName: v.string() },
  returns: v.object({
    kind: v.union(v.literal("nest"), v.literal("drawing")),
    sha256: v.string(),
    thicknessMm: v.union(v.string(), v.null()),
    sheetCount: v.number(),
    sheets: v.array(sheetValidator),
    sheetUrls: v.array(v.object({ index: v.number(), url: v.union(v.string(), v.null()) })),
    lines: v.array(previewLine),
  }),
  handler: async (ctx, args) => {
    const blob = await ctx.storage.get(args.fileId);
    if (!blob) throw new Error("Файл не найден");
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const parsed = parseLxds(bytes, args.fileName);
    const sha256 = await sha256Hex(bytes);
    const matches: Array<{
      cadName: string;
      nomenclatureId: Id<"nomenclature"> | null;
      name: string | null;
      article: string | null;
      imageUrl: string | null;
    }> = await ctx.runQuery(api.nomenclature.lookup, {
      cadNames: parsed.parts.map((part) => part.cadName),
    });
    const byName = new Map(matches.map((row) => [row.cadName, row]));
    const sheetCount = parsed.sheets.reduce((sum, sheet) => sum + sheet.planCount, 0);

    const sheets: Array<Infer<typeof sheetValidator>> = [];
    const sheetUrls = [];
    for (const sheet of parsed.sheets) {
      const drawing = parsed.drawings.sheets.get(sheet.index);
      if (!drawing) {
        sheets.push(sheet);
        sheetUrls.push({ index: sheet.index, url: null });
        continue;
      }
      const stored = await storeSvg(ctx, drawing.svg);
      sheets.push({
        ...sheet,
        previewId: stored.id,
        cutLengthMm: drawing.cutLengthMm,
        pierces: drawing.pierces,
      });
      sheetUrls.push({ index: sheet.index, url: stored.url });
    }

    const lines = [];
    for (const part of parsed.parts) {
      const match = byName.get(part.cadName);
      const drawing = parsed.drawings.parts.get(part.cadName);
      const stored = drawing ? await storeSvg(ctx, drawing.svg) : null;
      lines.push({
        cadName: part.cadName,
        qty: part.qty,
        nomenclatureId: match?.nomenclatureId ?? null,
        name: match?.name ?? null,
        article: match?.article ?? null,
        imageUrl: match?.imageUrl ?? null,
        previewId: stored?.id ?? null,
        previewUrl: stored?.url ?? null,
        cutLengthMm: drawing?.cutLengthMm ?? null,
        pierces: drawing?.pierces ?? null,
      });
    }

    return {
      kind: parsed.kind,
      sha256,
      thicknessMm: parsed.thicknessMm ?? null,
      sheetCount,
      sheets,
      sheetUrls,
      lines,
    };
  },
});

const lineInput = v.object({
  cadName: v.string(),
  qty: v.number(),
  nomenclatureId: v.optional(v.id("nomenclature")),
  previewId: v.optional(v.id("_storage")),
  cutLengthMm: v.optional(v.number()),
  pierces: v.optional(v.number()),
  photoId: v.optional(v.id("_storage")),
  create: v.optional(
    v.object({
      name: v.string(),
      article: v.string(),
      description: v.string(),
    }),
  ),
});

export const save = mutation({
  args: {
    title: v.string(),
    fileName: v.string(),
    fileId: v.id("_storage"),
    sha256: v.string(),
    thicknessMm: v.optional(v.string()),
    sheets: v.array(sheetValidator),
    lines: v.array(lineInput),
    enqueue: v.boolean(),
    machineId: v.optional(v.string()),
  },
  returns: v.object({
    presetId: v.id("presets"),
    jobId: v.union(v.id("jobs"), v.null()),
  }),
  handler: async (ctx, args) => {
    if (args.lines.length === 0) throw new Error("В пресете нет деталей");
    const title = args.title.trim() || args.fileName;
    const thicknessMm = normalizeThickness(args.thicknessMm) ?? undefined;
    if (args.thicknessMm?.trim() && !thicknessMm) throw new Error(`Не понял толщину «${args.thicknessMm}». Пример: 1.0`);
    const sheetCount = args.sheets.reduce((sum, sheet) => sum + sheet.planCount, 0);
    const presetId = await ctx.db.insert("presets", {
      title,
      fileName: args.fileName,
      fileId: args.fileId,
      sha256: args.sha256,
      thicknessMm,
      sheetCount,
      sheets: args.sheets,
      createdAt: Date.now(),
    });

    for (const line of args.lines) {
      let nomenclatureId = line.nomenclatureId;
      if (line.create) {
        const name = line.create.name.trim();
        const article = line.create.article.trim();
        if (!name || !article) throw new Error(`Заполните карточку для «${line.cadName}»`);
        const existing = await ctx.db
          .query("nomenclature")
          .withIndex("by_article", (q) => q.eq("article", article))
          .unique();
        if (existing) throw new Error(`Артикул «${article}» уже есть`);
        nomenclatureId = await ctx.db.insert("nomenclature", {
          name,
          article,
          description: line.create.description.trim(),
          imageId: line.photoId ?? line.previewId,
          createdAt: Date.now(),
        });
        await rememberAlias(ctx, nomenclatureId, line.cadName);
      } else if (nomenclatureId) {
        await rememberAlias(ctx, nomenclatureId, line.cadName);
        const card = await ctx.db.get(nomenclatureId);
        const imageId = line.photoId ?? (card?.imageId ? undefined : line.previewId);
        if (card && imageId) await ctx.db.patch(nomenclatureId, { imageId });
      }
      await ctx.db.insert("presetLines", {
        presetId,
        cadName: line.cadName.trim(),
        qty: line.qty,
        nomenclatureId,
        previewId: line.previewId,
        cutLengthMm: line.cutLengthMm,
        pierces: line.pierces,
      });
    }

    let jobId: Id<"jobs"> | null = null;
    if (args.enqueue) {
      if (!args.machineId) throw new Error("Выберите станок");
      jobId = await enqueuePreset(ctx, presetId, args.machineId, thicknessMm);
    }
    return { presetId, jobId };
  },
});

export const list = query({
  args: {},
  returns: v.array(
    v.object({
      _id: v.id("presets"),
      title: v.string(),
      fileName: v.string(),
      thicknessMm: v.union(v.string(), v.null()),
      sheetCount: v.number(),
      lineCount: v.number(),
      ready: v.boolean(),
      createdAt: v.number(),
    }),
  ),
  handler: async (ctx) => {
    const presets = await ctx.db.query("presets").withIndex("by_created").order("desc").take(100);
    const result = [];
    for (const preset of presets) {
      const lines = await ctx.db
        .query("presetLines")
        .withIndex("by_preset", (q) => q.eq("presetId", preset._id))
        .take(200);
      result.push({
        _id: preset._id,
        title: preset.title,
        fileName: preset.fileName,
        thicknessMm: preset.thicknessMm ?? null,
        sheetCount: preset.sheetCount,
        lineCount: lines.length,
        ready: lines.every((line) => line.nomenclatureId !== undefined),
        createdAt: preset.createdAt,
      });
    }
    return result;
  },
});

async function enqueuePreset(
  ctx: import("./_generated/server").MutationCtx,
  presetId: Id<"presets">,
  machineId: string,
  thicknessInput: string | undefined,
) {
  if (!machineId.trim()) throw new Error("Выберите станок");
  const preset = await ctx.db.get(presetId);
  if (!preset) throw new Error("Пресет не найден");
  const thicknessMm = normalizeThickness(thicknessInput ?? preset.thicknessMm);
  if (!thicknessMm) throw new Error("Укажите толщину листа, например 1.0");
  if (preset.thicknessMm !== thicknessMm) await ctx.db.patch(presetId, { thicknessMm });
  const lines = await ctx.db
    .query("presetLines")
    .withIndex("by_preset", (q) => q.eq("presetId", presetId))
    .take(200);
  if (lines.some((line) => !line.nomenclatureId)) {
    throw new Error("В пресете есть детали без номенклатуры");
  }
  const counter = await ctx.db
    .query("counters")
    .withIndex("by_name", (q) => q.eq("name", "jobs"))
    .unique();
  const next = (counter?.value ?? 0) + 1;
  if (counter) {
    await ctx.db.patch(counter._id, { value: next });
  } else {
    await ctx.db.insert("counters", { name: "jobs", value: next });
  }
  const jobId = await ctx.db.insert("jobs", {
    number: `J-${next}`,
    presetId,
    title: preset.title,
    fileName: preset.fileName,
    fileId: preset.fileId,
    sha256: preset.sha256,
    status: "queued",
    machineId: machineId.trim(),
    thicknessMm,
    fileReady: false,
    createdAt: Date.now(),
  });
  await ctx.scheduler.runAfter(0, internal.jobFiles.prepare, { jobId, fileId: preset.fileId, thicknessMm });
  for (const line of lines) {
    await ctx.db.insert("jobLines", {
      jobId,
      cadName: line.cadName,
      qtyPlanned: line.qty,
      qtyDone: 0,
      nomenclatureId: line.nomenclatureId,
      previewId: line.previewId,
    });
  }
  return jobId;
}

export const enqueue = mutation({
  args: { presetId: v.id("presets"), machineId: v.string(), thicknessMm: v.optional(v.string()) },
  returns: v.id("jobs"),
  handler: async (ctx, args) => {
    return await enqueuePreset(ctx, args.presetId, args.machineId, args.thicknessMm);
  },
});
