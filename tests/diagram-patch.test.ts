import { describe, expect, it } from 'vitest';
import { fitShape } from '../src/shared/diagram/fit.ts';
import { applyDiagramPatch, diagramProblems, repairDiagram, unlinkLost } from '../src/shared/diagram/patch.ts';
import { Diagram, type DiagramPatch, Model } from '../src/shared/model.ts';

const MODEL = Model.parse({
  elements: [
    { id: 'api', kind: 'service', name: 'Order API' },
    { id: 'db', kind: 'store', name: 'Orders DB' },
  ],
  flows: [{ id: 'buy', name: 'Buy' }],
  diagrams: [{ id: 'other', name: 'Other' }],
});

const box = (id: string, x: number, y: number, more: object = {}) => ({ id, x, y, w: 120, h: 48, ...more });

/** A group holding two connected boxes, and a loose note. */
const BASE = Diagram.parse({
  id: 'overview',
  name: 'Overview',
  shapes: [
    { ...box('zone', 0, 0), kind: 'group', w: 400, h: 200, text: 'Zone' },
    box('a', 16, 40, { text: 'A', parent: 'zone', tone: 'blue', detail: 'first' }),
    box('b', 200, 40, { text: 'B', parent: 'zone' }),
    box('memo', 0, 240, { kind: 'note', text: 'Remember' }),
  ],
  connectors: [{ id: 'a-to-b', from: 'a', to: 'b', label: 'calls', line: 'dashed' }],
});

function apply(patch: DiagramPatch, existing: Diagram | null = BASE) {
  return applyDiagramPatch(existing ?? undefined, patch, { id: 'overview', model: MODEL });
}

function ok(patch: DiagramPatch, existing: Diagram | null = BASE): Diagram {
  const result = apply(patch, existing);
  expect(result.errors).toEqual([]);
  expect(diagramProblems(result.diagram!, MODEL)).toEqual([]);
  return result.diagram!;
}

const shape = (diagram: Diagram, id: string) => diagram.shapes.find((s) => s.id === id)!;

describe('applyDiagramPatch', () => {
  it('creates a diagram with generated ids, fitted sizes and the given geometry rounded to one decimal', () => {
    const diagram = ok(
      {
        name: 'Checkout',
        summary: 'How an order is placed.',
        direction: 'right',
        shapes: [
          { text: 'Web app', x: 10.04, y: 20.06 },
          { link: { type: 'element', id: 'api' }, x: 200, y: 20, w: 150.25, h: 60 },
          { kind: 'cylinder', x: 400, y: 20 },
          { text: 'Web app', x: 0, y: 200 },
        ],
        connectors: [{ from: 'web-app', to: 'api' }, { from: 'web-app', to: 'api', label: 'again' }],
      },
      null,
    );
    expect(diagram).toMatchObject({ id: 'overview', name: 'Checkout', summary: 'How an order is placed.', direction: 'right' });
    expect(diagram.shapes.map((s) => s.id)).toEqual(['web-app', 'api', 'cylinder', 'web-app-2']);
    expect(diagram.shapes[0]).toEqual({ id: 'web-app', kind: 'box', text: 'Web app', x: 10, y: 20.1, ...fitShape({ kind: 'box', label: 'Web app' }) });
    expect(diagram.shapes[1]).toMatchObject({ text: '', link: { type: 'element', id: 'api' }, w: 150.3, h: 60 });
    expect(diagram.connectors).toEqual([
      { id: 'web-app-to-api', from: 'web-app', to: 'api', label: '' },
      { id: 'web-app-to-api-2', from: 'web-app', to: 'api', label: 'again' },
    ]);
  });

  it('needs a name for a new diagram', () => {
    expect(apply({ shapes: [] }, null).errors).toEqual(['diagram `overview`: a new diagram needs `name`.']);
  });

  it('sizes a linked shape without text to the name it shows', () => {
    const diagram = ok({ setShapes: [{ id: 'linked', link: { type: 'element', id: 'db' }, x: 0, y: 400 }] });
    expect(shape(diagram, 'linked')).toMatchObject(fitShape({ kind: 'box', label: 'Orders DB' }));
  });

  it('puts new shapes without a position in a row below the content and reports them', () => {
    const result = apply({ setShapes: [{ id: 'n1', text: 'One', w: 100, h: 40 }, { id: 'n2', text: 'Two', x: 5 }, { id: 'a', text: 'Still A' }] });
    expect(result.errors).toEqual([]);
    expect(result.unplaced).toEqual(['n1', 'n2']);
    expect(shape(result.diagram!, 'n1')).toMatchObject({ x: 0, y: 312 });
    expect(shape(result.diagram!, 'n2')).toMatchObject({ x: 128, y: 312 });
    expect(shape(result.diagram!, 'a')).toMatchObject({ x: 16, y: 40, text: 'Still A' });

    const first = apply({ name: 'Empty', setShapes: [{ text: 'Only' }] }, null);
    expect(first.unplaced).toEqual(['only']);
    expect(first.diagram!.shapes[0]).toMatchObject({ x: 0, y: 0 });
  });

  it('changes only the given properties with setShapes and setConnectors, and clears with null', () => {
    const diagram = ok({
      setShapes: [{ id: 'a', text: 'Alpha', tone: null, detail: null, fill: 'tint' }, { id: 'b', parent: null }],
      setConnectors: [{ id: 'a-to-b', line: null, route: 'curve' }],
    });
    expect(shape(diagram, 'a')).toEqual({ id: 'a', kind: 'box', text: 'Alpha', parent: 'zone', x: 16, y: 40, w: 120, h: 48, fill: 'tint' });
    expect(shape(diagram, 'b')).toEqual({ id: 'b', kind: 'box', text: 'B', x: 200, y: 40, w: 120, h: 48 });
    expect(diagram.connectors).toEqual([{ id: 'a-to-b', from: 'a', to: 'b', label: 'calls', route: 'curve' }]);
    expect(diagram.shapes.map((s) => s.id)).toEqual(['zone', 'a', 'b', 'memo']);
    expect(BASE.shapes[1]).toMatchObject({ text: 'A', tone: 'blue' });
  });

  it('treats full-list entries as complete definitions that keep only the stored geometry they do not mention', () => {
    const diagram = ok({ shapes: [{ id: 'b', text: 'Bee' }, { id: 'a', x: 1, y: 2 }, { id: 'fresh', text: 'Fresh', x: 300, y: 300 }] });
    expect(diagram.shapes).toEqual([
      { id: 'b', kind: 'box', text: 'Bee', x: 200, y: 40, w: 120, h: 48 },
      { id: 'a', kind: 'box', text: '', x: 1, y: 2, w: 120, h: 48 },
      { id: 'fresh', kind: 'box', text: 'Fresh', x: 300, y: 300, ...fitShape({ kind: 'box', label: 'Fresh' }) },
    ]);
    expect(diagram.connectors.map((c) => c.id)).toEqual(['a-to-b']);

    const fewer = ok({ shapes: [{ id: 'a' }, { id: 'memo', kind: 'note' }] });
    expect(fewer.connectors).toEqual([]);
    expect(ok({ connectors: [{ id: 'a-to-b', from: 'b', to: 'a' }] }).connectors).toEqual([{ id: 'a-to-b', from: 'b', to: 'a', label: '' }]);
  });

  it('removes attached connectors and moves the inside of a removed group to its own parent', () => {
    const nested = ok({ setShapes: [{ id: 'outer', kind: 'group', x: -20, y: -20, w: 500, h: 300 }, { id: 'zone', parent: 'outer' }] });
    const diagram = ok({ removeShapes: ['zone', 'b'] }, nested);
    expect(diagram.shapes.map((s) => [s.id, s.parent])).toEqual([['a', 'outer'], ['memo', undefined], ['outer', undefined]]);
    expect(diagram.connectors).toEqual([]);
    expect(ok({ removeShapes: ['zone'] }).shapes.map((s) => s.parent)).toEqual([undefined, undefined, undefined]);
    expect(ok({ removeShapes: ['a'], removeConnectors: ['a-to-b'] }).connectors).toEqual([]);
  });

  it('applies full lists, then removals, then upserts', () => {
    const diagram = ok({
      shapes: [{ id: 'a', text: 'A' }, { id: 'b', text: 'B' }, { id: 'c', text: 'C', x: 0, y: 500 }],
      connectors: [{ id: 'x', from: 'a', to: 'b' }, { id: 'y', from: 'b', to: 'c' }],
      removeShapes: ['a'],
      setShapes: [{ id: 'd', text: 'D', x: 0, y: 600 }],
      setConnectors: [{ from: 'c', to: 'd' }, { id: 'y', label: 'kept' }],
    });
    expect(diagram.shapes.map((s) => s.id)).toEqual(['b', 'c', 'd']);
    expect(diagram.connectors).toEqual([
      { id: 'y', from: 'b', to: 'c', label: 'kept' },
      { id: 'c-to-d', from: 'c', to: 'd', label: '' },
    ]);
  });

  it('rejects inconsistent patches, naming the diagram and the entry', () => {
    const errors = (patch: DiagramPatch) => apply(patch).errors.join('\n');
    expect(errors({ setConnectors: [{ from: 'a' }] })).toBe('diagram `overview` setConnectors[0]: a new connector needs `from` and `to`.');
    expect(errors({ setConnectors: [{ id: 'a-to-bee', label: 'x' }] })).toBe('diagram `overview` connector `a-to-bee`: there is no connector `a-to-bee`. To create it, give `from` and `to`. Did you mean `a-to-b`?');
    expect(errors({ setConnectors: [{ from: 'a', to: 'memoo' }] })).toBe('diagram `overview` connector `a-to-memoo`: unknown shape `memoo` in `to`. Did you mean `memo`?');
    expect(errors({ setConnectors: [{ id: 'a-to-b', to: 'a' }] })).toBe('diagram `overview` connector `a-to-b`: `from` and `to` are the same shape `a`.');
    expect(errors({ setShapes: [{ id: 'memo', parent: 'zon' }] })).toBe('diagram `overview` shape `memo`: unknown parent `zon`. Did you mean `zone`?');
    expect(errors({ setShapes: [{ id: 'memo', parent: 'a' }] })).toMatch(/shape `memo`: parent `a` is a box, not a group\./);
    expect(errors({ setShapes: [{ id: 'zone', parent: 'zone' }] })).toBe('diagram `overview` shape `zone`: cannot be its own parent.');
    expect(errors({ setShapes: [{ id: 'inner', kind: 'group', parent: 'zone' }, { id: 'zone', parent: 'inner' }] })).toMatch(/shape `zone`: putting it inside `inner` creates a containment cycle/);
    expect(errors({ setShapes: [{ id: 'zone', kind: 'box' }] })).toBe(
      'diagram `overview` shape `zone`: a box cannot hold shapes, but `a`, `b` are inside it. Move them out first (`parent: null`) or keep the kind `group`.',
    );
    expect(errors({ removeShapes: ['mem'], removeConnectors: ['nope'] })).toBe(
      'diagram `overview` removeShapes: unknown shape `mem`. Did you mean `memo`?\ndiagram `overview` removeConnectors: unknown connector `nope`.',
    );
    expect(errors({ removeShapes: ['a-to-b'] })).toMatch(/`a-to-b` is a connector; name it in `removeConnectors`/);
    expect(errors({ setShapes: [{ id: 'a', link: { type: 'element', id: 'apis' } }] })).toBe('diagram `overview` shape `a`: link: unknown element `apis`. Did you mean `api`?');
    expect(errors({ setShapes: [{ text: 'Flow', link: { type: 'flow', id: 'sell' } }] })).toMatch(/setShapes\[0\]: link: unknown flow `sell`\./);
    expect(errors({ setShapes: [{ id: 'a', link: { type: 'diagram', id: 'overview' } }] })).toMatch(/a diagram cannot link to itself/);
    expect(errors({ shapes: [{ id: 'a' }, { id: 'a' }] })).toBe('diagram `overview` shape `a`: duplicate id in `shapes`.');
    expect(errors({ connectors: [{ id: 'c', from: 'a', to: 'b' }, { id: 'c', from: 'b', to: 'a' }] })).toMatch(/connector `c`: duplicate id in `connectors`/);
    expect(errors({ setShapes: [{ id: 'a-to-b', text: 'x' }] })).toMatch(/`a-to-b` is a connector of this diagram/);
    expect(errors({ setConnectors: [{ id: 'memo', from: 'a', to: 'b' }] })).toMatch(/`memo` is a shape of this diagram/);
  });

  it('accepts links to elements, flows and other diagrams', () => {
    const diagram = ok({ setShapes: [{ id: 'a', link: { type: 'flow', id: 'buy' } }, { id: 'b', link: { type: 'diagram', id: 'other' } }, { id: 'memo', link: { type: 'element', id: 'db' } }] });
    expect(diagram.shapes.filter((s) => s.link).map((s) => s.link!.id)).toEqual(['buy', 'other', 'db']);
  });
});

describe('unlinkLost', () => {
  it('unlinks shapes whose target is gone, keeping the name they showed', () => {
    const linked = ok({ setShapes: [{ id: 'a', text: '', link: { type: 'element', id: 'api' } }, { id: 'b', link: { type: 'element', id: 'db' } }, { id: 'memo', link: { type: 'flow', id: 'buy' } }] });
    const after = { ...MODEL, elements: [] };
    const { diagram, lost } = unlinkLost(linked, after, MODEL);
    expect(lost).toEqual([{ shape: 'a', link: { type: 'element', id: 'api' } }, { shape: 'b', link: { type: 'element', id: 'db' } }]);
    expect(shape(diagram, 'a')).toMatchObject({ text: 'Order API' });
    expect(shape(diagram, 'b')).toMatchObject({ text: 'B' });
    expect(diagram.shapes.filter((s) => s.link).map((s) => s.id)).toEqual(['memo']);
    expect(shape(unlinkLost(linked, after).diagram, 'a').text).toBe('api');
    expect(unlinkLost(linked, MODEL).diagram).toBe(linked);
  });
});

describe('repairDiagram', () => {
  it('returns a consistent diagram as it is', () => {
    expect(repairDiagram(BASE, MODEL)).toEqual({ diagram: BASE, notes: [] });
  });

  it('makes a damaged diagram consistent, one note per repair', () => {
    const damaged = Diagram.parse({
      id: 'overview',
      name: 'Overview',
      shapes: [
        { ...box('g1', 0, 0), kind: 'group', parent: 'g2' },
        { ...box('g2', 0, 0), kind: 'group', parent: 'g1' },
        box('a', 0, 0, { parent: 'ghost' }),
        box('a', 9, 9, { text: 'second' }),
        box('b', 0, 0, { parent: 'a' }),
        box('c', 0, 0, { parent: 'c' }),
        box('d', 0, 0, { parent: 'g2', link: { type: 'element', id: 'gone' } }),
        box('e', 0, 0, { text: 'Mine', link: { type: 'flow', id: 'gone' } }),
        box('f', 0, 0, { link: { type: 'diagram', id: 'overview' } }),
        box('ok', 0, 0, { link: { type: 'element', id: 'api' } }),
      ],
      connectors: [
        { id: 'c1', from: 'a', to: 'b' },
        { id: 'c1', from: 'b', to: 'a' },
        { id: 'c2', from: 'a', to: 'nowhere' },
        { id: 'c3', from: 'b', to: 'b' },
        { id: 'e', from: 'a', to: 'b' },
      ],
    });
    const { diagram, notes } = repairDiagram(damaged, MODEL, (link) => (link.id === 'gone' && link.type === 'element' ? 'Billing' : undefined));
    expect(diagramProblems(diagram, MODEL)).toEqual([]);
    expect(diagram.shapes.map((s) => [s.id, s.parent, s.text, s.link?.id])).toEqual([
      ['g1', undefined, '', undefined],
      ['g2', 'g1', '', undefined],
      ['a', undefined, '', undefined],
      ['b', undefined, '', undefined],
      ['c', undefined, '', undefined],
      ['d', 'g2', 'Billing', undefined],
      ['e', undefined, 'Mine', undefined],
      ['f', undefined, 'Overview', undefined],
      ['ok', undefined, '', 'api'],
    ]);
    expect(diagram.connectors).toEqual([{ id: 'c1', from: 'a', to: 'b', label: '' }]);
    expect(notes).toEqual([
      'diagram `overview` shape `a`: dropped a second shape with this id.',
      'diagram `overview` shape `g1`: cleared its parent, `g2` is inside it.',
      'diagram `overview` shape `a`: cleared its parent, there is no shape `ghost`.',
      'diagram `overview` shape `b`: cleared its parent, `a` is not a group.',
      'diagram `overview` shape `c`: cleared its parent, it named itself.',
      'diagram `overview` shape `d`: unlinked from missing element `gone`, it keeps the name it showed.',
      'diagram `overview` shape `e`: unlinked from missing flow `gone`, it keeps the name it showed.',
      'diagram `overview` shape `f`: unlinked from its own diagram, it keeps the name it showed.',
      'diagram `overview` connector `c1`: dropped, its id is taken already.',
      'diagram `overview` connector `c2`: dropped, there is no shape `nowhere` (`to`).',
      'diagram `overview` connector `c3`: dropped, both ends are the shape `b`.',
      'diagram `overview` connector `e`: dropped, its id is taken already.',
    ]);
    expect(diagramProblems(damaged, MODEL).length).toBeGreaterThan(8);
    expect(repairDiagram(Diagram.parse({ id: 'd', name: 'D', shapes: [box('x', 0, 0, { link: { type: 'element', id: 'gone' } })] }), MODEL).diagram.shapes[0]!.text).toBe('gone');
  });
});

describe('stored size', () => {
  it('never stores a shape smaller than its text', () => {
    const { diagram } = applyDiagramPatch(undefined, { name: 'Sizes', shapes: [{ id: 'a', text: 'A label that needs room', x: 0, y: 0, w: 20, h: 10 }] }, { id: 'sizes', model: { elements: [], flows: [], diagrams: [] } });
    const a = diagram!.shapes[0]!;
    expect(a.w).toBeGreaterThan(20);
    expect(a.h).toBeGreaterThan(10);
  });
});
