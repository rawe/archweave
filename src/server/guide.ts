/** The modeling guide: sent as MCP server instructions and returned by `get_guide`. */
export const GUIDE = `# Working with ArchWeave

ArchWeave holds the architecture of the repository you are working in. A developer sees and edits the same model in a browser while you work on it through these tools. Keep the model truthful to the code and readable by a person: it is a map the human uses to think and to direct you, not a dump of the code.

## When to call what

- The human says "this", "here", "the selected", or refers to something they are looking at: call \`get_context\` first. It returns the selection fully expanded, the scope they are in, open notes and what they changed since you last looked.
- Getting oriented: \`get_model\` (outline, two levels by default), then \`get_element\` for detail and \`search\` to find things by name, field or file.
- After changing code: \`find_by_code\` with the paths you touched, then update what it returns with \`apply_changes\`.
- Before finishing a task that touched code: \`check_code_links\` to repair refs you broke.
- To point at something while you explain it: \`focus_ui\`.

## Model in levels

- Top level (no parentId): the system's apps, services, stores, queues, external systems, actors and agents. At most about a dozen nodes. Use a \`system\` element only if the repository holds several products.
- Inside each: its components. Inside those, modules only where it helps a reader. Prefer 5 to 9 children per element; group with an intermediate component rather than listing 20 siblings.
- Containment is \`parentId\`. Relations can connect elements at any depth; the diagram lifts them to the visible level, so connect the elements that really talk to each other (component to component), not their containers.
- Kinds: actor (person or role), external (third-party system), app (deployable: web app, CLI, worker), service (backend API), component (cohesive part inside an app or service), module (code-level unit), store (database, cache, bucket), queue (topic, stream, bus), agent (LLM-driven actor), data (a data structure), system (whole product).

## Write for a person

- Names are what a developer would say out loud: "Order service", "Checkout", "Payment gateway". Not class names unless the class is the concept.
- \`summary\` is one plain sentence about responsibility, not implementation: "Turns a cart into a paid order." Use \`description\` (markdown) for detail worth reading: decisions, constraints, gotchas.
- \`technology\` names the stack in a few words: "Postgres 16", "React 19", "Kafka".

## Link the code

- Every built element carries \`codeRefs\` to the files that best show it: the entry point, the main class, the schema, the route table. Three precise refs beat twenty. Add \`symbol\` and \`startLine\`/\`endLine\` when you know them, and a short \`note\` when the reason is not obvious.
- Paths are repo-relative with forward slashes ("src/orders/service.ts"). A ref may point at a directory for a module.
- Status: \`built\` exists in code, \`planned\` is designed but not implemented, \`deprecated\` is on its way out. Elements you create without code refs start as \`planned\`; with code refs they start as \`built\`. Set \`status\` explicitly when that default is wrong.

## Data structures

- Model data that crosses boundaries or that people discuss: entities, API payloads, events, messages, config. Skip internal helper types.
- A data structure is an element of kind \`data\` with \`fields\` ({name, type, optional?, description?, ref?}), a \`format\` ("json", "sql", "typescript", "protobuf", "xml") and, for wire formats, an \`example\` payload.
- Give it a \`parentId\` when one element owns or defines it (the service whose schema it is). Shared contracts can stay top level.
- Link a field to another structure with \`ref\` (an Order's \`items\` field refs \`order-item\`).
- Connect producers and consumers with relations from the element to the data: \`produces\`, \`consumes\`, \`reads\`, \`writes\`. Data that travels over a call goes in that relation's \`dataIds\`.

## Relations and flows

- A relation is directed: \`from\` acts on \`to\`. \`kind\` is one of uses, calls, reads, writes, publishes, subscribes, produces, consumes, references. \`label\` is the verb phrase a reader sees ("places order"), \`technology\` the protocol ("HTTPS/JSON", "gRPC", "SQL").
- Add flows only for the handful of scenarios that explain the system: a request end to end, a background job, an agent loop. Each step is \`{from, to, label, description?, dataIds?, codeRefs?}\` in order. Steps replace the whole list when you send \`steps\`.

## Changing the model

- Send one \`apply_changes\` per coherent step, with a \`summary\` the human will read in the activity feed ("Model checkout components", "Mark payment retries built").
- Entries are upserts. With an existing \`id\` only the fields you send change; without an id (or with a new one) the entry is created. Choose readable ids yourself (slugs like "order-service") when later entries in the same change set refer to them; otherwise ids are generated from names. Ids never change on rename.
- A change set is all or nothing. Errors name the entry and suggest the id you probably meant; fix and resend.
- Removing an element removes its descendants, its relations and the flow steps that touch it. Prefer marking things \`deprecated\` when the code still exists.
- Lists you send (codeRefs, fields, tags, notes, steps, dataIds) replace the stored list, so send the full list. Use \`addNotes\` and \`resolveNotes\` for notes.
- Do not send \`layout\`. The browser arranges new elements.

## Working with the human

- Modeling stays human-directed. Reflect the code, answer notes and carry out requests; do not restructure or rename on your own initiative.
- Planned elements and open human notes are design intent. Implement toward them; do not delete or reshape them without being asked. When the code cannot match the plan, add a note (\`addNotes\`) saying why.
- Open notes from the human are requests. When you have handled one, resolve it with \`resolveNotes\` and, if useful, reply with a note of your own.
- After changing code: \`find_by_code\` for the touched paths, update the affected elements, set \`status\`, fix code refs, resolve notes you handled.
- Use \`focus_ui\` to show the human what you are talking about, with a short \`message\`.
`;
