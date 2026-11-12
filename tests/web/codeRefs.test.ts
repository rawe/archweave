import { describe, expect, it } from 'vitest';
import type { StaleLink } from '../../src/shared/model.ts';
import { editRef, groupByFile, replaceRef, staleFor, withRange } from '../../src/web/lib/codeRefs.ts';

const sealed = { path: 'src/a.ts', symbol: 'run', startLine: 10, endLine: 14, digest: 'abc123', note: 'entry' };

describe('editRef', () => {
  it('keeps the seal when the location does not change', () => {
    expect(editRef(sealed, { note: 'the entry point' })).toEqual({ ...sealed, note: 'the entry point' });
    expect(editRef(sealed, {})).toEqual(sealed);
  });

  it('drops the seal when the path, symbol or range changes', () => {
    expect(editRef(sealed, { path: 'src/b.ts' }).digest).toBeUndefined();
    expect(editRef(sealed, { symbol: 'start' }).digest).toBeUndefined();
    expect(editRef(sealed, { symbol: undefined }).digest).toBeUndefined();
    expect(editRef(sealed, { startLine: 11 }).digest).toBeUndefined();
    expect(editRef(sealed, { endLine: 15 }).digest).toBeUndefined();
  });

  it('removes keys set to undefined instead of sending them', () => {
    const next = editRef(sealed, { symbol: undefined, note: undefined });
    expect(Object.keys(next).sort()).toEqual(['endLine', 'path', 'startLine']);
  });
});

describe('withRange', () => {
  it('moves the range, keeps the rest and drops the seal', () => {
    expect(withRange(sealed, { startLine: 20, endLine: 24 })).toEqual({ path: 'src/a.ts', symbol: 'run', startLine: 20, endLine: 24, note: 'entry' });
  });

  it('keeps a single-line ref without an end line', () => {
    expect(withRange({ path: 'a.ts', startLine: 3, digest: 'x' }, { startLine: 7, endLine: 7 })).toEqual({ path: 'a.ts', startLine: 7 });
    expect(withRange({ path: 'a.ts', startLine: 3, endLine: 3, digest: 'x' }, { startLine: 7, endLine: 7 })).toEqual({ path: 'a.ts', startLine: 7, endLine: 7 });
  });

  it('is a no-op on the seal when the range is the same', () => {
    expect(withRange(sealed, { startLine: 10, endLine: 14 })).toEqual(sealed);
  });
});

describe('replaceRef', () => {
  it('replaces only the matching ref and leaves the others exactly as read', () => {
    const other = { path: 'src/b.ts', startLine: 1, endLine: 2, digest: 'keep' };
    const refs = [other, sealed];
    const next = replaceRef(refs, sealed, withRange(sealed, { startLine: 30, endLine: 34 }));
    expect(next[0]).toBe(other);
    expect(next[1]).toEqual({ path: 'src/a.ts', symbol: 'run', startLine: 30, endLine: 34, note: 'entry' });
  });
});

describe('stale links', () => {
  const link = (over: Partial<StaleLink>): StaleLink => ({ ownerType: 'element', ownerId: 'api', ref: { path: 'src/a.ts', startLine: 1 }, reason: 'moved', ...over });

  it('matches a ref by owner, step and location', () => {
    const stale = [link({ ownerType: 'flow', ownerId: 'checkout', step: 2, ref: sealed })];
    expect(staleFor(stale, { type: 'flow', id: 'checkout', step: 2 }, sealed)).toBe(stale[0]);
    expect(staleFor(stale, { type: 'flow', id: 'checkout', step: 1 }, sealed)).toBeUndefined();
    expect(staleFor(stale, { type: 'element', id: 'checkout' }, sealed)).toBeUndefined();
  });

  it('groups by file in path order and sorts by line', () => {
    const groups = groupByFile([
      link({ ref: { path: 'src/z.ts', startLine: 9 } }),
      link({ ref: { path: 'src/a.ts', startLine: 40 } }),
      link({ ref: { path: 'src/a.ts', startLine: 4 } }),
    ]);
    expect(groups.map((g) => g.path)).toEqual(['src/a.ts', 'src/z.ts']);
    expect(groups[0]!.links.map((l) => l.ref.startLine)).toEqual([4, 40]);
  });
});
