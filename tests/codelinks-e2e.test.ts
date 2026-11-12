import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ArchWeave, createArchWeave, type Running } from '../src/server/app.ts';
import { configFromEnv } from '../src/server/config.ts';
import { tempRepo } from './helpers.ts';

const run = promisify(execFile);

const ROUTES = [
  "import { app } from './app';",
  '',
  'export function listOrders() {',
  '  return db.orders.all();',
  '}',
  '',
  'export function createOrder(input) {',
  '  validate(input);',
  '  return db.orders.insert(input);',
  '}',
  '',
  "app.get('/orders', listOrders);",
  "app.post('/orders', createOrder);",
  '',
].join('\n');
const FILE = 'src/routes.ts';

let repoDir: string;
let archweave: ArchWeave;
let running: Running;
let client: Client;

async function call(name: string, args: Record<string, unknown> = {}): Promise<any> {
  const result = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: { text: string }[] };
  if (result.isError) throw new Error(result.content[0]!.text);
  return JSON.parse(result.content[0]!.text);
}

function edit(content: string): void {
  const file = path.join(repoDir, FILE);
  fs.writeFileSync(file, content);
  const future = new Date(Date.now() + Math.random() * 1e6 + 1000);
  fs.utimesSync(file, future, future);
}

function checks(found: any): [string, number | null, number, string, unknown][] {
  const rows: [string, number | null, number, string, unknown][] = [];
  for (const e of found.elements) for (const r of e.codeRefs) rows.push([e.id, null, r.startLine, r.check, r.suggestion ?? null]);
  for (const rel of found.relations) for (const r of rel.codeRefs) rows.push([rel.id, null, r.startLine, r.check, r.suggestion ?? null]);
  for (const s of found.flowSteps) for (const r of s.codeRefs) rows.push([s.flowId, s.step, r.startLine, r.check, r.suggestion ?? null]);
  return rows;
}

beforeAll(async () => {
  repoDir = tempRepo({ [FILE]: ROUTES });
  const config = { ...configFromEnv({ ARCHWEAVE_REPO_DIR: repoDir }), port: 0, webDir: path.join(repoDir, 'no-web') };
  archweave = await createArchWeave(config, { debounceMs: 10, log: () => undefined });
  running = await archweave.listen();
  client = new Client({ name: 'codelinks-agent', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${running.url}/mcp`)));
});

afterAll(async () => {
  await client?.close();
  await running?.close();
});

describe('keeping code links anchored through MCP', () => {
  it('seals refs when the agent models the code, and persists the seals', async () => {
    const result = await call('apply_changes', {
      summary: 'Model order routes',
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
          ],
        },
        { id: 'db', kind: 'store', name: 'Orders DB' },
        { id: 'customer', kind: 'actor', name: 'Customer' },
      ],
      relations: [{ id: 'orders-writes-db', from: 'orders', to: 'db', kind: 'writes', codeRefs: [{ path: FILE, startLine: 9 }] }],
      flows: [{ id: 'place-order', name: 'Place order', steps: [{ from: 'orders', to: 'db', label: 'insert', codeRefs: [{ path: FILE, symbol: 'createOrder', startLine: 7, endLine: 10 }] }] }],
    });
    expect(result.warnings).toEqual([]);
    const element = await call('get_element', { id: 'orders' });
    expect(element.codeRefs.every((r: any) => typeof r.digest === 'string')).toBe(true);
    expect((await call('get_element', { id: 'customer' })).status).toBe('built');
    await archweave.persistence.flush();
    const saved = JSON.parse(fs.readFileSync(path.join(repoDir, '.archweave/model.json'), 'utf8'));
    expect(saved.elements.find((e: any) => e.id === 'orders').codeRefs[0].digest).toBe(element.codeRefs[0].digest);
  });

  it('runs the loop: edit the file, find_by_code shows what moved, repair re-anchors it, the agent accepts what changed', async () => {
    // Five lines on top shift everything; the POST route is edited too.
    edit(['// one', '// two', '// three', '// four', '// five', ROUTES.replace("app.post('/orders', createOrder);", "app.post('/orders', auth, createOrder);")].join('\n'));

    const found = await call('find_by_code', { paths: [FILE] });
    expect(checks(found)).toEqual([
      ['orders', null, 3, 'moved', { startLine: 8, endLine: 10 }],
      ['orders', null, 7, 'moved', { startLine: 12, endLine: 15 }],
      ['orders', null, 12, 'moved', { startLine: 17, endLine: 17 }],
      ['orders', null, 13, 'changed', null],
      ['orders-writes-db', null, 9, 'moved', { startLine: 14, endLine: 14 }],
      ['place-order', 1, 7, 'moved', { startLine: 12, endLine: 15 }],
    ]);
    expect(found.codeLinks).toEqual({ moved: 5, changed: 1 });
    expect(found.hint).toMatch(/repair: true/);

    const plain = await call('check_code_links');
    expect(plain.stale.map((l: any) => l.reason)).toEqual(['moved', 'moved', 'moved', 'changed', 'moved', 'moved']);
    expect(plain.stale.at(-1)).toMatchObject({ ownerType: 'flow', ownerId: 'place-order', step: 1, ownerName: 'Place order' });
    const revision = (await call('get_changes')).revision;

    const repaired = await call('check_code_links', { repair: true });
    expect(repaired).toMatchObject({ revision: revision + 1, summary: 'Re-anchored 5 code links in src/routes.ts' });
    expect(repaired.repaired).toHaveLength(5);
    expect(repaired.repaired[0]).toEqual({ ownerType: 'element', ownerId: 'orders', path: FILE, symbol: 'listOrders', from: { startLine: 3, endLine: 5 }, to: { startLine: 8, endLine: 10 }, ownerName: 'Orders' });
    expect(repaired.stale).toMatchObject([{ ownerId: 'orders', reason: 'changed', ref: { startLine: 13, note: 'POST /orders' } }]);
    const { entries } = await call('get_changes', { since: revision });
    expect(entries).toMatchObject([{ actor: 'agent', summary: 'Re-anchored 5 code links in src/routes.ts', updated: { elements: ['orders'], relations: ['orders-writes-db'], flows: ['place-order'] } }]);

    expect(checks(await call('find_by_code', { paths: ['src'] })).filter((row) => row[3] !== 'ok')).toEqual([['orders', null, 13, 'changed', null]]);

    // The agent reads the code: the POST route now sits on line 18. It points the ref there; the new range is sealed afresh.
    await call('apply_changes', {
      summary: 'Point the POST route at its new line',
      elements: [{ id: 'orders', removeCodeRefs: [{ path: FILE, startLine: 13 }], addCodeRefs: [{ path: FILE, startLine: 18, note: 'POST /orders' }] }],
    });
    const after = await call('find_by_code', { paths: [FILE] });
    expect(after.codeLinks).toEqual({ ok: 6 });
    expect(after.hint).toBeUndefined();
    expect(after.elements[0].codeRefs.at(-1)).toMatchObject({ startLine: 18, note: 'POST /orders', digest: expect.any(String), check: 'ok' });
  });

  it('lets the agent accept code edited in place by re-sending the ref', async () => {
    const current = fs.readFileSync(path.join(repoDir, FILE), 'utf8');
    edit(current.replace('return db.orders.all();', 'return db.orders.all({ limit: 100 });'));
    const found = await call('find_by_code', { paths: [FILE] });
    expect(checks(found).filter((row) => row[3] !== 'ok')).toEqual([['orders', null, 8, 'changed', null]]);
    expect(found.hint).toMatch(/re-send a ref without its digest in addCodeRefs/);
    const repair = await call('check_code_links', { repair: true });
    expect(repair).toMatchObject({ repaired: [], stale: [{ reason: 'changed' }] });
    expect(repair.summary).toBeUndefined();

    await call('apply_changes', { summary: 'Accept edited listOrders', elements: [{ id: 'orders', addCodeRefs: [{ path: FILE, symbol: 'listOrders', startLine: 8, endLine: 10 }] }] });
    expect((await call('find_by_code', { paths: [FILE] })).codeLinks).toEqual({ ok: 6 });
    expect((await call('check_code_links')).stale).toEqual([]);
  });

  it('repairs over REST as the human', async () => {
    const response = await fetch(`${running.url}/api/code/repair`, { method: 'POST' });
    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result).toMatchObject({ repaired: [], stale: [] });
    edit(['// zero', fs.readFileSync(path.join(repoDir, FILE), 'utf8')].join('\n'));
    const moved = await fetch(`${running.url}/api/code/repair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }).then((r) => r.json());
    expect(moved.summary).toBe('Re-anchored 6 code links in src/routes.ts');
    expect(moved.revision).toBe(result.revision + 1);
    const journal = await fetch(`${running.url}/api/journal?since=${result.revision}`).then((r) => r.json());
    expect(journal).toMatchObject([{ actor: 'human', summary: moved.summary }]);
    expect(await fetch(`${running.url}/api/code/stale`).then((r) => r.json())).toEqual([]);

    const scoped = await fetch(`${running.url}/api/code/repair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ scopeId: 'nope' }) });
    expect(scoped.status).toBe(400);
  });

  it('applies nothing when a change set was built from another revision: 409 over REST, a tool error over MCP', async () => {
    const post = (body: unknown) => fetch(`${running.url}/api/changes`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const { revision } = await fetch(`${running.url}/api/health`).then((r) => r.json());
    const stale = await post({ expectedRevision: revision - 1, elements: [{ id: 'db', summary: 'Stale write.' }] });
    expect(stale.status).toBe(409);
    expect((await stale.json()).error).toMatch(/The model changed since revision \d+ \(it is at revision \d+ now\)\. Nothing was applied; read it again and retry\./);
    await expect(call('apply_changes', { summary: 'Stale', expectedRevision: revision - 1, elements: [{ id: 'db', summary: 'Stale write.' }] })).rejects.toThrow(/The model changed since revision/);
    expect((await call('get_element', { id: 'db' })).summary).toBeUndefined();
    // Layout-only change sets ignore it.
    expect((await post({ expectedRevision: revision - 1, layout: { 'structure:root': { db: { x: 1, y: 2 } } } })).status).toBe(200);
    const fresh = await post({ expectedRevision: revision, elements: [{ id: 'db', summary: 'Holds orders.' }] });
    expect(fresh.status).toBe(200);
    expect((await fresh.json()).revision).toBe(revision + 1);
  });

  it('pretty-prints results from mcp-call.mjs only on a terminal or when asked', async () => {
    const script = path.join(import.meta.dirname, '..', 'scripts', 'mcp-call.mjs');
    const args = [script, 'get_element', '{"id":"db"}'];
    const env: NodeJS.ProcessEnv = { ...process.env, ARCHWEAVE_URL: running.url };
    delete env.ARCHWEAVE_PRETTY;
    const piped = await run(process.execPath, args, { env });
    expect(piped.stdout.trim().split('\n')).toHaveLength(1);
    expect(JSON.parse(piped.stdout)).toMatchObject({ id: 'db' });
    const pretty = await run(process.execPath, args, { env: { ...env, ARCHWEAVE_PRETTY: '1' } });
    expect(pretty.stdout).toContain('\n  "id": "db",\n');
    expect(JSON.parse(pretty.stdout)).toEqual(JSON.parse(piped.stdout));
  });
});
