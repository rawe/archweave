/**
 * Automatic placement with ELK's layered algorithm. Nodes that already have a
 * position never move; new nodes are laid out with the whole graph and then
 * transplanted next to the placed node they relate to, avoiding overlaps.
 */
import type { ELK as ElkApi } from 'elkjs/lib/elk-api.js';
import type { Position } from '../../shared/model.ts';

export interface LayoutNode {
  id: string;
  width: number;
  height: number;
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

const OPTIONS = {
  'elk.algorithm': 'layered',
  'elk.direction': 'RIGHT',
  'elk.spacing.nodeNode': '44',
  'elk.layered.spacing.nodeNodeBetweenLayers': '96',
  'elk.spacing.componentComponent': '72',
  'elk.layered.considerModelOrder.strategy': 'NODES_AND_EDGES',
  'elk.layered.crossingMinimization.forceNodeModelOrder': 'false',
  'elk.separateConnectedComponents': 'true',
  'elk.layered.compaction.connectedComponents': 'true',
  'elk.aspectRatio': '1.8',
  'elk.padding': '[top=0,left=0,bottom=0,right=0]',
};

const GAP = 28;

/** Full layered layout, normalized so the top-left node starts at the origin. */
export async function layoutAll(nodes: LayoutNode[], edges: LayoutEdge[]): Promise<Record<string, Position>> {
  if (!nodes.length) return {};
  const ids = new Set(nodes.map((n) => n.id));
  const graph = {
    id: 'root',
    layoutOptions: OPTIONS,
    children: nodes.map((n) => ({ id: n.id, width: n.width, height: n.height })),
    edges: edges
      .filter((e) => ids.has(e.from) && ids.has(e.to) && e.from !== e.to)
      .map((e, i) => ({ id: `e${i}`, sources: [e.from], targets: [e.to] })),
  };
  let result: Awaited<ReturnType<ElkApi['layout']>>;
  try {
    result = await (await getElk()).layout(graph);
  } catch {
    return gridFallback(nodes);
  }
  const out: Record<string, Position> = {};
  let minX = Infinity;
  let minY = Infinity;
  for (const child of result.children ?? []) {
    minX = Math.min(minX, child.x ?? 0);
    minY = Math.min(minY, child.y ?? 0);
  }
  for (const child of result.children ?? []) out[child.id] = { x: Math.round((child.x ?? 0) - minX), y: Math.round((child.y ?? 0) - minY) };
  return out;
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
      target = { x: bounds.x + bounds.w + 96, y: bounds.y };
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
  if (counts.size) return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]![0];
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
  const stepY = Math.max(40, (want.h + GAP) / 2);
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
  return Object.fromEntries(nodes.map((n, i) => [n.id, { x: (i % cols) * 280, y: Math.floor(i / cols) * 160 }]));
}
