import { strFromU8, strToU8, unzipSync, zipSync, type Zippable } from "fflate";

export function normalizeThickness(input: string | undefined | null): string | null {
  const value = Number((input ?? "").trim().replace(",", ".").replace(/\s*(mm|мм)$/i, ""));
  if (!Number.isFinite(value) || value <= 0 || value > 100) return null;
  const text = String(value);
  return text.includes(".") ? text : `${text}.0`;
}

export function sheetName(index: number, thicknessMm: string): string {
  return `Лист ${index} (${thicknessMm}мм)`;
}

function escapeXml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
}

function withName(tag: string, name: string): string {
  const value = `Name="${escapeXml(name)}"`;
  return /\bName="[^"]*"/.test(tag) ? tag.replace(/\bName="[^"]*"/, value) : tag.replace(/^<NestResult\b/, `<NestResult ${value}`);
}

// CypCut lists nest results by their Name attribute, stored both in the results index and in each result.
export function renameSheets(bytes: Uint8Array, thicknessMm: string): Uint8Array | null {
  const files = unzipSync(bytes);
  const index = files["Nest2D/Results/content.xml"];
  if (!index) return null;
  const names = new Map<string, string>();
  const renamedIndex = strFromU8(index).replace(/<NestResult\b[^>]*>/g, (tag) => {
    const number = /\bIndex="(\d+)"/.exec(tag)?.[1];
    if (!number) return tag;
    const name = sheetName(Number(number), thicknessMm);
    names.set(number, name);
    return withName(tag, name);
  });
  if (names.size === 0) return null;
  const out: Zippable = {};
  for (const [path, data] of Object.entries(files)) {
    const result = /^Nest2D\/Results\/(\d+)\/content\.xml$/.exec(path);
    const name = result?.[1] ? names.get(result[1]) : undefined;
    let content = data;
    if (path === "Nest2D/Results/content.xml") content = strToU8(renamedIndex);
    else if (name) content = strToU8(strFromU8(data).replace(/<NestResult\b[^>]*>/, (tag) => withName(tag, name)));
    out[path] = [content, { level: 0, mtime: new Date(2020, 0, 1) }];
  }
  return zipSync(out);
}
