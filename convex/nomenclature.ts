import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { mutation, query } from "./_generated/server";
import { cadKey } from "./lib/cad";

const cardValidator = v.object({
  _id: v.id("nomenclature"),
  name: v.string(),
  article: v.string(),
  description: v.string(),
  imageUrl: v.union(v.string(), v.null()),
  cadNames: v.array(v.string()),
  createdAt: v.number(),
});

export const list = query({
  args: {},
  returns: v.array(cardValidator),
  handler: async (ctx) => {
    const rows = await ctx.db.query("nomenclature").withIndex("by_article").take(200);
    const aliases = await ctx.db.query("cadAliases").withIndex("by_key").take(1000);
    const byId = new Map<string, string[]>();
    for (const alias of aliases) {
      const names = byId.get(alias.nomenclatureId) ?? [];
      names.push(alias.cadName);
      byId.set(alias.nomenclatureId, names);
    }
    const cards = [];
    for (const row of rows) {
      cards.push({
        _id: row._id,
        name: row.name,
        article: row.article,
        description: row.description,
        imageUrl: row.imageId ? await ctx.storage.getUrl(row.imageId) : null,
        cadNames: byId.get(row._id) ?? [],
        createdAt: row.createdAt,
      });
    }
    return cards;
  },
});

export const create = mutation({
  args: {
    name: v.string(),
    article: v.string(),
    description: v.string(),
    cadName: v.optional(v.string()),
    imageId: v.optional(v.id("_storage")),
  },
  returns: v.id("nomenclature"),
  handler: async (ctx, args) => {
    const name = args.name.trim();
    const article = args.article.trim();
    if (name.length < 1) throw new Error("Укажите наименование");
    if (article.length < 1) throw new Error("Укажите артикул");
    const existing = await ctx.db
      .query("nomenclature")
      .withIndex("by_article", (q) => q.eq("article", article))
      .unique();
    if (existing) throw new Error("Такой артикул уже есть");
    const id = await ctx.db.insert("nomenclature", {
      name,
      article,
      description: args.description.trim(),
      imageId: args.imageId,
      createdAt: Date.now(),
    });
    const cadName = (args.cadName ?? name).trim();
    if (cadName.length > 0) {
      await rememberAlias(ctx, id, cadName);
    }
    return id;
  },
});

export const update = mutation({
  args: {
    id: v.id("nomenclature"),
    name: v.string(),
    article: v.string(),
    description: v.string(),
    imageId: v.optional(v.id("_storage")),
    clearImage: v.optional(v.boolean()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const current = await ctx.db.get(args.id);
    if (!current) throw new Error("Номенклатура не найдена");
    const article = args.article.trim();
    const other = await ctx.db
      .query("nomenclature")
      .withIndex("by_article", (q) => q.eq("article", article))
      .unique();
    if (other && other._id !== args.id) throw new Error("Такой артикул уже есть");
    await ctx.db.patch(args.id, {
      name: args.name.trim(),
      article,
      description: args.description.trim(),
      imageId: args.clearImage ? undefined : (args.imageId ?? current.imageId),
    });
    return null;
  },
});

export async function rememberAlias(
  ctx: { db: MutationCtx["db"] },
  nomenclatureId: Id<"nomenclature">,
  cadName: string,
) {
  const key = cadKey(cadName);
  const found = await ctx.db
    .query("cadAliases")
    .withIndex("by_key", (q) => q.eq("cadKey", key))
    .unique();
  if (found) {
    if (found.nomenclatureId !== nomenclatureId) {
      throw new Error(`Имя «${cadName}» уже привязано к другой номенклатуре`);
    }
    return;
  }
  await ctx.db.insert("cadAliases", {
    cadKey: key,
    cadName: cadName.trim().replace(/\s+/g, " "),
    nomenclatureId,
  });
}

export const lookup = query({
  args: { cadNames: v.array(v.string()) },
  returns: v.array(
    v.object({
      cadName: v.string(),
      nomenclatureId: v.union(v.id("nomenclature"), v.null()),
      name: v.union(v.string(), v.null()),
      article: v.union(v.string(), v.null()),
      imageUrl: v.union(v.string(), v.null()),
    }),
  ),
  handler: async (ctx, args) => {
    const rows = [];
    for (const cadName of args.cadNames) {
      const found = await ctx.db
        .query("cadAliases")
        .withIndex("by_key", (q) => q.eq("cadKey", cadKey(cadName)))
        .unique();
      if (!found) {
        rows.push({ cadName, nomenclatureId: null, name: null, article: null, imageUrl: null });
        continue;
      }
      const card = await ctx.db.get(found.nomenclatureId);
      rows.push({
        cadName,
        nomenclatureId: found.nomenclatureId,
        name: card?.name ?? null,
        article: card?.article ?? null,
        imageUrl: card?.imageId ? await ctx.storage.getUrl(card.imageId) : null,
      });
    }
    return rows;
  },
});
