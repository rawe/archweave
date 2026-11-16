import { describe, expect, it } from 'vitest';
import { isValidElement, type ReactElement } from 'react';
import { Diagram } from '../../src/shared/model.ts';
import { clipText, copyShapes, parseClip, pasteShapes } from '../../src/web/diagrams/clipboard.ts';
import { descendants, groupAt, midpoint, outermost, resizeBox, snapMove } from '../../src/web/diagrams/geometry.ts';
import { paintElement, reactAttrs } from '../../src/web/diagrams/Paint.tsx';

const diagram = Diagram.parse({
  id: 'd',
  name: 'D',
  shapes: [
    { id: 'zone', kind: 'group', text: 'Zone', x: 0, y: 0, w: 400, h: 300 },
    { id: 'inner', kind: 'group', text: 'Inner', parent: 'zone', x: 20, y: 40, w: 200, h: 200 },
    { id: 'a', text: 'A', parent: 'inner', x: 40, y: 80, w: 112, h: 48 },
    { id: 'b', text: 'B', parent: 'zone', x: 260, y: 80, w: 112, h: 48 },
    { id: 'c', text: 'C', x: 500, y: 80, w: 112, h: 48 },
    { id: 'c-2', text: 'C again', x: 500, y: 200, w: 112, h: 48 },
  ],
  connectors: [
    { id: 'a-to-b', from: 'a', to: 'b' },
    { id: 'b-to-c', from: 'b', to: 'c', label: 'out' },
  ],
});

describe('moving', () => {
  it('snaps to the grid when nothing lines up', () => {
    expect(snapMove({ x: 13, y: 21, w: 100, h: 40 }, [], 6)).toEqual({ dx: 3, dy: 3, guides: [] });
  });

  it('lines up with the edges and centres of other shapes, with guides spanning both', () => {
    const other = { x: 200, y: 0, w: 100, h: 40 };
    const fit = snapMove({ x: 197, y: 100, w: 100, h: 40 }, [other], 6);
    expect(fit.dx).toBe(3);
    expect(fit.dy).toBe(4);
    expect(fit.guides).toContainEqual({ axis: 'x', at: 200, from: 0, to: 140 });
    expect(fit.guides).toContainEqual({ axis: 'x', at: 250, from: 0, to: 140 });
    expect(fit.guides.every((g) => g.axis === 'x')).toBe(true);
  });

  it('prefers the nearest alignment', () => {
    const fit = snapMove({ x: 3, y: 50, w: 100, h: 40 }, [{ x: 0, y: 0, w: 200, h: 10 }, { x: 54, y: 0, w: 2, h: 10 }], 6);
    expect(fit.dx).toBe(1);
  });
});

describe('resizing', () => {
  const min = () => ({ w: 56, h: 32 });
  it('moves the dragged edges onto the grid and keeps the opposite ones', () => {
    expect(resizeBox({ x: 8, y: 8, w: 112, h: 48 }, 'se', 21, 13, min)).toEqual({ x: 8, y: 8, w: 136, h: 64 });
    expect(resizeBox({ x: 8, y: 8, w: 112, h: 48 }, 'nw', -13, -3, min)).toEqual({ x: -8, y: 8, w: 128, h: 48 });
  });

  it('never gets smaller than the text needs: width first, then the height for that width', () => {
    const textual = (w: number) => ({ w: 56, h: w < 100 ? 80 : 32 });
    expect(resizeBox({ x: 0, y: 0, w: 112, h: 48 }, 'w', 100, 0, textual)).toEqual({ x: 56, y: 0, w: 56, h: 80 });
    expect(resizeBox({ x: 0, y: 0, w: 112, h: 48 }, 'n', 0, 40, min)).toEqual({ x: 0, y: 16, w: 112, h: 32 });
  });
});

describe('groups', () => {
  it('finds the innermost group under a point, leaving out the moving shapes', () => {
    expect(groupAt({ x: 60, y: 100 }, diagram.shapes)).toBe('inner');
    expect(groupAt({ x: 300, y: 100 }, diagram.shapes)).toBe('zone');
    expect(groupAt({ x: 60, y: 100 }, diagram.shapes, new Set(['inner']))).toBe('zone');
    expect(groupAt({ x: 520, y: 100 }, diagram.shapes)).toBeUndefined();
  });

  it('knows what is inside, at any depth, and which selected shapes are outermost', () => {
    expect([...descendants(diagram.shapes, ['zone'])].sort()).toEqual(['a', 'b', 'inner']);
    expect(outermost(diagram.shapes, ['a', 'inner', 'c'])).toEqual(['inner', 'c']);
  });

  it('finds the middle of a line', () => {
    expect(midpoint([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 30 }])).toEqual({ x: 10, y: 10 });
  });
});

describe('copy and paste', () => {
  it('copies groups with their content and the lines among the copied shapes', () => {
    const clip = copyShapes(diagram, ['inner', 'b'])!;
    expect(clip.shapes.map((s) => s.id)).toEqual(['inner', 'a', 'b']);
    expect(clip.shapes.find((s) => s.id === 'inner')!.parent).toBeUndefined();
    expect(clip.shapes.find((s) => s.id === 'a')!.parent).toBe('inner');
    expect(clip.connectors.map((c) => c.id)).toEqual(['a-to-b']);
    expect(copyShapes(diagram, ['a-to-b'])).toBeUndefined();
  });

  it('pastes with fresh ids, parents and line ends following, shifted', () => {
    const clip = copyShapes(diagram, ['b', 'c', 'b-to-c'])!;
    const taken = [...diagram.shapes, ...diagram.connectors].map((s) => s.id);
    const { shapes, connectors } = pasteShapes(clip, taken, { x: 16, y: 16 });
    expect(shapes.map((s) => [s.id, s.x, s.y])).toEqual([
      ['b-2', 276, 96],
      ['c-3', 516, 96],
    ]);
    expect(connectors).toEqual([{ id: 'b-to-c-2', from: 'b-2', to: 'c-3', label: 'out' }]);
    const nested = pasteShapes(copyShapes(diagram, ['inner'])!, taken, { x: 0, y: 0 });
    expect(nested.shapes.find((s) => s.text === 'A')!.parent).toBe(nested.shapes.find((s) => s.text === 'Inner')!.id);
  });

  it('round-trips through clipboard text and ignores other text', () => {
    const clip = copyShapes(diagram, ['c'])!;
    expect(parseClip(clipText(clip))).toEqual(clip);
    expect(parseClip('just words')).toBeUndefined();
    expect(parseClip('{"type":"archweave/shapes","shapes":[{"id":"BAD"}],"connectors":[]}')).toBeUndefined();
  });
});

describe('painting', () => {
  it('maps SVG attribute names to the ones React expects', () => {
    expect(reactAttrs({ 'stroke-width': 1.5, 'text-anchor': 'middle', 'fill-opacity': 0.1, class: 'x', d: 'M0,0', rx: 4 })).toEqual({
      strokeWidth: 1.5,
      textAnchor: 'middle',
      fillOpacity: 0.1,
      className: 'x',
      d: 'M0,0',
      rx: 4,
    });
  });

  it('builds the element tree with text and children', () => {
    const el = paintElement({ tag: 'g', attrs: { transform: 'translate(1 2)' }, children: [{ tag: 'text', attrs: { 'font-size': 12 }, text: 'Hi' }] }, 0) as ReactElement<{
      transform: string;
      children: ReactElement<{ fontSize: number; children: string }>[];
    }>;
    expect(isValidElement(el)).toBe(true);
    expect(el.type).toBe('g');
    expect(el.props.transform).toBe('translate(1 2)');
    expect(el.props.children[0]!.props).toEqual({ fontSize: 12, children: 'Hi' });
  });
});
