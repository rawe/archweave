import fsp from 'node:fs/promises';
import type { CodeRef, Model, StaleLink } from '../shared/model.ts';
import { countLines, MAX_FILE_BYTES, PathError, type Repo } from './repo.ts';

interface FileFacts {
  mtimeMs: number;
  exists: boolean;
  isFile: boolean;
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
    const missing: FileFacts = { mtimeMs: 0, exists: false, isFile: false, lineCount: 0, content: '' };
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
    const content = info.size <= MAX_FILE_BYTES ? await fsp.readFile(info.absolute, 'utf8') : '';
    const fresh = { mtimeMs: info.mtimeMs, exists: true, isFile: true, lineCount: countLines(content), content };
    this.cache.set(info.absolute, fresh);
    return fresh;
  }
}

function staleReason(ref: CodeRef, file: FileFacts): StaleLink['reason'] | undefined {
  if (!file.exists) return 'missing-file';
  if (!file.isFile || !file.content) return undefined;
  if ((ref.startLine && ref.startLine > file.lineCount) || (ref.endLine && ref.endLine > file.lineCount)) return 'line-out-of-range';
  if (ref.symbol && !containsSymbol(file.content, ref.symbol)) return 'symbol-not-found';
  return undefined;
}

/** Whole-word match; for qualified names ("Store.apply", "Foo::bar") the last segment is enough. */
export function containsSymbol(content: string, symbol: string): boolean {
  const candidates = [symbol.trim()];
  const last = symbol.split(/\.|::|#/).filter(Boolean).at(-1);
  if (last && last !== candidates[0]) candidates.push(last);
  return candidates.some((s) => s && new RegExp(`(?<![\\w$])${escapeRegExp(s)}(?![\\w$])`).test(content));
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
