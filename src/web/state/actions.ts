/** Model edits shared by the canvas, keyboard, inspector and palette. */
import { slugify, uniqueId, type ElementKind, type Position, type RelationKind } from '../../shared/model.ts';
import { descendantsOf } from '../../shared/projection.ts';
import { confirmAction } from '../chrome/Confirm.tsx';
import { plural } from '../lib/format.ts';
import { clearSelection, commit, getState, select, setState } from './store.ts';

export function canvasKey(scopeId?: string): string {
  return `structure:${scopeId ?? 'root'}`;
}

function takenElementIds(): Set<string> {
  return new Set(getState().model.elements.map((e) => e.id));
}

export async function createElement(opts: {
  name: string;
  kind: ElementKind;
  parentId?: string;
  position?: Position;
  canvas?: string;
}): Promise<string> {
  const id = uniqueId(slugify(opts.name), takenElementIds());
  const layout = opts.position && opts.canvas ? { [opts.canvas]: { [id]: opts.position } } : undefined;
  select({ elementIds: [id] });
  void commit({
    summary: `Added ${opts.name}`,
    elements: [{ id, kind: opts.kind, name: opts.name, parentId: opts.parentId, status: 'planned' }],
    layout,
  });
  return id;
}

export function connect(from: string, to: string, kind: RelationKind = 'uses') {
  if (from === to) return;
  const { model } = getState();
  const a = model.elements.find((e) => e.id === from);
  const b = model.elements.find((e) => e.id === to);
  if (!a || !b) return;
  const id = uniqueId(slugify(`${from}-${kind}-${to}`), new Set(model.relations.map((r) => r.id)));
  const status = a.status === 'built' && b.status === 'built' ? 'built' : 'planned';
  void commit({ summary: `Connected ${a.name} to ${b.name}`, relations: [{ id, from, to, kind, status }] });
  setState({ selection: { elementIds: [], relationIds: [id], edgeKey: `${from}->${to}` }, labelFocusFor: id });
}

export function reparent(ids: string[], parentId: string | null, fromCanvas?: string) {
  const { model } = getState();
  const target = parentId ? model.elements.find((e) => e.id === parentId) : undefined;
  const movable = ids.filter((id) => {
    if (id === parentId) return false;
    if (!parentId) return true;
    return !descendantsOf(id, model.elements).some((d) => d.id === parentId);
  });
  if (!movable.length) return;
  const names = movable.map((id) => model.elements.find((e) => e.id === id)?.name ?? id);
  void commit({
    summary: `Moved ${names.length === 1 ? names[0] : plural(names.length, 'element')} ${target ? `into ${target.name}` : 'to the top level'}`,
    elements: movable.map((id) => ({ id, parentId })),
    layout: fromCanvas ? { [fromCanvas]: Object.fromEntries(movable.map((id) => [id, null])) } : undefined,
  });
}

export async function deleteSelection() {
  const { selection, model } = getState();
  const elements = selection.elementIds.filter((id) => model.elements.some((e) => e.id === id));
  const relations = selection.relationIds.filter((id) => model.relations.some((r) => r.id === id));
  if (!elements.length && !relations.length) return;
  const descendants = new Set<string>();
  for (const id of elements) for (const d of descendantsOf(id, model.elements)) if (!elements.includes(d.id)) descendants.add(d.id);
  const names = elements.map((id) => model.elements.find((e) => e.id === id)!.name);
  if (descendants.size || relations.length > 1) {
    const what = names.length === 1 ? names[0]! : names.length ? plural(names.length, 'element') : plural(relations.length, 'relation');
    const ok = await confirmAction({
      title: `Delete ${what}?`,
      body: descendants.size ? `This also removes ${plural(descendants.size, 'element')} inside, and every relation attached to them.` : 'The underlying relations of this thread are removed together.',
      confirmLabel: 'Delete',
      danger: true,
    });
    if (!ok) return;
  }
  clearSelection();
  const summary = names.length
    ? `Deleted ${names.length === 1 ? names[0] : plural(names.length, 'element')}`
    : `Deleted ${relations.length === 1 ? 'a relation' : plural(relations.length, 'relation')}`;
  void commit({ summary, remove: { elements: elements.length ? elements : undefined, relations: relations.length ? relations : undefined } });
}

export function renameModel(name: string) {
  if (!name.trim()) return;
  void commit({ summary: `Renamed the model to ${name.trim()}`, model: { name: name.trim() } });
}
