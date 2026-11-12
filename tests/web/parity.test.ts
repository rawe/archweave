import { describe, expect, it } from 'vitest';
import { Store } from '../../src/server/store.ts';
import type { Layout, Model } from '../../src/shared/model.ts';
import { applyLocal, type PlainChangeSet } from '../../src/web/state/apply.ts';

/** The browser's optimistic apply must land where the server does for every plain patch the UI sends. */
const SEED = {
  elements: [
    { id: 'api', kind: 'service', name: 'API' },
    { id: 'checkout', kind: 'component', name: 'Checkout', parentId: 'api', codeRefs: [{ path: 'src/checkout.ts', startLine: 3 }] },
    { id: 'db', kind: 'store', name: 'DB' },
    { id: 'order', kind: 'data', name: 'Order', fields: [{ name: 'id', type: 'uuid' }] },
    { id: 'line', kind: 'data', name: 'Line', fields: [{ name: 'order', type: 'Order', ref: 'order' }] },
  ],
  relations: [{ id: 'checkout-writes-db', from: 'checkout', to: 'db', kind: 'writes', dataIds: ['order'] }],
  flows: [{ id: 'buy', name: 'Buy', steps: [{ from: 'checkout', to: 'db', label: 'save', dataIds: ['order'] }] }],
};
const LAYOUT = { 'structure:root': { api: { x: 0, y: 0 }, db: { x: 300, y: 0 } }, 'structure:api': { checkout: { x: 10, y: 10 } } };

/** Change sets as sent over the wire, so list entries may leave out what the schema defaults. */
const CASES: [string, PlainChangeSet][] = ([
  ['renames the model', { model: { name: 'Shop', description: 'A shop.' } }],
  ['creates an element inside a scope', { elements: [{ kind: 'component', name: 'Billing Engine', parentId: 'api', summary: 'Charges.' }] }],
  ['creates an element with a given id and status', { elements: [{ id: 'cache', kind: 'store', name: 'Cache', status: 'built', tags: ['redis'] }] }],
  ['patches only the given fields', { elements: [{ id: 'checkout', name: 'Checkout flow', technology: 'TS' }] }],
  ['moves an element to the top level', { elements: [{ id: 'checkout', parentId: null }] }],
  ['replaces the code ref list', { elements: [{ id: 'checkout', codeRefs: [{ path: 'src/checkout.ts', startLine: 3 }, { path: 'src/cart.ts', symbol: 'Cart', note: 'cart' }] }] }],
  ['replaces the field list', { elements: [{ id: 'order', fields: [{ name: 'id', type: 'uuid' }, { name: 'lines', type: 'Line[]', ref: 'line', optional: true }] }] }],
  ['creates a relation with a generated id', { relations: [{ from: 'api', to: 'db', kind: 'reads', label: 'loads' }] }],
  ['patches a relation', { relations: [{ id: 'checkout-writes-db', label: 'saves', dataIds: [], technology: 'SQL', codeRefs: [{ path: 'src/db.ts' }] }] }],
  ['creates a flow', { flows: [{ name: 'Refund', summary: 'Money back.', steps: [{ from: 'api', to: 'db', label: 'refund' }] }] }],
  ['replaces the step list', { flows: [{ id: 'buy', steps: [{ from: 'api', to: 'checkout', label: 'start' }, { from: 'checkout', to: 'db', label: 'save', codeRefs: [{ path: 'src/db.ts', startLine: 1 }] }] }] }],
  ['removes an element with its descendants, relations, steps and positions', { remove: { elements: ['api'] } }],
  ['removes a relation and a flow', { remove: { relations: ['checkout-writes-db'], flows: ['buy'] } }],
  ['removes a data structure that others reference', { remove: { elements: ['order'] } }],
  ['sets and clears positions', { layout: { 'structure:root': { api: null, db: { x: 1, y: 2 } }, data: { order: { x: 5, y: 6 } } } }],
  ['creates and positions in one change set', { elements: [{ id: 'queue', kind: 'queue', name: 'Queue' }], layout: { 'structure:root': { queue: { x: 9, y: 9 } } } }],
  ['fills defaults of list entries', { elements: [{ id: 'order', fields: [{ name: 'note' }] }] }],
] as [string, unknown][]).map(([name, cs]) => [name, cs as PlainChangeSet]);

function comparable(doc: { model: Model; layout: Layout }) {
  const model = JSON.parse(JSON.stringify(doc.model, (key, value) => (key === 'digest' ? undefined : value)));
  const layout = Object.fromEntries(Object.entries(doc.layout).filter(([, positions]) => Object.keys(positions).length));
  return { model, layout };
}

describe('optimistic apply matches the server for plain patches', () => {
  for (const [name, cs] of CASES) {
    it(name, () => {
      const store = new Store({ model: SEED, layout: LAYOUT });
      const before = store.snapshot();
      store.apply(cs, 'human');
      const server = store.snapshot();
      expect(comparable(applyLocal({ model: before.model, layout: before.layout }, cs))).toEqual(comparable(server));
    });
  }

  it('applies a sequence of patches the same way', () => {
    const store = new Store({ model: SEED, layout: LAYOUT });
    let local = { model: store.snapshot().model, layout: store.snapshot().layout };
    for (const [, cs] of CASES.filter(([name]) => !name.startsWith('removes'))) {
      store.apply(cs, 'human');
      local = applyLocal(local, cs);
    }
    expect(comparable(local)).toEqual(comparable(store.snapshot()));
  });
});
