import { type Actor, type ChangeResult, type JournalEntry, Layout, Model, type Snapshot } from '../shared/model.ts';
import { applyChangeSet, describeChanges, diffModels, parseChangeSet } from './changes.ts';
import { integrityProblems } from './integrity.ts';

export { ChangeError } from './changes.ts';

export interface StoreChange {
  snapshot: Snapshot;
  entry?: JournalEntry;
  modelChanged: boolean;
  layoutChanged: boolean;
  /** `reload` means the change came from disk and must not be written back. */
  cause: 'apply' | 'undo' | 'reload';
}

export interface StoreOptions {
  model?: unknown;
  layout?: unknown;
  journal?: JournalEntry[];
  now?: () => Date;
}

interface UndoStep {
  model: Model;
  layout: Layout;
}

export const JOURNAL_CAP = 500;
const UNDO_CAP = 50;

/**
 * The single owner of the model, layout, revision, journal and undo history.
 * Every mutation goes through `apply` (or `undo` / `replace`), which notifies subscribers.
 * Returned objects are shared and must be treated as read-only.
 */
export class Store {
  private model: Model;
  private layout: Layout;
  private revision: number;
  private entries: JournalEntry[];
  private undoStack: UndoStep[] = [];
  private listeners = new Set<(change: StoreChange) => void>();
  private now: () => Date;

  constructor(options: StoreOptions = {}) {
    this.model = parseModel(options.model ?? {});
    this.layout = Layout.parse(options.layout ?? {});
    this.entries = (options.journal ?? []).slice(-JOURNAL_CAP);
    this.revision = this.entries.reduce((max, e) => Math.max(max, e.revision), 0);
    this.now = options.now ?? (() => new Date());
  }

  snapshot(): Snapshot {
    return { revision: this.revision, model: this.model, layout: this.layout };
  }

  get currentRevision(): number {
    return this.revision;
  }

  journal(filter: { since?: number; actor?: Actor } = {}): JournalEntry[] {
    return this.entries.filter((e) => (filter.since === undefined || e.revision > filter.since) && (!filter.actor || e.actor === filter.actor));
  }

  /** Validates and applies a change set atomically. Throws ChangeError with an actionable message. */
  apply(input: unknown, actor: Actor): ChangeResult {
    const changes = parseChangeSet(input);
    const applied = applyChangeSet({ model: this.model, layout: this.layout }, changes, actor, this.now());
    const { created, updated, removed, warnings } = applied;
    if (!applied.modelChanged && !applied.layoutChanged) {
      return { revision: this.revision, created, updated, removed, warnings };
    }
    let entry: JournalEntry | undefined;
    if (applied.modelChanged) {
      this.pushUndo();
      this.revision += 1;
      entry = this.record(actor, changes.summary?.trim() || describeChanges(created, updated, removed), { created, updated, removed });
    }
    if (applied.modelChanged) this.model = applied.model;
    this.layout = applied.layout;
    this.emit({ entry, modelChanged: applied.modelChanged, layoutChanged: applied.layoutChanged, cause: 'apply' });
    return { revision: this.revision, created, updated, removed, warnings };
  }

  /** Validates a change set and returns what `apply` would return, without applying it. */
  preview(input: unknown, actor: Actor): ChangeResult {
    const applied = applyChangeSet({ model: this.model, layout: this.layout }, parseChangeSet(input), actor, this.now());
    const { created, updated, removed, warnings } = applied;
    return { revision: this.revision + (applied.modelChanged ? 1 : 0), created, updated, removed, warnings };
  }

  canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  /** Restores the model before the last model change. Returns the new revision, or undefined when there is nothing to undo. */
  undo(actor: Actor = 'human'): number | undefined {
    const step = this.undoStack.pop();
    if (!step) return undefined;
    const lastEntry = this.entries.at(-1);
    const diff = diffModels(this.model, step.model);
    this.layout = mergeLayoutForUndo(this.layout, step.layout, step.model);
    this.model = step.model;
    this.revision += 1;
    const entry = this.record(actor, `Undo: ${lastEntry?.summary ?? 'last change'}`, diff);
    this.emit({ entry, modelChanged: true, layoutChanged: true, cause: 'undo' });
    return this.revision;
  }

  /**
   * Takes over a model and/or layout changed on disk by someone else (git checkout, manual edit).
   * `undefined` keeps the current document. Both are validated before either is replaced;
   * an invalid document throws and changes nothing.
   */
  replace(model: unknown, layout: unknown): void {
    const nextModel = model === undefined ? undefined : parseModel(model);
    const nextLayout = layout === undefined ? undefined : Layout.parse(layout);
    if (!nextModel && !nextLayout) return;
    if (nextModel) {
      this.model = nextModel;
      this.undoStack = [];
      this.revision += 1;
    }
    if (nextLayout) this.layout = nextLayout;
    this.emit({ modelChanged: !!nextModel, layoutChanged: !!nextLayout, cause: 'reload' });
  }

  subscribe(listener: (change: StoreChange) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private pushUndo(): void {
    this.undoStack.push({ model: this.model, layout: this.layout });
    if (this.undoStack.length > UNDO_CAP) this.undoStack.shift();
  }

  private record(actor: Actor, summary: string, lists: Pick<JournalEntry, 'created' | 'updated' | 'removed'>): JournalEntry {
    const entry: JournalEntry = { revision: this.revision, at: this.now().toISOString(), actor, summary, ...lists };
    this.entries.push(entry);
    if (this.entries.length > JOURNAL_CAP) this.entries.splice(0, this.entries.length - JOURNAL_CAP);
    return entry;
  }

  private emit(change: Omit<StoreChange, 'snapshot'>): void {
    const full = { ...change, snapshot: this.snapshot() };
    for (const listener of this.listeners) listener(full);
  }
}

export class ModelIntegrityError extends Error {
  constructor(readonly problems: string[]) {
    const shown = problems.slice(0, 20).map((p) => `- ${p}`);
    if (problems.length > shown.length) shown.push(`- …and ${problems.length - shown.length} more`);
    super(`${problems.length} problem${problems.length === 1 ? '' : 's'} in the model:\n${shown.join('\n')}`);
    this.name = 'ModelIntegrityError';
  }
}

/** Schema and graph validation for a model read from outside the store. */
function parseModel(input: unknown): Model {
  const model = Model.parse(input);
  const problems = integrityProblems(model);
  if (problems.length) throw new ModelIntegrityError(problems);
  return model;
}

/** Keeps the human's current arrangement, restoring positions only for elements that come back. */
function mergeLayoutForUndo(current: Layout, previous: Layout, model: Model): Layout {
  const ids = new Set(model.elements.map((e) => e.id));
  const out: Layout = {};
  for (const canvas of new Set([...Object.keys(current), ...Object.keys(previous)])) {
    const scope = canvas.startsWith('structure:') ? canvas.slice('structure:'.length) : undefined;
    if (scope && scope !== 'root' && !ids.has(scope)) continue;
    const merged = { ...previous[canvas], ...current[canvas] };
    for (const id of Object.keys(merged)) if (!ids.has(id)) delete merged[id];
    if (Object.keys(merged).length) out[canvas] = merged;
  }
  return out;
}
