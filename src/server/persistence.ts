import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { Actor, type JournalEntry } from '../shared/model.ts';
import { canonicalLayout, canonicalModel, formatJson } from './canonical.ts';
import type { Store } from './store.ts';

const MODEL_FILE = 'model.json';
const LAYOUT_FILE = 'layout.json';
const JOURNAL_FILE = path.join('state', 'journal.jsonl');

type Document = 'model' | 'layout' | 'journal';
const FILES: Record<Document, string> = { model: MODEL_FILE, layout: LAYOUT_FILE, journal: JOURNAL_FILE };

const IdLists = z
  .object({ elements: z.array(z.string()).default([]), relations: z.array(z.string()).default([]), flows: z.array(z.string()).default([]) })
  .default({ elements: [], relations: [], flows: [] });
const JournalLine = z.object({
  revision: z.number().int().positive(),
  at: z.string(),
  actor: Actor,
  summary: z.string(),
  created: IdLists,
  updated: IdLists,
  removed: IdLists,
});

export interface Loaded {
  model?: unknown;
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
  private timer?: NodeJS.Timeout;
  private reloadTimer?: NodeJS.Timeout;
  private pending: Record<Document, boolean> = { model: false, layout: false, journal: false };
  private writing: Promise<void> = Promise.resolve();
  /** What this process last read or wrote, to tell its own writes from outside edits. */
  private known: Record<string, string | undefined> = {};
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
    return {
      model: model ?? (this.options.defaultName ? this.emptyModel() : undefined),
      layout,
      journal: await this.readJournal(),
    };
  }

  /** Starts writing store changes to disk and reloading outside edits into the store. */
  attach(store: Store): void {
    this.store = store;
    this.unsubscribe = store.subscribe((change) => {
      if (change.cause === 'reload') return;
      if (change.modelChanged) this.pending.model = true;
      if (change.layoutChanged) this.pending.layout = true;
      if (change.entry) this.pending.journal = true;
      this.schedule();
    });
    try {
      this.watcher = fs.watch(this.dataDir, (_event, filename) => {
        const name = filename?.toString();
        if (name === MODEL_FILE || name === LAYOUT_FILE) this.scheduleReload();
      });
      this.watcher.on('error', (error) => this.log(`archweave: watching ${this.dataDir} failed: ${error.message}`));
    } catch (error) {
      this.log(`archweave: cannot watch ${this.dataDir}: ${(error as Error).message}`);
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
    this.pending = { model: false, layout: false, journal: false };
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
    if (failure) throw failure;
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
   */
  private async reloadIfChanged(): Promise<void> {
    if (!this.store) return;
    const texts = { model: await this.readText(MODEL_FILE), layout: await this.readText(LAYOUT_FILE) };
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
    if (parsed.model === undefined && parsed.layout === undefined) return;
    try {
      this.store.replace(parsed.model, parsed.layout);
    } catch (error) {
      this.log(`archweave: ignoring the change on disk: ${describeInvalid(error)}`);
      return;
    }
    for (const doc of ['model', 'layout'] as const) if (parsed[doc] !== undefined) this.known[FILES[doc]] = texts[doc];
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
