/**
 * Back and Forward through the views the human moved through. The address holds the view (perspective,
 * scope, flow, diagram); each history entry's state holds the selection and the entry's place in the
 * app's own history, so Back restores what was selected and the app knows whether Back and Forward lead
 * anywhere. Works on any History-like object, so it is tested without a browser.
 */
import type { Model } from '../../shared/model.ts';

export interface NavSelection {
  elementIds: string[];
  relationIds: string[];
  shapeIds: string[];
  edgeKey?: string;
  step?: number;
}

/** What each history entry of the app carries. */
export interface NavEntry extends NavSelection {
  /** The entry's position in the app's history: 0 is the first view of this tab. */
  idx: number;
  /** The last position reachable with Forward, as known when the entry was last shown. */
  max: number;
}

export interface HistoryLike {
  readonly state: unknown;
  pushState(data: unknown, unused: string, url?: string): void;
  replaceState(data: unknown, unused: string, url?: string): void;
}

export const NO_SELECTION: NavSelection = { elementIds: [], relationIds: [], shapeIds: [] };

const ids = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string');

/** The app's entry in a history state, or undefined for an entry the app did not write. */
export function readEntry(state: unknown): NavEntry | undefined {
  if (!state || typeof state !== 'object') return undefined;
  const s = state as Record<string, unknown>;
  if (!Number.isInteger(s.idx) || !Number.isInteger(s.max) || !ids(s.elementIds) || !ids(s.relationIds) || !ids(s.shapeIds)) return undefined;
  return {
    idx: s.idx as number,
    max: Math.max(s.max as number, s.idx as number),
    elementIds: s.elementIds,
    relationIds: s.relationIds,
    shapeIds: s.shapeIds,
    ...(typeof s.edgeKey === 'string' ? { edgeKey: s.edgeKey } : {}),
    ...(Number.isInteger(s.step) ? { step: s.step as number } : {}),
  };
}

function selectionOf(entry: NavSelection): NavSelection {
  const { elementIds, relationIds, shapeIds, edgeKey, step } = entry;
  return { elementIds, relationIds, shapeIds, ...(edgeKey !== undefined ? { edgeKey } : {}), ...(step !== undefined ? { step } : {}) };
}

function sameSelection(a: NavSelection, b: NavSelection): boolean {
  return JSON.stringify(selectionOf(a)) === JSON.stringify(selectionOf(b));
}

/**
 * The app's side of the browser history. `navMax` lives in every entry the app writes (`max`), refreshed
 * whenever an entry is shown, so a reload on any entry still knows how far Forward reaches; while the page
 * lives, the in-memory value is the truth, because traversing never changes it and only a push shortens it.
 */
export class NavHistory {
  private entry: NavEntry;
  /** The entry found on load, when the app wrote it before (a reload, or Back into the app). */
  readonly restored: NavEntry | undefined;

  constructor(
    private readonly history: HistoryLike,
    private url: string,
  ) {
    this.restored = readEntry(history.state);
    this.entry = this.restored ?? { idx: 0, max: 0, ...NO_SELECTION };
    if (!this.restored) history.replaceState(this.entry, '');
  }

  get index(): number {
    return this.entry.idx;
  }

  get max(): number {
    return this.entry.max;
  }

  get canBack(): boolean {
    return this.entry.idx > 0;
  }

  get canForward(): boolean {
    return this.entry.idx < this.entry.max;
  }

  /** A deliberate move: a new entry after the current one, which drops what Forward led to. False when nothing would change. */
  push(url: string, selection: NavSelection): boolean {
    if (url === this.url && sameSelection(selection, this.entry)) return false;
    const idx = this.entry.idx + 1;
    this.entry = { idx, max: idx, ...selectionOf(selection) };
    this.url = url;
    this.history.pushState(this.entry, '', url);
    return true;
  }

  /**
   * The selection changed within the same view: the current entry remembers it, without a new entry. With
   * `url`, the entry's address is corrected too (the first view of a page opened without one).
   */
  replace(selection: NavSelection, url?: string): void {
    if ((url === undefined || url === this.url) && sameSelection(selection, this.entry)) return;
    this.entry = { idx: this.entry.idx, max: this.entry.max, ...selectionOf(selection) };
    if (url !== undefined) this.url = url;
    this.history.replaceState(this.entry, '', url);
  }

  /**
   * The browser moved to another entry (Back, Forward, or an address typed by hand). Returns the entry with
   * its stored selection, or undefined for an entry the app did not write; that one is adopted as a new
   * last entry. Only the entry now shown is rewritten, so the entries Forward leads to stay.
   */
  pop(state: unknown, url: string): NavEntry | undefined {
    this.url = url;
    const found = readEntry(state);
    this.entry = found ? { ...found, max: Math.max(this.entry.max, found.idx) } : { idx: this.entry.idx + 1, max: this.entry.idx + 1, ...NO_SELECTION };
    this.history.replaceState(this.entry, '');
    return found;
  }
}

/** A stored selection, keeping only what still exists in the view it is restored into. */
export function restorable(
  entry: NavSelection,
  model: Pick<Model, 'elements' | 'relations' | 'flows' | 'diagrams'>,
  view: { flowId?: string; diagramId?: string },
): { elementIds: string[]; relationIds: string[]; edgeKey?: string; shapeIds: string[]; stepIndex: number | null } {
  const elements = new Set(model.elements.map((e) => e.id));
  const relations = new Set(model.relations.map((r) => r.id));
  const diagram = view.diagramId ? model.diagrams.find((d) => d.id === view.diagramId) : undefined;
  const shapes = new Set([...(diagram?.shapes ?? []), ...(diagram?.connectors ?? [])].map((s) => s.id));
  const steps = view.flowId ? (model.flows.find((f) => f.id === view.flowId)?.steps.length ?? 0) : 0;
  const relationIds = entry.relationIds.filter((id) => relations.has(id));
  return {
    elementIds: entry.elementIds.filter((id) => elements.has(id)),
    relationIds,
    ...(relationIds.length && entry.edgeKey ? { edgeKey: entry.edgeKey } : {}),
    shapeIds: entry.shapeIds.filter((id) => shapes.has(id)),
    stepIndex: entry.step !== undefined && entry.step < steps ? entry.step : null,
  };
}
