import fsp from 'node:fs/promises';
import type { CodeRef, Model, StaleLink } from '../shared/model.ts';
import { countLines, MAX_FILE_BYTES, PathError, type Repo } from './repo.ts';

interface FileFacts {
  mtimeMs: number;
  exists: boolean;
  isFile: boolean;
  /** Larger than MAX_FILE_BYTES: only existence is checked. */
  tooLarge: boolean;
  lineCount: number;
  content: string;
}

export interface OwnedRef {
  ownerType: StaleLink['ownerType'];
  ownerId: string;
  ref: CodeRef;
}

/** Every code ref in the model with the element, relation or flow that holds it. */
export function allCodeRefs(model: Model): OwnedRef[] {
  const out: OwnedRef[] = [];
  for (const e of model.elements) for (const ref of e.codeRefs) out.push({ ownerType: 'element', ownerId: e.id, ref });
  for (const r of model.relations) for (const ref of r.codeRefs) out.push({ ownerType: 'relation', ownerId: r.id, ref });
  for (const f of model.flows) for (const step of f.steps) for (const ref of step.codeRefs) out.push({ ownerType: 'flow', ownerId: f.id, ref });
  return out;
}

/** Finds code refs that no longer match the repository. File facts are cached by mtime. */
export class StaleLinks {
  private cache = new Map<string, FileFacts>();

  constructor(private repo: Repo) {}

  async check(model: Model): Promise<StaleLink[]> {
    return this.checkRefs(allCodeRefs(model));
  }

  async checkRefs(refs: OwnedRef[]): Promise<StaleLink[]> {
    const facts = new Map<string, FileFacts>();
    await Promise.all([...new Set(refs.map((r) => r.ref.path))].map(async (p) => facts.set(p, await this.facts(p))));
    const out: StaleLink[] = [];
    for (const owned of refs) {
      const reason = staleReason(owned.ref, facts.get(owned.ref.path)!);
      if (reason) out.push({ ...owned, reason });
    }
    return out;
  }

  private async facts(refPath: string): Promise<FileFacts> {
    const missing: FileFacts = { mtimeMs: 0, exists: false, isFile: false, tooLarge: false, lineCount: 0, content: '' };
    let info;
    try {
      info = await this.repo.info(refPath);
    } catch (error) {
      if (error instanceof PathError) return missing;
      throw error;
    }
    if (!info) return missing;
    if (!info.isFile) return { ...missing, exists: true, mtimeMs: info.mtimeMs };
    const cached = this.cache.get(info.absolute);
    if (cached && cached.mtimeMs === info.mtimeMs) return cached;
    const tooLarge = info.size > MAX_FILE_BYTES;
    const content = tooLarge ? '' : await fsp.readFile(info.absolute, 'utf8');
    const fresh = { mtimeMs: info.mtimeMs, exists: true, isFile: true, tooLarge, lineCount: countLines(content), content };
    this.cache.set(info.absolute, fresh);
    return fresh;
  }
}

function staleReason(ref: CodeRef, file: FileFacts): StaleLink['reason'] | undefined {
  if (!file.exists) return 'missing-file';
  if (!file.isFile || file.tooLarge) return undefined;
  if ((ref.startLine && ref.startLine > file.lineCount) || (ref.endLine && ref.endLine > file.lineCount)) return 'line-out-of-range';
  if (!ref.symbol) return undefined;
  const lines = symbolLines(file.content, ref.symbol);
  if (!lines.length) return 'symbol-not-found';
  if (ref.startLine) {
    const end = ref.endLine ?? ref.startLine;
    const [from, to] = [Math.min(ref.startLine, end), Math.max(ref.startLine, end)];
    if (!lines.some((line) => line >= from && line <= to)) return 'symbol-outside-range';
  }
  return undefined;
}

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
