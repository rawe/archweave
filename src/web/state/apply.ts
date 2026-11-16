/**
 * Optimistic, client-side application of a change set. Mirrors the server's
 * plain upsert semantics for immediate feedback; the server snapshot that
 * follows is always the truth.
 *
 * The UI only ever sends plain patches: full lists, never the list helpers
 * (`addCodeRefs`, `setFields`, `updateSteps`, …), which stay a convenience for
 * agents. `PlainChangeSet` makes that a type-level guarantee on the commit path.
 * Diagram patches are the exception: they run through the same `applyDiagramPatch`
 * as on the server, so they are carried as they are.
 */
import {
  Element,
  Flow,
  Relation,
  slugify,
  uniqueId,
  type ChangeSet,
  type ElementPatch,
  type FlowPatch,
  type Layout,
  type Model,
  type RelationPatch,
} from '../../shared/model.ts';
import { applyDiagramPatch, unlinkLost } from '../../shared/diagram/patch.ts';
import { descendantsOf } from '../../shared/projection.ts';

export interface Doc {
  model: Model;
  layout: Layout;
}

/** `T` without the keys `K`, which may not even be present as undefined. */
type Without<T, K extends PropertyKey> = Omit<T, K> & { [P in K]?: never };

export type PlainElementPatch = Without<ElementPatch, 'addCodeRefs' | 'removeCodeRefs' | 'setFields' | 'removeFields'>;
export type PlainRelationPatch = Without<RelationPatch, 'addCodeRefs' | 'removeCodeRefs'>;
export type PlainFlowPatch = Without<FlowPatch, 'updateSteps' | 'insertSteps' | 'removeSteps'>;

/** A change set as the UI sends it: plain patches only. */
export type PlainChangeSet = Omit<ChangeSet, 'elements' | 'relations' | 'flows'> & {
  elements?: PlainElementPatch[];
  relations?: PlainRelationPatch[];
  flows?: PlainFlowPatch[];
};

const RECENT_NOTE_MS = 60_000;

export function applyLocal(doc: Doc, cs: PlainChangeSet, now = Date.now()): Doc {
  let { model, layout } = doc;

  if (cs.model) model = { ...model, ...stripUndefined(cs.model) };

  if (cs.elements?.length) {
    const elements = [...model.elements];
    const index = new Map(elements.map((el, i) => [el.id, i]));
    for (const patch of cs.elements) {
      const { addNotes, resolveNotes, parentId, ...rest } = patch;
      const at = patch.id ? index.get(patch.id) : undefined;
      let next: Element;
      if (at !== undefined) {
        next = withDefaults(Element, { ...elements[at]!, ...stripUndefined(rest) });
      } else {
        if (!patch.kind || !patch.name) continue;
        const id = patch.id ?? uniqueId(slugify(patch.name), new Set(index.keys()));
        const parsed = Element.safeParse({ status: 'planned', ...stripUndefined(rest), id });
        if (!parsed.success) continue;
        next = parsed.data;
      }
      if (parentId === null) delete next.parentId;
      else if (parentId !== undefined) next.parentId = parentId;
      if (addNotes?.length) {
        const notes = [...next.notes];
        for (const text of addNotes) {
          const duplicate = notes.some(
            (n) => n.author === 'human' && n.text === text && now - Date.parse(n.createdAt) < RECENT_NOTE_MS,
          );
          if (duplicate) continue;
          const id = uniqueId(`note-${now.toString(36)}`, new Set(notes.map((n) => n.id)));
          notes.push({ id, text, author: 'human', createdAt: new Date(now).toISOString() });
        }
        next.notes = notes;
      }
      if (resolveNotes?.length) {
        next.notes = next.notes.map((n) => (resolveNotes.includes(n.id) ? { ...n, resolved: true } : n));
      }
      if (at !== undefined) elements[at] = next;
      else {
        index.set(next.id, elements.length);
        elements.push(next);
      }
    }
    model = { ...model, elements };
  }

  if (cs.relations?.length) {
    const relations = [...model.relations];
    for (const patch of cs.relations) {
      const at = patch.id ? relations.findIndex((r) => r.id === patch.id) : -1;
      if (at >= 0) relations[at] = withDefaults(Relation, { ...relations[at]!, ...stripUndefined(patch) });
      else {
        if (!patch.from || !patch.to) continue;
        const id = patch.id ?? uniqueId(slugify(`${patch.from}-${patch.kind ?? 'uses'}-${patch.to}`), new Set(relations.map((r) => r.id)));
        const parsed = Relation.safeParse({ ...stripUndefined(patch), id });
        if (parsed.success) relations.push(parsed.data);
      }
    }
    model = { ...model, relations };
  }

  if (cs.flows?.length) {
    const flows = [...model.flows];
    for (const patch of cs.flows) {
      const at = patch.id ? flows.findIndex((f) => f.id === patch.id) : -1;
      if (at >= 0) flows[at] = withDefaults(Flow, { ...flows[at]!, ...stripUndefined(patch) });
      else {
        if (!patch.name) continue;
        const id = patch.id ?? uniqueId(slugify(patch.name), new Set(flows.map((f) => f.id)));
        const parsed = Flow.safeParse({ ...stripUndefined(patch), id });
        if (parsed.success) flows.push(parsed.data);
      }
    }
    model = { ...model, flows };
  }

  if (cs.diagrams?.length) {
    const diagrams = [...model.diagrams];
    for (const patch of cs.diagrams) {
      const at = patch.id ? diagrams.findIndex((d) => d.id === patch.id) : -1;
      if (at < 0 && !patch.name) continue;
      const id = at >= 0 ? diagrams[at]!.id : (patch.id ?? uniqueId(slugify(patch.name!), new Set(diagrams.map((d) => d.id))));
      // A patch the server will refuse is skipped: its answer is the truth.
      const { diagram } = applyDiagramPatch(diagrams[at], patch, { id, model: { ...model, diagrams } });
      if (!diagram) continue;
      if (at >= 0) diagrams[at] = diagram;
      else diagrams.push(diagram);
    }
    model = { ...model, diagrams };
  }

  const remove = cs.remove;
  if (remove?.elements?.length || remove?.relations?.length || remove?.flows?.length || remove?.diagrams?.length) {
    const goneElements = new Set<string>();
    for (const id of remove.elements ?? []) {
      goneElements.add(id);
      for (const d of descendantsOf(id, model.elements)) goneElements.add(d.id);
    }
    const goneRelations = new Set(remove.relations ?? []);
    const goneFlows = new Set(remove.flows ?? []);
    // As on the server: references to removed structures are dropped along with them.
    const keptData = (ids: string[]) => (ids.some((id) => goneElements.has(id)) ? ids.filter((id) => !goneElements.has(id)) : ids);
    model = {
      ...model,
      elements: model.elements
        .filter((el) => !goneElements.has(el.id))
        .map((el) =>
          el.fields.some((f) => f.ref && goneElements.has(f.ref))
            ? { ...el, fields: el.fields.map((f) => (f.ref && goneElements.has(f.ref) ? stripUndefined({ ...f, ref: undefined }) as typeof f : f)) }
            : el,
        ),
      relations: model.relations
        .filter((r) => !goneRelations.has(r.id) && !goneElements.has(r.from) && !goneElements.has(r.to))
        .map((r) => ({ ...r, dataIds: keptData(r.dataIds) })),
      flows: model.flows
        .filter((f) => !goneFlows.has(f.id))
        .map((f) =>
          goneElements.size
            ? { ...f, steps: f.steps.filter((s) => !goneElements.has(s.from) && !goneElements.has(s.to)).map((s) => ({ ...s, dataIds: keptData(s.dataIds) })) }
            : f,
        ),
      diagrams: remove.diagrams?.length ? model.diagrams.filter((d) => !remove.diagrams!.includes(d.id)) : model.diagrams,
    };
    // As on the server: shapes that linked to something removed stay, with the name they showed before this change set.
    if (model.diagrams.some((d) => d.shapes.some((s) => s.link))) {
      const targets = model;
      model = { ...model, diagrams: model.diagrams.map((d) => unlinkLost(d, targets, doc.model).diagram) };
    }
    if (goneElements.size) {
      const next: Layout = {};
      for (const [key, positions] of Object.entries(layout)) {
        const kept = Object.fromEntries(Object.entries(positions).filter(([id]) => !goneElements.has(id)));
        next[key] = kept;
      }
      layout = next;
    }
  }

  if (cs.layout) {
    const next: Layout = { ...layout };
    for (const [key, positions] of Object.entries(cs.layout)) {
      const canvas = { ...(next[key] ?? {}) };
      for (const [id, pos] of Object.entries(positions)) {
        if (pos) canvas[id] = { x: pos.x, y: pos.y };
        else delete canvas[id];
      }
      next[key] = canvas;
    }
    layout = next;
  }

  return { model, layout };
}

export function isLayoutOnly(cs: PlainChangeSet): boolean {
  return !!cs.layout && !cs.model && !cs.elements?.length && !cs.relations?.length && !cs.flows?.length && !cs.diagrams?.length && !cs.remove;
}

/** The patched entry with the schema's defaults filled in, as the server stores it. */
function withDefaults<T>(schema: { safeParse(value: unknown): { success: true; data: T } | { success: false } }, value: T): T {
  const parsed = schema.safeParse(value);
  return parsed.success ? parsed.data : value;
}

function stripUndefined<T extends object>(obj: T): Partial<T> {
  const out: Partial<T> = {};
  for (const [k, v] of Object.entries(obj)) if (v !== undefined) (out as Record<string, unknown>)[k] = v;
  return out;
}
