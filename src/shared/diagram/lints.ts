/**
 * What a reviewer would notice looking at a diagram, for an author who cannot see it: overlaps, shapes
 * sticking out of their group, lines through or along shapes, labels covering labels or shapes, text that
 * does not fit, doubled lines, empty shapes, and diagrams too big to read. Judged on shapes as drawn (grown to fit their text) and lines routed as the
 * renderer routes them, so it agrees with the picture.
 */
import type { Diagram, DiagramConnector, DiagramShape } from '../model.ts';
import { grownToFit } from './fit.ts';
import { distance, type Point, type Rect } from './geometry.ts';
import { shapeLabel } from './links.ts';
import type { LinkTargets } from './patch.ts';
import { routeConnectors } from './route.ts';

export interface DiagramLint {
  code: 'overlap' | 'outside-group' | 'crosses-shape' | 'lines-overlap' | 'label-overlap' | 'text-overflow' | 'duplicate-connector' | 'empty-shape' | 'too-many-shapes';
  /** One actionable sentence. */
  message: string;
  /** The shapes and connectors concerned. */
  ids: string[];
}

/** Above this many shapes a diagram stops being readable at a glance. */
export const MAX_SHAPES = 40;
/** Overlaps smaller than this are touching, not covering. */
const SLACK = 2;
/** A line closer to a shape than this, along at least NEAR_LENGTH of its way, runs through or along it. */
const NEAR = 4;
const NEAR_LENGTH = 12;

/** The lints of a diagram, in a stable order: by code, then by the order of shapes and connectors. Pure. */
export function diagramLints(diagram: Diagram, model: LinkTargets): DiagramLint[] {
  const shapes = diagram.shapes.map((s) => grownToFit(s, shapeLabel(model, s)));
  const byId = new Map(shapes.map((s) => [s.id, s]));
  const lints: DiagramLint[] = [];
  const add = (code: DiagramLint['code'], ids: string[], message: string) => lints.push({ code, message, ids });

  shapes.forEach((a, i) => {
    for (const b of shapes.slice(i + 1)) {
      if (a.parent !== b.parent || !covers(a, b)) continue;
      add('overlap', [a.id, b.id], `\`${a.id}\` and \`${b.id}\` overlap; move one with \`setShapes\` x/y, or leave positions out and send \`arrange: "all"\` if nobody placed them by hand.`);
    }
  });
  for (const s of shapes) {
    const group = s.parent ? byId.get(s.parent) : undefined;
    if (group && !inside(group, s)) add('outside-group', [s.id, group.id], `\`${s.id}\` sticks out of its group \`${group.id}\`; move it inside or make \`${group.id}\` larger.`);
  }
  const connectors = new Map(diagram.connectors.map((c) => [c.id, c]));
  const problems = lineProblems(shapes, diagram.connectors, diagram.direction);
  for (const { kind, connector: id, other } of problems) {
    const { from, to } = connectors.get(id)!;
    if (kind !== 'crosses') continue;
    add('crosses-shape', [id, other], `Connector \`${id}\` runs through or along \`${other}\`; move \`${other}\` off the line between \`${from}\` and \`${to}\`, or pin \`fromSide\`/\`toSide\` so the line goes around it.`);
  }
  for (const { kind, connector: id, other } of problems) {
    if (kind !== 'lines') continue;
    add('lines-overlap', [id, other], `Connectors \`${id}\` and \`${other}\` run on top of each other for a stretch; move a shape at one of their ends sideways, or pin \`fromSide\`/\`toSide\` on one of them.`);
  }
  for (const { kind, connector: id, other } of problems) {
    if (kind === 'crosses' || kind === 'lines') continue;
    const what = kind === 'label-label' ? `the label of connector \`${other}\`` : kind === 'label-line' ? `the line of connector \`${other}\`` : `\`${other}\``;
    add('label-overlap', [id, other], `The label of connector \`${id}\` covers ${what}; move the shapes apart, shorten the label, or pin \`fromSide\`/\`toSide\` to move the line.`);
  }
  for (const stored of diagram.shapes) {
    const shown = byId.get(stored.id)!;
    if (shown.w > stored.w || shown.h > stored.h) {
      add('text-overflow', [stored.id], `The text of \`${stored.id}\` does not fit its ${stored.w}×${stored.h}; make it at least ${Math.ceil(shown.w)}×${Math.ceil(shown.h)} or shorten the text.`);
    }
  }
  const seen = new Map<string, string>();
  for (const c of diagram.connectors) {
    const key = `${c.from}>${c.to}>${c.label}`;
    const first = seen.get(key);
    if (first) add('duplicate-connector', [first, c.id], `Connectors \`${first}\` and \`${c.id}\` both go from \`${c.from}\` to \`${c.to}\`${c.label ? ` labelled "${c.label}"` : ' without a label'}; remove one.`);
    else seen.set(key, c.id);
  }
  for (const s of diagram.shapes) {
    if (s.kind !== 'group' && s.kind !== 'text' && !s.text.trim() && !s.link) add('empty-shape', [s.id], `\`${s.id}\` shows nothing; give it \`text\` or a \`link\`, or remove it.`);
  }
  if (diagram.shapes.length > MAX_SHAPES) {
    add('too-many-shapes', [], `The diagram has ${diagram.shapes.length} shapes, too many to read at a glance; split it into diagrams of one idea each (a shape can link to another diagram).`);
  }
  return lints;
}

export interface LineProblem {
  /**
   * crosses: the line runs through or along a shape; label-shape, label-label, label-line: its label covers a
   * shape, another label, another line; lines: it runs on top of another line.
   */
  kind: 'crosses' | 'label-shape' | 'label-label' | 'label-line' | 'lines';
  connector: string;
  /** The shape, or the other connector. */
  other: string;
}

/**
 * What is wrong with the lines of a diagram, routed as the renderer routes them: lines running through or
 * along a shape other than their own ends, labels covering a shape, another label or another line, and
 * lines running on top of each other (pairs of connectors once). Lines leaving or reaching the same shape may
 * share their way, and a label may sit on that shared trunk: that is a fan, read as one line.
 * Group frames are left out: lines and labels lie across groups all the time.
 */
export function lineProblems(
  shapes: Pick<DiagramShape, 'id' | 'kind' | 'x' | 'y' | 'w' | 'h'>[],
  connectors: Pick<DiagramConnector, 'id' | 'from' | 'to' | 'route' | 'fromSide' | 'toSide' | 'label' | 'ends'>[],
  direction: Diagram['direction'],
): LineProblem[] {
  const routes = routeConnectors(shapes, connectors, { direction });
  const solid = shapes.filter((s) => s.kind !== 'group');
  const out: LineProblem[] = [];
  for (const c of connectors) {
    const points = routes.get(c.id)?.points;
    if (!points) continue;
    for (const s of solid) if (s.id !== c.from && s.id !== c.to && crosses(points, s)) out.push({ kind: 'crosses', connector: c.id, other: s.id });
  }
  const byId = new Map(connectors.map((c) => [c.id, c]));
  const labelled = connectors.flatMap((c) => {
    const label = routes.get(c.id)?.label;
    return label ? [{ id: c.id, label }] : [];
  });
  labelled.forEach(({ id, label }, i) => {
    for (const s of solid) if (covers(label, s)) out.push({ kind: 'label-shape', connector: id, other: s.id });
    for (const next of labelled.slice(i + 1)) if (covers(label, next.label)) out.push({ kind: 'label-label', connector: id, other: next.id });
    const own = byId.get(id)!;
    const ownPoints = routes.get(id)!.points;
    for (const c of connectors) {
      const points = c.id === id ? undefined : routes.get(c.id)?.points;
      if (!points) continue;
      const fan = c.from === own.from || c.to === own.to;
      const under = points.slice(1).some((p, j) => {
        const part = clip(points[j]!, p, label);
        return part && distance(...part) > SLACK && !(fan && runTogether(part, ownPoints, distance(...part) - 1));
      });
      if (under) out.push({ kind: 'label-line', connector: id, other: c.id });
    }
  });
  connectors.forEach((a, i) => {
    const pa = routes.get(a.id)?.points;
    for (const b of connectors.slice(i + 1)) {
      const pb = routes.get(b.id)?.points;
      if (pa && pb && a.from !== b.from && a.to !== b.to && runTogether(pa, pb)) out.push({ kind: 'lines', connector: a.id, other: b.id });
    }
  });
  return out;
}

/** Whether two polylines share a stretch: parallel straight segments closer than SLACK along `least` or more. */
function runTogether(a: Point[], b: Point[], least = NEAR_LENGTH): boolean {
  const segments = (points: Point[]) => points.slice(1).map((p, i) => [points[i]!, p] as const);
  return segments(a).some(([a0, a1]) =>
    segments(b).some(([b0, b1]) => {
      const level = (p: Point, q: Point) => Math.abs(p.y - q.y) < 0.01;
      const upright = (p: Point, q: Point) => Math.abs(p.x - q.x) < 0.01;
      const shared = (lo1: number, hi1: number, lo2: number, hi2: number) => Math.min(Math.max(lo1, hi1), Math.max(lo2, hi2)) - Math.max(Math.min(lo1, hi1), Math.min(lo2, hi2));
      if (level(a0, a1) && level(b0, b1) && Math.abs(a0.y - b0.y) < SLACK) return shared(a0.x, a1.x, b0.x, b1.x) >= least;
      if (upright(a0, a1) && upright(b0, b1) && Math.abs(a0.x - b0.x) < SLACK) return shared(a0.y, a1.y, b0.y, b1.y) >= least;
      return false;
    }),
  );
}

function covers(a: Rect, b: Rect): boolean {
  return Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x) > SLACK && Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y) > SLACK;
}

function inside(outer: Rect, inner: Rect): boolean {
  return inner.x >= outer.x - SLACK && inner.y >= outer.y - SLACK && inner.x + inner.w <= outer.x + outer.w + SLACK && inner.y + inner.h <= outer.y + outer.h + SLACK;
}

/** Whether a polyline runs through a shape, or along its edge within NEAR, for at least NEAR_LENGTH of its way. */
function crosses(points: Point[], shape: Pick<DiagramShape, 'x' | 'y' | 'w' | 'h'>): boolean {
  const box = { x: shape.x - NEAR, y: shape.y - NEAR, w: shape.w + 2 * NEAR, h: shape.h + 2 * NEAR };
  const length = points.slice(1).reduce((sum, p, i) => {
    const part = clip(points[i]!, p, box);
    return sum + (part ? distance(...part) : 0);
  }, 0);
  return length >= NEAR_LENGTH;
}

/** Liang–Barsky: the part of segment a–b inside the rectangle, if any. */
function clip(a: Point, b: Point, r: Rect): [Point, Point] | undefined {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  let t0 = 0;
  let t1 = 1;
  for (const [p, q] of [[-dx, a.x - r.x], [dx, r.x + r.w - a.x], [-dy, a.y - r.y], [dy, r.y + r.h - a.y]] as const) {
    if (p === 0) {
      if (q < 0) return undefined;
      continue;
    }
    const t = q / p;
    if (p < 0) t0 = Math.max(t0, t);
    else t1 = Math.min(t1, t);
    if (t0 > t1) return undefined;
  }
  return [{ x: a.x + t0 * dx, y: a.y + t0 * dy }, { x: a.x + t1 * dx, y: a.y + t1 * dy }];
}
