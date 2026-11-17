/** Placement maths of the diagram editor: grid, alignment guides, resizing, and which group a shape falls into. */
import type { DiagramShape } from '../../shared/model.ts';

export const GRID = 8;

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** A line drawn while a shape lines up with another: vertical at `x = at` (axis x) or horizontal at `y = at`. */
export interface Guide {
  axis: 'x' | 'y';
  at: number;
  from: number;
  to: number;
}

export function snap(n: number, grid = GRID): number {
  return Math.round(n / grid) * grid;
}

/** Geometry is stored with one decimal. */
export function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/**
 * How far a moving box shifts to settle: onto the edge or centre of another box when one lies within
 * `threshold` on that axis (with the guides that show it), otherwise onto the grid.
 */
export function snapMove(box: Box, others: Box[], threshold: number): { dx: number; dy: number; guides: Guide[] } {
  const along = (axis: 'x' | 'y') => {
    const lines = (b: Box) => (axis === 'x' ? [b.x, b.x + b.w / 2, b.x + b.w] : [b.y, b.y + b.h / 2, b.y + b.h]);
    const own = lines(box);
    let best: number | undefined;
    for (const other of others) {
      for (const target of lines(other)) {
        for (const line of own) {
          const d = target - line;
          if (Math.abs(d) <= threshold && (best === undefined || Math.abs(d) < Math.abs(best))) best = d;
        }
      }
    }
    if (best === undefined) return { shift: snap(axis === 'x' ? box.x : box.y) - (axis === 'x' ? box.x : box.y), guides: [] };
    const shift = best;
    const moved = axis === 'x' ? { ...box, x: box.x + shift } : { ...box, y: box.y + shift };
    const guides: Guide[] = [];
    for (const other of others) {
      for (const target of lines(other)) {
        if (!lines(moved).some((line) => Math.abs(line - target) < 0.5)) continue;
        const [lo, hi] = axis === 'x' ? [Math.min(moved.y, other.y), Math.max(moved.y + moved.h, other.y + other.h)] : [Math.min(moved.x, other.x), Math.max(moved.x + moved.w, other.x + other.w)];
        const same = guides.find((g) => Math.abs(g.at - target) < 0.5);
        if (same) {
          same.from = Math.min(same.from, lo);
          same.to = Math.max(same.to, hi);
        } else guides.push({ axis, at: target, from: lo, to: hi });
      }
    }
    return { shift, guides };
  };
  const x = along('x');
  const y = along('y');
  return { dx: x.shift, dy: y.shift, guides: [...x.guides, ...y.guides] };
}

export type ResizeHandle = 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w' | 'nw';

/**
 * The box after dragging a resize handle by (dx, dy): moved edges land on the grid, and the box never gets
 * smaller than `min` allows (the width is clamped first, then the height for that width), keeping the
 * opposite edges where they were.
 */
export function resizeBox(start: Box, handle: ResizeHandle, dx: number, dy: number, min: (w: number) => { w: number; h: number }): Box {
  const right = start.x + start.w;
  const bottom = start.y + start.h;
  let left = start.x;
  let top = start.y;
  let r = right;
  let b = bottom;
  if (handle.includes('w')) left = snap(start.x + dx);
  if (handle.includes('e')) r = snap(right + dx);
  if (handle.includes('n')) top = snap(start.y + dy);
  if (handle.includes('s')) b = snap(bottom + dy);
  const w = Math.max(r - left, min(r - left).w);
  if (handle.includes('w')) left = right - w;
  const h = Math.max(b - top, min(w).h);
  if (handle.includes('n')) top = bottom - h;
  return { x: left, y: top, w, h };
}

type Placed = Pick<DiagramShape, 'id' | 'kind' | 'parent'> & Box;

/** The innermost group whose box holds `point`, leaving out `exclude` (the shapes being moved). */
export function groupAt(point: { x: number; y: number }, shapes: Placed[], exclude: ReadonlySet<string> = new Set()): string | undefined {
  let best: Placed | undefined;
  for (const s of shapes) {
    if (s.kind !== 'group' || exclude.has(s.id)) continue;
    if (point.x < s.x || point.x > s.x + s.w || point.y < s.y || point.y > s.y + s.h) continue;
    if (!best || s.w * s.h < best.w * best.h) best = s;
  }
  return best?.id;
}

/** Every shape inside the given ones, at any depth, not counting the given ones themselves. */
export function descendants(shapes: Pick<DiagramShape, 'id' | 'parent'>[], ids: Iterable<string>): Set<string> {
  const roots = new Set(ids);
  const children = new Map<string, string[]>();
  for (const s of shapes) if (s.parent) children.set(s.parent, [...(children.get(s.parent) ?? []), s.id]);
  const out = new Set<string>();
  const stack = [...roots];
  while (stack.length) {
    for (const child of children.get(stack.pop()!) ?? []) {
      if (out.has(child) || roots.has(child)) continue;
      out.add(child);
      stack.push(child);
    }
  }
  return out;
}

/** The shapes among `ids` that are not inside another one of `ids`. */
export function outermost(shapes: Pick<DiagramShape, 'id' | 'parent'>[], ids: Iterable<string>): string[] {
  const set = new Set(ids);
  const parent = new Map(shapes.map((s) => [s.id, s.parent]));
  return [...set].filter((id) => {
    const seen = new Set<string>();
    for (let p = parent.get(id); p && !seen.has(p); p = parent.get(p)) {
      if (set.has(p)) return false;
      seen.add(p);
    }
    return true;
  });
}

/** The point halfway along a polyline. */
export function midpoint(points: { x: number; y: number }[]): { x: number; y: number } {
  if (points.length < 2) return points[0] ?? { x: 0, y: 0 };
  const lengths = points.slice(1).map((p, i) => Math.hypot(p.x - points[i]!.x, p.y - points[i]!.y));
  let rest = lengths.reduce((a, b) => a + b, 0) / 2;
  for (let i = 0; i < lengths.length; i++) {
    const len = lengths[i]!;
    if (rest <= len && len > 0) {
      const a = points[i]!;
      const b = points[i + 1]!;
      return { x: a.x + ((b.x - a.x) * rest) / len, y: a.y + ((b.y - a.y) * rest) / len };
    }
    rest -= len;
  }
  return points.at(-1)!;
}
