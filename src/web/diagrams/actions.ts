/** Diagram edits shared by the canvas, keyboard, inspector, rail and palette. */
import type { ConnectorPatch, Diagram, DiagramConnector, DiagramPatch, ElementKind, ModelLink, ShapeKind, ShapePatch } from '../../shared/model.ts';
import { slugify, uniqueId } from '../../shared/model.ts';
import { fitShape } from '../../shared/diagram/fit.ts';
import { linkName, shapeLabel } from '../../shared/diagram/links.ts';
import { unlinkShape } from '../../shared/diagram/patch.ts';
import { promoteConnector, promoteShape } from '../../shared/diagram/promote.ts';
import { seededLook } from '../../shared/diagram/seed.ts';
import { confirmAction } from '../chrome/Confirm.tsx';
import { plural } from '../lib/format.ts';
import {
  commit,
  getState,
  navigateToElement,
  navigateToRelation,
  openDiagram,
  openFlow,
  selectShapes,
  setState,
  toast,
  useStore,
} from '../state/store.ts';
import { type Clip, copyShapes, pasteShapes } from './clipboard.ts';
import { DRAFT_ID, clearOverrides, editedText, getEditor, setEditor, setOverride } from './editor.ts';
import { descendants, groupAt, round1, snap } from './geometry.ts';

function diagramById(id: string | undefined): Diagram | undefined {
  return id ? getState().model.diagrams.find((d) => d.id === id) : undefined;
}

/** The open diagram, with a nudge still waiting committed first, so every edit starts from where the shapes are shown. */
export function openedDiagram(): Diagram | undefined {
  flushNudge();
  return diagramById(getState().diagramId);
}

function patchDiagram(diagram: Diagram, patch: Omit<DiagramPatch, 'id'>, summary?: string) {
  flushNudge();
  return commit({ summary, diagrams: [{ id: diagram.id, ...patch }] });
}

function takenIds(diagram: Diagram): Set<string> {
  return new Set([...diagram.shapes, ...diagram.connectors].map((s) => s.id));
}

/** Once the server has answered a seed or a tidy, the canvas fits what it drew. */
function fitWhenDrawn(sent: Promise<boolean>) {
  setEditor({ fitNext: true });
  void sent.then(() => setTimeout(() => setEditor({ fitNext: false }), 1500));
}

// ─── Diagrams ───────────────────────────────────────────────────────────────

export function createDiagram(name: string): string {
  const id = uniqueId(slugify(name), new Set(getState().model.diagrams.map((d) => d.id)));
  void commit({ summary: `Added diagram ${name}`, diagrams: [{ id, name }] });
  openDiagram(id);
  return id;
}

/** Asks the rail for a name: it opens if hidden and shows its new-diagram field. */
export function askNewDiagram() {
  setState({ dataRailOpen: true });
  setEditor({ naming: true });
}

export function duplicateDiagram(diagram: Diagram) {
  const name = `${diagram.name} copy`.slice(0, 120);
  const id = uniqueId(slugify(name), new Set(getState().model.diagrams.map((d) => d.id)));
  void commit({
    summary: `Duplicated diagram ${diagram.name}`,
    diagrams: [{ id, name, summary: diagram.summary, direction: diagram.direction, shapes: diagram.shapes, connectors: diagram.connectors }],
  });
  openDiagram(id);
}

export async function deleteDiagram(diagram: Diagram) {
  const ok = await confirmAction({
    title: `Delete ${diagram.name}?`,
    body: `Its ${plural(diagram.shapes.length, 'shape')} go with it. The model is not touched.`,
    confirmLabel: 'Delete',
    danger: true,
  });
  if (!ok) return;
  setState({ diagramId: undefined, selectedShapeIds: [] });
  void commit({ summary: `Deleted diagram ${diagram.name}`, remove: { diagrams: [diagram.id] } });
}

export async function tidyDiagram(diagram: Diagram) {
  const ok = await confirmAction({
    title: `Tidy ${diagram.name}?`,
    body: 'Every shape is arranged afresh, in reading order. Undo brings your arrangement back.',
    confirmLabel: 'Tidy',
  });
  if (ok) fitWhenDrawn(patchDiagram(diagram, { arrange: 'all' }, `Tidied ${diagram.name}`));
}

export function seedDiagram(diagram: Diagram, elementIds: string[]) {
  if (!elementIds.length) return;
  fitWhenDrawn(patchDiagram(diagram, { seed: elementIds, arrange: 'new' }, `Added ${plural(elementIds.length, 'element')} to ${diagram.name}`));
}

/** A new diagram of the given elements, named after the current scope or the first element, opened. */
export function drawAsDiagram(elementIds: string[]) {
  const { model, scopeId } = getState();
  const first = model.elements.find((e) => e.id === elementIds[0]);
  const scope = scopeId ? model.elements.find((e) => e.id === scopeId) : undefined;
  const name = scope?.name ?? first?.name;
  if (!name) return;
  const id = uniqueId(slugify(name), new Set(model.diagrams.map((d) => d.id)));
  fitWhenDrawn(commit({ summary: `Drew ${name} as a diagram`, diagrams: [{ id, name, seed: elementIds, arrange: 'new' }] }));
  openDiagram(id);
}

// ─── Shapes ─────────────────────────────────────────────────────────────────

/** Puts a new shape of `kind` centred on `point` with its text open; it is created when the text is committed. */
export function beginPlacing(kind: ShapeKind, point: { x: number; y: number }, from?: string) {
  const diagram = openedDiagram();
  if (!diagram) return;
  const size = fitShape({ kind, label: '' });
  const parent = groupAt(point, diagram.shapes);
  const shape = { id: DRAFT_ID, kind, text: '', x: snap(point.x - size.w / 2), y: snap(point.y - size.h / 2), w: size.w, h: size.h, ...(parent ? { parent } : {}) };
  selectShapes([]);
  setEditor({ armed: null, placing: { shape, ...(from ? { from } : {}) }, editing: { target: 'shape', diagramId: diagram.id, id: DRAFT_ID, initial: '', draft: '' } });
}

export function startEditing(id: string) {
  const diagram = openedDiagram();
  if (!diagram) return;
  const shape = diagram.shapes.find((s) => s.id === id);
  const connector = diagram.connectors.find((c) => c.id === id);
  const initial = shape ? shapeLabel(getState().model, shape) : connector?.label;
  if (initial === undefined) return;
  setEditor({ editing: { target: shape ? 'shape' : 'connector', diagramId: diagram.id, id, initial, draft: initial } });
}

/** Ends text editing: `keep` commits what was typed, otherwise it is dropped (and a shape being placed with it). */
export function finishEditing(keep: boolean) {
  const { editing, placing } = getEditor();
  if (!editing) return;
  setEditor({ editing: null, placing: null });
  flushNudge();
  const diagram = diagramById(editing.diagramId);
  if (!diagram || !keep) return;
  const text = editing.draft.trim();
  if (editing.target === 'connector') {
    const connector = diagram.connectors.find((c) => c.id === editing.id);
    const label = connector && editedText(editing, connector.label);
    if (connector && label !== undefined) void patchDiagram(diagram, { setConnectors: [{ id: connector.id, label: label.slice(0, 120) }] });
    return;
  }
  if (placing && editing.id === DRAFT_ID) {
    if (!text && placing.shape.kind === 'text') return;
    const taken = takenIds(diagram);
    const id = uniqueId(slugify(text || placing.shape.kind), taken);
    taken.add(id);
    const { id: _, ...shape } = placing.shape;
    const from = placing.from && diagram.shapes.some((s) => s.id === placing.from) ? placing.from : undefined;
    void patchDiagram(
      diagram,
      {
        setShapes: [{ id, ...shape, text: text.slice(0, 400) }],
        ...(from ? { setConnectors: [{ id: uniqueId(slugify(`${from}-to-${id}`), taken), from, to: id }] } : {}),
      },
      `Added ${text ? text.split('\n')[0] : `a ${shape.kind}`} to ${diagram.name}`,
    );
    selectShapes([id]);
    return;
  }
  const shape = diagram.shapes.find((s) => s.id === editing.id);
  if (!shape) return;
  const next = editedText(editing, shape.text, shape.link ? (linkName(getState().model, shape.link) ?? '') : undefined);
  if (next !== undefined) void patchDiagram(diagram, { setShapes: [{ id: shape.id, text: next.slice(0, 400) }] });
}

export function connectShapes(from: string, to: string) {
  const diagram = openedDiagram();
  if (!diagram || from === to) return;
  const id = uniqueId(slugify(`${from}-to-${to}`), takenIds(diagram));
  void patchDiagram(diagram, { setConnectors: [{ id, from, to }] });
}

export function reconnect(id: string, end: 'from' | 'to', shapeId: string) {
  const diagram = openedDiagram();
  const connector = diagram?.connectors.find((c) => c.id === id);
  if (!diagram || !connector || connector[end] === shapeId) return;
  if ((end === 'from' ? connector.to : connector.from) === shapeId) return;
  void patchDiagram(diagram, { setConnectors: [{ id, [end]: shapeId, [end === 'from' ? 'fromSide' : 'toSide']: null }] });
}

/** A shape standing for a model item, placed at `point`. */
export function addLinkedShape(link: ModelLink, point: { x: number; y: number }) {
  const diagram = openedDiagram();
  if (!diagram) return;
  const { model } = getState();
  const element = link.type === 'element' ? model.elements.find((e) => e.id === link.id) : undefined;
  const look: Pick<ShapePatch, 'kind' | 'outline'> = element ? seededLook(element) : { kind: 'box' };
  const kind = look.kind ?? 'box';
  const size = fitShape({ kind, label: linkName(model, link) ?? '' });
  const id = uniqueId(slugify(link.id), takenIds(diagram));
  const parent = groupAt(point, diagram.shapes);
  void patchDiagram(
    diagram,
    { setShapes: [{ id, ...look, link, x: snap(point.x - size.w / 2), y: snap(point.y - size.h / 2), w: size.w, h: size.h, ...(parent ? { parent } : {}) }] },
    `Added ${linkName(model, link) ?? link.id} to ${diagram.name}`,
  );
  selectShapes([id]);
}

export function setShapes(diagram: Diagram, entries: ShapePatch[]) {
  if (entries.length) void patchDiagram(diagram, { setShapes: entries });
}

export function setConnectors(diagram: Diagram, entries: ConnectorPatch[]) {
  if (entries.length) void patchDiagram(diagram, { setConnectors: entries });
}

export function reverseConnector(diagram: Diagram, connector: DiagramConnector) {
  void patchDiagram(diagram, {
    setConnectors: [{ id: connector.id, from: connector.to, to: connector.from, fromSide: connector.toSide ?? null, toSide: connector.fromSide ?? null }],
  });
}

export function removeShapes(ids: string[]) {
  const diagram = openedDiagram();
  if (!diagram) return;
  const shapes = diagram.shapes.filter((s) => ids.includes(s.id)).map((s) => s.id);
  const connectors = diagram.connectors.filter((c) => ids.includes(c.id)).map((c) => c.id);
  if (!shapes.length && !connectors.length) return;
  selectShapes([]);
  const what = shapes.length ? plural(shapes.length, 'shape') : plural(connectors.length, 'line');
  void patchDiagram(
    diagram,
    { ...(shapes.length ? { removeShapes: shapes } : {}), ...(connectors.length ? { removeConnectors: connectors } : {}) },
    `Removed ${what} from ${diagram.name}`,
  );
}

let nudgeTimer: ReturnType<typeof setTimeout> | undefined;
/** The shapes moved by keys and not committed yet, with the diagram they belong to. */
let pendingNudge: { diagramId: string; ids: Set<string> } | null = null;

/** Moves the selected shapes (and what is inside them) at once; the move is committed when the keys rest. */
export function nudgeSelection(dx: number, dy: number): boolean {
  const diagramId = getState().diagramId;
  if (pendingNudge && pendingNudge.diagramId !== diagramId) flushNudge();
  const diagram = diagramById(diagramId);
  if (!diagram) return false;
  const selected = new Set(getState().selectedShapeIds);
  const ids = diagram.shapes.filter((s) => selected.has(s.id)).map((s) => s.id);
  if (!ids.length) return false;
  const { overrides } = getEditor();
  pendingNudge ??= { diagramId: diagram.id, ids: new Set() };
  for (const id of [...ids, ...descendants(diagram.shapes, ids)]) {
    const shape = diagram.shapes.find((s) => s.id === id)!;
    setOverride(id, { x: (overrides[id]?.x ?? shape.x) + dx, y: (overrides[id]?.y ?? shape.y) + dy });
    pendingNudge.ids.add(id);
  }
  clearTimeout(nudgeTimer);
  nudgeTimer = setTimeout(flushNudge, 450);
  return true;
}

/** Commits a waiting nudge to the diagram it was made in. Called before any other edit and when the view moves on. */
export function flushNudge() {
  clearTimeout(nudgeTimer);
  const pending = pendingNudge;
  pendingNudge = null;
  if (!pending) return;
  const { overrides } = getEditor();
  const diagram = diagramById(pending.diagramId);
  const entries = [...pending.ids].flatMap((id) => {
    const o = overrides[id];
    return o?.x !== undefined && o.y !== undefined && diagram?.shapes.some((s) => s.id === id) ? [{ id, x: round1(o.x), y: round1(o.y) }] : [];
  });
  if (diagram && entries.length) void patchDiagram(diagram, { setShapes: entries });
  clearOverrides(pending.ids);
}

useStore.subscribe((s, prev) => {
  if (pendingNudge && (s.diagramId !== prev.diagramId || s.perspective !== prev.perspective)) flushNudge();
});

export function copySelection(): Clip | undefined {
  const diagram = openedDiagram();
  return diagram ? copyShapes(diagram, getState().selectedShapeIds) : undefined;
}

let lastPaste = '';
let pasteRun = 0;

/** Adds a copied clip to the open diagram with fresh ids, shifted when it would land on itself. */
export function pasteClip(clip: Clip, summary = 'Pasted') {
  const diagram = openedDiagram();
  if (!diagram || !clip.shapes.length) return;
  const { model } = getState();
  const key = JSON.stringify(clip);
  const onTop = clip.shapes.some((s) => diagram.shapes.some((o) => o.x === s.x && o.y === s.y));
  pasteRun = key === lastPaste ? pasteRun + 1 : onTop ? 1 : 0;
  lastPaste = key;
  const { shapes, connectors } = pasteShapes(clip, takenIds(diagram), { x: 16 * pasteRun, y: 16 * pasteRun });
  const linkable = shapes.map((s) => {
    if (!s.link) return s;
    const own = s.link.type === 'diagram' && s.link.id === diagram.id;
    return own || linkName(model, s.link) === undefined ? unlinkShape(s, own ? diagram.name : undefined) : s;
  });
  void patchDiagram(diagram, { setShapes: linkable, setConnectors: connectors }, `${summary} ${plural(shapes.length, 'shape')} into ${diagram.name}`);
  selectShapes([...shapes, ...connectors].map((s) => s.id));
}

export function duplicateSelection() {
  const clip = copySelection();
  if (clip) pasteClip(clip, 'Duplicated');
}

export function selectAll() {
  const diagram = openedDiagram();
  if (diagram) selectShapes([...diagram.shapes, ...diagram.connectors].map((s) => s.id));
}

/** Brings the selected shapes in front of the others, or sends them behind (groups stay behind their content). */
export function reorder(front: boolean) {
  const diagram = openedDiagram();
  const selected = new Set(getState().selectedShapeIds);
  if (!diagram || !diagram.shapes.some((s) => selected.has(s.id))) return;
  const moving = diagram.shapes.filter((s) => selected.has(s.id));
  const rest = diagram.shapes.filter((s) => !selected.has(s.id));
  const shapes = front ? [...rest, ...moving] : [...moving, ...rest];
  if (shapes.every((s, i) => s === diagram.shapes[i])) return;
  void patchDiagram(diagram, { shapes });
}

export function openLink(link: ModelLink) {
  if (link.type === 'element') navigateToElement(link.id);
  else if (link.type === 'flow') openFlow(link.id);
  else openDiagram(link.id);
}

export function makeElement(diagram: Diagram, shapeId: string, kind: ElementKind) {
  const promotion = promoteShape(getState().model, diagram, shapeId, kind);
  if (!promotion) return;
  const { elementId, ...changes } = promotion;
  void commit(changes);
  toast({ tone: 'info', text: `${changes.elements[0]!.name} is an element now`, action: () => navigateToElement(elementId), actionLabel: 'Show' });
}

export function makeRelation(diagram: Diagram, connectorId: string) {
  const promotion = promoteConnector(getState().model, diagram, connectorId);
  if (!promotion) return;
  const { relationId, ...changes } = promotion;
  void commit(changes);
  toast({ tone: 'info', text: `${changes.summary} in the model`, action: () => navigateToRelation(relationId), actionLabel: 'Show' });
}
