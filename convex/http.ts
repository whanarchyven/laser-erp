import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";

function authorized(request: Request): boolean {
  const token = process.env.AGENT_TOKEN;
  if (!token) return false;
  return request.headers.get("Authorization") === `Bearer ${token}`;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const listPrograms = httpAction(async (ctx, request) => {
  if (!authorized(request)) return json({ error: "Unauthorized" }, 401);
  const machineId = new URL(request.url).searchParams.get("machineId")?.trim();
  if (!machineId) return json({ error: "machineId is required" }, 400);
  const programs = await ctx.runQuery(internal.agent.programsForAgent, { machineId });
  return json({ programs });
});

const downloadFile = httpAction(async (ctx, request) => {
  if (!authorized(request)) return json({ error: "Unauthorized" }, 401);
  const programId = new URL(request.url).searchParams.get("programId");
  if (!programId) return json({ error: "programId is required" }, 400);
  let meta: { fileId: Id<"_storage">; fileName: string; sha256: string } | null;
  try {
    meta = await ctx.runQuery(internal.agent.fileForAgent, {
      programId: programId as Id<"jobs">,
    });
  } catch {
    return json({ error: "Program not found" }, 404);
  }
  if (!meta) return json({ error: "Program not found" }, 404);
  const blob = await ctx.storage.get(meta.fileId);
  if (!blob) return json({ error: "File missing" }, 404);
  return new Response(blob, {
    headers: {
      "Content-Type": "application/octet-stream",
      "Content-Disposition": `attachment; filename="${encodeURIComponent(meta.fileName)}"`,
      "X-Sha256": meta.sha256,
    },
  });
});

const postEvents = httpAction(async (ctx, request) => {
  if (!authorized(request)) return json({ error: "Unauthorized" }, 401);
  const body = (await request.json()) as {
    events?: Array<{
      eventId?: string;
      programId?: string;
      type?: string;
      at?: number;
      count?: number;
      detail?: string;
      sheet?: number;
    }>;
  };
  const events = (body.events ?? []).flatMap((event) => {
    if (!event.eventId || !event.type) return [];
    return [
      {
        eventId: event.eventId,
        programId: event.programId ?? undefined,
        type: event.type,
        at: typeof event.at === "number" ? event.at : Date.now(),
        count: typeof event.count === "number" ? event.count : undefined,
        detail: typeof event.detail === "string" ? event.detail.slice(0, 1000) : undefined,
        sheetIndex: positiveInt(event.sheet),
      },
    ];
  });
  const result = await ctx.runMutation(internal.agent.applyEvents, { events });
  return json(result);
});

const postHeartbeat = httpAction(async (ctx, request) => {
  if (!authorized(request)) return json({ error: "Unauthorized" }, 401);
  const body = (await request.json()) as {
    agentVersion?: string;
    cypcutRunning?: boolean;
    windowTitle?: string;
    hostname?: string;
    machineId?: string;
    at?: number;
    logTail?: unknown;
    panel?: unknown;
    nest?: unknown;
  };
  await ctx.runMutation(internal.agent.recordHeartbeat, {
    machineId: body.machineId ?? body.hostname ?? "stand",
    agentVersion: body.agentVersion ?? "unknown",
    cypcutRunning: body.cypcutRunning === true,
    windowTitle: body.windowTitle ?? "",
    hostname: body.hostname ?? "",
    at: typeof body.at === "number" ? body.at : Date.now(),
    logTail: stringList(body.logTail, 40),
    panel: stringList(body.panel, 40),
    nest: nestOf(body.nest),
  });
  return json({ ok: true });
});

function positiveInt(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0 && value < 10_000
    ? value
    : undefined;
}

function nestOf(value: unknown) {
  if (typeof value !== "object" || value === null) return undefined;
  const raw = value as { programId?: unknown; current?: unknown; done?: unknown; total?: unknown };
  const total = positiveInt(raw.total);
  if (total === undefined) return undefined;
  return {
    programId: typeof raw.programId === "string" ? raw.programId.slice(0, 64) : undefined,
    current: positiveInt(raw.current) ?? null,
    done: Array.isArray(raw.done)
      ? raw.done.flatMap((item) => {
          const n = positiveInt(item);
          return n !== undefined && n <= total ? [n] : [];
        })
      : [],
    total,
  };
}

function stringList(value: unknown, max: number): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value
    .filter((item): item is string => typeof item === "string")
    .slice(-max)
    .map((item) => item.slice(0, 300));
}

const MAX_SCREEN_BYTES = 3 * 1024 * 1024;

const postScreen = httpAction(async (ctx, request) => {
  if (!authorized(request)) return json({ error: "Unauthorized" }, 401);
  const machineId = new URL(request.url).searchParams.get("machineId")?.trim();
  if (!machineId) return json({ error: "machineId is required" }, 400);
  const type = request.headers.get("Content-Type") ?? "";
  if (!type.startsWith("image/")) return json({ error: "image body expected" }, 415);
  const bytes = await request.arrayBuffer();
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_SCREEN_BYTES) {
    return json({ error: "image too large" }, 413);
  }
  const screenId = await ctx.storage.store(new Blob([bytes], { type }));
  await ctx.runMutation(internal.agent.recordScreen, { machineId, screenId, at: Date.now() });
  return json({ ok: true });
});

const http = httpRouter();
http.route({ path: "/agent/programs", method: "GET", handler: listPrograms });
http.route({ path: "/agent/file", method: "GET", handler: downloadFile });
http.route({ path: "/agent/events", method: "POST", handler: postEvents });
http.route({ path: "/agent/heartbeat", method: "POST", handler: postHeartbeat });
http.route({ path: "/agent/screen", method: "POST", handler: postScreen });

export default http;
