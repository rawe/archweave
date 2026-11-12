import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ArchWeave, createArchWeave, type Running } from '../src/server/app.ts';
import { configFromEnv } from '../src/server/config.ts';
import { PACKAGE_VERSION, serverVersion } from '../src/server/version.ts';
import { tempDir, tempRepo } from './helpers.ts';

let archweave: ArchWeave;
let running: Running;
let webDir: string;

beforeAll(async () => {
  const repoDir = tempRepo({ 'src/a.ts': '' });
  webDir = tempDir('archweave-web-');
  const config = { ...configFromEnv({ ARCHWEAVE_REPO_DIR: repoDir }), port: 0, webDir };
  archweave = await createArchWeave(config, { debounceMs: 10, log: () => undefined });
  running = await archweave.listen();
});

afterAll(async () => {
  await running?.close();
});

function request(method: string, pathname: string, headers: Record<string, string>, body?: string): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port: running.port, path: pathname, method, headers: { host: `localhost:${running.port}`, ...headers } },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => (text += chunk));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, text }));
      },
    );
    req.on('error', reject);
    req.end(body);
  });
}

const change = JSON.stringify({ elements: [{ id: 'x', kind: 'service', name: 'X' }] });

describe('request guard', () => {
  it('rejects an opaque "null" origin', async () => {
    const res = await request('POST', '/api/changes', { origin: 'null', 'content-type': 'application/json' }, change);
    expect(res.status).toBe(403);
    expect(archweave.store.snapshot().model.elements).toEqual([]);
  });

  it('requires a JSON content type on mutating requests with a body', async () => {
    const plain = await request('POST', '/api/changes', { 'content-type': 'text/plain' }, change);
    expect(plain.status).toBe(415);
    expect((await request('PUT', '/api/session/ui', { 'content-type': 'text/plain;charset=UTF-8' }, '{}')).status).toBe(415);
    expect((await request('POST', '/api/changes', {}, change)).status).toBe(415);
    expect(archweave.store.snapshot().model.elements).toEqual([]);

    const mcp = await request('POST', '/mcp', { 'content-type': 'text/plain', accept: 'application/json, text/event-stream' }, JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }));
    expect(mcp.status).toBe(415);
    expect(archweave.session.agent.connected).toBe(false);

    expect((await request('POST', '/api/changes', { 'content-type': 'application/json; charset=utf-8' }, change)).status).toBe(200);
    expect((await request('POST', '/api/undo', {})).status).toBe(200);
  });
});

describe('health check', () => {
  it('reports status, version and model revision before the web UI is built', async () => {
    expect((await request('GET', '/', {})).text).toContain('web UI is not built');
    const before = await request('GET', '/api/health', {});
    expect(before.status).toBe(200);
    expect(JSON.parse(before.text)).toEqual({ status: 'ok', version: PACKAGE_VERSION, revision: archweave.store.currentRevision });

    const applied = await request('POST', '/api/changes', { 'content-type': 'application/json' }, JSON.stringify({ elements: [{ id: 'health-probe', kind: 'service', name: 'Probe' }] }));
    expect(applied.status).toBe(200);
    expect(JSON.parse((await request('GET', '/api/health', {})).text).revision).toBe(JSON.parse(applied.text).revision);
  });
});

describe('version', () => {
  it('comes from ARCHWEAVE_VERSION when set, else from package.json', async () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, '..', 'package.json'), 'utf8'));
    expect(PACKAGE_VERSION).toBe(pkg.version);
    expect(serverVersion({})).toBe(pkg.version);
    expect(serverVersion({ ARCHWEAVE_VERSION: '' })).toBe(pkg.version);
    expect(serverVersion({ ARCHWEAVE_VERSION: '1.2.3' })).toBe('1.2.3');

    const config = { ...configFromEnv({ ARCHWEAVE_REPO_DIR: tempRepo({}), ARCHWEAVE_VERSION: '9.8.7-test' }), port: 0, webDir: tempDir('archweave-web-') };
    const other = await createArchWeave(config, { debounceMs: 10, log: () => undefined });
    const server = await other.listen();
    try {
      const health = await fetch(`${server.url}/api/health`).then((r) => r.json());
      expect(health.version).toBe('9.8.7-test');
      const client = new Client({ name: 'version-probe', version: '1.0.0' });
      await client.connect(new StreamableHTTPClientTransport(new URL(`${server.url}/mcp`)));
      expect(client.getServerVersion()).toMatchObject({ name: 'archweave', version: '9.8.7-test' });
      await client.close();
    } finally {
      await server.close();
    }
  });
});

describe('web UI', () => {
  it('serves the UI once it is built, without a restart', async () => {
    expect((await request('GET', '/', {})).text).toContain('web UI is not built');
    fs.mkdirSync(path.join(webDir, 'assets'));
    fs.writeFileSync(path.join(webDir, 'index.html'), '<!doctype html><title>built</title>');
    fs.writeFileSync(path.join(webDir, 'assets', 'app.js'), 'console.log(1)');
    expect((await request('GET', '/', {})).text).toContain('<title>built</title>');
    expect((await request('GET', '/data/some-scope', {})).text).toContain('<title>built</title>');
    expect((await request('GET', '/assets/app.js', {})).text).toBe('console.log(1)');
    expect((await request('GET', '/api/nope', {})).status).toBe(404);
  });
});
