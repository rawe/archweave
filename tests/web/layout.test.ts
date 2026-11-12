import { describe, expect, it } from 'vitest';
import { freeSpot, layoutAll, placeMissing } from '../../src/web/lib/layout.ts';

const overlaps = (a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }) =>
  a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;

describe('layout', () => {
  it('lays out a chain left to right from the origin', async () => {
    const nodes = ['a', 'b', 'c'].map((id) => ({ id, width: 200, height: 60 }));
    const pos = await layoutAll(nodes, [
      { from: 'a', to: 'b' },
      { from: 'b', to: 'c' },
    ]);
    expect(Math.min(...Object.values(pos).map((p) => p.x))).toBe(0);
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
});
