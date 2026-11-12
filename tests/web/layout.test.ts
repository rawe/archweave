import { describe, expect, it } from 'vitest';
import { freeSpot, layoutAll, looksAutoPlaced, placeMissing, separate } from '../../src/web/lib/layout.ts';

const overlaps = (a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }) =>
  a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;

describe('layout', () => {
  it('lays out a chain left to right from a fixed origin', async () => {
    const nodes = ['a', 'b', 'c'].map((id) => ({ id, width: 200, height: 60 }));
    const pos = await layoutAll(nodes, [
      { from: 'a', to: 'b' },
      { from: 'b', to: 'c' },
    ]);
    expect(Math.min(...Object.values(pos).map((p) => p.x))).toBe(40);
    expect(Math.min(...Object.values(pos).map((p) => p.y))).toBe(40);
    expect(pos.a!.x).toBeLessThan(pos.b!.x);
    expect(pos.b!.x).toBeLessThan(pos.c!.x);
  });

  it('never moves placed nodes and puts new ones where nothing overlaps', async () => {
    const nodes = ['a', 'b', 'c', 'd'].map((id) => ({ id, width: 200, height: 60 }));
    const fixed = { a: { x: 500, y: 300 }, b: { x: 800, y: 300 } };
    const placed = await placeMissing(nodes, [{ from: 'a', to: 'c' }, { from: 'b', to: 'd' }], fixed);
    expect(Object.keys(placed).sort()).toEqual(['c', 'd']);
    const rects = [
      ...Object.entries(fixed).map(([, p]) => ({ ...p, w: 200, h: 60 })),
      ...Object.values(placed).map((p) => ({ ...p, w: 200, h: 60 })),
    ];
    for (let i = 0; i < rects.length; i++) for (let j = i + 1; j < rects.length; j++) expect(overlaps(rects[i]!, rects[j]!)).toBe(false);
  });

  it('freeSpot returns the wanted spot when it is free and moves otherwise', () => {
    const want = { x: 0, y: 0, w: 100, h: 40 };
    expect(freeSpot(want, [])).toEqual(want);
    const moved = freeSpot(want, [{ x: 0, y: 0, w: 100, h: 40 }]);
    expect(overlaps(moved, { x: 0, y: 0, w: 100, h: 40 })).toBe(false);
  });

  it('puts callers on the left rim and callees on the right, close to the inside', async () => {
    const nodes = [
      { id: 'caller', width: 120, height: 26, rim: 'left' as const },
      { id: 'a', width: 188, height: 60 },
      { id: 'b', width: 188, height: 60 },
      { id: 'callee', width: 120, height: 26, rim: 'right' as const },
    ];
    const pos = await layoutAll(nodes, [
      { from: 'caller', to: 'a' },
      { from: 'a', to: 'b' },
      { from: 'b', to: 'callee' },
    ]);
    const insideLeft = Math.min(pos.a!.x, pos.b!.x);
    const insideRight = Math.max(pos.a!.x, pos.b!.x) + 188;
    expect(pos.caller!.x + 120).toBeLessThan(insideLeft);
    expect(pos.callee!.x).toBeGreaterThan(insideRight);
    // Compact: the rim sits one small gap away, not a whole column.
    expect(insideLeft - (pos.caller!.x + 120)).toBeLessThanOrEqual(60);
    expect(pos.callee!.x - insideRight).toBeLessThanOrEqual(60);
  });

  it('is deterministic', async () => {
    const nodes = ['a', 'b', 'c', 'd'].map((id) => ({ id, width: 188, height: 60 }));
    const edges = [
      { from: 'a', to: 'b' },
      { from: 'a', to: 'c' },
      { from: 'c', to: 'd' },
    ];
    expect(await layoutAll(nodes, edges)).toEqual(await layoutAll(nodes, edges));
  });

  it('recognizes layouts written by the earlier auto-layout, not hand-arranged or new ones', async () => {
    const old = { a: { x: 0, y: 33 }, b: { x: 0, y: 156 }, c: { x: 316, y: 0 }, d: { x: 316, y: 122 }, e: { x: 632, y: 40 } };
    expect(looksAutoPlaced(old)).toBe(true);
    expect(looksAutoPlaced({ ...old, a: { x: 12, y: 47 } })).toBe(false);
    expect(looksAutoPlaced({ a: { x: 102, y: 255 }, b: { x: 262, y: 527 }, c: { x: 279, y: -28 }, d: { x: 640, y: 291 } })).toBe(false);
    expect(looksAutoPlaced(undefined)).toBe(false);
    const fresh = await layoutAll(
      ['a', 'b', 'c', 'd', 'e'].map((id) => ({ id, width: 188, height: 60 })),
      [
        { from: 'a', to: 'b' },
        { from: 'a', to: 'c' },
        { from: 'b', to: 'd' },
        { from: 'c', to: 'e' },
      ],
    );
    expect(looksAutoPlaced(fresh)).toBe(false);
  });

  it('separate keeps stored positions and only moves nodes that grew into others', () => {
    const sizes = new Map([
      ['a', { width: 200, height: 120 }],
      ['b', { width: 200, height: 80 }],
      ['c', { width: 200, height: 80 }],
    ]);
    const shown = separate({ a: { x: 0, y: 0 }, b: { x: 0, y: 100 }, c: { x: 400, y: 50 } }, sizes);
    expect(shown.a).toEqual({ x: 0, y: 0 });
    expect(shown.c).toEqual({ x: 400, y: 50 });
    expect(shown.b).toEqual({ x: 0, y: 136 });
  });
});
