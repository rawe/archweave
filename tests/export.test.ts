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
    expect(content).toContain('-.->|"charges"|');
    expect(content).toContain('Open notes:\n- Use Stripe _(human)_');
    expect(content).toContain('## Data');
    expect(content).toContain('d0["Order"]');
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

  it('exports json as the full model with defaults filled in, and the layout', () => {
    const { content } = exportModel(model, { data: { order: { x: 1, y: 2 } } }, { format: 'json' });
    const parsed = JSON.parse(content);
    expect(parsed.layout).toEqual({ data: { order: { x: 1, y: 2 } } });
    expect(parsed.model).toMatchObject({ version: 1, name: 'Shop', description: 'Sells things.' });
    expect(parsed.model.elements).toHaveLength(8);
    expect(parsed.model.elements[0]).toEqual({
      id: 'api',
      kind: 'service',
      name: 'Order API',
      summary: 'Takes orders.',
      description: '',
      status: 'built',
      tags: [],
      codeRefs: [],
      notes: [],
      fields: [],
    });
    expect(parsed.model.relations.find((r: any) => r.id === 'customer-uses-web')).toEqual({
      id: 'customer-uses-web',
      from: 'customer',
      to: 'web',
      kind: 'uses',
      label: 'browses',
      description: '',
      dataIds: [],
      status: 'built',
      codeRefs: [],
    });
    expect(parsed.model.flows[0].steps[0]).toEqual({ from: 'customer', to: 'web', label: 'checks out', dataIds: [], codeRefs: [] });
    expect(parsed.model.flows.map((f: any) => f.id)).toEqual(['place-order']);
  });

  it('keeps mermaid diagrams valid for names and types with special characters', () => {
    const nasty = Model.parse({
      name: 'Nasty',
      elements: [
        { id: 'a', kind: 'service', name: 'API "v2" <beta> | {core} #1; done' },
        { id: 'b', kind: 'store', name: 'C# store & `cache`' },
        { id: 'u', kind: 'actor', name: 'User; admin -> root' },
        {
          id: 'cfg',
          kind: 'data',
          name: 'Config {"x"}',
          fields: [
            { name: 'dataType', type: "'string'|'integer'" },
            { name: 'displayName', type: 'string | null' },
            { name: 'items', type: 'Map<string, Array<{ id: number }>>', ref: 'item' },
            { name: 'say "hi"', type: '"quoted"' },
          ],
        },
        { id: 'item', kind: 'data', name: 'Item <T>' },
      ],
      relations: [
        { id: 'a-b', from: 'a', to: 'b', kind: 'writes', label: 'saves "rows" | {batch}; #2' },
        { id: 'u-a', from: 'u', to: 'a', label: 'calls -> "x"' },
        { id: 'cfg-item', from: 'cfg', to: 'item', kind: 'references', label: 'has <many> | "items"' },
      ],
      flows: [{ id: 'f', name: 'F', steps: [{ from: 'u', to: 'a', label: 'POST "/x"; then #3 <ok> -> {y} %% z', dataIds: ['cfg'] }] }],
    });
    const { content } = exportModel(nasty, {}, { format: 'mermaid' });
    const diagrams = [...content.matchAll(/```mermaid\n([\s\S]*?)\n```/g)].map((m) => m[1]!);
    expect(diagrams).toHaveLength(3);
    const unsafe = (text: string) => /["<>{}|;#`&%]/.test(text.replace(/#\w+;/g, ''));
    for (const diagram of diagrams) {
      for (const line of diagram.split('\n').slice(1)) {
        const quoted = [...line.matchAll(/"([^"]*)"/g)].map((m) => m[1]!);
        for (const text of quoted) expect(unsafe(text), line).toBe(false);
        expect(line.replace(/"[^"]*"/g, '').includes('"'), line).toBe(false);
        const free = line.match(/^\s*(?:actor|participant) \w+ as (.*)$/)?.[1] ?? line.match(/^\s*\w+->>\w+: (.*)$/)?.[1];
        if (free !== undefined) expect(unsafe(free), line).toBe(false);
      }
    }
    const [flowchart, data, sequence] = diagrams;
    expect(flowchart).toContain('n0["API #quot;v2#quot; #lt;beta#gt; #124; #123;core#125; #35;1#59; done"]');
    expect(flowchart).toMatch(/n0 -->\|"saves #quot;rows#quot; #124; #123;batch#125;#59; #35;2"\| n1/);
    expect(data).toMatch(/^flowchart LR/);
    expect(data).toContain('d0["Config #123;#quot;x#quot;#125;"]');
    expect(data).toMatch(/d0 -->\|"items"\| d1/);
    expect(data).toMatch(/d0 -\.->\|"has #lt;many#gt; #124; #quot;items#quot;"\| d1/);
    expect(sequence).toContain('actor p0 as User#59; admin -#gt; root');
    expect(sequence).toContain('p0->>p1: POST #quot;/x#quot;#59; then #35;3 #lt;ok#gt; -#gt; #123;y#125; #37;#37; z [Config #123;#quot;x#quot;#125;]');

    const doc = exportModel(nasty, {}, { format: 'markdown' }).content;
    expect(doc).toContain("| dataType | `'string'\\|'integer'` |  |");
    expect(doc).toContain('| items | `Map<string, Array<{ id: number }>>` → Item <T> |  |');
  });

  it('rejects an unknown scope', () => {
    expect(() => exportModel(model, {}, { format: 'markdown', scopeId: 'nope' })).toThrow(/unknown scope/);
  });
});
