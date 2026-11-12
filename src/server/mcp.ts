import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { ChangeSet, ElementKind, type FocusRequest, Id, type Model, Perspective } from '../shared/model.ts';
import { ancestorsOf, descendantsOf, projectStructure } from '../shared/projection.ts';
import { EXPORT_FORMATS, exportModel } from './export.ts';
import { GUIDE } from './guide.ts';
import { PathError, type Repo } from './repo.ts';
import type { Session } from './session.ts';
import { allCodeRefs, type StaleLinks } from './stale.ts';
import type { Store } from './store.ts';
import { didYouMean } from './suggest.ts';
import { compact, ModelView, THREAD_ID_CAP } from './views.ts';

export interface McpDeps {
  store: Store;
  session: Session;
  repo: Repo;
  stale: StaleLinks;
  version: string;
  /** Where the human opens the UI, for hints when no browser is connected. */
  uiUrl: string;
}

const CODE_LESS_KINDS = new Set(['actor', 'external', 'system']);

/** Handles one HTTP request to /mcp in stateless mode: a fresh server and transport per request. */
export async function handleMcpRequest(request: Request, deps: McpDeps): Promise<Response> {
  if (request.method !== 'POST') {
    return new Response(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed: this server is stateless, use POST.' }, id: null }), {
      status: 405,
      headers: { 'content-type': 'application/json', allow: 'POST' },
    });
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ jsonrpc: '2.0', error: { code: -32700, message: 'Parse error: invalid JSON' }, id: null }), {
      status: 400,
      headers: { 'content-type': 'application/json' },
    });
  }
  deps.session.touchAgent(clientNameFrom(body));
  const server = createMcpServer(deps);
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  await server.connect(transport);
  try {
    return await transport.handleRequest(request, { parsedBody: body });
  } finally {
    void server.close();
  }
}

function clientNameFrom(body: unknown): string | undefined {
  const messages = Array.isArray(body) ? body : [body];
  for (const m of messages) {
    if (m && typeof m === 'object' && (m as { method?: unknown }).method === 'initialize') {
      const name = (m as { params?: { clientInfo?: { name?: unknown } } }).params?.clientInfo?.name;
      if (typeof name === 'string') return name;
    }
  }
  return undefined;
}

function ok(value: unknown): CallToolResult {
  return { content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }] };
}

const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

export function createMcpServer(deps: McpDeps): McpServer {
  const { store, session, repo, stale } = deps;
  const server = new McpServer({ name: 'archweave', version: deps.version }, { instructions: GUIDE });
  const view = () => new ModelView(store.snapshot().model);

  server.registerTool(
    'get_guide',
    {
      title: 'Modeling guide',
      description: 'Returns the ArchWeave modeling guide: how to structure the model in levels, name things, link code, model data structures and flows, and work with the human. Read it once before your first change to the model.',
      annotations: readOnly,
    },
    async () => ok(GUIDE),
  );

  server.registerTool(
    'get_context',
    {
      title: 'What the human is looking at',
      description:
        'Returns what the human is doing in ArchWeave right now: the perspective and scope they are viewing (with breadcrumb), what is visible there (in the structure perspective: the scope\'s children, outside neighbors marked `neighbor: true`, and `visibleRelations`, the threads drawn between them with the underlying relation ids), the selected elements and relations expanded in full (code refs, notes, children, relations in and out, flows, data), open notes across the model, the changes the human made since your last get_context or apply_changes, and how many code links are stale. `ui.reportedAt` says when the browser reported this view; when no browser is connected, `uiHint` says the view may be out of date. Call this first whenever a request says "this", "here", "the selected" or otherwise refers to what the human sees.',
      annotations: { ...readOnly, idempotentHint: false },
    },
    async () => {
      const snapshot = store.snapshot();
      const v = new ModelView(snapshot.model);
      const ui = session.uiState;
      const reportedAt = session.uiReportedAt;
      const scope = ui.scopeId ? v.byId.get(ui.scopeId) : undefined;
      const flow = ui.flowId ? v.flowsById.get(ui.flowId) : undefined;
      const selectedElements = ui.selectedElementIds.map((id) => v.expandElement(id) ?? { id, missing: true });
      const selectedRelations = ui.selectedRelationIds.map((id) => v.expandRelation(id) ?? { id, missing: true });
      const humanChanges = store.journal({ since: session.agentCursor, actor: 'human' });
      const staleCount = (await stale.check(snapshot.model)).length;
      session.advanceAgentCursor(snapshot.revision);
      const nothingSelected = !selectedElements.length && !selectedRelations.length;
      const browserConnected = session.browserCount > 0;
      const uiHint = browserConnected
        ? undefined
        : reportedAt
          ? `No browser is connected; this is what the human last looked at ${timeAgo(reportedAt)} ago (${reportedAt}). It may be out of date.`
          : `No browser has reported a view yet. Ask the human to open ${deps.uiUrl}.`;
      return ok({
        revision: snapshot.revision,
        browserConnected,
        ui: {
          perspective: ui.perspective,
          ...(reportedAt ? { reportedAt } : {}),
          scope: scope ? compact(scope) : ui.scopeId ? { id: ui.scopeId, missing: true } : 'top level',
          breadcrumb: scope ? [...ancestorsOf(scope.id, v.byId), scope].map((e) => ({ id: e.id, name: e.name })) : [],
          ...(flow ? { flow: { id: flow.id, name: flow.name, summary: flow.summary || undefined, steps: flow.steps.map((s, i) => ({ step: i + 1, from: s.from, to: s.to, label: s.label, dataIds: s.dataIds.length ? s.dataIds : undefined })) } } : {}),
          ...visibleIn(snapshot.model, ui.perspective, scope?.id),
        },
        ...(uiHint ? { uiHint } : {}),
        selection: { elements: selectedElements, relations: selectedRelations },
        ...(nothingSelected ? { hint: 'Nothing is selected. If the request refers to something specific, ask the human to select it in ArchWeave, or work from the scope and visible elements.' } : {}),
        openNotes: openNotes(snapshot.model),
        humanChanges,
        staleLinks: staleCount,
      });
    },
  );

  server.registerTool(
    'get_model',
    {
      title: 'Model outline',
      description:
        'Returns an outline of the architecture: nested elements as {id, kind, name, summary, status, childCount, dataCount, children} starting at the top level or at `scopeId`, `depth` levels deep. `childCount` counts non-data children and `dataCount` the data structures an element owns; `children` is present only above the depth limit, so call again with a deeper `scopeId` or `depth` to expand. `relations` shows connectivity at the level returned: a single relation between two listed elements appears as itself (with `id`); relations between their descendants are lifted to the listed ancestors and merged into threads {from, to, count, relationIds (at most 10), kinds}. With `scopeId`, connections to elements outside the scope are lifted to outside `neighbors`, as on the diagram. `counts` covers the whole model, per kind including data. Data structures are left out of the outline unless `includeData` is true.',
      inputSchema: {
        scopeId: Id.optional().describe('Element whose inside to outline. Omit for the whole system.'),
        depth: z.number().int().min(1).max(10).optional().describe('Levels of nesting to include. Default 2.'),
        kinds: z.array(ElementKind).optional().describe('Only list elements of these kinds (their filtered-out parents are skipped, not their children).'),
        includeData: z.boolean().optional().describe('Include data structures (kind "data"). Default false.'),
      },
      annotations: readOnly,
    },
    async ({ scopeId, depth, kinds, includeData }) => {
      const v = view();
      if (scopeId && !v.byId.has(scopeId)) throw new Error(`Unknown element \`${scopeId}\`.${didYouMean(scopeId, v.byId.values())}`);
      return ok(v.outline({ scopeId, depth: depth ?? 2, kinds, includeData: includeData ?? false }));
    },
  );

  server.registerTool(
    'get_element',
    {
      title: 'Element in full',
      description:
        'Returns one element in full: all fields, code refs, notes, parent chain, children, relations in and out (with the other end\'s name), flows it takes part in, and the data it touches (for a data structure: who uses it and which fields reference it). Also accepts a relation id or a flow id.',
      inputSchema: { id: z.string().min(1).describe('Element, relation or flow id.') },
      annotations: readOnly,
    },
    async ({ id }) => {
      const v = view();
      const found = v.expandElement(id) ?? v.expandRelation(id) ?? flowDetail(v, id);
      if (!found) {
        throw new Error(`No element, relation or flow \`${id}\`.${didYouMean(id, [...v.byId.values(), ...v.relationsById.values(), ...v.flowsById.values()])}`);
      }
      return ok(found);
    },
  );

  server.registerTool(
    'search',
    {
      title: 'Search the model',
      description: 'Finds elements whose name, id, summary, description, tags, technology, field names or code paths contain all words of `query`. Returns compact elements, best matches first, with where they matched.',
      inputSchema: {
        query: z.string().min(1).describe('Words to look for, e.g. "order payload" or "src/billing".'),
        kinds: z.array(ElementKind).optional().describe('Only these element kinds.'),
        limit: z.number().int().min(1).max(100).optional().describe('Default 20.'),
      },
      annotations: readOnly,
    },
    async ({ query, kinds, limit }) => ok(view().search(query, { kinds, limit: limit ?? 20 })),
  );

  server.registerTool(
    'find_by_code',
    {
      title: 'Find model entries by code path',
      description:
        'Returns the elements, relations and flow steps whose code refs touch the given files or directories (a directory matches everything below it, and a ref to a directory matches files inside it). Call this after changing code to find what to update. Paths with nothing linked are listed in `unmatchedPaths`.',
      inputSchema: { paths: z.array(z.string().min(1)).min(1).describe('Repo-relative paths ("src/orders/service.ts", "src/billing"). Absolute paths inside the repository are accepted.') },
      annotations: readOnly,
    },
    async ({ paths }) => {
      const normalized = paths.map((p) => {
        try {
          return repo.normalize(p);
        } catch (error) {
          if (error instanceof PathError) throw new Error(`${error.message}. Use paths relative to the repository root.`);
          throw error;
        }
      });
      return ok(view().findByCode(normalized));
    },
  );

  server.registerTool(
    'apply_changes',
    {
      title: 'Change the model',
      description: `Applies one change set to the model as the agent, atomically: if any entry is invalid nothing is applied and the error names the entry (with "did you mean" suggestions for unknown ids). Returns the new revision, the ids created, updated and removed, and warnings. With \`dryRun: true\` it validates and returns the same result (with the revision it would get) without applying anything.

Semantics:
- \`summary\` (required): one line the human reads in the activity feed, e.g. "Model checkout components".
- \`elements\`, \`relations\`, \`flows\`: upserts. With an existing \`id\` only the fields you send change. Without an id, or with an id that does not exist yet, the entry is created; new elements need \`kind\` and \`name\`, new relations \`from\` and \`to\`, new flows \`name\`. Element and flow ids are generated as slugs of the name, relation ids as "<from>-<kind>-<to>"; supplying your own readable id is fine. Give your own ids when later entries in the same change set refer to them; entries can refer to elements created in the same change set.
- Lists you send (codeRefs, fields, tags, notes, steps, dataIds) replace the stored list. For small corrections use the additive helpers instead:
  - elements and relations: \`addCodeRefs\` (appended, duplicates by path+symbol+lines skipped), \`removeCodeRefs\` ([{path, symbol?}]: all refs to the path, or only that symbol);
  - elements: \`setFields\` ([{name, type?, optional?, description?, ref?}]: upsert by name, only given properties change, \`ref: null\` clears), \`removeFields\` (names), \`addNotes\` (texts), \`resolveNotes\` (note ids);
  - flows: \`updateSteps\` ([{index, ...properties}]), \`insertSteps\` ([{index, step}], inserted before that index; index = step count appends), \`removeSteps\` (indices). Indices are 0-based (step number − 1) and refer to the steps before this patch.
  Within one entry a full list is applied first, then removals, then additions and updates. A helper that names something missing is an error.
- \`parentId: null\` moves an element to the top level. Containment cycles are rejected.
- New elements default to status "built" when they have code refs, otherwise "planned".
- \`remove\` deletes by id. Removing an element also removes its descendants, attached relations and the flow steps that touch it.
- \`dataIds\` and field \`ref\`s you send must name data structures (kind "data"); otherwise the change set is rejected. References broken by a removal, or by an element no longer being of kind "data", are cleaned up with a warning.
- Code ref paths are stored normalized (repo-relative, forward slashes, no "./").
- Do not send \`layout\`.`,
      inputSchema: ChangeSet.extend({
        summary: z.string().min(1).max(200).describe('One line for the activity feed.'),
        dryRun: z.boolean().optional().describe('Validate and report what would change without applying it.'),
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    async ({ dryRun, ...changes }) => {
      if (dryRun) return ok({ dryRun: true, ...store.preview(changes, 'agent') });
      const humanChanges = store.journal({ since: session.agentCursor, actor: 'human' });
      const result = store.apply(changes, 'agent');
      session.advanceAgentCursor(result.revision);
      return ok(humanChanges.length ? { ...result, humanChangesSinceYouLastLooked: humanChanges } : result);
    },
  );

  server.registerTool(
    'check_code_links',
    {
      title: 'Check code links',
      description:
        'Checks code refs against the repository and returns the stale ones with their owner, plus built elements that have no code ref at all. Reasons: missing-file; line-out-of-range (startLine or endLine past the end of the file); symbol-not-found (the `symbol`, matched as an identifier, does not occur in the file outside quotes; for "A.b" the last segment is enough); symbol-outside-range (it occurs, but not within startLine..endLine, or on startLine when there is no endLine). Limit to one subtree with `scopeId`. Fix stale refs with apply_changes: `removeCodeRefs` plus `addCodeRefs`, or the corrected `codeRefs` list.',
      inputSchema: { scopeId: Id.optional().describe('Only check this element and everything inside it.') },
      annotations: readOnly,
    },
    async ({ scopeId }) => {
      const model = store.snapshot().model;
      const v = new ModelView(model);
      if (scopeId && !v.byId.has(scopeId)) throw new Error(`Unknown element \`${scopeId}\`.${didYouMean(scopeId, v.byId.values())}`);
      const inRange = scopeId ? new Set([scopeId, ...descendantsOf(scopeId, model.elements).map((e) => e.id)]) : undefined;
      const owners = allCodeRefs(model).filter((o) => {
        if (!inRange) return true;
        if (o.ownerType === 'element') return inRange.has(o.ownerId);
        if (o.ownerType === 'relation') {
          const r = v.relationsById.get(o.ownerId);
          return !!r && (inRange.has(r.from) || inRange.has(r.to));
        }
        return !!v.flowsById.get(o.ownerId)?.steps.some((s) => inRange.has(s.from) || inRange.has(s.to));
      });
      const links = await stale.checkRefs(owners);
      const nameOf = (type: string, id: string) =>
        type === 'element' ? v.byId.get(id)?.name : type === 'relation' ? v.relationsById.get(id)?.label || id : v.flowsById.get(id)?.name;
      const builtWithoutCode = model.elements
        .filter((e) => (!inRange || inRange.has(e.id)) && e.status === 'built' && !e.codeRefs.length && !CODE_LESS_KINDS.has(e.kind))
        .map(compact);
      return ok({
        stale: links.map((l) => ({ ...l, ownerName: nameOf(l.ownerType, l.ownerId) })),
        builtWithoutCode,
      });
    },
  );

  server.registerTool(
    'get_changes',
    {
      title: 'Activity journal',
      description: 'Returns journal entries (revision, time, actor, summary, ids created/updated/removed), oldest first. Without `since`, returns the last 20.',
      inputSchema: {
        since: z.number().int().min(0).optional().describe('Only entries after this revision.'),
        actor: z.enum(['human', 'agent']).optional().describe('Only entries by this actor.'),
      },
      annotations: readOnly,
    },
    async ({ since, actor }) => {
      const entries = store.journal({ since, actor });
      return ok({ revision: store.currentRevision, entries: since === undefined ? entries.slice(-20) : entries });
    },
  );

  server.registerTool(
    'focus_ui',
    {
      title: 'Show something to the human',
      description:
        'Asks the browser to navigate to and highlight these elements, optionally in a given perspective, scope or flow, with a short message shown to the human. Use it to point at what you are talking about. Returns whether a browser is connected to receive it.',
      inputSchema: {
        elementIds: z.array(Id).describe('Elements to highlight. May be empty when only navigating.'),
        perspective: Perspective.optional().describe('structure, data or flows. Omit to let the browser choose.'),
        scopeId: Id.nullable().optional().describe('Structure scope to open; null for the top level. Omit to let the browser pick a scope that shows the elements.'),
        flowId: Id.optional().describe('Flow to open in the flows perspective.'),
        message: z.string().max(280).optional().describe('One short sentence shown to the human.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ elementIds, perspective, scopeId, flowId, message }) => {
      const v = view();
      const problems: string[] = [];
      for (const id of [...elementIds, ...(scopeId ? [scopeId] : [])]) {
        if (!v.byId.has(id)) problems.push(`unknown element \`${id}\`.${didYouMean(id, v.byId.values())}`);
      }
      if (flowId && !v.flowsById.has(flowId)) problems.push(`unknown flow \`${flowId}\`.${didYouMean(flowId, v.flowsById.values())}`);
      if (problems.length) throw new Error(problems.join('\n'));
      const request: FocusRequest = {
        elementIds,
        ...(perspective ? { perspective } : {}),
        ...(scopeId !== undefined ? { scopeId } : {}),
        ...(flowId ? { flowId } : {}),
        ...(message ? { message } : {}),
      };
      session.publish({ event: 'focus', data: request });
      const browsers = session.browserCount;
      return ok({
        delivered: browsers > 0,
        browsers,
        ...(browsers ? {} : { hint: `No browser is connected. Ask the human to open ${deps.uiUrl}.` }),
      });
    },
  );

  server.registerTool(
    'export',
    {
      title: 'Export documentation',
      description:
        'Returns the model as text: "markdown" is an architecture document (overview and per-scope Mermaid diagrams with element entries, data structures with field tables, flows as sequence diagrams); "mermaid" is just the diagrams; "json" is the raw model and layout. `scope` limits markdown and mermaid to one subtree.',
      inputSchema: {
        format: z.enum(EXPORT_FORMATS),
        scope: Id.optional().describe('Element id whose subtree to export.'),
      },
      annotations: readOnly,
    },
    async ({ format, scope }) => {
      const { model, layout } = store.snapshot();
      if (scope && !model.elements.some((e) => e.id === scope)) throw new Error(`Unknown element \`${scope}\`.${didYouMean(scope, model.elements)}`);
      return ok(exportModel(model, layout, { format, scopeId: scope }).content);
    },
  );

  return server;
}

/** What the browser draws for this perspective, as far as the agent needs it. */
function visibleIn(model: Model, perspective: Perspective, scopeId: string | undefined): Record<string, unknown> {
  if (perspective === 'data') return { visible: model.elements.filter((e) => e.kind === 'data').map(compact) };
  if (perspective !== 'structure') return {};
  const projection = projectStructure(model, scopeId);
  return {
    visible: projection.nodes.map((n) => ({
      ...compact(n.element),
      ...(n.role === 'neighbor' ? { neighbor: true } : {}),
      ...(n.childCount ? { childCount: n.childCount } : {}),
    })),
    visibleRelations: projection.edges.map((e) => ({
      from: e.from,
      to: e.to,
      count: e.relations.length,
      relationIds: e.relations.slice(0, THREAD_ID_CAP).map((r) => r.id),
    })),
  };
}

function timeAgo(iso: string): string {
  const seconds = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  if (seconds < 90) return `${seconds} seconds`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) return `${minutes} minutes`;
  const hours = Math.round(minutes / 60);
  return hours < 36 ? `${hours} hours` : `${Math.round(hours / 24)} days`;
}

function openNotes(model: Model) {
  return model.elements.flatMap((e) =>
    e.notes.filter((n) => !n.resolved).map((n) => ({ elementId: e.id, elementName: e.name, noteId: n.id, author: n.author, text: n.text, createdAt: n.createdAt })),
  );
}

function flowDetail(v: ModelView, id: string): Record<string, unknown> | undefined {
  const flow = v.flowsById.get(id);
  if (!flow) return undefined;
  return {
    type: 'flow',
    id: flow.id,
    name: flow.name,
    ...(flow.summary ? { summary: flow.summary } : {}),
    steps: flow.steps.map((s, i) => ({
      step: i + 1,
      from: v.ref(s.from),
      to: v.ref(s.to),
      label: s.label,
      ...(s.description ? { description: s.description } : {}),
      ...(s.dataIds.length ? { data: s.dataIds.map((d) => v.ref(d)) } : {}),
      ...(s.codeRefs.length ? { codeRefs: s.codeRefs } : {}),
    })),
  };
}
