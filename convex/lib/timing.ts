export type CutRate = {
  secPerMeter: number;
  secPerPierce: number;
  source: "default" | "fact";
  samples: number;
};

const DEFAULT_SEC_PER_METER = 7;
const DEFAULT_SEC_PER_PIERCE = 1;

const UNIT_SECONDS: Array<[RegExp, number]> = [
  [/^(h|hr|hrs|hour|hours|ч|час|часа|часов|小时|时)$/i, 3600],
  [/^(m|min|mins|minute|minutes|м|мин|минут|минуты|分|分钟)$/i, 60],
  [/^(s|sec|secs|second|seconds|с|сек|секунд|секунды|秒)$/i, 1],
  [/^(ms|мс|毫秒)$/i, 0.001],
];

export function parseDurationSec(text: string): number | null {
  const marker = /(?:Потраченное время|Spend time|Spent time|花费时间)\s*[:：]?\s*(.+)$/i.exec(text);
  const tail = (marker?.[1] ?? text).trim();

  const clock = /(\d+):(\d{1,2})(?::(\d{1,2}(?:[.,]\d+)?))?/.exec(tail);
  if (clock) {
    const a = Number(clock[1]);
    const b = Number(clock[2]);
    if (clock[3] !== undefined) return a * 3600 + b * 60 + Number(clock[3].replace(",", "."));
    return a * 60 + b;
  }

  let total = 0;
  let matched = false;
  for (const part of tail.matchAll(/(\d+(?:[.,]\d+)?)\s*([a-zа-я\u4e00-\u9fff]+)/gi)) {
    const value = Number((part[1] ?? "").replace(",", "."));
    const unit = UNIT_SECONDS.find(([re]) => re.test(part[2] ?? ""));
    if (!unit || !Number.isFinite(value)) continue;
    total += value * unit[1];
    matched = true;
  }
  if (matched) return total;

  const bare = /^(\d+(?:[.,]\d+)?)\s*$/.exec(tail);
  return bare ? Number((bare[1] ?? "").replace(",", ".")) : null;
}

type Sample = { durationSec: number; cutLengthMm: number; pierces: number };

export function fitRate(samples: Sample[]): CutRate {
  const usable = samples.filter((s) => s.durationSec > 0 && s.cutLengthMm > 0);
  if (usable.length === 0) {
    return {
      secPerMeter: DEFAULT_SEC_PER_METER,
      secPerPierce: DEFAULT_SEC_PER_PIERCE,
      source: "default",
      samples: 0,
    };
  }
  if (usable.length >= 3) {
    let ll = 0;
    let lp = 0;
    let pp = 0;
    let lt = 0;
    let pt = 0;
    for (const s of usable) {
      const l = s.cutLengthMm / 1000;
      ll += l * l;
      lp += l * s.pierces;
      pp += s.pierces * s.pierces;
      lt += l * s.durationSec;
      pt += s.pierces * s.durationSec;
    }
    const det = ll * pp - lp * lp;
    if (Math.abs(det) > 1e-6 * ll * pp) {
      const a = (lt * pp - pt * lp) / det;
      const b = (pt * ll - lt * lp) / det;
      if (a > 0 && b >= 0) {
        return { secPerMeter: a, secPerPierce: b, source: "fact", samples: usable.length };
      }
    }
  }
  const actual = usable.reduce((sum, s) => sum + s.durationSec, 0);
  const guessed = usable.reduce(
    (sum, s) => sum + (s.cutLengthMm / 1000) * DEFAULT_SEC_PER_METER + s.pierces * DEFAULT_SEC_PER_PIERCE,
    0,
  );
  const k = guessed > 0 ? actual / guessed : 1;
  return {
    secPerMeter: DEFAULT_SEC_PER_METER * k,
    secPerPierce: DEFAULT_SEC_PER_PIERCE * k,
    source: "fact",
    samples: usable.length,
  };
}

export function estimateSec(rate: CutRate, cutLengthMm: number, pierces: number): number {
  return Math.round((cutLengthMm / 1000) * rate.secPerMeter + pierces * rate.secPerPierce);
}
