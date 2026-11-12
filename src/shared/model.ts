/**
 * The ArchWeave architecture model: the single contract shared by the server,
 * the web UI and the MCP tools. Everything is one graph of elements and
 * relations; perspectives (structure, data, flows) are lenses onto that graph.
 */
import { z } from 'zod';

/** Ids are readable slugs ("order-service"), stable across renames, unique per collection. */
export const Id = z
  .string()
  .min(1)
  .max(80)
  .regex(/^[a-z0-9][a-z0-9._-]*$/, 'lowercase letters, digits, ".", "_" or "-"');

export const ELEMENT_KINDS = [
  'system', // a whole product or bounded context; usually a top-level scope
  'actor', // a person or role using the system
  'external', // a third-party system outside the repository
  'app', // a deployable unit: web app, CLI, worker, mobile app
  'service', // a backend service or API server
  'component', // a cohesive part inside an app or service
  'module', // a code-level unit: package, folder, class cluster
  'store', // database, cache, file store, bucket
  'queue', // topic, queue, stream, event bus
  'agent', // an AI agent or LLM-driven actor
  'data', // a data structure: entity, DTO, event payload, schema, config
] as const;
export const ElementKind = z.enum(ELEMENT_KINDS);
export type ElementKind = z.infer<typeof ElementKind>;

/** Kinds that stand for something outside the code: they never carry code refs and exist as soon as they are modeled. */
export const CODELESS_KINDS: readonly ElementKind[] = ['actor', 'external', 'system'];
/** Kinds whose built elements should link code; an agent, store or queue may live outside the repository. */
export const CODE_EXPECTED_KINDS: readonly ElementKind[] = ['app', 'service', 'component', 'module', 'data'];

/** planned = designed but not implemented yet; built = exists in code; deprecated = scheduled for removal. */
export const Status = z.enum(['planned', 'built', 'deprecated']);
export type Status = z.infer<typeof Status>;

export const Actor = z.enum(['human', 'agent']);
export type Actor = z.infer<typeof Actor>;

/** A link from the model into the repository. Paths are repo-relative with forward slashes. */
export const CodeRef = z.object({
  path: z.string().min(1),
  symbol: z.string().optional(), // function, class, type or export name
  startLine: z.number().int().positive().optional(),
  endLine: z.number().int().positive().optional(),
  note: z.string().optional(), // why this location matters
  /**
   * Seal of the text at startLine..endLine when the ref was written: computed by the server,
   * never by clients (a sent digest is ignored). Lets the checker tell moved code from changed code.
   */
  digest: z.string().optional(),
});
export type CodeRef = z.infer<typeof CodeRef>;

/** One field of a data structure. `ref` points at another `data` element when the field embeds or references it. */
export const Field = z.object({
  name: z.string().min(1),
  type: z.string().default(''), // free text: "string", "Order[]", "uuid"
  optional: z.boolean().optional(),
  description: z.string().optional(),
  ref: Id.optional(),
});
export type Field = z.infer<typeof Field>;

/** A message pinned to an element: human intent for the agent, or an agent's open question for the human. */
export const Note = z.object({
  id: Id,
  text: z.string().min(1),
  author: Actor,
  createdAt: z.string(),
  resolved: z.boolean().optional(),
});
export type Note = z.infer<typeof Note>;

export const Element = z.object({
  id: Id,
  kind: ElementKind,
  name: z.string().min(1).max(120),
  /** One sentence. Shown on the diagram. */
  summary: z.string().max(280).default(''),
  /** Markdown. Shown on demand in the inspector and in exports. */
  description: z.string().default(''),
  /** Containment. Top-level elements have no parent. `data` elements may be owned by the element that defines them. */
  parentId: Id.optional(),
  technology: z.string().optional(), // "Postgres 16", "React", "Kafka"
  status: Status.default('built'),
  tags: z.array(z.string()).default([]),
  codeRefs: z.array(CodeRef).default([]),
  notes: z.array(Note).default([]),
  // Only meaningful for kind === 'data':
  format: z.string().optional(), // "json", "xml", "sql", "typescript", "protobuf"
  fields: z.array(Field).default([]),
  example: z.string().optional(), // sample payload, shown as code
});
export type Element = z.infer<typeof Element>;

export const RELATION_KINDS = [
  'uses', // generic dependency or call
  'calls', // synchronous request
  'reads', // reads from a store or data structure
  'writes', // writes to a store or data structure
  'publishes', // emits to a queue or stream
  'subscribes', // consumes from a queue or stream
  'produces', // creates or returns a data structure
  'consumes', // accepts a data structure
  'references', // data-to-data reference
] as const;
export const RelationKind = z.enum(RELATION_KINDS);
export type RelationKind = z.infer<typeof RelationKind>;

export const Relation = z.object({
  id: Id,
  from: Id,
  to: Id,
  kind: RelationKind.default('uses'),
  label: z.string().max(80).default(''),
  description: z.string().default(''),
  technology: z.string().optional(), // "HTTPS/JSON", "gRPC", "SQL"
  /** Data structures carried over this relation. */
  dataIds: z.array(Id).default([]),
  status: Status.default('built'),
  codeRefs: z.array(CodeRef).default([]),
});
export type Relation = z.infer<typeof Relation>;

/** A named scenario: an ordered walk through the architecture. */
export const FlowStep = z.object({
  from: Id,
  to: Id,
  label: z.string().min(1),
  description: z.string().optional(),
  dataIds: z.array(Id).default([]),
  codeRefs: z.array(CodeRef).default([]),
});
export type FlowStep = z.infer<typeof FlowStep>;

export const Flow = z.object({
  id: Id,
  name: z.string().min(1).max(120),
  summary: z.string().max(280).default(''),
  steps: z.array(FlowStep).default([]),
});
export type Flow = z.infer<typeof Flow>;

export const Model = z.object({
  version: z.literal(1).default(1),
  name: z.string().default('Architecture'),
  description: z.string().default(''),
  elements: z.array(Element).default([]),
  relations: z.array(Relation).default([]),
  flows: z.array(Flow).default([]),
});
export type Model = z.infer<typeof Model>;

/**
 * Diagram positions, kept out of the model so model diffs stay semantic.
 * Canvas keys: "structure:<scopeId>" (or "structure:root") and "data".
 */
export const Position = z.object({ x: z.number(), y: z.number() });
export type Position = z.infer<typeof Position>;
export const Layout = z.record(z.string(), z.record(z.string(), Position));
export type Layout = z.infer<typeof Layout>;

// ─── Changes ────────────────────────────────────────────────────────────────
// One mutation path for everyone. The UI posts ChangeSets over REST, the agent
// sends the same shape through the `apply_changes` MCP tool.

/** `.partial()` keeps `.default()`s in zod v4, which would make every patch overwrite unspecified fields with defaults. */
function patchShape<S extends z.ZodRawShape>(shape: S) {
  return Object.fromEntries(
    Object.entries(shape).map(([key, schema]) => [key, ((schema instanceof z.ZodDefault ? schema.unwrap() : schema) as z.ZodType).optional()]),
  ) as unknown as { [K in keyof S]: z.ZodOptional<S[K] extends z.ZodDefault<infer Inner> ? Inner : S[K]> };
}

/**
 * Upserts are patches: with an existing id only the given fields change; without
 * an id (or with a new id) the entry is created and `kind` + `name` are required
 * for elements, `from` + `to` for relations, `name` for flows.
 * `parentId: null` moves an element to the top level.
 */
// Additive list helpers. Order within one patch: the full list (if sent) replaces
// the stored one, then removals apply, then additions and updates.

/**
 * Removes code refs with this path, narrowed to the given symbol and/or start line
 * (startLine picks one symbol-less ref among several to the same file).
 */
export const CodeRefSelector = z.object({ path: z.string().min(1), symbol: z.string().optional(), startLine: z.number().int().positive().optional() });
export type CodeRefSelector = z.infer<typeof CodeRefSelector>;

/** Upserts a field by name: given properties change, the rest stay. `ref: null` clears the ref. */
export const FieldPatch = z.object({
  name: z.string().min(1),
  type: z.string().optional(),
  optional: z.boolean().optional(),
  description: z.string().optional(),
  ref: Id.nullable().optional(),
});
export type FieldPatch = z.infer<typeof FieldPatch>;

const codeRefHelpers = {
  /**
   * Appends code refs. A ref already present (same path, symbol and line range) is not duplicated:
   * it is re-sealed against the current file text and takes the sent `note`, if any.
   */
  addCodeRefs: z.array(CodeRef).optional(),
  removeCodeRefs: z.array(CodeRefSelector).optional(),
};

export const ElementPatch = z.object(patchShape(Element.shape)).extend({
  parentId: Id.nullable().optional(),
  /** Convenience: append notes without resending the list. */
  addNotes: z.array(z.string().min(1)).optional(),
  resolveNotes: z.array(Id).optional(),
  ...codeRefHelpers,
  setFields: z.array(FieldPatch).optional(),
  /** Field names to remove. */
  removeFields: z.array(z.string().min(1)).optional(),
});
export type ElementPatch = z.infer<typeof ElementPatch>;

export const RelationPatch = z.object(patchShape(Relation.shape)).extend(codeRefHelpers);
export type RelationPatch = z.infer<typeof RelationPatch>;

/** Indices are 0-based and refer to the step list before this patch (after `steps`, if sent). */
export const StepIndex = z.number().int().min(0);

export const FlowPatch = z.object(patchShape(Flow.shape)).extend({
  /** Changes the given properties of existing steps; `addCodeRefs`/`removeCodeRefs` work as on elements. */
  updateSteps: z.array(z.object(patchShape(FlowStep.shape)).extend({ index: StepIndex, ...codeRefHelpers })).optional(),
  /** Inserts steps before the step at `index`; `index` equal to the step count appends. */
  insertSteps: z.array(z.object({ index: StepIndex, step: FlowStep })).optional(),
  removeSteps: z.array(StepIndex).optional(),
});
export type FlowPatch = z.infer<typeof FlowPatch>;

export const ChangeSet = z.object({
  /** One line for the activity feed: "Split billing out of order-service". */
  summary: z.string().max(200).optional(),
  model: z.object({ name: z.string().optional(), description: z.string().optional() }).optional(),
  elements: z.array(ElementPatch).optional(),
  relations: z.array(RelationPatch).optional(),
  flows: z.array(FlowPatch).optional(),
  /** Removing an element also removes its descendants, attached relations and flow steps. */
  remove: z
    .object({
      elements: z.array(Id).optional(),
      relations: z.array(Id).optional(),
      flows: z.array(Id).optional(),
    })
    .optional(),
  /** Partial layout update: canvas key → element id → position (null clears). */
  layout: z.record(z.string(), z.record(z.string(), Position.nullable())).optional(),
});
export type ChangeSet = z.infer<typeof ChangeSet>;

export interface ChangeResult {
  revision: number;
  created: { elements: string[]; relations: string[]; flows: string[] };
  updated: { elements: string[]; relations: string[]; flows: string[] };
  removed: { elements: string[]; relations: string[]; flows: string[] };
  warnings: string[];
}

/** One entry of the shared activity journal. Layout-only changes are not journaled. */
export interface JournalEntry {
  revision: number;
  at: string; // ISO timestamp
  actor: Actor;
  summary: string; // given or generated ("Added 3 elements, 2 relations")
  created: ChangeResult['created'];
  updated: ChangeResult['updated'];
  removed: ChangeResult['removed'];
}

// ─── Session ────────────────────────────────────────────────────────────────

export const PERSPECTIVES = ['structure', 'data', 'flows'] as const;
export const Perspective = z.enum(PERSPECTIVES);
export type Perspective = z.infer<typeof Perspective>;

/** What the human is looking at right now. Pushed by the UI, read by the agent. */
export const UiState = z.object({
  perspective: Perspective.default('structure'),
  /** Structure perspective: the element whose inside is shown; absent at the top level. */
  scopeId: Id.optional(),
  flowId: Id.optional(),
  selectedElementIds: z.array(Id).default([]),
  selectedRelationIds: z.array(Id).default([]),
});
export type UiState = z.infer<typeof UiState>;

export interface AgentPresence {
  connected: boolean;
  clientName?: string;
  lastSeenAt?: string;
}

/** Sent by the agent to steer the human's view. */
export interface FocusRequest {
  perspective?: Perspective;
  scopeId?: string | null;
  flowId?: string;
  elementIds: string[];
  message?: string;
}

/**
 * Why a code ref no longer matches the repository.
 * - symbol-outside-range: the symbol exists in the file but not within startLine..endLine.
 * - moved (sealed refs only): the sealed text is gone from its lines but found verbatim elsewhere in the file; see `suggestion`.
 * - changed (sealed refs only): the sealed text is gone and not found elsewhere; `suggestion`, when present, is where the symbol is now.
 */
export type StaleReason = 'missing-file' | 'line-out-of-range' | 'symbol-not-found' | 'symbol-outside-range' | 'moved' | 'changed';

/** A suggested new line range for a moved or changed ref. */
export interface LineRange {
  startLine: number;
  endLine: number;
}

/** A code reference whose target no longer matches the repository. */
export interface StaleLink {
  ownerType: 'element' | 'relation' | 'flow';
  ownerId: string;
  /** For flow refs: the 1-based step number that holds the ref. */
  step?: number;
  ref: CodeRef;
  reason: StaleReason;
  /** For `moved` (always) and `changed` (when it can be determined): the range the ref should point at now. */
  suggestion?: LineRange;
}

export interface Snapshot {
  revision: number;
  model: Model;
  layout: Layout;
}

/**
 * The stored form of a code ref path: forward slashes, no "./" segments, no trailing slash.
 * "." stands for the repository root.
 */
export function normalizeCodePath(input: string): string {
  const parts: string[] = [];
  const absolute = /^\s*[\\/]/.test(input);
  for (const part of input.trim().replace(/\\/g, '/').split('/')) {
    if (!part || part === '.') continue;
    if (part === '..' && parts.length && parts.at(-1) !== '..') parts.pop();
    else if (part !== '..' || !absolute) parts.push(part);
  }
  const joined = parts.join('/');
  return absolute ? `/${joined}` : joined || '.';
}

export function slugify(name: string): string {
  const slug = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return slug || 'item';
}

export function uniqueId(base: string, taken: ReadonlySet<string>): string {
  if (!taken.has(base)) return base;
  for (let i = 2; ; i++) {
    const candidate = `${base}-${i}`;
    if (!taken.has(candidate)) return candidate;
  }
}
