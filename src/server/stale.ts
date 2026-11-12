import { createHash } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import type { CodeRef, LineRange, Model, StaleLink, StaleReason } from '../shared/model.ts';
import { countLines, type FileInfo, isBinary, MAX_FILE_BYTES, PathError, type Repo } from './repo.ts';

interface FileFacts {
  mtimeMs: number;
  size?: number;
  exists: boolean;
  isFile: boolean;
  /** Larger than MAX_FILE_BYTES, or binary: only existence is checked, and refs to it are never sealed. */
  opaque: boolean;
  lineCount: number;
  content: string;
  /** Normalized lines (see `normalizeLine`), computed on first use. */
  lines?: string[];
  /** Results of searches for moved text, keyed by digest, length, origin and symbol. */
  moves?: Map<string, LineRange | undefined>;
}

export interface OwnedRef {
  ownerType: StaleLink['ownerType'];
  ownerId: string;
  /** For flow refs: the 1-based step number. */
  step?: number;
  /** Position of the ref in its owner's (or step's) code ref list. */
  index: number;
  ref: CodeRef;
}

/** The check result for one ref: no `reason` means it matches the repository. */
export interface Verdict {
  reason?: StaleReason;
  suggestion?: LineRange;
}

export type RefStatus = OwnedRef & Verdict;

/** What the store learns about a ref it writes: its seal, and why it is stale already, if it is. */
export interface Seal {
  digest?: string;
  reason?: StaleReason;
}

/** What the store needs from the repository to write code refs. */
export interface CodeAccess {
  /** The seal of a ref about to be written, and why it is stale already, if it is. */
  seal(ref: CodeRef): Seal;
  /** The stored form of a code ref path: repo-relative ("." for the root). Throws PathError for paths outside the repository. */
  normalizePath(path: string): string;
}

/** Every code ref in the model with the element, relation or flow step that holds it. */
export function allCodeRefs(model: Model): OwnedRef[] {
  const out: OwnedRef[] = [];
  for (const e of model.elements) e.codeRefs.forEach((ref, index) => out.push({ ownerType: 'element', ownerId: e.id, index, ref }));
  for (const r of model.relations) r.codeRefs.forEach((ref, index) => out.push({ ownerType: 'relation', ownerId: r.id, index, ref }));
  for (const f of model.flows) {
    f.steps.forEach((step, i) => step.codeRefs.forEach((ref, index) => out.push({ ownerType: 'flow', ownerId: f.id, step: i + 1, index, ref })));
  }
  return out;
}

/** The public form of a stale ref status. */
export function staleLink(status: RefStatus): StaleLink {
  return {
    ownerType: status.ownerType,
    ownerId: status.ownerId,
    ...(status.step ? { step: status.step } : {}),
    ref: status.ref,
    reason: status.reason!,
    ...(status.suggestion ? { suggestion: status.suggestion } : {}),
  };
}

/** Finds code refs that no longer match the repository. File facts are cached by mtime and size. */
export class StaleLinks {
  private cache = new Map<string, FileFacts>();

  constructor(private repo: Repo) {}

  async check(model: Model): Promise<StaleLink[]> {
    return this.checkRefs(allCodeRefs(model));
  }

  async checkRefs(refs: OwnedRef[]): Promise<StaleLink[]> {
    return (await this.inspect(refs)).filter((s) => s.reason).map(staleLink);
  }

  /** Checks every ref, stale or not. */
  async inspect<T extends { ref: CodeRef }>(refs: T[]): Promise<(T & Verdict)[]> {
    const facts = new Map<string, FileFacts>();
    await Promise.all([...new Set(refs.map((r) => r.ref.path))].map(async (p) => facts.set(p, await this.facts(p))));
    return refs.map((owned) => ({ ...owned, ...verdict(owned.ref, facts.get(owned.ref.path)!) }));
  }

  /**
   * Seals a ref the store is about to write: the digest of its line range when the file is readable and
   * the range lies inside it, plus the plain check result. Synchronous, because the store applies change sets synchronously.
   */
  seal(ref: CodeRef): Seal {
    const file = this.factsSync(ref.path);
    const reason = plainReason(ref, file);
    if (!ref.startLine || !file.isFile || file.opaque) return reason ? { reason } : {};
    const [from, to] = rangeOf(ref);
    const digest = to <= file.lineCount ? digestLines(linesOf(file), from, to) : undefined;
    return { ...(digest ? { digest } : {}), ...(reason ? { reason } : {}) };
  }

  /** Sealing and path normalization against this repository, for the store. */
  get access(): CodeAccess {
    return {
      seal: (ref) => this.seal(ref),
      normalizePath: (path) => this.repo.normalize(path) || '.',
    };
  }

  private async facts(refPath: string): Promise<FileFacts> {
    let info: FileInfo | undefined;
    try {
      info = await this.repo.info(refPath);
    } catch (error) {
      if (error instanceof PathError) return missingFile();
      throw error;
    }
    return this.known(info) ?? this.remember(info!, await fsp.readFile(info!.absolute));
  }

  private factsSync(refPath: string): FileFacts {
    let info: FileInfo | undefined;
    try {
      info = this.repo.infoSync(refPath);
    } catch (error) {
      if (error instanceof PathError) return missingFile();
      throw error;
    }
    return this.known(info) ?? this.remember(info!, fs.readFileSync(info!.absolute));
  }

  /** Facts that need no read: missing, not a file, too large, or cached for this mtime. */
  private known(info: FileInfo | undefined): FileFacts | undefined {
    if (!info) return missingFile();
    if (!info.isFile) return { ...missingFile(), exists: true, mtimeMs: info.mtimeMs };
    if (info.size > MAX_FILE_BYTES) return { ...missingFile(), exists: true, isFile: true, opaque: true, mtimeMs: info.mtimeMs };
    const cached = this.cache.get(info.absolute);
    return cached && cached.mtimeMs === info.mtimeMs && cached.size === info.size ? cached : undefined;
  }

  /** Binary files are classified as the code file endpoint does: existence only. */
  private remember(info: FileInfo, bytes: Buffer): FileFacts {
    const fresh: FileFacts = isBinary(bytes)
      ? { ...missingFile(), exists: true, isFile: true, opaque: true, mtimeMs: info.mtimeMs, size: info.size }
      : (() => {
          const content = bytes.toString('utf8');
          return { mtimeMs: info.mtimeMs, size: info.size, exists: true, isFile: true, opaque: false, lineCount: countLines(content), content };
        })();
    this.cache.set(info.absolute, fresh);
    return fresh;
  }
}

function missingFile(): FileFacts {
  return { mtimeMs: 0, exists: false, isFile: false, opaque: false, lineCount: 0, content: '' };
}

/** The status of one ref against one file. Sealed refs are checked by their text; the others by lines and symbol. */
function verdict(ref: CodeRef, file: FileFacts): Verdict {
  if (!ref.digest || !ref.startLine || !file.isFile || file.opaque) {
    const reason = plainReason(ref, file);
    return reason ? { reason } : {};
  }
  const [from, to] = rangeOf(ref);
  const lines = linesOf(file);
  if (to <= file.lineCount && digestLines(lines, from, to) === ref.digest) {
    const reason = plainReason(ref, file);
    return reason ? { reason } : {};
  }
  const symbolAt = ref.symbol ? symbolLines(file.content, ref.symbol) : undefined;
  const moved = findMoved(file, ref.digest, to - from + 1, from, symbolAt, ref.symbol);
  if (moved) return { reason: 'moved', suggestion: moved };
  if (symbolAt) {
    if (!symbolAt.length) return { reason: 'symbol-not-found' };
    if (symbolAt.some((line) => line >= from && line <= to)) return { reason: 'changed' };
    const anchor = symbolAnchor(file, ref.symbol!, symbolAt);
    if (anchor === undefined) return { reason: 'changed' };
    return { reason: 'changed', suggestion: { startLine: anchor, endLine: Math.min(anchor + (to - from), file.lineCount) } };
  }
  return { reason: to > file.lineCount ? 'line-out-of-range' : 'changed' };
}

/** The checks for refs without a seal (and for sealed refs whose text still matches). */
function plainReason(ref: CodeRef, file: FileFacts): StaleReason | undefined {
  if (!file.exists) return 'missing-file';
  if (!file.isFile || file.opaque) return undefined;
  if ((ref.startLine && ref.startLine > file.lineCount) || (ref.endLine && ref.endLine > file.lineCount)) return 'line-out-of-range';
  if (!ref.symbol) return undefined;
  const lines = symbolLines(file.content, ref.symbol);
  if (!lines.length) return 'symbol-not-found';
  if (ref.startLine) {
    const [from, to] = rangeOf(ref);
    if (!lines.some((line) => line >= from && line <= to)) return 'symbol-outside-range';
  }
  return undefined;
}

function rangeOf(ref: CodeRef): [number, number] {
  const start = ref.startLine!;
  const end = ref.endLine ?? start;
  return [Math.min(start, end), Math.max(start, end)];
}

// ─── Seals ──────────────────────────────────────────────────────────────────

/** Characters of the base64url digest: 72 bits of SHA-256. */
export const DIGEST_LENGTH = 12;

/** Lines are compared without the whitespace at either end, so re-indenting or trailing spaces do not count as a change. */
function normalizeLine(line: string): string {
  return line.trim();
}

/** The seal of a piece of text: SHA-256 over its normalized lines joined by "\n", first 12 base64url characters. */
export function digestText(text: string): string {
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return hashLines(lines.map(normalizeLine));
}

function hashLines(lines: string[]): string {
  return createHash('sha256').update(lines.join('\n')).digest('base64url').slice(0, DIGEST_LENGTH);
}

/** The seal of lines from..to (1-based, inclusive) of a file's normalized lines. */
function digestLines(lines: string[], from: number, to: number): string | undefined {
  if (from < 1 || to > lines.length || from > to) return undefined;
  return hashLines(lines.slice(from - 1, to));
}

function linesOf(file: FileFacts): string[] {
  if (!file.lines) {
    const lines = file.content.split('\n');
    if (file.content.endsWith('\n')) lines.pop();
    file.lines = file.content ? lines.map(normalizeLine) : [];
  }
  return file.lines;
}

/**
 * Looks for a window of `length` lines with this seal, nearest to `origin` first (ties go to the earlier line).
 * With a symbol, the window must contain one of its occurrences.
 */
function findMoved(file: FileFacts, digest: string, length: number, origin: number, symbolAt: number[] | undefined, symbol: string | undefined): LineRange | undefined {
  const key = `${digest}:${length}:${origin}:${symbol ?? ''}`;
  file.moves ??= new Map();
  if (file.moves.has(key)) return file.moves.get(key);
  const lines = linesOf(file);
  const last = lines.length - length + 1;
  let found: LineRange | undefined;
  const fits = (start: number) =>
    start >= 1 &&
    start <= last &&
    (!symbolAt || symbolAt.some((line) => line >= start && line < start + length)) &&
    digestLines(lines, start, start + length - 1) === digest;
  for (let distance = 1; !found && (origin - distance >= 1 || origin + distance <= last); distance++) {
    for (const start of [origin - distance, origin + distance]) {
      if (fits(start)) {
        found = { startLine: start, endLine: start + length - 1 };
        break;
      }
    }
  }
  file.moves.set(key, found);
  return found;
}

const DECLARATION = /\b(?:function|class|interface|type|enum|struct|trait|impl|def|fn|func|module|object|record|const|let|var|val)\s+\*?\s*$/;

/**
 * Where a symbol most likely lives now, without parsing: its only declaration-like occurrence
 * ("function x", "class x", "def x", "const x"), else its only occurrence. Undefined when ambiguous.
 */
function symbolAnchor(file: FileFacts, symbol: string, occurrences: number[]): number | undefined {
  const name = symbol.trim().replace(/^(['"`])(.*)\1$/, '$2').split(/\.|::|#/).filter(Boolean).at(-1) ?? symbol;
  const raw = file.content.split('\n');
  const declarations = occurrences.filter((line) => {
    const text = raw[line - 1] ?? '';
    const at = text.search(new RegExp(`(?<![\\w$])${escapeRegExp(name)}(?![\\w$])`));
    return at >= 0 && DECLARATION.test(text.slice(0, at));
  });
  if (declarations.length === 1) return declarations[0];
  if (!declarations.length && occurrences.length === 1) return occurrences[0];
  return undefined;
}

// ─── Symbols ────────────────────────────────────────────────────────────────

/**
 * 1-based lines where `symbol` occurs as an identifier: whole word, not wrapped in quotes.
 * Quotes around the symbol itself are ignored. For qualified names ("Store.apply", "Foo::bar") the last segment is enough.
 */
export function symbolLines(content: string, symbol: string): number[] {
  const bare = symbol.trim().replace(/^(['"`])(.*)\1$/, '$2').trim();
  const candidates = new Set([bare, bare.split(/\.|::|#/).filter(Boolean).at(-1) ?? '']);
  const lines = new Set<number>();
  let lineStarts: number[] | undefined;
  for (const candidate of candidates) {
    if (!candidate) continue;
    const pattern = new RegExp(`(?<![\\w$])${escapeRegExp(candidate)}(?![\\w$])`, 'g');
    for (const match of content.matchAll(pattern)) {
      const before = content[match.index - 1];
      const after = content[match.index + candidate.length];
      if (before && before === after && QUOTES.has(before)) continue;
      lineStarts ??= startsOfLines(content);
      lines.add(lineAt(lineStarts, match.index));
    }
  }
  return [...lines].sort((a, b) => a - b);
}

const QUOTES = new Set(['"', "'", '`']);

function startsOfLines(content: string): number[] {
  const starts = [0];
  for (let i = content.indexOf('\n'); i >= 0; i = content.indexOf('\n', i + 1)) starts.push(i + 1);
  return starts;
}

function lineAt(starts: number[], index: number): number {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid]! <= index) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
