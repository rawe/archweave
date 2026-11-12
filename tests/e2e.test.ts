import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ArchWeave, createArchWeave, type Running } from '../src/server/app.ts';
import { configFromEnv } from '../src/server/config.ts';
import { tempRepo, waitFor } from './helpers.ts';

const ORDERS = ['export function createOrder(cart) {', '  return charge(cart);', '}', ''].join('\n');
const BILLING = ['export function charge(cart) {', '  return { ok: true };', '}', ''].join('\n');

let repoDir: string;
let archweave: ArchWeave;
let running: Running;
let client: Client;
let events: SseReader;

interface SseEvent {
  event: string;
  data: any;
}

/** Minimal SSE consumer over fetch. */
class SseReader {
  received: SseEvent[] = [];
  private controller = new AbortController();

  async open(url: string): Promise<void> {
    const response = await fetch(url, { signal: this.controller.signal });
    expect(response.headers.get('content-type')).toMatch(/text\/event-stream/);
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    void (async () => {
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) return;
          buffer += decoder.decode(value, { stream: true });
          let cut: number;
          while ((cut = buffer.indexOf('\n\n')) >= 0) {
            const chunk = buffer.slice(0, cut);
            buffer = buffer.slice(cut + 2);
            const event = chunk.match(/^event: (.*)$/m)?.[1];
            const data = chunk
              .split('\n')
              .filter((l) => l.startsWith('data: '))
              .map((l) => l.slice(6))
              .join('\n');
            if (event) this.received.push({ event, data: JSON.parse(data) });
          }
        }
      } catch {
        /* aborted */
      }
    })();
  }

  next(name: string, after = 0): Promise<SseEvent> {
    return waitFor(() => this.received.slice(after).find((e) => e.event === name));
  }

  close(): void {
    this.controller.abort();
  }
}

async function call(name: string, args: Record<string, unknown> = {}): Promise<any> {
  const result = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: { type: string; text: string }[] };
  if (result.isError) throw new Error(result.content[0]!.text);
  const text = result.content[0]!.text;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function callError(name: string, args: Record<string, unknown>): Promise<string> {
  const result = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: { text: string }[] };
  expect(result.isError).toBe(true);
  return result.content[0]!.text;
}

async function api(method: string, route: string, body?: unknown): Promise<{ status: number; json: any; text: string; headers: Headers }> {
  const response = await fetch(`${running.url}${route}`, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { status: response.status, json, text, headers: response.headers };
}

function rawRequest(pathname: string, headers: Record<string, string>): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: running.port, path: pathname, method: 'GET', headers }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on('error', reject);
    req.end();
  });
}

beforeAll(async () => {
  repoDir = tempRepo({ 'src/orders/service.ts': ORDERS, 'src/billing/charge.ts': BILLING, 'web/app.tsx': 'export const App = () => null;\n' });
  const config = { ...configFromEnv({ ARCHWEAVE_REPO_DIR: repoDir }), port: 0, webDir: path.join(repoDir, 'no-web') };
  archweave = await createArchWeave(config, { debounceMs: 10, log: () => undefined });
  running = await archweave.listen();
  events = new SseReader();
  await events.open(`${running.url}/api/events`);
  client = new Client({ name: 'e2e-agent', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${running.url}/mcp`)));
});

afterAll(async () => {
  events?.close();
  await client?.close();
  await running?.close();
});

describe('ArchWeave end to end', () => {
  it('sends a snapshot when a browser connects', async () => {
    const first = await events.next('snapshot');
    expect(first.data.snapshot).toMatchObject({ revision: 0, model: { name: path.basename(repoDir), elements: [] } });
  });

  it('offers the tools and the guide', async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(
      ['apply_changes', 'check_code_links', 'export', 'find_by_code', 'focus_ui', 'get_changes', 'get_context', 'get_element', 'get_guide', 'get_model', 'search'].sort(),
    );
    expect(client.getInstructions()).toContain('Model in levels');
    expect(await call('get_guide')).toContain('find_by_code');
  });

  it('marks the agent present with its client name', async () => {
    const { json } = await api('GET', '/api/session');
    expect(json.agent).toMatchObject({ connected: true, clientName: 'e2e-agent' });
    expect(json.repo).toEqual({ name: path.basename(repoDir) });
  });

  it('builds a model through apply_changes and broadcasts it', async () => {
    const before = events.received.length;
    const result = await call('apply_changes', {
      summary: 'Model the shop',
      elements: [
        { id: 'web', kind: 'app', name: 'Web app', summary: 'Storefront.', codeRefs: [{ path: 'web/app.tsx', symbol: 'App' }] },
        { id: 'api', kind: 'service', name: 'Order API', summary: 'Takes orders.', codeRefs: [{ path: 'src' }] },
        { id: 'orders', kind: 'component', name: 'Orders', parentId: 'api', codeRefs: [{ path: 'src/orders/service.ts', symbol: 'createOrder', startLine: 1, endLine: 3 }] },
        { id: 'billing', kind: 'component', name: 'Billing', parentId: 'api', codeRefs: [{ path: 'src/billing/charge.ts', symbol: 'charge' }] },
        { id: 'order', kind: 'data', name: 'Order', parentId: 'orders', fields: [{ name: 'id', type: 'uuid' }] },
      ],
      relations: [
        { from: 'web', to: 'orders', kind: 'calls', label: 'places order', dataIds: ['order'] },
        { from: 'orders', to: 'billing', kind: 'calls', label: 'charges' },
      ],
      flows: [{ name: 'Place order', steps: [{ from: 'web', to: 'orders', label: 'submit' }, { from: 'orders', to: 'billing', label: 'charge' }] }],
    });
    expect(result).toMatchObject({
      revision: 1,
      created: { elements: ['web', 'api', 'orders', 'billing', 'order'], relations: ['web-calls-orders', 'orders-calls-billing'], flows: ['place-order'] },
      warnings: [],
    });
    const broadcast = await events.next('snapshot', before);
    expect(broadcast.data.entry).toMatchObject({ revision: 1, actor: 'agent', summary: 'Model the shop' });
    const { json } = await api('GET', '/api/snapshot');
    expect(json.model.elements.find((e: any) => e.id === 'order').status).toBe('planned');
    expect(json.model.elements.find((e: any) => e.id === 'orders').status).toBe('built');
  });

  it('rejects a broken change set with an actionable error', async () => {
    const message = await callError('apply_changes', { summary: 'Bad', relations: [{ from: 'orders', to: 'biling' }] });
    expect(message).toContain('unknown element `biling` in `to`. Did you mean `billing`?');
    const missingSummary = await callError('apply_changes', { elements: [{ kind: 'app', name: 'X' }] });
    expect(missingSummary).toMatch(/summary/);
    expect((await api('GET', '/api/snapshot')).json.revision).toBe(1);
  });

  it('hands the human selection to the agent fully expanded', async () => {
    const put = await api('PUT', '/api/session/ui', { perspective: 'structure', scopeId: 'api', selectedElementIds: ['orders'], selectedRelationIds: ['orders-calls-billing'] });
    expect(put.status).toBe(200);
    const context = await call('get_context');
    expect(context.ui).toMatchObject({ perspective: 'structure', scope: { id: 'api', name: 'Order API' }, breadcrumb: [{ id: 'api', name: 'Order API' }] });
    expect(context.ui.visible.map((e: any) => e.id)).toEqual(['orders', 'billing']);
    const [orders] = context.selection.elements;
    expect(orders).toMatchObject({
      id: 'orders',
      name: 'Orders',
      codeRefs: [{ path: 'src/orders/service.ts', symbol: 'createOrder', startLine: 1, endLine: 3 }],
      parentChain: [{ id: 'api', name: 'Order API', kind: 'service' }],
      children: [{ id: 'order', kind: 'data', name: 'Order' }],
      relationsIn: [{ id: 'web-calls-orders', from: { id: 'web', name: 'Web app' }, label: 'places order' }],
      relationsOut: [{ id: 'orders-calls-billing', to: { id: 'billing', name: 'Billing' } }],
      flows: [{ id: 'place-order', steps: [1, 2] }],
    });
    expect(orders.dataTouched).toEqual([
      { id: 'order', name: 'Order', via: 'carried by web-calls-orders, defines' },
    ]);
    expect(context.selection.relations[0]).toMatchObject({ id: 'orders-calls-billing', fromElement: { name: 'Orders' }, toElement: { name: 'Billing' } });
    expect(context.humanChanges).toEqual([]);
    expect(context.staleLinks).toBe(0);
    expect(context.browserConnected).toBe(true);
  });

  it('shows human edits to the agent once', async () => {
    const posted = await api('POST', '/api/changes', { summary: 'Note for the agent', elements: [{ id: 'billing', addNotes: ['Add refunds'] }] });
    expect(posted.status).toBe(200);
    expect(posted.json.updated.elements).toEqual(['billing']);
    const context = await call('get_context');
    expect(context.humanChanges).toMatchObject([{ revision: 2, actor: 'human', summary: 'Note for the agent', updated: { elements: ['billing'] } }]);
    expect(context.openNotes).toMatchObject([{ elementId: 'billing', noteId: 'note-1', author: 'human', text: 'Add refunds' }]);
    expect((await call('get_context')).humanChanges).toEqual([]);
  });

  it('answers REST validation errors with 400 and a message', async () => {
    const bad = await api('POST', '/api/changes', { relations: [{ from: 'web', to: 'nope' }] });
    expect(bad.status).toBe(400);
    expect(bad.json.error).toMatch(/unknown element `nope`/);
    expect((await api('PUT', '/api/session/ui', { perspective: 'sideways' })).status).toBe(400);
  });

  it('finds model entries by code path', async () => {
    const found = await call('find_by_code', { paths: ['src/billing/charge.ts', path.join(repoDir, 'src/orders'), 'docs/x.md'] });
    expect(found.elements.map((e: any) => e.id).sort()).toEqual(['api', 'billing', 'orders']);
    expect(found.unmatchedPaths).toEqual(['docs/x.md']);
  });

  it('reads outline, element detail and search results', async () => {
    const outline = await call('get_model', {});
    expect(outline.elements.map((e: any) => e.id)).toEqual(['web', 'api']);
    expect(outline.elements[1].children.map((e: any) => e.id)).toEqual(['orders', 'billing']);
    expect(outline.counts).toEqual({ elements: 4, data: 1, relations: 2, flows: 1 });
    const flow = await call('get_element', { id: 'place-order' });
    expect(flow.steps[0]).toMatchObject({ from: { name: 'Web app' }, to: { name: 'Orders' } });
    expect(await callError('get_element', { id: 'biling' })).toContain('Did you mean `billing`?');
    const hits = await call('search', { query: 'charge' });
    expect(hits[0]).toMatchObject({ id: 'billing', matchedIn: ['code'] });
  });

  it('asks the browser to focus elements', async () => {
    const before = events.received.length;
    const result = await call('focus_ui', { elementIds: ['billing'], scopeId: 'api', message: 'Refunds go here' });
    expect(result).toMatchObject({ delivered: true, browsers: 1 });
    const focus = await events.next('focus', before);
    expect(focus.data).toEqual({ elementIds: ['billing'], scopeId: 'api', message: 'Refunds go here' });
  });

  it('finds stale code links after the code changes', async () => {
    fs.writeFileSync(path.join(repoDir, 'src/billing/charge.ts'), 'export function bill() {}\n');
    fs.rmSync(path.join(repoDir, 'web/app.tsx'));
    const report = await call('check_code_links', {});
    expect(report.stale.map((l: any) => [l.ownerId, l.ref.path, l.reason]).sort()).toEqual([
      ['billing', 'src/billing/charge.ts', 'symbol-not-found'],
      ['web', 'web/app.tsx', 'missing-file'],
    ]);
    expect((await call('check_code_links', { scopeId: 'api' })).stale).toHaveLength(1);
    expect((await api('GET', '/api/code/stale')).json).toHaveLength(2);
  });

  it('serves repository files read-only and confined', async () => {
    const file = await api('GET', '/api/code/file?path=src/orders/service.ts');
    expect(file.json).toEqual({ path: 'src/orders/service.ts', exists: true, content: ORDERS, lineCount: 3, language: 'typescript' });
    expect((await api('GET', '/api/code/file?path=../../etc/passwd')).status).toBe(400);
    expect((await api('GET', '/api/code/files?q=charge')).json).toEqual(['src/billing/charge.ts']);
  });

  it('exports documentation over REST and MCP', async () => {
    const download = await api('GET', '/api/export?format=markdown&perspectives=structure,flows&code=false');
    expect(download.headers.get('content-disposition')).toMatch(/attachment; filename=".*\.md"/);
    expect(download.text).toContain('```mermaid');
    expect(download.text).not.toContain('src/orders/service.ts');
    expect(await call('export', { format: 'mermaid', scope: 'api' })).toContain('flowchart LR');
    expect((await api('GET', '/api/export?format=pdf')).status).toBe(400);
  });

  it('undoes the last change and journals it', async () => {
    const undo = await api('POST', '/api/undo');
    expect(undo.status).toBe(200);
    const snapshot = (await api('GET', '/api/snapshot')).json;
    expect(snapshot.revision).toBe(undo.json.revision);
    expect(snapshot.model.elements.find((e: any) => e.id === 'billing').notes).toEqual([]);
    const journal = (await api('GET', `/api/journal?since=${undo.json.revision - 1}`)).json;
    expect(journal).toMatchObject([{ actor: 'human', summary: 'Undo: Note for the agent' }]);
    const changes = await call('get_changes', { actor: 'agent' });
    expect(changes.entries.map((e: any) => e.summary)).toEqual(['Model the shop']);
  });

  it('persists to the data directory', async () => {
    await archweave.persistence.flush();
    const saved = JSON.parse(fs.readFileSync(path.join(repoDir, '.archweave/model.json'), 'utf8'));
    expect(saved.elements.map((e: any) => e.id)).toEqual(['api', 'billing', 'order', 'orders', 'web']);
  });

  it('rejects foreign Host and Origin headers', async () => {
    expect(await rawRequest('/mcp', { host: 'evil.example:4317' })).toBe(403);
    expect(await rawRequest('/api/snapshot', { host: 'attacker.test' })).toBe(403);
    expect(await rawRequest('/api/snapshot', { host: `localhost:${running.port}`, origin: 'http://attacker.test' })).toBe(403);
    expect(await rawRequest('/api/snapshot', { host: `localhost:${running.port}`, origin: `http://localhost:5173` })).toBe(200);
  });

  it('answers without a built UI', async () => {
    const root = await api('GET', '/');
    expect(root.status).toBe(200);
    expect(root.text).toContain('web UI is not built');
    expect((await api('GET', '/api/nope')).status).toBe(404);
  });
});
