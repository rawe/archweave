import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { Actor, Diagram, Id, type JournalEntry } from '../shared/model.ts';
import { canonicalDiagram, canonicalLayout, canonicalModel, formatJson } from './canonical.ts';
import type { Store } from './store.ts';

const MODEL_FILE = 'model.json';
const LAYOUT_FILE = 'layout.json';
const JOURNAL_FILE = path.join('state', 'journal.jsonl');
/** One file per diagram, `<id>.json`. */
const DIAGRAM_DIR = 'diagrams';
const diagramFile = (id: string) => path.join(DIAGRAM_DIR, `${id}.json`);
/** Marks a `reported` entry as a read error, which no file text starts with. */
const UNREADABLE = '\0';

interface DiagramFiles {
  texts: Map<string, string>;
  /** Ids of files that exist but could not be read. */
  unreadable: Set<string>;
}

type Document = 'model' | 'layout' | 'journal';
const FILES: Record<Document, string> = { model: MODEL_FILE, layout: LAYOUT_FILE, journal: JOURNAL_FILE };

const IdLists = z
  .object({
    elements: z.array(z.string()).default([]),
    relations: z.array(z.string()).default([]),
    flows: z.array(z.string()).default([]),
    diagrams: z.array(z.string()).default([]),
  })
  .default({ elements: [], relations: [], flows: [], diagrams: [] });
const JournalLine = z.object({
  revision: z.number().int().positive(),
  firstRevision: z.number().int().positive().optional(),
  at: z.string(),
  actor: Actor,
  summary: z.string(),
  created: IdLists,
  updated: IdLists,
  removed: IdLists,
});

export interface Loaded {
  model?: unknown;
  /** The readable diagram files, by file name. */
  diagrams: Diagram[];
  layout?: unknown;
  journal: JournalEntry[];
}

export interface PersistenceOptions {
  debounceMs?: number;
  /** Model name used when there is no model.json yet. */
  defaultName?: string;
  log?: (message: string) => void;
}

/**
 * Keeps the data directory in sync with the store: debounced atomic writes in a
 * stable format, and reloads when the files change on disk for another reason.
 */
export class Persistence {
  private store?: Store;
  private unsubscribe?: () => void;
  private watcher?: fs.FSWatcher;
  private diagramWatcher?: fs.FSWatcher;
  private timer?: NodeJS.Timeout;
  private reloadTimer?: NodeJS.Timeout;
  private pending: Record<Document | 'diagrams', boolean> = { model: false, layout: false, journal: false, diagrams: false };
  private writing: Promise<void> = Promise.resolve();
  /** What this process last read or wrote, to tell its own writes from outside edits. */
  private known: Record<string, string | undefined> = {};
  /**
   * Per diagram this process read into the store or wrote: its canonical text at that time. A diagram whose
   * current canonical text differs has an edit that is not saved yet; its keys are the files this process may delete.
   * Kept apart from `known`, the raw file text, because a valid diagram file need not be canonically formatted.
   */
  private saved = new Map<string, string>();
  /** Diagram files already reported as skipped, by their text, so a reload does not report them again. */
  private reported: Record<string, string> = {};
  private readonly debounceMs: number;
  private readonly log: (message: string) => void;

  constructor(
    readonly dataDir: string,
    private options: PersistenceOptions = {},
  ) {
    this.debounceMs = options.debounceMs ?? 150;
    this.log = options.log ?? ((message) => console.warn(message));
  }

  async load(): Promise<Loaded> {
    await fsp.mkdir(path.join(this.dataDir, 'state'), { recursive: true });
    const ignore = path.join(this.dataDir, '.gitignore');
    if (!fs.existsSync(ignore)) await fsp.writeFile(ignore, 'state/\n');
    const model = await this.readJson(MODEL_FILE);
    const layout = await this.readJson(LAYOUT_FILE);
    const diagrams: Diagram[] = [];
    for (const [id, text] of (await this.readDiagramFiles()).texts) {
      const diagram = this.parseDiagram(id, text);
      if (!diagram) continue;
      diagrams.push(diagram);
      this.known[diagramFile(id)] = text;
      this.saved.set(id, formatJson(canonicalDiagram(diagram)));
    }
    return {
      model: model ?? (this.options.defaultName ? this.emptyModel() : undefined),
      diagrams,
      layout,
      journal: await this.readJournal(),
    };
  }

  /** Starts writing store changes to disk and reloading outside edits into the store. */
  attach(store: Store): void {
    this.store = store;
    this.unsubscribe = store.subscribe((change) => {
      if (change.cause === 'reload') return;
      if (change.modelChanged) this.pending.model = this.pending.diagrams = true;
      if (change.layoutChanged) this.pending.layout = true;
      if (change.entry) this.pending.journal = true;
      this.schedule();
    });
    try {
      this.watcher = fs.watch(this.dataDir, (_event, filename) => {
        const name = filename?.toString();
        if (name === DIAGRAM_DIR) this.watchDiagrams();
        if (name === MODEL_FILE || name === LAYOUT_FILE || name === DIAGRAM_DIR) this.scheduleReload();
      });
      this.watcher.on('error', (error) => this.log(`archweave: watching ${this.dataDir} failed: ${error.message}`));
    } catch (error) {
      this.log(`archweave: cannot watch ${this.dataDir}: ${(error as Error).message}`);
    }
    this.watchDiagrams();
  }

  /** (Re)starts watching the diagram directory, which appears with the first diagram and may go and come back with a checkout. */
  private watchDiagrams(): void {
    this.diagramWatcher?.close();
    this.diagramWatcher = undefined;
    const dir = path.join(this.dataDir, DIAGRAM_DIR);
    if (!fs.existsSync(dir)) return;
    try {
      const watcher = fs.watch(dir, (_event, filename) => {
        const name = filename?.toString();
        if (!name || name.endsWith('.json')) this.scheduleReload();
      });
      watcher.on('error', () => {
        watcher.close();
        if (this.diagramWatcher === watcher) this.diagramWatcher = undefined;
        this.scheduleReload();
      });
      this.diagramWatcher = watcher;
    } catch (error) {
      this.log(`archweave: cannot watch ${dir}: ${(error as Error).message}`);
    }
  }

  /** Writes anything pending now. */
  async flush(): Promise<void> {
    clearTimeout(this.timer);
    this.timer = undefined;
    const run = this.writing.catch(() => undefined).then(() => this.writePending());
    this.writing = run;
    await run;
  }

  async close(): Promise<void> {
    this.unsubscribe?.();
    this.watcher?.close();
    this.diagramWatcher?.close();
    clearTimeout(this.reloadTimer);
    await this.flush();
  }

  private schedule(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.flush().catch((error) => this.log(`archweave: saving failed: ${(error as Error).message}`));
    }, this.debounceMs);
  }

  /** Writes the pending documents. A document that fails to write stays pending for the next flush. */
  private async writePending(): Promise<void> {
    if (!this.store) return;
    const store = this.store;
    const { model, layout } = store.snapshot();
    const pending = this.pending;
    this.pending = { model: false, layout: false, journal: false, diagrams: false };
    const content: Record<Document, () => string> = {
      model: () => formatJson(canonicalModel(model)),
      layout: () => formatJson(canonicalLayout(layout)),
      journal: () => store.journal().map((e) => `${JSON.stringify(e)}\n`).join(''),
    };
    let failure: unknown;
    for (const doc of ['model', 'layout', 'journal'] as const) {
      if (!pending[doc]) continue;
      try {
        await this.writeFile(FILES[doc], content[doc]());
      } catch (error) {
        this.pending[doc] = true;
        failure ??= error;
      }
    }
    if (pending.diagrams) {
      try {
        await this.writeDiagrams(model.diagrams);
      } catch (error) {
        this.pending.diagrams = true;
        failure ??= error;
      }
    }
    if (failure) throw failure;
  }

  /** Writes the diagram files whose diagram changed since it was last read or written and deletes the files of removed diagrams. */
  private async writeDiagrams(diagrams: Diagram[]): Promise<void> {
    const wanted = new Map(diagrams.map((d) => [d.id, formatJson(canonicalDiagram(d))]));
    for (const [id, text] of wanted) {
      if (this.saved.get(id) === text) continue;
      await this.writeFile(diagramFile(id), text);
      this.saved.set(id, text);
    }
    for (const id of [...this.saved.keys()]) {
      if (wanted.has(id)) continue;
      await fsp.rm(path.join(this.dataDir, diagramFile(id)), { force: true });
      delete this.known[diagramFile(id)];
      this.saved.delete(id);
    }
  }

  private async writeFile(relative: string, content: string): Promise<void> {
    const target = path.join(this.dataDir, relative);
    const temp = `${target}.${process.pid}.tmp`;
    await fsp.mkdir(path.dirname(target), { recursive: true });
    try {
      await fsp.writeFile(temp, content);
      await fsp.rename(temp, target);
    } catch (error) {
      await fsp.rm(temp, { force: true }).catch(() => undefined);
      throw error;
    }
    this.known[relative] = content;
  }

  private scheduleReload(): void {
    clearTimeout(this.reloadTimer);
    this.reloadTimer = setTimeout(() => {
      this.writing = this.writing
        .catch(() => undefined)
        .then(() => this.reloadIfChanged())
        .catch((error) => this.log(`archweave: reload failed: ${(error as Error).message}`));
    }, 100);
  }

  /**
   * Takes over the documents that changed on disk since this process last read or wrote them.
   * A document with an edit that is not saved yet keeps the edit; the next write overwrites the file.
   * Everything is read first: from the last read to `store.replace` nothing is awaited, so no edit can
   * land between the decision that a document has none pending and the takeover that would discard it.
   */
  private async reloadIfChanged(): Promise<void> {
    if (!this.store) return;
    const texts = { model: await this.readText(MODEL_FILE), layout: await this.readText(LAYOUT_FILE) };
    const files = await this.readDiagramFiles();

    const parsed: { model?: unknown; layout?: unknown } = {};
    for (const doc of ['model', 'layout'] as const) {
      const text = texts[doc];
      if (text === this.known[FILES[doc]]) continue;
      if (this.pending[doc]) {
        this.log(`archweave: ${FILES[doc]} changed on disk while an edit was not saved yet; keeping the edit, it overwrites the file.`);
        continue;
      }
      try {
        parsed[doc] = text === undefined ? (doc === 'model' ? this.emptyModel() : {}) : JSON.parse(text);
      } catch (error) {
        this.log(`archweave: ignoring unreadable ${FILES[doc]} on disk: ${(error as Error).message}`);
      }
    }
    const diagrams = this.changedDiagrams(this.store, files);
    if (parsed.model === undefined && parsed.layout === undefined && !diagrams) return;
    try {
      this.store.replace(parsed.model, parsed.layout, diagrams?.list);
    } catch (error) {
      this.log(`archweave: ignoring the change on disk: ${describeInvalid(error)}`);
      return;
    }
    for (const doc of ['model', 'layout'] as const) if (parsed[doc] !== undefined) this.known[FILES[doc]] = texts[doc];
    for (const [id, taken] of diagrams?.taken ?? []) {
      this.known[diagramFile(id)] = taken?.text;
      if (taken) this.saved.set(id, formatJson(canonicalDiagram(taken.diagram)));
      else this.saved.delete(id);
    }
  }

  /**
   * The store's diagrams with the outside edits of diagram files taken over: files added, changed or deleted
   * since this process last read or wrote them (`taken`: what was read per id, undefined for a deleted file).
   * Undefined when there is none. As for the other documents, a diagram with an edit that is not saved yet
   * keeps the edit; a file that cannot be read, or is no diagram, keeps the diagram as it is.
   */
  private changedDiagrams(store: Store, files: DiagramFiles): { list: Diagram[]; taken: Map<string, { text: string; diagram: Diagram } | undefined> } | undefined {
    const next = new Map(store.snapshot().model.diagrams.map((d) => [d.id, d]));
    const taken = new Map<string, { text: string; diagram: Diagram } | undefined>();
    for (const id of new Set([...files.texts.keys(), ...this.saved.keys()])) {
      const file = diagramFile(id);
      const text = files.texts.get(id);
      if (files.unreadable.has(id) || text === this.known[file]) continue;
      const mine = next.get(id);
      if (this.pending.diagrams && (mine && formatJson(canonicalDiagram(mine))) !== this.saved.get(id)) {
        this.log(`archweave: ${file} changed on disk while an edit was not saved yet; keeping the edit, it overwrites the file.`);
        continue;
      }
      const diagram = text === undefined ? undefined : this.parseDiagram(id, text);
      if (text !== undefined && !diagram) continue;
      if (diagram) next.set(id, diagram);
      else next.delete(id);
      taken.set(id, diagram && { text: text!, diagram });
    }
    return taken.size ? { list: [...next.values()], taken } : undefined;
  }

  /**
   * The text of every `<id>.json` in the diagram directory, by id, sorted. Files with another kind of name are
   * skipped with a log line. Only a file that does not exist counts as absent: one that is there but cannot be
   * read is named in `unreadable`, with a log line, so a permission or I/O error is never taken for a deletion.
   */
  private async readDiagramFiles(): Promise<DiagramFiles> {
    const files: DiagramFiles = { texts: new Map(), unreadable: new Set() };
    let names: string[];
    try {
      names = (await fsp.readdir(path.join(this.dataDir, DIAGRAM_DIR))).filter((name) => name.endsWith('.json')).sort();
    } catch (error) {
      if (['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) return files;
      throw error;
    }
    for (const name of names) {
      const id = name.slice(0, -'.json'.length);
      const file = diagramFile(id);
      if (!Id.safeParse(id).success) {
        this.skipDiagram(file, '', 'the file name is not a diagram id (lowercase letters, digits, ".", "_" or "-")');
        continue;
      }
      try {
        const text = await this.readText(file);
        if (text !== undefined) files.texts.set(id, text);
        if (this.reported[file]?.startsWith(UNREADABLE)) delete this.reported[file];
      } catch (error) {
        files.unreadable.add(id);
        this.skipDiagram(file, `${UNREADABLE}${(error as Error).message}`, `it cannot be read: ${(error as Error).message}`);
      }
    }
    return files;
  }

  /** The diagram a file holds, with the file name as its id; undefined, with a log line, when the file is not a diagram. */
  private parseDiagram(id: string, text: string): Diagram | undefined {
    const file = diagramFile(id);
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch (error) {
      return this.skipDiagram(file, text, `not valid JSON: ${(error as Error).message}`);
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) return this.skipDiagram(file, text, 'not a JSON object');
    const version = (value as { version?: unknown }).version;
    if (version !== undefined && version !== 1) return this.skipDiagram(file, text, `version ${JSON.stringify(version)} is not supported, this server reads version 1`);
    const parsed = Diagram.safeParse({ ...value, id });
    if (!parsed.success) return this.skipDiagram(file, text, describeInvalid(parsed.error));
    delete this.reported[file];
    return parsed.data;
  }

  private skipDiagram(file: string, text: string, reason: string): undefined {
    if (this.reported[file] !== text) this.log(`archweave: skipped ${file}: ${reason}`);
    this.reported[file] = text;
    return undefined;
  }

  private emptyModel(): unknown {
    return this.options.defaultName ? { name: this.options.defaultName } : {};
  }

  private async readText(relative: string): Promise<string | undefined> {
    try {
      return await fsp.readFile(path.join(this.dataDir, relative), 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
  }

  private async readJson(relative: string): Promise<unknown> {
    const text = await this.readText(relative);
    this.known[relative] = text;
    if (text === undefined) return undefined;
    try {
      return JSON.parse(text);
    } catch (error) {
      throw new Error(`${path.join(this.dataDir, relative)} is not valid JSON: ${(error as Error).message}`);
    }
  }

  private async readJournal(): Promise<JournalEntry[]> {
    const text = await this.readText(JOURNAL_FILE);
    if (!text) return [];
    const entries: JournalEntry[] = [];
    text.split('\n').forEach((line, i) => {
      if (!line.trim()) return;
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch {
        this.log(`archweave: skipped journal line ${i + 1}: not JSON`);
        return;
      }
      const entry = JournalLine.safeParse(value);
      if (entry.success) entries.push(entry.data);
      else this.log(`archweave: skipped journal line ${i + 1}: ${entry.error.issues.map((issue) => `${issue.path.join('.') || 'entry'}: ${issue.message}`).join('; ')}`);
    });
    return entries;
  }
}

function describeInvalid(error: unknown): string {
  const issues = (error as { issues?: { path: PropertyKey[]; message: string }[] }).issues;
  if (issues) return issues.slice(0, 5).map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
  return (error as Error).message;
}
