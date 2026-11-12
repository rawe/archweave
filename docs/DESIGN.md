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
- **CodeRef**: repo-relative `path`, optional `symbol`, optional line range, optional `note`.
- **Note**: text pinned to an element by the human or the agent, resolvable. Human notes are the lightweight way to hand work to the agent.

Ids are readable slugs generated from names and never change on rename.

### Persistence

Everything lives in the data directory (`ARCHWEAVE_DATA_DIR`, default `<repo>/.archweave`):

```
.archweave/
  model.json      elements, relations, flows. Stable ordering (sorted by id), 2-space JSON, trailing newline.
  layout.json     diagram positions per canvas. Same formatting rules.
  .gitignore      contains "state/"
  state/          not tracked
    journal.jsonl activity journal, capped at 500 entries
```

Arrays are written sorted by id and default-valued fields are omitted, so Git diffs are small and meaningful. Writes are atomic (temp file plus rename) and debounced (about 150 ms). The server watches both files; when they change on disk for a reason other than its own write (git checkout, manual edit), it reloads, bumps the revision and broadcasts.

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
- Elements created by the human default to `status: planned` unless given; elements created by the agent default to `built` when they carry at least one code ref, otherwise `planned`.
- A change set that only contains `layout` does not create a journal entry or an undo step and does not bump the model revision visibly to the agent (it still broadcasts to browsers).
- Undo: the store keeps the last 50 model snapshots. `undo()` restores the previous one and journals it.

### REST API

All JSON. Errors are `{ "error": string, "details"?: unknown }` with a 4xx or 5xx status.

| Method and path | Purpose |
| --- | --- |
| `GET /api/snapshot` | `Snapshot` |
| `POST /api/changes` | Body `ChangeSet`. Applied as actor `human`. Returns `ChangeResult`. |
| `POST /api/undo` | Undo the last model change. Returns `{ revision }` or 409 when nothing to undo. |
| `GET /api/journal?since=<revision>` | `JournalEntry[]`, newest last. |
| `GET /api/session` | `{ ui: UiState, agent: AgentPresence, repo: { name, hostPath? } }` |
| `PUT /api/session/ui` | Body `UiState`. The browser reports what the human sees and has selected. |
| `GET /api/events` | Server-sent events, see below. |
| `GET /api/code/file?path=` | `{ path, exists, content?, lineCount?, language?, truncated? }`. Text files up to 1 MB. |
| `GET /api/code/files?q=&limit=` | Repo file paths matching a fuzzy query, for the code link picker. Uses `git ls-files` when the repo is a Git checkout, otherwise a walk that skips `node_modules`, `.git`, `dist`, `build` and dot-directories. |
| `GET /api/code/stale` | `StaleLink[]` |
| `GET /api/export?format=markdown\|json\|mermaid&scope=<id>&perspectives=structure,data,flows&code=true\|false` | Download. |

Server-sent events (`event:` name, JSON `data:`):
- `snapshot`: `{ snapshot: Snapshot, entry?: JournalEntry }` after every applied change, undo or disk reload. Also sent once on connect.
- `agent`: `AgentPresence` when it changes.
- `focus`: `FocusRequest` when the agent asks to show something.
- A comment line every 25 s as keep-alive.

Repository access is read-only and confined to `ARCHWEAVE_REPO_DIR`: resolve the real path and reject anything outside it, reject paths inside `.git`.

### Stale link detection

`missing-file` when the path does not exist, `line-out-of-range` when `endLine` or `startLine` exceeds the file's line count, `symbol-not-found` when `symbol` is given and does not occur as a whole word in the file. Computed on demand with a short cache keyed by file mtime.

### Export

- **markdown**: an architecture document. Title and description; per scope a section with a Mermaid flowchart of that level and a short entry for each element (summary, description, code links, notes that are open); a data section with a field table per structure and "used by"; a flows section with a Mermaid sequence diagram per flow. `scope` limits the document to one subtree.
- **mermaid**: just the diagrams.
- **json**: `{ model, layout }`.

Image export (PNG, SVG) of the current canvas happens in the browser.

## 4. MCP

Streamable HTTP at `/mcp` on the same port, stateless JSON responses are fine. Validate the `Host` header against localhost names and the configured host to block DNS rebinding. Any MCP request marks the agent as present (`lastSeenAt`, `clientName` from `initialize`); presence expires to `connected: false` after 60 s without requests.

The server `instructions` and the `get_guide` tool carry the modeling guide (section 4.2), so an agent that has never seen ArchWeave can use it well.

### 4.1 Tools

Keep the surface small. Tool results are compact JSON text. Every tool that returns elements uses the same compact form unless asked for detail.

| Tool | Input | Returns |
| --- | --- | --- |
| `get_guide` | none | The modeling guide. |
| `get_context` | none | What the human is doing now: `ui` state with the selected elements and relations expanded in full (including code refs, notes, children, relations in and out), the breadcrumb of the current scope, open notes across the model, journal entries by the human since the agent's last `get_context` or `apply_changes`, and stale link count. This is the first call for any request that says "this", "here", "the selected". |
| `get_model` | `scopeId?`, `depth?` (default 2), `kinds?`, `includeData?` | Outline of the model: nested elements as `{id, kind, name, summary, status, children}` plus relations among them, flows by name, counts. |
| `get_element` | `id` | One element in full: fields, code refs, notes, parent chain, children, relations in and out with the other end's name, flows it takes part in, data it touches. Works for relations ids too. |
| `search` | `query`, `kinds?`, `limit?` | Elements whose name, summary, description, tags, field names or code paths match. |
| `find_by_code` | `paths: string[]` | Elements, relations and flow steps whose code refs touch those files or directories. Call this after changing code to find what to update. |
| `apply_changes` | `ChangeSet` (as in `model.ts`) | `ChangeResult`. Applied as actor `agent`. `summary` is required here. |
| `check_code_links` | `scopeId?` | Stale links, plus built elements without any code ref. |
| `get_changes` | `since?` (revision), `actor?` | Journal entries. |
| `focus_ui` | `elementIds`, `perspective?`, `scopeId?`, `flowId?`, `message?` | Asks the browser to show and highlight these elements. Returns whether a browser is connected. |
| `export` | `format`, `scope?` | The export text. |

Errors come back as tool errors with a message the agent can act on ("relation `a-calls-b`: unknown element `b`. Did you mean `billing`?").

### 4.2 Modeling guide (text shipped to agents)

Write this as `src/server/guide.md` or a string constant. Content, in this spirit:

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
- Do not set layout. The browser arranges new elements.
- Use `focus_ui` to show the human what you are talking about.

## 5. Web UI

React, Vite, `@xyflow/react` for the canvas, `elkjs` for automatic layout, `zustand` for state. The built UI is served by the server from `dist/web`. In development Vite proxies `/api` and `/mcp` to the server.

### 5.1 Principles

- **The canvas is the page.** Chrome floats over it in small pieces and gets out of the way. No sidebars that are always open, no headers above panels, no captions explaining what a panel is.
- **One accent per author.** The human's selection and edits are cobalt. The agent's activity is saffron. Nothing else in the interface uses those two hues, so a glance tells who did what.
- **Threads carry the meaning.** Relations are drawn as calm, thin threads. Selecting an element brings its threads and neighbors forward and lets the rest recede. This focus behavior is the signature of the product and the main tool for reading a dense diagram.
- **Words are scarce.** Diagram nodes show a name, and at comfortable zoom the full summary. Everything else appears in the inspector on selection. Explanations live behind `?`.
- **Nothing is cut off.** No text on a canvas or in a panel is ever shortened with an ellipsis or clipped: names, summaries, field names, field types, technology, labels, paths and list entries wrap, and their container grows to fit. To reduce density the interface hides a whole kind of content (the "names only" view option hides summaries; neighbor chips never had them), it never shows half of it. A diagram the reader cannot fully read is useless.
- **Keyboard first, pointer complete.** Every action is reachable both ways.

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

Threads: 1.25 px, `--line` at rest, smooth step or bezier routed with rounded corners, small arrowhead. Label shown only when the thread is in focus or the zoom is close. Planned relations are dashed. A relation carrying data shows a small diamond at its midpoint; hovering it lists the structures.

Focus: when something is selected, its threads take `--human`, neighbors keep full contrast, everything else drops to about 35% opacity (transition 160 ms). Clicking the empty canvas restores the whole picture.

Agent activity: elements the agent created or changed get a saffron ring that fades over about 6 seconds, and a saffron dot stays on them until the human selects them once. Removed elements fade out. Respect `prefers-reduced-motion` (no fades, static ring).

### 5.3 Layout

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ ◈ shop › Order service › Checkout      [Structure  Data  Flows]   ⌕  ● ⤓ ◐ ? │
│                                                                ┌───────────┐ │
│                                                                │ Inspector │ │
│                     canvas                                     │ (only on  │ │
│                                                                │ selection)│ │
│                                                                │           │ │
│ − 80% + ⤢                                                      └───────────┘ │
└──────────────────────────────────────────────────────────────────────────────┘
```

- **Top left:** the mark and a breadcrumb of the current scope. Each crumb is clickable. The model name is the root crumb.
- **Top center:** the perspective switch, a three-segment control. Keys `1`, `2`, `3`.
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
- **Arrange:** positions persist per scope. New elements without positions are placed by ELK relative to the existing ones without moving them. "Tidy" in the canvas context menu re-runs layout for the whole scope.
- Multi-select with shift-click and drag-box.

### 5.5 Data perspective

The place to find and discuss data structures. A real codebase has dozens of them, so this perspective never draws them all as one graph. It has two states on one canvas, both laid out deterministically (no stored positions).

**Catalog** (nothing selected). Every `data` element as a compact card: name, format tag, field count. No field rows, no threads. Cards are grouped by owner; each group has a quiet title (the owner's name, which jumps to that element in the Structure perspective) and groups flow into columns that fit the canvas width, so the whole catalog reads top to bottom like a well-set index. Structures without an owner form the first group.

**Focus** (one structure selected). The selected card sits in the center with all its field rows (`name`, mono `type`, optional marker, a link glyph when the field refs another structure).
- Right column: the structures it references, through field `ref`s and `references` relations. Threads run from the referencing field row to the target card.
- Left column: the structures that reference it, with the thread starting at their referencing field row.
- Neighbor cards show their name, the rows involved in the link, and a quiet "n more fields" line; they are one hop only.
- Below the center card: the elements that produce, consume, read or write it, as small quiet nodes grouped by verb. Clicking one jumps to it in the Structure perspective.
- Clicking a neighbor card moves the focus to it with a short transition. Browser Back returns to the previous focus. `Esc` returns to the catalog.

Shared by both states:
- A slim list rail on the left (the only persistent side element, 220 px, collapsible) lists all structures grouped by owner, with a filter field. The filter also narrows the catalog. Selecting an entry focuses that structure. This is what makes any structure reachable in one step.
- Fields are edited in the inspector: add, rename, retype, reorder, link to another structure, mark optional. The example payload is an editable code block.
- From anywhere, `⌘K` then a structure name jumps here in focus. From the Structure perspective, the inspector of an element lists the data it touches; clicking one jumps here with it focused.

### 5.6 Flows perspective

A flow list (same rail position as the data list) and, for the selected flow, a sequence diagram: participants as columns in order of first appearance, steps as numbered arrows top to bottom, data carried shown as a small chip on the arrow. Numbering is appropriate here because steps are a sequence.

- Selecting a step shows its description, data and code links in the inspector.
- `←` / `→` or `J` / `K` steps through; the active step is cobalt, earlier steps stay at full contrast, later ones recede.
- Participants link back to the Structure perspective.
- Steps are added with "Add step" at the end of the diagram (pick from, to, label), reordered by drag, edited in the inspector.

### 5.7 Inspector

For an element, top to bottom, with sections collapsed when empty and no section headers heavier than a 12 px `--ink-2` label:

1. Kind icon and name (click to rename), status control, technology.
2. Summary (single line, editable in place).
3. Description (rendered markdown, click to edit).
4. **Code**: each ref as path, symbol and line range in mono. Click opens the code drawer at that location. Stale refs show in `--warn` with the reason. "Link code" opens a fuzzy file picker backed by `/api/code/files`.
5. **Data** (non-data elements): structures it touches with the verb. **Fields** (data elements).
6. **Relations**: incoming and outgoing, each a row that selects the other end.
7. **Notes**: open notes, a field to add one ("Note for the agent"), resolved notes folded away.
8. A quiet footer row: "Copy prompt" with a menu (Explain, Investigate, Change…) that copies a ready sentence referencing the element by name and id, for pasting into the agent. Delete.

For a relation: kind, label, technology, description, data carried (picker), code, the underlying relations when it is a merged thread.

Edits commit on blur or `Enter` and go out as a `ChangeSet`.

### 5.8 Code drawer

Read-only view of the linked file with syntax highlighting (`highlight.js`), the referenced range marked and scrolled into view. Header: path (mono), a list of the elements linked to this same file as chips (code-to-architecture navigation), "Open in editor" (`vscode://file/<hostPath>/<path>:<line>`, shown when a host path is known), copy path. Selecting lines and pressing "Link selection" adds a code ref with that range to the selected element.

### 5.9 Search and commands

`⌘K` opens a centered palette: elements, data structures, flows, and files that have links, each with kind icon and scope path. `Enter` navigates to it in the right perspective and scope and selects it. Commands also live here: export, tidy, toggle theme, undo.

### 5.10 Agent presence and activity

The presence button shows a dot: hollow when no agent has connected, saffron when one is present. Clicking it opens the activity popover: journal entries newest first, each with author color, summary and relative time; clicking an entry selects what it touched. When no agent has ever connected the popover shows how to connect: the MCP URL and the one-line config, with a copy button.

When the agent applies a change while the human is looking, a small toast at the bottom center names the summary; clicking it navigates to the change. A `focus` event navigates immediately and shows the message in the same toast.

The browser reports `UiState` to the server whenever perspective, scope, flow or selection changes (debounced 150 ms).

### 5.11 Empty state

An empty model shows a single centered invitation on the canvas: a short sentence that the architecture can be drawn here or built by the agent, the MCP connection snippet with a copy button, and a suggested first prompt ("Analyze this repository and model its architecture in ArchWeave"). It disappears with the first element.

### 5.12 Export

A small dialog: what (current scope or everything), which perspectives, format (Markdown document, Mermaid, JSON, PNG, SVG of the current canvas), include code links. One primary button, "Export".

### 5.13 Help

`?` opens a sheet with the shortcut list and three short paragraphs on working with an agent. Nowhere else does the interface explain itself.

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
