import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { JournalEntry } from '../shared/model.ts';
import { canonicalLayout, canonicalModel, formatJson } from './canonical.ts';
import type { Store } from './store.ts';

const MODEL_FILE = 'model.json';
const LAYOUT_FILE = 'layout.json';
const JOURNAL_FILE = path.join('state', 'journal.jsonl');

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
  private pending = { model: false, layout: false, journal: false };
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
      model: model ?? (this.options.defaultName ? { name: this.options.defaultName } : undefined),
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

  private async writePending(): Promise<void> {
    if (!this.store) return;
    const { model, layout } = this.store.snapshot();
    const pending = this.pending;
    this.pending = { model: false, layout: false, journal: false };
    if (pending.model) await this.writeFile(MODEL_FILE, formatJson(canonicalModel(model)));
    if (pending.layout) await this.writeFile(LAYOUT_FILE, formatJson(canonicalLayout(layout)));
    if (pending.journal) {
      const lines = this.store.journal().map((e) => JSON.stringify(e));
      await this.writeFile(JOURNAL_FILE, lines.length ? `${lines.join('\n')}\n` : '');
    }
  }

  private async writeFile(relative: string, content: string): Promise<void> {
    const target = path.join(this.dataDir, relative);
    const temp = `${target}.${process.pid}.tmp`;
    this.known[relative] = content;
    await fsp.mkdir(path.dirname(target), { recursive: true });
    await fsp.writeFile(temp, content);
    await fsp.rename(temp, target);
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

  private async reloadIfChanged(): Promise<void> {
    if (!this.store) return;
    const files = [MODEL_FILE, LAYOUT_FILE];
    const texts = await Promise.all(files.map((f) => this.readText(f)));
    if (texts.every((text, i) => text === this.known[files[i]!])) return;
    let model: unknown;
    let layout: unknown;
    try {
      model = texts[0] === undefined ? (this.options.defaultName ? { name: this.options.defaultName } : {}) : JSON.parse(texts[0]);
      layout = texts[1] === undefined ? {} : JSON.parse(texts[1]);
      this.store.replace(model, layout);
    } catch (error) {
      this.log(`archweave: ignoring unreadable change on disk: ${(error as Error).message}`);
      return;
    }
    files.forEach((f, i) => (this.known[f] = texts[i]));
    this.pending.model = false;
    this.pending.layout = false;
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
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        entries.push(JSON.parse(line) as JournalEntry);
      } catch {
        this.log('archweave: skipped an unreadable journal line');
      }
    }
    return entries;
  }
}
