import { httpAction } from "./_generated/server";
import type { ActionCtx } from "./_generated/server";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Authorization, Content-Type",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...cors },
  });
}

export const preflight = httpAction(async () => new Response(null, { status: 204, headers: cors }));

function allowed(request: Request): boolean {
  const header = request.headers.get("Authorization");
  const apiToken = process.env.API_TOKEN;
  if (apiToken) return header === `Bearer ${apiToken}`;
  const agentToken = process.env.AGENT_TOKEN;
  return Boolean(agentToken) && header === `Bearer ${agentToken}`;
}

function errorText(error: unknown): string {
  const raw = error instanceof Error ? error.message : "Ошибка";
  const lines = raw
    .split("\n")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  const uncaught = lines.find((line) => line.startsWith("Uncaught Error:"));
  if (uncaught) return uncaught.replace(/^Uncaught Error:\s*/, "").slice(0, 500);
  const human = lines.find((line) => !line.startsWith("at ") && !line.startsWith("[Request ID"));
  return (human ?? "Ошибка").slice(0, 500);
}

function fail(error: unknown): Response {
  const text = errorText(error);
  const status = /не найден/i.test(text) ? 404 : /уже/i.test(text) ? 409 : 400;
  return json({ error: text }, status);
}

async function readJson(request: Request): Promise<Record<string, unknown>> {
  const text = await request.text();
  if (!text.trim()) return {};
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error("Тело запроса не JSON");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Тело запроса должно быть объектом");
  }
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim().length === 0) throw new Error(`Поле ${name} обязательно`);
  return value;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function requiredNumber(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`Поле ${name} должно быть числом`);
  return value;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function objectOf(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`Поле ${name} должно быть объектом`);
  }
  return value as Record<string, unknown>;
}

async function guard(
  request: Request,
  run: (ctx: ActionCtx) => Promise<unknown>,
  ctx: ActionCtx,
): Promise<Response> {
  if (!allowed(request)) return json({ error: "Unauthorized" }, 401);
  try {
    return json(await run(ctx));
  } catch (error) {
    return fail(error);
  }
}

const index = {
  version: 1,
  auth: "Authorization: Bearer <API_TOKEN>",
  docs: "docs/API.md",
  endpoints: [
    "GET /api/machines",
    "DELETE /api/machines?machineId=",
    "GET /api/jobs",
    "GET /api/jobs?jobId=",
    "GET /api/jobs/file?jobId=",
    "POST /api/jobs/qty",
    "POST /api/jobs/sheet-done",
    "POST /api/jobs/finish",
    "POST /api/jobs/cancel",
    "GET /api/presets",
    "POST /api/files/upload-url",
    "POST /api/presets/inspect",
    "POST /api/presets",
    "POST /api/presets/enqueue",
    "GET /api/nomenclature",
    "POST /api/nomenclature",
    "POST /api/nomenclature/update",
    "POST /api/nomenclature/lookup",
  ],
};

export const getIndex = httpAction(async (_ctx, request) => {
  if (!allowed(request)) return json({ error: "Unauthorized" }, 401);
  return json(index);
});

export const getMachines = httpAction(async (ctx, request) =>
  guard(request, async (c) => ({ machines: await c.runQuery(api.stand.machines, {}) }), ctx),
);

export const deleteMachine = httpAction(async (ctx, request) =>
  guard(
    request,
    async (c) => {
      const machineId = new URL(request.url).searchParams.get("machineId")?.trim() ?? "";
      if (!machineId) throw new Error("Поле machineId обязательно");
      await c.runMutation(api.stand.removeMachine, { machineId });
      return { ok: true };
    },
    ctx,
  ),
);

export const getJobs = httpAction(async (ctx, request) =>
  guard(
    request,
    async (c) => {
      const jobId = new URL(request.url).searchParams.get("jobId")?.trim();
      if (!jobId) return { jobs: await c.runQuery(api.jobs.list, {}) };
      const job = await c.runQuery(api.jobs.get, { jobId: jobId as Id<"jobs"> });
      if (!job) throw new Error("Задача не найдена");
      return { job };
    },
    ctx,
  ),
);

export const getJobFile = httpAction(async (ctx, request) => {
  if (!allowed(request)) return json({ error: "Unauthorized" }, 401);
  const jobId = new URL(request.url).searchParams.get("jobId")?.trim();
  if (!jobId) return json({ error: "Поле jobId обязательно" }, 400);
  try {
    const meta = await ctx.runQuery(internal.agent.fileForAgent, { programId: jobId as Id<"jobs"> });
    if (!meta) return json({ error: "Задача не найдена" }, 404);
    const blob = await ctx.storage.get(meta.fileId);
    if (!blob) return json({ error: "Файл не найден" }, 404);
    return new Response(blob, {
      headers: {
        ...cors,
        "Content-Type": "application/octet-stream",
        "Content-Disposition": `attachment; filename="${encodeURIComponent(meta.fileName)}"`,
        "X-Sha256": meta.sha256,
      },
    });
  } catch (error) {
    return fail(error);
  }
});

export const postQty = httpAction(async (ctx, request) =>
  guard(
    request,
    async (c) => {
      const body = await readJson(request);
      await c.runMutation(api.jobs.setQtyDone, {
        lineId: requiredString(body.lineId, "lineId") as Id<"jobLines">,
        qtyDone: requiredNumber(body.qtyDone, "qtyDone"),
      });
      return { ok: true };
    },
    ctx,
  ),
);

export const postSheetDone = httpAction(async (ctx, request) =>
  guard(
    request,
    async (c) => {
      const body = await readJson(request);
      return await c.runMutation(api.jobs.sheetDone, {
        jobId: requiredString(body.jobId, "jobId") as Id<"jobs">,
      });
    },
    ctx,
  ),
);

export const postFinish = httpAction(async (ctx, request) =>
  guard(
    request,
    async (c) => {
      const body = await readJson(request);
      await c.runMutation(api.jobs.finish, { jobId: requiredString(body.jobId, "jobId") as Id<"jobs"> });
      return { ok: true };
    },
    ctx,
  ),
);

export const postCancel = httpAction(async (ctx, request) =>
  guard(
    request,
    async (c) => {
      const body = await readJson(request);
      await c.runMutation(api.jobs.cancel, { jobId: requiredString(body.jobId, "jobId") as Id<"jobs"> });
      return { ok: true };
    },
    ctx,
  ),
);

export const getPresets = httpAction(async (ctx, request) =>
  guard(request, async (c) => ({ presets: await c.runQuery(api.presets.list, {}) }), ctx),
);

export const postUploadUrl = httpAction(async (ctx, request) =>
  guard(
    request,
    async (c) => ({ uploadUrl: await c.runMutation(api.presets.generateUploadUrl, {}) }),
    ctx,
  ),
);

export const postInspect = httpAction(async (ctx, request) =>
  guard(
    request,
    async (c) => {
      const body = await readJson(request);
      return await c.runAction(api.presets.inspect, {
        fileId: requiredString(body.fileId, "fileId") as Id<"_storage">,
        fileName: requiredString(body.fileName, "fileName"),
      });
    },
    ctx,
  ),
);

export const postPreset = httpAction(async (ctx, request) =>
  guard(
    request,
    async (c) => {
      const body = await readJson(request);
      if (!Array.isArray(body.sheets)) throw new Error("Поле sheets должно быть массивом");
      if (!Array.isArray(body.lines)) throw new Error("Поле lines должно быть массивом");
      return await c.runMutation(api.presets.save, {
        title: typeof body.title === "string" ? body.title : "",
        fileName: requiredString(body.fileName, "fileName"),
        fileId: requiredString(body.fileId, "fileId") as Id<"_storage">,
        sha256: requiredString(body.sha256, "sha256"),
        thicknessMm: optionalString(body.thicknessMm),
        sheets: body.sheets.map((item, i) => sheetInput(item, i)),
        lines: body.lines.map((item, i) => lineInput(item, i)),
        enqueue: body.enqueue === true,
        machineId: optionalString(body.machineId),
      });
    },
    ctx,
  ),
);

export const postEnqueue = httpAction(async (ctx, request) =>
  guard(
    request,
    async (c) => {
      const body = await readJson(request);
      const jobId = await c.runMutation(api.presets.enqueue, {
        presetId: requiredString(body.presetId, "presetId") as Id<"presets">,
        machineId: requiredString(body.machineId, "machineId"),
        thicknessMm: optionalString(body.thicknessMm),
      });
      return { jobId };
    },
    ctx,
  ),
);

export const getNomenclature = httpAction(async (ctx, request) =>
  guard(request, async (c) => ({ nomenclature: await c.runQuery(api.nomenclature.list, {}) }), ctx),
);

export const postNomenclature = httpAction(async (ctx, request) =>
  guard(
    request,
    async (c) => {
      const body = await readJson(request);
      const id = await c.runMutation(api.nomenclature.create, {
        name: requiredString(body.name, "name"),
        article: requiredString(body.article, "article"),
        description: typeof body.description === "string" ? body.description : "",
        cadName: optionalString(body.cadName),
        imageId: optionalString(body.imageId) as Id<"_storage"> | undefined,
      });
      return { id };
    },
    ctx,
  ),
);

export const postNomenclatureUpdate = httpAction(async (ctx, request) =>
  guard(
    request,
    async (c) => {
      const body = await readJson(request);
      await c.runMutation(api.nomenclature.update, {
        id: requiredString(body.id, "id") as Id<"nomenclature">,
        name: requiredString(body.name, "name"),
        article: requiredString(body.article, "article"),
        description: typeof body.description === "string" ? body.description : "",
        imageId: optionalString(body.imageId) as Id<"_storage"> | undefined,
        clearImage: body.clearImage === true ? true : undefined,
      });
      return { ok: true };
    },
    ctx,
  ),
);

export const postLookup = httpAction(async (ctx, request) =>
  guard(
    request,
    async (c) => {
      const body = await readJson(request);
      if (!Array.isArray(body.cadNames) || body.cadNames.some((name) => typeof name !== "string")) {
        throw new Error("Поле cadNames должно быть массивом строк");
      }
      return { matches: await c.runQuery(api.nomenclature.lookup, { cadNames: body.cadNames }) };
    },
    ctx,
  ),
);

function sheetInput(value: unknown, index: number) {
  const sheet = objectOf(value, `sheets[${index}]`);
  const parts = Array.isArray(sheet.parts)
    ? sheet.parts.map((part, i) => {
        const row = objectOf(part, `sheets[${index}].parts[${i}]`);
        return { cadName: requiredString(row.cadName, "cadName"), qty: requiredNumber(row.qty, "qty") };
      })
    : undefined;
  return {
    index: requiredNumber(sheet.index, "index"),
    width: requiredNumber(sheet.width, "width"),
    height: requiredNumber(sheet.height, "height"),
    planCount: requiredNumber(sheet.planCount, "planCount"),
    ...(optionalNumber(sheet.utilization) !== undefined ? { utilization: optionalNumber(sheet.utilization) } : {}),
    ...(parts ? { parts } : {}),
    ...(typeof sheet.previewId === "string" ? { previewId: sheet.previewId as Id<"_storage"> } : {}),
    ...(optionalNumber(sheet.cutLengthMm) !== undefined ? { cutLengthMm: optionalNumber(sheet.cutLengthMm) } : {}),
    ...(optionalNumber(sheet.pierces) !== undefined ? { pierces: optionalNumber(sheet.pierces) } : {}),
  };
}

function lineInput(value: unknown, index: number) {
  const line = objectOf(value, `lines[${index}]`);
  const create = line.create === undefined ? undefined : objectOf(line.create, "create");
  return {
    cadName: requiredString(line.cadName, "cadName"),
    qty: requiredNumber(line.qty, "qty"),
    ...(typeof line.nomenclatureId === "string" ? { nomenclatureId: line.nomenclatureId as Id<"nomenclature"> } : {}),
    ...(typeof line.previewId === "string" ? { previewId: line.previewId as Id<"_storage"> } : {}),
    ...(optionalNumber(line.cutLengthMm) !== undefined ? { cutLengthMm: optionalNumber(line.cutLengthMm) } : {}),
    ...(optionalNumber(line.pierces) !== undefined ? { pierces: optionalNumber(line.pierces) } : {}),
    ...(typeof line.photoId === "string" ? { photoId: line.photoId as Id<"_storage"> } : {}),
    ...(create
      ? {
          create: {
            name: requiredString(create.name, "create.name"),
            article: requiredString(create.article, "create.article"),
            description: typeof create.description === "string" ? create.description : "",
          },
        }
      : {}),
  };
}
