import { describe, expect, it } from 'vitest';
import { Position } from '@xyflow/react';
import { assignPorts, facingSides } from '../../src/web/lib/ports.ts';

const rect = (x: number, y: number, width = 100, height = 60) => ({ x, y, width, height });

describe('ports', () => {
  it('attaches on the sides that face each other', () => {
    expect(facingSides(rect(0, 0), rect(200, 300))).toEqual([Position.Right, Position.Left]);
    expect(facingSides(rect(200, 0), rect(0, 10))).toEqual([Position.Left, Position.Right]);
    expect(facingSides(rect(0, 0), rect(10, 200))).toEqual([Position.Bottom, Position.Top]);
  });

  it('spreads threads sharing a side in the order of their other ends', () => {
    const rects = new Map([
      ['a', rect(0, 100)],
      ['top', rect(300, 0)],
      ['mid', rect(300, 100)],
      ['low', rect(300, 220)],
    ]);
    const routes = assignPorts(rects, [
      { id: 'a-low', from: 'a', to: 'low' },
      { id: 'a-top', from: 'a', to: 'top' },
      { id: 'a-mid', from: 'a', to: 'mid' },
    ]);
    const ys = ['a-top', 'a-mid', 'a-low'].map((id) => routes.get(id)!.source.y);
    expect(ys[0]).toBeLessThan(ys[1]!);
    expect(ys[1]).toBeLessThan(ys[2]!);
    for (const id of ['a-top', 'a-mid', 'a-low']) {
      expect(routes.get(id)!.source).toMatchObject({ x: 100, side: Position.Right });
      expect(routes.get(id)!.target).toMatchObject({ x: 300, side: Position.Left });
    }
    for (const y of ys) {
      expect(y).toBeGreaterThan(100);
      expect(y).toBeLessThan(160);
    }
  });
});
