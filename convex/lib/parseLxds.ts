import { strFromU8, unzipSync } from "fflate";
import { cadKey, thicknessFromFileName } from "./cad";
import { buildDrawings, type LxdsDrawings } from "./lxdsGeometry";

export type SheetPart = {
  cadName: string;
  qty: number;
};

export type ParsedSheet = {
  index: number;
  width: number;
  height: number;
  planCount: number;
  utilization?: number;
  parts?: SheetPart[];
};

export type ParsedPart = {
  cadName: string;
  qty: number;
};

export type ParsedLxds = {
  kind: "nest" | "drawing";
  parts: ParsedPart[];
  sheets: ParsedSheet[];
  thicknessMm?: string;
  drawings: LxdsDrawings;
};

function readAttrs(source: string, tag: string): Array<Record<string, string>> {
  const re = new RegExp(`<${tag}\\b([^>]*)\\/?>`, "g");
  const rows: Array<Record<string, string>> = [];
  for (const match of source.matchAll(re)) {
    rows.push(attrsOf(match[1] ?? ""));
  }
  return rows;
}

function attrsOf(body: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  for (const attr of body.matchAll(/([\w:-]+)="([^"]*)"/g)) {
    const key = attr[1];
    const value = attr[2];
    if (key !== undefined && value !== undefined) attrs[key] = value;
  }
  return attrs;
}

function text(files: Record<string, Uint8Array>, path: string): string | null {
  const bytes = files[path];
  return bytes ? strFromU8(bytes) : null;
}

function cleanName(name: string): string {
  return name.trim().replace(/\s+/g, " ");
}

function fileStem(fileName: string): string {
  return cleanName(fileName.replace(/^.*[\\/]/, "").replace(/\.lxds$/i, ""));
}

function parseDrawing(files: Record<string, Uint8Array>, fileName: string): ParsedLxds {
  const model = text(files, "Model2D/content.xml");
  if (!model) throw new Error("В LXDS нет ни раскроя Nest2D, ни чертежа Model2D");
  const min = /<ExtMin\b([^>]*)\/?>/.exec(model);
  const max = /<ExtMax\b([^>]*)\/?>/.exec(model);
  const lo = attrsOf(min?.[1] ?? "");
  const hi = attrsOf(max?.[1] ?? "");
  const width = Math.round(Number(hi.X ?? 0) - Number(lo.X ?? 0));
  const height = Math.round(Number(hi.Y ?? 0) - Number(lo.Y ?? 0));
  const name = fileStem(fileName);
  return {
    kind: "drawing",
    parts: [{ cadName: name, qty: 1 }],
    sheets: [
      {
        index: 1,
        width: Number.isFinite(width) ? width : 0,
        height: Number.isFinite(height) ? height : 0,
        planCount: 1,
        parts: [{ cadName: name, qty: 1 }],
      },
    ],
    thicknessMm: thicknessFromFileName(fileName),
    drawings: buildDrawings(files, new Map([[name, ""]])),
  };
}

export function parseLxds(bytes: Uint8Array, fileName: string): ParsedLxds {
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(bytes);
  } catch {
    throw new Error("Файл не похож на LXDS (это zip-архив)");
  }

  const partsXml = text(files, "Nest2D/Parts/content.xml");
  if (!partsXml) return parseDrawing(files, fileName);

  const merged = new Map<string, ParsedPart>();
  const nameByHandle = new Map<string, string>();
  const partBlocks = new Map<string, string>();
  for (const match of partsXml.matchAll(/<NestPart\b([^>]*?)(?:\/>|>([\s\S]*?)<\/NestPart>)/g)) {
    const attrs = attrsOf(match[1] ?? "");
    const rawName = attrs.Name?.trim();
    if (!rawName) continue;
    const cadName = cleanName(rawName);
    if (attrs.Handle) nameByHandle.set(attrs.Handle, cadName);
    const blockName = /<BlockName>([^<]*)<\/BlockName>/.exec(match[2] ?? "")?.[1];
    if (blockName && !partBlocks.has(cadName)) partBlocks.set(cadName, blockName);
    const qty = Number(attrs.Amount ?? "0");
    if (!Number.isFinite(qty) || qty <= 0) continue;
    const previous = merged.get(cadKey(cadName));
    if (previous) previous.qty += qty;
    else merged.set(cadKey(cadName), { cadName, qty });
  }
  const parts = [...merged.values()];
  if (parts.length === 0) {
    throw new Error("В раскрое не найдены детали");
  }

  const groups = new Map<string, string[]>();
  const groupsXml = text(files, "Nest2D/Parts/Groups/content.xml") ?? "";
  for (const match of groupsXml.matchAll(/<NestGroup\b([^>]*)>([\s\S]*?)<\/NestGroup>/g)) {
    const handle = attrsOf(match[1] ?? "").Handle;
    if (!handle) continue;
    const members = [...(match[2] ?? "").matchAll(/<Object\b[^>]*Handle="([^"]+)"/g)]
      .map((m) => m[1])
      .filter((h): h is string => h !== undefined);
    groups.set(handle, members);
  }

  const resultsXml = text(files, "Nest2D/Results/content.xml");
  if (!resultsXml) throw new Error("В LXDS нет Nest2D/Results/content.xml");
  const sheets: ParsedSheet[] = [];
  for (const attrs of readAttrs(resultsXml, "NestResult")) {
    const index = Number(attrs.Index ?? "0");
    const width = Number(attrs.SizeX ?? "0");
    const height = Number(attrs.SizeY ?? "0");
    const planCount = Number(attrs.PlanCount ?? "1");
    const utilization = attrs.Utilization ? Number(attrs.Utilization) : undefined;
    if (!Number.isFinite(index) || index <= 0) continue;
    sheets.push({
      index,
      width: Number.isFinite(width) ? width : 0,
      height: Number.isFinite(height) ? height : 0,
      planCount: Number.isFinite(planCount) && planCount > 0 ? planCount : 1,
      utilization:
        utilization !== undefined && Number.isFinite(utilization) ? utilization : undefined,
      parts: sheetParts(text(files, `Nest2D/Results/${index}/content.xml`), groups, nameByHandle),
    });
  }

  return {
    kind: "nest",
    parts,
    sheets,
    thicknessMm: thicknessFromFileName(fileName),
    drawings: buildDrawings(files, partBlocks),
  };
}

function sheetParts(
  xml: string | null,
  groups: Map<string, string[]>,
  nameByHandle: Map<string, string>,
): SheetPart[] | undefined {
  if (!xml) return undefined;
  const counts = new Map<string, number>();
  const add = (handle: string) => {
    const name = nameByHandle.get(handle);
    if (name) counts.set(name, (counts.get(name) ?? 0) + 1);
  };
  for (const match of xml.matchAll(/<Shape\b([^>]*)>/g)) {
    const attrs = attrsOf(match[1] ?? "");
    if (attrs.NestPart) add(attrs.NestPart);
    if (attrs.NestGroup) for (const member of groups.get(attrs.NestGroup) ?? []) add(member);
  }
  if (counts.size === 0) return undefined;
  return [...counts.entries()].map(([cadName, qty]) => ({ cadName, qty }));
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const digest = await crypto.subtle.digest("SHA-256", copy.buffer);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
