import { describe, expect, it } from 'vitest';
import { Diagram, Model } from '../src/shared/model.ts';
import { connectorEnds, promoteConnector, promotedKind, promoteShape } from '../src/shared/diagram/promote.ts';
import { Store } from '../src/server/store.ts';

const model = Model.parse({
  elements: [
    { id: 'api', kind: 'service', name: 'API' },
    { id: 'db', kind: 'store', name: 'Orders DB', status: 'planned' },
    { id: 'mailer', kind: 'service', name: 'Mailer' },
  ],
  relations: [{ id: 'api-writes-db', from: 'api', to: 'db', kind: 'writes' }],
});

const diagram = Diagram.parse({
  id: 'sketch',
  name: 'Sketch',
  shapes: [
    { id: 'gw', text: 'API', link: { type: 'element', id: 'api' }, x: 0, y: 0, w: 120, h: 48 },
    { id: 'store', kind: 'cylinder', text: '\n  Order store \nkeeps orders', detail: 'All  orders,\nfor ever.', x: 0, y: 100, w: 120, h: 72 },
    { id: 'db', link: { type: 'element', id: 'db' }, x: 200, y: 0, w: 120, h: 48 },
    { id: 'mail', link: { type: 'element', id: 'mailer' }, x: 200, y: 100, w: 120, h: 48 },
    { id: 'blank', x: 400, y: 0, w: 120, h: 48 },
  ],
  connectors: [
    { id: 'gw-to-db', from: 'gw', to: 'db', label: 'writes' },
    { id: 'gw-to-mail', from: 'gw', to: 'mail', label: 'sends  mail' },
    { id: 'gw-to-store', from: 'gw', to: 'store' },
  ],
});

describe('promoting a shape', () => {
  it('picks the element kind the silhouette suggests', () => {
    expect(promotedKind('cylinder')).toBe('store');
    expect(promotedKind('pill')).toBe('queue');
    expect(promotedKind('actor')).toBe('actor');
    expect(promotedKind('group')).toBe('system');
    expect(promotedKind('diamond')).toBe('component');
  });

  it('creates the element from the first line and the detail, and links the shape with its text cleared', () => {
    const p = promoteShape(model, diagram, 'store', 'store')!;
    expect(p.elements).toEqual([{ id: 'order-store', kind: 'store', name: 'Order store', summary: 'All orders, for ever.', status: 'planned' }]);
    expect(p.diagrams).toEqual([{ id: 'sketch', setShapes: [{ id: 'store', text: '', link: { type: 'element', id: 'order-store' } }] }]);
    expect(p.elementId).toBe('order-store');
  });

  it('refuses shapes that are linked already or have no text', () => {
    expect(promoteShape(model, diagram, 'gw', 'service')).toBeUndefined();
    expect(promoteShape(model, diagram, 'blank', 'component')).toBeUndefined();
    expect(promoteShape(model, diagram, 'nope', 'component')).toBeUndefined();
  });

  it('applies as one change set the store accepts, after which the shape shows the live name', () => {
    const store = new Store({ model: { ...model, diagrams: [diagram] } });
    const { elementId: _, ...changes } = promoteShape(model, diagram, 'store', 'store')!;
    store.apply(changes, 'human');
    const after = store.snapshot().model;
    expect(after.elements.find((e) => e.id === 'order-store')?.name).toBe('Order store');
    expect(after.diagrams[0]!.shapes.find((s) => s.id === 'store')).toMatchObject({ text: '', link: { type: 'element', id: 'order-store' } });
  });
});

describe('promoting a connector', () => {
  it('needs both ends linked to elements', () => {
    expect(connectorEnds(model, diagram, 'gw-to-mail')).toEqual({ from: 'api', to: 'mailer' });
    expect(connectorEnds(model, diagram, 'gw-to-store')).toBeUndefined();
    expect(promoteConnector(model, diagram, 'gw-to-store')).toBeUndefined();
  });

  it('creates a relation labelled like the line, built only when both ends are built', () => {
    expect(promoteConnector(model, diagram, 'gw-to-mail')).toEqual({
      summary: 'Related API to Mailer',
      relations: [{ id: 'api-uses-mailer', from: 'api', to: 'mailer', kind: 'uses', label: 'sends mail', status: 'built' }],
      relationId: 'api-uses-mailer',
    });
  });

  it('does not relate what the model relates in that direction already', () => {
    expect(promoteConnector(model, diagram, 'gw-to-db')).toBeUndefined();
  });
});
