import { strFromU8 } from "fflate";

export type Drawing = {
  svg: string;
  cutLengthMm: number;
  pierces: number;
  width: number;
  height: number;
};

type Pt = { x: number; y: number };

type Prim =
  | { kind: "circle"; c: Pt; r: number }
  | { kind: "line"; a: Pt; b: Pt }
  | { kind: "poly"; pts: Array<Pt & { bulge: number }>; closed: boolean }
  | { kind: "bezier"; segs: Array<[Pt, Pt, Pt, Pt]>; closed: boolean };

type ShapeRef = {
  cls: string;
  handle: string;
  attrs: Record<string, string>;
  insert?: { block: string; at: Pt; sx: number; sy: number };
};

type Block = { base: Pt; shapes: ShapeRef[] };

type Xform = { dx: number; dy: number; sx: number; sy: number };

const RECORD_MAGIC = -774778415;
const INNER_MAGIC = -1044266559;
const POINT_TAG = 0x00020010;

function attrsOf(body: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  for (const attr of body.matchAll(/([\w:-]+)="([^"]*)"/g)) {
    const key = attr[1];
    const value = attr[2];
    if (key !== undefined && value !== undefined) attrs[key] = value;
  }
  return attrs;
}

function pointAttr(xml: string, tag: string): Pt {
  const match = new RegExp(`<${tag}\\b([^>]*)\\/?>`).exec(xml);
  const attrs = attrsOf(match?.[1] ?? "");
  return { x: Number(attrs.X ?? 0), y: Number(attrs.Y ?? 0) };
}

function elementText(xml: string, tag: string): string | undefined {
  return new RegExp(`<${tag}>([^<]*)</${tag}>`).exec(xml)?.[1];
}

export function readShapeRefs(xml: string): ShapeRef[] {
  const refs: ShapeRef[] = [];
  for (const match of xml.matchAll(/<Shape\b([^>]*?)(?:\/>|>([\s\S]*?)<\/Shape>)/g)) {
    const attrs = attrsOf(match[1] ?? "");
    const cls = attrs.Class ?? "";
    const handle = attrs.Handle ?? "";
    const body = match[2] ?? "";
    const ref: ShapeRef = { cls, handle, attrs };
    if (cls === "Insert") {
      const block = elementText(body, "BlockName");
      if (block) {
        ref.insert = {
          block,
          at: pointAttr(body, "InsertPoint"),
          sx: Number(elementText(body, "XScale") ?? 1),
          sy: Number(elementText(body, "YScale") ?? 1),
        };
      }
    }
    refs.push(ref);
  }
  return refs;
}

class GeometryStore {
  private readonly view: DataView;
  private readonly addrByHandle = new Map<string, { cls: string; addr: number }>();
  private readonly cache = new Map<string, Prim | null>();
  readonly blocks = new Map<string, Block>();

  constructor(files: Record<string, Uint8Array>) {
    const data = files["Geometry2D/data.bin"] ?? new Uint8Array();
    this.view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const shapesXml = files["Shapes2D/content.xml"];
    if (shapesXml) {
      for (const match of strFromU8(shapesXml).matchAll(/<(\w+)\b([^>]*)\/?>/g)) {
        const attrs = attrsOf(match[2] ?? "");
        if (attrs.Handle && attrs.GeoAddr) {
          this.addrByHandle.set(attrs.Handle, { cls: match[1] ?? "", addr: Number(attrs.GeoAddr) });
        }
      }
    }
    const blocksXml = files["Blocks/content.xml"];
    if (blocksXml) {
      for (const match of strFromU8(blocksXml).matchAll(/<Block\b([^>]*)>([\s\S]*?)<\/Block>/g)) {
        const name = attrsOf(match[1] ?? "").Name;
        const body = match[2] ?? "";
        if (name) this.blocks.set(name, { base: pointAttr(body, "BasePoint"), shapes: readShapeRefs(body) });
      }
    }
  }

  prim(handle: string): Prim | null {
    if (this.cache.has(handle)) return this.cache.get(handle) ?? null;
    const entry = this.addrByHandle.get(handle);
    let prim: Prim | null = null;
    if (entry) {
      try {
        prim = this.decode(entry.cls, entry.addr);
      } catch {
        prim = null;
      }
    }
    this.cache.set(handle, prim);
    return prim;
  }

  private i32(at: number) {
    return this.view.getInt32(at, true);
  }

  private f64(at: number) {
    return this.view.getFloat64(at, true);
  }

  private point(at: number): Pt {
    return { x: this.f64(at), y: this.f64(at + 8) };
  }

  private decode(cls: string, addr: number): Prim | null {
    if (addr + 16 > this.view.byteLength || this.i32(addr) !== RECORD_MAGIC) return null;
    const end = addr + this.i32(addr + 8);
    let inner = addr + 20;
    while (inner + 4 <= end && this.i32(inner) !== INNER_MAGIC) inner += 2;
    if (inner + 20 > end) return null;
    const nameHeader = inner + 16;
    const nameEnd = nameHeader + 4 + (this.i32(nameHeader) >>> 16);
    const nextPoint = (from: number) => {
      for (let at = from; at + 20 <= end; at += 2) if (this.i32(at) === POINT_TAG) return at;
      return -1;
    };

    if (cls === "Circle") {
      const at = nextPoint(nameEnd);
      if (at < 0) return null;
      return { kind: "circle", c: this.point(at + 4), r: this.f64(at + 20) };
    }
    if (cls === "Line") {
      const a = nextPoint(nameEnd);
      const b = a < 0 ? -1 : nextPoint(a + 20);
      if (b < 0) return null;
      return { kind: "line", a: this.point(a + 4), b: this.point(b + 4) };
    }
    if (cls === "LwPolyline") {
      const closed = this.i32(nameEnd + 10) === 1;
      const count = this.i32(nameEnd + 14);
      if (count <= 0 || count > 100000) return null;
      const pts: Array<Pt & { bulge: number }> = [];
      for (let i = 0; i < count; i++) {
        const at = nameEnd + 18 + i * 32;
        if (at + 28 > end) return null;
        pts.push({ ...this.point(at + 4), bulge: this.f64(at + 20) });
      }
      return { kind: "poly", pts, closed };
    }
    if (cls === "PolyBezier") {
      const closed = this.i32(nameEnd + 10) === 1;
      const count = this.i32(nameEnd + 18);
      if (count <= 0 || count > 100000) return null;
      const segs: Array<[Pt, Pt, Pt, Pt]> = [];
      for (let i = 0; i < count; i++) {
        const at = nameEnd + 22 + i * 88;
        if (at + 84 > end) return null;
        segs.push([
          this.point(at + 8),
          this.point(at + 28),
          this.point(at + 48),
          this.point(at + 68),
        ]);
      }
      return { kind: "bezier", segs, closed };
    }
    return null;
  }
}

type Placed = { prim: Prim; xf: Xform };

function collect(
  store: GeometryStore,
  refs: ShapeRef[],
  xf: Xform,
  out: Placed[],
  depth = 0,
  skip?: (ref: ShapeRef) => boolean,
) {
  if (depth > 8) return;
  for (const ref of refs) {
    if (skip?.(ref)) continue;
    if (ref.insert) {
      const block = store.blocks.get(ref.insert.block);
      if (!block) continue;
      const { at, sx, sy } = ref.insert;
      const inner: Xform = {
        sx: xf.sx * sx,
        sy: xf.sy * sy,
        dx: xf.dx + xf.sx * (at.x - block.base.x * sx),
        dy: xf.dy + xf.sy * (at.y - block.base.y * sy),
      };
      collect(store, block.shapes, inner, out, depth + 1, skip);
      continue;
    }
    const prim = store.prim(ref.handle);
    if (prim) out.push({ prim, xf });
  }
}

const IDENTITY: Xform = { dx: 0, dy: 0, sx: 1, sy: 1 };

function apply(xf: Xform, p: Pt): Pt {
  return { x: xf.dx + xf.sx * p.x, y: xf.dy + xf.sy * p.y };
}

function dist(a: Pt, b: Pt) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function bezierAt(s: [Pt, Pt, Pt, Pt], t: number): Pt {
  const u = 1 - t;
  const [p0, p1, p2, p3] = s;
  return {
    x: u * u * u * p0.x + 3 * u * u * t * p1.x + 3 * u * t * t * p2.x + t * t * t * p3.x,
    y: u * u * u * p0.y + 3 * u * u * t * p1.y + 3 * u * t * t * p2.y + t * t * t * p3.y,
  };
}

function arcLength(a: Pt, b: Pt, bulge: number) {
  const chord = dist(a, b);
  if (Math.abs(bulge) < 1e-9) return chord;
  const theta = 4 * Math.atan(Math.abs(bulge));
  return (chord * theta) / (2 * Math.sin(theta / 2));
}

function endpoints(p: Placed): [Pt, Pt] | null {
  const { prim, xf } = p;
  if (prim.kind === "line") return [apply(xf, prim.a), apply(xf, prim.b)];
  if (prim.kind === "poly" && !prim.closed && prim.pts.length > 1) {
    const first = prim.pts[0];
    const last = prim.pts[prim.pts.length - 1];
    if (first && last) return [apply(xf, first), apply(xf, last)];
  }
  if (prim.kind === "bezier" && !prim.closed && prim.segs.length > 0) {
    const first = prim.segs[0];
    const last = prim.segs[prim.segs.length - 1];
    if (first && last) return [apply(xf, first[0]), apply(xf, last[3])];
  }
  return null;
}

function lengthOf(p: Placed): number {
  const { prim, xf } = p;
  const scale = Math.sqrt(Math.abs(xf.sx * xf.sy));
  if (prim.kind === "circle") return 2 * Math.PI * prim.r * scale;
  if (prim.kind === "line") return dist(prim.a, prim.b) * scale;
  if (prim.kind === "poly") {
    let sum = 0;
    const n = prim.pts.length;
    const last = prim.closed ? n : n - 1;
    for (let i = 0; i < last; i++) {
      const a = prim.pts[i];
      const b = prim.pts[(i + 1) % n];
      if (a && b) sum += arcLength(a, b, a.bulge);
    }
    return sum * scale;
  }
  let sum = 0;
  for (const seg of prim.segs) {
    let prev = seg[0];
    for (let k = 1; k <= 16; k++) {
      const next = bezierAt(seg, k / 16);
      sum += dist(prev, next);
      prev = next;
    }
  }
  return sum * scale;
}

function countContours(placed: Placed[]): number {
  const parent = new Map<string, string>();
  const find = (k: string): string => {
    let root = k;
    while (parent.get(root) !== root) root = parent.get(root) ?? root;
    parent.set(k, root);
    return root;
  };
  const key = (p: Pt) => `${Math.round(p.x * 20)}:${Math.round(p.y * 20)}`;
  let closed = 0;
  for (const p of placed) {
    const ends = endpoints(p);
    if (!ends) {
      closed++;
      continue;
    }
    const a = key(ends[0]);
    const b = key(ends[1]);
    if (!parent.has(a)) parent.set(a, a);
    if (!parent.has(b)) parent.set(b, b);
    parent.set(find(a), find(b));
  }
  const roots = new Set<string>();
  for (const k of parent.keys()) roots.add(find(k));
  return closed + roots.size;
}

const fmt = (n: number) => {
  const r = Math.round(n * 10) / 10;
  return Object.is(r, -0) ? "0" : String(r);
};

function pathOf(p: Placed, ox: number, oy: number): string {
  const { prim, xf } = p;
  const mirror = xf.sx * xf.sy < 0;
  const scale = Math.sqrt(Math.abs(xf.sx * xf.sy));
  const P = (pt: Pt) => {
    const q = apply(xf, pt);
    return `${fmt(q.x - ox)} ${fmt(oy - q.y)}`;
  };
  if (prim.kind === "circle") {
    const c = apply(xf, prim.c);
    const r = prim.r * scale;
    const x = c.x - ox;
    const y = oy - c.y;
    return `M${fmt(x + r)} ${fmt(y)}A${fmt(r)} ${fmt(r)} 0 1 0 ${fmt(x - r)} ${fmt(y)}A${fmt(r)} ${fmt(r)} 0 1 0 ${fmt(x + r)} ${fmt(y)}`;
  }
  if (prim.kind === "line") return `M${P(prim.a)}L${P(prim.b)}`;
  if (prim.kind === "poly") {
    const n = prim.pts.length;
    const first = prim.pts[0];
    if (!first) return "";
    let d = `M${P(first)}`;
    const last = prim.closed ? n : n - 1;
    for (let i = 0; i < last; i++) {
      const a = prim.pts[i];
      const b = prim.pts[(i + 1) % n];
      if (!a || !b) continue;
      if (Math.abs(a.bulge) < 1e-9) {
        d += `L${P(b)}`;
        continue;
      }
      const theta = 4 * Math.atan(Math.abs(a.bulge));
      const r = (dist(a, b) * scale) / (2 * Math.sin(theta / 2));
      const ccw = (a.bulge > 0) !== mirror;
      d += `A${fmt(r)} ${fmt(r)} 0 ${theta > Math.PI ? 1 : 0} ${ccw ? 0 : 1} ${P(b)}`;
    }
    return prim.closed ? `${d}Z` : d;
  }
  const first = prim.segs[0];
  if (!first) return "";
  let d = `M${P(first[0])}`;
  for (const seg of prim.segs) d += `C${P(seg[1])} ${P(seg[2])} ${P(seg[3])}`;
  return prim.closed ? `${d}Z` : d;
}

function bounds(placed: Placed[]) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const add = (p: Pt, pad = 0) => {
    minX = Math.min(minX, p.x - pad);
    minY = Math.min(minY, p.y - pad);
    maxX = Math.max(maxX, p.x + pad);
    maxY = Math.max(maxY, p.y + pad);
  };
  for (const { prim, xf } of placed) {
    if (prim.kind === "circle") add(apply(xf, prim.c), prim.r * Math.abs(xf.sx));
    else if (prim.kind === "line") {
      add(apply(xf, prim.a));
      add(apply(xf, prim.b));
    } else if (prim.kind === "poly") for (const pt of prim.pts) add(apply(xf, pt));
    else for (const seg of prim.segs) for (const pt of seg) add(apply(xf, pt));
  }
  return { minX, minY, maxX, maxY };
}

function render(cut: Placed[], frame: Placed[] = []): Drawing | null {
  const all = [...frame, ...cut];
  if (cut.length === 0) return null;
  const box = bounds(all);
  if (!Number.isFinite(box.minX)) return null;
  const width = box.maxX - box.minX;
  const height = box.maxY - box.minY;
  const pad = Math.max(width, height) * 0.02 + 1;
  const ox = box.minX;
  const oy = box.maxY;
  const cutPath = cut.map((p) => pathOf(p, ox, oy)).join("");
  const framePath = frame.map((p) => pathOf(p, ox, oy)).join("");
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${fmt(-pad)} ${fmt(-pad)} ${fmt(width + 2 * pad)} ${fmt(height + 2 * pad)}">` +
    (framePath
      ? `<path d="${framePath}" fill="#f4f1ea" stroke="#9a9488" stroke-width="1.5" vector-effect="non-scaling-stroke"/>`
      : "") +
    `<path d="${cutPath}" fill="none" stroke="#1f2a37" stroke-width="1" vector-effect="non-scaling-stroke" stroke-linejoin="round"/>` +
    `</svg>`;
  return {
    svg,
    cutLengthMm: Math.round(cut.reduce((sum, p) => sum + lengthOf(p), 0)),
    pierces: countContours(cut),
    width: Math.round(width),
    height: Math.round(height),
  };
}

export type LxdsDrawings = {
  parts: Map<string, Drawing>;
  sheets: Map<number, Drawing>;
};

export function buildDrawings(
  files: Record<string, Uint8Array>,
  partBlocks: Map<string, string>,
): LxdsDrawings {
  const store = new GeometryStore(files);
  const parts = new Map<string, Drawing>();
  for (const [cadName, blockName] of partBlocks) {
    const block = store.blocks.get(blockName);
    if (!block) continue;
    const placed: Placed[] = [];
    collect(store, block.shapes, IDENTITY, placed);
    const drawing = render(placed);
    if (drawing) parts.set(cadName, drawing);
  }

  const sheets = new Map<number, Drawing>();
  const resultsXml = files["Nest2D/Results/content.xml"];
  if (resultsXml) {
    for (const match of strFromU8(resultsXml).matchAll(/<NestResult\b([^>]*)\/?>/g)) {
      const index = Number(attrsOf(match[1] ?? "").Index ?? 0);
      const xml = files[`Nest2D/Results/${index}/content.xml`];
      if (!index || !xml) continue;
      const refs = readShapeRefs(strFromU8(xml));
      const cut: Placed[] = [];
      const frame: Placed[] = [];
      collect(store, refs.filter((r) => !r.attrs.NestPlate), IDENTITY, cut);
      collect(store, refs.filter((r) => r.attrs.NestPlate), IDENTITY, frame);
      const drawing = render(cut, frame);
      if (drawing) sheets.set(index, drawing);
    }
  } else {
    const model = files["Model2D/content.xml"];
    if (model) {
      const cut: Placed[] = [];
      collect(store, readShapeRefs(strFromU8(model)), IDENTITY, cut);
      const drawing = render(cut);
      if (drawing) {
        sheets.set(1, drawing);
        for (const cadName of partBlocks.keys()) parts.set(cadName, drawing);
      }
    }
  }
  return { parts, sheets };
}
