/**
 * Pure helpers for code refs as the UI sends them back to the server.
 *
 * The server seals refs (`digest`) and keeps a seal only when a ref comes back with the same
 * location and digest it was read with. So the UI always resends refs it did not edit exactly as
 * read, digest included, and drops the digest of a ref whose location it changed so the server
 * seals it afresh against the current text.
 */
import type { CodeRef, LineRange, StaleLink } from '../../shared/model.ts';

type Location = Pick<CodeRef, 'path' | 'symbol' | 'startLine' | 'endLine'>;

/** Same file, symbol and line range: the server's notion of "the same ref". */
export function sameLocation(a: Location, b: Location): boolean {
  return a.path === b.path && a.symbol === b.symbol && a.startLine === b.startLine && a.endLine === b.endLine;
}

/**
 * The ref with `change` applied. When the path, symbol or line range changes, the old seal no
 * longer describes the linked text, so the digest is dropped; any other edit (a note) keeps it.
 * Keys set to `undefined` are removed.
 */
export function editRef(ref: CodeRef, change: Partial<Omit<CodeRef, 'digest'>>): CodeRef {
  const next: CodeRef = { ...ref, ...change };
  for (const key of Object.keys(next) as (keyof CodeRef)[]) if (next[key] === undefined) delete next[key];
  if (!sameLocation(ref, next)) delete next.digest;
  return next;
}

/** The ref pointed at `range`, written the way the server's repair writes it (single-line refs stay without `endLine`). */
export function withRange(ref: CodeRef, range: LineRange): CodeRef {
  const single = ref.endLine === undefined && range.startLine === range.endLine;
  return editRef(ref, { startLine: range.startLine, endLine: single ? undefined : range.endLine });
}

/** `refs` with the ref at `target`'s location replaced by `next`; the others are returned untouched. */
export function replaceRef(refs: CodeRef[], target: Location, next: CodeRef): CodeRef[] {
  return refs.map((r) => (sameLocation(r, target) ? next : r));
}

/** Where a ref lives: the owner, and for flows the 1-based step. */
export interface RefOwner {
  type: StaleLink['ownerType'];
  id: string;
  step?: number;
}

/** The stale entry for this ref of this owner, if any. */
export function staleFor(stale: StaleLink[], owner: RefOwner, ref: CodeRef): StaleLink | undefined {
  return stale.find(
    (s) => s.ownerType === owner.type && s.ownerId === owner.id && (owner.type !== 'flow' || s.step === owner.step) && sameLocation(s.ref, ref),
  );
}

/** Two stale entries name the same ref of the same owner. */
export function sameLink(a: StaleLink, b: StaleLink): boolean {
  return a.ownerType === b.ownerType && a.ownerId === b.ownerId && a.step === b.step && sameLocation(a.ref, b.ref);
}

/** Stale links grouped by file, files in path order, links within a file by line. */
export function groupByFile(stale: StaleLink[]): { path: string; links: StaleLink[] }[] {
  const files = new Map<string, StaleLink[]>();
  for (const s of stale) files.set(s.ref.path, [...(files.get(s.ref.path) ?? []), s]);
  return [...files]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([path, links]) => ({ path, links: [...links].sort((a, b) => (a.ref.startLine ?? 0) - (b.ref.startLine ?? 0)) }));
}
