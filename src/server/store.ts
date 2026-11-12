import { type Actor, type ChangeResult, type ChangeSet, type JournalEntry, Layout, Model, type Snapshot } from '../shared/model.ts';
import { applyChangeSet, type Collection, describeChanges, describeEdit, diffModels, onlyUpdated, parseChangeSet } from './changes.ts';
import { integrityProblems } from './integrity.ts';
import type { CodeAccess } from './stale.ts';

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
  /** Normalizes code ref paths against the repository and seals refs written by change sets. Without it refs are stored unsealed. */
  code?: CodeAccess;
}

interface UndoStep {
  model: Model;
  layout: Layout;
}

export const JOURNAL_CAP = 500;
const UNDO_CAP = 50;
/** Quick edits of one item by one actor, without an explicit summary, share a journal entry within this window. */
export const COALESCE_MS = 60_000;

/** The last journal entry, while later edits may still be merged into it. */
interface OpenEdit {
  entry: JournalEntry;
  collection: Collection;
  id: string;
  /** The item before the first edit the entry holds. */
  before: object | undefined;
}

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
  private openEdit?: OpenEdit;
  private listeners = new Set<(change: StoreChange) => void>();
  private now: () => Date;
  private code?: CodeAccess;

  constructor(options: StoreOptions = {}) {
    this.model = parseModel(options.model ?? {});
    this.layout = Layout.parse(options.layout ?? {});
    this.entries = (options.journal ?? []).slice(-JOURNAL_CAP);
    this.revision = this.entries.reduce((max, e) => Math.max(max, e.revision), 0);
    this.now = options.now ?? (() => new Date());
    this.code = options.code;
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

  /** Validates and applies a change set atomically. Throws ChangeError with an actionable message, RevisionConflict when it was built from another revision. */
  apply(input: unknown, actor: Actor): ChangeResult {
    const changes = parseChangeSet(input);
    this.checkRevision(changes);
    const applied = applyChangeSet({ model: this.model, layout: this.layout }, changes, actor, this.now(), this.code);
    const { created, updated, removed, warnings } = applied;
    if (!applied.modelChanged && !applied.layoutChanged) {
      return { revision: this.revision, created, updated, removed, warnings };
    }
    let entry: JournalEntry | undefined;
    if (applied.modelChanged) {
      this.pushUndo();
      this.revision += 1;
      const summary = changes.summary?.trim();
      const target = summary ? undefined : onlyUpdated({ created, updated, removed });
      entry = target
        ? this.recordEdit(actor, target, { created, updated, removed }, applied.model)
        : this.record(actor, summary || describeChanges(created, updated, removed), { created, updated, removed });
    }
    if (applied.modelChanged) this.model = applied.model;
    this.layout = applied.layout;
    this.emit({ entry, modelChanged: applied.modelChanged, layoutChanged: applied.layoutChanged, cause: 'apply' });
    return { revision: this.revision, created, updated, removed, warnings };
  }

  /** Validates a change set and returns what `apply` would return, without applying it. */
  preview(input: unknown, actor: Actor): ChangeResult {
    const changes = parseChangeSet(input);
    this.checkRevision(changes);
    const applied = applyChangeSet({ model: this.model, layout: this.layout }, changes, actor, this.now(), this.code);
    const { created, updated, removed, warnings } = applied;
    return { revision: this.revision + (applied.modelChanged ? 1 : 0), created, updated, removed, warnings };
  }

  private checkRevision(changes: ChangeSet): void {
    if (changes.expectedRevision === undefined || changes.expectedRevision === this.revision || isLayoutOnly(changes)) return;
    throw new RevisionConflict(changes.expectedRevision, this.revision);
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
      this.openEdit = undefined;
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
    this.openEdit = undefined;
    return entry;
  }

  /**
   * Journals an update of one item without an explicit summary. It is merged into the previous entry
   * when that one is the same kind of edit, by the same actor, of the same item, less than COALESCE_MS old.
   * The merged entry takes the current revision (so `since` queries still return it), remembers the
   * first one in `firstRevision`, and its summary names everything changed since the first edit.
   */
  private recordEdit(actor: Actor, target: { collection: Collection; id: string }, lists: Pick<JournalEntry, 'created' | 'updated' | 'removed'>, after: Model): JournalEntry {
    const now = this.now();
    const open = this.openEdit;
    const last = this.entries.at(-1);
    const item = (model: Model) => (model[target.collection] as { id: string }[]).find((x) => x.id === target.id);
    const merge =
      open && last && open.entry === last && last.actor === actor && open.collection === target.collection && open.id === target.id && now.getTime() - Date.parse(last.at) < COALESCE_MS;
    const before = merge ? open.before : item(this.model);
    const summary = describeEdit(target.collection, before, item(after)!, after);
    if (!merge) {
      const entry = this.record(actor, summary, lists);
      this.openEdit = { entry, ...target, before };
      return entry;
    }
    const entry: JournalEntry = { ...last, revision: this.revision, firstRevision: last.firstRevision ?? last.revision, at: now.toISOString(), summary };
    this.entries[this.entries.length - 1] = entry;
    this.openEdit = { ...open, entry };
    return entry;
  }

  private emit(change: Omit<StoreChange, 'snapshot'>): void {
    const full = { ...change, snapshot: this.snapshot() };
    for (const listener of this.listeners) listener(full);
  }
}

/** A change set built from another revision than the current one. Nothing was applied. */
export class RevisionConflict extends Error {
  constructor(expected: number, current: number) {
    super(`The model changed since revision ${expected} (it is at revision ${current} now). Nothing was applied; read it again and retry.`);
    this.name = 'RevisionConflict';
  }
}

function isLayoutOnly(changes: ChangeSet): boolean {
  return !changes.model && !changes.elements?.length && !changes.relations?.length && !changes.flows?.length && !changes.remove;
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
