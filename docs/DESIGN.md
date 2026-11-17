# ArchWeave design

ArchWeave is one workspace with two doors. A developer walks in through the browser, a coding agent walks in through MCP, and both stand in front of the same architecture model of the repository they are working in.

This document is the contract for the implementation. `src/shared/model.ts` is the contract for the data.

## 1. The loop the product is built around

1. **Understand.** The agent reads the code and builds a model: elements, relations, data structures, flows, each linked to the files that implement it.
2. **Explore.** The developer navigates the model, drills into components, opens the linked code, follows a data structure to everything that touches it.
3. **Direct.** The developer selects something and talks to the agent ("explain this", "why does this call that", "split this in two"). The agent reads the selection through MCP. The developer may also edit the model directly or pin a note on an element; those edits are intent the agent can read.
4. **Change.** The agent changes code, then updates the model so it matches. Planned elements become built. Stale code links are repaired.

The same loop works starting from an empty model: the developer designs planned elements first, the agent implements them and marks them built.

Modeling stays human-directed. The agent never restructures the model on its own initiative; it reflects code, answers notes, and carries out requests.

## 2. Model

One graph. See `src/shared/model.ts` for the exact shapes.

- **Element**: anything with a name. Has a `kind`, a one-line `summary`, a markdown `description`, a `status` (`planned`, `built`, `deprecated`), `codeRefs`, `notes`, and an optional `parentId`. Containment gives zoom levels: system, then apps and services, then components, then modules.
- **Data structures are elements** of kind `data` with `fields`, `format` and an `example`. A field can `ref` another data element. A data element may have a `parentId` (the element that owns or defines it).
- **Relation**: directed edge with a `kind`, a short `label`, and `dataIds` naming the data structures that travel over it. Relations of kind `reads`, `writes`, `produces`, `consumes` from a non-data element to a data element say who touches a structure. `references` links data to data.
- **Flow**: a named scenario, an ordered list of steps `from → to` with a label and optional data and code references.
- **CodeRef**: repo-relative `path`, optional `symbol`, optional line range, optional `note`, and the server's `digest` seal (see Stale link detection).
- **Note**: text pinned to an element by the human or the agent, resolvable. Human notes are the lightweight way to hand work to the agent.
- **Diagram**: a drawing beside the graph, made by the human or the agent to explain one idea: `shapes` (box, pill, cylinder, diamond, actor, note, text, group) and `connectors` between them, styled from a small vocabulary (outline, tone, fill, text size; line, ends, route, sides), with a reading `direction` (down or right). Shape positions and sizes are part of the content. A shape may `link` to an element, flow or diagram; a linked shape without text shows the item's live name. A connector is a drawn line, never a relation: a diagram points at the model and never adds to it. Removing a linked item keeps its shapes, unlinked, with the name they showed.

Ids are readable slugs generated from names and never change on rename.

### Persistence

Everything lives in the data directory (`ARCHWEAVE_DATA_DIR`, default `<repo>/.archweave`):

```
.archweave/
  model.json      elements, relations, flows. Stable ordering (sorted by id), 2-space JSON, trailing newline.
  layout.json     positions on the structure and data canvases. Same formatting rules.
  diagrams/
    <id>.json     one file per diagram, with its shapes and connectors in drawing order. Same formatting rules.
  .gitignore      contains "state/"
  state/          not tracked
    journal.jsonl activity journal, capped at 500 entries
```

Arrays are written sorted by id and default-valued fields are omitted, so Git diffs are small and meaningful. Writes are atomic (temp file plus rename) and debounced (about 150 ms). The server watches these files (a diagram file added, changed or deleted counts too); when they change on disk for a reason other than its own write (git checkout, manual edit), it reloads, bumps the revision and broadcasts.

## 3. Server

A single Node process serves the UI, the REST API, the event stream and the MCP endpoint on one port (`PORT`, default `4317`). Environment:

| Variable | Default | Meaning |
| --- | --- | --- |
| `ARCHWEAVE_REPO_DIR` | current directory | The repository being modeled. Read-only use. |
| `ARCHWEAVE_DATA_DIR` | `<repo>/.archweave` | Model storage. |
| `ARCHWEAVE_HOST_REPO_PATH` | unset | Absolute path of the repo on the host, used to build "open in editor" links when running in Docker. |
| `PORT` / `HOST` | `4317` / `127.0.0.1` | Listen address. Docker image sets `HOST=0.0.0.0`. |

### Store

One in-memory store owns the model, layout, revision counter, journal and undo stack. Every mutation is a `ChangeSet` applied through one function:

`apply(changeSet, actor) → ChangeResult`

Rules:
- Validation is all-or-nothing. On error nothing is applied and the error names the offending entry.
- Upsert semantics as documented on `ElementPatch`. Missing ids are generated with `slugify` + `uniqueId`.
- Referential integrity: `parentId`, relation endpoints, `dataIds`, field `ref`, flow step endpoints must exist after the change set is applied (so one change set can create an element and relate to it), and `dataIds` and field `ref`s must name elements of kind `data`. No containment cycles. A `dataIds` entry or field `ref` written in the change set that does not name a data structure is an error with a did-you-mean hint. Stored references broken by the change set (a removed element, an element that is no longer of kind `data`) are cleaned up with a warning.
- Removing an element removes descendants, attached relations, flow steps that touch them, and their layout entries.
- Elements created by the human default to `status: planned` unless given; elements created by the agent default to `built` when they carry at least one code ref or are of a kind that never has code (actor, external, system), otherwise `planned`.
- `expectedRevision` (optional) names the revision the change set was built from. When the model is at another revision nothing is applied: REST answers 409, MCP returns a tool error, both saying the model changed and to read it again. Layout-only change sets ignore it.
- After applying, the result passes the same graph integrity check the store runs on load (duplicate ids, missing references, data references to non-data elements, containment cycles); a change set that fails it is a validation error naming the problem, so no change set can persist a model that will not load.
- Code ref paths are stored repo-relative: an absolute path inside the repository is made relative; an absolute path outside it, or one escaping it with `..`, is a validation error.
- A change set that only contains `layout` does not create a journal entry or an undo step and does not bump the model revision visibly to the agent (it still broadcasts to browsers).
- Undo: the store keeps the last 50 model snapshots. `undo()` restores the previous one and journals it.
- Diagrams change through `diagrams` patches (see `DiagramPatch`), applied by the same function the browser uses for its optimistic update (`shared/diagram/patch.ts`). Upserts by id; full `shapes`/`connectors` lists replace the stored ones, `setShapes`/`setConnectors` change single entries, `removeShapes`/`removeConnectors` remove them (with the connectors attached; a removed group's content moves out). Errors name the diagram and the entry. A new shape without `w`/`h` is sized to its text; shapes never move unless a position is sent. Diagram files read from disk are repaired instead of refused: a damaged entry is dropped or unlinked and the repair logged.
- Arrangement runs before the store, in `server/arrange.ts`, for `POST /api/changes` and `apply_changes` alike: `seed` is expanded into linked shapes for the given elements and connectors for the relations among them, lifted to the nearest drawn ancestor as the structure perspective lifts them (a new seeded diagram without `direction` is tried both ways and keeps the better), and shapes are placed (`arrange: "new"`, the default, places only new shapes without a position, around the rest; `"all"` lays out every shape afresh with ELK's layered algorithm: several ELK settings are tried, routed as the renderer routes, and the layout with the fewest line problems, shortest lines, fewest bends and crossings and smallest size is kept). The result is written into the change set as plain positions, so the store, the journal and undo see an ordinary change.
- Journal coalescing: a change that only updates one element, relation or flow (nothing created or removed) and has no `summary` gets a generated one naming what changed ("Edited Order: summary, fields"). It is merged into the previous journal entry when that entry is the same kind of edit of the same item by the same actor, less than 60 s old, with nothing journaled in between (an undo or a disk reload ends it). The merged entry takes the new `revision` and `at`, keeps the first edit's revision in `firstRevision`, so `since` queries inside the range still return it, and its summary covers everything changed since the first edit. Undo steps stay one per change.

### REST API

All JSON. Errors are `{ "error": string, "details"?: unknown }` with a 4xx or 5xx status.

| Method and path | Purpose |
| --- | --- |
| `GET /api/health` | `{ status: 'ok', version, revision }`. Liveness for the Docker `HEALTHCHECK`; works without the web UI built. |
| `GET /api/snapshot` | `Snapshot` |
| `POST /api/changes` | Body `ChangeSet`. Applied as actor `human`. Returns `ChangeResult`, or 409 when `expectedRevision` is given and the model is at another revision. |
| `POST /api/undo` | Undo the last model change. Returns `{ revision }` or 409 when nothing to undo. |
| `GET /api/journal?since=<revision>` | `JournalEntry[]`, newest last. |
| `GET /api/session` | `{ ui: UiState, agent: AgentPresence, repo: { name, hostPath? } }` |
| `PUT /api/session/ui` | Body `UiState`. The browser reports what the human sees and has selected. |
| `GET /api/events` | Server-sent events, see below. |
| `GET /api/code/file?path=` | `{ path, exists, content?, lineCount?, language?, truncated? }`. Text files up to 1 MB. |
| `GET /api/code/files?q=&limit=` | Repo file paths matching a fuzzy query, for the code link picker. Uses `git ls-files` when the repo is a Git checkout, otherwise a walk that skips `node_modules`, `.git`, `dist`, `build` and dot-directories. |
| `GET /api/code/stale` | `StaleLink[]` |
| `POST /api/code/repair` | Body `{ scopeId? }`. Re-anchors every code link whose text moved within its file. Returns `{ revision, summary?, repaired, stale }`. |
| `GET /api/export?format=markdown\|json\|mermaid&scope=<id>&perspectives=structure,data,flows,diagrams&code=true\|false` | Download. |
| `GET /api/diagrams/:id/image?format=svg\|png&theme=light\|dark&scale=1..4&background=canvas\|white\|transparent&download=1` | A diagram as a picture, rendered on the server with the same scene code as the browser. |

Server-sent events (`event:` name, JSON `data:`):
- `snapshot`: `{ snapshot: Snapshot, entry?: JournalEntry }` after every applied change, undo or disk reload. Also sent once on connect.
- `agent`: `AgentPresence` when it changes.
- `focus`: `FocusRequest` when the agent asks to show something.
- A comment line every 25 s as keep-alive.

Repository access is read-only and confined to `ARCHWEAVE_REPO_DIR`: resolve the real path and reject anything outside it, reject paths inside `.git`.

### Stale link detection

Every code ref is checked against the repository: `missing-file` when the path does not exist, `line-out-of-range` when `endLine` or `startLine` exceeds the file's line count, `symbol-not-found` when `symbol` is given and does not occur as an identifier (whole word, not in quotes) in the file, `symbol-outside-range` when it occurs but not within `startLine..endLine`. Computed on demand with a cache keyed by file mtime and size.

**Seals.** When a ref with a line range is written through the store (create or change, by anyone) and the file is a readable text file, the server stores `digest`: SHA-256 over the linked lines, each trimmed of whitespace at both ends, joined by `\n`, first 12 base64url characters. A written ref that carries a digest is a claim that this is still the same code:
- same location and digest as the stored ref: kept as is, without reading the file (resending a list as read never accepts drift);
- a digest at another location, or with no stored counterpart: the server reads the file; when the text at that range has this digest, the ref is stored with it (a verified move); otherwise the change set is rejected ("the code at … is not the text this link was sealed to; send the ref without digest to seal it to the current text");
- no digest: sealed afresh against the current file, an explicit statement by the writer that the range is right. A ref re-sent without digest in `addCodeRefs` (on elements, relations, and flow steps through `updateSteps`) is how an agent accepts edited code as still right, and how a ref without a seal gets one.

A ref that is already stale when written comes back as a warning in the `ChangeResult`. Binary files (a NUL byte in the first 8000 bytes, as the code file endpoint decides), files over 1 MB and directories are checked for existence only and never sealed.

**Checking a sealed ref** compares text. If the linked lines still match the seal, the checks above apply. Otherwise:
- `moved`: a window of the same length with the same seal exists elsewhere in the file (nearest to the old start first; with a `symbol`, the window must contain it). `suggestion` is the new `{startLine, endLine}`.
- `changed`: the text was edited. With a `symbol` that no longer occurs, the reason is `symbol-not-found`. With a symbol that still occurs in the old range there is no suggestion; elsewhere, `suggestion` keeps the old length and starts at the symbol's only declaration-like occurrence (`function x`, `class x`, `def x`, `const x`, …) or its only occurrence, else none. Without a symbol, a range past the end of the file is `line-out-of-range`.

Refs without a seal (no line range, unreadable or binary file, or not written since sealing existed) keep the plain checks.

**Repair** (`check_code_links` with `repair: true` as the agent, `POST /api/code/repair` with optional body `{ scopeId }` as the human) applies every `moved` suggestion across elements, relations and flow steps in one journaled change set ("Re-anchored 11 code links in src/server/routes.ts"), with `expectedRevision` set. Each moved ref keeps its digest, so the store verifies the text at every destination when it applies the change set. When the model or a file changed since the check, repair checks once more; what it still cannot apply is reported, not written. It returns `{ revision, summary?, repaired, stale }`, where `stale` is what still needs attention. `changed` refs are never repaired automatically. Plain reads never write.

### Export

- **markdown**: an architecture document. Title and description; per scope a section with a Mermaid flowchart of that level and a short entry for each element (summary, description, code links, notes that are open); a data section with a field table per structure and "used by"; a flows section with a Mermaid sequence diagram per flow; a list of the drawn diagrams by name and summary (without a `scope`). `scope` limits the document to one subtree.
- **mermaid**: just the diagrams.
- **json**: `{ model, layout }`.

Image export (PNG, SVG) of the structure, data and flows canvases happens in the browser; drawn diagrams are rendered by the image route.

## 4. MCP

Streamable HTTP at `/mcp` on the same port, stateless JSON responses are fine. Validate the `Host` header against localhost names and the configured host to block DNS rebinding. Any MCP request marks the agent as present (`lastSeenAt`, `clientName` from `initialize`); presence expires to `connected: false` after 60 s without requests.

The server `instructions` are a short router: what ArchWeave is, which tool to call when, and that `get_guide` must be read before the first change to the model (topic `modeling`) and before drawing or changing a diagram (topic `diagrams`). Clients keep only the start of the instructions (Claude Code the first 4096 characters, Codex advises a self-contained first 512), so they stay under 4096 characters with the essentials in the first 500, and the guides (section 4.2) stay behind `get_guide`.

### 4.1 Tools

Keep the surface small. Tool results are compact JSON text. Every tool that returns elements uses the same compact form unless asked for detail.

| Tool | Input | Returns |
| --- | --- | --- |
| `get_guide` | `topic?`: `modeling` (default) or `diagrams` | The guide for that topic. |
| `get_context` | none | What the human is doing now: `ui` state with the selected elements and relations expanded in full (including code refs, notes, children, relations in and out), the breadcrumb of the current scope, what the canvas shows (structure: the scope's nodes and threads; data: the catalog as counts per owner, or the focused structure with its fields, the structures it references and that reference it, and its users by verb; diagrams: the open diagram's outline, or the list of diagrams, and the selected shapes and connectors in full, a linked shape with its element), open notes across the model, journal entries by the human since the agent's last `get_context` or `apply_changes` (the 20 most recent; `olderHumanChangesOmitted` counts the rest), and stale link count. This is the first call for any request that says "this", "here", "the selected". |
| `get_model` | `scopeId?`, `depth?` (default 2), `kinds?`, `includeData?` | Outline of the model: nested elements as `{id, kind, name, summary, status, children}` plus relations among them, flows by name, diagrams as `{id, name, summary, shapes}`, counts. |
| `get_element` | `id` | One element in full: fields, code refs, notes, parent chain, children, relations in and out with the other end's name, flows it takes part in, data it touches, diagrams that show it. Works for relation and flow ids too. A diagram id returns its outline: shapes nested in their groups with `label`, `link` (with the element's kind and status), the style set on them and `at: [x, y, w, h]`, connectors with their set properties, `direction`, counts and lints. |
| `search` | `query`, `kinds?`, `limit?` | Elements whose name, summary, description, tags, field names or code paths match, and (without `kinds`) diagrams whose name, summary or shape texts match. |
| `find_by_code` | `paths: string[]` | Elements, relations and flow steps whose code refs touch those files or directories, each ref with its current `check` (`ok`, `moved` with `suggestion`, `changed`, or another stale reason) and a count per check. Call this after changing code to find what to update and what needs re-anchoring. |
| `apply_changes` | `ChangeSet` (as in `model.ts`) | `ChangeResult`, plus `diagrams: [{id, lints}]` for every diagram created or updated. Applied as actor `agent` after arrangement (see Store). `summary` is required here. A stale `expectedRevision` is a tool error. |
| `check_code_links` | `scopeId?`, `repair?` | Stale links (flow refs with their `step`), plus built elements of kinds that should have code (app, service, component, module, data) without any code ref. With `repair: true`: re-anchors moved links in one change set and returns what it changed and what still needs attention. |
| `get_changes` | `since?` (revision), `actor?` | Journal entries. |
| `focus_ui` | `elementIds`, `perspective?`, `scopeId?`, `flowId?`, `diagramId?`, `shapeIds?`, `message?` | Asks the browser to show and highlight these elements, or to open a diagram and highlight shapes and connectors on it. Returns whether a browser is connected. |
| `render_diagram` | `id`, `theme?`, `scale?` | An MCP image block (PNG, at most 1568 pixels on the long edge) followed by a text block with the diagram's lints. |
| `export` | `format`, `scope?` | The export text. |

**Lints** (`shared/diagram/lints.ts`) tell an agent that cannot see the picture what a reviewer would notice, one actionable sentence each: shapes that overlap (other than a group and its content), a shape sticking out of its group, a line running through or along a shape that is not one of its ends, two lines from different shapes running on top of each other, a label covering a shape, another label or another line (all routed and placed as the renderer does it; lines of one fan may share a trunk), text that does not fit its shape, two connectors between the same shapes in the same direction with the same label, a shape with neither text nor link, and more than 40 shapes.

Errors come back as tool errors with a message the agent can act on ("relation `a-calls-b`: unknown element `b`. Did you mean `billing`?").

### 4.2 Guides (text shipped to agents)

`src/server/guide.ts` holds the instructions router and two guides, returned by `get_guide`. The `diagrams` guide covers what a diagram is and is not (a drawing; links show live names; connectors are never relations; promoting a drawn box), the workflow (`get_context`, `get_element`, one `apply_changes` with readable ids and no positions, lints, `render_diagram`, `focus_ui`), the vocabulary, composition conventions, editing a diagram a human arranged, and worked examples. The `modeling` guide, in this spirit:

- ArchWeave holds the architecture of this repository. The human sees and edits the same model in a browser. Keep it truthful to the code and readable by a person.
- Start with `get_context` whenever the request refers to what the human sees or selected.
- Model in levels. Top level: the system's apps, services, stores, external systems and actors, at most about a dozen nodes. Inside each: its components. Inside those, modules only where it helps. Prefer 5 to 9 children per element.
- Names are what a developer would say out loud. Summaries are one plain sentence about responsibility, not implementation.
- Every built element carries code refs to the files that best show it: entry points, the main class, the schema. Three precise refs beat twenty. Use `symbol` and line ranges when you know them.
- Model data structures that cross boundaries or that people argue about: entities, API payloads, events, config. Give fields with types, link fields to other structures with `ref`, attach an example for wire formats, and connect producers and consumers.
- Add flows for the handful of scenarios that explain the system: a request end to end, a background job, an agent loop.
- Use relation `label` for the verb ("places order"), `technology` for the protocol, `dataIds` for what travels.
- Send one `apply_changes` per coherent step with a `summary` the human will read in the activity feed.
- After changing code: `find_by_code` for the touched paths, update the affected elements, set `status`, fix code refs, resolve notes you handled with `resolveNotes`.
- Planned elements and open human notes are design intent. Implement toward them; do not delete or reshape them without being asked. If the code cannot match the plan, add a note explaining why.
- Do not set layout. The browser arranges new elements. On diagrams, leave positions out: the server arranges them.
- Use `focus_ui` to show the human what you are talking about.

## 5. Web UI

React, Vite, `@xyflow/react` for the canvas, `elkjs` for automatic layout, `zustand` for state. The built UI is served by the server from `dist/web`. In development Vite proxies `/api` and `/mcp` to the server.

### 5.1 Principles

- **The canvas is the page.** Chrome floats over it in small pieces and gets out of the way. No sidebars that are always open, no headers above panels, no captions explaining what a panel is.
- **One accent per author.** The human's selection and edits are cobalt. The agent's activity is saffron. Nothing else in the interface uses those two hues, so a glance tells who did what. The tones of drawn diagrams are content, not interface: they are chosen beside the two author hues, not from them (the diagram blue leans to steel, its amber to ochre), so a toned shape never reads as selected or as touched by the agent.
- **Threads carry the meaning.** Relations are drawn as calm, thin threads. Selecting an element brings its threads and neighbors forward and lets the rest recede. This focus behavior is the signature of the product and the main tool for reading a dense diagram.
- **Words are scarce.** Diagram nodes show a name, and at comfortable zoom the full summary. Everything else appears in the inspector on selection. Explanations live behind `?`.
- **Nothing is cut off.** No text on a canvas or in a panel is ever shortened with an ellipsis or clipped: names, summaries, field names, field types, technology, labels, paths and list entries wrap, and their container grows to fit. To reduce density the interface hides a whole kind of content (the "names only" view option hides summaries; neighbor chips never had them), it never shows half of it. A diagram the reader cannot fully read is useless.
- **Keyboard first, pointer complete.** Every action is reachable both ways. While a dialog, the palette or the export dialog is open, no global shortcut acts.

### 5.2 Visual language

Tokens (CSS custom properties on `:root`, dark values under `[data-theme="dark"]`; follow `prefers-color-scheme` until the user toggles):

| Token | Light | Dark | Use |
| --- | --- | --- | --- |
| `--canvas` | `#EDF0F3` | `#12161C` | Canvas background, a cool drafting grey |
| `--surface` | `#FFFFFF` | `#1B212A` | Nodes, panels |
| `--surface-2` | `#F5F7F9` | `#232A35` | Insets, hover |
| `--line` | `#D3D9E0` | `#313A47` | Borders, resting threads |
| `--ink` | `#17202B` | `#E8ECF1` | Primary text |
| `--ink-2` | `#5B6878` | `#98A4B3` | Secondary text |
| `--ink-3` | `#8E99A6` | `#66717F` | Tertiary, placeholders |
| `--human` | `#2456E6` | `#6E96FF` | Selection, human focus |
| `--agent` | `#D99A0B` | `#F2BC3D` | Agent activity |
| `--warn` | `#C2410C` | `#F08A5D` | Stale links |

Type: IBM Plex Sans (variable, `@fontsource-variable/ibm-plex-sans`) for interface text, IBM Plex Mono (`@fontsource/ibm-plex-mono`) only for real code: paths, symbols, field types, code view. Sizes 12, 13, 15, 18, 24. Sentence case everywhere. No uppercase labels, no letter-spaced eyebrows.

Shape: nodes are 10 px radius rectangles with a 1 px `--line` border and no shadow at rest; floating chrome has a soft two-layer shadow. Kind is shown by a small line icon at the node's top left and by silhouette where it helps: `store` has a cylinder-top hint, `queue` a pill, `actor` a circle badge, `external` a dashed-corner outline, `data` a card with field rows. Status: `planned` is a dashed border with a slightly transparent fill, `deprecated` strikes the name and fades.

Canvas background: a faint dot grid that fades out when zoomed far out.

Threads: 1.25 px, `--line` at rest, smooth step or bezier routed with rounded corners, small arrowhead. Label shown only while the thread is hovered or its relation is selected; a focused element's relations read in the inspector. Planned relations are dashed. A relation carrying data shows a small diamond at its midpoint; hovering it lists the structures.

Focus: when something is selected, its threads take `--human`, neighbors keep full contrast, everything else drops to about 35% opacity (transition 160 ms). Clicking the empty canvas restores the whole picture.

Agent activity: elements the agent created or changed get a saffron ring that fades over about 6 seconds, and a saffron dot stays on them until the human selects them once. Removed elements fade out. Respect `prefers-reduced-motion` (no fades, static ring).

### 5.3 Layout

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ ← → ◈ shop › Orders › Checkout  [Structure Data Flows Diagrams]  ⌕  ● ⤓ ◐ ?  │
│                                                                ┌───────────┐ │
│                                                                │ Inspector │ │
│                     canvas                                     │ (only on  │ │
│                                                                │ selection)│ │
│                                                                │           │ │
│ − 80% + ⤢                                                      └───────────┘ │
└──────────────────────────────────────────────────────────────────────────────┘
```

- **Top left:** Back and Forward, then the mark and a breadcrumb of the current scope (or the open flow or diagram). Each crumb is clickable. The model name is the root crumb.
- **Back and Forward** move through the views and selections the human went through, never through changes (that is undo). The address holds the view (perspective, scope, flow, open diagram, focused data structure); each history entry holds the selection (elements, relations, diagram shapes and lines, the flow step), so Back restores both. A new view and a deliberate jump (following a link, a relation row, an activity entry, a linked shape, a palette result, the agent's `focus_ui`) add an entry; selecting on the canvas only updates the current one. Alt+← / Alt+→ and the browser's own buttons do the same. The buttons stay in place, quiet when there is nowhere to go; they know that from the entry's position and the furthest position reachable, both kept in each entry's history state, so a reload keeps them right. A restored selection drops what no longer exists.
- **Top center:** the perspective switch, a four-segment control: Structure, Data, Flows, Diagrams. Keys `1`, `2`, `3`, `4`.
- **Top right:** search (`⌘K`), agent presence, export, theme, help. Icon buttons with tooltips.
- **Bottom left:** zoom out, zoom level, zoom in, fit. Undo appears here after a change.
- **Right:** the inspector, 360 px, slides in on selection, closes with `Esc`.
- **Bottom:** the code drawer, opens when a code link is followed, resizable, closes with `Esc`.

Below 900 px width the inspector becomes a bottom sheet.

### 5.4 Structure perspective

Shows the children of the current scope (top-level elements at the root). Elements of kind `data` are not shown here.

- **Neighbors.** Elements outside the scope that are related to something inside it appear as smaller, quieter context nodes at the edge, lifted to the highest ancestor that is not an ancestor of the scope. Relations are lifted the same way: a relation between two deep descendants is drawn between their visible ancestors, merged when several lift to the same pair (the thread shows a count, the inspector lists the underlying relations). Relations whose two ends lift to the same visible node are hidden.
- **Drill in:** double-click a node, or `Enter` on a selected node, or the small "open" affordance that appears on a node with children. The canvas animates into the node. **Drill out:** `Esc` when nothing is selected, the breadcrumb, or `⌘↑`.
- A node with children shows a child count dot-row or a small "contains 6" on hover, not permanently.
- **Create:** double-click empty canvas, or `N`. A small inline composer appears at the pointer: type a name, pick a kind with `Tab` (kinds cycle, default `component` inside a scope and `service` at root), `Enter` creates. Created inside the current scope.
- **Connect:** drag from a node's edge handle (visible on hover) to another node. The thread is created as `uses`; kind and label are edited in the inspector, with the label field focused.
- **Move into:** drag a node onto another to re-parent, with a clear drop highlight. Also available as "Move to…" in the inspector.
- **Delete:** `Backspace` or `Delete` on a selection. Deleting an element with children asks once.
- **Density:** automatic layout is compact. A scope with about ten elements and as many neighbors is readable at 80% zoom or more on a 1280 px wide window. Neighbors are name-only chips on the rim: callers on the left, callees on the right. Threads leave and enter nodes on the sides facing each other, spread along the side so they do not stack, and curve once; no loops, no detours.
- **Selection stays visible:** when the inspector opens over the selected element or its neighbors, the canvas pans just enough to bring the focused set into the free area.
- **Arrange:** positions persist per scope. New elements without positions are placed by ELK relative to the existing ones without moving them. A canvas that goes from empty to having nodes (an agent filled it) is fitted to the screen once, after placement. "Tidy" in the canvas context menu re-runs layout for the whole scope.
- Multi-select with shift-click and drag-box.

### 5.5 Data perspective

The place to find and discuss data structures. A real codebase has dozens of them, so this perspective never draws them all as one graph. It has two states on one canvas, both laid out deterministically (no stored positions).

**Catalog** (nothing selected). Every `data` element as a compact card: name, format tag, field count. No field rows, no threads. Cards are grouped by owner; each group has a quiet title (the owner's name, which jumps to that element in the Structure perspective) and groups flow into columns that fit the canvas width, so the whole catalog reads top to bottom like a well-set index. Structures without an owner form the first group.

**Focus** (one structure selected). The selected card sits in the center with all its field rows (`name`, mono `type`, optional marker, a link glyph when the field refs another structure).
- Right column: the structures it references, through field `ref`s and `references` relations. Threads run from the referencing field row to the target card.
- Left column: the structures that reference it, with the thread starting at their referencing field row.
- Neighbor cards show their name, the rows involved in the link, and a quiet "n more fields" line; they are one hop only.
- Below the center card: the elements that produce, consume, read or write it, as small quiet nodes grouped by verb. Clicking one jumps to it in the Structure perspective.
- Clicking a neighbor card moves the focus to it with a short transition. Back (the app's button, Alt+←, or the browser's) returns to the previous focus. `Esc` returns to the catalog.

Shared by both states:
- A slim list rail on the left (the only persistent side element, 220 px, collapsible) lists all structures grouped by owner, with a filter field. The filter also narrows the catalog. Selecting an entry focuses that structure. This is what makes any structure reachable in one step.
- Fields are edited in the inspector: add, rename, retype, reorder, link to another structure (never the structure itself), mark optional. The example payload is an editable code block.
- From anywhere, `⌘K` then a structure name jumps here in focus. From the Structure perspective, the inspector of an element lists the data it touches; clicking one jumps here with it focused.

### 5.6 Flows perspective

A flow list (same rail position as the data list) and, for the selected flow, a sequence diagram: participants as columns in order of first appearance, steps as numbered arrows top to bottom, data carried shown as a small chip on the arrow. Numbering is appropriate here because steps are a sequence.

- Selecting a step shows its description, data and code links in the inspector.
- `←` / `→` or `J` / `K` steps through; the active step is cobalt, earlier steps stay at full contrast, later ones recede.
- Participants link back to the Structure perspective.
- Steps are added with "Add step" at the end of the diagram (pick from, to, label), reordered by drag, edited in the inspector.

### 5.7 Diagrams perspective

Drawings beside the model, made by the human or the agent to explain one idea to people: a checkout path for a design review, a deployment sketch for a customer document. A diagram is never the model; it may point at it. Everything on the canvas is drawn by the shared renderer (`shared/diagram`), so what the editor shows is exactly what the SVG and PNG exports contain.

- **List and header.** A diagram list on the left (same rail as Flows, with a filter and "New diagram"). The open diagram's name is the last crumb; a quiet header over the canvas holds its name and summary, editable in place, and a menu: Add from model…, Tidy (arranges every shape afresh after a confirm), Duplicate, Export image…, Delete.
- **Empty states.** No diagrams: two sentences on what a diagram is for and that the agent can draw one, and "New diagram". An empty diagram: double-click to place a box, or pick a shape below.
- **Create.** A small shape toolbar floats at the bottom center: box, group, note, text, then pill, cylinder, diamond, actor, and "From the model" (a picker that places a shape linked to an element, flow or diagram). Choosing a kind arms it; the next click places the shape there with its text open; `Esc` disarms. Keys `B` box, `G` group, `S` note, `T` text. Double-click on empty canvas, or `N`, places a box and starts typing. A shape placed and named is one change; `Esc` while naming it places nothing.
- **Text.** Double-click a shape, or `Enter` on the selected one, edits its label in place, in the position, font, size and alignment the renderer draws it. `Enter` commits, `Shift+Enter` breaks the line, `Esc` cancels. The shape grows while the text needs it. A linked shape without text shows the linked item's live name; typing gives it its own text, clearing it brings the live name back. Double-clicking a line edits its label the same way.
- **Move and arrange.** Shapes snap to an 8-unit grid and line up with the edges and centres of nearby shapes, with a thin guide while they do. Shift-click and Shift-drag a box select several; they move together. Moving a group moves what is inside it. A shape dropped with its centre inside a group joins it, with the same drop highlight as "move into" in Structure; dragged out, it leaves. Arrow keys nudge by 8 (with `Shift` by 1). Resize handles appear on the one selected shape; edges land on the grid and a shape never gets smaller than its text. Each finished gesture is one change, undone with `⌘Z`.
- **Connect.** Drag from a handle on a shape's side to another shape. Released over empty canvas, the line ends in a new box with its text open, so a chain of boxes is drawn in one motion. A selected line shows grips at its ends; dragging one to another shape moves that end.
- **Keys.** `⌫` deletes the selection, `⌘D` duplicates it with an offset, `⌘C` / `⌘V` copy and paste shapes with the lines between them (also into another diagram, with fresh ids), `⌘A` selects everything, `]` / `[` bring to front and send to back. None of them act while a text field has focus.
- **Links.** A linked shape carries a small quiet link glyph; clicking it (or the row in the inspector) goes to the element in Structure or Data, the flow, or the other diagram.
- **Inspector.** For shapes (one or several): shape kind, tone (seven swatches in the renderer's colours for the current theme), fill, outline, text size, as compact segmented controls; for one shape also its text, detail and link (pick, open, unlink). Effective values are shown, and only what the human chooses is written: choosing the kind's default clears the property. For lines: label, line, ends, route, tone, Reverse, and "Unpin sides" when an end is pinned. Selection outlines and handles are cobalt and drawn outside the shape, so they never change how it looks.
- **Promote** is always an explicit act. On an unlinked shape, "Make this an element…" picks a kind (suggested from the silhouette: cylinder store, pill queue, actor actor, group system, otherwise component) and creates a planned element named after the first line of the text, with the detail as summary, linked to the shape in the same change. On a line whose two ends link to elements, "Make this a relation" adds a `uses` relation with the line's label.
- **Seed.** "Add from model…" picks elements to draw; the server places them with the relations among them. In Structure, "Draw as diagram" (palette and node menu) starts a new diagram from the selected elements, named after the scope or the first element.
- **Agent.** When the agent draws or changes a diagram, the toast's "Show" opens it and the shapes it touched carry the saffron ring. Changes arriving under the human's hands keep the zoom and pan, and an open text edit stays open. `focus_ui` with a diagram opens it, selects the shapes and fits them into view.

### 5.8 Inspector

For an element, top to bottom, with sections collapsed when empty and no section headers heavier than a 12 px `--ink-2` label:

1. Kind icon and name (click to rename), status control, technology.
2. Summary (single line, editable in place).
3. Description (rendered markdown, click to edit).
4. **Code**: each ref as path, symbol and line range in mono. Click opens the code drawer at that location. Stale refs show in `--warn` with the reason. "Link code" opens a fuzzy file picker backed by `/api/code/files`.
5. **Data** (non-data elements): structures it touches with the verb. **Fields** (data elements).
6. **Relations**: incoming and outgoing, each a row that selects the other end. "Add" picks any other element, also one on another canvas, and a direction (to or from), creates a `uses` relation and opens it with the label field focused.
7. **Notes**: open notes, a field to add one ("Note for the agent"), resolved notes folded away.
8. A quiet footer row: "Copy prompt" with a menu (Explain, Investigate, Change…) that copies a ready sentence referencing the element by name and id, for pasting into the agent. Delete.

For a relation: kind, label, technology, description, data carried (picker), code, the underlying relations when it is a merged thread.

Edits commit on blur or `Enter` and go out as a `ChangeSet`. Plain property edits (fields, summary, description, technology, code links, a relation's label) carry no summary, so the server describes them and coalesces quick ones into one journal entry (see Store).

### 5.9 Code drawer

Read-only view of the linked file with syntax highlighting (`highlight.js`), the referenced range marked and scrolled into view. Header: path (mono), a list of the elements linked to this same file as chips (code-to-architecture navigation), "Open in editor" (`vscode://file/<hostPath>/<path>:<line>`, shown when a host path is known), copy path. Selecting lines and pressing "Link lines <range> to <element>" (for example "Link lines 8–12 to Checkout") adds a code ref with that range to the selected element.

### 5.10 Search and commands

`⌘K` opens a centered palette: elements, data structures, flows, diagrams, and files that have links, each with kind icon and scope path. `Enter` navigates to it in the right perspective and scope and selects it. Commands also live here: export, tidy, toggle theme, undo, new diagram, and "Draw as diagram" while elements are selected in Structure.

### 5.11 Agent presence and activity

The presence button shows a dot: hollow when no agent has connected, saffron when one is present. Clicking it opens the activity popover: code links that need attention, then open notes across the model (author color, the full text, the owning element; clicking one goes to the element; no section when there are none), then journal entries newest first, each with author color, summary and relative time; clicking an entry selects what it touched. When no agent has ever connected the popover shows how to connect: the MCP URL and the one-line config, with a copy button.

When the agent applies a change while the human is looking, a small toast at the bottom center names the summary; clicking it navigates to the change. A `focus` event navigates immediately and shows the message in the same toast.

The browser reports `UiState` to the server whenever perspective, scope, flow, open diagram or selection (elements, relations, or shapes and lines of the open diagram) changes (debounced 150 ms), and at once whenever the event stream connects or reconnects, so a restarted server knows the view without waiting for a click.

### 5.12 Empty state

An empty model shows a single centered invitation on the canvas: a short sentence that the architecture can be drawn here or built by the agent, the MCP connection snippet with a copy button, and a suggested first prompt ("Analyze this repository and model its architecture in ArchWeave"). It disappears with the first element.

### 5.13 Export

A small dialog: what (current scope or everything), which perspectives, format (Markdown document, Mermaid, JSON, PNG, SVG of the current canvas), include code links. One primary button, "Export".

In the Diagrams perspective, PNG and SVG are the open diagram, rendered by the image route (`GET /api/diagrams/:id/image`) rather than captured from the screen: theme (light by default, since exports mostly go into documents, or dark), background (canvas, white, transparent), PNG scale (1× to 4×, default 2×), and a live preview from the same route. "Export" downloads the file; "Copy image" puts the PNG on the clipboard where the browser allows it.

### 5.14 Help

`?` opens a sheet with the shortcut list (including the Diagrams keys), three short paragraphs on working with an agent and one on diagrams: drawings beside the model, shapes that link to model items, promote and seed, and that the agent draws and reads them too. Nowhere else does the interface explain itself.

## 6. Running

- `npm run dev` for development, `npm run build && npm start` for a local production run inside any repository (`ARCHWEAVE_REPO_DIR=/path/to/repo`).
- Docker: a small multi-stage image. `docker-compose.yml` in this repository is the snippet users copy next to their code: it mounts the repository at `/repo`, stores data in `/repo/.archweave`, publishes `127.0.0.1:4317`.
- Agent connection: `{"mcpServers": {"archweave": {"type": "http", "url": "http://localhost:4317/mcp"}}}`.

## 7. Source layout and ownership

```
src/shared/      model.ts (contract), projection.ts (scope projection, lifting, focus sets; pure, tested)
src/server/      main.ts, store, persistence, repo access, stale links, export, REST routes, MCP tools, guide
src/web/         React app
tests/           vitest: store, projection, export, REST and MCP end to end
```

Keep modules small and plainly named. No comments that restate code. No AI attribution anywhere.
