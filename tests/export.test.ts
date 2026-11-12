import { describe, expect, it } from 'vitest';
import { exportModel } from '../src/server/export.ts';
import { Model } from '../src/shared/model.ts';

const model = Model.parse({
  name: 'Shop',
  description: 'Sells things.',
  elements: [
    { id: 'customer', kind: 'actor', name: 'Customer' },
    { id: 'web', kind: 'app', name: 'Web app', summary: 'Storefront.', technology: 'React' },
    { id: 'api', kind: 'service', name: 'Order API', summary: 'Takes orders.' },
    { id: 'checkout', kind: 'component', name: 'Checkout', parentId: 'api', summary: 'Turns carts into orders.', codeRefs: [{ path: 'api/checkout.ts', symbol: 'checkout', startLine: 3, endLine: 9 }] },
    { id: 'billing', kind: 'component', name: 'Billing', parentId: 'api', status: 'planned', notes: [{ id: 'note-1', text: 'Use Stripe', author: 'human', createdAt: '2026-01-01T00:00:00Z' }] },
    { id: 'db', kind: 'store', name: 'Orders DB', technology: 'Postgres' },
    { id: 'order', kind: 'data', name: 'Order', parentId: 'api', format: 'json', fields: [{ name: 'id', type: 'uuid' }, { name: 'items', type: 'OrderItem[]', ref: 'order-item' }], example: '{"id": "1"}' },
    { id: 'order-item', kind: 'data', name: 'Order item', fields: [{ name: 'sku', type: 'string', optional: true }] },
  ],
  relations: [
    { id: 'customer-uses-web', from: 'customer', to: 'web', label: 'browses' },
    { id: 'web-calls-checkout', from: 'web', to: 'checkout', kind: 'calls', label: 'places order', dataIds: ['order'] },
    { id: 'checkout-calls-billing', from: 'checkout', to: 'billing', kind: 'calls', label: 'charges', status: 'planned' },
    { id: 'checkout-writes-db', from: 'checkout', to: 'db', kind: 'writes' },
    { id: 'checkout-produces-order', from: 'checkout', to: 'order', kind: 'produces' },
  ],
  flows: [
    {
      id: 'place-order',
      name: 'Place order',
      summary: 'A customer buys.',
      steps: [
        { from: 'customer', to: 'web', label: 'checks out' },
        { from: 'web', to: 'checkout', label: 'POST /orders; retry', dataIds: ['order'] },
        { from: 'checkout', to: 'db', label: 'insert' },
      ],
    },
  ],
});

describe('exportModel', () => {
  it('writes a markdown architecture document', () => {
    const { content, filename, contentType } = exportModel(model, {}, { format: 'markdown' });
    expect(filename).toBe('shop.md');
    expect(contentType).toMatch(/markdown/);
    expect(content.startsWith('# Shop\n\nSells things.\n\n## Structure\n\n### Overview\n\n```mermaid\nflowchart LR\n')).toBe(true);
    expect(content).toContain('n0(("Customer"))');
    expect(content).toContain('[("Orders DB")]');
    expect(content).toContain('### Order API');
    expect(content).toContain('#### Checkout\n\n`component`\n\nTurns carts into orders.\n\nCode:\n- `api/checkout.ts` · `checkout` · lines 3–9');
    expect(content).toContain('-.->|charges|');
    expect(content).toContain('Open notes:\n- Use Stripe _(human)_');
    expect(content).toContain('## Data');
    expect(content).toContain('classDiagram');
    expect(content).toContain('| items | `OrderItem[]` → Order item |  |');
    expect(content).toContain('| sku (optional) | `string` |  |');
    expect(content).toContain('Used by: Web app → Checkout (places order), Checkout (produces).');
    expect(content).toContain('```json\n{"id": "1"}\n```');
    expect(content).toContain('## Flows\n\n### Place order\n\nA customer buys.\n\n```mermaid\nsequenceDiagram\n  actor p0 as Customer');
    expect(content).toContain('p1->>p2: POST /orders#59; retry [Order]');
    expect(content).toContain('2. **Web app → Checkout**: POST /orders; retry (data: Order)');
  });

  it('limits the document to a scope and perspectives, and can leave out code', () => {
    const { content } = exportModel(model, {}, { format: 'markdown', scopeId: 'api', perspectives: ['structure'], code: false });
    expect(content.startsWith('# Order API\n\nPart of Shop.\n\nTakes orders.')).toBe(true);
    expect(content).toContain('### Order API');
    expect(content).not.toContain('### Overview');
    expect(content).not.toContain('## Data');
    expect(content).not.toContain('## Flows');
    expect(content).not.toContain('api/checkout.ts');
  });

  it('exports just the diagrams as mermaid', () => {
    const { content, filename } = exportModel(model, {}, { format: 'mermaid' });
    expect(filename).toBe('shop-diagrams.md');
    expect(content.match(/```mermaid/g)).toHaveLength(4);
    expect(content).not.toContain('####');
    expect(content).not.toContain('Used by');
  });

  it('exports json as the canonical model and layout', () => {
    const { content } = exportModel(model, { data: { order: { x: 1, y: 2 } } }, { format: 'json' });
    const parsed = JSON.parse(content);
    expect(parsed.layout).toEqual({ data: { order: { x: 1, y: 2 } } });
    expect(parsed.model.elements).toHaveLength(8);
    expect(parsed.model.elements[0]).toEqual({ id: 'api', kind: 'service', name: 'Order API', summary: 'Takes orders.' });
  });

  it('rejects an unknown scope', () => {
    expect(() => exportModel(model, {}, { format: 'markdown', scopeId: 'nope' })).toThrow(/unknown scope/);
  });
});
