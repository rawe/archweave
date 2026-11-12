import { slugify } from '../shared/model.ts';

export interface Named {
  id: string;
  name?: string;
}

/** The closest known id for a mistyped one, matching ids and slugified names. */
export function closestId(input: string, candidates: Iterable<Named>): string | undefined {
  const needle = input.toLowerCase();
  const asSlug = slugify(input);
  let best: { id: string; score: number } | undefined;
  for (const candidate of candidates) {
    const keys = [candidate.id, candidate.name ? slugify(candidate.name) : undefined].filter(Boolean) as string[];
    for (const key of keys) {
      if (key === asSlug) return candidate.id;
      let score = distance(needle, key);
      if (key.includes(needle) || needle.includes(key)) score = Math.min(score, Math.abs(key.length - needle.length) / 2);
      if (!best || score < best.score) best = { id: candidate.id, score };
    }
  }
  if (!best) return undefined;
  return best.score <= Math.max(2, Math.floor(needle.length / 3)) ? best.id : undefined;
}

export function didYouMean(input: string, candidates: Iterable<Named>): string {
  const hit = closestId(input, candidates);
  return hit ? ` Did you mean \`${hit}\`?` : '';
}

function distance(a: string, b: string): number {
  if (a === b) return 0;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) {
      row[j] = Math.min(prev[j]! + 1, row[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = row;
  }
  return prev[b.length]!;
}
