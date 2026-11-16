/** The modeling guide: `get_guide` with topic "modeling" (the default). */
export const GUIDE = `# Working with ArchWeave

ArchWeave holds the architecture of the repository you are working in. A developer sees and edits the same model in a browser while you work on it through these tools. Keep the model truthful to the code and readable by a person: it is a map the human uses to think and to direct you, not a dump of the code.

This is the modeling guide. Diagrams, the drawings beside the model, have their own: \`get_guide\` with topic "diagrams".

## When to call what

- The human says "this", "here", "the selected", or refers to something they are looking at: call \`get_context\` first. It returns the selection fully expanded, the scope they are in, open notes and what they changed since you last looked.
- Getting oriented: \`get_model\` (outline, two levels by default), then \`get_element\` for detail and \`search\` to find things by name, field or file.
- After changing code: \`find_by_code\` with the paths you touched. It shows what is linked there and the \`check\` of every ref (ok, moved, changed, …). Then \`check_code_links\` with \`repair: true\` re-anchors the moved ones in one step; look at the changed ones yourself (see "Keep code links working"), and update the model with \`apply_changes\`.
- Before finishing a task that touched code: \`check_code_links\` (with \`repair: true\`) so no link is left stale.
- To point at something while you explain it: \`focus_ui\`.

## Model in levels

- Top level (no parentId): the system's apps, services, stores, queues, external systems, actors and agents. At most about a dozen nodes. Use a \`system\` element only if the repository holds several products. When optional integrations or externals would push the top level to more than about a dozen, group them under one element (an \`external\` "Integrations" with the providers inside).
- Inside each: its components. Inside those, modules only where it helps a reader. Prefer 5 to 9 children per element; group with an intermediate component rather than listing 20 siblings.
- Containment is \`parentId\`. Relations can connect elements at any depth; the diagram lifts them to the visible level, so connect the elements that really talk to each other (component to component), not their containers.
- Kinds: actor (person or role), external (third-party system), app (deployable: web app, CLI, worker), service (backend API), component (cohesive part inside an app or service), module (code-level unit), store (database, cache, bucket), queue (topic, stream, bus), agent (LLM-driven actor), data (a data structure), system (whole product).

## Write for a person

- Names are what a developer would say out loud: "Order service", "Checkout", "Payment gateway". Not class names unless the class is the concept.
- \`summary\` is one plain sentence about responsibility, not implementation: "Turns a cart into a paid order." Use \`description\` (markdown) for detail worth reading: decisions, constraints, gotchas.
- \`technology\` names the stack in a few words: "Postgres 16", "React 19", "Kafka".

## Link the code

- Every built element carries \`codeRefs\` to the files that best show it: the entry point, the main class, the schema, the route table. Three precise refs beat twenty. Add \`symbol\` and \`startLine\`/\`endLine\` when you know them, and a short \`note\` when the reason is not obvious.
- A \`symbol\` must literally occur, as an identifier, within \`startLine\`..\`endLine\` (or on \`startLine\` when there is no \`endLine\`); otherwise the ref is reported stale. For things registered by a string name, such as routes ("/api/orders") or tool names, give the line range without a \`symbol\`.
- Link a large unit (a class, a long function, a component, a route table) by its declaration line: \`symbol\` plus \`startLine\`, no \`endLine\`. Such a link follows the unit when it moves and stays valid while its body is edited. The linked line must be unique in its file; when the declaration line repeats (eleven identical \`server.registerTool(\` lines), link the first line that only this unit has. Give a range only for a short passage whose exact lines are the point; any edit inside a range marks the link \`changed\`.
- Paths are repo-relative with forward slashes ("src/orders/service.ts"). A ref may point at a directory for a module.
- Link a location once, where it explains the most. A relation or flow step needs its own ref only when it shows something its elements' refs do not.
- Status: \`built\` exists in code, \`planned\` is designed but not implemented, \`deprecated\` is on its way out. Elements you create without code refs start as \`planned\`; with code refs they start as \`built\`, and so do actors, externals and systems, which have no code. Set \`status\` explicitly when that default is wrong.

## Keep code links working

- When you write a ref with a line range, the server seals it: it stores a \`digest\` of the linked lines. Do not invent or edit digests; send a ref without one, or leave it exactly as you read it.
- Checks of a sealed ref compare text, not just line numbers: \`moved\` means the same lines now sit elsewhere in the file (\`suggestion\` has the new range); \`changed\` means the linked code itself was edited.
- After editing code: \`find_by_code\` for the touched files, then \`check_code_links\` with \`repair: true\`. It re-anchors every moved ref on elements, relations and flow steps in one journaled change. Do not recompute line numbers by hand.
- Changed refs are never repaired for you. Read the code: if the ref is wrong, send the corrected ref (\`removeCodeRefs\` plus \`addCodeRefs\`; a new range is sealed afresh). If it is still right as it is, re-send it without its digest in \`addCodeRefs\` (for a flow step: \`updateSteps\` with \`addCodeRefs\`); that seals it to the current code, and so seals a ref that has no seal yet.
- To remove one of several refs to the same file, narrow \`removeCodeRefs\` with \`symbol\` and/or \`startLine\`.

## Data structures

- Model data that crosses boundaries or that people discuss: entities, API payloads, events, messages, config. Skip internal helper types.
- A data structure is an element of kind \`data\` with \`fields\` ({name, type, optional?, description?, ref?}), a \`format\` and, for wire formats, an \`example\` payload. \`format\` and field \`type\` are free text: "json", "sql", "protobuf"; "string", "Order[]", "uuid".
- Nested fields use dotted names ("customer.address.city"). Enum values go in the type string ("'draft' | 'paid'").
- Give it a \`parentId\` when one element owns or defines it (the service whose schema it is). Persisted records (tables, documents, rows) are owned by the store that keeps them. Shared contracts can stay top level.
- Link a field to another structure with \`ref\` (an Order's \`items\` field refs \`order-item\`). Link a wire structure to the record it is built from with a \`references\` relation (data to data), or with a field \`ref\` when one field carries it.
- Connect producers and consumers with relations from the element to the data: \`produces\`, \`consumes\`, \`reads\`, \`writes\`. Data that travels over a call goes in that relation's \`dataIds\`.

## Relations and flows

- A relation is directed: \`from\` acts on \`to\`. \`kind\` is one of uses, calls, reads, writes, publishes, subscribes, produces, consumes, references (default uses). \`label\` is the verb phrase a reader sees ("places order"), \`technology\` the protocol ("HTTPS/JSON", "gRPC", "SQL").
- Relations have no name. Their generated id is "<from>-<kind>-<to>" ("checkout-calls-billing", with "-2" appended when taken); supplying your own readable id is fine.
- Add flows only for the handful of scenarios that explain the system: a request end to end, a background job, an agent loop. Each step is \`{from, to, label, description?, dataIds?, codeRefs?}\` in order.

## Changing the model

- Send one \`apply_changes\` per coherent step, with a \`summary\` the human will read in the activity feed ("Model checkout components", "Mark payment retries built").
- Entries are upserts. With an existing \`id\` only the fields you send change; without an id (or with a new one) the entry is created. Choose readable ids yourself (slugs like "order-service") when later entries in the same change set refer to them; otherwise ids are generated from names. Ids never change on rename.
- A change set is all or nothing. Errors name the entry and suggest the id you probably meant; fix and resend.
- Removing an element removes its descendants, its relations and the flow steps that touch it. Prefer marking things \`deprecated\` when the code still exists.
- Lists you send (codeRefs, fields, tags, notes, steps, dataIds) replace the stored list. For small corrections use the helpers: \`addCodeRefs\`/\`removeCodeRefs\` (elements, relations), \`setFields\`/\`removeFields\` and \`addNotes\`/\`resolveNotes\` (elements), \`updateSteps\`/\`insertSteps\`/\`removeSteps\` with 0-based indices (flows). The \`apply_changes\` description has the details.
- \`dataIds\` and field \`ref\`s must name existing data structures, or the change set is rejected. \`dryRun: true\` checks a large change set without applying it.
- Do not send \`layout\`. The browser arranges new elements.

## Working with the human

- Modeling stays human-directed. Reflect the code, answer notes and carry out requests; do not restructure or rename on your own initiative.
- Planned elements and open human notes are design intent. Implement toward them; do not delete or reshape them without being asked. When the code cannot match the plan, add a note (\`addNotes\`) saying why.
- Open notes from the human are requests. When you have handled one, resolve it with \`resolveNotes\` and, if useful, reply with a note of your own.
- After changing code: \`find_by_code\` for the touched paths, \`check_code_links\` with \`repair: true\`, then update the affected elements, set \`status\`, fix changed code refs, resolve notes you handled.
- Use \`focus_ui\` to show the human what you are talking about, with a short \`message\`.
`;

/**
 * The MCP server instructions: a short router to the tools and the guides. Clients keep only the start of
 * this text (Claude Code the first 4096 characters, Codex advises a self-contained first 512), so the
 * essentials come first and the guides stay behind `get_guide`.
 */
export const INSTRUCTIONS = `ArchWeave holds the architecture of the repository you are working in: a model of elements, relations, data structures and flows linked to the code, plus diagrams drawn beside it. A developer sees and edits the same model in a browser. Read \`get_guide\` (topic "modeling") before your first change to the model, and \`get_guide\` with topic "diagrams" before drawing or changing a diagram. What follows is only a summary.

## Which tool when
- The human says "this", "here", "the selected" or refers to what they see: \`get_context\` first. It returns their view, the selection in full, open notes and what they changed since you last looked.
- Getting oriented: \`get_model\` (outline of elements, flows and diagrams), then \`get_element\` for one element, relation, flow or diagram, and \`search\` to find things by name, field, file or diagram text.
- Changing the model or a diagram: \`apply_changes\`, one coherent step per call with a \`summary\` the human reads in the activity feed. \`dryRun: true\` checks without applying.
- After changing code: \`find_by_code\` with the touched paths, then \`check_code_links\` with \`repair: true\`, then update the affected elements.
- Diagrams: read one with \`get_element\` (an outline with lints), draw with \`diagrams\` in \`apply_changes\` (leave positions out; the server arranges), look at it with \`render_diagram\` when your client shows images.
- Pointing at something while you explain it: \`focus_ui\`.
- History: \`get_changes\`. Documentation: \`export\`.

## Always
- Modeling is human-directed: reflect the code, answer notes, carry out requests; do not restructure or rename on your own initiative. Planned elements and open human notes are design intent.
- Keep the model truthful to the code and readable by a person.
- Diagrams are drawings: shapes may link to model items, connectors are never relations, and the model stays the source of truth.
- Do not send \`layout\`. Leave diagram positions out unless the human asked for a place.
- Errors name the entry and suggest the id you probably meant; fix and resend.
`;

/** The diagrams guide: `get_guide` with topic "diagrams". */
export const DIAGRAMS_GUIDE = `# Drawing diagrams in ArchWeave

A diagram is a drawing beside the model: shapes and connectors placed on purpose to explain one idea to a person. It is not the model. Elements, relations and flows stay the source of truth; a diagram may point at them and never adds to them.

- A shape may \`link\` to a model item: \`{"type": "element" | "flow" | "diagram", "id": …}\`. A linked shape without \`text\` shows the item's live name and follows renames; give \`text\` only to say something else.
- Connectors are drawn lines, never relations. Drawing one changes nothing in the model.
- To make a drawn box real ("promote" it), create the element and link the shape in the same change set; clearing \`text\` lets it show the element's name: \`{"elements": [{"id": "mailer", "kind": "component", "name": "Invoice mailer"}], "diagrams": [{"id": "billing-overview", "setShapes": [{"id": "mailer-box", "text": "", "link": {"type": "element", "id": "mailer"}}]}]}\`.
- Removing an element keeps its shapes, unlinked, with the name they showed.

## Workflow
1. When the human refers to what they see ("this diagram", "the selected box"), call \`get_context\`: in the diagrams perspective it returns the open diagram and the selected shapes and connectors.
2. Read a diagram with \`get_element\` and its id: shapes nested in their groups, each with \`label\` (what it shows), \`link\`, the style set on it and \`at: [x, y, w, h]\`; connectors; \`lints\`. \`get_model\` lists every diagram.
3. Write with one \`apply_changes\` per coherent step. Choose a readable diagram id ("checkout-flow") and shape ids ("api", "orders-db"); connectors name shapes by id.
4. Leave out \`x\`, \`y\`, \`w\` and \`h\`. The server sizes every shape to its text and arranges the diagram in its \`direction\`.
5. The reply lists \`diagrams: [{id, lints}]\`. A lint is what a reviewer would notice: shapes that overlap, a line running through or along a shape, lines on top of each other, a label covering a shape, a label or a line, text that does not fit, an empty shape, a doubled connector, too many shapes. Fix them in your next change set.
6. When your client shows images, \`render_diagram\` returns a PNG of the result. Look at it before you call the diagram done.
7. \`focus_ui\` with \`diagramId\` (and \`shapeIds\` to highlight) opens the diagram for the human.

## Writing
\`diagrams\` in \`apply_changes\` holds upserts: with an existing \`id\` only what you send changes; a new id creates the diagram and needs \`name\`. \`direction\` is "down" (default) or "right"; \`summary\` is one sentence.
- \`shapes\` and \`connectors\` are full lists that replace the stored ones. Use them to create a diagram.
- \`setShapes\` / \`setConnectors\` upsert single entries by id: only the given properties change, \`null\` clears one. \`removeShapes\` / \`removeConnectors\` take ids. Removing a shape removes its connectors; what sat in a removed group moves out.
- \`arrange\`: "new" (the default) places only shapes without a position and moves nothing else; "all" arranges every shape afresh.
- \`seed\`: element ids to draw from the model. Each element not on the diagram yet gets a linked shape with the element id as shape id (stores as cylinders, queues as pills, actors as actors, externals and planned elements dashed), an element seeded with its parent sits inside it as a group, and the relations become connectors, lifted as the structure view lifts them: a relation between elements that are not drawn runs between their nearest drawn ancestors, relations lifting to the same pair share one connector (labelled only when they all say the same), and pairs already connected are left alone.
- \`remove: {"diagrams": [id]}\` deletes a diagram.

## Vocabulary
Shape \`kind\`:
- \`box\` (default): a service, component, step, anything.
- \`pill\`: start and end points, queues, small tags.
- \`cylinder\`: a store: database, cache, bucket.
- \`diamond\`: a decision.
- \`actor\`: a person or role.
- \`note\`: an annotation with a folded corner, amber by default.
- \`text\`: free text without outline, for titles and captions.
- \`group\`: a titled frame. Shapes with \`parent: "<group id>"\` sit inside it. Use it for a boundary: a service, a network, a team, a phase.
\`text\` is the label: 1 to 4 words, line breaks kept. \`detail\` is a quieter second block under it ("Postgres 16", "every 5 min").
Style, all optional:
- \`outline\`: solid, dashed (planned, external, optional), dotted (deprecated, temporary), none.
- \`tone\`: neutral, blue, teal, green, amber, red, violet.
- \`fill\`: none (see-through), plain (surface), tint (a soft wash of the tone), solid (the tone itself with light text; for the one thing that matters).
- \`size\`: s, m (default), l.
Connector: \`from\`, \`to\`, \`label\` (the verb: "reads", "publishes order").
- \`line\`: solid (default), dashed (asynchronous, planned, optional), dotted.
- \`ends\`: arrow (default, a head at \`to\`), both, none.
- \`route\`: elbow (default, right angles), straight, curve.
- \`tone\` as for shapes. \`fromSide\` / \`toSide\` (top, right, bottom, left) pin where the line leaves and arrives, to steer it around a shape.

## Composition
- One idea per diagram, 5 to 15 shapes. Bigger: split it, and link a shape to the detail diagram (\`{"type": "diagram"}\`).
- \`direction\` "down" for layers (clients on top, stores at the bottom), "right" for pipelines and sequences.
- Short noun labels on shapes, the verb on the connector.
- Groups for real boundaries, at most two levels deep.
- Dashed outlines for planned or external things, dashed lines for asynchronous or planned connections.
- Colour means something or nothing: one tone per meaning, the same meaning in the same tone everywhere, and a \`note\` saying what the tones mean. Most shapes stay neutral.
- A \`note\` holds what the drawing cannot say: an assumption, an open question.
- Link a shape whenever it stands for a model item, so it follows renames and readers can jump to the model.

## Editing a diagram a human arranged
- Read it first. Never resend the full \`shapes\` list for a small change; use \`setShapes\`, \`removeShapes\`, \`setConnectors\`, \`removeConnectors\`.
- Never move or resize shapes the human placed unless asked. New shapes without a position are placed around them; only a group may grow to hold a new shape.
- \`arrange: "all"\` only when the human asks to tidy the whole diagram.

## Examples
A new diagram:
\`\`\`json
{"summary": "Draw the checkout path", "diagrams": [{"id": "checkout", "name": "Checkout", "summary": "How an order is paid.", "direction": "right",
  "shapes": [
    {"id": "shopper", "kind": "actor", "text": "Shopper"},
    {"id": "backend", "kind": "group", "text": "Order API"},
    {"id": "orders", "parent": "backend", "link": {"type": "element", "id": "orders"}},
    {"id": "billing", "parent": "backend", "link": {"type": "element", "id": "billing"}},
    {"id": "stripe", "text": "Stripe", "outline": "dashed"},
    {"id": "db", "kind": "cylinder", "text": "Orders DB"}],
  "connectors": [
    {"from": "shopper", "to": "orders", "label": "places order"},
    {"from": "orders", "to": "db", "label": "writes"},
    {"from": "orders", "to": "billing", "label": "charges"},
    {"from": "billing", "to": "stripe", "label": "creates payment"}]}]}
\`\`\`
Adding two shapes to a diagram a human arranged:
\`\`\`json
{"summary": "Add fraud scoring to checkout", "diagrams": [{"id": "checkout",
  "setShapes": [{"id": "fraud", "text": "Fraud check", "parent": "backend", "outline": "dashed"}, {"id": "fraud-why", "kind": "note", "text": "Planned for Q3"}],
  "setConnectors": [{"from": "orders", "to": "fraud", "label": "scores", "line": "dashed"}]}]}
\`\`\`
Seeding from elements and adding a note:
\`\`\`json
{"summary": "Draw billing", "diagrams": [{"id": "billing-overview", "name": "Billing", "seed": ["billing", "invoices-db", "stripe"],
  "setShapes": [{"id": "retries", "kind": "note", "text": "Stripe retries webhooks for 3 days."}]}]}
\`\`\`
`;

export const GUIDE_TOPICS = { modeling: GUIDE, diagrams: DIAGRAMS_GUIDE } as const;
