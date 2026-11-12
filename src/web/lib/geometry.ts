import { Position } from '@xyflow/react';

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Anchor {
  x: number;
  y: number;
  side: Position;
}

/** Where the line between two rectangles' centers leaves each of them, optionally shifted sideways. */
export function floatingAnchors(a: Rect, b: Rect, shift = 0): { source: Anchor; target: Anchor } {
  const ac = { x: a.x + a.width / 2, y: a.y + a.height / 2 };
  const bc = { x: b.x + b.width / 2, y: b.y + b.height / 2 };
  const dx = bc.x - ac.x;
  const dy = bc.y - ac.y;
  const len = Math.hypot(dx, dy) || 1;
  const ox = (-dy / len) * shift;
  const oy = (dx / len) * shift;
  return {
    source: exit(a, { x: ac.x + ox, y: ac.y + oy }, dx, dy),
    target: exit(b, { x: bc.x + ox, y: bc.y + oy }, -dx, -dy),
  };
}

function exit(r: Rect, from: { x: number; y: number }, dx: number, dy: number): Anchor {
  const tx = dx === 0 ? Infinity : Math.max(0, dx > 0 ? r.x + r.width - from.x : from.x - r.x) / Math.abs(dx);
  const ty = dy === 0 ? Infinity : Math.max(0, dy > 0 ? r.y + r.height - from.y : from.y - r.y) / Math.abs(dy);
  if (tx < ty) return { x: from.x + dx * tx, y: from.y + dy * tx, side: dx > 0 ? Position.Right : Position.Left };
  return { x: from.x + dx * ty, y: from.y + dy * ty, side: dy > 0 ? Position.Bottom : Position.Top };
}

const DIR: Record<Position, { x: number; y: number }> = {
  [Position.Left]: { x: -1, y: 0 },
  [Position.Right]: { x: 1, y: 0 },
  [Position.Top]: { x: 0, y: -1 },
  [Position.Bottom]: { x: 0, y: 1 },
};

/** Outward normal of a node side. */
export function sideNormal(side: Position): { x: number; y: number } {
  return DIR[side];
}

/** A small filled arrowhead whose tip touches the target; returns the head path and the point where the line should stop. */
export function arrowHead(tip: Anchor, length = 7, width = 6): { path: string; base: { x: number; y: number } } {
  const n = sideNormal(tip.side);
  const base = { x: tip.x + n.x * length, y: tip.y + n.y * length };
  const px = -n.y * (width / 2);
  const py = n.x * (width / 2);
  return {
    path: `M ${tip.x} ${tip.y} L ${base.x + px} ${base.y + py} Q ${base.x + n.x * 1.5} ${base.y + n.y * 1.5} ${base.x - px} ${base.y - py} Z`,
    base,
  };
}
