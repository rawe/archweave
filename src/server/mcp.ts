import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { ChangeSet, CODE_EXPECTED_KINDS, type CodeRef, ElementKind, type FocusRequest, Id, type JournalEntry, type Model, normalizeCodePath, Perspective, type UiState } from '../shared/model.ts';
import { ancestorsOf, descendantsOf, projectStructure } from '../shared/projection.ts';
import { EXPORT_FORMATS, exportModel } from './export.ts';
import { GUIDE } from './guide.ts';
import { ownedRefs, repairCodeLinks } from './repair.ts';
import { PathError, type Repo } from './repo.ts';
import type { Session } from './session.ts';
import type { StaleLinks, Verdict } from './stale.ts';
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
        'Returns what the human is doing in ArchWeave right now: the perspective and scope they are viewing (with breadcrumb), what is visible there (in the structure perspective: the scope\'s children, outside neighbors marked `neighbor: true`, and `visibleRelations`, the threads drawn between them with the underlying relation ids; in the data perspective: `dataView`, either the catalog of all structures by owner or the focused structure with its fields, the structures it references and that reference it, and the elements using it by verb), the selected elements and relations expanded in full (code refs, notes, children, relations in and out, flows, data), open notes across the model, the changes the human made since your last get_context or apply_changes (the 20 most recent; `olderHumanChangesOmitted` counts the rest, which get_changes lists), and how many code links are stale. `ui.reportedAt` says when the browser reported this view; when no browser is connected, `uiHint` says the view may be out of date. Call this first whenever a request says "this", "here", "the selected" or otherwise refers to what the human sees.',
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
      const humanChanges = recentHumanChanges(store.journal({ since: session.agentCursor, actor: 'human' }));
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
          ...visibleIn(v, ui, scope?.id),
        },
        ...(uiHint ? { uiHint } : {}),
        selection: { elements: selectedElements, relations: selectedRelations },
        ...(nothingSelected ? { hint: 'Nothing is selected. If the request refers to something specific, ask the human to select it in ArchWeave, or work from the scope and visible elements.' } : {}),
        openNotes: openNotes(snapshot.model),
        ...humanChanges,
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
        'Returns the elements, relations and flow steps whose code refs touch the given files or directories (a directory matches everything below it, and a ref to a directory matches files inside it), with the current check of every returned ref: `check` is "ok", "moved" (the linked text now sits elsewhere in the file; `suggestion` has the new startLine/endLine), "changed" (the linked text was edited; `suggestion`, when present, is where the symbol is now) or another stale reason (missing-file, line-out-of-range, symbol-not-found, symbol-outside-range). `codeLinks` counts the refs per check. Call this right after changing code: run check_code_links with `repair: true` to re-anchor moved links, and look at changed ones yourself. Paths with nothing linked are listed in `unmatchedPaths`.',
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
      // Stored paths are compared in their repo-relative form, so refs stored with an absolute path inside the repository match too.
      const storedForm = (path: string) => {
        try {
          return repo.normalize(path);
        } catch {
          return normalizeCodePath(path);
        }
      };
      const found = view().findByCode(normalized, storedForm);
      const refs = [...found.elements, ...found.relations, ...found.flowSteps].flatMap((owner) => owner.codeRefs);
      const verdicts = new Map((await stale.inspect(refs.map((ref) => ({ ref })))).map((v) => [v.ref, v]));
      const counts: Record<string, number> = {};
      const annotate = (list: CodeRef[]) =>
        list.map((ref) => {
          const { reason, suggestion }: Verdict = verdicts.get(ref) ?? {};
          const check = reason ?? 'ok';
          counts[check] = (counts[check] ?? 0) + 1;
          return { ...ref, check, ...(suggestion ? { suggestion } : {}) };
        });
      const result = {
        elements: found.elements.map((e) => ({ ...e, codeRefs: annotate(e.codeRefs) })),
        relations: found.relations.map((r) => ({ ...r, codeRefs: annotate(r.codeRefs) })),
        flowSteps: found.flowSteps.map((s) => ({ ...s, codeRefs: annotate(s.codeRefs) })),
        unmatchedPaths: found.unmatchedPaths,
        codeLinks: counts,
      };
      const hints = [
        counts.moved ? `${counts.moved} moved: call check_code_links with repair: true to re-anchor them.` : '',
        refs.length - (counts.ok ?? 0) - (counts.moved ?? 0) ? 'Look at the other stale refs in the code and fix them with apply_changes (re-send a ref without its digest in addCodeRefs to accept it as is).' : '',
      ].filter(Boolean);
      return ok(hints.length ? { ...result, hint: hints.join(' ') } : result);
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
  - elements and relations: \`addCodeRefs\` (appended; a ref already there, same path+symbol+lines, is not duplicated but re-sealed and takes the sent \`note\`), \`removeCodeRefs\` ([{path, symbol?, startLine?}]: all refs to the path, or only those with that symbol and/or start line);
  - elements: \`setFields\` ([{name, type?, optional?, description?, ref?}]: upsert by name, only given properties change, \`ref: null\` clears), \`removeFields\` (names), \`addNotes\` (texts), \`resolveNotes\` (note ids);
  - flows: \`updateSteps\` ([{index, ...properties, addCodeRefs?, removeCodeRefs?}]), \`insertSteps\` ([{index, step}], inserted before that index; index = step count appends), \`removeSteps\` (indices). Indices are 0-based (step number − 1) and refer to the steps before this patch.
  Within one entry a full list is applied first, then removals, then additions and updates. A helper that names something missing is an error.
- \`parentId: null\` moves an element to the top level. Containment cycles are rejected.
- New elements default to status "built" when they have code refs or are of a kind without code (actor, external, system), otherwise "planned".
- Code refs with a line range are sealed by the server (\`digest\`, a hash of the linked lines) so later checks can tell moved code from edited code. A ref written without a digest is sealed to the current text: re-send a ref without its digest (in \`addCodeRefs\`) to accept edited code as still right. A ref resent exactly as read (same location and digest) keeps its seal. A digest sent with a new location claims the code there is the sealed text; when it is not, the change set is rejected. A ref that is stale already when written comes back as a warning.
- \`expectedRevision\`: the revision you read; when the model has changed since, nothing is applied and you get an error. Optional.
- \`remove\` deletes by id. Removing an element also removes its descendants, attached relations and the flow steps that touch it.
- \`dataIds\` and field \`ref\`s you send must name data structures (kind "data"); otherwise the change set is rejected. References broken by a removal, or by an element no longer being of kind "data", are cleaned up with a warning.
- Code ref paths are stored normalized (repo-relative, forward slashes, no "./"); an absolute path inside the repository is made relative, a path outside it is an error.
- Do not send \`layout\`.`,
      inputSchema: ChangeSet.extend({
        summary: z.string().min(1).max(200).describe('One line for the activity feed.'),
        dryRun: z.boolean().optional().describe('Validate and report what would change without applying it.'),
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    async ({ dryRun, ...changes }) => {
      if (dryRun) return ok({ dryRun: true, ...store.preview(changes, 'agent') });
      const { humanChanges, olderHumanChangesOmitted } = recentHumanChanges(store.journal({ since: session.agentCursor, actor: 'human' }));
      const result = store.apply(changes, 'agent');
      session.advanceAgentCursor(result.revision);
      return ok(humanChanges.length ? { ...result, humanChangesSinceYouLastLooked: humanChanges, ...(olderHumanChangesOmitted ? { olderHumanChangesOmitted } : {}) } : result);
    },
  );

  server.registerTool(
    'check_code_links',
    {
      title: 'Check and repair code links',
      description: `Checks code refs against the repository and returns the stale ones with their owner (flow refs also name the 1-based \`step\`), plus built elements of kinds that should have code (app, service, component, module, data) without any code ref. Limit to one subtree with \`scopeId\`.

Refs with a line range are sealed when written: the server stores a \`digest\` of the linked lines (you never send it). A sealed ref is checked by its text:
- moved: the text is no longer at its lines but found verbatim elsewhere in the file (with its symbol inside); \`suggestion\` is the new {startLine, endLine}.
- changed: the text was edited. \`suggestion\`, when present, is where the symbol is now (same length); check it in the code.
Other reasons, for every ref: missing-file; line-out-of-range (startLine or endLine past the end of the file); symbol-not-found (the \`symbol\`, matched as an identifier, does not occur in the file outside quotes; for "A.b" the last segment is enough); symbol-outside-range (it occurs, but not within startLine..endLine, or on startLine when there is no endLine).

With \`repair: true\` it also changes the model, in one journaled change set: every moved ref (on elements, relations and flow steps) is re-anchored to its suggestion. It returns what it re-anchored and what still needs attention. Changed and other stale refs are never repaired automatically: look at the code, then fix the ref with apply_changes (a new line range without a digest is sealed afresh), or, when the ref is still right, re-send it without its digest in \`addCodeRefs\` (in \`updateSteps\` for flow steps) to re-seal it.`,
      inputSchema: {
        scopeId: Id.optional().describe('Only check this element and everything inside it, and relations and flow steps that touch them.'),
        repair: z.boolean().optional().describe('Re-anchor moved refs. Default false (read only).'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ scopeId, repair }) => {
      const model = store.snapshot().model;
      const v = new ModelView(model);
      if (scopeId && !v.byId.has(scopeId)) throw new Error(`Unknown element \`${scopeId}\`.${didYouMean(scopeId, v.byId.values())}`);
      const nameOf = (type: string, id: string) =>
        type === 'element' ? v.byId.get(id)?.name : type === 'relation' ? v.relationsById.get(id)?.label || id : v.flowsById.get(id)?.name;
      const inScope = scopeId ? new Set([scopeId, ...descendantsOf(scopeId, model.elements).map((e) => e.id)]) : undefined;
      const builtWithoutCode = model.elements
        .filter((e) => (!inScope || inScope.has(e.id)) && e.status === 'built' && !e.codeRefs.length && CODE_EXPECTED_KINDS.includes(e.kind))
        .map(compact);
      const named = <T extends { ownerType: string; ownerId: string }>(l: T) => ({ ...l, ownerName: nameOf(l.ownerType, l.ownerId) });
      if (repair) {
        const result = await repairCodeLinks(store, stale, { actor: 'agent', scopeId });
        return ok({
          revision: result.revision,
          ...(result.summary ? { summary: result.summary } : {}),
          repaired: result.repaired.map(named),
          stale: result.stale.map(named),
          builtWithoutCode,
        });
      }
      const links = await stale.checkRefs(ownedRefs(model, scopeId));
      const moved = links.filter((l) => l.reason === 'moved').length;
      return ok({
        stale: links.map(named),
        builtWithoutCode,
        ...(moved ? { hint: `${moved} moved: call again with repair: true to re-anchor them.` } : {}),
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
function visibleIn(v: ModelView, ui: UiState, scopeId: string | undefined): Record<string, unknown> {
  if (ui.perspective === 'data') {
    // As in the browser: the first selected data structure is in focus; without one the catalog shows.
    const focusId = ui.selectedElementIds.find((id) => v.byId.get(id)?.kind === 'data');
    return { dataView: focusId ? v.dataFocus(focusId) : v.dataCatalog() };
  }
  if (ui.perspective !== 'structure') return {};
  const projection = projectStructure(v.model, scopeId);
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

export const HUMAN_CHANGES_CAP = 20;

/** The human's most recent journal entries, and how many older ones were left out (absent when none were). */
export function recentHumanChanges(entries: JournalEntry[]): { humanChanges: JournalEntry[]; olderHumanChangesOmitted?: number } {
  const omitted = Math.max(0, entries.length - HUMAN_CHANGES_CAP);
  return { humanChanges: entries.slice(omitted), ...(omitted ? { olderHumanChangesOmitted: omitted } : {}) };
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
