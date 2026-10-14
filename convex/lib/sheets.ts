import { cadKey } from "./cad";

type Sheet = {
  index: number;
  planCount: number;
  utilization?: number;
  parts?: Array<{ cadName: string; qty: number }>;
};

type Total = { cadName: string; qty: number };

export type SheetRun = {
  sheetIndex: number;
  exact: boolean;
  parts: Map<string, number>;
};

export function sheetRunCount(sheets: Sheet[]): number {
  return sheets.reduce((sum, sheet) => sum + sheet.planCount, 0);
}

export function planSheetRuns(sheets: Sheet[], totals: Total[]): SheetRun[] {
  const ordered = [...sheets].sort((a, b) => a.index - b.index);
  const remaining = new Map<string, number>();
  for (const total of totals) {
    const key = cadKey(total.cadName);
    remaining.set(key, (remaining.get(key) ?? 0) + total.qty);
  }

  const runs: SheetRun[] = [];
  for (const sheet of ordered) {
    for (let copy = 0; copy < sheet.planCount; copy++) {
      if (sheet.parts) {
        const parts = new Map<string, number>();
        for (const part of sheet.parts) {
          const key = cadKey(part.cadName);
          parts.set(key, (parts.get(key) ?? 0) + part.qty);
          remaining.set(key, Math.max(0, (remaining.get(key) ?? 0) - part.qty));
        }
        runs.push({ sheetIndex: sheet.index, exact: true, parts });
      } else {
        runs.push({ sheetIndex: sheet.index, exact: false, parts: new Map() });
      }
    }
  }

  const unknown = runs
    .map((run, position) => ({ run, position }))
    .filter(({ run }) => !run.exact);
  if (unknown.length === 0) return runs;

  const weights = unknown.map(({ run }) => {
    const sheet = ordered.find((s) => s.index === run.sheetIndex);
    const value = sheet?.utilization ?? 1;
    return value > 0 ? value : 1;
  });
  const weightSum = weights.reduce((a, b) => a + b, 0);

  const pieces: string[] = [];
  for (const [key, qty] of remaining) {
    for (let i = 0; i < qty; i++) pieces.push(key);
  }
  let given = 0;
  let cumulative = 0;
  unknown.forEach(({ run }, i) => {
    cumulative += weights[i] ?? 0;
    const end =
      i === unknown.length - 1 ? pieces.length : Math.round((pieces.length * cumulative) / weightSum);
    for (const key of pieces.slice(given, end)) run.parts.set(key, (run.parts.get(key) ?? 0) + 1);
    given = Math.max(given, end);
  });
  return runs;
}
