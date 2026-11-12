import fs from 'node:fs';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono, type MiddlewareHandler } from 'hono';
import type { Config } from './config.ts';
import { handleMcpRequest } from './mcp.ts';
import { Persistence } from './persistence.ts';
import { Repo } from './repo.ts';
import { apiRoutes, broadcastStoreChanges } from './routes.ts';
import { Session } from './session.ts';
import { StaleLinks } from './stale.ts';
import { Store } from './store.ts';

export const VERSION = '0.1.0';

export interface Tuning {
  debounceMs?: number;
  keepAliveMs?: number;
  presenceTimeoutMs?: number;
  log?: (message: string) => void;
}

export interface Running {
  port: number;
  url: string;
  close(): Promise<void>;
}

export interface ArchWeave {
  app: Hono;
  store: Store;
  session: Session;
  persistence: Persistence;
  repo: Repo;
  listen(): Promise<Running>;
  close(): Promise<void>;
}

export async function createArchWeave(config: Config, tuning: Tuning = {}): Promise<ArchWeave> {
  const repo = new Repo(config.repoDir, config.hostRepoPath);
  const persistence = new Persistence(config.dataDir, { debounceMs: tuning.debounceMs, defaultName: repo.name, log: tuning.log });
  const loaded = await persistence.load();
  let store: Store;
  try {
    store = new Store(loaded);
  } catch (error) {
    throw new Error(`The model in ${config.dataDir} does not match the ArchWeave format: ${(error as Error).message}`);
  }
  persistence.attach(store);
  const session = new Session(tuning.presenceTimeoutMs);
  const stopBroadcast = broadcastStoreChanges(store, session);
  const stale = new StaleLinks(repo);
  let uiUrl = `http://localhost:${config.port}`;

  const app = new Hono();
  app.use('*', hostGuard(config));
  app.route('/api', apiRoutes({ store, session, repo, stale, hostRepoPath: config.hostRepoPath, keepAliveMs: tuning.keepAliveMs }));
  app.all('/mcp', (c) => handleMcpRequest(c.req.raw, { store, session, repo, stale, version: VERSION, uiUrl }));
  serveWeb(app, findWebDir(config.webDir));

  const close = async () => {
    stopBroadcast();
    session.close();
    await persistence.close();
  };

  return {
    app,
    store,
    session,
    persistence,
    repo,
    close,
    listen: () =>
      new Promise<Running>((resolve, reject) => {
        const server = serve({ fetch: app.fetch, port: config.port, hostname: config.host }, (info: AddressInfo) => {
          const host = config.host === '0.0.0.0' || config.host === '::' ? 'localhost' : config.host.includes(':') ? `[${config.host}]` : config.host;
          uiUrl = `http://${host}:${info.port}`;
          resolve({
            port: info.port,
            url: uiUrl,
            close: () =>
              new Promise<void>((done) => {
                server.close(() => done());
                (server as { closeAllConnections?: () => void }).closeAllConnections?.();
              }).then(close),
          });
        });
        server.once('error', reject);
      }),
  };
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);

/** Rejects requests whose Host or Origin is not this server, to block DNS rebinding. */
function hostGuard(config: Config): MiddlewareHandler {
  const allowed = new Set([...LOCAL_HOSTS, ...config.allowedHosts]);
  if (config.host !== '0.0.0.0' && config.host !== '::') allowed.add(config.host.toLowerCase());
  const ok = (hostname: string) => allowed.has(hostname) || hostname.endsWith('.localhost');
  return async (c, next) => {
    const host = hostnameOf(c.req.header('host'));
    if (!host || !ok(host)) {
      return c.json({ error: `Host "${c.req.header('host') ?? ''}" is not allowed. Add it to ARCHWEAVE_ALLOWED_HOSTS to accept it.` }, 403);
    }
    const origin = c.req.header('origin');
    if (origin && origin !== 'null') {
      let originHost: string | undefined;
      try {
        originHost = new URL(origin).hostname.replace(/^\[|\]$/g, '').toLowerCase();
      } catch {
        originHost = undefined;
      }
      if (!originHost || !ok(originHost)) return c.json({ error: `Origin "${origin}" is not allowed.` }, 403);
    }
    await next();
  };
}

function hostnameOf(header: string | undefined): string | undefined {
  if (!header) return undefined;
  const h = header.trim().toLowerCase();
  if (h.startsWith('[')) return h.slice(1, h.indexOf(']'));
  return h.split(':')[0];
}

function findWebDir(configured?: string): string | undefined {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = configured ? [configured] : [path.resolve(here, '../web'), path.resolve(here, '../../dist/web')];
  return candidates.find((dir) => fs.existsSync(path.join(dir, 'index.html')));
}

function serveWeb(app: Hono, webDir: string | undefined): void {
  if (!webDir) {
    app.get('/', (c) =>
      c.html('<!doctype html><title>ArchWeave</title><p>The ArchWeave server is running, but the web UI is not built. Run <code>npm run build:web</code>, or use <code>npm run dev</code>.</p>'),
    );
    return;
  }
  const indexFile = path.join(webDir, 'index.html');
  app.use('*', serveStatic({ root: webDir }));
  app.get('*', (c) => {
    if (path.posix.extname(c.req.path)) return c.notFound();
    return c.html(fs.readFileSync(indexFile, 'utf8'));
  });
}
