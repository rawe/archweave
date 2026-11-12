/**
 * Optimistic, client-side application of a ChangeSet. Mirrors the server's
 * upsert semantics closely enough for immediate feedback; the server snapshot
 * that follows is always the truth.
 */
import {
  Element,
  Flow,
  Relation,
  slugify,
  uniqueId,
  type ChangeSet,
  type Layout,
  type Model,
} from '../../shared/model.ts';
import { descendantsOf } from '../../shared/projection.ts';

export interface Doc {
  model: Model;
  layout: Layout;
}

const RECENT_NOTE_MS = 60_000;

export function applyLocal(doc: Doc, cs: ChangeSet, now = Date.now()): Doc {
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
        next = { ...elements[at]!, ...stripUndefined(rest) };
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
      if (at >= 0) relations[at] = { ...relations[at]!, ...stripUndefined(patch) };
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
      if (at >= 0) flows[at] = { ...flows[at]!, ...stripUndefined(patch) };
      else {
        if (!patch.name) continue;
        const id = patch.id ?? uniqueId(slugify(patch.name), new Set(flows.map((f) => f.id)));
        const parsed = Flow.safeParse({ ...stripUndefined(patch), id });
        if (parsed.success) flows.push(parsed.data);
      }
    }
    model = { ...model, flows };
  }

  const remove = cs.remove;
  if (remove?.elements?.length || remove?.relations?.length || remove?.flows?.length) {
    const goneElements = new Set<string>();
    for (const id of remove.elements ?? []) {
      goneElements.add(id);
      for (const d of descendantsOf(id, model.elements)) goneElements.add(d.id);
    }
    const goneRelations = new Set(remove.relations ?? []);
    const goneFlows = new Set(remove.flows ?? []);
    model = {
      ...model,
      elements: model.elements.filter((el) => !goneElements.has(el.id)),
      relations: model.relations.filter(
        (r) => !goneRelations.has(r.id) && !goneElements.has(r.from) && !goneElements.has(r.to),
      ),
      flows: model.flows
        .filter((f) => !goneFlows.has(f.id))
        .map((f) =>
          goneElements.size && f.steps.some((s) => goneElements.has(s.from) || goneElements.has(s.to))
            ? { ...f, steps: f.steps.filter((s) => !goneElements.has(s.from) && !goneElements.has(s.to)) }
            : f,
        ),
    };
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

export function isLayoutOnly(cs: ChangeSet): boolean {
  return !!cs.layout && !cs.model && !cs.elements?.length && !cs.relations?.length && !cs.flows?.length && !cs.remove;
}

function stripUndefined<T extends object>(obj: T): Partial<T> {
  const out: Partial<T> = {};
  for (const [k, v] of Object.entries(obj)) if (v !== undefined) (out as Record<string, unknown>)[k] = v;
  return out;
}
