import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { canonicalModel } from '../src/server/canonical.ts';
import { repairCodeLinks } from '../src/server/repair.ts';
import { Repo } from '../src/server/repo.ts';
import { DIGEST_LENGTH, digestText, StaleLinks } from '../src/server/stale.ts';
import { Store } from '../src/server/store.ts';
import type { CodeRef } from '../src/shared/model.ts';
import { tempRepo } from './helpers.ts';

/** A small route file: functions plus routes registered by string name. */
const ROUTES = [
  "import { app } from './app';", //  1
  '', //                               2
  'export function listOrders() {', // 3
  '  return db.orders.all();', //      4
  '}', //                              5
  '', //                               6
  'export function createOrder(input) {', // 7
  '  validate(input);', //             8
  '  return db.orders.insert(input);', // 9
  '}', //                             10
  '', //                              11
  "app.get('/orders', listOrders);", // 12
  "app.post('/orders', createOrder);", // 13
  '',
].join('\n');

const FILE = 'src/routes.ts';
const INSERTED = ['// a', '// b', '// c', '// d', '// e'];

function lines(content: string, from: number, to: number): string {
  return content.split('\n').slice(from - 1, to).join('\n');
}

function setup(content = ROUTES) {
  const repoDir = tempRepo({ [FILE]: content });
  const stale = new StaleLinks(new Repo(repoDir));
  const store = new Store({ sealer: stale.sealer });
  const write = (next: string) => {
    fs.writeFileSync(path.join(repoDir, FILE), next);
    const future = new Date(Date.now() + Math.random() * 1e6 + 1000);
    fs.utimesSync(path.join(repoDir, FILE), future, future);
  };
  const refsOf = (id: string) => store.snapshot().model.elements.find((e) => e.id === id)!.codeRefs;
  return { repoDir, stale, store, write, refsOf };
}

/** The scenario from the trials: refs on elements, a relation and flow steps, some with only a line range. */
function seedShop(store: Store) {
  store.apply(
    {
      summary: 'Model routes',
      elements: [
        {
          id: 'orders',
          kind: 'component',
          name: 'Orders',
          codeRefs: [
            { path: FILE, symbol: 'listOrders', startLine: 3, endLine: 5 },
            { path: FILE, symbol: 'createOrder', startLine: 7, endLine: 10 },
            { path: FILE, startLine: 12, note: 'GET /orders' },
            { path: FILE, startLine: 13, note: 'POST /orders' },
            // The symbol is still inside 1..10 after five lines are added on top: the old checks accepted it.
            { path: FILE, symbol: 'listOrders', startLine: 1, endLine: 10 },
          ],
        },
        { id: 'db', kind: 'store', name: 'DB', codeRefs: [{ path: FILE, startLine: 4 }] },
      ],
      relations: [{ id: 'orders-writes-db', from: 'orders', to: 'db', kind: 'writes', codeRefs: [{ path: FILE, startLine: 9 }] }],
      flows: [
        {
          id: 'place-order',
          name: 'Place order',
          steps: [
            { from: 'orders', to: 'orders', label: 'route', codeRefs: [{ path: FILE, startLine: 13 }] },
            { from: 'orders', to: 'db', label: 'insert', codeRefs: [{ path: FILE, symbol: 'createOrder', startLine: 7, endLine: 10 }, { path: FILE, startLine: 9 }] },
          ],
        },
      ],
    },
    'agent',
  );
}

describe('sealing code refs', () => {
  it('stores a short digest of the linked lines when a ref with a line range is written, ignoring a sent one', () => {
    const { store, refsOf } = setup();
    const result = store.apply(
      {
        elements: [
          {
            id: 'orders',
            kind: 'component',
            name: 'Orders',
            codeRefs: [
              { path: FILE, symbol: 'listOrders', startLine: 3, endLine: 5, digest: 'forged' },
              { path: FILE, symbol: 'listOrders' },
              { path: './src/routes.ts', startLine: 12 },
            ],
          },
        ],
      },
      'agent',
    );
    expect(result.warnings).toEqual([]);
    const [fn, plain, route] = refsOf('orders');
    expect(fn!.digest).toBe(digestText(lines(ROUTES, 3, 5)));
    expect(fn!.digest).toMatch(new RegExp(`^[A-Za-z0-9_-]{${DIGEST_LENGTH}}$`));
    expect(plain!.digest).toBeUndefined();
    expect(route).toEqual({ path: FILE, startLine: 12, digest: digestText(lines(ROUTES, 12, 12)) });
    expect((canonicalModel(store.snapshot().model) as any).elements[0].codeRefs[0].digest).toBe(fn!.digest);
  });

  it('ignores whitespace at the ends of lines and line endings', () => {
    expect(digestText('export function a() {\n  return 1;\n}')).toBe(digestText('  export function a() {   \r\n\treturn 1;\r\n}\n'));
    expect(digestText('return 1;')).not.toBe(digestText('return 2;'));
  });

  it('stores no digest without a readable range, and without a repository', () => {
    const { store, refsOf } = setup();
    const result = store.apply({ elements: [{ id: 'x', kind: 'module', name: 'X', codeRefs: [{ path: FILE, startLine: 99 }, { path: 'src/nope.ts', startLine: 1 }] }] }, 'agent');
    expect(refsOf('x').map((r) => r.digest)).toEqual([undefined, undefined]);
    expect(result.warnings).toEqual([
      expect.stringMatching(/`src\/routes\.ts` lines 99: the line range is past the end of the file/),
      expect.stringMatching(/`src\/nope\.ts` lines 1: the file does not exist/),
    ]);

    const bare = new Store();
    bare.apply({ elements: [{ id: 'x', kind: 'module', name: 'X', codeRefs: [{ path: FILE, startLine: 1, digest: 'forged' }] }] }, 'agent');
    expect(bare.snapshot().model.elements[0]!.codeRefs).toEqual([{ path: FILE, startLine: 1 }]);
  });

  it('warns when a symbol does not occur within its range, and says what to do for string-registered names', () => {
    const { store } = setup();
    const result = store.apply({ elements: [{ id: 'x', kind: 'module', name: 'X', codeRefs: [{ path: FILE, symbol: '/orders', startLine: 12 }, { path: FILE, symbol: 'createOrder', startLine: 3, endLine: 5 }] }] }, 'agent');
    expect(result.warnings).toHaveLength(2);
    expect(result.warnings[1]).toMatch(/`createOrder` does not occur within lines 3–5\. A symbol must literally occur in its range; for things registered by a string name/);
  });

  it('keeps seals when a client sends back the list it read, and re-seals a ref sent again in addCodeRefs', async () => {
    const { store, write, stale, refsOf } = setup();
    seedShop(store);
    const sealed = refsOf('orders')[0]!;
    const stepSeal = store.snapshot().model.flows[0]!.steps[1]!.codeRefs[0]!.digest;
    expect(stepSeal).toBeDefined();
    write(ROUTES.replace('return db.orders.all();', 'return db.orders.all({ limit: 50 });'));

    // The UI resends whole lists as it read them, here with a new note; that must not accept the edit.
    store.apply({ elements: [{ id: 'orders', codeRefs: refsOf('orders').map((r, i) => (i === 0 ? { ...r, note: 'list' } : r)) }] }, 'human');
    expect(refsOf('orders')[0]).toEqual({ ...sealed, note: 'list' });
    store.apply({ flows: [{ id: 'place-order', steps: store.snapshot().model.flows[0]!.steps.map((s) => ({ ...s, label: `${s.label}!` })) }] }, 'human');
    expect(store.snapshot().model.flows[0]!.steps[1]!.codeRefs[0]!.digest).toBe(stepSeal);

    expect((await stale.check(store.snapshot().model)).map((l) => [l.ownerId, l.ref.startLine, l.reason])).toEqual([
      ['orders', 3, 'changed'],
      ['orders', 1, 'changed'],
      ['db', 4, 'changed'],
    ]);
    const accepted = store.apply({ elements: [{ id: 'orders', addCodeRefs: [{ path: FILE, symbol: 'listOrders', startLine: 3, endLine: 5 }] }] }, 'agent');
    expect(accepted.updated.elements).toEqual(['orders']);
    expect(refsOf('orders')).toHaveLength(5);
    expect(refsOf('orders')[0]).toMatchObject({ note: 'list', digest: digestText('export function listOrders() {\nreturn db.orders.all({ limit: 50 });\n}') });
    expect((await stale.check(store.snapshot().model)).map((l) => [l.ownerId, l.ref.startLine])).toEqual([
      ['orders', 1],
      ['db', 4],
    ]);
  });

  it('seals afresh a ref written without its stored digest, or with a forged one', () => {
    const { store, write, refsOf } = setup();
    seedShop(store);
    const edited = ROUTES.replace('return db.orders.all();', 'return [];');
    write(edited);
    const fresh = digestText(lines(edited, 3, 5));
    store.apply({ elements: [{ id: 'orders', codeRefs: refsOf('orders').map((r, i) => (i === 0 ? { ...r, digest: 'forged' } : r)) }] }, 'agent');
    expect(refsOf('orders')[0]!.digest).toBe(fresh);
    store.apply({ elements: [{ id: 'db', codeRefs: [{ path: FILE, startLine: 4 }] }] }, 'agent');
    expect(refsOf('db')[0]!.digest).toBe(digestText('return [];'));
  });

  it('does not hand a ref the seal of another ref that used to sit on its new line', () => {
    const { store, write, refsOf } = setup();
    seedShop(store);
    const [, , get, post] = refsOf('orders');
    write(ROUTES.replace("app.get('/orders', listOrders);", "app.get('/orders', listOrders);\napp.get('/orders/:id', getOrder);"));
    // GET moves onto line 13, where POST was; POST moves on to 14.
    store.apply({ elements: [{ id: 'orders', codeRefs: refsOf('orders').map((r) => (r === get ? { ...r, startLine: 13 } : r === post ? { ...r, startLine: 14 } : r)) }] }, 'agent');
    expect(refsOf('orders')[2]).toMatchObject({ startLine: 13, digest: digestText("app.get('/orders/:id', getOrder);") });
    expect(refsOf('orders')[3]).toMatchObject({ startLine: 14, digest: post!.digest });
  });

  it('re-seals a flow step ref sent again through updateSteps', async () => {
    const { store, write, stale } = setup();
    seedShop(store);
    write(ROUTES.replace('  return db.orders.insert(input);', '  return db.orders.insert(normalize(input));'));
    const before = await stale.check(store.snapshot().model);
    expect(before.filter((l) => l.ownerType === 'flow').map((l) => [l.step, l.ref.startLine, l.reason])).toEqual([
      [2, 7, 'changed'],
      [2, 9, 'changed'],
    ]);
    store.apply({ flows: [{ id: 'place-order', updateSteps: [{ index: 1, addCodeRefs: [{ path: FILE, startLine: 9 }] }] }] }, 'agent');
    const after = await stale.check(store.snapshot().model);
    expect(after.filter((l) => l.ownerType === 'flow').map((l) => [l.step, l.ref.startLine, l.reason])).toEqual([[2, 7, 'changed']]);
  });

  it('does not seal refs from before sealing when a list is resent', () => {
    const repoDir = tempRepo({ [FILE]: ROUTES });
    const stale = new StaleLinks(new Repo(repoDir));
    const store = new Store({ sealer: stale.sealer, model: { elements: [{ id: 'orders', kind: 'component', name: 'Orders', codeRefs: [{ path: FILE, startLine: 3, endLine: 5 }] }] } });
    store.apply({ elements: [{ id: 'orders', codeRefs: [{ path: FILE, startLine: 3, endLine: 5, note: 'n' }] }] }, 'human');
    expect(store.snapshot().model.elements[0]!.codeRefs).toEqual([{ path: FILE, startLine: 3, endLine: 5, note: 'n' }]);
  });
});

describe('checking sealed refs', () => {
  it('reports every ref shifted by an insertion as moved, with the new lines', async () => {
    const { store, write, stale } = setup();
    seedShop(store);
    write([...INSERTED, ROUTES].join('\n'));
    const links = await stale.check(store.snapshot().model);
    expect(links.map((l) => [l.ownerType, l.step ?? null, l.ref.startLine, l.reason, l.suggestion])).toEqual([
      ['element', null, 3, 'moved', { startLine: 8, endLine: 10 }],
      ['element', null, 7, 'moved', { startLine: 12, endLine: 15 }],
      ['element', null, 12, 'moved', { startLine: 17, endLine: 17 }],
      ['element', null, 13, 'moved', { startLine: 18, endLine: 18 }],
      ['element', null, 1, 'moved', { startLine: 6, endLine: 15 }],
      ['element', null, 4, 'moved', { startLine: 9, endLine: 9 }],
      ['relation', null, 9, 'moved', { startLine: 14, endLine: 14 }],
      ['flow', 1, 13, 'moved', { startLine: 18, endLine: 18 }],
      ['flow', 2, 7, 'moved', { startLine: 12, endLine: 15 }],
      ['flow', 2, 9, 'moved', { startLine: 14, endLine: 14 }],
    ]);
  });

  it('prefers the nearest copy, and requires the symbol inside the window', async () => {
    const block = ['export function one() {', '  return 1;', '}', '', 'export function two() {', '  return 2;', '}', ''];
    const { store, write, stale, refsOf } = setup(block.join('\n'));
    store.apply(
      {
        elements: [
          {
            id: 'x',
            kind: 'module',
            name: 'X',
            codeRefs: [
              { path: FILE, startLine: 7 }, // "}" closing two()
              { path: FILE, symbol: 'two', startLine: 5, endLine: 7 },
            ],
          },
        ],
      },
      'agent',
    );
    expect(refsOf('x')[1]!.digest).toBeDefined();
    write(['// header', ...block].join('\n'));
    const links = await stale.check(store.snapshot().model);
    // "}" sits on lines 4 and 8 now: the nearest to 7 is 8.
    expect(links.map((l) => [l.ref.startLine, l.reason, l.suggestion])).toEqual([
      [7, 'moved', { startLine: 8, endLine: 8 }],
      [5, 'moved', { startLine: 6, endLine: 8 }],
    ]);
  });

  it('does not report a moved window that lacks the symbol', async () => {
    const content = ['export function gamma() {', '}', '', 'function other() {', '}', ''].join('\n');
    const { store, write, stale } = setup(content);
    // Sealed while already inconsistent: the symbol is on line 1, the range is the "}" on line 2.
    store.apply({ elements: [{ id: 'x', kind: 'module', name: 'X', codeRefs: [{ path: FILE, startLine: 2 }, { path: FILE, symbol: 'gamma', startLine: 2 }] }] }, 'agent');
    write(['// one', '// two', '// three', content].join('\n'));
    const links = await stale.check(store.snapshot().model);
    expect(links.map((l) => [l.ref.symbol ?? null, l.reason, l.suggestion])).toEqual([
      [null, 'moved', { startLine: 5, endLine: 5 }],
      ['gamma', 'changed', { startLine: 4, endLine: 4 }],
    ]);
  });

  it('reports edited code as changed, suggesting where the symbol is now only when that is clear', async () => {
    const { store, write, stale } = setup();
    store.apply(
      {
        elements: [
          {
            id: 'x',
            kind: 'module',
            name: 'X',
            codeRefs: [
              { path: FILE, symbol: 'listOrders', startLine: 3, endLine: 5 },
              { path: FILE, symbol: 'createOrder', startLine: 7, endLine: 10 },
              { path: FILE, startLine: 12 },
              { path: FILE, symbol: 'validate', startLine: 8 },
            ],
          },
        ],
      },
      'agent',
    );
    const edited = ROUTES.replace('return db.orders.all();', 'return db.orders.all(1);') // listOrders edited in place
      .replace('export function createOrder(input) {\n  validate(input);', '// moved below\n// a\n// b\n// c\n\nexport function createOrder(input) {\n  check(input);') // createOrder edited and shifted
      .replace("app.get('/orders', listOrders);", "app.get('/v2/orders', listOrders);"); // route edited
    write(edited);
    const links = await stale.check(store.snapshot().model);
    expect(links.map((l) => [l.ref.symbol ?? l.ref.startLine, l.reason, l.suggestion ?? null])).toEqual([
      ['listOrders', 'changed', null],
      // "createOrder" occurs twice (declaration and route); the declaration wins.
      ['createOrder', 'changed', { startLine: 12, endLine: 15 }],
      [12, 'changed', null],
      ['validate', 'symbol-not-found', null],
    ]);
  });

  it('reports lines past the end of a shrunk file when the text is gone', async () => {
    const { store, write, stale } = setup();
    store.apply({ elements: [{ id: 'x', kind: 'module', name: 'X', codeRefs: [{ path: FILE, startLine: 13 }] }] }, 'agent');
    write(ROUTES.split('\n').slice(0, 10).join('\n'));
    expect((await stale.check(store.snapshot().model)).map((l) => l.reason)).toEqual(['line-out-of-range']);
  });
});

describe('repairCodeLinks', () => {
  it('re-anchors moved refs on elements, relations and flow steps in one journaled change, leaving changed ones', async () => {
    const { store, write, stale, refsOf } = setup();
    seedShop(store);
    write([...INSERTED, ROUTES.replace("app.post('/orders', createOrder);", "app.post('/orders', auth, createOrder);")].join('\n'));
    const result = await repairCodeLinks(store, stale, { actor: 'agent' });
    expect(result.summary).toBe('Re-anchored 8 code links in src/routes.ts');
    expect(result.sealed).toBe(0);
    expect(result.repaired).toContainEqual({ ownerType: 'flow', ownerId: 'place-order', step: 2, path: FILE, symbol: 'createOrder', from: { startLine: 7, endLine: 10 }, to: { startLine: 12, endLine: 15 } });
    expect(result.stale.map((l) => [l.ownerType, l.step ?? null, l.ref.startLine, l.reason])).toEqual([
      ['element', null, 13, 'changed'],
      ['flow', 1, 13, 'changed'],
    ]);
    expect(store.journal().at(-1)).toMatchObject({ actor: 'agent', summary: result.summary, updated: { elements: ['orders', 'db'], relations: ['orders-writes-db'], flows: ['place-order'] } });
    expect(refsOf('orders').map((r) => [r.startLine, r.endLine ?? null, r.note ?? null])).toEqual([
      [8, 10, null],
      [12, 15, null],
      [17, null, 'GET /orders'],
      [13, null, 'POST /orders'],
      [6, 15, null],
    ]);
    expect(refsOf('orders').every((r) => r.digest)).toBe(true);
    expect((await stale.check(store.snapshot().model)).map((l) => l.reason)).toEqual(['changed', 'changed']);

    const again = await repairCodeLinks(store, stale, { actor: 'agent' });
    expect(again).toMatchObject({ repaired: [], sealed: 0, revision: result.revision });
    expect(again.summary).toBeUndefined();
    expect(store.undo()).toBeDefined();
    expect(refsOf('orders')[0]!.startLine).toBe(3);
  });

  it('seals refs from before sealing that pass every check, and only those', async () => {
    const repoDir = tempRepo({ [FILE]: ROUTES });
    const stale = new StaleLinks(new Repo(repoDir));
    const refs: CodeRef[] = [
      { path: FILE, symbol: 'listOrders', startLine: 3, endLine: 5 },
      { path: FILE, startLine: 12 },
      { path: FILE, symbol: 'createOrder', startLine: 1, endLine: 2 }, // symbol outside range
      { path: FILE, startLine: 40 }, // past the end
      { path: FILE }, // no range: nothing to seal
    ];
    const store = new Store({ sealer: stale.sealer, model: { elements: [{ id: 'x', kind: 'module', name: 'X', codeRefs: refs }] } });
    const result = await repairCodeLinks(store, stale, { actor: 'agent' });
    expect(result).toMatchObject({ summary: 'Sealed 2 code links', sealed: 2, repaired: [] });
    expect(result.stale.map((l) => l.reason)).toEqual(['symbol-outside-range', 'line-out-of-range']);
    expect(store.snapshot().model.elements[0]!.codeRefs.map((r) => !!r.digest)).toEqual([true, true, false, false, false]);
    expect((await repairCodeLinks(store, stale, { actor: 'agent' })).sealed).toBe(0);
  });

  it('stays within a scope', async () => {
    const { store, write, stale, refsOf } = setup();
    seedShop(store);
    write([...INSERTED, ROUTES].join('\n'));
    const result = await repairCodeLinks(store, stale, { actor: 'human', scopeId: 'db' });
    // db's own ref, the relation touching db, and the flow step touching db.
    expect(result.repaired.map((r) => [r.ownerType, r.ownerId, r.step ?? null])).toEqual([
      ['element', 'db', null],
      ['relation', 'orders-writes-db', null],
      ['flow', 'place-order', 2],
      ['flow', 'place-order', 2],
    ]);
    expect(refsOf('orders')[0]!.startLine).toBe(3);
    expect(store.journal().at(-1)!.actor).toBe('human');
  });
});
