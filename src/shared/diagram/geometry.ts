import { num } from './svg.ts';

export interface Point {
  x: number;
  y: number;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export function distance(a: Point, b: Point): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

export function rectsOverlap(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

export function rectContains(outer: Rect, inner: Rect): boolean {
  return inner.x >= outer.x && inner.y >= outer.y && inner.x + inner.w <= outer.x + outer.w && inner.y + inner.h <= outer.y + outer.h;
}

export function inflate(rect: Rect, by: number): Rect {
  return { x: rect.x - by, y: rect.y - by, w: rect.w + 2 * by, h: rect.h + 2 * by };
}

export function unionRects(rects: Rect[]): Rect | undefined {
  if (!rects.length) return undefined;
  const x = Math.min(...rects.map((r) => r.x));
  const y = Math.min(...rects.map((r) => r.y));
  return { x, y, w: Math.max(...rects.map((r) => r.x + r.w)) - x, h: Math.max(...rects.map((r) => r.y + r.h)) - y };
}

/** Drops repeated points and points lying on the straight line between their neighbours. */
export function simplify(points: Point[]): Point[] {
  const out: Point[] = [];
  for (const p of points) {
    const last = out.at(-1);
    if (last && Math.abs(last.x - p.x) < 0.01 && Math.abs(last.y - p.y) < 0.01) continue;
    const before = out.at(-2);
    if (before && last && Math.abs((last.x - before.x) * (p.y - before.y) - (last.y - before.y) * (p.x - before.x)) < 0.01) out.pop();
    out.push(p);
  }
  return out;
}

/**
 * Path data through the points with every corner rounded. The rounding never takes more than
 * half of a neighbouring segment, so short segments stay drawable.
 */
export function roundedPath(points: Point[], radius: number, closed = false): string {
  const n = points.length;
  if (n < 2) return '';
  if (n === 2 || radius <= 0) return `M${points.map((p) => `${num(p.x)},${num(p.y)}`).join('L')}${closed ? 'Z' : ''}`;
  const corner = (i: number): { enter: Point; at: Point; leave: Point } => {
    const at = points[i]!;
    const prev = points[(i - 1 + n) % n]!;
    const next = points[(i + 1) % n]!;
    const before = distance(prev, at);
    const after = distance(at, next);
    const cut = Math.min(radius, before / 2, after / 2);
    return {
      enter: { x: at.x + ((prev.x - at.x) * cut) / (before || 1), y: at.y + ((prev.y - at.y) * cut) / (before || 1) },
      at,
      leave: { x: at.x + ((next.x - at.x) * cut) / (after || 1), y: at.y + ((next.y - at.y) * cut) / (after || 1) },
    };
  };
  const curve = (i: number): string => {
    const c = corner(i);
    return `L${num(c.enter.x)},${num(c.enter.y)}Q${num(c.at.x)},${num(c.at.y)} ${num(c.leave.x)},${num(c.leave.y)}`;
  };
  if (closed) {
    const first = corner(0);
    let d = `M${num(first.leave.x)},${num(first.leave.y)}`;
    for (let i = 1; i <= n; i++) d += curve(i % n);
    return `${d}Z`;
  }
  let d = `M${num(points[0]!.x)},${num(points[0]!.y)}`;
  for (let i = 1; i < n - 1; i++) d += curve(i);
  return `${d}L${num(points[n - 1]!.x)},${num(points[n - 1]!.y)}`;
}
