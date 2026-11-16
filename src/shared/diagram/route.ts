import type { DiagramConnector, ShapeKind, Side } from '../model.ts';
import { distance, inflate, type Point, type Rect, rectContains, rectsOverlap, roundedPath, simplify } from './geometry.ts';
import { cylinderRy } from './layout.ts';
import { num } from './svg.ts';
import { blockWidth, lineHeight, wrapText } from './text.ts';

/** What routing needs of a shape: where it is, and its kind where the outline is not the rectangle. */
export interface RouteShape extends Rect {
  id: string;
  kind?: ShapeKind;
}

export type RouteConnector = Pick<DiagramConnector, 'id' | 'from' | 'to'> & Partial<Pick<DiagramConnector, 'label' | 'ends' | 'route' | 'fromSide' | 'toSide'>>;

export interface RouteOptions {
  /** The diagram's reading direction: decides between a vertical and a horizontal route when two shapes sit diagonally. */
  direction?: 'down' | 'right';
}

export interface ArrowHead {
  tip: Point;
  /** Unit vector pointing the way the arrow points. */
  dx: number;
  dy: number;
}

export interface LabelBox extends Rect {
  lines: string[];
}

export interface ConnectorGeometry {
  id: string;
  route: 'elbow' | 'straight' | 'curve';
  fromSide: Side;
  toSide: Side;
  /** The corners of the line from start to end; a curve is given as points along it. */
  points: Point[];
  /** The visible line, stopping short where an arrowhead takes over. */
  path: string;
  /** The whole line from end to end: stroke it wide and transparent to catch the pointer. */
  hitPath: string;
  heads: ArrowHead[];
  label?: LabelBox;
}

export const CONNECTOR_RADIUS = 8;
export const ARROW_LENGTH = 9;
export const CONNECTOR_LABEL_SIZE = 12;
/** Air between the end of a line and the outline it points at. */
const GAP = 3;
const STUB = 16;
const PORT_SPACING = 20;
const CORNER_CLEARANCE = 12;
const LABEL_MAX_WIDTH = 160;
const LABEL_PAD_X = 6;
const LABEL_PAD_Y = 3;

const NORMAL: Record<Side, Point> = { top: { x: 0, y: -1 }, right: { x: 1, y: 0 }, bottom: { x: 0, y: 1 }, left: { x: -1, y: 0 } };
const OPPOSITE: Record<Side, Side> = { top: 'bottom', right: 'left', bottom: 'top', left: 'right' };
const horizontal = (side: Side): boolean => side === 'left' || side === 'right';

type Mode = 'normal' | 'inside' | 'overlap' | 'self';

interface Plan {
  connector: RouteConnector;
  route: 'elbow' | 'straight' | 'curve';
  a: RouteShape;
  b: RouteShape;
  mode: Mode;
  fromSide: Side;
  toSide: Side;
  /** Position of each end along its side, as an offset from the middle of the side. */
  fromOffset: number;
  toOffset: number;
}

/**
 * Routes every connector whose two shapes exist. Takes plain rectangles, so an editor can call it
 * with live positions while shapes are dragged. Connectors with a missing end are left out of the result.
 */
export function routeConnectors(shapes: RouteShape[], connectors: RouteConnector[], options: RouteOptions = {}): Map<string, ConnectorGeometry> {
  const byId = new Map(shapes.map((s) => [s.id, s]));
  const plans: Plan[] = [];
  for (const connector of connectors) {
    const a = byId.get(connector.from);
    const b = byId.get(connector.to);
    if (!a || !b) continue;
    const mode: Mode = a === b ? 'self' : rectContains(a, b) || rectContains(b, a) ? 'inside' : rectsOverlap(a, b) ? 'overlap' : 'normal';
    const sides = chooseSides(a, b, mode, connector, options);
    plans.push({ connector, route: connector.route ?? 'elbow', a, b, mode, ...sides, fromOffset: 0, toOffset: 0 });
  }
  straighten(plans, spreadPorts(plans));
  const twins = twinOffsets(plans);

  const result = new Map<string, ConnectorGeometry>();
  for (const plan of plans) {
    const line = plan.route === 'straight' ? straightLine(plan, twins.get(plan) ?? 0) : plan.route === 'curve' ? curvedLine(plan) : elbowLine(plan);
    result.set(plan.connector.id, geometry(plan, line));
  }
  return result;
}

// ─── Sides ──────────────────────────────────────────────────────────────────

function centre(r: Rect): Point {
  return { x: r.x + r.w / 2, y: r.y + r.h / 2 };
}

/** Horizontal and vertical air between two rectangles; negative where they overlap on that axis. */
function gaps(a: Rect, b: Rect): { gx: number; gy: number } {
  return { gx: Math.max(b.x - (a.x + a.w), a.x - (b.x + b.w)), gy: Math.max(b.y - (a.y + a.h), a.y - (b.y + b.h)) };
}

/** The sides of `a` and `b` that face each other. */
function facingSides(a: Rect, b: Rect, direction?: 'down' | 'right'): { fromSide: Side; toSide: Side } {
  const { gx, gy } = gaps(a, b);
  const ca = centre(a);
  const cb = centre(b);
  let vertical: boolean;
  if (gx > 0 && gy > 0) vertical = direction === 'down' ? gy >= 24 : direction === 'right' ? gx < 24 : gy >= gx;
  else if (gx > 0 || gy > 0) vertical = gy > 0;
  else vertical = Math.abs(cb.y - ca.y) >= Math.abs(cb.x - ca.x);
  if (vertical) return cb.y >= ca.y ? { fromSide: 'bottom', toSide: 'top' } : { fromSide: 'top', toSide: 'bottom' };
  return cb.x >= ca.x ? { fromSide: 'right', toSide: 'left' } : { fromSide: 'left', toSide: 'right' };
}

function chooseSides(a: RouteShape, b: RouteShape, mode: Mode, connector: RouteConnector, options: RouteOptions): { fromSide: Side; toSide: Side } {
  let auto: { fromSide: Side; toSide: Side };
  if (mode === 'self') auto = { fromSide: 'right', toSide: 'top' };
  else if (mode === 'inside') {
    // From a shape to the frame around it: leave by the side nearest to the frame and meet the frame from within.
    const inner = rectContains(a, b) ? b : a;
    const outer = inner === a ? b : a;
    const room: Record<Side, number> = {
      top: inner.y - outer.y,
      right: outer.x + outer.w - (inner.x + inner.w),
      bottom: outer.y + outer.h - (inner.y + inner.h),
      left: inner.x - outer.x,
    };
    const pinned = inner === a ? connector.fromSide : connector.toSide;
    const side = pinned ?? (Object.keys(room) as Side[]).reduce((best, s) => (room[s] < room[best] ? s : best), 'top');
    return { fromSide: side, toSide: side };
  } else auto = facingSides(a, b, options.direction);
  return { fromSide: connector.fromSide ?? auto.fromSide, toSide: connector.toSide ?? auto.toSide };
}

// ─── Ports ──────────────────────────────────────────────────────────────────

function sideLength(shape: Rect, side: Side): number {
  return horizontal(side) ? shape.h : shape.w;
}

function clearance(length: number): number {
  return Math.min(CORNER_CLEARANCE, length / 4);
}

/**
 * Gives every line end on the same side of a shape its own place, in the order of where the lines lead.
 * Returns the ends that share their side with another, as `connector id + ' from' | ' to'`.
 */
function spreadPorts(plans: Plan[]): Set<string> {
  const shared = new Set<string>();
  interface End {
    plan: Plan;
    end: 'from' | 'to';
    key: number;
    order: number;
  }
  const sides = new Map<string, End[]>();
  plans.forEach((plan, order) => {
    if (plan.route === 'straight' || plan.mode === 'overlap') return;
    for (const end of ['from', 'to'] as const) {
      const shape = end === 'from' ? plan.a : plan.b;
      const other = end === 'from' ? plan.b : plan.a;
      const side = end === 'from' ? plan.fromSide : plan.toSide;
      if (plan.mode === 'inside' && rectContains(shape, other)) continue;
      const towards = plan.mode === 'self' ? centre(shape) : centre(other);
      const key = `${shape.id} ${side}`;
      sides.set(key, [...(sides.get(key) ?? []), { plan, end, key: horizontal(side) ? towards.y : towards.x, order }]);
    }
  });
  for (const [key, ends] of sides) {
    if (ends.length < 2) continue;
    const first = ends[0]!;
    const shape = first.end === 'from' ? first.plan.a : first.plan.b;
    const side = key.slice(key.lastIndexOf(' ') + 1) as Side;
    const length = sideLength(shape, side);
    const spacing = Math.min(PORT_SPACING, (length - 2 * clearance(length)) / (ends.length - 1));
    ends.sort((p, q) => p.key - q.key || p.order - q.order);
    ends.forEach((e, i) => {
      const offset = (i - (ends.length - 1) / 2) * spacing;
      if (e.end === 'from') e.plan.fromOffset = offset;
      else e.plan.toOffset = offset;
    });
    for (const e of ends) shared.add(`${e.plan.connector.id} ${e.end}`);
  }
  return shared;
}

/**
 * Lines up the two ends of a connector between facing sides when the sides overlap, so the elbow
 * collapses to one straight segment. Only an end that is alone on its side may move.
 */
function straighten(plans: Plan[], shared: Set<string>): void {
  for (const plan of plans) {
    if (plan.mode !== 'normal' || plan.route === 'straight' || plan.toSide !== OPPOSITE[plan.fromSide]) continue;
    const across = horizontal(plan.fromSide);
    const { gx, gy } = gaps(plan.a, plan.b);
    if ((across ? gx : gy) <= 0) continue;
    const mid = (r: Rect): number => (across ? r.y + r.h / 2 : r.x + r.w / 2);
    const range = (r: Rect): [number, number] => {
      const length = across ? r.h : r.w;
      const start = across ? r.y : r.x;
      return [start + clearance(length), start + length - clearance(length)];
    };
    const [a0, a1] = range(plan.a);
    const [b0, b1] = range(plan.b);
    const fromAlone = !shared.has(`${plan.connector.id} from`);
    const toAlone = !shared.has(`${plan.connector.id} to`);
    const from = mid(plan.a) + plan.fromOffset;
    const to = mid(plan.b) + plan.toOffset;
    if (fromAlone && toAlone) {
      const lo = Math.max(a0, b0);
      const hi = Math.min(a1, b1);
      if (lo > hi) continue;
      const common = Math.min(hi, Math.max(lo, (mid(plan.a) + mid(plan.b)) / 2));
      plan.fromOffset = common - mid(plan.a);
      plan.toOffset = common - mid(plan.b);
    } else if (toAlone && from >= b0 && from <= b1) plan.toOffset = from - mid(plan.b);
    else if (fromAlone && to >= a0 && to <= a1) plan.fromOffset = to - mid(plan.a);
  }
}

/** Straight connectors between the same two shapes run side by side instead of on top of each other. */
function twinOffsets(plans: Plan[]): Map<Plan, number> {
  const pairs = new Map<string, Plan[]>();
  for (const plan of plans) {
    if (plan.route !== 'straight' || plan.mode === 'self') continue;
    const key = [plan.a.id, plan.b.id].sort().join(' ');
    pairs.set(key, [...(pairs.get(key) ?? []), plan]);
  }
  const offsets = new Map<Plan, number>();
  for (const twins of pairs.values()) {
    if (twins.length < 2) continue;
    twins.forEach((plan, i) => {
      const offset = (i - (twins.length - 1) / 2) * 12;
      offsets.set(plan, plan.a.id < plan.b.id ? offset : -offset);
    });
  }
  return offsets;
}

/** How far inside the bounding box the outline of a shape lies, at `offset` from the middle of a side. */
function outlineInset(shape: RouteShape, side: Side, offset: number): number {
  const along = sideLength(shape, side);
  const depth = horizontal(side) ? shape.w : shape.h;
  const t = Math.min(1, Math.abs(offset) / (along / 2));
  if (shape.kind === 'diamond') return (t * depth) / 2;
  if (shape.kind === 'pill') {
    const r = Math.min(shape.w, shape.h) / 2;
    const intoCorner = Math.abs(offset) - (along / 2 - r);
    return intoCorner > 0 ? r - Math.sqrt(Math.max(0, r * r - intoCorner * intoCorner)) : 0;
  }
  if (shape.kind === 'cylinder' && !horizontal(side)) {
    return cylinderRy(shape.w) * (1 - Math.sqrt(1 - t * t));
  }
  return 0;
}

/** Where a side meets the bounding box at an offset from its middle. */
function boxPoint(shape: Rect, side: Side, offset: number): Point {
  const c = centre(shape);
  if (side === 'top') return { x: c.x + offset, y: shape.y };
  if (side === 'bottom') return { x: c.x + offset, y: shape.y + shape.h };
  if (side === 'left') return { x: shape.x, y: c.y + offset };
  return { x: shape.x + shape.w, y: c.y + offset };
}

function along(p: Point, direction: Point, by: number): Point {
  return { x: p.x + direction.x * by, y: p.y + direction.y * by };
}

/** Where a line ends at a side: on the outline, held off by the gap. */
function port(shape: RouteShape, side: Side, offset: number): Point {
  return along(boxPoint(shape, side, offset), NORMAL[side], GAP - outlineInset(shape, side, offset));
}

// ─── Lines ──────────────────────────────────────────────────────────────────

interface Line {
  points: Point[];
  /** Cubic control points when the line is a curve. */
  curve?: [Point, Point, Point, Point];
}

function insideLine(plan: Plan): Line {
  const inner = rectContains(plan.a, plan.b) ? plan.b : plan.a;
  const outer = inner === plan.a ? plan.b : plan.a;
  const side = plan.fromSide;
  const start = port(inner, side, inner === plan.a ? plan.fromOffset : plan.toOffset);
  const edge = side === 'top' ? outer.y : side === 'bottom' ? outer.y + outer.h : side === 'left' ? outer.x : outer.x + outer.w;
  const end = horizontal(side) ? { x: edge - NORMAL[side].x * GAP, y: start.y } : { x: start.x, y: edge - NORMAL[side].y * GAP };
  return { points: inner === plan.a ? [start, end] : [end, start] };
}

function elbowLine(plan: Plan): Line {
  if (plan.mode === 'inside') return insideLine(plan);
  const from = port(plan.a, plan.fromSide, plan.fromOffset);
  const to = port(plan.b, plan.toSide, plan.toOffset);
  if (plan.mode === 'overlap') return { points: [from, to] };
  const { gx, gy } = gaps(plan.a, plan.b);
  const air = plan.mode === 'self' ? 2 * STUB : Math.max(gx, gy);
  if (air < 2 * (GAP + 2)) return { points: [from, to] };
  const stub = Math.min(STUB, air / 2);
  const path = orthogonalPath(
    along(boxPoint(plan.a, plan.fromSide, plan.fromOffset), NORMAL[plan.fromSide], stub),
    plan.fromSide,
    along(boxPoint(plan.b, plan.toSide, plan.toOffset), NORMAL[plan.toSide], stub),
    plan.toSide,
    plan.a,
    plan.b,
    stub,
  );
  return { points: path ? simplify([from, ...path, to]) : [from, to] };
}

const DIRECTIONS: Point[] = [
  { x: 1, y: 0 },
  { x: 0, y: 1 },
  { x: -1, y: 0 },
  { x: 0, y: -1 },
];
const SIDE_DIRECTION: Record<Side, number> = { right: 0, bottom: 1, left: 2, top: 3 };
const BEND_COST = 40;

/**
 * The right-angled path with the fewest bends from `start` to `end` that stays `margin` clear of both
 * rectangles. Searched on the few lines that matter: through the two points, along the kept-clear
 * borders of the rectangles and down the middle of the gap between them, where a jog is placed by preference.
 */
function orthogonalPath(start: Point, startSide: Side, end: Point, endSide: Side, a: Rect, b: Rect, margin: number): Point[] | undefined {
  const blocks = a === b ? [inflate(a, margin)] : [inflate(a, margin), inflate(b, margin)];
  const { gx, gy } = gaps(a, b);
  const midX = a !== b && gx > 0 ? (Math.max(a.x, b.x) + Math.min(a.x + a.w, b.x + b.w)) / 2 : undefined;
  const midY = a !== b && gy > 0 ? (Math.max(a.y, b.y) + Math.min(a.y + a.h, b.y + b.h)) / 2 : undefined;
  const axis = (values: (number | undefined)[]): number[] => [...new Set(values.filter((v): v is number => v !== undefined).map((v) => Math.round(v * 100) / 100))].sort((p, q) => p - q);
  const xs = axis([start.x, end.x, midX, ...blocks.flatMap((r) => [r.x, r.x + r.w])]);
  const ys = axis([start.y, end.y, midY, ...blocks.flatMap((r) => [r.y, r.y + r.h])]);
  const blocked = (x: number, y: number): boolean => blocks.some((r) => x > r.x + 0.01 && x < r.x + r.w - 0.01 && y > r.y + 0.01 && y < r.y + r.h - 0.01);
  const index = (values: number[], v: number): number => values.indexOf(Math.round(v * 100) / 100);

  const cols = xs.length;
  const rows = ys.length;
  const state = (i: number, j: number, d: number): number => (j * cols + i) * 4 + d;
  const cost = new Array<number>(cols * rows * 4).fill(Infinity);
  const previous = new Array<number>(cols * rows * 4).fill(-1);
  const done = new Array<boolean>(cols * rows * 4).fill(false);
  const origin = state(index(xs, start.x), index(ys, start.y), SIDE_DIRECTION[startSide]);
  const goalI = index(xs, end.x);
  const goalJ = index(ys, end.y);
  const arriving = (SIDE_DIRECTION[endSide] + 2) % 4;
  cost[origin] = 0;

  let best = -1;
  let bestCost = Infinity;
  for (;;) {
    let current = -1;
    for (let s = 0; s < cost.length; s++) if (!done[s] && cost[s]! < (current < 0 ? Infinity : cost[current]!)) current = s;
    if (current < 0 || cost[current]! >= bestCost) break;
    done[current] = true;
    const d = current % 4;
    const i = Math.floor(current / 4) % cols;
    const j = Math.floor(current / 4 / cols);
    if (i === goalI && j === goalJ && d !== (arriving + 2) % 4) {
      const total = cost[current]! + (d === arriving ? 0 : BEND_COST);
      if (total < bestCost) {
        bestCost = total;
        best = current;
      }
    }
    for (let turn = 0; turn < 4; turn++) {
      if (turn === (d + 2) % 4) continue;
      const ni = i + DIRECTIONS[turn]!.x;
      const nj = j + DIRECTIONS[turn]!.y;
      if (ni < 0 || nj < 0 || ni >= cols || nj >= rows) continue;
      const x = xs[ni]!;
      const y = ys[nj]!;
      if (blocked(x, y) || blocked((x + xs[i]!) / 2, (y + ys[j]!) / 2)) continue;
      const length = Math.abs(x - xs[i]!) + Math.abs(y - ys[j]!);
      const preferred = turn % 2 === 0 ? y === round2(midY) : x === round2(midX);
      const next = state(ni, nj, turn);
      const total = cost[current]! + length * (preferred ? 1 : 1.001) + (turn === d ? 0 : BEND_COST);
      if (total < cost[next]!) {
        cost[next] = total;
        previous[next] = current;
      }
    }
  }
  if (best < 0) return undefined;
  const path: Point[] = [];
  for (let s = best; s >= 0; s = previous[s]!) path.unshift({ x: xs[Math.floor(s / 4) % cols]!, y: ys[Math.floor(s / 4 / cols)]! });
  return path;
}

function round2(value: number | undefined): number | undefined {
  return value === undefined ? undefined : Math.round(value * 100) / 100;
}

function curvedLine(plan: Plan): Line {
  if (plan.mode === 'inside') return insideLine(plan);
  const from = port(plan.a, plan.fromSide, plan.fromOffset);
  const to = port(plan.b, plan.toSide, plan.toOffset);
  // Facing sides bend in proportion to the air between them, so a short hop sideways does not bulge.
  const facing = plan.toSide === OPPOSITE[plan.fromSide];
  const axial = horizontal(plan.fromSide) ? Math.abs(to.x - from.x) : Math.abs(to.y - from.y);
  const lateral = horizontal(plan.fromSide) ? Math.abs(to.y - from.y) : Math.abs(to.x - from.x);
  const reach = plan.mode === 'self' ? 48 : Math.max(16, Math.min(120, facing ? axial * 0.5 + lateral * 0.08 : distance(from, to) * 0.45));
  const curve: [Point, Point, Point, Point] = [from, along(from, NORMAL[plan.fromSide], reach), along(to, NORMAL[plan.toSide], reach), to];
  const points: Point[] = [];
  for (let i = 0; i <= 16; i++) points.push(cubicAt(curve, i / 16));
  return { points, curve };
}

function cubicAt([p0, p1, p2, p3]: [Point, Point, Point, Point], t: number): Point {
  const u = 1 - t;
  const a = u * u * u;
  const b = 3 * u * u * t;
  const c = 3 * u * t * t;
  const d = t * t * t;
  return { x: a * p0.x + b * p1.x + c * p2.x + d * p3.x, y: a * p0.y + b * p1.y + c * p2.y + d * p3.y };
}

/** Whether a point lies within the outline of a shape. */
function within(shape: RouteShape, p: Point): boolean {
  const c = centre(shape);
  const dx = Math.abs(p.x - c.x);
  const dy = Math.abs(p.y - c.y);
  if (dx > shape.w / 2 || dy > shape.h / 2) return false;
  if (shape.kind === 'diamond') return dx / (shape.w / 2) + dy / (shape.h / 2) <= 1;
  if (shape.kind === 'pill') {
    const r = Math.min(shape.w, shape.h) / 2;
    const cx = Math.max(0, dx - (shape.w / 2 - r));
    const cy = Math.max(0, dy - (shape.h / 2 - r));
    return cx * cx + cy * cy <= r * r;
  }
  return true;
}

/** Where the way from `inside` (a point within the shape) to `target` leaves the outline, held off by the gap. */
function leaving(shape: RouteShape, inside: Point, target: Point): Point {
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 24; i++) {
    const t = (lo + hi) / 2;
    if (within(shape, { x: inside.x + (target.x - inside.x) * t, y: inside.y + (target.y - inside.y) * t })) lo = t;
    else hi = t;
  }
  const length = distance(inside, target) || 1;
  const t = lo + GAP / length;
  return { x: inside.x + (target.x - inside.x) * t, y: inside.y + (target.y - inside.y) * t };
}

function straightLine(plan: Plan, twinOffset: number): Line {
  if (plan.mode === 'inside') return insideLine(plan);
  if (plan.mode === 'self') return elbowLine(plan);
  const { connector, a, b } = plan;
  let ca = centre(a);
  let cb = centre(b);
  if (twinOffset) {
    const length = distance(ca, cb) || 1;
    const shift = { x: (-(cb.y - ca.y) / length) * twinOffset, y: ((cb.x - ca.x) / length) * twinOffset };
    const limit = Math.min(a.w, a.h, b.w, b.h) / 2 - 4;
    const scale = Math.abs(twinOffset) > limit ? Math.max(0, limit) / Math.abs(twinOffset) : 1;
    ca = { x: ca.x + shift.x * scale, y: ca.y + shift.y * scale };
    cb = { x: cb.x + shift.x * scale, y: cb.y + shift.y * scale };
  }
  const pinnedFrom = connector.fromSide ? port(a, connector.fromSide, 0) : undefined;
  const pinnedTo = connector.toSide ? port(b, connector.toSide, 0) : undefined;
  const from = pinnedFrom ?? leaving(a, ca, pinnedTo ?? cb);
  const to = pinnedTo ?? leaving(b, cb, pinnedFrom ?? ca);
  return { points: [from, to] };
}

// ─── Geometry ───────────────────────────────────────────────────────────────

function geometry(plan: Plan, line: Line): ConnectorGeometry {
  const { connector } = plan;
  const points = line.points;
  const ends = connector.ends ?? 'arrow';
  const first = points[0]!;
  const last = points.at(-1)!;
  const heads: ArrowHead[] = [];
  const headAt = (tip: Point, from: Point): ArrowHead => {
    const length = distance(from, tip) || 1;
    return { tip, dx: (tip.x - from.x) / length, dy: (tip.y - from.y) / length };
  };
  const endTangent = line.curve ? line.curve[2] : points.at(-2)!;
  const startTangent = line.curve ? line.curve[1] : points[1]!;
  if (ends !== 'none') heads.push(headAt(last, endTangent));
  if (ends === 'both') heads.push(headAt(first, startTangent));

  // The stroke stops inside the arrowhead, so a thick or dashed line never blunts the tip.
  const pull = ARROW_LENGTH - 3;
  const shorten = (tip: Point, towards: Point): Point => {
    const room = distance(tip, towards);
    const by = Math.min(pull, Math.max(0, room - 1));
    return { x: tip.x + ((towards.x - tip.x) * by) / (room || 1), y: tip.y + ((towards.y - tip.y) * by) / (room || 1) };
  };
  const drawn = (pts: Point[], curve?: [Point, Point, Point, Point]): string => {
    if (curve) {
      const [p0, p1, p2, p3] = curve;
      return `M${num(p0.x)},${num(p0.y)}C${num(p1.x)},${num(p1.y)} ${num(p2.x)},${num(p2.y)} ${num(p3.x)},${num(p3.y)}`;
    }
    return roundedPath(pts, CONNECTOR_RADIUS);
  };
  // Drawn from the arrow back, so a dashed line always meets its arrowhead with a full dash.
  const backwards = ends === 'arrow';
  let visible: string;
  if (line.curve) {
    const [p0, p1, p2, p3] = line.curve;
    const curve: [Point, Point, Point, Point] = [ends === 'both' ? shorten(p0, p1) : p0, p1, p2, ends !== 'none' ? shorten(p3, p2) : p3];
    visible = drawn(points, backwards ? [curve[3], curve[2], curve[1], curve[0]] : curve);
  } else {
    const trimmed = [...points];
    if (ends !== 'none') trimmed[trimmed.length - 1] = shorten(last, points.at(-2)!);
    if (ends === 'both') trimmed[0] = shorten(first, points[1]!);
    visible = drawn(backwards ? trimmed.reverse() : trimmed);
  }

  const label = connector.label?.trim() ? placeLabel(connector.label, points, plan, Boolean(line.curve)) : undefined;
  return {
    id: connector.id,
    route: plan.route,
    fromSide: plan.fromSide,
    toSide: plan.toSide,
    points,
    path: visible,
    hitPath: drawn(points, line.curve),
    heads,
    ...(label ? { label } : {}),
  };
}

// ─── Labels ─────────────────────────────────────────────────────────────────

function pointAtLength(points: Point[], target: number): Point {
  let walked = 0;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!;
    const b = points[i]!;
    const length = distance(a, b);
    if (walked + length >= target && length > 0) {
      const t = (target - walked) / length;
      return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
    }
    walked += length;
  }
  return points.at(-1)!;
}

/**
 * Puts the label on the line: on the segment that has room for it and lies nearest the middle of
 * the line, clear of the two end shapes whenever any candidate is.
 */
function placeLabel(text: string, points: Point[], plan: Plan, smooth: boolean): LabelBox {
  const lines = wrapText(text, LABEL_MAX_WIDTH, CONNECTOR_LABEL_SIZE, 400);
  const w = Math.ceil(blockWidth(lines, CONNECTOR_LABEL_SIZE, 400)) + 2 * LABEL_PAD_X;
  const h = lines.length * lineHeight(CONNECTOR_LABEL_SIZE) + 2 * LABEL_PAD_Y;
  const lengths = points.slice(1).map((p, i) => distance(points[i]!, p));
  const total = lengths.reduce((sum, l) => sum + l, 0);

  const candidates: { at: Point; penalty: number }[] = [{ at: pointAtLength(points, total / 2), penalty: smooth || points.length === 2 ? 0 : 30 }];
  if (smooth || points.length === 2) {
    for (const t of [0.4, 0.6, 0.3, 0.7]) candidates.push({ at: pointAtLength(points, total * t), penalty: 1 + Math.abs(t - 0.5) * 10 });
  } else {
    let walked = 0;
    lengths.forEach((length, i) => {
      const a = points[i]!;
      const b = points[i + 1]!;
      const level = Math.abs(a.y - b.y) < 0.01;
      const room = level ? length >= w + 2 * CONNECTOR_RADIUS : length >= h + 2 * CONNECTOR_RADIUS;
      const off = Math.abs(walked + length / 2 - total / 2);
      candidates.push({ at: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, penalty: (room ? (level ? 0 : 4) : 60) + off * 0.05 });
      walked += length;
    });
  }
  const box = (at: Point): Rect => ({ x: Math.round(at.x - w / 2), y: Math.round(at.y - h / 2), w, h });
  const ends = plan.mode === 'inside' ? [rectContains(plan.a, plan.b) ? plan.b : plan.a] : [plan.a, plan.b];
  const scored = candidates.map((c) => ({ ...c, penalty: c.penalty + (ends.some((shape) => rectsOverlap(inflate(shape, 2), box(c.at))) ? 1000 : 0) }));
  const best = scored.reduce((p, q) => (q.penalty < p.penalty ? q : p));
  return { ...box(best.at), lines };
}
