import { describe, expect, it } from 'vitest';
import { MAX_PNG_EDGE, renderDiagramPng } from '../src/server/render.ts';
import { Model } from '../src/shared/model.ts';

/** Width and height from the PNG header. */
function size(png: Uint8Array): { w: number; h: number } {
  const view = new DataView(png.buffer, png.byteOffset);
  return { w: view.getUint32(16), h: view.getUint32(20) };
}

const box = (id: string, x: number, y: number) => ({ id, text: id, x, y, w: 120, h: 48 });

describe('png size', () => {
  it('keeps a far-flung diagram within the edge limit whatever scale is asked for', async () => {
    const model = Model.parse({ diagrams: [{ id: 'wide', name: 'Wide', shapes: [box('a', 0, 0), box('b', 6000, 5000)] }] });
    const { w, h } = size((await renderDiagramPng(model, 'wide', { scale: 4 }))!);
    expect(Math.max(w, h)).toBeLessThanOrEqual(MAX_PNG_EDGE);
    expect(Math.max(w, h)).toBeGreaterThan(MAX_PNG_EDGE - 40);
  });

  it('honours a scale below one', async () => {
    const model = Model.parse({ diagrams: [{ id: 'small', name: 'Small', shapes: [box('a', 0, 0), box('b', 1000, 0)] }] });
    const { w } = size((await renderDiagramPng(model, 'small', { scale: 0.1 }))!);
    expect(w).toBeLessThan(200);
  });
});
