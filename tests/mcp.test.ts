import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, describe, expect, it } from 'vitest';
import { createMcpServer } from '../src/server/mcp.ts';
import { Repo } from '../src/server/repo.ts';
import { Session } from '../src/server/session.ts';
import { StaleLinks } from '../src/server/stale.ts';
import { Store } from '../src/server/store.ts';
import { tempRepo, waitFor } from './helpers.ts';

const MODEL = {
  name: 'Shop',
  elements: [
    { id: 'customer', kind: 'actor', name: 'Customer' },
    { id: 'web', kind: 'app', name: 'Web app' },
    { id: 'api', kind: 'service', name: 'Order API' },
    { id: 'api-config', kind: 'data', name: 'API config', parentId: 'api' },
    { id: 'orders', kind: 'component', name: 'Orders', parentId: 'api', codeRefs: [{ path: './src/orders/service.ts' }] },
    { id: 'orders-db-adapter', kind: 'module', name: 'Orders DB adapter', parentId: 'orders' },
    { id: 'order', kind: 'data', name: 'Order', parentId: 'orders' },
    { id: 'billing', kind: 'component', name: 'Billing', parentId: 'api', codeRefs: [{ path: 'src/billing/' }] },
    { id: 'invoice', kind: 'data', name: 'Invoice', parentId: 'billing' },
    { id: 'db', kind: 'store', name: 'Orders DB' },
    { id: 'stripe', kind: 'external', name: 'Stripe' },
  ],
  relations: [
    { id: 'customer-uses-web', from: 'customer', to: 'web', label: 'browses' },
    { id: 'web-calls-orders', from: 'web', to: 'orders', kind: 'calls', dataIds: ['order'] },
    { id: 'web-calls-billing', from: 'web', to: 'billing', kind: 'calls' },
    { id: 'orders-calls-billing', from: 'orders', to: 'billing', kind: 'calls' },
    { id: 'adapter-writes-db', from: 'orders-db-adapter', to: 'db', kind: 'writes' },
    { id: 'billing-calls-stripe', from: 'billing', to: 'stripe', kind: 'calls' },
    { id: 'orders-produces-order', from: 'orders', to: 'order', kind: 'produces' },
  ],
};

interface Harness {
  store: Store;
  session: Session;
  client: Client;
  call(name: string, args?: Record<string, unknown>): Promise<any>;
}

const clients: Client[] = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.close()));
});

async function harness(options: { stale?: StaleLinks; repoDir?: string } = {}): Promise<Harness> {
  const store = new Store({ model: MODEL });
  const session = new Session();
  const repo = new Repo(options.repoDir ?? tempRepo({}));
  const server = createMcpServer({ store, session, repo, stale: options.stale ?? new StaleLinks(repo), version: 'test', uiUrl: 'http://localhost:9' });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: 'test-agent', version: '1.0.0' });
  await client.connect(clientSide);
  clients.push(client);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const result = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: { text: string }[] };
    if (result.isError) throw new Error(result.content[0]!.text);
    const text = result.content[0]!.text;
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  };
  return { store, session, client, call };
}

describe('get_model', () => {
  it('lifts relations to the returned depth and merges them', async () => {
    const { call } = await harness();
    const outline = await call('get_model', { depth: 1 });
    expect(outline.elements.map((e: any) => e.id)).toEqual(['customer', 'web', 'api', 'db', 'stripe']);
    expect(outline.relations).toEqual([
      { id: 'customer-uses-web', from: 'customer', to: 'web', kind: 'uses', label: 'browses' },
      { from: 'web', to: 'api', count: 2, relationIds: ['web-calls-orders', 'web-calls-billing'], kinds: ['calls'] },
      { from: 'api', to: 'db', count: 1, relationIds: ['adapter-writes-db'], kinds: ['writes'] },
      { from: 'api', to: 'stripe', count: 1, relationIds: ['billing-calls-stripe'], kinds: ['calls'] },
    ]);
  });

  it('shows connections to outside neighbors of a scope', async () => {
    const { call } = await harness();
    const outline = await call('get_model', { scopeId: 'api', depth: 1 });
    expect(outline.elements.map((e: any) => e.id)).toEqual(['orders', 'billing']);
    expect(outline.neighbors.map((e: any) => e.id).sort()).toEqual(['db', 'stripe', 'web']);
    expect(outline.relations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'orders-calls-billing' }),
        expect.objectContaining({ id: 'web-calls-orders', from: 'web', to: 'orders' }),
        { from: 'orders', to: 'db', count: 1, relationIds: ['adapter-writes-db'], kinds: ['writes'] },
      ]),
    );
    expect(outline.relations).toHaveLength(5);
  });

  it('counts every kind including data and shows child and data counts', async () => {
    const { call } = await harness();
    const outline = await call('get_model', { depth: 1 });
    expect(outline.counts).toEqual({
      elements: 11,
      byKind: { actor: 1, app: 1, service: 1, component: 2, module: 1, store: 1, external: 1, data: 3 },
      relations: 7,
      flows: 0,
    });
    const api = outline.elements.find((e: any) => e.id === 'api');
    expect(api).toMatchObject({ childCount: 2, dataCount: 1 });
    expect(api.children).toBeUndefined();
    const deep = await call('get_model', { depth: 2 });
    const orders = deep.elements.find((e: any) => e.id === 'api').children.find((e: any) => e.id === 'orders');
    expect(orders).toMatchObject({ childCount: 1, dataCount: 1 });
  });
});

describe('get_context', () => {
  it('lists what the browser shows: children, lifted neighbors and threads among them', async () => {
    const { call, session } = await harness();
    session.setUi({ perspective: 'structure', scopeId: 'api' });
    const context = await call('get_context');
    expect(context.ui.visible).toEqual([
      expect.objectContaining({ id: 'web', neighbor: true }),
      expect.objectContaining({ id: 'orders' }),
      expect.objectContaining({ id: 'billing' }),
      expect.objectContaining({ id: 'db', neighbor: true }),
      expect.objectContaining({ id: 'stripe', neighbor: true }),
    ]);
    expect(context.ui.visible.find((e: any) => e.id === 'orders').neighbor).toBeUndefined();
    expect(context.ui.visibleRelations).toEqual(
      expect.arrayContaining([
        { from: 'web', to: 'orders', count: 1, relationIds: ['web-calls-orders'] },
        { from: 'orders', to: 'db', count: 1, relationIds: ['adapter-writes-db'] },
      ]),
    );
    expect(context.ui.visibleRelations).toHaveLength(5);
  });

  it('says when the reported view is stale because no browser is connected', async () => {
    const { call, session } = await harness();
    session.setUi({ perspective: 'structure', scopeId: 'api' });
    const context = await call('get_context');
    expect(Date.parse(context.ui.reportedAt)).toBeGreaterThan(0);
    expect(context.browserConnected).toBe(false);
    expect(context.uiHint).toMatch(/No browser is connected; this is what the human last looked at .* ago/);

    const stop = session.subscribe(() => undefined);
    expect((await call('get_context')).uiHint).toBeUndefined();
    stop();
  });

  it('never moves the human-changes cursor backwards under concurrent calls', async () => {
    let entered = false;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const stale = {
      check: async () => {
        entered = true;
        await gate;
        return [];
      },
    } as unknown as StaleLinks;
    const { call, store, session } = await harness({ stale });
    store.apply({ summary: 'Human edit', elements: [{ id: 'web', summary: 'Storefront.' }] }, 'human');
    const slow = call('get_context');
    await waitFor(() => entered);
    const applied = await call('apply_changes', { summary: 'Agent edit', elements: [{ id: 'db', summary: 'Keeps orders.' }] });
    expect(session.agentCursor).toBe(applied.revision);
    release();
    await slow;
    expect(session.agentCursor).toBe(applied.revision);
  });
});

describe('apply_changes', () => {
  it('validates without applying on dryRun', async () => {
    const { call, store } = await harness();
    const before = store.snapshot();
    const result = await call('apply_changes', { summary: 'Try', dryRun: true, elements: [{ kind: 'queue', name: 'Events' }] });
    expect(result).toMatchObject({ dryRun: true, created: { elements: ['events'] }, warnings: [] });
    expect(store.snapshot().model).toBe(before.model);
    expect(store.currentRevision).toBe(before.revision);
    await expect(call('apply_changes', { summary: 'Try', dryRun: true, relations: [{ from: 'web', to: 'ordrs' }] })).rejects.toThrow(/Did you mean `orders`/);
  });

  it('documents the list helpers and dry runs', async () => {
    const { client } = await harness();
    const { tools } = await client.listTools();
    const description = tools.find((t) => t.name === 'apply_changes')!.description!;
    for (const word of ['addCodeRefs', 'removeCodeRefs', 'setFields', 'removeFields', 'updateSteps', 'insertSteps', 'removeSteps', 'dryRun']) {
      expect(description).toContain(word);
    }
  });
});

describe('find_by_code', () => {
  it('matches stored refs written in another form of the same path', async () => {
    const repoDir = tempRepo({ 'src/orders/service.ts': '', 'src/billing/charge.ts': '' });
    const { call } = await harness({ repoDir });
    const found = await call('find_by_code', { paths: ['src/orders/service.ts', './src/billing/charge.ts'] });
    expect(found.elements.map((e: any) => e.id).sort()).toEqual(['billing', 'orders']);
    expect(found.unmatchedPaths).toEqual([]);
  });
});

describe('check_code_links', () => {
  it('lists built elements without code only for kinds that should have code', async () => {
    const { call, store } = await harness();
    store.apply({ elements: [{ id: 'planner', kind: 'agent', name: 'Planner', status: 'built' }, { id: 'events', kind: 'queue', name: 'Events', status: 'built' }] }, 'human');
    const report = await call('check_code_links');
    expect(report.builtWithoutCode.map((e: any) => e.id).sort()).toEqual(['api', 'api-config', 'invoice', 'order', 'orders-db-adapter', 'web']);
  });
});

describe('get_element', () => {
  it('lists each user of a data structure once, with every way it uses it', async () => {
    const { call } = await harness();
    const order = await call('get_element', { id: 'order' });
    expect(order.usedBy).toEqual([
      { id: 'web', name: 'Web app', kind: 'app', via: ['carried by web-calls-orders'] },
      { id: 'orders', name: 'Orders', kind: 'component', via: ['carried by web-calls-orders', 'produces'] },
    ]);
  });
});

describe('guide', () => {
  it('answers the questions agents ran into', async () => {
    const { call, client } = await harness();
    const guide = await call('get_guide');
    expect(client.getInstructions()).toBe(guide);
    expect(guide).toMatch(/same text as `get_guide`/);
    expect(guide).toMatch(/Relations have no name/);
    expect(guide).toMatch(/<from>-<kind>-<to>/);
    expect(guide).toMatch(/owned by the store/);
    expect(guide).toMatch(/dotted names/);
    expect(guide).toMatch(/free text/);
    expect(guide).toMatch(/more than about a dozen/);
    expect(guide).toMatch(/addCodeRefs/);
    expect(guide).toMatch(/A `symbol` must literally occur, as an identifier, within `startLine`\.\.`endLine`/);
    expect(guide).toMatch(/registered by a string name, such as routes .* give the line range without a `symbol`/);
    expect(guide).toMatch(/`check_code_links` with `repair: true` re-anchors/);
    expect(guide).toMatch(/re-send it unchanged in `addCodeRefs`/);
  });

  it('documents repair, the new reasons and the narrower selectors in the tool descriptions', async () => {
    const { client } = await harness();
    const { tools } = await client.listTools();
    const describe = (name: string) => tools.find((t) => t.name === name)!;
    expect(describe('check_code_links').description).toMatch(/moved.*suggestion[\s\S]*changed[\s\S]*repair: true/);
    expect(Object.keys((describe('check_code_links').inputSchema as any).properties)).toEqual(['scopeId', 'repair', 'seal']);
    expect(describe('find_by_code').description).toMatch(/`check` is "ok", "moved"/);
    expect(describe('apply_changes').description).toMatch(/\[\{path, symbol\?, startLine\?\}\]/);
    expect(describe('apply_changes').description).toMatch(/actor, external, system/);
  });
});
