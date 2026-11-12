import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { PERSPECTIVES, type Perspective } from '../shared/model.ts';
import { EXPORT_FORMATS, ExportError, type ExportFormat, exportModel } from './export.ts';
import { PathError, type Repo } from './repo.ts';
import type { ServerEvent, Session } from './session.ts';
import type { StaleLinks } from './stale.ts';
import { ChangeError, type Store } from './store.ts';

export interface ApiDeps {
  store: Store;
  session: Session;
  repo: Repo;
  stale: StaleLinks;
  hostRepoPath?: string;
  keepAliveMs?: number;
}

/** The REST API and event stream under /api. */
export function apiRoutes(deps: ApiDeps): Hono {
  const { store, session, repo, stale } = deps;
  const api = new Hono();

  api.onError((error, c) => {
    if (error instanceof ChangeError) return c.json({ error: error.message, details: error.details }, 400);
    if (error instanceof PathError || error instanceof ExportError || error instanceof BadRequest) return c.json({ error: error.message }, 400);
    console.error(error);
    return c.json({ error: 'Internal server error' }, 500);
  });

  api.get('/snapshot', (c) => c.json(store.snapshot()));

  api.post('/changes', async (c) => c.json(store.apply(await jsonBody(c.req.raw), 'human')));

  api.post('/undo', (c) => {
    const revision = store.undo('human');
    return revision === undefined ? c.json({ error: 'Nothing to undo' }, 409) : c.json({ revision });
  });

  api.get('/journal', (c) => {
    const since = c.req.query('since');
    return c.json(store.journal({ since: since === undefined || since === '' ? undefined : integer(since, 'since') }));
  });

  api.get('/session', (c) =>
    c.json({
      ui: session.uiState,
      agent: session.agent,
      repo: { name: repo.name, ...(deps.hostRepoPath ? { hostPath: deps.hostRepoPath } : {}) },
    }),
  );

  api.put('/session/ui', async (c) => {
    const body = await jsonBody(c.req.raw);
    try {
      return c.json(session.setUi(body));
    } catch (error) {
      return c.json({ error: 'Invalid UI state', details: (error as { issues?: unknown }).issues }, 400);
    }
  });

  api.get('/events', (c) =>
    streamSSE(c, async (stream) => {
      const send = (event: ServerEvent) => stream.writeSSE({ event: event.event, data: JSON.stringify(event.data) });
      const queue: ServerEvent[] = [];
      let flushing = false;
      const enqueue = (event: ServerEvent) => {
        queue.push(event);
        if (flushing) return;
        flushing = true;
        void (async () => {
          while (queue.length) await send(queue.shift()!).catch(() => undefined);
          flushing = false;
        })();
      };
      enqueue({ event: 'snapshot', data: { snapshot: store.snapshot() } });
      enqueue({ event: 'agent', data: session.agent });
      const unsubscribe = session.subscribe(enqueue);
      const keepAlive = setInterval(() => void stream.write(': keep-alive\n\n').catch(() => undefined), deps.keepAliveMs ?? 25_000);
      await new Promise<void>((resolve) =>
        stream.onAbort(() => {
          clearInterval(keepAlive);
          unsubscribe();
          resolve();
        }),
      );
    }),
  );

  api.get('/code/file', async (c) => {
    const path = c.req.query('path');
    if (!path) throw new BadRequest('`path` is required');
    return c.json(await repo.readFile(path));
  });

  api.get('/code/files', async (c) => {
    const limit = c.req.query('limit');
    return c.json(await repo.searchFiles(c.req.query('q') ?? '', limit ? Math.min(integer(limit, 'limit'), 1000) : 50));
  });

  api.get('/code/stale', async (c) => c.json(await stale.check(store.snapshot().model)));

  api.get('/export', (c) => {
    const format = (c.req.query('format') ?? 'markdown') as ExportFormat;
    if (!EXPORT_FORMATS.includes(format)) throw new BadRequest(`format must be one of ${EXPORT_FORMATS.join(', ')}`);
    const perspectives = (c.req.query('perspectives') ?? '')
      .split(',')
      .map((p) => p.trim())
      .filter(Boolean);
    const unknown = perspectives.filter((p) => !PERSPECTIVES.includes(p as Perspective));
    if (unknown.length) throw new BadRequest(`unknown perspective ${unknown.join(', ')}; use ${PERSPECTIVES.join(', ')}`);
    const { model, layout } = store.snapshot();
    const file = exportModel(model, layout, {
      format,
      scopeId: c.req.query('scope') || undefined,
      perspectives: perspectives as Perspective[],
      code: c.req.query('code') !== 'false',
    });
    return c.body(file.content, 200, {
      'content-type': file.contentType,
      'content-disposition': `attachment; filename="${file.filename}"`,
    });
  });

  api.all('*', (c) => c.json({ error: `No route ${c.req.method} ${c.req.path}` }, 404));

  return api;
}

/** Forwards store changes to connected browsers as `snapshot` events. */
export function broadcastStoreChanges(store: Store, session: Session): () => void {
  return store.subscribe((change) => session.publish({ event: 'snapshot', data: { snapshot: change.snapshot, ...(change.entry ? { entry: change.entry } : {}) } }));
}

class BadRequest extends Error {}

async function jsonBody(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    throw new BadRequest('Request body must be JSON');
  }
}

function integer(value: string, name: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) throw new BadRequest(`\`${name}\` must be a non-negative integer`);
  return n;
}
