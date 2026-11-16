import type { DiagramConnector, ShapeKind, Side } from '../model.ts';
import { distance, inflate, type Point, type Rect, rectContains, rectsOverlap, roundedPath, simplify } from './geometry.ts';
import { cylinderRy } from './layout.ts';
import { num } from './svg.ts';
import { blockWidth, lineHeight, wrapText } from './text.ts';

/**
 * What routing needs of a shape: where it is, its kind where the outline is not the rectangle, and the
 * group it sits in, because a line may cross the frames around its own ends and no other shape.
 */
export interface RouteShape extends Rect {
  id: string;
  kind?: ShapeKind;
  parent?: string;
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
/** The distance a detour keeps from the shapes it passes. */
const DETOUR_CLEARANCE = 12;
/** Nearer than this to a foreign shape a detour never runs, also where two shapes leave less than twice the clearance. */
const DETOUR_LIMIT = 6;
/** A line this close to a foreign shape counts as running through it and is rerouted. */
const BLOCKED_WITHIN = 4;
/** The step by which a detour moves aside from a line it would otherwise lie on. */
const LANE = 8;
/** How much cheaper a route from other sides must be before an unpinned side gives way to it. */
const SWAP_GAIN = 100;
/** What a unit of length costs where a detour would lie on another connector's line. */
const BUSY_COST = 3;

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
 *
 * Every connector is first routed between its two ends alone. An elbow whose line would then run through
 * a shape that is neither one of its ends nor a group around them is routed again around what is in its way;
 * all other lines stay exactly as the direct route drew them.
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
  const direct = (plan: Plan): Line => (plan.route === 'straight' ? straightLine(plan, twins.get(plan) ?? 0) : plan.route === 'curve' ? curvedLine(plan) : elbowLine(plan));

  let lines = plans.map(direct);
  if (shapes.length > 2) {
    const inTheWay = obstacleFinder(shapes, byId);
    const blocked = (): Plan[] => plans.filter((plan, i) => plan.route === 'elbow' && plan.mode === 'normal' && inTheWay(plan).some((o) => runsThrough(lines[i]!.points, o, BLOCKED_WITHIN)));
    let detours = blocked();
    if (detours.length) {
      let swapped = false;
      const tried = new Map<string, Point[] | undefined>();
      for (const plan of detours) swapped = swapSides(plan, inTheWay(plan), tried) || swapped;
      if (swapped) {
        for (const plan of plans) plan.fromOffset = plan.toOffset = 0;
        straighten(plans, spreadPorts(plans));
        lines = plans.map(direct);
        detours = blocked();
      }
      const laid: Laid[] = plans.flatMap((plan, i) => (detours.includes(plan) ? [] : laidSegments(plan, lines[i]!.points)));
      // The longest detour takes the lane nearest the obstacle and shorter ones nest outside it, so they do not cross.
      const found = detours.map((plan) => ({ plan, i: plans.indexOf(plan), around: detour(plan, inTheWay(plan), tried) }));
      found.sort((p, q) => (q.around ? routeCost(q.around) : 0) - (p.around ? routeCost(p.around) : 0) || p.i - q.i);
      for (const { plan, i, around } of found) {
        if (around) {
          const obstacles = inTheWay(plan);
          const others = laid.filter((l) => l.from !== plan.connector.from && l.to !== plan.connector.to);
          let points = takeLane(around, plan, obstacles, others);
          // No free lane beside the lines already there: look for another way, which may well be the same one.
          if (liesOnTop(points, others)) points = takeLane(detour(plan, obstacles, tried, others) ?? around, plan, obstacles, others);
          lines[i] = { points };
        }
        laid.push(...laidSegments(plan, lines[i]!.points));
      }
    }
  }

  const solid = shapes.filter((s) => s.kind !== 'group');
  const labels: Rect[] = [];
  const result = new Map<string, ConnectorGeometry>();
  plans.forEach((plan, i) => {
    const made = geometry(plan, lines[i]!, solid, labels);
    if (made.label) labels.push(made.label);
    result.set(plan.connector.id, made);
  });
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

/** How far a line runs straight out of its end shapes before it may turn; undefined when the shapes leave no room for an elbow. */
function stubLength(plan: Plan): number | undefined {
  const { gx, gy } = gaps(plan.a, plan.b);
  const air = plan.mode === 'self' ? 2 * STUB : Math.max(gx, gy);
  return air < 2 * (GAP + 2) ? undefined : Math.min(STUB, air / 2);
}

function elbowLine(plan: Plan): Line {
  if (plan.mode === 'inside') return insideLine(plan);
  const from = port(plan.a, plan.fromSide, plan.fromOffset);
  const to = port(plan.b, plan.toSide, plan.toOffset);
  if (plan.mode === 'overlap') return { points: [from, to] };
  const stub = stubLength(plan);
  if (stub === undefined) return { points: [from, to] };
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

// ─── Detours ────────────────────────────────────────────────────────────────

/**
 * For a connector, the shapes its line must go around: all but its two ends, the groups around either
 * end (by `parent` or by position), and whatever lies on an end shape, which no route could avoid.
 */
function obstacleFinder(shapes: RouteShape[], byId: Map<string, RouteShape>): (plan: Plan) => RouteShape[] {
  const around = new Map<string, Set<string>>();
  const groupsAround = (shape: RouteShape): Set<string> => {
    let found = around.get(shape.id);
    if (!found) {
      found = new Set();
      for (let at = shape.parent ? byId.get(shape.parent) : undefined; at && !found.has(at.id); at = at.parent ? byId.get(at.parent) : undefined) found.add(at.id);
      around.set(shape.id, found);
    }
    return found;
  };
  const cache = new Map<string, RouteShape[]>();
  return (plan) => {
    const key = `${plan.a.id} ${plan.b.id}`;
    let obstacles = cache.get(key);
    if (!obstacles) {
      const { a, b } = plan;
      const own = new Set([...groupsAround(a), ...groupsAround(b)]);
      obstacles = shapes.filter((s) => s !== a && s !== b && !own.has(s.id) && !rectsOverlap(s, a) && !rectsOverlap(s, b));
      cache.set(key, obstacles);
    }
    return obstacles;
  };
}

/** Whether a line passes through a rectangle grown by `within`; touching its border does not count. */
function runsThrough(points: Point[], rect: Rect, within: number): boolean {
  const x0 = rect.x - within + 0.01;
  const y0 = rect.y - within + 0.01;
  const x1 = rect.x + rect.w + within - 0.01;
  const y1 = rect.y + rect.h + within - 0.01;
  for (let i = 1; i < points.length; i++) {
    const p = points[i - 1]!;
    const q = points[i]!;
    if (Math.max(p.x, q.x) <= x0 || Math.min(p.x, q.x) >= x1 || Math.max(p.y, q.y) <= y0 || Math.min(p.y, q.y) >= y1) continue;
    const dx = q.x - p.x;
    const dy = q.y - p.y;
    let t0 = 0;
    let t1 = 1;
    let outside = false;
    for (const [d, lo, hi] of [[dx, x0 - p.x, x1 - p.x], [dy, y0 - p.y, y1 - p.y]] as const) {
      if (d === 0) {
        if (lo >= 0 || hi <= 0) outside = true;
        continue;
      }
      t0 = Math.max(t0, Math.min(lo / d, hi / d));
      t1 = Math.min(t1, Math.max(lo / d, hi / d));
    }
    if (!outside && t1 - t0 > 0 && (t1 - t0) * Math.hypot(dx, dy) > 0.5) return true;
  }
  return false;
}

/** What a route costs: its length, and a bend as much as forty units of it. */
function routeCost(points: Point[]): number {
  let cost = (points.length - 2) * BEND_COST;
  for (let i = 1; i < points.length; i++) cost += distance(points[i - 1]!, points[i]!);
  return cost;
}

/**
 * Lets a blocked connector leave or arrive by another side when that route is clearly better than
 * the detour from the sides it has. Pinned sides stay. Returns whether a side changed.
 */
function swapSides(plan: Plan, obstacles: RouteShape[], found: Map<string, Point[] | undefined>): boolean {
  const { connector, a, b } = plan;
  if (connector.fromSide && connector.toSide) return false;
  const current = detour(plan, obstacles, found);
  const reach = Math.abs(centre(b).x - centre(a).x) + Math.abs(centre(b).y - centre(a).y);
  // The plain detour, out and back with four corners or fewer, is kept: other sides could not better it by enough.
  if (current && current.length <= 6 && routeCost(current) < reach + 6 * BEND_COST) return false;
  const facing = (shape: Rect, other: Rect, kept: Side): Side[] => {
    const dx = centre(other).x - centre(shape).x;
    const dy = centre(other).y - centre(shape).y;
    return (Object.keys(NORMAL) as Side[]).filter((side) => side === kept || NORMAL[side].x * dx + NORMAL[side].y * dy >= 0);
  };
  let best: { fromSide: Side; toSide: Side } | undefined;
  let bestCost = current ? routeCost(current) - SWAP_GAIN : Infinity;
  for (const fromSide of connector.fromSide ? [plan.fromSide] : facing(a, b, plan.fromSide)) {
    for (const toSide of connector.toSide ? [plan.toSide] : facing(b, a, plan.toSide)) {
      if (fromSide === plan.fromSide && toSide === plan.toSide) continue;
      const tried = detour({ ...plan, fromSide, toSide, fromOffset: fromSide === plan.fromSide ? plan.fromOffset : 0, toOffset: toSide === plan.toSide ? plan.toOffset : 0 }, obstacles, found);
      const cost = tried ? routeCost(tried) : Infinity;
      if (cost < bestCost) {
        bestCost = cost;
        best = { fromSide, toSide };
      }
    }
  }
  if (!best) return false;
  plan.fromSide = best.fromSide;
  plan.toSide = best.toSide;
  return true;
}

/**
 * The route of a connector around the shapes in its way, or undefined when there is none. The search
 * starts with the obstacles near the two ends and takes in further ones only as a found route runs
 * into them, so a connector in a corner of a large diagram is not searched across all of it.
 * Stretches on top of the `laid` lines of other connectors cost several times their length; searches
 * without them are remembered in `found` for the rest of the routing pass.
 */
function detour(plan: Plan, obstacles: RouteShape[], found: Map<string, Point[] | undefined>, laid?: Laid[]): Point[] | undefined {
  const key = `${plan.connector.id} ${plan.fromSide} ${plan.toSide} ${plan.fromOffset} ${plan.toOffset}`;
  if (!laid && found.has(key)) return found.get(key);
  const points = searchDetour(plan, obstacles, laid ?? []);
  if (!laid) found.set(key, points);
  return points;
}

function searchDetour(plan: Plan, obstacles: RouteShape[], laid: Laid[]): Point[] | undefined {
  const full = stubLength(plan);
  if (full === undefined) return undefined;
  const { a, b } = plan;
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  const region = inflate({ x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y }, 3 * DETOUR_CLEARANCE);
  const from = port(a, plan.fromSide, plan.fromOffset);
  const to = port(b, plan.toSide, plan.toOffset);
  for (const stub of full > 8 ? [full, 8] : [full]) {
    const start = along(boxPoint(a, plan.fromSide, plan.fromOffset), NORMAL[plan.fromSide], stub);
    const end = along(boxPoint(b, plan.toSide, plan.toOffset), NORMAL[plan.toSide], stub);
    let known = obstacles.filter((o) => rectsOverlap(o, region));
    for (let round = 0; round < 8; round++) {
      const path = detourPath(start, plan.fromSide, end, plan.toSide, a, b, stub, round < 7 ? known : obstacles, laid);
      if (!path) break;
      const points = simplify([from, ...path, to]);
      const missed = obstacles.filter((o) => !known.includes(o) && runsThrough(points, o, DETOUR_LIMIT));
      if (!missed.length) return points;
      known = [...known, ...missed];
    }
  }
  return undefined;
}

/**
 * The cheapest right-angled path from `start` to `end` that stays clear of the two end shapes and of
 * the obstacles, by length and bends. Searched with A* on the lines through the two points, along the
 * kept-clear borders of everything and down the middle of the gap between the ends.
 */
function detourPath(start: Point, startSide: Side, end: Point, endSide: Side, a: Rect, b: Rect, margin: number, obstacles: Rect[], laid: Laid[]): Point[] | undefined {
  const blocks = [inflate(a, margin), inflate(b, margin), ...obstacles.map((o) => inflate(o, DETOUR_LIMIT))];
  const { gx, gy } = gaps(a, b);
  const midX = round2(gx > 0 ? (Math.max(a.x, b.x) + Math.min(a.x + a.w, b.x + b.w)) / 2 : undefined);
  const midY = round2(gy > 0 ? (Math.max(a.y, b.y) + Math.min(a.y + a.h, b.y + b.h)) / 2 : undefined);
  const axis = (values: (number | undefined)[]): number[] => [...new Set(values.filter((v): v is number => v !== undefined).map((v) => Math.round(v * 100) / 100))].sort((p, q) => p - q);
  const tracks = obstacles.map((o) => inflate(o, DETOUR_CLEARANCE));
  const xs = axis([start.x, end.x, midX, ...[blocks[0]!, blocks[1]!, ...tracks].flatMap((r) => [r.x, r.x + r.w])]);
  const ys = axis([start.y, end.y, midY, ...[blocks[0]!, blocks[1]!, ...tracks].flatMap((r) => [r.y, r.y + r.h])]);
  const cols = xs.length;
  const rows = ys.length;
  // Among equal routes the one that keeps longest to the lines straight out of its two ends and the middle of the gap:
  // a detour then leaves the direct way as late and rejoins it as early as it can.
  const likedX = new Set([midX, horizontal(startSide) ? undefined : round2(start.x), horizontal(endSide) ? undefined : round2(end.x)]);
  const likedY = new Set([midY, horizontal(startSide) ? round2(start.y) : undefined, horizontal(endSide) ? round2(end.y) : undefined]);
  // Next come the lines at the even distance from what is passed, so a turn sits beside an obstacle and not just anywhere.
  const besideX = new Set(tracks.flatMap((r) => [round2(r.x), round2(r.x + r.w)]));
  const besideY = new Set(tracks.flatMap((r) => [round2(r.y), round2(r.y + r.h)]));

  // Steps that would lie on another connector's line.
  const busyRight = new Uint8Array(cols * rows);
  const busyDown = new Uint8Array(cols * rows);
  for (const l of laid) {
    const [across, alongAxis, busy] = l.level ? [ys, xs, busyRight] : [xs, ys, busyDown];
    for (let p = 0; p < across.length; p++) {
      if (Math.abs(across[p]! - l.at) >= LANE / 2) continue;
      for (let q = 0; q + 1 < alongAxis.length; q++) {
        if (alongAxis[q + 1]! > l.lo + 0.01 && alongAxis[q]! < l.hi - 0.01) busy[l.level ? p * cols + q : q * cols + p] = 1;
      }
    }
  }

  // What is closed: grid points inside a block, and the steps to the right of and below a point that cut through one.
  const closed = new Uint8Array(cols * rows);
  const closedRight = new Uint8Array(cols * rows);
  const closedDown = new Uint8Array(cols * rows);
  for (const r of blocks) {
    const x0 = r.x + 0.01;
    const x1 = r.x + r.w - 0.01;
    const y0 = r.y + 0.01;
    const y1 = r.y + r.h - 0.01;
    // The first row and column whose step onwards reaches into the block.
    let j = 0;
    while (j + 1 < rows && ys[j + 1]! <= y0) j++;
    let first = 0;
    while (first + 1 < cols && xs[first + 1]! <= x0) first++;
    for (; j < rows && ys[j]! < y1; j++) {
      const rowInside = ys[j]! > y0;
      const stepDown = j + 1 < rows && ys[j + 1]! > y0;
      for (let i = first; i < cols && xs[i]! < x1; i++) {
        const colInside = xs[i]! > x0;
        if (rowInside && colInside) closed[j * cols + i] = 1;
        if (rowInside && i + 1 < cols && xs[i + 1]! > x0) closedRight[j * cols + i] = 1;
        if (stepDown && colInside) closedDown[j * cols + i] = 1;
      }
    }
  }

  const index = (values: number[], v: number): number => values.indexOf(Math.round(v * 100) / 100);
  const startNode = index(ys, start.y) * cols + index(xs, start.x);
  const goalI = index(xs, end.x);
  const goalJ = index(ys, end.y);
  if (closed[startNode] || closed[goalJ * cols + goalI]) return undefined;
  const arriving = (SIDE_DIRECTION[endSide] + 2) % 4;
  const goalX = xs[goalI]!;
  const goalY = ys[goalJ]!;

  const states = cols * rows * 4;
  const cost = new Float64Array(states).fill(Infinity);
  const previous = new Int32Array(states).fill(-1);
  const done = new Uint8Array(states);
  // A binary heap of states ordered by estimated total, then by state, so equal routes always resolve alike.
  // A state enters at most once per way into it, which bounds the heap.
  const heapKey = new Float64Array(states * 3 + 1);
  const heapState = new Int32Array(states * 3 + 1);
  let heapSize = 0;

  const origin = startNode * 4 + SIDE_DIRECTION[startSide];
  cost[origin] = 0;
  heapKey[0] = Math.abs(goalX - start.x) + Math.abs(goalY - start.y);
  heapState[0] = origin;
  heapSize = 1;
  let best = -1;
  let bestCost = Infinity;
  while (heapSize > 0 && heapKey[0]! < bestCost) {
    const current: number = heapState[0]!;
    heapSize--;
    if (heapSize > 0) {
      const key = heapKey[heapSize]!;
      const state = heapState[heapSize]!;
      let at = 0;
      for (;;) {
        let child = 2 * at + 1;
        if (child >= heapSize) break;
        if (child + 1 < heapSize && (heapKey[child + 1]! < heapKey[child]! || (heapKey[child + 1] === heapKey[child] && heapState[child + 1]! < heapState[child]!))) child++;
        if (key < heapKey[child]! || (key === heapKey[child] && state < heapState[child]!)) break;
        heapKey[at] = heapKey[child]!;
        heapState[at] = heapState[child]!;
        at = child;
      }
      heapKey[at] = key;
      heapState[at] = state;
    }
    if (done[current]) continue;
    done[current] = 1;
    const d = current % 4;
    const node = current >> 2;
    const i = node % cols;
    const j = (node - i) / cols;
    if (i === goalI && j === goalJ) {
      if (d !== (arriving + 2) % 4) {
        const total = cost[current]! + (d === arriving ? 0 : BEND_COST);
        if (total < bestCost) {
          bestCost = total;
          best = current;
        }
      }
      continue;
    }
    for (let turn = 0; turn < 4; turn++) {
      if (turn === (d + 2) % 4) continue;
      const ni = i + DIRECTIONS[turn]!.x;
      const nj = j + DIRECTIONS[turn]!.y;
      if (ni < 0 || nj < 0 || ni >= cols || nj >= rows) continue;
      const to = nj * cols + ni;
      if (closed[to]) continue;
      if (turn === 0 ? closedRight[node] : turn === 2 ? closedRight[to] : turn === 1 ? closedDown[node] : closedDown[to]) continue;
      const x = xs[ni]!;
      const y = ys[nj]!;
      const length = Math.abs(x - xs[i]!) + Math.abs(y - ys[j]!);
      const busy = turn === 0 ? busyRight[node] : turn === 2 ? busyRight[to] : turn === 1 ? busyDown[node] : busyDown[to];
      const level = turn % 2 === 0;
      const liking = busy ? BUSY_COST : (level ? likedY.has(y) : likedX.has(x)) ? 1 : (level ? besideY.has(y) : besideX.has(x)) ? 1.0005 : 1.001;
      const next = to * 4 + turn;
      const total = cost[current]! + length * liking + (turn === d ? 0 : BEND_COST);
      if (total >= cost[next]!) continue;
      cost[next] = total;
      previous[next] = current;
      const key = total + Math.abs(goalX - x) + Math.abs(goalY - y);
      let at = heapSize++;
      while (at > 0) {
        const up = (at - 1) >> 1;
        if (heapKey[up]! < key || (heapKey[up] === key && heapState[up]! < next)) break;
        heapKey[at] = heapKey[up]!;
        heapState[at] = heapState[up]!;
        at = up;
      }
      heapKey[at] = key;
      heapState[at] = next;
    }
  }
  if (best < 0) return undefined;
  const path: Point[] = [];
  for (let s = best; s >= 0; s = previous[s]!) path.unshift({ x: xs[(s >> 2) % cols]!, y: ys[Math.floor((s >> 2) / cols)]! });
  return path;
}

/** A level or upright stretch of a routed line, with the ends of its connector. */
interface Laid {
  from: string;
  to: string;
  level: boolean;
  /** The y of a level stretch, the x of an upright one. */
  at: number;
  lo: number;
  hi: number;
}

function laidSegments(plan: Plan, points: Point[]): Laid[] {
  const out: Laid[] = [];
  for (let i = 1; i < points.length; i++) {
    const p = points[i - 1]!;
    const q = points[i]!;
    const level = Math.abs(p.y - q.y) < 0.01;
    if (!level && Math.abs(p.x - q.x) >= 0.01) continue;
    out.push({ from: plan.connector.from, to: plan.connector.to, level, at: level ? p.y : p.x, lo: level ? Math.min(p.x, q.x) : Math.min(p.y, q.y), hi: level ? Math.max(p.x, q.x) : Math.max(p.y, q.y) });
  }
  return out;
}

/** Whether the stretch from p to q lies on one of the laid lines for a lane's length or more. */
function onTop(p: Point, q: Point, laid: Laid[]): boolean {
  const level = Math.abs(p.y - q.y) < 0.01;
  if (!level && Math.abs(p.x - q.x) >= 0.01) return false;
  const at = level ? p.y : p.x;
  const lo = level ? Math.min(p.x, q.x) : Math.min(p.y, q.y);
  const hi = level ? Math.max(p.x, q.x) : Math.max(p.y, q.y);
  return laid.some((l) => l.level === level && Math.abs(l.at - at) < LANE / 2 && Math.min(hi, l.hi) - Math.max(lo, l.lo) >= LANE);
}

function liesOnTop(points: Point[], laid: Laid[]): boolean {
  return points.slice(1).some((q, i) => onTop(points[i]!, q, laid));
}

/**
 * Moves the stretches of a detour that would lie on top of another connector's line aside by a lane,
 * outwards first, to the nearest place where the detour stays clear of shapes and of those lines.
 * `others` leaves out the lines from the same shape or to the same shape: sharing their way is a
 * trunk, read as one line.
 */
function takeLane(points: Point[], plan: Plan, obstacles: RouteShape[], others: Laid[]): Point[] {
  if (!others.length || points.length < 4) return points;
  const ends = [inflate(plan.a, DETOUR_LIMIT), inflate(plan.b, DETOUR_LIMIT)];
  const middle = { x: (Math.min(...points.map((p) => p.x)) + Math.max(...points.map((p) => p.x))) / 2, y: (Math.min(...points.map((p) => p.y)) + Math.max(...points.map((p) => p.y))) / 2 };
  let line = points;
  for (let k = 1; k < line.length - 2; k++) {
    if (!onTop(line[k]!, line[k + 1]!, others)) continue;
    const level = Math.abs(line[k]!.y - line[k + 1]!.y) < 0.01;
    const out = (level ? line[k]!.y >= middle.y : line[k]!.x >= middle.x) ? LANE : -LANE;
    for (const by of [out, -out, 2 * out, -2 * out, 3 * out, -3 * out, 4 * out, -4 * out]) {
      const moved = line.map((p, i) => (i === k || i === k + 1 ? (level ? { x: p.x, y: p.y + by } : { x: p.x + by, y: p.y }) : p));
      const kept = [k - 1, k + 1].every((s) => {
        const was = level ? line[s + 1]!.y - line[s]!.y : line[s + 1]!.x - line[s]!.x;
        const now = level ? moved[s + 1]!.y - moved[s]!.y : moved[s + 1]!.x - moved[s]!.x;
        return Math.sign(was) === Math.sign(now) && Math.abs(now) >= CONNECTOR_RADIUS;
      });
      if (!kept) continue;
      const part = moved.slice(k - 1, k + 3);
      if (obstacles.some((o) => runsThrough(part, o, DETOUR_LIMIT)) || ends.some((e) => runsThrough(moved.slice(k, k + 2), e, 0))) continue;
      if ([k - 1, k, k + 1].some((s) => onTop(moved[s]!, moved[s + 1]!, others) && (s === k || !onTop(line[s]!, line[s + 1]!, others)))) continue;
      line = moved;
      break;
    }
  }
  return line;
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

function geometry(plan: Plan, line: Line, solid: RouteShape[], labels: Rect[]): ConnectorGeometry {
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

  const label = connector.label?.trim() ? placeLabel(connector.label, points, plan, Boolean(line.curve), solid, labels) : undefined;
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
 * the line, clear of the two end shapes, of every other shape and of the labels placed before it
 * whenever any candidate is.
 */
function placeLabel(text: string, points: Point[], plan: Plan, smooth: boolean, solid: RouteShape[], labels: Rect[]): LabelBox {
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
      const need = (level ? w : h) + 2 * CONNECTOR_RADIUS;
      const room = length >= need;
      const base = room ? (level ? 0 : 4) : 60;
      candidates.push({ at: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, penalty: base + Math.abs(walked + length / 2 - total / 2) * 0.05 });
      // Further places along a long segment, taken only when its middle is covered.
      if (length >= 2 * need) {
        for (const t of [need / 2 / length, 1 - need / 2 / length, 0.25, 0.75]) {
          candidates.push({ at: { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }, penalty: base + 8 + Math.abs(walked + length * t - total / 2) * 0.05 });
        }
      }
      walked += length;
    });
  }
  const box = (at: Point): Rect => ({ x: Math.round(at.x - w / 2), y: Math.round(at.y - h / 2), w, h });
  const ends = plan.mode === 'inside' ? [rectContains(plan.a, plan.b) ? plan.b : plan.a] : [plan.a, plan.b];
  const scored = candidates.map((c) => {
    const at = box(c.at);
    let penalty = c.penalty;
    if (ends.some((shape) => rectsOverlap(inflate(shape, 2), at))) penalty += 1000;
    if (solid.some((shape) => shape !== plan.a && shape !== plan.b && rectsOverlap(shape, at))) penalty += 500;
    if (labels.some((other) => rectsOverlap(other, at))) penalty += 250;
    return { ...c, penalty };
  });
  const best = scored.reduce((p, q) => (q.penalty < p.penalty ? q : p));
  return { ...box(best.at), lines };
}
