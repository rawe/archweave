import { describe, expect, it } from 'vitest';
import { seedPatch } from '../src/shared/diagram/seed.ts';
import { Diagram, Model } from '../src/shared/model.ts';

const MODEL = Model.parse({
  elements: [
    { id: 'shop', kind: 'system', name: 'Shop' },
    { id: 'api', kind: 'service', name: 'Order API', parentId: 'shop' },
    { id: 'orders', kind: 'component', name: 'Orders', parentId: 'api' },
    { id: 'db', kind: 'store', name: 'Orders DB', parentId: 'shop' },
    { id: 'events', kind: 'queue', name: 'Events' },
    { id: 'customer', kind: 'actor', name: 'Customer' },
    { id: 'stripe', kind: 'external', name: 'Stripe' },
    { id: 'fraud', kind: 'service', name: 'Fraud check', status: 'planned' },
    { id: 'legacy', kind: 'service', name: 'Legacy', status: 'deprecated' },
  ],
  relations: [
    { id: 'customer-uses-orders', from: 'customer', to: 'orders', label: 'orders' },
    { id: 'orders-writes-db', from: 'orders', to: 'db', kind: 'writes', label: 'writes' },
    { id: 'orders-reads-db', from: 'orders', to: 'db', kind: 'reads', label: 'reads' },
    { id: 'orders-publishes-events', from: 'orders', to: 'events', kind: 'publishes' },
    { id: 'orders-calls-fraud', from: 'orders', to: 'fraud', kind: 'calls', label: 'scores', status: 'planned' },
    { id: 'api-calls-stripe', from: 'api', to: 'stripe', kind: 'calls', label: 'charges' },
    { id: 'api-contains-orders', from: 'api', to: 'orders', label: 'owns' },
  ],
});

describe('seedPatch', () => {
  it('draws each element as a linked shape whose kind and outline follow the element', () => {
    const { setShapes, errors } = seedPatch(MODEL, undefined, ['events', 'customer', 'stripe', 'fraud', 'legacy', 'db']);
    expect(errors).toEqual([]);
    expect(setShapes).toEqual([
      { id: 'events', kind: 'pill', link: { type: 'element', id: 'events' } },
      { id: 'customer', kind: 'actor', link: { type: 'element', id: 'customer' } },
      { id: 'stripe', kind: 'box', outline: 'dashed', link: { type: 'element', id: 'stripe' } },
      { id: 'fraud', kind: 'box', outline: 'dashed', link: { type: 'element', id: 'fraud' } },
      { id: 'legacy', kind: 'box', outline: 'dotted', link: { type: 'element', id: 'legacy' } },
      { id: 'db', kind: 'cylinder', link: { type: 'element', id: 'db' } },
    ]);
  });

  it('turns a seeded ancestor into a group holding its seeded descendants', () => {
    const { setShapes } = seedPatch(MODEL, undefined, ['shop', 'orders', 'db']);
    expect(setShapes.map((s) => [s.id, s.kind, s.parent])).toEqual([['shop', 'group', undefined], ['orders', 'box', 'shop'], ['db', 'cylinder', 'shop']]);
  });

  it('connects drawn elements once per direction, keeping a label all agree on, dashing planned relations and skipping containment', () => {
    const { setConnectors } = seedPatch(MODEL, undefined, ['customer', 'api', 'orders', 'db', 'fraud', 'stripe']);
    expect(setConnectors).toEqual([
      { id: 'customer-to-orders', from: 'customer', to: 'orders', label: 'orders' },
      { id: 'orders-to-db', from: 'orders', to: 'db' },
      { id: 'orders-to-fraud', from: 'orders', to: 'fraud', label: 'scores', line: 'dashed' },
      { id: 'api-to-stripe', from: 'api', to: 'stripe', label: 'charges' },
    ]);
  });

  it('lifts relations to the nearest drawn ancestor, as the structure perspective does', () => {
    const { setConnectors } = seedPatch(MODEL, undefined, ['customer', 'shop', 'events', 'fraud']);
    expect(setConnectors).toEqual([
      { id: 'customer-to-shop', from: 'customer', to: 'shop', label: 'orders' },
      { id: 'shop-to-events', from: 'shop', to: 'events' },
      { id: 'shop-to-fraud', from: 'shop', to: 'fraud', label: 'scores', line: 'dashed' },
    ]);
    const shared = seedPatch({ ...MODEL, relations: [...MODEL.relations, { ...MODEL.relations[3]!, id: 'api-publishes-events', from: 'api', label: '' }] }, undefined, ['shop', 'events']);
    expect(shared.setConnectors).toEqual([{ id: 'shop-to-events', from: 'shop', to: 'events' }]);
    const agreed = seedPatch(Model.parse({ ...MODEL, relations: [{ id: 'r1', from: 'orders', to: 'events', label: 'publishes' }, { id: 'r2', from: 'api', to: 'events', label: 'publishes' }] }), undefined, ['shop', 'events']);
    expect(agreed.setConnectors).toEqual([{ id: 'shop-to-events', from: 'shop', to: 'events', label: 'publishes' }]);
  });

  it('adds only what is missing on an existing diagram and uses the shapes already linked', () => {
    const diagram = Diagram.parse({
      id: 'd',
      name: 'D',
      shapes: [
        { id: 'frame', kind: 'group', text: 'Shop', link: { type: 'element', id: 'shop' }, x: 0, y: 0, w: 400, h: 300 },
        { id: 'orders-box', link: { type: 'element', id: 'orders' }, parent: 'frame', x: 20, y: 60, w: 120, h: 48 },
        { id: 'db', text: 'taken id', x: 500, y: 0, w: 120, h: 48 },
      ],
      connectors: [{ id: 'drawn', from: 'orders-box', to: 'db' }],
    });
    const { setShapes, setConnectors } = seedPatch(MODEL, diagram, ['orders', 'db', 'customer']);
    expect(setShapes).toEqual([
      { id: 'db-2', kind: 'cylinder', link: { type: 'element', id: 'db' }, parent: 'frame' },
      { id: 'customer', kind: 'actor', link: { type: 'element', id: 'customer' } },
    ]);
    expect(setConnectors.map((c) => [c.from, c.to])).toEqual([['customer', 'orders-box'], ['orders-box', 'db-2']]);
  });

  it('names unknown elements with a suggestion and seeds nothing', () => {
    expect(seedPatch(MODEL, undefined, ['orders', 'strip'])).toEqual({ setShapes: [], setConnectors: [], errors: ['seed: unknown element `strip`. Did you mean `stripe`?'] });
  });
});
