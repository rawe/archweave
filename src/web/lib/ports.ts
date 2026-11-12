/**
 * Where threads attach to nodes. Each thread leaves and enters on the sides
 * that face each other; threads sharing a side are spread along it in the
 * order of their other ends, so they neither stack nor cross at the node.
 */
import { Position } from '@xyflow/react';
import type { Anchor, Rect } from './geometry.ts';
import { sideNormal } from './geometry.ts';

export interface PortEdge {
  id: string;
  from: string;
  to: string;
}

export interface Route {
  source: Anchor;
  target: Anchor;
}

const center = (r: Rect) => ({ x: r.x + r.width / 2, y: r.y + r.height / 2 });

/** The facing sides of two rectangles: horizontal when they are apart sideways at least as much as vertically. */
export function facingSides(a: Rect, b: Rect): [Position, Position] {
  const gx = Math.max(b.x - (a.x + a.width), a.x - (b.x + b.width));
  const gy = Math.max(b.y - (a.y + a.height), a.y - (b.y + b.height));
  const ca = center(a);
  const cb = center(b);
  // Overlapping in both directions: fall back to the dominant direction between the centers.
  // Nodes in different columns always meet sideways, so threads run through the gaps between columns.
  const horizontal = gx < 0 && gy < 0 ? Math.abs(cb.x - ca.x) >= Math.abs(cb.y - ca.y) : gx >= 12 || gx >= gy;
  if (horizontal) return cb.x >= ca.x ? [Position.Right, Position.Left] : [Position.Left, Position.Right];
  return cb.y >= ca.y ? [Position.Bottom, Position.Top] : [Position.Top, Position.Bottom];
}

export function assignPorts(rects: ReadonlyMap<string, Rect>, edges: readonly PortEdge[]): Map<string, Route> {
  type End = { edge: string; end: 'source' | 'target'; along: number; tie: number };
  const slots = new Map<string, End[]>();
  const sides = new Map<string, [Position, Position]>();
  const push = (node: string, side: Position, end: End) => {
    const key = `${node}|${side}`;
    (slots.get(key) ?? slots.set(key, []).get(key)!).push(end);
  };

  for (const e of edges) {
    const a = rects.get(e.from);
    const b = rects.get(e.to);
    if (!a || !b || e.from === e.to) continue;
    const [sa, sb] = facingSides(a, b);
    sides.set(e.id, [sa, sb]);
    const ca = center(a);
    const cb = center(b);
    const vertical = (s: Position) => s === Position.Left || s === Position.Right;
    // Outgoing before incoming on a shared side keeps a pair of opposite threads apart.
    push(e.from, sa, { edge: e.id, end: 'source', along: vertical(sa) ? cb.y : cb.x, tie: 0 });
    push(e.to, sb, { edge: e.id, end: 'target', along: vertical(sb) ? ca.y : ca.x, tie: 1 });
  }

  const points = new Map<string, Partial<Route>>();
  for (const [key, ends] of slots) {
    const [node, side] = key.split('|') as [string, Position];
    const r = rects.get(node)!;
    const vertical = side === Position.Left || side === Position.Right;
    const length = vertical ? r.height : r.width;
    const start = vertical ? r.y : r.x;
    ends.sort((p, q) => p.along - q.along || p.tie - q.tie || p.edge.localeCompare(q.edge));
    const inset = Math.min(12, length * 0.22);
    const usable = Math.max(0, length - inset * 2);
    const step = ends.length > 1 ? Math.min(vertical ? 12 : 18, usable / (ends.length - 1)) : 0;
    const mid = start + length / 2;
    ends.forEach((end, i) => {
      const offset = mid + (i - (ends.length - 1) / 2) * step;
      const anchor: Anchor = vertical
        ? { x: side === Position.Right ? r.x + r.width : r.x, y: offset, side }
        : { x: offset, y: side === Position.Bottom ? r.y + r.height : r.y, side };
      const route = points.get(end.edge) ?? {};
      route[end.end] = anchor;
      points.set(end.edge, route);
    });
  }

  const out = new Map<string, Route>();
  for (const [id, route] of points) if (route.source && route.target) out.set(id, route as Route);
  return out;
}

/** One smooth curve between two anchors, leaving and entering along the side normals. */
export function curve(a: { x: number; y: number; side: Position }, b: { x: number; y: number; side: Position }): { path: string; mid: { x: number; y: number } } {
  const na = sideNormal(a.side);
  const nb = sideNormal(b.side);
  const along = Math.abs(na.x) ? Math.abs(b.x - a.x) : Math.abs(b.y - a.y);
  const k = Math.max(18, Math.min(140, along * 0.5));
  const c1 = { x: a.x + na.x * k, y: a.y + na.y * k };
  const c2 = { x: b.x + nb.x * k, y: b.y + nb.y * k };
  const mid = {
    x: 0.125 * a.x + 0.375 * c1.x + 0.375 * c2.x + 0.125 * b.x,
    y: 0.125 * a.y + 0.375 * c1.y + 0.375 * c2.y + 0.125 * b.y,
  };
  return { path: `M ${a.x} ${a.y} C ${c1.x} ${c1.y}, ${c2.x} ${c2.y}, ${b.x} ${b.y}`, mid };
}
