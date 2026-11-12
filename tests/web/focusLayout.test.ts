import { describe, expect, it } from 'vitest';
import { Model } from '../../src/shared/model.ts';
import { CENTER_W, ROW, layoutFocus, rowHeight } from '../../src/web/data/focusLayout.ts';
import { estimateMeasure } from '../../src/web/lib/text.ts';
import { groupStructures } from '../../src/web/data/groups.ts';
import { buildIndex } from '../../src/web/state/selectors.ts';

const model = Model.parse({
  elements: [
    { id: 'api', kind: 'service', name: 'API' },
    { id: 'db', kind: 'store', name: 'Database' },
    { id: 'order', kind: 'data', name: 'Order', parentId: 'api', fields: [{ name: 'id', type: 'uuid' }, { name: 'customer', type: 'Customer', ref: 'customer' }, { name: 'lines', type: 'Line[]', ref: 'line' }] },
    { id: 'customer', kind: 'data', name: 'Customer', fields: [{ name: 'id', type: 'uuid' }, { name: 'name', type: 'string' }] },
    { id: 'line', kind: 'data', name: 'Line', parentId: 'api', fields: [{ name: 'sku', type: 'string' }, { name: 'order', type: 'Order', ref: 'order' }] },
    { id: 'invoice', kind: 'data', name: 'Invoice', parentId: 'db', fields: [{ name: 'order', type: 'Order', ref: 'order' }, { name: 'total', type: 'number' }, { name: 'due', type: 'date' }] },
  ],
  relations: [
    { id: 'api-writes-order', from: 'api', to: 'order', kind: 'writes' },
    { id: 'api-calls-db', from: 'api', to: 'db', kind: 'calls', dataIds: ['order'] },
  ],
});

describe('data focus layout', () => {
  const measure = estimateMeasure;
  const layout = layoutFocus(model, 'order', { measure })!;

  it('puts referenced structures right, referencing ones left, mutual ones once on the right', () => {
    const role = Object.fromEntries(layout.cards.map((c) => [c.id, c.role]));
    expect(role).toEqual({ order: 'center', customer: 'right', line: 'right', invoice: 'left' });
  });

  it('starts each outgoing thread at the referencing field row and ends at the target header', () => {
    const toCustomer = layout.threads.find((t) => t.neighbor === 'customer')!;
    const row = layout.center.rows[1]!;
    expect(toCustomer.from).toEqual({ x: CENTER_W, y: row.y + ROW / 2 });
    const customer = layout.cards.find((c) => c.id === 'customer')!;
    expect(toCustomer.to.x).toBe(customer.x);
    expect(toCustomer.to.y).toBeGreaterThan(customer.y);
  });

  it('shows only the involved rows on side cards, with the rest counted', () => {
    const invoice = layout.cards.find((c) => c.id === 'invoice')!;
    expect(invoice.rows.map((r) => r.field.name)).toEqual(['order']);
    expect(invoice.more).toBe(2);
    expect(layout.threads.some((t) => t.neighbor === 'invoice' && t.sideRow === 0 && t.toward === 'right')).toBe(true);
  });

  it('lists who touches the structure, grouped by verb', () => {
    expect(layout.users!.groups.map((g) => g.label)).toEqual(['Written by', 'Carried between']);
    expect(layout.users!.groups[1]!.items[0]!.peer?.id).toBe('db');
  });

  it('keeps cards from overlapping within a column', () => {
    for (const side of ['left', 'right'] as const) {
      const col = layout.cards.filter((c) => c.role === side).sort((a, b) => a.y - b.y);
      for (let i = 1; i < col.length; i++) expect(col[i]!.y).toBeGreaterThanOrEqual(col[i - 1]!.y + col[i - 1]!.h);
    }
  });

  it('returns nothing for elements that are not data', () => {
    expect(layoutFocus(model, 'api', { measure })).toBeNull();
  });

  it('expands a side card in place to all its fields', () => {
    const open = layoutFocus(model, 'order', { measure, expanded: new Set(['invoice']) })!;
    const invoice = open.cards.find((c) => c.id === 'invoice')!;
    expect(invoice.rows.map((r) => r.field.name)).toEqual(['order', 'total', 'due']);
    expect(invoice.more).toBe(0);
    expect(invoice.canCollapse).toBe(true);
    expect(invoice.h).toBeGreaterThan(layout.cards.find((c) => c.id === 'invoice')!.h);
  });

  it('draws both relations between structures that reference each other, as two separate threads', () => {
    const mutual = Model.parse({
      elements: [
        { id: 'a', kind: 'data', name: 'A' },
        { id: 'b', kind: 'data', name: 'B' },
      ],
      relations: [
        { id: 'a-references-b', from: 'a', to: 'b', kind: 'references' },
        { id: 'b-references-a', from: 'b', to: 'a', kind: 'references' },
      ],
    });
    const focus = layoutFocus(mutual, 'a', { measure })!;
    expect(focus.cards.map((c) => [c.id, c.role])).toEqual([['a', 'center'], ['b', 'right']]);
    const out = focus.threads.find((t) => t.id === 'rel:a-references-b')!;
    const back = focus.threads.find((t) => t.id === 'rel:b-references-a')!;
    expect(out).toMatchObject({ neighbor: 'b', toward: 'right' });
    expect(back).toMatchObject({ neighbor: 'b', toward: 'left' });
    expect(back.from.x).toBe(focus.cards[1]!.x);
    expect(back.to.x).toBe(CENTER_W);
    // Not drawn on top of each other.
    expect(back.from.y).not.toBe(out.to.y);
  });

  it('gives long types more lines instead of cutting them', () => {
    const long = { name: 'parts', type: '{key, name, description, includes: {entityTypes[], relationTypes[]}, indexInclusions?, savedQueries[]}[]' };
    expect(rowHeight({ name: 'id', type: 'uuid' }, CENTER_W, measure)).toBe(ROW);
    expect(rowHeight(long, CENTER_W, measure)).toBeGreaterThanOrEqual(12 + 4 * 16);
  });
});

describe('structure groups', () => {
  it('puts unowned structures first, then owners by name, and filters by name or field', () => {
    const groups = groupStructures(buildIndex(model));
    expect(groups.map((g) => g.name)).toEqual(['Shared', 'API', 'Database']);
    expect(groups[1]!.items.map((d) => d.name)).toEqual(['Line', 'Order']);
    expect(groupStructures(buildIndex(model), 'total').flatMap((g) => g.items.map((d) => d.id))).toEqual(['invoice']);
  });
});
