import { describe, expect, it } from 'vitest';
import type { Model } from '../../src/shared/model.ts';
import { applyLocal, isLayoutOnly } from '../../src/web/state/apply.ts';

const base: Model = {
  version: 1,
  name: 'Shop',
  description: '',
  elements: [
    { id: 'api', kind: 'service', name: 'API', summary: '', description: '', status: 'built', tags: [], codeRefs: [], notes: [], fields: [] },
    { id: 'checkout', kind: 'component', name: 'Checkout', summary: '', description: '', parentId: 'api', status: 'built', tags: [], codeRefs: [], notes: [], fields: [] },
    { id: 'db', kind: 'store', name: 'DB', summary: '', description: '', status: 'built', tags: [], codeRefs: [], notes: [], fields: [] },
  ],
  relations: [{ id: 'checkout-writes-db', from: 'checkout', to: 'db', kind: 'writes', label: '', description: '', dataIds: [], status: 'built', codeRefs: [] }],
  flows: [{ id: 'buy', name: 'Buy', summary: '', steps: [{ from: 'checkout', to: 'db', label: 'save', dataIds: [], codeRefs: [] }] }],
  diagrams: [],
};

describe('applyLocal', () => {
  it('patches existing elements and creates new ones as planned', () => {
    const { model } = applyLocal({ model: base, layout: {} }, { elements: [{ id: 'api', name: 'Gateway' }, { id: 'cache', kind: 'store', name: 'Cache' }] });
    expect(model.elements.find((e) => e.id === 'api')?.name).toBe('Gateway');
    expect(model.elements.find((e) => e.id === 'cache')).toMatchObject({ kind: 'store', status: 'planned' });
  });

  it('moves to the top level with parentId null', () => {
    const { model } = applyLocal({ model: base, layout: {} }, { elements: [{ id: 'checkout', parentId: null }] });
    expect(model.elements.find((e) => e.id === 'checkout')?.parentId).toBeUndefined();
  });

  it('removes descendants, attached relations, flow steps and layout', () => {
    const { model, layout } = applyLocal(
      { model: base, layout: { 'structure:api': { checkout: { x: 1, y: 2 } }, 'structure:root': { api: { x: 0, y: 0 }, db: { x: 9, y: 9 } } } },
      { remove: { elements: ['api'] } },
    );
    expect(model.elements.map((e) => e.id)).toEqual(['db']);
    expect(model.relations).toEqual([]);
    expect(model.flows[0]!.steps).toEqual([]);
    expect(layout['structure:root']).toEqual({ db: { x: 9, y: 9 } });
    expect(layout['structure:api']).toEqual({});
  });

  it('adds a note once even if the change is applied twice', () => {
    const now = Date.parse('2026-01-01T00:00:00Z');
    const once = applyLocal({ model: base, layout: {} }, { elements: [{ id: 'db', addNotes: ['Index this'] }] }, now);
    const twice = applyLocal(once, { elements: [{ id: 'db', addNotes: ['Index this'] }] }, now + 10);
    expect(twice.model.elements.find((e) => e.id === 'db')?.notes).toHaveLength(1);
  });

  it('sets and clears layout positions', () => {
    const doc = applyLocal({ model: base, layout: {} }, { layout: { data: { a: { x: 1, y: 2 }, b: { x: 3, y: 4 } } } });
    const next = applyLocal(doc, { layout: { data: { a: null } } });
    expect(next.layout.data).toEqual({ b: { x: 3, y: 4 } });
  });

  it('recognizes layout-only change sets', () => {
    expect(isLayoutOnly({ layout: { data: {} } })).toBe(true);
    expect(isLayoutOnly({ layout: { data: {} }, elements: [{ id: 'db', name: 'X' }] })).toBe(false);
  });
});
