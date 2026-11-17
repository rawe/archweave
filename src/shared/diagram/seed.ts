/**
 * Starting a diagram from the model: a linked shape per element and a connector per relation among them.
 * Pure, so the server's `seed` and the browser's "add from model" draw the same thing.
 */
import type { ConnectorPatch, Diagram, Element, Model, Relation, ShapePatch } from '../model.ts';
import { uniqueId } from '../model.ts';
import { didYouMean } from '../suggest.ts';

export interface SeedResult {
  setShapes: ShapePatch[];
  setConnectors: ConnectorPatch[];
  /** Unknown element ids, one line each with a did-you-mean. Nothing is seeded when there are any. */
  errors: string[];
}

/**
 * What `seed: elementIds` adds to `diagram` (absent for a new one), as `setShapes` / `setConnectors` entries:
 * - a linked shape, text left empty so it shows the element's live name, for each element no shape links to
 *   yet; its kind and outline follow the element (see `seededLook`), without a position;
 * - an element seeded together with one of its ancestors goes inside it, and that ancestor becomes a `group`;
 *   an element whose ancestor is drawn already as a group goes into that group;
 * - a connector for each relation, lifted as the structure perspective lifts it: an end that has no shape is
 *   drawn from its nearest ancestor that has one. Relations that lift to one shape, to a shape and its own
 *   group, or to a pair already connected in that direction are left out. Relations lifting to the same pair
 *   and direction share one connector, labelled when they all say the same thing; one relation keeps its own
 *   label. Planned relations are dashed and deprecated ones dotted, a shared connector only when all are.
 */
export function seedPatch(model: Pick<Model, 'elements' | 'relations'>, diagram: Diagram | undefined, elementIds: string[]): SeedResult {
  const byId = new Map(model.elements.map((e) => [e.id, e]));
  const errors = elementIds.filter((id) => !byId.has(id)).map((id) => `seed: unknown element \`${id}\`.${didYouMean(id, model.elements)}`);
  if (errors.length) return { setShapes: [], setConnectors: [], errors };

  const shapes = diagram?.shapes ?? [];
  const taken = new Set([...shapes, ...(diagram?.connectors ?? [])].map((s) => s.id));
  const shown = new Map<string, string>();
  for (const s of shapes) if (s.link?.type === 'element' && !shown.has(s.link.id)) shown.set(s.link.id, s.id);
  const kinds = new Map(shapes.map((s) => [s.id, s.kind]));
  const parents = new Map(shapes.flatMap((s) => (s.parent ? [[s.id, s.parent] as const] : [])));

  const seeded = [...new Set(elementIds)].filter((id) => !shown.has(id)).map((id) => byId.get(id)!);
  const fresh = new Set(seeded.map((e) => e.id));
  for (const e of seeded) {
    const id = uniqueId(e.id, taken);
    taken.add(id);
    shown.set(e.id, id);
  }
  const groups = new Set<string>();
  for (const e of seeded) {
    const holder = drawnAncestor(e, byId, shown);
    if (!holder) continue;
    const shape = shown.get(holder)!;
    if (fresh.has(holder)) groups.add(holder);
    else if (kinds.get(shape) !== 'group') continue;
    parents.set(shown.get(e.id)!, shape);
  }
  const setShapes = seeded.map((e): ShapePatch => {
    const id = shown.get(e.id)!;
    const parent = parents.get(id);
    return { id, ...seededLook(e, groups.has(e.id)), link: { type: 'element', id: e.id }, ...(parent ? { parent } : {}) };
  });

  const inside = (a: string, b: string) => {
    for (let p = parents.get(a); p; p = parents.get(p)) if (p === b) return true;
    return false;
  };
  const drawn = new Set((diagram?.connectors ?? []).map((c) => `${c.from}>${c.to}`));
  const lifted = (id: string) => {
    const holder = shown.has(id) ? id : byId.has(id) ? drawnAncestor(byId.get(id)!, byId, shown) : undefined;
    return holder && shown.get(holder);
  };
  const pairs = new Map<string, { from: string; to: string; relations: Relation[] }>();
  for (const r of model.relations) {
    const from = lifted(r.from);
    const to = lifted(r.to);
    const key = `${from}>${to}`;
    if (!from || !to || from === to || drawn.has(key) || inside(from, to) || inside(to, from)) continue;
    pairs.set(key, { from, to, relations: [...(pairs.get(key)?.relations ?? []), r] });
  }
  const setConnectors = [...pairs.values()].map(({ from, to, relations }): ConnectorPatch => {
    const id = uniqueId(`${from}-to-${to}`, taken);
    taken.add(id);
    const labels = new Set(relations.map((r) => r.label));
    const label = labels.size === 1 ? relations[0]!.label : '';
    const all = (status: Relation['status']) => relations.every((r) => r.status === status);
    const line = all('planned') ? 'dashed' : all('deprecated') ? 'dotted' : undefined;
    return { id, from, to, ...(label ? { label } : {}), ...(line ? { line } : {}) };
  });
  return { setShapes, setConnectors, errors: [] };
}

/**
 * How a seeded element is drawn: stores as cylinders, queues as pills, actors as actors, the rest as boxes
 * (or a group when it holds other seeded shapes); externals and planned elements dashed, deprecated ones dotted.
 */
export function seededLook(element: Element, group = false): Pick<ShapePatch, 'kind' | 'outline'> {
  const kind = group ? 'group' : element.kind === 'store' ? 'cylinder' : element.kind === 'queue' ? 'pill' : element.kind === 'actor' ? 'actor' : 'box';
  const outline = element.status === 'deprecated' ? 'dotted' : element.status === 'planned' || element.kind === 'external' ? 'dashed' : undefined;
  return { kind, ...(outline ? { outline } : {}) };
}

/** The nearest ancestor of an element that has a shape on the diagram. */
function drawnAncestor(element: Element, byId: ReadonlyMap<string, Element>, shown: ReadonlyMap<string, string>): string | undefined {
  const seen = new Set<string>();
  for (let id = element.parentId; id && !seen.has(id); id = byId.get(id)?.parentId) {
    if (shown.has(id)) return id;
    seen.add(id);
  }
  return undefined;
}
