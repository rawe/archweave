/**
 * Small fuzzy scorer for the palette and pickers: subsequence match with
 * bonuses for word starts and consecutive characters. Returns -1 for no match.
 */
export function fuzzyScore(query: string, text: string): number {
  const q = query.trim().toLowerCase();
  if (!q) return 0;
  const t = text.toLowerCase();
  const direct = t.indexOf(q);
  if (direct >= 0) return 1000 - direct * 2 - (t.length - q.length) * 0.5 + (direct === 0 || /[\s/._-]/.test(t[direct - 1] ?? '') ? 200 : 0);
  let score = 0;
  let ti = 0;
  let streak = 0;
  for (const ch of q) {
    if (ch === ' ') continue;
    const found = t.indexOf(ch, ti);
    if (found < 0) return -1;
    const boundary = found === 0 || /[\s/._-]/.test(t[found - 1] ?? '');
    streak = found === ti ? streak + 1 : 0;
    score += 10 + (boundary ? 18 : 0) + streak * 6 - Math.min(found - ti, 12);
    ti = found + 1;
  }
  return score - t.length * 0.2;
}

export function fuzzyFilter<T>(items: readonly T[], query: string, text: (item: T) => string, limit = 50): T[] {
  if (!query.trim()) return items.slice(0, limit);
  return items
    .map((item) => ({ item, score: fuzzyScore(query, text(item)) }))
    .filter((x) => x.score >= 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((x) => x.item);
}
