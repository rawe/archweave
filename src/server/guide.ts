/** The modeling guide: sent as MCP server instructions and returned by `get_guide`. */
export const GUIDE = `# Working with ArchWeave

ArchWeave holds the architecture of the repository you are working in. A developer sees and edits the same model in a browser while you work on it through these tools. Keep the model truthful to the code and readable by a person: it is a map the human uses to think and to direct you, not a dump of the code.

These are the server's MCP instructions, the same text as \`get_guide\` returns.

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
- Link a large unit (a class, a long function, a component, a route table) by its declaration line: \`symbol\` plus \`startLine\`, no \`endLine\`. Such a link follows the unit when it moves and stays valid while its body is edited. Give a range only for a short passage whose exact lines are the point; any edit inside a range marks the link \`changed\`.
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
