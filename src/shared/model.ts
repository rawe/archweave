/**
 * The ArchWeave architecture model: the single contract shared by the server,
 * the web UI and the MCP tools. Everything is one graph of elements and
 * relations; the structure, data and flows perspectives are lenses onto that graph.
 * Diagrams are authored drawings beside it: they may point at the graph, they never add to it.
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
   * Seal of the text at startLine..endLine, computed by the server when the ref is written. Lets the checker
   * tell moved code from changed code. A ref written with a digest claims "this is still the same code": the
   * server keeps it when the ref is unchanged, verifies it against the file when the location changed, and
   * rejects the change set when the text there does not match. A ref written without one is sealed afresh.
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

// ─── Diagrams ───────────────────────────────────────────────────────────────
// A diagram is a drawing someone made: shapes, connectors and their styling are the
// content. A shape may link to a model item, which makes it a reference, never a
// second definition; a connector is a drawn line and never a relation.

export const SHAPE_KINDS = [
  'box', // rounded rectangle, the default
  'pill', // fully rounded: start and end points, queues, small labels
  'cylinder', // stores
  'diamond', // decisions
  'actor', // a person
  'note', // an annotation with a folded corner
  'text', // free text without an outline
  'group', // a titled frame that contains other shapes
] as const;
export const ShapeKind = z.enum(SHAPE_KINDS);
export type ShapeKind = z.infer<typeof ShapeKind>;

export const OUTLINES = ['solid', 'dashed', 'dotted', 'none'] as const;
export const Outline = z.enum(OUTLINES);
export type Outline = z.infer<typeof Outline>;

export const LINE_STYLES = ['solid', 'dashed', 'dotted'] as const;
export const LineStyle = z.enum(LINE_STYLES);
export type LineStyle = z.infer<typeof LineStyle>;

/** The whole colour vocabulary of a diagram. The renderer owns the actual colours, per theme. */
export const TONES = ['neutral', 'blue', 'teal', 'green', 'amber', 'red', 'violet'] as const;
export const Tone = z.enum(TONES);
export type Tone = z.infer<typeof Tone>;

/** none = see-through, plain = the surface colour, tint = a soft wash of the tone, solid = the tone itself with light text. */
export const FILLS = ['none', 'plain', 'tint', 'solid'] as const;
export const Fill = z.enum(FILLS);
export type Fill = z.infer<typeof Fill>;

export const TEXT_SIZES = ['s', 'm', 'l'] as const;
export const TextSize = z.enum(TEXT_SIZES);
export type TextSize = z.infer<typeof TextSize>;

export const SIDES = ['top', 'right', 'bottom', 'left'] as const;
export const Side = z.enum(SIDES);
export type Side = z.infer<typeof Side>;

/** What a shape stands for in the model. */
export const ModelLink = z.object({ type: z.enum(['element', 'flow', 'diagram']), id: Id });
export type ModelLink = z.infer<typeof ModelLink>;

/**
 * Style properties left out take the default of the shape's kind (see `shapeStyle` in shared/diagram),
 * so a diagram file only records what its author chose.
 */
export const DiagramShape = z.object({
  /** Unique within the diagram, among shapes and connectors together. */
  id: Id,
  kind: ShapeKind.default('box'),
  /** The label. Line breaks are kept. A linked shape with no text shows the linked item's current name. */
  text: z.string().max(400).default(''),
  /** A second, quieter block of text under the label. */
  detail: z.string().max(600).optional(),
  link: ModelLink.optional(),
  /** The group this shape sits in. Moving a group moves what is inside. */
  parent: Id.optional(),
  /** Top-left corner and size in diagram units (pixels at 100%). Always absolute, also inside a group. */
  x: z.number(),
  y: z.number(),
  w: z.number().positive(),
  h: z.number().positive(),
  outline: Outline.optional(),
  tone: Tone.optional(),
  fill: Fill.optional(),
  size: TextSize.optional(),
});
export type DiagramShape = z.infer<typeof DiagramShape>;

export const CONNECTOR_ENDS = ['arrow', 'both', 'none'] as const;
export const CONNECTOR_ROUTES = ['elbow', 'straight', 'curve'] as const;

/** A drawn line between two shapes. It stays attached when they move. */
export const DiagramConnector = z.object({
  id: Id,
  from: Id,
  to: Id,
  label: z.string().max(120).default(''),
  line: LineStyle.optional(), // default solid
  /** arrow = a head at `to`; both = heads at both ends; none = a plain line. Default arrow. */
  ends: z.enum(CONNECTOR_ENDS).optional(),
  /** elbow = right angles with rounded corners (default), straight, or curve. */
  route: z.enum(CONNECTOR_ROUTES).optional(),
  tone: Tone.optional(),
  /** Pins the side of the shape the line leaves from or arrives at. Unset: the renderer picks the facing sides. */
  fromSide: Side.optional(),
  toSide: Side.optional(),
});
export type DiagramConnector = z.infer<typeof DiagramConnector>;

export const DIAGRAM_DIRECTIONS = ['down', 'right'] as const;

export const Diagram = z.object({
  id: Id,
  name: z.string().min(1).max(120),
  summary: z.string().max(280).default(''),
  /** The reading direction automatic arrangement follows. */
  direction: z.enum(DIAGRAM_DIRECTIONS).default('down'),
  /** In drawing order: later shapes lie on top. Groups are always drawn behind what they contain. */
  shapes: z.array(DiagramShape).default([]),
  connectors: z.array(DiagramConnector).default([]),
});
export type Diagram = z.infer<typeof Diagram>;

export const Model = z.object({
  version: z.literal(1).default(1),
  name: z.string().default('Architecture'),
  description: z.string().default(''),
  elements: z.array(Element).default([]),
  relations: z.array(Relation).default([]),
  flows: z.array(Flow).default([]),
  /** Stored one file per diagram, beside model.json (see Persistence in docs/DESIGN.md). */
  diagrams: z.array(Diagram).default([]),
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
   * it takes the sent `note`, if any, and, when sent without a digest, is sealed afresh against the current file text.
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

/**
 * Upserts a shape by id: with an existing id only the given properties change; otherwise the shape is created.
 * A new shape needs nothing: without `w`/`h` it is sized to fit its text, without `x`/`y` it is placed
 * automatically. `null` clears an optional property back to its default.
 */
export const ShapePatch = z.object({
  id: Id.optional(),
  kind: ShapeKind.optional(),
  text: z.string().max(400).optional(),
  detail: z.string().max(600).nullable().optional(),
  link: ModelLink.nullable().optional(),
  parent: Id.nullable().optional(),
  x: z.number().optional(),
  y: z.number().optional(),
  w: z.number().positive().optional(),
  h: z.number().positive().optional(),
  outline: Outline.nullable().optional(),
  tone: Tone.nullable().optional(),
  fill: Fill.nullable().optional(),
  size: TextSize.nullable().optional(),
});
export type ShapePatch = z.infer<typeof ShapePatch>;

/** Upserts a connector by id. A new connector needs `from` and `to`. `null` clears an optional property. */
export const ConnectorPatch = z.object({
  id: Id.optional(),
  from: Id.optional(),
  to: Id.optional(),
  label: z.string().max(120).optional(),
  line: LineStyle.nullable().optional(),
  ends: z.enum(CONNECTOR_ENDS).nullable().optional(),
  route: z.enum(CONNECTOR_ROUTES).nullable().optional(),
  tone: Tone.nullable().optional(),
  fromSide: Side.nullable().optional(),
  toSide: Side.nullable().optional(),
});
export type ConnectorPatch = z.infer<typeof ConnectorPatch>;

/**
 * Order within one patch: `shapes` / `connectors` (full lists, replacing the stored ones) first, then
 * `removeShapes` and `removeConnectors`, then `setShapes` and `setConnectors`.
 * Removing a shape removes the connectors attached to it; what was inside a removed group moves out to the group's own parent.
 */
export const DiagramPatch = z.object({
  id: Id.optional(),
  name: z.string().min(1).max(120).optional(),
  summary: z.string().max(280).optional(),
  direction: z.enum(DIAGRAM_DIRECTIONS).optional(),
  shapes: z.array(ShapePatch).optional(),
  connectors: z.array(ConnectorPatch).optional(),
  setShapes: z.array(ShapePatch).optional(),
  removeShapes: z.array(Id).optional(),
  setConnectors: z.array(ConnectorPatch).optional(),
  removeConnectors: z.array(Id).optional(),
  /**
   * Asks the server to arrange the diagram before applying: "new" (the default) places only shapes that have no
   * position yet and leaves the rest where they are; "all" arranges every shape afresh. Not stored.
   */
  arrange: z.enum(['new', 'all']).optional(),
  /**
   * Seeds the diagram from the model, on the server before applying: a linked shape for each of these elements
   * that is not on the diagram yet, and a connector for each pair of shapes that relations connect and no
   * connector does yet. A relation of something not drawn is lifted to its nearest drawn ancestor. Not stored.
   */
  seed: z.array(Id).optional(),
});
export type DiagramPatch = z.infer<typeof DiagramPatch>;

export const ChangeSet = z.object({
  /** One line for the activity feed: "Split billing out of order-service". */
  summary: z.string().max(200).optional(),
  /**
   * The model revision the change set was built from. When the model is at another revision, nothing is applied
   * (409 over REST, a tool error over MCP). Ignored by layout-only change sets.
   */
  expectedRevision: z.number().int().min(0).optional(),
  model: z.object({ name: z.string().optional(), description: z.string().optional() }).optional(),
  elements: z.array(ElementPatch).optional(),
  relations: z.array(RelationPatch).optional(),
  flows: z.array(FlowPatch).optional(),
  diagrams: z.array(DiagramPatch).optional(),
  /**
   * Removing an element also removes its descendants, attached relations and flow steps.
   * Diagram shapes that linked to something removed stay, as plain shapes keeping the name they showed.
   */
  remove: z
    .object({
      elements: z.array(Id).optional(),
      relations: z.array(Id).optional(),
      flows: z.array(Id).optional(),
      diagrams: z.array(Id).optional(),
    })
    .optional(),
  /** Partial layout update: canvas key → element id → position (null clears). */
  layout: z.record(z.string(), z.record(z.string(), Position.nullable())).optional(),
});
export type ChangeSet = z.infer<typeof ChangeSet>;

/** Ids per collection. */
export interface IdLists {
  elements: string[];
  relations: string[];
  flows: string[];
  diagrams: string[];
}

export interface ChangeResult {
  revision: number;
  created: IdLists;
  updated: IdLists;
  removed: IdLists;
  warnings: string[];
}

/** One entry of the shared activity journal. Layout-only changes are not journaled. */
export interface JournalEntry {
  /** The model revision after this change. Entries coalesced from several quick edits carry the latest. */
  revision: number;
  /** For coalesced entries: the revision of the first edit they hold. */
  firstRevision?: number;
  at: string; // ISO timestamp
  actor: Actor;
  summary: string; // given or generated ("Added 3 elements, 2 relations")
  created: ChangeResult['created'];
  updated: ChangeResult['updated'];
  removed: ChangeResult['removed'];
}

// ─── Session ────────────────────────────────────────────────────────────────

export const PERSPECTIVES = ['structure', 'data', 'flows', 'diagrams'] as const;
export const Perspective = z.enum(PERSPECTIVES);
export type Perspective = z.infer<typeof Perspective>;

/** What the human is looking at right now. Pushed by the UI, read by the agent. */
export const UiState = z.object({
  perspective: Perspective.default('structure'),
  /** Structure perspective: the element whose inside is shown; absent at the top level. */
  scopeId: Id.optional(),
  flowId: Id.optional(),
  /** Diagrams perspective: the diagram that is open. */
  diagramId: Id.optional(),
  selectedElementIds: z.array(Id).default([]),
  selectedRelationIds: z.array(Id).default([]),
  /** Diagrams perspective: selected shapes and connectors of the open diagram. */
  selectedShapeIds: z.array(Id).default([]),
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
  diagramId?: string;
  /** Shapes and connectors of `diagramId` to highlight. */
  shapeIds?: string[];
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
