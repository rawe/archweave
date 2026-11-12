import { describe, expect, it } from 'vitest';
import { ChangeError, Store, type StoreChange } from '../src/server/store.ts';

const fixedNow = () => new Date('2026-01-02T03:04:05Z');

function shop(): Store {
  const store = new Store({ now: fixedNow });
  store.apply(
    {
      summary: 'Seed',
      elements: [
        { id: 'web', kind: 'app', name: 'Web app', summary: 'Storefront.', codeRefs: [{ path: 'web/main.ts' }] },
        { id: 'api', kind: 'service', name: 'Order API', summary: 'Takes orders.', codeRefs: [{ path: 'api/main.ts' }] },
        { id: 'checkout', kind: 'component', name: 'Checkout', parentId: 'api', codeRefs: [{ path: 'api/checkout.ts' }] },
        { id: 'pricing', kind: 'module', name: 'Pricing', parentId: 'checkout', codeRefs: [{ path: 'api/pricing.ts' }] },
        { id: 'billing', kind: 'component', name: 'Billing', parentId: 'api', codeRefs: [{ path: 'api/billing.ts' }] },
        { id: 'order', kind: 'data', name: 'Order', fields: [{ name: 'id', type: 'uuid' }] },
      ],
      relations: [
        { id: 'web-calls-checkout', from: 'web', to: 'checkout', kind: 'calls', label: 'places order', dataIds: ['order'] },
        { id: 'checkout-uses-pricing', from: 'checkout', to: 'pricing' },
        { id: 'checkout-calls-billing', from: 'checkout', to: 'billing', kind: 'calls' },
      ],
      flows: [
        {
          id: 'place-order',
          name: 'Place order',
          steps: [
            { from: 'web', to: 'checkout', label: 'submit cart' },
            { from: 'checkout', to: 'pricing', label: 'price items' },
            { from: 'checkout', to: 'billing', label: 'charge' },
          ],
        },
      ],
      layout: { 'structure:api': { checkout: { x: 1, y: 2 }, billing: { x: 3, y: 4 } }, 'structure:checkout': { pricing: { x: 0, y: 0 } } },
    },
    'agent',
  );
  return store;
}

function element(store: Store, id: string) {
  return store.snapshot().model.elements.find((e) => e.id === id);
}

describe('Store.apply', () => {
  it('creates elements with slug ids from names', () => {
    const store = new Store();
    const result = store.apply({ elements: [{ kind: 'service', name: 'Order Service' }, { kind: 'service', name: 'Order service' }] }, 'human');
    expect(result.created.elements).toEqual(['order-service', 'order-service-2']);
    expect(result.revision).toBe(1);
  });

  it('defaults status by actor: human planned, agent built only with code refs', () => {
    const store = new Store();
    store.apply({ elements: [{ id: 'h', kind: 'service', name: 'H', codeRefs: [{ path: 'a.ts' }] }] }, 'human');
    store.apply({ elements: [{ id: 'a1', kind: 'service', name: 'A1', codeRefs: [{ path: 'a.ts' }] }, { id: 'a2', kind: 'service', name: 'A2' }] }, 'agent');
    store.apply({ elements: [{ id: 'a3', kind: 'service', name: 'A3', status: 'deprecated' }] }, 'agent');
    expect(element(store, 'h')?.status).toBe('planned');
    expect(element(store, 'a1')?.status).toBe('built');
    expect(element(store, 'a2')?.status).toBe('planned');
    expect(element(store, 'a3')?.status).toBe('deprecated');
  });

  it('patches only the given fields of an existing element', () => {
    const store = shop();
    const result = store.apply({ elements: [{ id: 'api', name: 'Orders API' }] }, 'human');
    expect(result.updated.elements).toEqual(['api']);
    const api = element(store, 'api')!;
    expect(api.name).toBe('Orders API');
    expect(api.summary).toBe('Takes orders.');
    expect(api.status).toBe('built');
    expect(api.codeRefs).toEqual([{ path: 'api/main.ts' }]);
  });

  it('moves an element to the top level with parentId null', () => {
    const store = shop();
    store.apply({ elements: [{ id: 'billing', parentId: null }] }, 'human');
    expect(element(store, 'billing')).not.toHaveProperty('parentId');
  });

  it('lets one change set create an element and relate to it', () => {
    const store = shop();
    const result = store.apply(
      { elements: [{ id: 'stripe', kind: 'external', name: 'Stripe' }], relations: [{ from: 'billing', to: 'stripe', kind: 'calls' }] },
      'agent',
    );
    expect(result.created).toEqual({ elements: ['stripe'], relations: ['billing-calls-stripe'], flows: [] });
  });

  it('rejects unknown relation endpoints with a suggestion and applies nothing', () => {
    const store = shop();
    const before = store.snapshot();
    expect(() =>
      store.apply({ elements: [{ kind: 'store', name: 'Ledger' }], relations: [{ from: 'checkout', to: 'billng' }] }, 'agent'),
    ).toThrowError(/unknown element `billng`.*Did you mean `billing`\?/);
    expect(store.snapshot().model).toBe(before.model);
    expect(store.currentRevision).toBe(before.revision);
    expect(store.journal()).toHaveLength(1);
  });

  it('suggests an existing id when updating one that does not exist', () => {
    const store = shop();
    expect(() => store.apply({ elements: [{ id: 'chekout', summary: 'x' }] }, 'agent')).toThrowError(
      /element `chekout`: there is no element `chekout`.*Did you mean `checkout`\?/,
    );
  });

  it('reports schema errors with the path and name of the entry', () => {
    const store = shop();
    expect(() => store.apply({ elements: [{ name: 'Thing', kind: 'gadget' }] }, 'agent')).toThrowError(/elements\[0\] \("Thing"\)\.kind/);
    expect(() => store.apply({ elements: [{ name: 'Thing', kind: 'gadget' }] }, 'agent')).toThrowError(ChangeError);
  });

  it('rejects containment cycles', () => {
    const store = shop();
    expect(() => store.apply({ elements: [{ id: 'api', parentId: 'pricing' }] }, 'human')).toThrowError(/containment cycle/);
    expect(() => store.apply({ elements: [{ id: 'api', parentId: 'api' }] }, 'human')).toThrowError(/own parent/);
  });

  it('drops dangling data ids and field refs with warnings', () => {
    const store = shop();
    const result = store.apply(
      {
        relations: [{ id: 'checkout-calls-billing', dataIds: ['order', 'invoice', 'web'] }],
        elements: [{ id: 'order', fields: [{ name: 'id', type: 'uuid' }, { name: 'invoice', type: 'Invoice', ref: 'invoice' }] }],
      },
      'agent',
    );
    expect(store.snapshot().model.relations.find((r) => r.id === 'checkout-calls-billing')!.dataIds).toEqual(['order']);
    expect(element(store, 'order')!.fields[1]).toEqual({ name: 'invoice', type: 'Invoice' });
    expect(result.warnings).toHaveLength(3);
    expect(result.warnings.join('\n')).toMatch(/`web`, it is a app, not a data structure/);
  });

  it('removes descendants, attached relations, flow steps and layout entries', () => {
    const store = shop();
    const result = store.apply({ remove: { elements: ['checkout'] } }, 'human');
    const { model, layout } = store.snapshot();
    expect(result.removed.elements.sort()).toEqual(['checkout', 'pricing']);
    expect(result.removed.relations.sort()).toEqual(['checkout-calls-billing', 'checkout-uses-pricing', 'web-calls-checkout']);
    expect(model.relations).toEqual([]);
    expect(model.flows[0]!.steps).toEqual([]);
    expect(result.updated.flows).toEqual(['place-order']);
    expect(layout).toEqual({ 'structure:api': { billing: { x: 3, y: 4 } } });
  });

  it('rejects removing unknown ids', () => {
    const store = shop();
    expect(() => store.apply({ remove: { relations: ['web-calls-checkuot'] } }, 'human')).toThrowError(/Did you mean `web-calls-checkout`/);
  });

  it('adds and resolves notes', () => {
    const store = shop();
    store.apply({ elements: [{ id: 'billing', addNotes: ['Split refunds out'] }] }, 'human');
    const note = element(store, 'billing')!.notes[0]!;
    expect(note).toMatchObject({ id: 'note-1', text: 'Split refunds out', author: 'human', createdAt: '2026-01-02T03:04:05.000Z' });
    store.apply({ elements: [{ id: 'billing', resolveNotes: ['note-1'], addNotes: ['Done in refunds.ts'] }] }, 'agent');
    expect(element(store, 'billing')!.notes.map((n) => [n.id, n.author, !!n.resolved])).toEqual([
      ['note-1', 'human', true],
      ['note-2', 'agent', false],
    ]);
    expect(() => store.apply({ elements: [{ id: 'billing', resolveNotes: ['note-9'] }] }, 'agent')).toThrowError(/unknown note `note-9`/);
  });

  it('applies layout-only changes without a revision, journal entry or undo step', () => {
    const store = shop();
    const changes: StoreChange[] = [];
    store.subscribe((c) => changes.push(c));
    const result = store.apply({ layout: { 'structure:root': { web: { x: 10, y: 20 } } } }, 'human');
    expect(result.revision).toBe(1);
    expect(store.journal()).toHaveLength(1);
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ modelChanged: false, layoutChanged: true, entry: undefined });
    expect(store.snapshot().layout['structure:root']).toEqual({ web: { x: 10, y: 20 } });
    store.undo();
    expect(store.snapshot().model.elements).toEqual([]);
  });

  it('does nothing for a change set that changes nothing', () => {
    const store = shop();
    const result = store.apply({ elements: [{ id: 'api', name: 'Order API' }] }, 'agent');
    expect(result.updated.elements).toEqual([]);
    expect(store.currentRevision).toBe(1);
  });

  it('journals with the given or a generated summary', () => {
    const store = shop();
    store.apply({ elements: [{ kind: 'queue', name: 'Events' }], remove: { relations: ['checkout-uses-pricing'] } }, 'human');
    expect(store.journal().map((e) => [e.revision, e.actor, e.summary])).toEqual([
      [1, 'agent', 'Seed'],
      [2, 'human', 'Added 1 element; removed 1 relation'],
    ]);
    expect(store.journal({ since: 1 })).toHaveLength(1);
    expect(store.journal({ actor: 'agent' })).toHaveLength(1);
  });
});

describe('Store.undo', () => {
  it('restores the previous model and layout entries of restored elements', () => {
    const store = shop();
    store.apply({ remove: { elements: ['billing'] } }, 'human');
    store.apply({ layout: { 'structure:api': { checkout: { x: 50, y: 50 } } } }, 'human');
    const revision = store.undo();
    expect(revision).toBe(3);
    const { model, layout } = store.snapshot();
    expect(model.elements.some((e) => e.id === 'billing')).toBe(true);
    expect(model.relations.some((r) => r.id === 'checkout-calls-billing')).toBe(true);
    expect(layout['structure:api']).toEqual({ checkout: { x: 50, y: 50 }, billing: { x: 3, y: 4 } });
    expect(store.journal().at(-1)).toMatchObject({ actor: 'human', summary: 'Undo: Updated 1 flow; removed 1 element, 1 relation', created: { elements: ['billing'] } });
  });

  it('returns undefined when there is nothing to undo', () => {
    expect(new Store().undo()).toBeUndefined();
  });

  it('keeps at most 50 steps', () => {
    const store = new Store();
    for (let i = 0; i < 55; i++) store.apply({ elements: [{ kind: 'module', name: `M${i}` }] }, 'human');
    let undone = 0;
    while (store.undo() !== undefined) undone++;
    expect(undone).toBe(50);
    expect(store.snapshot().model.elements).toHaveLength(5);
  });
});
