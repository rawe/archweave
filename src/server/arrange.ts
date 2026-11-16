/**
 * Automatic arrangement of diagrams, so agents never have to think in pixels. Runs on a change set before
 * the store sees it: `seed` is expanded, shapes are placed, and the result is written back into the patch
 * as plain positions, so the store, the journal and undo see an ordinary change set.
 */
import ELK from 'elkjs/lib/elk.bundled.js';
import type { ElkExtendedEdge, ElkNode } from 'elkjs/lib/elk-api.js';
import { minHeightAt } from '../shared/diagram/layout.ts';
import { shapeLabel } from '../shared/diagram/links.ts';
import { lineProblems } from '../shared/diagram/lints.ts';
import { applyDiagramPatch, type LinkTargets } from '../shared/diagram/patch.ts';
import { routeConnectors } from '../shared/diagram/route.ts';
import { seedPatch } from '../shared/diagram/seed.ts';
import { textStyle } from '../shared/diagram/style.ts';
import { measureText } from '../shared/diagram/text.ts';
import { type ChangeSet, type Diagram, type DiagramConnector, type DiagramPatch, type DiagramShape, type Model, type ShapePatch, slugify, uniqueId } from '../shared/model.ts';
import { applyChangeSet, ChangeError, parseChangeSet } from './changes.ts';

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

type Direction = Diagram['direction'];

const GRID = 8;
/** Where a diagram arranged from scratch starts. */
const ORIGIN = 40;
/** Between consecutive layers of the reading direction. */
const LAYER_GAP = 72;
/** Between shapes side by side, and the least clearance a placed shape keeps from anything else. */
const NODE_GAP = 48;
const CLEARANCE = 40;
/** Inside a group: on the sides and at the bottom, and below the title. */
const GROUP_PAD = 24;
const TITLE_GAP = 16;
/** How far `clearLines` moves a shape sideways at most, and how many routings it may spend. */
const MAX_SHIFT = 256;
const CLEAR_BUDGET = 400;

let elk: InstanceType<typeof ELK> | undefined;

/**
 * Prepares a change set for the store: for each diagram patch, `seed` becomes `setShapes`/`setConnectors`
 * entries and the shapes that need it are placed (`arrange: 'new'`, the default, places only new shapes
 * without a position; `'all'` places every shape afresh), written back as explicit `x`, `y` (and `w`, `h`
 * for groups). `arrange` and `seed` are removed. Id-less shape entries of an arranged patch get their id here.
 * A patch the store would reject is passed on untouched so the store reports it; an unknown seed id throws
 * a ChangeError. Returns the input itself when no diagram patch needs any of this.
 */
export async function prepareChanges(model: Model, input: unknown): Promise<ChangeSet> {
  const changes = parseChangeSet(input);
  if (!changes.diagrams?.length) return changes;
  let targets: Model = model;
  if (changes.elements?.length || changes.relations?.length || changes.flows?.length || changes.remove) {
    try {
      targets = applyChangeSet({ model, layout: {} }, { ...changes, diagrams: undefined, layout: undefined, expectedRevision: undefined }, 'agent', new Date()).model;
    } catch {
      // The store reports what is wrong with the rest of the change set.
    }
  }
  const diagrams = new Map(targets.diagrams.map((d) => [d.id, d]));
  const prepared: DiagramPatch[] = [];
  let touched = false;
  for (const patch of changes.diagrams) {
    const existing = patch.id ? diagrams.get(patch.id) : undefined;
    const id = existing?.id ?? patch.id ?? (patch.name ? uniqueId(slugify(patch.name), new Set(diagrams.keys())) : undefined);
    const result = id ? await preparePatch(existing, patch, id, { ...targets, diagrams: [...diagrams.values()] }) : undefined;
    if (result?.diagram) diagrams.set(id!, result.diagram);
    touched ||= !!result && result.patch !== patch;
    prepared.push(result?.patch ?? patch);
  }
  return touched ? { ...changes, diagrams: prepared } : changes;
}

/** One diagram patch with its seed expanded and its shapes placed, and the diagram it will produce. */
async function preparePatch(existing: Diagram | undefined, patch: DiagramPatch, id: string, targets: Model): Promise<{ patch: DiagramPatch; diagram?: Diagram }> {
  const { arrange, seed, ...rest } = patch;
  const ctx = { id, model: targets };
  let base: DiagramPatch = withShapeIds(rest, existing);
  if (seed?.length) {
    const before = applyDiagramPatch(existing, base, ctx);
    if (!before.diagram) return { patch };
    const seeded = seedPatch(targets, before.diagram, seed);
    if (seeded.errors.length) throw new ChangeError(seeded.errors.map((e) => `diagram \`${id}\` ${e}`).join('\n'));
    base = { ...base, setShapes: [...(base.setShapes ?? []), ...seeded.setShapes], setConnectors: [...(base.setConnectors ?? []), ...seeded.setConnectors] };
  }
  const applied = applyDiagramPatch(existing, base, ctx);
  if (!applied.diagram) return { patch };
  const all = arrange === 'all';
  if (!all && !applied.unplaced.length) return { patch: seed || arrange ? base : patch, diagram: applied.diagram };
  // Should ELK fail on some graph, the store's fallback row is better than refusing the change.
  const boxes = await arrangeDiagram(applied.diagram, targets, all ? 'all' : applied.unplaced).catch(() => undefined);
  if (!boxes) return { patch: base, diagram: applied.diagram };
  const placed = withBoxes(base, boxes, applied.diagram);
  return { patch: placed, diagram: applyDiagramPatch(existing, placed, ctx).diagram };
}

/**
 * New positions for the shapes of a diagram: with `'all'` every shape, laid out afresh (non-group shapes keep
 * their size, groups are sized to what they hold); with a list of shape ids only those, around the rest,
 * which stays where it is except that a group grows to hold a new shape and pushes aside what it would cover.
 * Returns the shapes whose geometry changes.
 */
export async function arrangeDiagram(diagram: Diagram, targets: LinkTargets, place: 'all' | string[]): Promise<Map<string, Box>> {
  const shapes = new Map(diagram.shapes.map((s) => [s.id, s]));
  const pending = new Set(place === 'all' ? shapes.keys() : place);
  const fixed = [...shapes.values()].filter((s) => !pending.has(s.id));
  if (!fixed.length) {
    const block = await layoutBlock([...shapes.values()], diagram.connectors, diagram.direction, targets);
    return new Map([...block.boxes].map(([id, box]) => [id, { ...box, x: box.x + ORIGIN, y: box.y + ORIGIN }]));
  }
  return new Placer(shapes, diagram.connectors, diagram.direction, targets, pending).run();
}

/** Gives every id-less shape entry of a patch an id made as the store makes it, so positions can be written back to it. */
function withShapeIds(patch: DiagramPatch, existing: Diagram | undefined): DiagramPatch {
  const entries = [...(patch.shapes ?? []), ...(patch.setShapes ?? [])];
  if (entries.every((s) => s.id)) return patch;
  const taken = new Set([...(existing?.shapes ?? []), ...(existing?.connectors ?? []), ...entries, ...(patch.connectors ?? []), ...(patch.setConnectors ?? [])].flatMap((s) => (s.id ? [s.id] : [])));
  const named = (list?: ShapePatch[]) =>
    list?.map((s) => {
      if (s.id) return s;
      const id = uniqueId(slugify([s.text, s.link?.id].find((t) => t && /[a-z0-9]/i.test(t)) ?? s.kind ?? 'box'), taken);
      taken.add(id);
      return { id, ...s };
    });
  return { ...patch, ...(patch.shapes ? { shapes: named(patch.shapes) } : {}), ...(patch.setShapes ? { setShapes: named(patch.setShapes) } : {}) };
}

/** Writes boxes into the patch: into the shape's last entry when it has one, else as a new `setShapes` entry. */
function withBoxes(patch: DiagramPatch, boxes: Map<string, Box>, diagram: Diagram): DiagramPatch {
  const kinds = new Map(diagram.shapes.map((s) => [s.id, s.kind]));
  const geometry = (id: string): Partial<ShapePatch> => {
    const { x, y, w, h } = boxes.get(id)!;
    return kinds.get(id) === 'group' ? { x, y, w, h } : { x, y };
  };
  const done = new Set<string>();
  const write = (list?: ShapePatch[]) =>
    list &&
    [...list]
      .reverse()
      .map((entry) => {
        if (!entry.id || !boxes.has(entry.id) || done.has(entry.id)) return entry;
        done.add(entry.id);
        return { ...entry, ...geometry(entry.id) };
      })
      .reverse();
  const setShapes = write(patch.setShapes) ?? [];
  const shapes = write(patch.shapes);
  for (const id of boxes.keys()) if (!done.has(id)) setShapes.push({ id, ...geometry(id) });
  return { ...patch, ...(shapes ? { shapes } : {}), ...(setShapes.length ? { setShapes } : {}) };
}

/** Shapes laid out together, relative to (0, 0), and the size of the whole. */
interface Block {
  boxes: Map<string, Box>;
  w: number;
  h: number;
}

/**
 * ELK settings tried for every layout. Lines are drawn with the renderer's routes, not ELK's, so which
 * settings give clear lines depends on the graph: each is tried and the clearest, most compact result wins.
 */
const VARIANTS: Record<string, string>[] = ['NETWORK_SIMPLEX', 'BRANDES_KOEPF', 'LINEAR_SEGMENTS'].flatMap((placement) =>
  ['NETWORK_SIMPLEX', 'LONGEST_PATH'].map((layering) => ({
    'elk.layered.nodePlacement.strategy': placement,
    'elk.layered.nodePlacement.bk.fixedAlignment': 'BALANCED',
    'elk.layered.layering.strategy': layering,
  })),
);
/** What one line problem left in a layout costs against its size (width plus height, in units). */
const PROBLEM_COST = 1200;

/**
 * Lays out shapes with ELK's layered algorithm in the reading direction: groups (among `shapes`) are frames
 * around their children, connectors between the shapes pull them into layers. Of the VARIANTS, the layout
 * with the fewest line problems (see `clearLines`) and then the smallest size is taken. Deterministic.
 * Non-group shapes keep their size; a group with nothing inside keeps its size too.
 */
async function layoutBlock(shapes: DiagramShape[], connectors: DiagramConnector[], direction: Direction, targets: LinkTargets): Promise<Block> {
  const members = new Map(shapes.map((s) => [s.id, s]));
  const children = new Map<string | undefined, DiagramShape[]>();
  for (const s of shapes) {
    const parent = s.parent && members.has(s.parent) ? s.parent : undefined;
    children.set(parent, [...(children.get(parent) ?? []), s]);
  }
  const within = (a: string, b: string) => {
    for (let p = members.get(a)?.parent; p && members.has(p); p = members.get(p)!.parent) if (p === b) return true;
    return false;
  };
  const drawn = connectors.filter((c) => members.has(c.from) && members.has(c.to) && c.from !== c.to && !within(c.from, c.to) && !within(c.to, c.from));
  const spacing = {
    'elk.direction': direction === 'right' ? 'RIGHT' : 'DOWN',
    ...labelSpacing(drawn, direction),
    'elk.spacing.edgeNode': '24',
    'elk.layered.spacing.edgeNodeBetweenLayers': '24',
    'elk.spacing.edgeEdge': '16',
    'elk.spacing.componentComponent': String(LAYER_GAP),
  };
  const node = (s: DiagramShape): ElkNode => {
    const inside = children.get(s.id);
    if (s.kind !== 'group' || !inside) return { id: s.id, width: s.w, height: s.h };
    const title = groupTitle(s, targets);
    return {
      id: s.id,
      children: inside.map(node),
      layoutOptions: {
        ...spacing,
        'elk.padding': `[top=${title.band},left=${GROUP_PAD},bottom=${GROUP_PAD},right=${GROUP_PAD}]`,
        'elk.nodeSize.constraints': 'MINIMUM_SIZE',
        'elk.nodeSize.minimum': `(${title.w}, ${title.band + GROUP_PAD})`,
      },
    };
  };
  const edges: ElkExtendedEdge[] = drawn.map((c) => ({ id: `edge:${c.id}`, sources: [c.from], targets: [c.to] }));
  const graph = (variant: Record<string, string>, withEdges: boolean): ElkNode => ({
    id: 'root',
    layoutOptions: {
      ...spacing,
      ...variant,
      'elk.algorithm': 'layered',
      'elk.hierarchyHandling': 'INCLUDE_CHILDREN',
      'elk.edgeRouting': 'ORTHOGONAL',
      // Only here: on a group without edges inside, ELK 0.12 fails with it.
      'elk.layered.considerModelOrder.strategy': 'NODES_AND_EDGES',
      'elk.padding': '[top=0,left=0,bottom=0,right=0]',
    },
    children: (children.get(undefined) ?? []).map(node),
    edges: withEdges ? edges : [],
  });
  elk ??= new ELK();
  let best: (Block & { cost: number }) | undefined;
  for (const variant of drawn.length ? VARIANTS : VARIANTS.slice(0, 1)) {
    // ELK refuses some graphs (edges into a group from inside it, for one); the shapes are then laid out without edges.
    const result = await elk.layout(graph(variant, true)).catch(() => elk!.layout(graph(variant, false)));
    const boxes = gridded(result, members);
    const left = clearLines(boxes, members, drawn, direction, targets);
    const bounds = union([...boxes.values()])!;
    const cost = left * PROBLEM_COST + bounds.w + bounds.h;
    if (best && cost >= best.cost) continue;
    for (const [id, b] of boxes) boxes.set(id, { ...b, x: b.x - bounds.x, y: b.y - bounds.y });
    best = { boxes, w: bounds.w, h: bounds.h, cost };
    if (!left) break;
  }
  return { boxes: best!.boxes, w: best!.w, h: best!.h };
}

/** ELK's result as absolute boxes from (0, 0) on the grid; groups grown outward to the grid, other shapes at their own size. */
function gridded(result: ElkNode, members: Map<string, DiagramShape>): Map<string, Box> {
  const boxes = new Map<string, Box>();
  const collect = (n: ElkNode, dx: number, dy: number) => {
    for (const child of n.children ?? []) {
      const x = dx + (child.x ?? 0);
      const y = dy + (child.y ?? 0);
      boxes.set(child.id, { x, y, w: child.width ?? 0, h: child.height ?? 0 });
      collect(child, x, y);
    }
  };
  collect(result, 0, 0);
  const left = Math.min(...[...boxes.values()].map((b) => b.x));
  const top = Math.min(...[...boxes.values()].map((b) => b.y));
  for (const [id, b] of boxes) {
    const s = members.get(id)!;
    boxes.set(id, s.kind === 'group' ? snapOut({ ...b, x: b.x - left, y: b.y - top }) : { x: snap(b.x - left), y: snap(b.y - top), w: s.w, h: s.h });
  }
  return boxes;
}

/**
 * Lines are drawn with the renderer's own routes, not ELK's, so a line that skips a layer can run through a
 * shape, and labels can land on shapes, labels or lines. Moves the shapes concerned (the shape in the way,
 * the ends of a line whose label is in the way, the groups holding them, each with its content) across the
 * reading direction, then along it, the least distance that lowers the number of such problems. A move
 * never makes a shape overlap another; a group grows to hold a child moved out of its frame. Returns how
 * many problems are left.
 */
function clearLines(boxes: Map<string, Box>, members: Map<string, DiagramShape>, connectors: DiagramConnector[], direction: Direction, targets: LinkTargets): number {
  const across = direction === 'right' ? 'y' : 'x';
  const along = across === 'x' ? 'y' : 'x';
  const byId = new Map(connectors.map((c) => [c.id, c]));
  const problems = () => lineProblems([...boxes].map(([id, b]) => ({ ...b, id, kind: members.get(id)!.kind })), connectors, direction);
  const ancestors = (id: string) => {
    const out: string[] = [];
    for (let p = members.get(id)!.parent; p && members.has(p) && !out.includes(p); p = members.get(p)!.parent) out.push(p);
    return out;
  };
  const inside = (id: string) => [...members.keys()].filter((d) => ancestors(d).includes(id));
  const ends = (connector: string) => [byId.get(connector)!.to, byId.get(connector)!.from];

  /** Moves a shape with its content, growing the groups that hold it; undoes the move and returns false when something would overlap. */
  const move = (id: string, by: { x: number; y: number }): boolean => {
    const before = new Map(boxes);
    const moved = [id, ...inside(id)];
    for (const m of moved) boxes.set(m, { ...boxes.get(m)!, x: boxes.get(m)!.x + by.x, y: boxes.get(m)!.y + by.y });
    const grown = ancestors(id);
    for (const g of grown) {
      const content = union([...members.values()].filter((s) => s.parent === g).map((s) => boxes.get(s.id)!))!;
      const band = groupTitle(members.get(g)!, targets).band;
      boxes.set(g, snapOut(union([boxes.get(g)!, { x: content.x - GROUP_PAD, y: content.y - band, w: content.w + 2 * GROUP_PAD, h: content.h + band + GROUP_PAD }])!));
    }
    const clash = [id, ...grown].some((changed) => {
      const related = new Set([changed, ...ancestors(changed), ...inside(changed)]);
      const mine = inflate(boxes.get(changed)!, NODE_GAP / 2 - 1);
      return [...boxes].some(([other, b]) => !related.has(other) && overlaps(mine, b));
    });
    if (clash) for (const [k, b] of before) boxes.set(k, b);
    return !clash;
  };

  let budget = CLEAR_BUDGET;
  let current = problems();
  while (current.length && budget > 0) {
    const suspects = current.flatMap((p) => (p.kind === 'crosses' ? [p.other] : p.kind === 'label-shape' ? [p.other, ...ends(p.connector)] : [...ends(p.connector), ...ends(p.other)]));
    const tried = new Set(suspects.flatMap((id) => [id, ...ancestors(id)]));
    let better: typeof current | undefined;
    for (const target of tried) {
      const steps = [
        ...Array.from({ length: MAX_SHIFT / (2 * GRID) }, (_, i) => (i + 1) * 2 * GRID).flatMap((d) => [{ [across]: -d, [along]: 0 }, { [across]: d, [along]: 0 }]),
        ...Array.from({ length: MAX_SHIFT / (4 * GRID) }, (_, i) => (i + 1) * 2 * GRID).flatMap((d) => [{ [across]: 0, [along]: d }, { [across]: 0, [along]: -d }]),
      ] as { x: number; y: number }[];
      for (const by of steps) {
        if (budget <= 0) break;
        const before = new Map(boxes);
        if (!move(target, by)) continue;
        budget--;
        const after = problems();
        if (after.length < current.length) {
          better = after;
          break;
        }
        for (const [k, b] of before) boxes.set(k, b);
      }
      if (better) break;
    }
    if (!better) return current.length;
    current = better;
  }
  return current.length;
}

/**
 * Spacing that leaves room for connector labels as the renderer places them: between layers for the tallest
 * label (reading down) or the widest (reading right), and between neighbours in a layer so the labels of
 * lines fanning out to them stand side by side.
 */
function labelSpacing(connectors: DiagramConnector[], direction: Direction): Record<string, string> {
  const sizes = connectors.flatMap((c) => (c.label.trim() ? [labelSize(c.label)] : []));
  const widest = Math.max(0, ...sizes.map((s) => s.w));
  const tallest = Math.max(0, ...sizes.map((s) => s.h));
  const [between, beside] = direction === 'right' ? [widest + 2 * CLEARANCE, tallest + NODE_GAP / 2] : [tallest + 2 * CLEARANCE, widest * 0.6];
  return {
    'elk.spacing.nodeNode': String(snap(Math.max(NODE_GAP, beside))),
    'elk.layered.spacing.nodeNodeBetweenLayers': String(snap(Math.max(LAYER_GAP, between))),
  };
}

/** The box a connector label takes, wrapped as the renderer wraps it: asked of the router on a plain line. */
function labelSize(label: string): { w: number; h: number } {
  const ends = [{ id: 'a', x: 0, y: 0, w: 10, h: 10 }, { id: 'b', x: 0, y: 1000, w: 10, h: 10 }];
  const box = routeConnectors(ends, [{ id: 'c', from: 'a', to: 'b', label }]).get('c')?.label;
  return box ? { w: box.w, h: box.h } : { w: 0, h: 0 };
}

/** The width a group's title needs, and the band above its content that holds it. */
function groupTitle(group: DiagramShape, targets: LinkTargets): { w: number; band: number } {
  const label = shapeLabel(targets, group);
  const type = textStyle('group', group.size);
  const w = Math.min(480, Math.max(120, Math.ceil(measureText(label, type.labelSize, type.labelWeight)) + 32));
  const text = label.trim() || group.detail?.trim() ? minHeightAt({ kind: 'group', label, detail: group.detail, size: group.size }, w) - 11 : 0;
  return { w, band: snap(Math.max(GROUP_PAD, text + TITLE_GAP)) };
}

/**
 * Places new shapes into a diagram that has an arrangement already. New shapes are taken together as clusters
 * (connected to each other, or a new group with what is inside it), each laid out on its own and then put
 * near what it connects to, on the side the reading direction suggests, at the nearest spot that overlaps
 * nothing. Clusters without a connection go into a column (down) or row (right) beside the content.
 */
class Placer {
  private at = new Map<string, Box>();
  private changed = new Set<string>();
  /** New groups that hold shapes which stay where they are: they are fitted around those first and grow like placed groups. */
  private wrapping = new Set<string>();
  private beside = new Map<string | undefined, Box>();

  constructor(
    private shapes: Map<string, DiagramShape>,
    private connectors: DiagramConnector[],
    private direction: Direction,
    private targets: LinkTargets,
    private pending: Set<string>,
  ) {
    for (const s of shapes.values()) if (!pending.has(s.id)) this.at.set(s.id, box(s));
    for (const s of shapes.values()) if (!pending.has(s.id)) for (const a of this.ancestors(s.id)) if (pending.has(a)) this.wrapping.add(a);
    for (const id of [...this.wrapping].sort((a, b) => this.ancestors(b).length - this.ancestors(a).length)) {
      this.at.set(id, this.enclosing(shapes.get(id)!, union(this.childBoxes(id))!));
      this.changed.add(id);
    }
  }

  async run(): Promise<Map<string, Box>> {
    const clusters = this.clusters();
    const blocks = new Map<string[], Block>();
    for (const cluster of clusters) {
      const members = cluster.map((id) => this.shapes.get(id)!);
      blocks.set(cluster, await layoutBlock(members, this.connectors, this.direction, this.targets));
    }
    const left = [...clusters];
    while (left.length) {
      const next = left.findIndex((c) => this.links(c).length);
      const [cluster] = left.splice(Math.max(0, next), 1);
      this.put(cluster!, blocks.get(cluster!)!, next >= 0);
    }
    return new Map([...this.changed].map((id) => [id, this.at.get(id)!]));
  }

  /** New shapes grouped into clusters that are placed as one: connected new shapes with the same host, and new groups with their new content. */
  private clusters(): string[][] {
    const ids = [...this.shapes.keys()].filter((id) => this.pending.has(id) && !this.wrapping.has(id));
    const root = new Map(ids.map((id) => [id, id]));
    const find = (id: string): string => (root.get(id) === id ? id : find(root.get(id)!));
    const join = (a: string, b: string) => root.set(find(a), find(b));
    for (const id of ids) {
      const parent = this.shapes.get(id)!.parent;
      if (parent && root.has(parent)) join(id, parent);
    }
    for (const c of this.connectors) if (root.has(c.from) && root.has(c.to) && this.host(c.from) === this.host(c.to)) join(c.from, c.to);
    const out = new Map<string, string[]>();
    for (const id of ids) out.set(find(id), [...(out.get(find(id)) ?? []), id]);
    return [...out.values()];
  }

  /** The shape a new one is placed inside: its nearest ancestor that is not placed with it, if any. */
  private host(id: string): string | undefined {
    return this.ancestors(id).find((a) => !this.pending.has(a) || this.wrapping.has(a));
  }

  private ancestors(id: string): string[] {
    const out: string[] = [];
    for (let p = this.shapes.get(id)?.parent; p && this.shapes.has(p) && !out.includes(p); p = this.shapes.get(p)!.parent) out.push(p);
    return out;
  }

  /** Connectors between a cluster and placed shapes outside it, as [member, other, other is upstream]. */
  private links(cluster: string[]): [string, string, boolean][] {
    const inside = new Set(cluster);
    const host = this.host(cluster[0]!);
    const around = new Set(host ? [host, ...this.ancestors(host)] : []);
    const out: [string, string, boolean][] = [];
    for (const c of this.connectors) {
      if (inside.has(c.to) && !inside.has(c.from) && this.at.has(c.from) && !around.has(c.from)) out.push([c.to, c.from, true]);
      if (inside.has(c.from) && !inside.has(c.to) && this.at.has(c.to) && !around.has(c.to)) out.push([c.from, c.to, false]);
    }
    return out;
  }

  private put(cluster: string[], block: Block, linked: boolean): void {
    const host = this.host(cluster[0]!);
    const main = this.direction === 'right' ? 'x' : 'y';
    const cross = main === 'x' ? 'y' : 'x';
    const extent = main === 'x' ? 'w' : 'h';
    let preferred: { x: number; y: number };
    let sign = 1;
    let along: 'x' | 'y' = main;
    if (linked) {
      const links = this.links(cluster);
      sign = links.filter(([, , upstream]) => upstream).length * 2 >= links.length ? 1 : -1;
      const anchors = union(links.map(([, other]) => this.at.get(other)!))!;
      const centre = (b: Box) => b[cross] + b[cross === 'x' ? 'w' : 'h'] / 2;
      const want = average(links.map(([, other]) => centre(this.at.get(other)!)));
      const have = average(links.map(([member]) => centre(block.boxes.get(member)!)));
      preferred = { x: 0, y: 0 };
      preferred[cross] = want - have;
      preferred[main] = sign > 0 ? anchors[main] + anchors[extent] + LAYER_GAP : anchors[main] - LAYER_GAP - block[extent];
    } else {
      along = cross;
      preferred = this.besideSpot(host);
    }
    const spot = this.free(block, { x: snap(preferred.x), y: snap(preferred.y), w: block.w, h: block.h }, host, along, sign);
    for (const [id, b] of block.boxes) {
      this.at.set(id, { ...b, x: b.x + spot.x, y: b.y + spot.y });
      this.changed.add(id);
    }
    if (!linked) this.beside.set(host, { ...spot, w: block.w, h: block.h });
    if (host) this.grow(host);
  }

  /** Where the next unconnected cluster goes: after the previous one, or beside everything in the host. */
  private besideSpot(host: string | undefined): { x: number; y: number } {
    const previous = this.beside.get(host);
    const right = this.direction === 'down';
    if (previous) return right ? { x: previous.x, y: previous.y + previous.h + NODE_GAP } : { x: previous.x + previous.w + NODE_GAP, y: previous.y };
    const content = union([...this.at].filter(([id]) => (host ? this.ancestors(id).includes(host) : true)).map(([, b]) => b));
    if (!content) {
      const frame = host ? this.at.get(host)! : undefined;
      return frame ? { x: frame.x + GROUP_PAD, y: frame.y + groupTitle(this.shapes.get(host!)!, this.targets).band } : { x: ORIGIN, y: ORIGIN };
    }
    return right ? { x: content.x + content.w + LAYER_GAP, y: content.y } : { x: content.x, y: content.y + content.h + LAYER_GAP };
  }

  /**
   * The nearest spot to `wanted` where the block keeps its clearance from every placed shape (except the
   * host and what holds it), searching away from the anchor along `along` (`sign`) and to both sides across.
   * Spots inside the host's frame win over spots that make it grow, and spots where no line runs through a
   * shape and no label covers anything win over nearer ones; after FREE_SPOTS candidates the best so far is taken.
   */
  private free(block: Block, wanted: Box, host: string | undefined, along: 'x' | 'y', sign: number): Box {
    const around = new Set(host ? [host, ...this.ancestors(host)] : []);
    const obstacles = [...this.at].filter(([id]) => !around.has(id)).map(([, b]) => inflate(b, CLEARANCE));
    const frame = host ? this.inner(host) : undefined;
    const across = along === 'x' ? 'y' : 'x';
    let best: { box: Box; cost: number } | undefined;
    let tried = 0;
    for (const [step, side] of OFFSETS) {
      const cost = step + Math.abs(side) * 1.5;
      if (best && cost >= best.cost) break;
      const at = { ...wanted };
      at[along] += sign * step * 16;
      at[across] += side * 16;
      if (obstacles.some((o) => overlaps(o, at))) continue;
      const total = cost + (frame && !contains(frame, at) ? 1000 : 0) + 400 * this.problemsAt(block, at);
      if (!best || total < best.cost) best = { box: at, cost: total };
      if (++tried >= FREE_SPOTS) break;
    }
    if (best) return best.box;
    const all = union([...this.at.values()]) ?? wanted;
    return along === 'x' ? { ...wanted, x: snap(all.x + all.w + CLEARANCE) } : { ...wanted, y: snap(all.y + all.h + CLEARANCE) };
  }

  /** How many line problems (see `lineProblems`) involving the block there would be with the block at `spot`. */
  private problemsAt(block: Block, spot: Box): number {
    const shapes = [...this.at, ...[...block.boxes].map(([id, b]) => [id, { ...b, x: b.x + spot.x, y: b.y + spot.y }] as const)].map(([id, b]) => ({ ...b, id, kind: this.shapes.get(id)!.kind }));
    const placed = new Set(shapes.map((s) => s.id));
    const lines = new Map(this.connectors.filter((c) => placed.has(c.from) && placed.has(c.to)).map((c) => [c.id, c]));
    const involved = (id: string) => block.boxes.has(id) || (lines.has(id) && (block.boxes.has(lines.get(id)!.from) || block.boxes.has(lines.get(id)!.to)));
    return lineProblems(shapes, [...lines.values()], this.direction).filter((p) => involved(p.connector) || involved(p.other)).length;
  }

  /** The area of a group where content goes: inside its padding, below its title. */
  private inner(id: string): Box {
    const b = this.at.get(id)!;
    const band = groupTitle(this.shapes.get(id)!, this.targets).band;
    return { x: b.x + GROUP_PAD, y: b.y + band, w: b.w - 2 * GROUP_PAD, h: b.h - band - GROUP_PAD };
  }

  private childBoxes(id: string): Box[] {
    return [...this.shapes.values()].filter((s) => s.parent === id && this.at.has(s.id)).map((s) => this.at.get(s.id)!);
  }

  private enclosing(group: DiagramShape, content: Box): Box {
    const band = groupTitle(group, this.targets).band;
    return snapOut({ x: content.x - GROUP_PAD, y: content.y - band, w: content.w + 2 * GROUP_PAD, h: content.h + band + GROUP_PAD });
  }

  /** Grows a placed group to hold its children, pushes aside the shapes beside it it now covers, then does the same for its own group. */
  private grow(id: string): void {
    const before = this.at.get(id)!;
    const after = snapOut(union([before, this.enclosing(this.shapes.get(id)!, union(this.childBoxes(id))!)])!);
    if (after.x === before.x && after.y === before.y && after.w === before.w && after.h === before.h) return;
    this.at.set(id, after);
    this.changed.add(id);
    this.pushAside(id, after.w - before.w >= after.h - before.h ? 'x' : 'y', new Set([id]));
    const parent = this.shapes.get(id)!.parent;
    if (parent && this.at.has(parent)) this.grow(parent);
  }

  /** Moves the siblings a shape now covers (with what they hold) out of its way along `axis`, and so on from them. */
  private pushAside(id: string, axis: 'x' | 'y', moved: Set<string>): void {
    const self = this.at.get(id)!;
    const parent = this.shapes.get(id)!.parent;
    const extent = axis === 'x' ? 'w' : 'h';
    for (const s of this.shapes.values()) {
      const other = this.at.get(s.id);
      if (!other || moved.has(s.id) || s.parent !== parent || !overlaps(inflate(self, CLEARANCE - 1), other)) continue;
      if (other[axis] + other[extent] / 2 < self[axis] + self[extent] / 2) continue;
      const by = snap(self[axis] + self[extent] + CLEARANCE - other[axis]);
      for (const shifted of [s.id, ...[...this.shapes.keys()].filter((d) => this.ancestors(d).includes(s.id))]) {
        const b = this.at.get(shifted);
        if (!b) continue;
        this.at.set(shifted, { ...b, [axis]: b[axis] + by });
        this.changed.add(shifted);
      }
      moved.add(s.id);
      this.pushAside(s.id, axis, moved);
    }
  }
}

/** How many free spots `free` weighs before it settles for the best of them. */
const FREE_SPOTS = 120;

/** Search offsets as [steps along, steps across], cheapest first: straight ahead, then fanning out to both sides. */
const OFFSETS: [number, number][] = (() => {
  const out: [number, number][] = [];
  for (let step = 0; step <= 80; step++) for (let side = -40; side <= 40; side++) out.push([step, side]);
  return out.sort((a, b) => a[0] + Math.abs(a[1]) * 1.5 - (b[0] + Math.abs(b[1]) * 1.5) || a[0] - b[0] || Math.abs(a[1]) - Math.abs(b[1]) || b[1] - a[1]);
})();

function box(s: DiagramShape): Box {
  return { x: s.x, y: s.y, w: s.w, h: s.h };
}

function overlaps(a: Box, b: Box): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

function contains(outer: Box, inner: Box): boolean {
  return inner.x >= outer.x && inner.y >= outer.y && inner.x + inner.w <= outer.x + outer.w && inner.y + inner.h <= outer.y + outer.h;
}

function inflate(b: Box, by: number): Box {
  return { x: b.x - by, y: b.y - by, w: b.w + 2 * by, h: b.h + 2 * by };
}

function union(boxes: Box[]): Box | undefined {
  if (!boxes.length) return undefined;
  const x = Math.min(...boxes.map((b) => b.x));
  const y = Math.min(...boxes.map((b) => b.y));
  return { x, y, w: Math.max(...boxes.map((b) => b.x + b.w)) - x, h: Math.max(...boxes.map((b) => b.y + b.h)) - y };
}

function average(values: number[]): number {
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

function snap(n: number): number {
  return Math.round(n / GRID) * GRID;
}

/** The smallest box on the grid that covers `b`. */
function snapOut(b: Box): Box {
  const x = Math.floor(b.x / GRID) * GRID;
  const y = Math.floor(b.y / GRID) * GRID;
  return { x, y, w: Math.ceil((b.x + b.w) / GRID) * GRID - x, h: Math.ceil((b.y + b.h) / GRID) * GRID - y };
}
