import { create } from 'zustand';
import type {
  AgentPresence,
  ChangeSet,
  FocusRequest,
  JournalEntry,
  Layout,
  Model,
  Perspective,
  Snapshot,
  StaleLink,
} from '../../shared/model.ts';
import { api, ApiError } from '../api.ts';
import { applyLocal, isLayoutOnly } from './apply.ts';

interface Pending {
  seq: number;
  cs: ChangeSet;
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
}

export type Overlay = 'palette' | 'export' | 'help' | 'activity' | null;

export interface Selection {
  elementIds: string[];
  relationIds: string[];
  /** Structure perspective: the projected thread key ("a->b") the relations came from. */
  edgeKey?: string;
}

const EMPTY_SELECTION: Selection = { elementIds: [], relationIds: [] };
const EMPTY_MODEL: Model = { version: 1, name: 'Architecture', description: '', elements: [], relations: [], flows: [] };
const UNSEEN_KEY = 'archweave.unseen';

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
  /** Bumped to ask the active canvas to center on the selection. */
  revealToken: number;
  /** A relation whose label field the inspector should focus once, right after connecting. */
  labelFocusFor?: string;

  /** Element and relation ids recently touched by the agent → time of the change. */
  fresh: Record<string, number>;
  /** Ids touched by the agent that the human has not selected since. */
  unseen: Record<string, true>;
  /** Removed by the agent a moment ago; kept briefly so they can fade out. */
  leaving: Record<string, number>;

  overlay: Overlay;
  code: CodeView | null;
  toasts: Toast[];
  humanChanged: boolean;
  dataRailOpen: boolean;
  showDataUsers: boolean;
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
  revealToken: 0,
  fresh: {},
  unseen: loadUnseen(),
  leaving: {},
  overlay: null,
  code: null,
  toasts: [],
  humanChanged: false,
  dataRailOpen: typeof window === 'undefined' || window.innerWidth >= 900,
  showDataUsers: false,
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
  const next: Partial<State> = { server: snapshot, pending, loaded: true, ...recompute(snapshot, pending) };
  if (entry && !state.journal.some((j) => j.revision === entry.revision && j.at === entry.at)) {
    next.journal = [...state.journal, entry].slice(-500);
  }
  set(next);
  sanitizeView(state.model);
  if (entry?.actor === 'agent') onAgentEntry(entry);
}

/** Applies a change locally right away and sends it to the server. */
export async function commit(cs: ChangeSet): Promise<boolean> {
  const p: Pending = { seq: ++seq, cs, layoutOnly: isLayoutOnly(cs), snapshotsSinceAck: 0 };
  const pending = [...get().pending, p];
  set({ pending, ...recompute(get().server, pending), ...(p.layoutOnly ? {} : { humanChanged: true }) });
  try {
    const result = await api.applyChanges(cs);
    const current = get();
    const acked = current.pending.map((q) => (q.seq === p.seq ? { ...q, ackRevision: result.revision } : q));
    const pruned = prune(acked, current.server?.revision ?? 0);
    set({ pending: pruned, ...recompute(current.server, pruned) });
    if (p.layoutOnly) setTimeout(() => dropPending(p.seq), 3000);
    for (const warning of result.warnings ?? []) toast({ tone: 'info', text: warning });
    return true;
  } catch (err) {
    dropPending(p.seq);
    toast({ tone: 'error', text: err instanceof ApiError ? err.message : 'Could not reach the ArchWeave server.' });
    return false;
  }
}

function dropPending(target: number) {
  const current = get();
  if (!current.pending.some((q) => q.seq === target)) return;
  const pending = current.pending.filter((q) => q.seq !== target);
  set({ pending, ...recompute(current.server, pending) });
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

function onAgentEntry(entry: JournalEntry) {
  const now = Date.now();
  const touched = [...entry.created.elements, ...entry.updated.elements, ...entry.created.relations, ...entry.updated.relations];
  const { fresh, unseen, leaving } = get();
  const nextFresh = { ...fresh };
  const nextUnseen = { ...unseen };
  for (const id of touched) {
    nextFresh[id] = now;
    nextUnseen[id] = true;
  }
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

  const navigable = touched.length > 0 || entry.created.flows.length + entry.updated.flows.length > 0;
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
  const { selection, stepIndex } = get();
  if (selection.elementIds.length || selection.relationIds.length || stepIndex !== null)
    set({ selection: EMPTY_SELECTION, stepIndex: null });
}

export function setPerspective(perspective: Perspective) {
  const s = get();
  if (s.perspective === perspective) return;
  const keep = s.selection.elementIds.filter((id) => {
    const el = s.model.elements.find((e) => e.id === id);
    if (!el) return false;
    return perspective === 'data' ? el.kind === 'data' : perspective === 'structure' ? el.kind !== 'data' : false;
  });
  set({ perspective, selection: { elementIds: keep, relationIds: [] }, stepIndex: null });
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
    set((s) => ({ perspective: 'data', selection: { elementIds: [id, ...extra], relationIds: [] }, revealToken: s.revealToken + 1, stepIndex: null }));
  } else {
    const parent = el.parentId && model.elements.some((e) => e.id === el.parentId) ? el.parentId : undefined;
    set((s) => ({
      perspective: 'structure',
      scopeId: parent,
      selection: { elementIds: [id, ...extra], relationIds: [] },
      revealToken: s.revealToken + 1,
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
    set((s) => ({ perspective: 'data', selection: { elementIds: [], relationIds: [id] }, revealToken: s.revealToken + 1 }));
    return;
  }
  // Show it at the scope of the source's parent; the projection lifts it if needed.
  const anchor = from?.kind === 'data' ? to : from;
  set((s) => ({
    perspective: 'structure',
    scopeId: anchor?.parentId,
    selection: { elementIds: [], relationIds: [id] },
    revealToken: s.revealToken + 1,
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
  if (flowId) openFlow(flowId);
}

export function handleFocusRequest(req: FocusRequest) {
  const { model } = get();
  const ids = req.elementIds.filter((id) => model.elements.some((e) => e.id === id));
  if (req.perspective === 'flows' || (req.flowId && !req.perspective)) {
    openFlow(req.flowId ?? get().flowId);
  } else if (req.perspective || req.scopeId !== undefined) {
    const perspective = req.perspective ?? 'structure';
    set((s) => ({
      perspective,
      scopeId: perspective === 'structure' ? (req.scopeId ?? undefined) : s.scopeId,
      selection: { elementIds: ids, relationIds: [] },
      revealToken: s.revealToken + 1,
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
  if (Object.keys(patch).length) set(patch);
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
