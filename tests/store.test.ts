import { describe, expect, it } from 'vitest';
import { ChangeError, RevisionConflict, Store, type StoreChange } from '../src/server/store.ts';

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

  it('defaults agent-created actors, externals and systems to built: they never have code', () => {
    const store = new Store();
    store.apply(
      {
        elements: [
          { id: 'user', kind: 'actor', name: 'User' },
          { id: 'stripe', kind: 'external', name: 'Stripe' },
          { id: 'shop', kind: 'system', name: 'Shop' },
          { id: 'old', kind: 'external', name: 'Old', status: 'deprecated' },
          { id: 'llm', kind: 'agent', name: 'Planner' },
        ],
      },
      'agent',
    );
    store.apply({ elements: [{ id: 'buyer', kind: 'actor', name: 'Buyer' }] }, 'human');
    expect(['user', 'stripe', 'shop', 'old', 'llm', 'buyer'].map((id) => element(store, id)?.status)).toEqual(['built', 'built', 'built', 'deprecated', 'planned', 'planned']);
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
    expect(result.created).toEqual({ elements: ['stripe'], relations: ['billing-calls-stripe'], flows: [], diagrams: [] });
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

  it('rejects unknown or non-data ids in supplied data ids and field refs', () => {
    const store = shop();
    const before = store.snapshot();
    let message = '';
    try {
      store.apply(
        {
          relations: [{ id: 'checkout-calls-billing', dataIds: ['order', 'ordr', 'web'] }],
          elements: [{ id: 'order', fields: [{ name: 'id', type: 'uuid' }, { name: 'invoice', type: 'Invoice', ref: 'invoice' }] }],
          flows: [{ id: 'place-order', updateSteps: [{ index: 0, dataIds: ['oder'] }] }],
        },
        'agent',
      );
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(/Nothing was applied/);
    expect(message).toMatch(/relation `checkout-calls-billing`: data id `ordr`: no such data structure\. Did you mean `order`\?/);
    expect(message).toMatch(/data id `web`: it is a app, not a data structure/);
    expect(message).toMatch(/element `order` field `invoice`: ref `invoice`: no such data structure/);
    expect(message).toMatch(/flow `place-order` step 1: data id `oder`: no such data structure\. Did you mean `order`\?/);
    expect(store.snapshot()).toEqual(before);
  });

  it('cleans references broken by a removal with warnings', () => {
    const store = shop();
    store.apply(
      {
        elements: [{ id: 'line', kind: 'data', name: 'Line', fields: [{ name: 'order', ref: 'order' }] }],
        flows: [{ id: 'place-order', updateSteps: [{ index: 0, dataIds: ['order'] }] }],
      },
      'agent',
    );
    const result = store.apply({ remove: { elements: ['order'] } }, 'agent');
    const { model } = store.snapshot();
    expect(model.relations.find((r) => r.id === 'web-calls-checkout')!.dataIds).toEqual([]);
    expect(model.flows[0]!.steps[0]!.dataIds).toEqual([]);
    expect(element(store, 'line')!.fields).toEqual([{ name: 'order', type: '' }]);
    expect(result.updated).toEqual({ elements: ['line'], relations: ['web-calls-checkout'], flows: ['place-order'], diagrams: [] });
    expect(result.warnings.join('\n')).toMatch(/relation `web-calls-checkout`: dropped data id `order`/);
    expect(result.warnings.join('\n')).toMatch(/element `line` field `order`: dropped ref `order`/);
  });

  it('cleans references to an element that stops being a data structure', () => {
    const store = shop();
    store.apply(
      {
        elements: [{ id: 'line', kind: 'data', name: 'Line', fields: [{ name: 'order', ref: 'order' }] }],
        flows: [{ id: 'place-order', updateSteps: [{ index: 0, dataIds: ['order'] }] }],
      },
      'agent',
    );
    const result = store.apply({ elements: [{ id: 'order', kind: 'component' }] }, 'agent');
    const { model } = store.snapshot();
    expect(model.relations.find((r) => r.id === 'web-calls-checkout')!.dataIds).toEqual([]);
    expect(model.flows[0]!.steps[0]!.dataIds).toEqual([]);
    expect(element(store, 'line')!.fields).toEqual([{ name: 'order', type: '' }]);
    expect(result.updated.relations).toEqual(['web-calls-checkout']);
    expect(result.updated.flows).toEqual(['place-order']);
    expect(result.updated.elements.sort()).toEqual(['line', 'order']);
    expect(result.warnings).toHaveLength(3);
    expect(result.warnings.join('\n')).toMatch(/it is a component, not a data structure/);
  });

  it('normalizes code ref paths when storing them', () => {
    const store = shop();
    store.apply({ elements: [{ id: 'api', codeRefs: [{ path: './api//main.ts' }, { path: 'api\\routes\\' }] }] }, 'agent');
    expect(element(store, 'api')!.codeRefs).toEqual([{ path: 'api/main.ts' }, { path: 'api/routes' }]);
  });

  it('removes descendants, attached relations, flow steps and layout entries', () => {
    const store = shop();
    const changes: StoreChange[] = [];
    store.subscribe((c) => changes.push(c));
    const result = store.apply({ remove: { elements: ['checkout'] } }, 'human');
    expect(changes[0]).toMatchObject({ modelChanged: true, layoutChanged: true });
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

describe('Store list helpers', () => {
  it('adds and removes code refs without resending the list', () => {
    const store = shop();
    const result = store.apply(
      {
        elements: [
          { id: 'api', addCodeRefs: [{ path: './api/main.ts' }, { path: 'api/routes.ts', symbol: 'routes' }, { path: 'api/routes.ts', symbol: 'routes' }] },
          { id: 'billing', removeCodeRefs: [{ path: 'api/billing.ts' }], addCodeRefs: [{ path: 'api/billing/index.ts' }] },
        ],
        relations: [{ id: 'checkout-calls-billing', addCodeRefs: [{ path: 'api/checkout.ts', symbol: 'charge', startLine: 3 }] }],
      },
      'agent',
    );
    expect(result.updated.elements).toEqual(['api', 'billing']);
    expect(element(store, 'api')!.codeRefs).toEqual([{ path: 'api/main.ts' }, { path: 'api/routes.ts', symbol: 'routes' }]);
    expect(element(store, 'billing')!.codeRefs).toEqual([{ path: 'api/billing/index.ts' }]);
    expect(store.snapshot().model.relations.find((r) => r.id === 'checkout-calls-billing')!.codeRefs).toEqual([
      { path: 'api/checkout.ts', symbol: 'charge', startLine: 3 },
    ]);

    expect(() => store.apply({ elements: [{ id: 'api', removeCodeRefs: [{ path: 'api/routes.ts', symbol: 'other' }] }] }, 'agent')).toThrowError(
      /no code ref with path `api\/routes\.ts` and symbol `other`/,
    );
    store.apply({ elements: [{ id: 'api', removeCodeRefs: [{ path: 'api/routes.ts', symbol: 'routes' }] }] }, 'agent');
    expect(element(store, 'api')!.codeRefs).toEqual([{ path: 'api/main.ts' }]);
    expect(() => store.apply({ elements: [{ id: 'api', removeCodeRefs: [{ path: 'api/nope.ts' }] }] }, 'agent')).toThrowError(
      /no code ref with path `api\/nope\.ts`/,
    );
  });

  it('removes one symbol-less ref among several to the same file by its start line', () => {
    const store = shop();
    store.apply({ elements: [{ id: 'api', addCodeRefs: [{ path: 'api/routes.ts', startLine: 4 }, { path: 'api/routes.ts', startLine: 9 }, { path: 'api/routes.ts', symbol: 'routes', startLine: 4 }] }] }, 'agent');
    store.apply({ elements: [{ id: 'api', removeCodeRefs: [{ path: 'api/routes.ts', startLine: 9 }] }] }, 'agent');
    expect(element(store, 'api')!.codeRefs).toEqual([
      { path: 'api/main.ts' },
      { path: 'api/routes.ts', startLine: 4 },
      { path: 'api/routes.ts', symbol: 'routes', startLine: 4 },
    ]);
    store.apply({ elements: [{ id: 'api', removeCodeRefs: [{ path: 'api/routes.ts', symbol: 'routes', startLine: 4 }] }] }, 'agent');
    expect(element(store, 'api')!.codeRefs).toEqual([{ path: 'api/main.ts' }, { path: 'api/routes.ts', startLine: 4 }]);
    expect(() => store.apply({ elements: [{ id: 'api', removeCodeRefs: [{ path: 'api/routes.ts', startLine: 5 }] }] }, 'agent')).toThrowError(
      /no code ref with path `api\/routes\.ts` starting at line 5\. Its code refs are: `api\/main\.ts`, `api\/routes\.ts` lines 4\./,
    );
  });

  it('adds and removes code refs of a flow step', () => {
    const store = shop();
    store.apply({ flows: [{ id: 'place-order', updateSteps: [{ index: 2, label: 'charge card', addCodeRefs: [{ path: 'api/billing.ts', startLine: 3 }, { path: 'api/billing.ts', startLine: 8 }] }] }] }, 'agent');
    store.apply({ flows: [{ id: 'place-order', updateSteps: [{ index: 2, removeCodeRefs: [{ path: 'api/billing.ts', startLine: 3 }] }] }] }, 'agent');
    const step = store.snapshot().model.flows[0]!.steps[2]!;
    expect(step).toEqual({ from: 'checkout', to: 'billing', label: 'charge card', dataIds: [], codeRefs: [{ path: 'api/billing.ts', startLine: 8 }] });
  });

  it('upserts and removes fields by name', () => {
    const store = shop();
    store.apply({ elements: [{ id: 'line', kind: 'data', name: 'Line' }] }, 'agent');
    store.apply(
      {
        elements: [
          {
            id: 'order',
            setFields: [
              { name: 'id', description: 'Primary key' },
              { name: 'lines', type: 'Line[]', ref: 'line' },
              { name: 'customer.name', type: 'string', optional: true },
            ],
          },
        ],
      },
      'agent',
    );
    expect(element(store, 'order')!.fields).toEqual([
      { name: 'id', type: 'uuid', description: 'Primary key' },
      { name: 'lines', type: 'Line[]', ref: 'line' },
      { name: 'customer.name', type: 'string', optional: true },
    ]);
    store.apply({ elements: [{ id: 'order', setFields: [{ name: 'lines', ref: null }], removeFields: ['customer.name'] }] }, 'agent');
    expect(element(store, 'order')!.fields).toEqual([
      { name: 'id', type: 'uuid', description: 'Primary key' },
      { name: 'lines', type: 'Line[]' },
    ]);
    expect(() => store.apply({ elements: [{ id: 'order', removeFields: ['nope'] }] }, 'agent')).toThrowError(/no field `nope`. Its fields are: `id`, `lines`/);
    expect(() => store.apply({ elements: [{ id: 'order', setFields: [{ name: 'x', ref: 'lne' }] }] }, 'agent')).toThrowError(/Did you mean `line`\?/);
  });

  it('updates, inserts and removes flow steps by index', () => {
    const store = shop();
    store.apply(
      {
        flows: [
          {
            id: 'place-order',
            updateSteps: [{ index: 1, label: 'price the cart', dataIds: ['order'] }],
            removeSteps: [2],
            insertSteps: [
              { index: 0, step: { from: 'web', to: 'web', label: 'validate' } },
              { index: 3, step: { from: 'checkout', to: 'billing', label: 'charge later' } },
            ],
          },
        ],
      },
      'agent',
    );
    expect(store.snapshot().model.flows[0]!.steps.map((s) => [s.from, s.to, s.label, s.dataIds])).toEqual([
      ['web', 'web', 'validate', []],
      ['web', 'checkout', 'submit cart', []],
      ['checkout', 'pricing', 'price the cart', ['order']],
      ['checkout', 'billing', 'charge later', []],
    ]);
    expect(() => store.apply({ flows: [{ id: 'place-order', updateSteps: [{ index: 9, label: 'x' }] }] }, 'agent')).toThrowError(
      /updateSteps: index 9 is out of range \(the flow has 4 steps, indices 0 to 3\)/,
    );
    expect(() => store.apply({ flows: [{ id: 'place-order', insertSteps: [{ index: 1, step: { from: 'web', to: 'nope', label: 'x' } }] }] }, 'agent')).toThrowError(
      /unknown element `nope`/,
    );
    expect(() => store.apply({ flows: [{ id: 'place-order', removeSteps: [0], updateSteps: [{ index: 0, label: 'x' }] }] }, 'agent')).toThrowError(
      /index 0 is both updated and removed/,
    );
  });

  it('keeps full list replacement working next to the helpers', () => {
    const store = shop();
    store.apply({ elements: [{ id: 'api', codeRefs: [{ path: 'a.ts' }], addCodeRefs: [{ path: 'b.ts' }] }] }, 'agent');
    expect(element(store, 'api')!.codeRefs).toEqual([{ path: 'a.ts' }, { path: 'b.ts' }]);
  });
});

describe('Store.preview', () => {
  it('validates and reports a change set without applying it', () => {
    const store = shop();
    const before = store.snapshot();
    const changes: StoreChange[] = [];
    store.subscribe((c) => changes.push(c));
    const result = store.preview({ elements: [{ kind: 'store', name: 'Ledger' }], remove: { elements: ['pricing'] } }, 'agent');
    expect(result).toMatchObject({ revision: 2, created: { elements: ['ledger'] }, removed: { elements: ['pricing'] } });
    expect(store.snapshot().model).toBe(before.model);
    expect(store.snapshot()).toEqual(before);
    expect(changes).toEqual([]);
    expect(store.journal()).toHaveLength(1);
    expect(() => store.preview({ relations: [{ from: 'web', to: 'nope' }] }, 'agent')).toThrowError(ChangeError);
  });
});

describe('Store integrity', () => {
  const valid = { elements: [{ id: 'a', kind: 'service', name: 'A' }] };

  it('validates both documents before replacing either', () => {
    const store = shop();
    const before = store.snapshot();
    expect(() => store.replace(valid, { 'structure:root': { a: { x: 'left' } } })).toThrow();
    expect(store.snapshot().model).toBe(before.model);
    expect(store.snapshot().layout).toBe(before.layout);
  });

  it('refuses a model with broken references, duplicates or cycles, naming the problem', () => {
    const broken = {
      elements: [
        { id: 'a', kind: 'service', name: 'A', parentId: 'b' },
        { id: 'b', kind: 'component', name: 'B', parentId: 'a' },
        { id: 'c', kind: 'component', name: 'C', parentId: 'ghost' },
        { id: 'c', kind: 'component', name: 'C again' },
        { id: 'd', kind: 'data', name: 'D', fields: [{ name: 'x', ref: 'a' }] },
      ],
      relations: [{ id: 'r', from: 'a', to: 'zz', dataIds: ['b'] }],
      flows: [{ id: 'f', name: 'F', steps: [{ from: 'a', to: 'nobody', label: 'x', dataIds: ['q'] }] }],
    };
    let message = '';
    try {
      new Store({ model: broken });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(/duplicate element id `c`/);
    expect(message).toMatch(/element `c`: unknown parent `ghost`/);
    expect(message).toMatch(/containment cycle/);
    expect(message).toMatch(/element `d` field `x`: ref `a` is not a data structure/);
    expect(message).toMatch(/relation `r`: unknown element `zz` in `to`/);
    expect(message).toMatch(/relation `r`: data id `b` is not a data structure/);
    expect(message).toMatch(/flow `f` step 1: unknown element `nobody` in `to`/);
    expect(message).toMatch(/flow `f` step 1: data id `q` is not a data structure/);

    const store = shop();
    const before = store.snapshot();
    expect(() => store.replace(broken, {})).toThrow(/unknown parent `ghost`/);
    expect(store.snapshot().model).toBe(before.model);
    expect(store.snapshot().layout).toBe(before.layout);
  });
  it('validates data ids that step helpers carry through merges of the same step', () => {
    const store = shop();
    const steps = (dataIds: string[]) => [{ from: 'web', to: 'checkout', label: 'submit', dataIds }];
    expect(() => store.apply({ flows: [{ id: 'place-order', steps: steps(['missing']), updateSteps: [{ index: 0, label: 'x' }] }] }, 'agent')).toThrow(
      /flow `place-order` step 1: data id `missing`: no such data structure/,
    );
    expect(() => store.apply({ flows: [{ id: 'place-order', updateSteps: [{ index: 0, dataIds: ['missing'] }, { index: 0, label: 'x' }] }] }, 'agent')).toThrow(
      /flow `place-order` step 1: data id `missing`: no such data structure/,
    );
    expect(() => store.apply({ flows: [{ id: 'place-order', insertSteps: [{ index: 0, step: steps(['missing'])[0]! }] }] }, 'agent')).toThrow(/data id `missing`/);
    expect(new Store({ model: store.snapshot().model }).snapshot().model).toEqual(store.snapshot().model);
  });

  it('never applies a change set that would leave a model the store cannot load', () => {
    const store = shop();
    const before = store.snapshot();
    const note = { id: 'n1', text: 'Twice', author: 'human', createdAt: '2026-01-01T00:00:00Z' };
    expect(() => store.apply({ elements: [{ id: 'web', notes: [note, note] }] }, 'human')).toThrow(
      /Nothing was applied\. The change set would leave the model inconsistent:\n- element `web`: duplicate note id `n1`/,
    );
    expect(store.snapshot().model).toBe(before.model);
  });

  it('applies nothing when built from another revision, except layout', () => {
    const store = shop();
    const revision = store.currentRevision;
    expect(() => store.apply({ expectedRevision: revision - 1, elements: [{ id: 'web', summary: 'x' }] }, 'human')).toThrow(RevisionConflict);
    expect(() => store.preview({ expectedRevision: revision - 1, elements: [{ id: 'web', summary: 'x' }] }, 'human')).toThrow(RevisionConflict);
    store.apply({ expectedRevision: revision - 1, layout: { 'structure:root': { web: { x: 5, y: 5 } } } }, 'human');
    expect(store.snapshot().layout['structure:root']).toEqual({ web: { x: 5, y: 5 } });
    expect(store.apply({ expectedRevision: revision, elements: [{ id: 'web', summary: 'x' }] }, 'human').revision).toBe(revision + 1);
  });
});

describe('Store journal coalescing', () => {
  function clocked() {
    let t = Date.parse('2026-01-02T03:04:05Z');
    const store = new Store({ now: () => new Date(t) });
    store.apply({ summary: 'Seed', elements: [{ id: 'order', kind: 'data', name: 'Order' }, { id: 'web', kind: 'app', name: 'Web' }] }, 'agent');
    return { store, advance: (ms: number) => (t += ms) };
  }
  const fields = (...names: string[]) => names.map((name) => ({ name, type: 'string' }));

  it('merges quick summary-less edits of one item by one actor into one entry', () => {
    const { store, advance } = clocked();
    store.apply({ elements: [{ id: 'order', fields: fields('id') }] }, 'human');
    advance(20_000);
    store.apply({ elements: [{ id: 'order', fields: fields('id', 'total') }] }, 'human');
    advance(20_000);
    store.apply({ elements: [{ id: 'order', summary: 'A placed order.' }] }, 'human');
    const human = store.journal({ actor: 'human' });
    expect(human).toHaveLength(1);
    expect(human[0]).toMatchObject({
      revision: 4,
      firstRevision: 2,
      at: '2026-01-02T03:04:45.000Z',
      summary: 'Edited Order: summary, fields',
      updated: { elements: ['order'], relations: [], flows: [] },
    });
    // Undo still steps back one edit at a time.
    store.undo();
    expect(store.snapshot().model.elements.find((e) => e.id === 'order')?.fields.map((f) => f.name)).toEqual(['id', 'total']);
  });

  it('still answers since queries for a revision inside the merged range', () => {
    const { store } = clocked();
    store.apply({ elements: [{ id: 'order', fields: fields('id') }] }, 'human');
    const seen = store.currentRevision;
    store.apply({ elements: [{ id: 'order', fields: fields('id', 'total') }] }, 'human');
    expect(store.journal({ since: seen, actor: 'human' }).map((e) => e.revision)).toEqual([store.currentRevision]);
    expect(store.journal({ since: store.currentRevision })).toEqual([]);
  });

  it('keeps entries apart for another item, another actor, an explicit summary, a create, or after a minute', () => {
    const { store, advance } = clocked();
    store.apply({ elements: [{ id: 'order', summary: 'a' }] }, 'human');
    store.apply({ elements: [{ id: 'web', summary: 'b' }] }, 'human');
    store.apply({ elements: [{ id: 'web', summary: 'c' }] }, 'agent');
    store.apply({ elements: [{ id: 'web', summary: 'd' }] }, 'human');
    store.apply({ summary: 'Described the web app', elements: [{ id: 'web', summary: 'e' }] }, 'human');
    store.apply({ elements: [{ id: 'web', summary: 'f' }] }, 'human');
    store.apply({ elements: [{ id: 'web', summary: 'g' }, { kind: 'queue', name: 'Events' }] }, 'human');
    store.apply({ elements: [{ id: 'order', summary: 'h' }] }, 'human');
    advance(60_000);
    store.apply({ elements: [{ id: 'order', summary: 'i' }] }, 'human');
    expect(store.journal().slice(1).map((e) => [e.actor, e.summary])).toEqual([
      ['human', 'Edited Order: summary'],
      ['human', 'Edited Web: summary'],
      ['agent', 'Edited Web: summary'],
      ['human', 'Edited Web: summary'],
      ['human', 'Described the web app'],
      ['human', 'Edited Web: summary'],
      ['human', 'Added 1 element; updated 1 element'],
      ['human', 'Edited Order: summary'],
      ['human', 'Edited Order: summary'],
    ]);
  });

  it('does not merge across an undo', () => {
    const { store } = clocked();
    store.apply({ elements: [{ id: 'order', summary: 'a' }] }, 'human');
    store.undo();
    store.apply({ elements: [{ id: 'order', summary: 'b' }] }, 'human');
    expect(store.journal().slice(1).map((e) => e.summary)).toEqual(['Edited Order: summary', 'Undo: Edited Order: summary', 'Edited Order: summary']);
  });

  it('names a relation by its ends', () => {
    const { store } = clocked();
    store.apply({ summary: 'Link', relations: [{ id: 'web-uses-order', from: 'web', to: 'order', kind: 'reads' }] }, 'agent');
    store.apply({ relations: [{ id: 'web-uses-order', label: 'shows', technology: 'HTTP' }] }, 'human');
    expect(store.journal().at(-1)?.summary).toBe('Edited Web → Order: label, technology');
  });
});

describe('Store diagrams', () => {
  const at = (id: string, x: number, y: number, more: object = {}) => ({ id, x, y, w: 120, h: 48, ...more });

  /** The shop with a diagram that links to an element, a nested element, a flow and another diagram. */
  function drawn(now: () => Date = fixedNow) {
    const logs: string[] = [];
    const store = new Store({ now, model: shop().snapshot().model, log: (m) => logs.push(m) });
    store.apply(
      {
        summary: 'Draw',
        diagrams: [
          { id: 'detail', name: 'Detail' },
          {
            name: 'Checkout overview',
            shapes: [
              at('zone', 0, 0, { kind: 'group', text: 'Backend', w: 400, h: 200 }),
              at('api', 16, 40, { link: { type: 'element', id: 'api' }, parent: 'zone' }),
              at('pricing', 200, 40, { text: 'Prices', link: { type: 'element', id: 'pricing' }, parent: 'zone' }),
              at('flow', 0, 240, { kind: 'pill', link: { type: 'flow', id: 'place-order' } }),
              at('more', 200, 240, { link: { type: 'diagram', id: 'detail' } }),
            ],
            connectors: [{ from: 'api', to: 'pricing', label: 'asks' }],
          },
        ],
      },
      'agent',
    );
    return { store, logs };
  }
  const diagram = (store: Store, id = 'checkout-overview') => store.snapshot().model.diagrams.find((d) => d.id === id)!;
  const shape = (store: Store, id: string) => diagram(store).shapes.find((s) => s.id === id)!;

  it('creates diagrams with ids from their names and journals them', () => {
    const store = shop();
    const result = store.apply({ diagrams: [{ name: 'Checkout overview', setShapes: [{ text: 'Start', kind: 'pill' }] }, { name: 'Checkout overview' }] }, 'human');
    expect(result.created).toEqual({ elements: [], relations: [], flows: [], diagrams: ['checkout-overview', 'checkout-overview-2'] });
    expect(store.journal().at(-1)?.summary).toBe('Added 2 diagrams');
    expect(diagram(store).shapes.map((s) => [s.id, s.kind, s.x, s.y])).toEqual([['start', 'pill', 0, 0]]);
    store.apply({ remove: { diagrams: ['checkout-overview-2'] }, diagrams: [{ name: 'Other' }] }, 'human');
    expect(store.journal().at(-1)?.summary).toBe('Added 1 diagram; removed 1 diagram');
  });

  it('does nothing for a diagram patch that changes nothing', () => {
    const { store } = drawn();
    const revision = store.currentRevision;
    const result = store.apply({ diagrams: [{ id: 'checkout-overview', name: 'Checkout overview', setShapes: [{ id: 'api', x: 16 }] }] }, 'human');
    expect(result.updated.diagrams).toEqual([]);
    expect(store.currentRevision).toBe(revision);
  });

  it('merges quick diagram edits into one journal entry and undoes them one by one', () => {
    let t = Date.parse('2026-01-02T03:04:05Z');
    const { store } = drawn(() => new Date(t));
    const before = store.journal().length;
    store.apply({ diagrams: [{ id: 'checkout-overview', setShapes: [{ id: 'api', x: 24, y: 48 }] }] }, 'human');
    t += 5_000;
    store.apply({ diagrams: [{ id: 'checkout-overview', setConnectors: [{ id: 'api-to-pricing', line: 'dashed' }] }] }, 'human');
    const entries = store.journal().slice(before);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ summary: 'Edited Checkout overview: shapes, connectors', firstRevision: 2, revision: 3, updated: { diagrams: ['checkout-overview'] } });

    store.undo();
    expect(diagram(store).connectors[0]!.line).toBeUndefined();
    expect(shape(store, 'api')).toMatchObject({ x: 24, y: 48 });
    store.undo();
    expect(shape(store, 'api')).toMatchObject({ x: 16, y: 40 });
    store.undo();
    expect(store.snapshot().model.diagrams).toEqual([]);
    expect(store.journal().at(-1)).toMatchObject({ removed: { diagrams: ['detail', 'checkout-overview'] } });
  });

  it('applies nothing of a diagram change built from another revision', () => {
    const { store } = drawn();
    const revision = store.currentRevision;
    const move = { diagrams: [{ id: 'checkout-overview', setShapes: [{ id: 'api', x: 99 }] }] };
    expect(() => store.apply({ expectedRevision: revision - 1, ...move }, 'human')).toThrow(RevisionConflict);
    expect(shape(store, 'api').x).toBe(16);
    expect(store.apply({ expectedRevision: revision, ...move }, 'human').revision).toBe(revision + 1);
  });

  it('rejects a change set with a bad diagram patch as a whole', () => {
    const { store } = drawn();
    const before = store.snapshot();
    const fails = (changes: object, message: RegExp) => expect(() => store.apply(changes, 'agent')).toThrow(message);
    fails({ elements: [{ id: 'web', summary: 'x' }], diagrams: [{ id: 'checkout-overview', setConnectors: [{ from: 'api', to: 'prices' }] }] }, /diagram `checkout-overview` connector `api-to-prices`: unknown shape `prices` in `to`\. Did you mean `pricing`\?/);
    fails({ diagrams: [{ id: 'checkout-overvew', summary: 'x' }] }, /diagram `checkout-overvew`: there is no diagram `checkout-overvew`\. To create it, give `name`\. Did you mean `checkout-overview`\?/);
    fails({ diagrams: [{ summary: 'x' }] }, /diagrams\[0\]: a new diagram needs `name`\./);
    fails({ remove: { diagrams: ['details'] } }, /remove\.diagrams: unknown diagram `details`\. Did you mean `detail`\?/);
    fails({ remove: { diagrams: ['detail'] }, diagrams: [{ id: 'detail', summary: 'x' }] }, /diagram `detail` is both removed and changed/);
    fails({ remove: { elements: ['web'] }, diagrams: [{ id: 'detail', setShapes: [{ link: { type: 'element', id: 'web' } }] }] }, /link: unknown element `web`/);
    fails({ diagrams: [{ id: 'detail', setShapes: [{ text: 'x'.repeat(401) }] }] }, /diagrams\[0\] \("detail"\)\.setShapes\[0\]\.text/);
    expect(store.snapshot().model).toBe(before.model);
    expect(store.currentRevision).toBe(before.revision);
  });

  it('lets one change set create an element, a flow and a diagram that links to them', () => {
    const { store } = drawn();
    store.apply(
      {
        elements: [{ id: 'mailer', kind: 'service', name: 'Mailer' }],
        flows: [{ id: 'notify', name: 'Notify' }],
        diagrams: [{ id: 'detail', setShapes: [{ link: { type: 'element', id: 'mailer' } }, { link: { type: 'flow', id: 'notify' } }, { link: { type: 'diagram', id: 'checkout-overview' } }] }],
      },
      'agent',
    );
    expect(diagram(store, 'detail').shapes.map((s) => s.id)).toEqual(['mailer', 'notify', 'checkout-overview']);
  });

  it('keeps shapes that linked to something removed, as plain shapes with the name they showed', () => {
    const { store } = drawn();
    const result = store.apply({ elements: [{ id: 'api', name: 'Renamed in the same change set' }], remove: { elements: ['checkout'], flows: ['place-order'], diagrams: ['detail'] } }, 'human');
    expect(result.removed.elements).toEqual(['checkout', 'pricing']);
    expect(result.updated.diagrams).toEqual(['checkout-overview']);
    expect(result.warnings).toEqual([
      'diagram `checkout-overview` shape `pricing`: unlinked from removed element `pricing`, it keeps the name it showed.',
      'diagram `checkout-overview` shape `flow`: unlinked from removed flow `place-order`, it keeps the name it showed.',
      'diagram `checkout-overview` shape `more`: unlinked from removed diagram `detail`, it keeps the name it showed.',
    ]);
    expect(diagram(store).shapes.map((s) => [s.id, s.text, s.link?.id])).toEqual([
      ['zone', 'Backend', undefined],
      ['api', '', 'api'],
      ['pricing', 'Prices', undefined],
      ['flow', 'Place order', undefined],
      ['more', 'Detail', undefined],
    ]);
    expect(diagram(store).connectors).toHaveLength(1);
    store.undo();
    expect(shape(store, 'flow')).toMatchObject({ text: '', link: { type: 'flow', id: 'place-order' } });
  });

  it('repairs diagrams taken over from outside instead of refusing them, and says what it did', () => {
    const logs: string[] = [];
    const store = new Store({
      log: (m) => logs.push(m),
      model: { elements: [{ id: 'a', kind: 'service', name: 'A' }], diagrams: [{ id: 'imported', name: 'Imported' }, { id: 'map', name: 'Shadowed by the file' }] },
      diagrams: [
        { id: 'map', name: 'Map', shapes: [at('a', 0, 0, { link: { type: 'element', id: 'a' } }), at('b', 0, 0, { parent: 'a', link: { type: 'element', id: 'gone' } })], connectors: [{ id: 'c', from: 'a', to: 'zz' }] },
        { id: 'map', name: 'Twice' },
        { id: 'broken', shapes: 'none' },
        'nonsense',
      ],
    });
    expect(store.snapshot().model.diagrams.map((d) => [d.id, d.name])).toEqual([['map', 'Map'], ['imported', 'Imported']]);
    expect(store.snapshot().model.diagrams[0]).toMatchObject({ shapes: [{ id: 'a', link: { type: 'element', id: 'a' } }, { id: 'b', text: 'gone' }], connectors: [] });
    expect(logs).toEqual([
      'archweave: skipped a second diagram with the id `map`.',
      expect.stringMatching(/^archweave: skipped diagram `broken`: name: /),
      expect.stringMatching(/^archweave: skipped diagram #4: /),
      'archweave: diagram `map` shape `b`: cleared its parent, `a` is not a group.',
      'archweave: diagram `map` shape `b`: unlinked from missing element `gone`, it keeps the name it showed.',
      'archweave: diagram `map` connector `c`: dropped, there is no shape `zz` (`to`).',
    ]);
    expect(new Store({ model: store.snapshot().model, log: (m) => logs.push(m) }).snapshot().model).toEqual(store.snapshot().model);
    expect(logs).toHaveLength(6);
  });

  it('takes over the model and the diagrams independently', () => {
    const { store, logs } = drawn();
    const { diagrams, ...graph } = store.snapshot().model;

    store.replace(undefined, undefined, [{ id: 'solo', name: 'Solo', shapes: [at('web', 0, 0, { link: { type: 'element', id: 'web' } })] }]);
    expect(store.snapshot().model.diagrams.map((d) => d.id)).toEqual(['solo']);
    expect(store.snapshot().model.elements).toEqual(graph.elements);
    expect(store.canUndo()).toBe(false);

    store.replace(undefined, undefined, diagrams);
    const changes: StoreChange[] = [];
    store.subscribe((c) => changes.push(c));
    store.replace({ ...graph, elements: graph.elements.filter((e) => e.id !== 'pricing'), relations: graph.relations.filter((r) => r.to !== 'pricing'), flows: [] }, undefined);
    expect(changes).toMatchObject([{ cause: 'reload', modelChanged: true, layoutChanged: false }]);
    expect(store.snapshot().model.diagrams.map((d) => d.id)).toEqual(['detail', 'checkout-overview']);
    expect(shape(store, 'pricing')).toEqual(at('pricing', 200, 40, { kind: 'box', text: 'Prices', parent: 'zone' }));
    expect(shape(store, 'flow')).toMatchObject({ text: 'Place order' });
    expect(shape(store, 'flow').link).toBeUndefined();
    expect(logs).toEqual([
      'archweave: diagram `checkout-overview` shape `pricing`: unlinked from missing element `pricing`, it keeps the name it showed.',
      'archweave: diagram `checkout-overview` shape `flow`: unlinked from missing flow `place-order`, it keeps the name it showed.',
    ]);
  });

  it('never lets a change set through that leaves a diagram inconsistent', () => {
    const { store } = drawn();
    const twice = { id: 'detail', shapes: [{ id: 'x', x: 0, y: 0 }], connectors: [{ id: 'y', from: 'x', to: 'x' }] };
    expect(() => store.apply({ diagrams: [twice] }, 'human')).toThrow(/Nothing was applied\.\ndiagram `detail` connector `y`: `from` and `to` are the same shape `x`\./);
    expect(diagram(store, 'detail').shapes).toEqual([]);
  });
});
