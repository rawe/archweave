/**
 * Automatic placement for the structure canvas, with ELK's layered algorithm.
 *
 * A scope is laid out left to right and compact: the elements inside in a few
 * tight columns, neighbors on the rim (callers in a column on the left,
 * callees on the right). Nodes that already have a position never move; new
 * nodes are laid out with the whole graph and then transplanted next to the
 * placed node they relate to, avoiding overlaps.
 */
import type { ELK as ElkApi } from 'elkjs/lib/elk-api.js';
import type { Position } from '../../shared/model.ts';

export interface LayoutNode {
  id: string;
  width: number;
  height: number;
  /** Neighbors sit on the rim: callers left, callees right. */
  rim?: 'left' | 'right';
}

export interface LayoutEdge {
  from: string;
  to: string;
}

let elkPromise: Promise<ElkApi> | null = null;
/** ELK is large; it loads the first time something needs placing. */
function getElk(): Promise<ElkApi> {
  elkPromise ??= import('elkjs/lib/elk.bundled.js').then((m) => new m.default());
  return elkPromise;
}

/** Gap between columns; threads curve once inside it. */
export const COLUMN_GAP = 38;
const RIM_GAP = 40;

const OPTIONS = {
  'elk.algorithm': 'layered',
  'elk.direction': 'RIGHT',
  'elk.spacing.nodeNode': '26',
  'elk.layered.spacing.nodeNodeBetweenLayers': String(COLUMN_GAP),
  'elk.layered.spacing.edgeNodeBetweenLayers': '14',
  'elk.spacing.edgeNode': '12',
  'elk.spacing.edgeEdge': '8',
  'elk.edgeRouting': 'POLYLINE',
  'elk.layered.nodePlacement.strategy': 'BRANDES_KOEPF',
  'elk.layered.nodePlacement.bk.fixedAlignment': 'BALANCED',
  'elk.layered.considerModelOrder.strategy': 'NODES_AND_EDGES',
  'elk.layered.crossingMinimization.forceNodeModelOrder': 'false',
  'elk.separateConnectedComponents': 'false',
  'elk.padding': '[top=0,left=0,bottom=0,right=0]',
};

/** Where automatic layouts start. */
const ORIGIN = { x: 40, y: 40 };
const GAP = 24;

/** Full layout of a scope, deterministic for the same nodes and edges. */
export async function layoutAll(nodes: LayoutNode[], edges: LayoutEdge[]): Promise<Record<string, Position>> {
  if (!nodes.length) return {};
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const graph = {
    id: 'root',
    layoutOptions: OPTIONS,
    children: nodes.map((n) => ({
      id: n.id,
      width: n.width,
      height: n.height,
      layoutOptions: n.rim ? { 'elk.layered.layering.layerConstraint': n.rim === 'left' ? 'FIRST_SEPARATE' : 'LAST_SEPARATE' } : undefined,
    })),
    edges: edges
      .filter((e) => byId.has(e.from) && byId.has(e.to) && e.from !== e.to)
      .map((e, i) => {
        // Rim nodes only make sense with edges pointing away from the left rim and into the right one.
        const flip = byId.get(e.from)!.rim === 'right' || byId.get(e.to)!.rim === 'left';
        return { id: `e${i}`, sources: [flip ? e.to : e.from], targets: [flip ? e.from : e.to] };
      }),
  };
  let result: Awaited<ReturnType<ElkApi['layout']>>;
  try {
    result = await (await getElk()).layout(graph);
  } catch {
    return gridFallback(nodes);
  }
  const placed = new Map<string, Rect>();
  for (const child of result.children ?? []) {
    const n = byId.get(child.id)!;
    placed.set(child.id, { x: child.x ?? 0, y: child.y ?? 0, w: n.width, h: n.height });
  }
  tightenRims(nodes, placed);
  let minX = Infinity;
  let minY = Infinity;
  for (const r of placed.values()) {
    minX = Math.min(minX, r.x);
    minY = Math.min(minY, r.y);
  }
  const out: Record<string, Position> = {};
  for (const [id, r] of placed) out[id] = { x: Math.round(r.x - minX + ORIGIN.x), y: Math.round(r.y - minY + ORIGIN.y) };
  return out;
}

/**
 * Re-spaces the columns ELK produced to exactly COLUMN_GAP (ELK widens them to
 * route edges, which our single curves do not need), then snaps the rim
 * columns close to the inside: left chips right-aligned, right chips left-aligned.
 */
function tightenRims(nodes: LayoutNode[], placed: Map<string, Rect>) {
  const inside = nodes.filter((n) => !n.rim).map((n) => placed.get(n.id)!);
  if (!inside.length) return;
  const columns = [...new Set(inside.map((r) => Math.round(r.x)))].sort((a, b) => a - b);
  let x = columns[0]!;
  const shifted = new Map<number, number>();
  for (const col of columns) {
    shifted.set(col, x);
    const width = Math.max(...inside.filter((r) => Math.round(r.x) === col).map((r) => r.w));
    x += width + COLUMN_GAP;
  }
  for (const r of inside) r.x = shifted.get(Math.round(r.x))!;
  const left = Math.min(...inside.map((r) => r.x));
  const right = Math.max(...inside.map((r) => r.x + r.w));
  for (const n of nodes) {
    const r = placed.get(n.id)!;
    if (n.rim === 'left') r.x = left - RIM_GAP - r.w;
    else if (n.rim === 'right') r.x = right + RIM_GAP;
  }
}

/**
 * Positions a canvas shows: stored positions always win and are never replaced automatically (only Tidy
 * replaces a layout); positions computed in this browser fill in for nodes the store does not have.
 */
export function shownPositions(stored: Record<string, Position> | undefined, computed: Record<string, Position> | undefined): Record<string, Position> {
  return { ...(computed ?? {}), ...(stored ?? {}) };
}

/**
 * What a finished placement job writes: positions for nodes that still exist and that nobody positioned
 * while the job ran.
 */
export function placementToSave(placed: Record<string, Position>, alive: ReadonlySet<string>, stored: Record<string, Position>): Record<string, Position> {
  return Object.fromEntries(Object.entries(placed).filter(([id]) => alive.has(id) && !stored[id]));
}

/** Positions for the nodes missing from `fixed`, leaving every fixed node where it is. */
export async function placeMissing(
  nodes: LayoutNode[],
  edges: LayoutEdge[],
  fixed: Record<string, Position>,
): Promise<Record<string, Position>> {
  const missing = nodes.filter((n) => !fixed[n.id]);
  if (!missing.length) return {};
  const placedNodes = nodes.filter((n) => fixed[n.id]);
  const ideal = await layoutAll(nodes, edges);
  if (!placedNodes.length) return Object.fromEntries(missing.map((n) => [n.id, ideal[n.id]!]));

  const occupied: Rect[] = placedNodes.map((n) => ({ ...fixed[n.id]!, w: n.width, h: n.height }));
  const out: Record<string, Position> = {};
  const known = (id: string) => fixed[id] ?? out[id];

  // Place nodes connected to placed ones first so chains grow outward.
  const order = [...missing].sort((a, b) => degreeTo(b.id, edges, fixed) - degreeTo(a.id, edges, fixed));
  for (const node of order) {
    const anchor = pickAnchor(node.id, edges, ideal, known);
    const at = ideal[node.id] ?? { x: 0, y: 0 };
    let target: Position;
    if (anchor) {
      const anchorIdeal = ideal[anchor]!;
      const anchorPos = known(anchor)!;
      target = { x: anchorPos.x + (at.x - anchorIdeal.x), y: anchorPos.y + (at.y - anchorIdeal.y) };
    } else {
      const bounds = boundsOf(occupied);
      target = { x: bounds.x + bounds.w + 72, y: bounds.y };
    }
    const rect = freeSpot({ ...target, w: node.width, h: node.height }, occupied);
    out[node.id] = { x: Math.round(rect.x), y: Math.round(rect.y) };
    occupied.push(rect);
  }
  return out;
}

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

function degreeTo(id: string, edges: LayoutEdge[], fixed: Record<string, Position>): number {
  let n = 0;
  for (const e of edges) if ((e.from === id && fixed[e.to]) || (e.to === id && fixed[e.from])) n++;
  return n;
}

function pickAnchor(
  id: string,
  edges: LayoutEdge[],
  ideal: Record<string, Position>,
  known: (id: string) => Position | undefined,
): string | undefined {
  const counts = new Map<string, number>();
  for (const e of edges) {
    const other = e.from === id ? e.to : e.to === id ? e.from : undefined;
    if (other && other !== id && known(other) && ideal[other]) counts.set(other, (counts.get(other) ?? 0) + 1);
  }
  if (counts.size) return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]![0];
  const at = ideal[id];
  if (!at) return undefined;
  let best: string | undefined;
  let bestDist = Infinity;
  for (const [other, pos] of Object.entries(ideal)) {
    if (other === id || !known(other)) continue;
    const d = Math.hypot(pos.x - at.x, pos.y - at.y);
    if (d < bestDist) {
      bestDist = d;
      best = other;
    }
  }
  return best;
}

function overlaps(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w + GAP && a.x + a.w + GAP > b.x && a.y < b.y + b.h + GAP && a.y + a.h + GAP > b.y;
}

/** The closest spot to `want` that does not overlap anything, searched on rings around it. */
export function freeSpot(want: Rect, occupied: Rect[]): Rect {
  if (!occupied.some((o) => overlaps(want, o))) return want;
  const stepX = want.w + GAP;
  const stepY = Math.max(36, (want.h + GAP) / 2);
  for (let ring = 1; ring < 40; ring++) {
    const candidates: Rect[] = [];
    for (let dx = -ring; dx <= ring; dx++) {
      for (let dy = -ring * 2; dy <= ring * 2; dy++) {
        if (Math.max(Math.abs(dx), Math.abs(dy) / 2) < ring - 0.5) continue;
        candidates.push({ ...want, x: want.x + dx * stepX, y: want.y + dy * stepY });
      }
    }
    candidates.sort((a, b) => Math.hypot(a.x - want.x, (a.y - want.y) * 1.4) - Math.hypot(b.x - want.x, (b.y - want.y) * 1.4));
    const free = candidates.find((c) => !occupied.some((o) => overlaps(c, o)));
    if (free) return free;
  }
  return want;
}

function boundsOf(rects: Rect[]): Rect {
  const x = Math.min(...rects.map((r) => r.x));
  const y = Math.min(...rects.map((r) => r.y));
  const r = Math.max(...rects.map((r) => r.x + r.w));
  const b = Math.max(...rects.map((r) => r.y + r.h));
  return { x, y, w: r - x, h: b - y };
}

function gridFallback(nodes: LayoutNode[]): Record<string, Position> {
  const cols = Math.ceil(Math.sqrt(nodes.length));
  return Object.fromEntries(nodes.map((n, i) => [n.id, { x: ORIGIN.x + (i % cols) * 260, y: ORIGIN.y + Math.floor(i / cols) * 140 }]));
}

/**
 * Display positions that never overlap: stored positions are kept, and a node
 * that would overlap one above it moves down just below it. Needed because
 * nodes grow (full summaries, longer names) after a human arranged them.
 */
export function separate(
  positions: Record<string, Position>,
  sizes: ReadonlyMap<string, { width: number; height: number }>,
  gap = 16,
): Record<string, Position> {
  const ids = Object.keys(positions)
    .filter((id) => sizes.has(id))
    .sort((a, b) => positions[a]!.y - positions[b]!.y || positions[a]!.x - positions[b]!.x || a.localeCompare(b));
  const out: Record<string, Position> = { ...positions };
  const done: Rect[] = [];
  for (const id of ids) {
    const size = sizes.get(id)!;
    const r: Rect = { x: positions[id]!.x, y: positions[id]!.y, w: size.width, h: size.height };
    for (let guard = 0, moved = true; moved && guard < 500; guard++) {
      moved = false;
      for (const o of done)
        if (r.x < o.x + o.w && r.x + r.w > o.x && r.y < o.y + o.h + gap && r.y + r.h + gap > o.y) {
          r.y = o.y + o.h + gap;
          moved = true;
        }
    }
    if (r.y !== positions[id]!.y) out[id] = { x: r.x, y: r.y };
    done.push(r);
  }
  return out;
}
