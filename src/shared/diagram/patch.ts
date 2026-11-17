/**
 * The one place a diagram changes: the server's change sets and the browser's optimistic apply
 * both go through `applyDiagramPatch`, so the two can never drift.
 */
import { Diagram, type DiagramConnector, type DiagramPatch, type DiagramShape, type ConnectorPatch, type Model, type ModelLink, type ShapePatch, slugify, uniqueId } from '../model.ts';
import { didYouMean } from '../suggest.ts';
import { fitShape, grownToFit } from './fit.ts';
import { linkName, shapeLabel } from './links.ts';

/** The collections a shape may link into. */
export type LinkTargets = Pick<Model, 'elements' | 'flows' | 'diagrams'>;

export interface DiagramPatchContext {
  /** The id of the diagram: the existing one's, or the one a new diagram gets. */
  id: string;
  /** What links are checked and linked shapes are named against. `diagrams` need not hold this diagram. */
  model: LinkTargets;
}

export interface DiagramPatchResult {
  /** The patched diagram; absent when there are errors. */
  diagram?: Diagram;
  /** One line per problem, naming the diagram and the entry. */
  errors: string[];
  /** New shapes that came without a position and sit at a fallback one, for a later arrangement step. */
  unplaced: string[];
}

/** The gap between shapes placed without a position, and the grid they snap to. */
const GAP = 24;
const GRID = 8;

/** A shape while a patch is applied: a new one may still wait for its position. */
type PendingShape = Omit<DiagramShape, 'x' | 'y'> & { x?: number; y?: number };

/**
 * Applies a patch to `existing`, or creates the diagram when there is none (`name` is required then).
 * Never mutates its inputs.
 *
 * Order: the full lists `shapes` / `connectors` replace the stored ones, then `removeShapes` and
 * `removeConnectors` apply, then `setShapes` and `setConnectors` upsert by id.
 *
 * - A full-list entry is a complete definition: what it leaves out takes the default, not the stored value.
 *   The one exception is geometry: an entry whose id existed keeps the stored `x`, `y`, `w`, `h` it does not
 *   mention, so resending a list without positions never moves or resizes anything.
 * - `setShapes` / `setConnectors` change only the given properties; `null` clears an optional one.
 * - Shapes and connectors share one id namespace. A shape without id gets the slug of its text, else of its
 *   link id, else its kind; a connector gets `<from>-to-<to>`; both made unique.
 * - A new shape without `w` or `h` is sized to fit its label. A new shape without both `x` and `y` is put in a
 *   row below everything else and reported in `unplaced`. Existing shapes never move unless `x`/`y` are sent.
 * - Removing a shape (or leaving it out of a full list) removes the connectors attached to it. What was
 *   inside a group removed with `removeShapes` moves out to the group's own parent; in a full list every
 *   entry states its own `parent`, which must be in the list.
 * - Geometry is stored rounded to one decimal.
 */
export function applyDiagramPatch(existing: Diagram | undefined, patch: DiagramPatch, ctx: DiagramPatchContext): DiagramPatchResult {
  const at = `diagram \`${ctx.id}\``;
  const name = patch.name ?? existing?.name;
  if (name === undefined) return { errors: [`${at}: a new diagram needs \`name\`.`], unplaced: [] };

  const errors: string[] = [];
  const stored = new Map((existing?.shapes ?? []).map((s) => [s.id, s]));
  const shapes = new Map<string, PendingShape>(patch.shapes ? [] : stored);
  const connectors = new Map<string, DiagramConnector>(patch.connectors ? [] : (existing?.connectors ?? []).map((c) => [c.id, c]));
  const lists = [patch.shapes, patch.connectors, patch.setShapes, patch.setConnectors] as ({ id?: string }[] | undefined)[];
  const explicit = lists.flatMap((list) => (list ?? []).flatMap((entry) => (entry.id ? [entry.id] : [])));
  const taken = () => new Set([...shapes.keys(), ...connectors.keys(), ...explicit]);
  const shapeNames = () => [...shapes.values()].map((s) => ({ id: s.id, name: s.text }));
  /** Shapes whose parent this patch wrote: it answers for them. */
  const parented = new Set<string>();

  const writeShape = (entry: ShapePatch, index: number, list: 'shapes' | 'setShapes') => {
    const where = entry.id ? `${at} shape \`${entry.id}\`` : `${at} ${list}[${index}]`;
    const full = list === 'shapes';
    const current = entry.id ? shapes.get(entry.id) : undefined;
    if (full && current) return void errors.push(`${where}: duplicate id in \`shapes\`.`);
    if (entry.id && connectors.has(entry.id)) return void errors.push(`${where}: \`${entry.id}\` is a connector of this diagram; shapes and connectors share their ids.`);
    const kept = full && entry.id ? stored.get(entry.id) : undefined;
    const next = merged(current ?? (kept ? { x: kept.x, y: kept.y, w: kept.w, h: kept.h } : {}), entry) as Partial<DiagramShape>;
    next.kind ??= 'box';
    next.text ??= '';
    if (entry.link) {
      const { type, id } = entry.link;
      if (type === 'diagram' && id === ctx.id) errors.push(`${where}: link: a diagram cannot link to itself.`);
      else if (linkName(ctx.model, entry.link) === undefined) errors.push(`${where}: link: unknown ${type} \`${id}\`.${didYouMean(id, ctx.model[`${type}s`])}`);
    }
    if (next.w === undefined || next.h === undefined) {
      const fit = fitShape({ kind: next.kind, label: shapeLabel(ctx.model, { text: next.text, link: next.link }), detail: next.detail, size: next.size });
      next.w ??= round(fit.w);
      next.h ??= round(fit.h);
    }
    const id = entry.id ?? uniqueId(slugify([next.text, next.link?.id].find((s) => s && /[a-z0-9]/i.test(s)) ?? next.kind), taken());
    if (entry.parent) parented.add(id);
    shapes.set(id, { ...next, id } as PendingShape);
  };

  const writeConnector = (entry: ConnectorPatch, index: number, list: 'connectors' | 'setConnectors') => {
    const where = entry.id ? `${at} connector \`${entry.id}\`` : `${at} ${list}[${index}]`;
    const full = list === 'connectors';
    const current = entry.id ? connectors.get(entry.id) : undefined;
    if (full && current) return void errors.push(`${where}: duplicate id in \`connectors\`.`);
    if (entry.id && shapes.has(entry.id)) return void errors.push(`${where}: \`${entry.id}\` is a shape of this diagram; shapes and connectors share their ids.`);
    const next = merged(current ?? {}, entry) as Partial<DiagramConnector>;
    if (!next.from || !next.to) {
      const missing = entry.id && !full ? `there is no connector \`${entry.id}\`. To create it, give \`from\` and \`to\`.${didYouMean(entry.id, connectors.values())}` : 'a new connector needs `from` and `to`.';
      return void errors.push(`${where}: ${missing}`);
    }
    next.label ??= '';
    const id = entry.id ?? uniqueId(slugify(`${next.from}-to-${next.to}`), taken());
    connectors.set(id, { ...next, id } as DiagramConnector);
  };

  patch.shapes?.forEach((entry, i) => writeShape(entry, i, 'shapes'));
  for (const c of [...connectors.values()]) if (!shapes.has(c.from) || !shapes.has(c.to)) connectors.delete(c.id);
  patch.connectors?.forEach((entry, i) => writeConnector(entry, i, 'connectors'));

  for (const id of patch.removeShapes ?? []) {
    if (shapes.has(id)) continue;
    errors.push(`${at} removeShapes: ${connectors.has(id) ? `\`${id}\` is a connector; name it in \`removeConnectors\`.` : `unknown shape \`${id}\`.${didYouMean(id, shapeNames())}`}`);
  }
  for (const id of patch.removeConnectors ?? []) {
    if (connectors.has(id)) continue;
    errors.push(`${at} removeConnectors: ${shapes.has(id) ? `\`${id}\` is a shape; name it in \`removeShapes\`.` : `unknown connector \`${id}\`.${didYouMean(id, connectors.values())}`}`);
  }
  for (const id of patch.removeShapes ?? []) {
    const gone = shapes.get(id);
    if (!gone) continue;
    shapes.delete(id);
    for (const shape of [...shapes.values()]) if (shape.parent === id) shapes.set(shape.id, withParent(shape, gone.parent));
    for (const c of [...connectors.values()]) if (c.from === id || c.to === id) connectors.delete(c.id);
  }
  for (const id of patch.removeConnectors ?? []) connectors.delete(id);

  patch.setShapes?.forEach((entry, i) => writeShape(entry, i, 'setShapes'));
  patch.setConnectors?.forEach((entry, i) => writeConnector(entry, i, 'setConnectors'));

  const orphans = new Map<string, string[]>();
  for (const shape of shapes.values()) {
    const { id, parent } = shape;
    if (parent === undefined) continue;
    const where = `${at} shape \`${id}\``;
    const holder = shapes.get(parent);
    const groups = [...shapes.values()].filter((s) => s.kind === 'group' && s.id !== id).map((s) => ({ id: s.id, name: s.text }));
    if (parent === id) errors.push(`${where}: cannot be its own parent.`);
    else if (!holder) errors.push(`${where}: unknown parent \`${parent}\`.${didYouMean(parent, groups)}`);
    else if (holder.kind !== 'group') {
      if (parented.has(id)) errors.push(`${where}: parent \`${parent}\` is a ${holder.kind}, not a group.${didYouMean(parent, groups)}`);
      else orphans.set(parent, [...(orphans.get(parent) ?? []), id]);
    } else if (parented.has(id) && insideItself(id, shapes)) {
      errors.push(`${where}: putting it inside \`${parent}\` creates a containment cycle (\`${parent}\` is inside \`${id}\`).`);
    }
  }
  for (const [id, inside] of orphans) {
    const list = inside.map((i) => `\`${i}\``).join(', ');
    errors.push(`${at} shape \`${id}\`: a ${shapes.get(id)!.kind} cannot hold shapes, but ${list} ${inside.length === 1 ? 'is' : 'are'} inside it. Move ${inside.length === 1 ? 'it' : 'them'} out first (\`parent: null\`) or keep the kind \`group\`.`);
  }
  // Stored connectors that lost an end are gone by now, so what is left dangling was written by this patch.
  for (const connector of connectors.values()) {
    const where = `${at} connector \`${connector.id}\``;
    for (const end of ['from', 'to'] as const) {
      if (!shapes.has(connector[end])) errors.push(`${where}: unknown shape \`${connector[end]}\` in \`${end}\`.${didYouMean(connector[end], shapeNames())}`);
    }
    if (connector.from === connector.to) errors.push(`${where}: \`from\` and \`to\` are the same shape \`${connector.from}\`.`);
  }
  if (errors.length) return { errors, unplaced: [] };

  const waiting = [...shapes.values()].filter((s) => s.x === undefined || s.y === undefined);
  const placed = [...shapes.values()].filter((s) => !waiting.includes(s)) as DiagramShape[];
  let x = placed.length ? snap(Math.min(...placed.map((s) => s.x))) : 0;
  const y = placed.length ? snap(Math.max(...placed.map((s) => s.y + s.h)) + GAP) : 0;
  for (const shape of waiting) {
    shapes.set(shape.id, { ...shape, x, y });
    x = snap(x + shape.w + GAP);
  }

  // A shape is never stored smaller than its text: what is drawn and what is stored stay the same size.
  for (const shape of [...shapes.values()]) {
    if (shape.kind === 'group') continue;
    const grown = grownToFit(shape as DiagramShape, shapeLabel(ctx.model, shape));
    if (grown !== shape) shapes.set(shape.id, { ...grown, w: round(grown.w), h: round(grown.h) });
  }

  const parsed = Diagram.safeParse({
    id: ctx.id,
    name,
    summary: patch.summary ?? existing?.summary,
    direction: patch.direction ?? existing?.direction,
    shapes: [...shapes.values()],
    connectors: [...connectors.values()],
  });
  if (!parsed.success) return { errors: parsed.error.issues.map((issue) => `${at}${describeIssue(issue.path, shapes, connectors)}: ${issue.message}`), unplaced: [] };
  return { diagram: parsed.data, errors: [], unplaced: waiting.map((s) => s.id) };
}

/**
 * A shape that no longer stands for a model item: the link is removed and, when the shape has no text of
 * its own, it keeps the name it showed (`name`, the last known one), else the link's id.
 */
export function unlinkShape(shape: DiagramShape, name?: string): DiagramShape {
  const { link, ...plain } = shape;
  return link ? { ...plain, text: shape.text || name || link.id } : shape;
}

/**
 * Unlinks every shape whose link target is not in `model`, naming it from `before` (the model while the
 * target still existed). Returns the same diagram when nothing was lost.
 */
export function unlinkLost(diagram: Diagram, model: LinkTargets, before?: LinkTargets): { diagram: Diagram; lost: { shape: string; link: ModelLink }[] } {
  const lost: { shape: string; link: ModelLink }[] = [];
  const shapes = diagram.shapes.map((shape) => {
    if (!shape.link || linkName(model, shape.link) !== undefined) return shape;
    lost.push({ shape: shape.id, link: shape.link });
    return unlinkShape(shape, before && linkName(before, shape.link));
  });
  return lost.length ? { diagram: { ...diagram, shapes }, lost } : { diagram, lost };
}

/**
 * What a schema cannot catch inside one diagram: ids used twice (shapes and connectors share them), parents
 * that are missing, not groups or cyclic, connectors with missing or identical ends and, with `model`,
 * links that point at nothing. One readable line per problem; empty when the diagram is consistent.
 */
export function diagramProblems(diagram: Diagram, model?: LinkTargets): string[] {
  const problems: string[] = [];
  const at = `diagram \`${diagram.id}\``;
  const shapes = new Map<string, DiagramShape>();
  const seen = new Set<string>();
  for (const item of [...diagram.shapes, ...diagram.connectors]) {
    if (seen.has(item.id)) problems.push(`${at}: duplicate id \`${item.id}\``);
    seen.add(item.id);
  }
  for (const shape of diagram.shapes) if (!shapes.has(shape.id)) shapes.set(shape.id, shape);
  for (const shape of shapes.values()) {
    const where = `${at} shape \`${shape.id}\``;
    if (shape.parent !== undefined) {
      const holder = shapes.get(shape.parent);
      if (shape.parent === shape.id) problems.push(`${where}: is its own parent`);
      else if (!holder) problems.push(`${where}: unknown parent \`${shape.parent}\``);
      else if (holder.kind !== 'group') problems.push(`${where}: parent \`${shape.parent}\` is not a group`);
      else if (insideItself(shape.id, shapes)) problems.push(`${where}: containment cycle through \`${shape.parent}\``);
    }
    if (!shape.link || !model) continue;
    if (shape.link.type === 'diagram' && shape.link.id === diagram.id) problems.push(`${where}: links to its own diagram`);
    else if (linkName(model, shape.link) === undefined) problems.push(`${where}: link to unknown ${shape.link.type} \`${shape.link.id}\``);
  }
  for (const connector of diagram.connectors) {
    const where = `${at} connector \`${connector.id}\``;
    for (const end of ['from', 'to'] as const) if (!shapes.has(connector[end])) problems.push(`${where}: unknown shape \`${connector[end]}\` in \`${end}\``);
    if (connector.from === connector.to) problems.push(`${where}: \`from\` and \`to\` are the same shape`);
  }
  return problems;
}

/**
 * Makes any schema-valid diagram internally consistent instead of rejecting it, for diagrams read from disk:
 * drops shapes and connectors whose id is taken already (the first keeps it), clears parents that are missing,
 * not groups or cyclic, drops connectors with missing or identical ends, and unlinks shapes whose link target
 * does not exist (see `unlinkShape`; `lastName` gives the name a lost target had, when it is still known).
 * One readable note per repair. Returns the same diagram when there is nothing to repair.
 */
export function repairDiagram(diagram: Diagram, model: LinkTargets, lastName?: (link: ModelLink) => string | undefined): { diagram: Diagram; notes: string[] } {
  const notes: string[] = [];
  const at = `diagram \`${diagram.id}\``;
  const shapes = new Map<string, DiagramShape>();
  const connectors = new Map<string, DiagramConnector>();
  for (const shape of diagram.shapes) {
    if (shapes.has(shape.id)) notes.push(`${at} shape \`${shape.id}\`: dropped a second shape with this id.`);
    else shapes.set(shape.id, shape);
  }
  for (const [id, shape] of shapes) {
    const holder = shape.parent === undefined ? undefined : shapes.get(shape.parent);
    const reason =
      shape.parent === undefined ? undefined
      : shape.parent === id ? 'it named itself'
      : !holder ? `there is no shape \`${shape.parent}\``
      : holder.kind !== 'group' ? `\`${shape.parent}\` is not a group`
      : insideItself(id, shapes) ? `\`${shape.parent}\` is inside it`
      : undefined;
    if (reason) {
      notes.push(`${at} shape \`${id}\`: cleared its parent, ${reason}.`);
      shapes.set(id, withParent(shape, undefined));
    }
  }
  for (const [id, shape] of shapes) {
    const link = shape.link;
    if (!link) continue;
    const own = link.type === 'diagram' && link.id === diagram.id;
    if (!own && linkName(model, link) !== undefined) continue;
    notes.push(`${at} shape \`${id}\`: unlinked from ${own ? 'its own diagram' : `missing ${link.type} \`${link.id}\``}, it keeps the name it showed.`);
    shapes.set(id, unlinkShape(shape, own ? diagram.name : lastName?.(link)));
  }
  for (const connector of diagram.connectors) {
    const where = `${at} connector \`${connector.id}\``;
    const missing = (['from', 'to'] as const).find((end) => !shapes.has(connector[end]));
    if (shapes.has(connector.id) || connectors.has(connector.id)) notes.push(`${where}: dropped, its id is taken already.`);
    else if (missing) notes.push(`${where}: dropped, there is no shape \`${connector[missing]}\` (\`${missing}\`).`);
    else if (connector.from === connector.to) notes.push(`${where}: dropped, both ends are the shape \`${connector.from}\`.`);
    else connectors.set(connector.id, connector);
  }
  return notes.length ? { diagram: { ...diagram, shapes: [...shapes.values()], connectors: [...connectors.values()] }, notes } : { diagram, notes };
}

/** `base` with the given properties of `patch`: `null` clears one, numbers are rounded, `id` is left to the caller. */
function merged(base: object, patch: object): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined || key === 'id') continue;
    if (value === null) delete out[key];
    else out[key] = typeof value === 'number' ? round(value) : value;
  }
  return out;
}

function withParent<S extends { parent?: string }>(shape: S, parent: string | undefined): S {
  const { parent: _old, ...rest } = shape;
  return (parent === undefined ? rest : { ...rest, parent }) as S;
}

/** Whether following the parents of a shape leads back to it. */
function insideItself(id: string, shapes: ReadonlyMap<string, { parent?: string }>): boolean {
  const seen = new Set<string>();
  for (let cursor = shapes.get(id)?.parent; cursor !== undefined && !seen.has(cursor); cursor = shapes.get(cursor)?.parent) {
    if (cursor === id) return true;
    seen.add(cursor);
  }
  return false;
}

/** " shape `a`: w" for a schema issue at shapes.0.w, so the message names the entry, not its index. */
function describeIssue(path: readonly PropertyKey[], shapes: ReadonlyMap<string, unknown>, connectors: ReadonlyMap<string, unknown>): string {
  const [list, index, ...rest] = path;
  const ids = list === 'shapes' ? [...shapes.keys()] : list === 'connectors' ? [...connectors.keys()] : undefined;
  if (!ids || typeof index !== 'number') return path.length ? `: ${path.join('.')}` : '';
  return ` ${String(list).slice(0, -1)} \`${ids[index]}\`${rest.length ? `: ${rest.join('.')}` : ''}`;
}

function round(n: number): number {
  return Math.round(n * 10) / 10;
}

function snap(n: number): number {
  return Math.ceil(n / GRID) * GRID;
}
