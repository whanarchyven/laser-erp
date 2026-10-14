export function cadKey(name: string): string {
  return name.trim().replace(/\s+/g, " ").toLowerCase();
}

export function thicknessFromFileName(fileName: string): string | undefined {
  const match = /(\d+(?:[.,]\d+)?)\s*mm/i.exec(fileName);
  return match?.[1]?.replace(",", ".");
}
