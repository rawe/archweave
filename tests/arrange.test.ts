import { describe, expect, it } from 'vitest';
import { arrangeDiagram, prepareChanges } from '../src/server/arrange.ts';
import { Repo } from '../src/server/repo.ts';
import { apiRoutes } from '../src/server/routes.ts';
import { Session } from '../src/server/session.ts';
import { StaleLinks } from '../src/server/stale.ts';
import { Store } from '../src/server/store.ts';
import { diagramLints } from '../src/shared/diagram/lints.ts';
import { type ChangeSet, type Diagram, type DiagramPatch, type DiagramShape, Model } from '../src/shared/model.ts';
import { tempRepo } from './helpers.ts';

const MODEL = Model.parse({
  elements: [
    { id: 'shop', kind: 'system', name: 'Shop' },
    { id: 'api', kind: 'service', name: 'Order API', parentId: 'shop' },
    { id: 'db', kind: 'store', name: 'Orders DB', parentId: 'shop' },
    { id: 'events', kind: 'queue', name: 'Events', parentId: 'shop' },
    { id: 'customer', kind: 'actor', name: 'Customer' },
    { id: 'stripe', kind: 'external', name: 'Stripe' },
    { id: 'fraud', kind: 'service', name: 'Fraud check', status: 'planned' },
  ],
  relations: [
    { id: 'customer-uses-api', from: 'customer', to: 'api', label: 'orders' },
    { id: 'api-writes-db', from: 'api', to: 'db', kind: 'writes', label: 'writes' },
    { id: 'api-publishes-events', from: 'api', to: 'events', kind: 'publishes', label: 'publishes' },
    { id: 'api-calls-stripe', from: 'api', to: 'stripe', kind: 'calls', label: 'charges' },
    { id: 'api-calls-fraud', from: 'api', to: 'fraud', kind: 'calls', label: 'scores', status: 'planned' },
  ],
});

/** Applies a diagram change the way the MCP tool does: prepared, then through the store. */
async function draw(store: Store, ...diagrams: DiagramPatch[]): Promise<{ prepared: ChangeSet; diagram: Diagram }> {
  const prepared = await prepareChanges(store.snapshot().model, { diagrams });
  store.apply(prepared, 'agent');
  const id = prepared.diagrams![0]!.id ?? 'd';
  return { prepared, diagram: store.snapshot().model.diagrams.find((d) => d.id === id)! };
}

/** Pairs of shapes in the same group (or both outside groups) that overlap. */
function overlaps(diagram: Diagram): string[] {
  const out: string[] = [];
  diagram.shapes.forEach((a, i) => {
    for (const b of diagram.shapes.slice(i + 1)) {
      if (a.parent === b.parent && a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h) out.push(`${a.id}/${b.id}`);
    }
  });
  return out;
}

/** Shapes not fully inside their group. */
function escapes(diagram: Diagram): string[] {
  const byId = new Map(diagram.shapes.map((s) => [s.id, s]));
  return diagram.shapes.filter((s) => {
    const g = s.parent ? byId.get(s.parent) : undefined;
    return g && !(s.x >= g.x && s.y >= g.y && s.x + s.w <= g.x + g.w && s.y + s.h <= g.y + g.h);
  }).map((s) => s.id);
}

function onGrid(diagram: Diagram): boolean {
  return diagram.shapes.every((s) => s.x % 8 === 0 && s.y % 8 === 0);
}

const at = (d: Diagram, id: string): DiagramShape => d.shapes.find((s) => s.id === id)!;

const CHAIN: DiagramPatch = {
  id: 'd',
  name: 'Chain',
  shapes: [{ id: 'a', text: 'Browser' }, { id: 'b', text: 'API gateway' }, { id: 'c', text: 'Orders' }, { id: 'db', kind: 'cylinder', text: 'Orders DB' }],
  connectors: [{ from: 'a', to: 'b', label: 'HTTPS' }, { from: 'b', to: 'c', label: 'routes' }, { from: 'c', to: 'db', label: 'writes' }, { from: 'a', to: 'c' }],
};

describe('arranging a new diagram', () => {
  it('lays out in layers along the reading direction, on the grid, calm and without lints', async () => {
    for (const direction of ['down', 'right'] as const) {
      const { diagram } = await draw(new Store({ model: MODEL }), { ...CHAIN, direction });
      const [a, b, c, db] = ['a', 'b', 'c', 'db'].map((id) => at(diagram, id));
      if (direction === 'down') {
        expect(b!.y).toBeGreaterThanOrEqual(a!.y + a!.h + 48);
        expect(c!.y).toBeGreaterThan(b!.y + b!.h);
        expect(db!.y).toBeGreaterThan(c!.y + c!.h);
      } else {
        expect(b!.x).toBeGreaterThanOrEqual(a!.x + a!.w + 48);
        expect(c!.x).toBeGreaterThan(b!.x + b!.w);
        expect(db!.x).toBeGreaterThan(c!.x + c!.w);
      }
      expect(onGrid(diagram)).toBe(true);
      expect(diagramLints(diagram, MODEL)).toEqual([]);
    }
  });

  it('seeds and arranges a diagram from the model without any lint, in both directions', async () => {
    for (const direction of ['down', 'right'] as const) {
      const { diagram } = await draw(new Store({ model: MODEL }), { id: 'd', name: 'Seeded', direction, seed: ['shop', 'api', 'db', 'events', 'customer', 'stripe', 'fraud'] });
      expect(diagram.connectors.length).toBe(5);
      expect(diagramLints(diagram, MODEL)).toEqual([]);
    }
  });

  it('leaves room for long labels on lines fanning out of one shape', async () => {
    for (const direction of ['down', 'right'] as const) {
      const { diagram } = await draw(new Store({ model: MODEL }), {
        id: 'd',
        name: 'Fan',
        direction,
        shapes: [{ id: 'dev', kind: 'actor', text: 'Developer' }, { id: 'agent', text: 'Coding agent' }, { id: 'files', kind: 'cylinder', text: 'Model files' }],
        connectors: [
          { from: 'dev', to: 'agent', label: 'asks to model, explain or change code' },
          { from: 'dev', to: 'files', label: 'commits, checks out or edits model files' },
        ],
      });
      expect(diagramLints(diagram, MODEL)).toEqual([]);
    }
  });

  it('is deterministic', async () => {
    const first = await draw(new Store({ model: MODEL }), CHAIN);
    const second = await draw(new Store({ model: MODEL }), CHAIN);
    expect(second.prepared).toEqual(first.prepared);
  });

  it('writes positions into the patch and drops `arrange` and `seed`, giving id-less shapes their id', async () => {
    const prepared = await prepareChanges(MODEL, { diagrams: [{ name: 'Loose', arrange: 'new', shapes: [{ text: 'Web app' }, { text: 'Web app' }] }] });
    const patch = prepared.diagrams![0]!;
    expect(patch).not.toHaveProperty('arrange');
    expect(patch).not.toHaveProperty('seed');
    expect(patch.shapes!.map((s) => s.id)).toEqual(['web-app', 'web-app-2']);
    for (const s of patch.shapes!) expect(s).toMatchObject({ x: expect.any(Number), y: expect.any(Number) });
  });

  it('frames groups around their children with room for the title', async () => {
    const { diagram } = await draw(new Store({ model: MODEL }), {
      id: 'd',
      name: 'Groups',
      shapes: [
        { id: 'edge', kind: 'group', text: 'Edge' },
        { id: 'core', kind: 'group', text: 'Core services', detail: 'Kubernetes' },
        { id: 'lb', text: 'Load balancer', parent: 'edge' },
        { id: 'api', text: 'API', parent: 'core' },
        { id: 'worker', text: 'Worker', parent: 'core' },
      ],
      connectors: [{ from: 'lb', to: 'api' }, { from: 'api', to: 'worker' }],
    });
    expect(escapes(diagram)).toEqual([]);
    expect(overlaps(diagram)).toEqual([]);
    const core = at(diagram, 'core');
    expect(Math.min(at(diagram, 'api').y, at(diagram, 'worker').y) - core.y).toBeGreaterThanOrEqual(48);
    expect(diagramLints(diagram, MODEL)).toEqual([]);
  });

  it('arranges a 25-shape diagram with three groups without overlaps or shapes outside their group', async () => {
    const names = ['Web', 'Mobile', 'Admin', 'Gateway', 'Auth', 'Orders', 'Billing', 'Catalog', 'Search', 'Cart', 'Notify', 'Email', 'SMS', 'Push', 'Orders DB', 'Billing DB', 'Catalog DB', 'Index', 'Cache', 'Events', 'Payments', 'Tax'];
    const ids = names.map((n) => n.toLowerCase().replace(/ /g, '-'));
    const group = (id: string) => (['gateway', 'auth', 'orders', 'billing', 'catalog', 'search', 'cart'].includes(id) ? 'backend' : ['orders-db', 'billing-db', 'catalog-db', 'index', 'cache', 'events'].includes(id) ? 'data' : ['notify', 'email', 'sms', 'push'].includes(id) ? 'messaging' : undefined);
    const edges = [
      ['web', 'gateway'], ['mobile', 'gateway'], ['admin', 'gateway'], ['gateway', 'auth'], ['gateway', 'orders'], ['gateway', 'catalog'], ['gateway', 'search'], ['gateway', 'cart'],
      ['orders', 'billing'], ['orders', 'orders-db'], ['billing', 'billing-db'], ['catalog', 'catalog-db'], ['search', 'index'], ['cart', 'cache'], ['orders', 'events'],
      ['events', 'notify'], ['notify', 'email'], ['notify', 'sms'], ['notify', 'push'], ['billing', 'payments'], ['billing', 'tax'],
    ];
    const patch: DiagramPatch = {
      id: 'big',
      name: 'Big',
      shapes: [
        { id: 'backend', kind: 'group', text: 'Backend' },
        { id: 'data', kind: 'group', text: 'Data' },
        { id: 'messaging', kind: 'group', text: 'Messaging' },
        ...ids.map((id, i) => ({ id, text: names[i], ...(group(id) ? { parent: group(id) } : {}), ...(id.endsWith('db') ? { kind: 'cylinder' as const } : {}) })),
      ],
      connectors: edges.map(([from, to]) => ({ from, to })),
    };
    const { diagram } = await draw(new Store({ model: MODEL }), patch);
    expect(diagram.shapes).toHaveLength(25);
    expect(overlaps(diagram)).toEqual([]);
    expect(escapes(diagram)).toEqual([]);
    expect(onGrid(diagram)).toBe(true);
    expect(diagramLints(diagram, MODEL).filter((l) => l.code !== 'crosses-shape')).toEqual([]);
  });
});

describe('arranging new shapes into an arranged diagram', () => {
  /** Hand-arranged: a group with two boxes, a store below, a note far to the right. */
  const HAND: DiagramPatch = {
    id: 'hand',
    name: 'Hand made',
    shapes: [
      { id: 'zone', kind: 'group', text: 'Zone', x: 0, y: 0, w: 400, h: 160 },
      { id: 'a', text: 'A', parent: 'zone', x: 24, y: 56, w: 120, h: 48 },
      { id: 'b', text: 'B', parent: 'zone', x: 240, y: 56, w: 120, h: 48 },
      { id: 'store', kind: 'cylinder', text: 'Store', x: 140, y: 300, w: 120, h: 72 },
      { id: 'memo', kind: 'note', text: 'Hand placed', x: 640, y: 0, w: 160, h: 40 },
    ],
    connectors: [{ id: 'a-b', from: 'a', to: 'b' }, { id: 'b-store', from: 'b', to: 'store' }],
  };

  async function handMade(direction: 'down' | 'right' = 'down') {
    const store = new Store({ model: MODEL });
    store.apply({ diagrams: [{ ...HAND, direction }] }, 'human');
    return { store, before: store.snapshot().model.diagrams[0]! };
  }

  it('places a single shape next to what it connects to, downstream, and moves nothing else', async () => {
    const { store, before } = await handMade();
    const { prepared, diagram } = await draw(store, { id: 'hand', setShapes: [{ id: 'cache', kind: 'cylinder', text: 'Cache' }], setConnectors: [{ from: 'store', to: 'cache' }] });
    expect(prepared.diagrams![0]!.setShapes!.map((s) => s.id)).toEqual(['cache']);
    for (const s of before.shapes) expect(at(diagram, s.id)).toEqual(s);
    const cache = at(diagram, 'cache');
    const store_ = at(diagram, 'store');
    expect(cache.y).toBeGreaterThanOrEqual(store_.y + store_.h + 40);
    expect(Math.abs(cache.x + cache.w / 2 - (store_.x + store_.w / 2))).toBeLessThanOrEqual(8);
    expect(overlaps(diagram)).toEqual([]);
    expect(diagramLints(diagram, MODEL)).toEqual([]);
  });

  it('places a shape upstream of what it points at, and to the side when reading right', async () => {
    const { store } = await handMade();
    const { diagram } = await draw(store, { id: 'hand', setShapes: [{ id: 'user', kind: 'actor', text: 'User' }], setConnectors: [{ from: 'user', to: 'store' }] });
    expect(at(diagram, 'user').y + at(diagram, 'user').h).toBeLessThanOrEqual(at(diagram, 'store').y - 40);
    const right = await handMade('right');
    const { diagram: wide } = await draw(right.store, { id: 'hand', setShapes: [{ id: 'cache', text: 'Cache' }], setConnectors: [{ from: 'store', to: 'cache' }] });
    expect(at(wide, 'cache').x).toBeGreaterThanOrEqual(at(wide, 'store').x + at(wide, 'store').w + 40);
  });

  it('puts a new shape inside its existing group, which grows and pushes aside what it would cover', async () => {
    const { store, before } = await handMade();
    const { prepared, diagram } = await draw(store, {
      id: 'hand',
      setShapes: [{ id: 'c', text: 'C', parent: 'zone' }, { id: 'd', text: 'D', parent: 'zone' }],
      setConnectors: [{ from: 'b', to: 'c' }, { from: 'c', to: 'd' }],
    });
    expect(escapes(diagram)).toEqual([]);
    expect(overlaps(diagram)).toEqual([]);
    expect(at(diagram, 'zone').h).toBeGreaterThan(160);
    for (const id of ['a', 'b']) expect(at(diagram, id)).toEqual(before.shapes.find((s) => s.id === id));
    const written = prepared.diagrams![0]!.setShapes!.find((s) => s.id === 'zone');
    expect(written).toMatchObject({ w: expect.any(Number), h: expect.any(Number) });
  });

  it('arranges connected new shapes together as a cluster', async () => {
    const { store } = await handMade();
    const { diagram } = await draw(store, {
      id: 'hand',
      setShapes: [{ id: 'p', text: 'P' }, { id: 'q', text: 'Q' }, { id: 'r', text: 'R' }],
      setConnectors: [{ from: 'store', to: 'p' }, { from: 'p', to: 'q' }, { from: 'p', to: 'r' }],
    });
    const [p, q, r] = ['p', 'q', 'r'].map((id) => at(diagram, id));
    expect(q!.y).toBeGreaterThan(p!.y + p!.h);
    expect(r!.y).toBe(q!.y);
    expect(overlaps(diagram)).toEqual([]);
  });

  it('puts unconnected new shapes in a tidy column beside the content', async () => {
    const { store } = await handMade();
    const { diagram } = await draw(store, { id: 'hand', setShapes: [{ id: 'n1', kind: 'note', text: 'One' }, { id: 'n2', kind: 'note', text: 'Two' }] });
    const [n1, n2] = [at(diagram, 'n1'), at(diagram, 'n2')];
    expect(n1.x).toBe(n2.x);
    expect(n2.y).toBeGreaterThan(n1.y + n1.h);
    expect(n1.x).toBeGreaterThan(800);
    expect(overlaps(diagram)).toEqual([]);
  });

  it('sizes a new group with new children to enclose them', async () => {
    const { store } = await handMade();
    const { diagram } = await draw(store, {
      id: 'hand',
      setShapes: [{ id: 'ext', kind: 'group', text: 'External' }, { id: 'pay', text: 'Payments', parent: 'ext' }, { id: 'tax', text: 'Tax', parent: 'ext' }],
      setConnectors: [{ from: 'store', to: 'pay' }],
    });
    expect(escapes(diagram)).toEqual([]);
    expect(overlaps(diagram)).toEqual([]);
  });

  it('fits a new group around shapes that stay where they are', async () => {
    const { store, before } = await handMade();
    const { diagram } = await draw(store, { id: 'hand', setShapes: [{ id: 'notes', kind: 'group', text: 'Notes' }, { id: 'memo', parent: 'notes' }] });
    expect(at(diagram, 'memo')).toEqual({ ...before.shapes.find((s) => s.id === 'memo'), parent: 'notes' });
    expect(escapes(diagram)).toEqual([]);
  });

  it('re-arranges everything with `arrange: "all"`, keeping the sizes of shapes but not of groups', async () => {
    const { store, before } = await handMade();
    const { diagram } = await draw(store, { id: 'hand', arrange: 'all' });
    for (const s of before.shapes.filter((s) => s.kind !== 'group')) expect([at(diagram, s.id).w, at(diagram, s.id).h]).toEqual([s.w, s.h]);
    expect(at(diagram, 'zone').w).not.toBe(400);
    expect(escapes(diagram)).toEqual([]);
    expect(overlaps(diagram)).toEqual([]);
  });

  it('passes a change set without anything to arrange through unchanged', async () => {
    const { store } = await handMade();
    const changes = { summary: 'Rename', diagrams: [{ id: 'hand', setShapes: [{ id: 'a', text: 'Alpha' }] }], elements: [{ id: 'api', name: 'Orders API' }] };
    expect(await prepareChanges(store.snapshot().model, changes)).toEqual(changes);
  });

  it('leaves a patch with errors to the store, which reports them', async () => {
    const { store } = await handMade();
    const bad = { diagrams: [{ id: 'hand', setShapes: [{ id: 'x', text: 'X' }], setConnectors: [{ from: 'x', to: 'nowhere' }] }] };
    const prepared = await prepareChanges(store.snapshot().model, bad);
    expect(prepared).toEqual(bad);
    expect(() => store.apply(prepared, 'agent')).toThrow(/unknown shape `nowhere`/);
  });
});

describe('arrangeDiagram', () => {
  it('returns new boxes only for the shapes it was asked to place', async () => {
    const diagram: Diagram = {
      id: 'd',
      name: 'D',
      summary: '',
      direction: 'down',
      shapes: [
        { id: 'a', kind: 'box', text: 'A', x: 0, y: 0, w: 112, h: 48 },
        { id: 'b', kind: 'box', text: 'B', x: 0, y: 0, w: 112, h: 48 },
      ],
      connectors: [{ id: 'ab', from: 'a', to: 'b', label: '' }],
    };
    expect([...(await arrangeDiagram(diagram, MODEL, ['b'])).keys()]).toEqual(['b']);
  });
});

describe('seed through prepareChanges', () => {
  it('draws elements created in the same change set and reports unknown ids with a suggestion', async () => {
    const store = new Store({ model: MODEL });
    const prepared = await prepareChanges(store.snapshot().model, {
      elements: [{ id: 'cache', kind: 'store', name: 'Cache' }],
      relations: [{ from: 'api', to: 'cache', label: 'caches' }],
      diagrams: [{ id: 'd', name: 'D', seed: ['api', 'cache'] }],
    });
    store.apply(prepared, 'agent');
    const d = store.snapshot().model.diagrams[0]!;
    expect(d.shapes.map((s) => [s.id, s.kind])).toEqual([['api', 'box'], ['cache', 'cylinder']]);
    expect(d.connectors).toEqual([expect.objectContaining({ from: 'api', to: 'cache', label: 'caches' })]);
    expect(overlaps(d)).toEqual([]);
    await expect(prepareChanges(MODEL, { diagrams: [{ id: 'd', name: 'D', seed: ['strip'] }] })).rejects.toThrow(/seed: unknown element `strip`\. Did you mean `stripe`\?/);
  });
});

describe('POST /api/changes', () => {
  it('arranges diagrams for the human too', async () => {
    const store = new Store({ model: MODEL });
    const repo = new Repo(tempRepo({}));
    const api = apiRoutes({ store, session: new Session(), repo, stale: new StaleLinks(repo), version: 'test' });
    const res = await api.request('/changes', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ diagrams: [CHAIN] }) });
    expect(res.status).toBe(200);
    const d = store.snapshot().model.diagrams[0]!;
    expect(overlaps(d)).toEqual([]);
    expect(at(d, 'b').y).toBeGreaterThan(at(d, 'a').y);
  });
});
