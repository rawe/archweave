import { describe, expect, it } from 'vitest';
import { diagramLints } from '../src/shared/diagram/lints.ts';
import { Diagram, Model } from '../src/shared/model.ts';

const MODEL = Model.parse({ elements: [{ id: 'api', kind: 'service', name: 'Order API' }] });

const box = (id: string, x: number, y: number, more: object = {}) => ({ id, text: id.toUpperCase(), x, y, w: 120, h: 48, ...more });

/** A clean, hand-arranged diagram: a group with two connected boxes, a store below, a linked shape and a note. */
const CLEAN = {
  id: 'clean',
  name: 'Clean',
  shapes: [
    { id: 'zone', kind: 'group', text: 'Zone', x: 0, y: 0, w: 400, h: 160 },
    box('a', 24, 72, { parent: 'zone' }),
    box('b', 256, 72, { parent: 'zone' }),
    { id: 'db', kind: 'cylinder', text: 'DB', x: 256, y: 280, w: 120, h: 72 },
    { id: 'svc', link: { type: 'element', id: 'api' }, x: 520, y: 72, w: 120, h: 48 },
    { id: 'memo', kind: 'note', text: 'Fine', x: 520, y: 280, w: 120, h: 40 },
    { id: 'title', kind: 'text', text: '', x: 0, y: -60, w: 80, h: 24 },
  ],
  connectors: [
    { id: 'a-b', from: 'a', to: 'b', label: 'calls' },
    { id: 'b-db', from: 'b', to: 'db', label: 'writes' },
    { id: 'b-svc', from: 'b', to: 'svc' },
  ],
};

function lint(patch: (d: typeof CLEAN) => object = (d) => d) {
  return diagramLints(Diagram.parse(patch(structuredClone(CLEAN))), MODEL);
}

describe('diagramLints', () => {
  it('finds nothing on a well-arranged diagram', () => {
    expect(lint()).toEqual([]);
  });

  it('reports shapes that overlap, but not a group and what it holds', () => {
    const lints = lint((d) => ({ ...d, shapes: [...d.shapes, box('c', 560, 90)] }));
    expect(lints).toEqual([expect.objectContaining({ code: 'overlap', ids: ['svc', 'c'] })]);
    expect(lints[0]!.message).toMatch(/`svc` and `c` overlap; move one/);
  });

  it('reports a shape sticking out of its group', () => {
    const lints = lint((d) => ({ ...d, shapes: d.shapes.map((s) => (s.id === 'b' ? { ...s, x: 320 } : s)) }));
    expect(lints).toEqual([expect.objectContaining({ code: 'outside-group', ids: ['b', 'zone'] })]);
  });

  it('reports a line running through a shape that is not one of its ends', () => {
    // Elbows detour around shapes; a straight line cannot.
    const lints = lint((d) => ({ ...d, connectors: [...d.connectors, { id: 'a-svc', from: 'a', to: 'svc', route: 'straight' }] }));
    expect(lints).toEqual([expect.objectContaining({ code: 'crosses-shape', ids: ['a-svc', 'b'] })]);
    expect(lints[0]!.message).toMatch(/runs through or along `b`/);
  });

  it('reports a line running along the edge of a shape, not one passing at a distance', () => {
    const along = (top: number) =>
      diagramLints(
        Diagram.parse({ id: 'd', name: 'D', direction: 'right', shapes: [box('p', 0, 0), box('q', 480, 0), box('r', 200, top)], connectors: [{ id: 'p-q', from: 'p', to: 'q', route: 'straight' }] }),
        MODEL,
      );
    expect(along(26)).toEqual([expect.objectContaining({ code: 'crosses-shape', ids: ['p-q', 'r'] })]);
    expect(along(36)).toEqual([]);
  });

  it('reports a label covering another label, a shape or a line, but not the trunk of its own fan', () => {
    // A short straight line beside a tall shape: every place along it for the label is covered.
    const covered = diagramLints(
      Diagram.parse({
        id: 'd',
        name: 'D',
        shapes: [box('p', 0, 0), box('q', 0, 160), box('d', 80, 52, { h: 72 })],
        connectors: [{ id: 'a-c', from: 'p', to: 'q', label: 'a label wide enough to reach', route: 'straight' }],
      }),
      MODEL,
    );
    expect(covered).toContainEqual(expect.objectContaining({ code: 'label-overlap', ids: ['a-c', 'd'] }));
    expect(covered.find((l) => l.code === 'label-overlap')!.message).toMatch(/The label of connector `a-c` covers `d`/);
    const labels = lint((d) => ({
      ...d,
      shapes: [...d.shapes, box('c', 24, 400), box('e', 200, 400)],
      connectors: [...d.connectors, { id: 'a-c', from: 'a', to: 'c', label: 'a long label on the left' }, { id: 'a-e', from: 'a', to: 'e', label: 'a long label on the right' }],
    }));
    expect(labels.map((l) => l.code)).toContain('label-overlap');
  });

  it('reports text that does not fit its shape, with the size it needs', () => {
    const lints = lint((d) => ({ ...d, shapes: d.shapes.map((s) => (s.id === 'memo' ? { ...s, text: 'A much longer note that cannot possibly fit into this small shape at all' } : s)) }));
    expect(lints).toEqual([expect.objectContaining({ code: 'text-overflow', ids: ['memo'] })]);
    expect(lints[0]!.message).toMatch(/does not fit its 120×40; make it at least \d+×\d+ or shorten the text/);
  });

  it('reports doubled connectors and empty shapes', () => {
    const lints = lint((d) => ({
      ...d,
      shapes: [...d.shapes, box('blank', 520, 400, { text: '' })],
      connectors: [...d.connectors, { id: 'a-b-again', from: 'a', to: 'b', label: 'calls' }, { id: 'b-a', from: 'b', to: 'a', label: 'calls' }].map((c) => ({ ...c, label: '' })),
    }));
    expect(lints.map((l) => [l.code, l.ids])).toEqual([
      ['duplicate-connector', ['a-b', 'a-b-again']],
      ['empty-shape', ['blank']],
    ]);
  });

  it('asks to split a diagram with too many shapes', () => {
    const lints = lint((d) => ({ ...d, shapes: [...d.shapes, ...Array.from({ length: 40 }, (_, i) => box(`n${i}`, (i % 8) * 160, 600 + Math.floor(i / 8) * 100))] }));
    expect(lints).toEqual([expect.objectContaining({ code: 'too-many-shapes', ids: [] })]);
    expect(lints[0]!.message).toMatch(/47 shapes.*split it/);
  });
});
