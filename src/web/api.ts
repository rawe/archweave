/** Everything the browser asks of the server goes through this module. */
import type {
  AgentPresence,
  ChangeResult,
  FocusRequest,
  JournalEntry,
  LineRange,
  Snapshot,
  StaleLink,
  UiState,
} from '../shared/model.ts';
import type { PlainChangeSet } from './state/apply.ts';

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: init?.body ? { 'content-type': 'application/json', ...init.headers } : init?.headers,
  });
  const text = await res.text();
  const body = text ? safeJson(text) : undefined;
  if (!res.ok) {
    const message =
      body && typeof body === 'object' && 'error' in body && typeof body.error === 'string'
        ? body.error
        : `Request failed (${res.status})`;
    throw new ApiError(message, res.status, body && typeof body === 'object' && 'details' in body ? body.details : undefined);
  }
  return body as T;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

export interface SessionInfo {
  ui: UiState;
  agent: AgentPresence;
  repo: { name: string; hostPath?: string };
}

export interface CodeFile {
  path: string;
  exists: boolean;
  content?: string;
  lineCount?: number;
  language?: string;
  truncated?: boolean;
}

/** What `POST /api/code/repair` did, and what still needs attention. */
export interface RepairResult {
  revision: number;
  summary?: string;
  repaired: { ownerType: StaleLink['ownerType']; ownerId: string; step?: number; path: string; symbol?: string; from: LineRange; to: LineRange }[];
  stale: StaleLink[];
}

export const api = {
  snapshot: () => request<Snapshot>('/api/snapshot'),
  applyChanges: (changeSet: PlainChangeSet) =>
    request<ChangeResult>('/api/changes', { method: 'POST', body: JSON.stringify(changeSet) }),
  undo: () => request<{ revision: number }>('/api/undo', { method: 'POST' }),
  journal: (since = 0) => request<JournalEntry[]>(`/api/journal?since=${since}`),
  session: () => request<SessionInfo>('/api/session'),
  putUi: (ui: UiState) => request<unknown>('/api/session/ui', { method: 'PUT', body: JSON.stringify(ui) }),
  codeFile: (path: string) => request<CodeFile>(`/api/code/file?path=${encodeURIComponent(path)}`),
  codeFiles: (q: string, limit = 30) =>
    request<string[] | { files: string[] }>(`/api/code/files?q=${encodeURIComponent(q)}&limit=${limit}`).then((r) =>
      Array.isArray(r) ? r : (r?.files ?? []),
    ),
  stale: () => request<StaleLink[]>('/api/code/stale'),
  /** Re-anchors moved links. */
  repairLinks: (opts: { scopeId?: string } = {}) =>
    request<RepairResult>('/api/code/repair', { method: 'POST', body: JSON.stringify(opts.scopeId ? { scopeId: opts.scopeId } : {}) }),
  /** A diagram rendered by the server, as the exports and the agent see it. */
  diagramImageUrl: (id: string, opts: { format: 'png' | 'svg'; theme: 'light' | 'dark'; background: 'canvas' | 'white' | 'transparent'; scale?: number; download?: boolean; version?: number }) => {
    const params = new URLSearchParams({ format: opts.format, theme: opts.theme, background: opts.background });
    if (opts.format === 'png' && opts.scale) params.set('scale', String(opts.scale));
    if (opts.download) params.set('download', '1');
    if (opts.version !== undefined) params.set('v', String(opts.version));
    return `/api/diagrams/${encodeURIComponent(id)}/image?${params}`;
  },
  exportUrl: (opts: { format: 'markdown' | 'json' | 'mermaid'; scope?: string; perspectives: string[]; code: boolean }) => {
    const params = new URLSearchParams({ format: opts.format, perspectives: opts.perspectives.join(','), code: String(opts.code) });
    if (opts.scope) params.set('scope', opts.scope);
    return `/api/export?${params}`;
  },
};

export interface EventHandlers {
  snapshot: (data: { snapshot: Snapshot; entry?: JournalEntry }) => void;
  agent: (presence: AgentPresence) => void;
  focus: (request: FocusRequest) => void;
  status: (status: 'live' | 'offline') => void;
}

/** Subscribes to the server's event stream. EventSource reconnects on its own. */
export function subscribe(handlers: EventHandlers): () => void {
  const source = new EventSource('/api/events');
  const on = <K extends 'snapshot' | 'agent' | 'focus'>(name: K) =>
    source.addEventListener(name, (event) => {
      const data = safeJson((event as MessageEvent<string>).data);
      if (data !== undefined) (handlers[name] as (d: unknown) => void)(data);
    });
  on('snapshot');
  on('agent');
  on('focus');
  source.onopen = () => handlers.status('live');
  source.onerror = () => handlers.status('offline');
  return () => source.close();
}
