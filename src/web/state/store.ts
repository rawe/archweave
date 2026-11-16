import { create } from 'zustand';
import type {
  AgentPresence,
  Diagram,
  FocusRequest,
  JournalEntry,
  Layout,
  Model,
  Perspective,
  Snapshot,
  StaleLink,
} from '../../shared/model.ts';
import { api, ApiError } from '../api.ts';
import { applyLocal, isLayoutOnly, type PlainChangeSet } from './apply.ts';

interface Pending {
  seq: number;
  cs: PlainChangeSet;
  layoutOnly: boolean;
  ackRevision?: number;
  snapshotsSinceAck: number;
}

export interface Toast {
  id: number;
  tone: 'agent' | 'info' | 'error';
  text: string;
  detail?: string;
  /** Called when the toast is clicked. */
  action?: () => void;
  actionLabel?: string;
}

export interface CodeView {
  path: string;
  startLine?: number;
  endLine?: number;
  /** The element or relation whose link was followed. */
  ownerId?: string;
  /** When the followed link needs attention: what the server found, so the drawer can show the suggestion and fixes. */
  link?: StaleLink;
}

export type Overlay = 'palette' | 'export' | 'help' | 'activity' | null;

export interface Selection {
  elementIds: string[];
  relationIds: string[];
  /** Structure perspective: the projected thread key ("a->b") the relations came from. */
  edgeKey?: string;
}

const EMPTY_SELECTION: Selection = { elementIds: [], relationIds: [] };
const EMPTY_MODEL: Model = { version: 1, name: 'Architecture', description: '', elements: [], relations: [], flows: [], diagrams: [] };
const UNSEEN_KEY = 'archweave.unseen';
const NAMES_ONLY_KEY = 'archweave.namesOnly';

function loadFlag(key: string): boolean {
  try {
    return localStorage.getItem(key) === '1';
  } catch {
    return false;
  }
}

/** Hides summaries on structure nodes, remembered per browser. Positions are laid out for full nodes, so toggling never makes nodes overlap. */
export function toggleNamesOnly() {
  const namesOnly = !useStore.getState().namesOnly;
  useStore.setState({ namesOnly });
  try {
    localStorage.setItem(NAMES_ONLY_KEY, namesOnly ? '1' : '0');
  } catch {
    /* storage unavailable */
  }
}

export interface State {
  loaded: boolean;
  connection: 'connecting' | 'live' | 'offline';
  server: Snapshot | null;
  pending: Pending[];
  model: Model;
  layout: Layout;
  revision: number;

  journal: JournalEntry[];
  agent: AgentPresence;
  agentEverSeen: boolean;
  repo: { name: string; hostPath?: string };
  stale: StaleLink[];

  perspective: Perspective;
  scopeId?: string;
  flowId?: string;
  stepIndex: number | null;
  selection: Selection;
  /** The diagram open in the Diagrams perspective. */
  diagramId?: string;
  /** Diagrams perspective: selected shapes and connectors of the open diagram (one id namespace). */
  selectedShapeIds: string[];
  /** Bumped to ask the active canvas to center on the selection. */
  revealToken: number;
  /** Bumped by a deliberate jump (a link followed, the agent showing something): it gets its own Back entry. */
  navToken: number;
  /** Position in the app's own history and the last position Forward reaches (see state/navHistory.ts). */
  navIndex: number;
  navMax: number;
  /** A relation whose label field the inspector should focus once, right after connecting. */
  labelFocusFor?: string;

  /** Element and relation ids recently touched by the agent → time of the change; shapes as "<diagram>/<shape>". */
  fresh: Record<string, number>;
  /** Ids touched by the agent that the human has not selected since; diagrams as "diagram:<id>". */
  unseen: Record<string, true>;
  /** Removed by the agent a moment ago; kept briefly so they can fade out. */
  leaving: Record<string, number>;

  overlay: Overlay;
  code: CodeView | null;
  toasts: Toast[];
  humanChanged: boolean;
  dataRailOpen: boolean;
  /** The data rail's filter; it also narrows the catalog. */
  dataFilter: string;
  /** View option: structure nodes show names without summaries. */
  namesOnly: boolean;
}

export const useStore = create<State>(() => ({
  loaded: false,
  connection: 'connecting',
  server: null,
  pending: [],
  model: EMPTY_MODEL,
  layout: {},
  revision: 0,
  journal: [],
  agent: { connected: false },
  agentEverSeen: false,
  repo: { name: '' },
  stale: [],
  perspective: 'structure',
  stepIndex: null,
  selection: EMPTY_SELECTION,
  selectedShapeIds: [],
  revealToken: 0,
  navToken: 0,
  navIndex: 0,
  navMax: 0,
  fresh: {},
  unseen: loadUnseen(),
  leaving: {},
  overlay: null,
  code: null,
  toasts: [],
  humanChanged: false,
  dataRailOpen: typeof window === 'undefined' || window.innerWidth >= 900,
  dataFilter: '',
  namesOnly: loadFlag(NAMES_ONLY_KEY),
}));

const set = useStore.setState;
const get = useStore.getState;

// ─── Snapshot and optimistic changes ────────────────────────────────────────

let seq = 0;

function recompute(server: Snapshot | null, pending: Pending[]) {
  let doc = { model: server?.model ?? EMPTY_MODEL, layout: server?.layout ?? {} };
  for (const p of pending) doc = applyLocal(doc, p.cs);
  return { model: doc.model, layout: doc.layout, revision: server?.revision ?? 0 };
}

/**
 * Recomputes the local document from the server snapshot plus pending changes
 * and drops view references (scope, selection, flow) to things that vanished,
 * which can happen on any recomputation, not only on a new snapshot.
 */
function setDocument(server: Snapshot | null, pending: Pending[], extra: Partial<State> = {}) {
  const before = get().model;
  set({ ...extra, pending, ...recompute(server, pending) });
  sanitizeView(before);
}

function prune(pending: Pending[], serverRevision: number): Pending[] {
  return pending.filter((p) => {
    if (p.ackRevision === undefined) return true;
    if (serverRevision > p.ackRevision) return false;
    if (serverRevision === p.ackRevision) return p.layoutOnly && p.snapshotsSinceAck === 0;
    return true;
  });
}

export function receiveSnapshot(snapshot: Snapshot, entry?: JournalEntry) {
  const state = get();
  const pending = prune(
    state.pending.map((p) => (p.ackRevision !== undefined ? { ...p, snapshotsSinceAck: p.snapshotsSinceAck + 1 } : p)),
    snapshot.revision,
  );
  const next: Partial<State> = { server: snapshot, loaded: true };
  const redrawn = entry?.actor === 'agent' ? changedShapes(state.model.diagrams, snapshot.model.diagrams, [...entry.created.diagrams, ...entry.updated.diagrams]) : [];
  if (entry && !state.journal.some((j) => j.revision === entry.revision && j.at === entry.at)) {
    // A coalesced entry replaces the entry it grew from.
    const merged = (j: JournalEntry) => entry.firstRevision !== undefined && j.actor === entry.actor && j.revision >= entry.firstRevision && j.revision < entry.revision;
    next.journal = [...state.journal.filter((j) => !merged(j)), entry].slice(-500);
  }
  setDocument(snapshot, pending, next);
  if (entry?.actor === 'agent') onAgentEntry(entry, redrawn);
}

/** Shapes and connectors of the given diagrams that are new or differ, as "<diagram>/<id>". */
function changedShapes(before: Diagram[], after: Diagram[], ids: string[]): string[] {
  const out: string[] = [];
  for (const id of ids) {
    const was = before.find((d) => d.id === id);
    const now = after.find((d) => d.id === id);
    if (!now) continue;
    const old = new Map<string, unknown>([...(was?.shapes ?? []), ...(was?.connectors ?? [])].map((s) => [s.id, s]));
    for (const item of [...now.shapes, ...now.connectors]) {
      const prev = old.get(item.id);
      if (!prev || JSON.stringify(prev) !== JSON.stringify(item)) out.push(`${id}/${item.id}`);
    }
  }
  return out;
}

/**
 * Applies a change locally right away and sends it to the server. `failure` replaces the toast for an error the
 * server answered with (a conflict or a rejected change set), e.g. to say what the human should do next.
 */
export async function commit(cs: PlainChangeSet, opts: { failure?: string } = {}): Promise<boolean> {
  const p: Pending = { seq: ++seq, cs, layoutOnly: isLayoutOnly(cs), snapshotsSinceAck: 0 };
  setDocument(get().server, [...get().pending, p], p.layoutOnly ? {} : { humanChanged: true });
  try {
    const result = await api.applyChanges(cs);
    const current = get();
    const acked = current.pending.map((q) => (q.seq === p.seq ? { ...q, ackRevision: result.revision } : q));
    setDocument(current.server, prune(acked, current.server?.revision ?? 0));
    if (p.layoutOnly) setTimeout(() => dropPending(p.seq), 3000);
    for (const warning of result.warnings ?? []) toast({ tone: 'info', text: warning });
    return true;
  } catch (err) {
    dropPending(p.seq);
    toast({ tone: 'error', text: err instanceof ApiError ? (opts.failure ?? err.message) : 'Could not reach the ArchWeave server.' });
    return false;
  }
}

function dropPending(target: number) {
  const current = get();
  if (!current.pending.some((q) => q.seq === target)) return;
  setDocument(current.server, current.pending.filter((q) => q.seq !== target));
}

export async function undo() {
  try {
    await api.undo();
    toast({ tone: 'info', text: 'Undone' });
  } catch (err) {
    if (err instanceof ApiError && err.status === 409) {
      set({ humanChanged: false });
      toast({ tone: 'info', text: 'Nothing left to undo' });
    } else toast({ tone: 'error', text: err instanceof Error ? err.message : 'Undo failed' });
  }
}

// ─── Agent activity ─────────────────────────────────────────────────────────

const FRESH_MS = 6500;

function onAgentEntry(entry: JournalEntry, redrawn: string[] = []) {
  const now = Date.now();
  const touched = [...entry.created.elements, ...entry.updated.elements, ...entry.created.relations, ...entry.updated.relations];
  const diagrams = [...entry.created.diagrams, ...entry.updated.diagrams];
  const { fresh, unseen, leaving } = get();
  const nextFresh = { ...fresh };
  const nextUnseen = { ...unseen };
  for (const id of touched) {
    nextFresh[id] = now;
    nextUnseen[id] = true;
  }
  for (const id of redrawn) nextFresh[id] = now;
  for (const id of diagrams) if (get().perspective !== 'diagrams' || get().diagramId !== id) nextUnseen[`diagram:${id}`] = true;
  const nextLeaving = { ...leaving };
  for (const id of [...entry.removed.elements, ...entry.removed.relations]) nextLeaving[id] = now;
  set({ fresh: nextFresh, unseen: nextUnseen, leaving: nextLeaving });
  saveUnseen(nextUnseen);
  setTimeout(() => {
    const s = get();
    const f = { ...s.fresh };
    const l = { ...s.leaving };
    for (const [id, at] of Object.entries(f)) if (Date.now() - at >= FRESH_MS) delete f[id];
    for (const [id, at] of Object.entries(l)) if (Date.now() - at >= 900) delete l[id];
    set({ fresh: f, leaving: l });
  }, FRESH_MS);

  const navigable = touched.length > 0 || diagrams.length > 0 || entry.created.flows.length + entry.updated.flows.length > 0;
  toast({
    tone: 'agent',
    text: entry.summary,
    action: navigable ? () => navigateToEntry(entry) : undefined,
    actionLabel: navigable ? 'Show' : undefined,
  });
}

export function markSeen(ids: string[]) {
  const { unseen } = get();
  if (!ids.some((id) => unseen[id])) return;
  const next = { ...unseen };
  for (const id of ids) delete next[id];
  set({ unseen: next });
  saveUnseen(next);
}

function loadUnseen(): Record<string, true> {
  try {
    return JSON.parse(localStorage.getItem(UNSEEN_KEY) ?? '{}');
  } catch {
    return {};
  }
}

function saveUnseen(value: Record<string, true>) {
  try {
    localStorage.setItem(UNSEEN_KEY, JSON.stringify(value));
  } catch {
    /* storage unavailable */
  }
}

export function setAgent(agent: AgentPresence) {
  set((s) => ({ agent, agentEverSeen: s.agentEverSeen || agent.connected || !!agent.lastSeenAt }));
}

// ─── Toasts ─────────────────────────────────────────────────────────────────

let toastSeq = 0;
export function toast(t: Omit<Toast, 'id'>, ms = t.tone === 'agent' ? 7000 : 3200) {
  const id = ++toastSeq;
  set((s) => ({ toasts: [...s.toasts.filter((x) => !(x.tone === t.tone && x.text === t.text)), { ...t, id }].slice(-3) }));
  setTimeout(() => dismissToast(id), ms);
}

export function dismissToast(id: number) {
  set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
}

// ─── Navigation and selection ───────────────────────────────────────────────

export function select(selection: Partial<Selection>, opts: { reveal?: boolean } = {}) {
  const next: Selection = { elementIds: selection.elementIds ?? [], relationIds: selection.relationIds ?? [], edgeKey: selection.edgeKey };
  set((s) => ({ selection: next, revealToken: opts.reveal ? s.revealToken + 1 : s.revealToken }));
  markSeen([...next.elementIds, ...next.relationIds]);
}

export function clearSelection() {
  const { selection, stepIndex, selectedShapeIds } = get();
  if (selection.elementIds.length || selection.relationIds.length || stepIndex !== null || selectedShapeIds.length)
    set({ selection: EMPTY_SELECTION, stepIndex: null, selectedShapeIds: [] });
}

/** Selects shapes and connectors of the open diagram. */
export function selectShapes(ids: string[], opts: { reveal?: boolean } = {}) {
  set((s) => ({ selectedShapeIds: ids, revealToken: opts.reveal ? s.revealToken + 1 : s.revealToken }));
}

/** Opens a diagram in the Diagrams perspective, optionally with shapes selected and brought into view. */
export function openDiagram(diagramId: string | undefined, selectIds: string[] = []) {
  set((s) => ({
    perspective: 'diagrams',
    diagramId,
    selectedShapeIds: selectIds,
    selection: EMPTY_SELECTION,
    stepIndex: null,
    revealToken: s.revealToken + (selectIds.length ? 1 : 0),
    navToken: s.navToken + (selectIds.length ? 1 : 0),
  }));
  if (diagramId) markSeen([`diagram:${diagramId}`]);
}

export function setPerspective(perspective: Perspective) {
  const s = get();
  if (s.perspective === perspective) return;
  const keep = s.selection.elementIds.filter((id) => {
    const el = s.model.elements.find((e) => e.id === id);
    if (!el) return false;
    return perspective === 'data' ? el.kind === 'data' : perspective === 'structure' ? el.kind !== 'data' : false;
  });
  set({ perspective, selection: { elementIds: keep, relationIds: [] }, stepIndex: null, selectedShapeIds: [] });
  if (perspective === 'diagrams' && s.diagramId) markSeen([`diagram:${s.diagramId}`]);
}

export function enterScope(scopeId: string | undefined, selectAfter?: string[]) {
  set((s) => ({
    perspective: 'structure',
    scopeId,
    selection: { elementIds: selectAfter ?? [], relationIds: [] },
    stepIndex: null,
    revealToken: s.revealToken + (selectAfter?.length ? 1 : 0),
  }));
}

export function scopeOut() {
  const { scopeId, model } = get();
  if (!scopeId) return;
  const scope = model.elements.find((e) => e.id === scopeId);
  enterScope(scope?.parentId, [scopeId]);
}

export function openFlow(flowId: string | undefined, stepIndex: number | null = null) {
  set({ perspective: 'flows', flowId, stepIndex, selection: EMPTY_SELECTION });
}

/** Shows an element where it lives: Structure at its parent's scope, or Data for structures. */
export function navigateToElement(id: string, extra: string[] = []) {
  const { model } = get();
  const el = model.elements.find((e) => e.id === id);
  if (!el) return;
  if (el.kind === 'data') {
    set((s) => ({ perspective: 'data', selection: { elementIds: [id, ...extra], relationIds: [] }, revealToken: s.revealToken + 1, navToken: s.navToken + 1, stepIndex: null }));
  } else {
    const parent = el.parentId && model.elements.some((e) => e.id === el.parentId) ? el.parentId : undefined;
    set((s) => ({
      perspective: 'structure',
      scopeId: parent,
      selection: { elementIds: [id, ...extra], relationIds: [] },
      revealToken: s.revealToken + 1,
      navToken: s.navToken + 1,
      stepIndex: null,
    }));
  }
  markSeen([id, ...extra]);
}

export function navigateToRelation(id: string) {
  const { model } = get();
  const rel = model.relations.find((r) => r.id === id);
  if (!rel) return;
  const from = model.elements.find((e) => e.id === rel.from);
  const to = model.elements.find((e) => e.id === rel.to);
  if (from?.kind === 'data' && to?.kind === 'data') {
    // The data perspective shows a relation between structures by focusing its source.
    set((s) => ({ perspective: 'data', selection: { elementIds: [rel.from], relationIds: [] }, revealToken: s.revealToken + 1, navToken: s.navToken + 1, stepIndex: null }));
    markSeen([id]);
    return;
  }
  // Show it at the scope of the source's parent; the projection lifts it if needed.
  const anchor = from?.kind === 'data' ? to : from;
  set((s) => ({
    perspective: 'structure',
    scopeId: anchor?.parentId,
    selection: { elementIds: [], relationIds: [id] },
    revealToken: s.revealToken + 1,
    navToken: s.navToken + 1,
    stepIndex: null,
  }));
  markSeen([id]);
}

export function navigateToEntry(entry: JournalEntry) {
  const { model } = get();
  const elementIds = [...entry.created.elements, ...entry.updated.elements].filter((id) => model.elements.some((e) => e.id === id));
  if (elementIds.length) {
    const first = model.elements.find((e) => e.id === elementIds[0])!;
    const siblings = elementIds.filter((id) => {
      const el = model.elements.find((e) => e.id === id)!;
      return el.parentId === first.parentId && (el.kind === 'data') === (first.kind === 'data');
    });
    navigateToElement(first.id, siblings.filter((id) => id !== first.id));
    return;
  }
  const relationId = [...entry.created.relations, ...entry.updated.relations].find((id) => model.relations.some((r) => r.id === id));
  if (relationId) return navigateToRelation(relationId);
  const flowId = [...entry.created.flows, ...entry.updated.flows].find((id) => model.flows.some((f) => f.id === id));
  if (flowId) return openFlow(flowId);
  const diagramId = [...entry.created.diagrams, ...entry.updated.diagrams].find((id) => model.diagrams.some((d) => d.id === id));
  if (diagramId) {
    const changed = Object.keys(get().fresh).filter((key) => key.startsWith(`${diagramId}/`)).map((key) => key.slice(diagramId.length + 1));
    openDiagram(diagramId, changed);
  }
}

export function handleFocusRequest(req: FocusRequest) {
  const { model } = get();
  const ids = req.elementIds.filter((id) => model.elements.some((e) => e.id === id));
  const diagram = req.diagramId ? model.diagrams.find((d) => d.id === req.diagramId) : undefined;
  if (diagram) {
    const known = new Set([...diagram.shapes, ...diagram.connectors].map((s) => s.id));
    const shapeIds = (req.shapeIds ?? []).filter((id) => known.has(id));
    // Always a reveal: the canvas fits the highlighted shapes, or the whole diagram. One deliberate jump, one Back entry.
    set((s) => ({
      perspective: 'diagrams',
      diagramId: diagram.id,
      selectedShapeIds: shapeIds,
      selection: EMPTY_SELECTION,
      stepIndex: null,
      revealToken: s.revealToken + 1,
      navToken: s.navToken + 1,
    }));
    markSeen([`diagram:${diagram.id}`]);
    const now = Date.now();
    set((s) => ({ fresh: { ...s.fresh, ...Object.fromEntries(shapeIds.map((id) => [`${diagram.id}/${id}`, now])) } }));
    toast({ tone: 'agent', text: req.message || 'The agent is showing you this' });
    return;
  }
  if (req.perspective === 'flows' || (req.flowId && !req.perspective)) {
    openFlow(req.flowId ?? get().flowId);
    set((s) => ({ navToken: s.navToken + 1 }));
  } else if (req.perspective || req.scopeId !== undefined) {
    const perspective = req.perspective ?? 'structure';
    set((s) => ({
      perspective,
      scopeId: perspective === 'structure' ? (req.scopeId ?? undefined) : s.scopeId,
      selection: { elementIds: ids, relationIds: [] },
      revealToken: s.revealToken + 1,
      navToken: s.navToken + 1,
      stepIndex: null,
    }));
  } else if (ids.length) {
    navigateToElement(ids[0]!, ids.slice(1));
  }
  const now = Date.now();
  set((s) => ({ fresh: { ...s.fresh, ...Object.fromEntries(ids.map((id) => [id, now])) } }));
  toast({ tone: 'agent', text: req.message || 'The agent is showing you this' });
}

/** Drops scope, flow and selection references that no longer exist. */
function sanitizeView(before: Model) {
  const s = get();
  const ids = new Set(s.model.elements.map((e) => e.id));
  const relIds = new Set(s.model.relations.map((r) => r.id));
  const patch: Partial<State> = {};
  let scopeId = s.scopeId;
  while (scopeId && !ids.has(scopeId)) scopeId = before.elements.find((e) => e.id === scopeId)?.parentId;
  if (scopeId !== s.scopeId) patch.scopeId = scopeId;
  if (s.flowId && !s.model.flows.some((f) => f.id === s.flowId)) {
    patch.flowId = undefined;
    patch.stepIndex = null;
  }
  const elementIds = s.selection.elementIds.filter((id) => ids.has(id));
  const relationIds = s.selection.relationIds.filter((id) => relIds.has(id));
  if (elementIds.length !== s.selection.elementIds.length || relationIds.length !== s.selection.relationIds.length) {
    patch.selection = { elementIds, relationIds, edgeKey: relationIds.length ? s.selection.edgeKey : undefined };
  }
  if (s.code?.ownerId && !ids.has(s.code.ownerId) && !relIds.has(s.code.ownerId)) patch.code = { ...s.code, ownerId: undefined };
  const diagram = s.diagramId ? s.model.diagrams.find((d) => d.id === s.diagramId) : undefined;
  if (s.diagramId && !diagram) patch.diagramId = undefined;
  if (s.selectedShapeIds.length) {
    const known = new Set([...(diagram?.shapes ?? []), ...(diagram?.connectors ?? [])].map((x) => x.id));
    const kept = s.selectedShapeIds.filter((id) => known.has(id));
    if (kept.length !== s.selectedShapeIds.length) patch.selectedShapeIds = kept;
  }
  if (Object.keys(patch).length) set(patch);
}

/** The structure the data perspective is focused on: the first selected data element, if any. */
export function dataFocusId(s: Pick<State, 'selection' | 'model'>): string | undefined {
  return s.selection.elementIds.find((id) => s.model.elements.some((e) => e.id === id && e.kind === 'data'));
}

/** Back and Forward through the app's own history; the browser's buttons do the same. */
export function goBack() {
  if (get().navIndex > 0) history.back();
}

export function goForward() {
  if (get().navIndex < get().navMax) history.forward();
}

export function openCode(view: CodeView) {
  set({ code: view });
}

export function closeCode() {
  set({ code: null });
}

export function setOverlay(overlay: Overlay) {
  set({ overlay });
}

export { set as setState, get as getState };
