import { type CodeRef, type Element, type Flow, type Layout, type Model, type Perspective, PERSPECTIVES, slugify } from '../shared/model.ts';
import { descendantsOf, indexById, projectStructure } from '../shared/projection.ts';
import { canonicalLayout, canonicalModel, formatJson } from './canonical.ts';

export const EXPORT_FORMATS = ['markdown', 'mermaid', 'json'] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];

export interface ExportOptions {
  format: ExportFormat;
  scopeId?: string;
  perspectives?: Perspective[];
  code?: boolean;
}

export interface ExportFile {
  content: string;
  filename: string;
  contentType: string;
}

export class ExportError extends Error {}

export function exportModel(model: Model, layout: Layout, options: ExportOptions): ExportFile {
  const byId = indexById(model.elements);
  const scope = options.scopeId ? byId.get(options.scopeId) : undefined;
  if (options.scopeId && !scope) throw new ExportError(`unknown scope element \`${options.scopeId}\``);
  const base = slugify(scope?.name ?? model.name);
  if (options.format === 'json') {
    return { content: formatJson({ model: canonicalModel(model), layout: canonicalLayout(layout) }), filename: `${base}.archweave.json`, contentType: 'application/json' };
  }
  const doc = new DocumentWriter(model, scope, {
    perspectives: new Set(options.perspectives?.length ? options.perspectives : PERSPECTIVES),
    code: options.code ?? true,
    diagramsOnly: options.format === 'mermaid',
  });
  const content = doc.write();
  return options.format === 'mermaid'
    ? { content, filename: `${base}-diagrams.md`, contentType: 'text/markdown; charset=utf-8' }
    : { content, filename: `${base}.md`, contentType: 'text/markdown; charset=utf-8' };
}

interface WriterOptions {
  perspectives: Set<Perspective>;
  code: boolean;
  diagramsOnly: boolean;
}

class DocumentWriter {
  private out: string[] = [];
  private byId: Map<string, Element>;
  private inRange: Set<string>;

  constructor(
    private model: Model,
    private scope: Element | undefined,
    private options: WriterOptions,
  ) {
    this.byId = indexById(model.elements);
    this.inRange = new Set(scope ? [scope.id, ...descendantsOf(scope.id, model.elements).map((e) => e.id)] : model.elements.map((e) => e.id));
  }

  write(): string {
    const { scope, model, options } = this;
    this.line(`# ${scope ? scope.name : model.name}`);
    if (!options.diagramsOnly) {
      if (scope) this.line(`Part of ${model.name}.`);
      const description = scope ? [scope.summary, scope.description] : [model.description];
      for (const text of description) if (text.trim()) this.line(text.trim());
    }
    if (options.perspectives.has('structure')) this.structure();
    if (options.perspectives.has('data')) this.data();
    if (options.perspectives.has('flows')) this.flows();
    return `${this.out.join('\n\n').replace(/\n{3,}/g, '\n\n').trim()}\n`;
  }

  private line(text: string): void {
    this.out.push(text);
  }

  private structure(): void {
    const scopes = this.structureScopes();
    if (!scopes.length) return;
    this.line('## Structure');
    for (const scopeId of scopes) {
      const projection = projectStructure(this.model, scopeId);
      if (!projection.nodes.length) continue;
      const title = scopeId ? projection.breadcrumb.map((e) => e.name).join(' › ') : 'Overview';
      this.line(`### ${title}`);
      if (!this.options.diagramsOnly && scopeId) {
        const element = this.byId.get(scopeId)!;
        if (element.summary) this.line(element.summary);
      }
      this.line(fence(flowchart(projection)));
      if (this.options.diagramsOnly) continue;
      for (const node of projection.nodes) if (node.role === 'inside') this.elementEntry(node.element);
    }
  }

  /** Scopes that get a section: the starting scope, then every element with non-data children, depth first. */
  private structureScopes(): (string | undefined)[] {
    const children = (id: string | undefined) =>
      this.model.elements.filter((e) => e.kind !== 'data' && (id ? e.parentId === id : !e.parentId || !this.byId.has(e.parentId)));
    const out: (string | undefined)[] = [];
    const visit = (id: string | undefined, seen: Set<string>) => {
      const kids = children(id);
      if (!kids.length) return;
      out.push(id);
      for (const kid of kids) {
        if (seen.has(kid.id)) continue;
        seen.add(kid.id);
        visit(kid.id, seen);
      }
    };
    visit(this.scope?.id, new Set(this.scope ? [this.scope.id] : []));
    return out;
  }

  private elementEntry(element: Element): void {
    this.line(`#### ${element.name}`);
    const facts = [`\`${element.kind}\``, element.status !== 'built' ? element.status : undefined, element.technology].filter(Boolean);
    this.line(facts.join(' · '));
    if (element.summary) this.line(element.summary);
    if (element.description.trim()) this.line(element.description.trim());
    this.codeList(element.codeRefs);
    const open = element.notes.filter((n) => !n.resolved);
    if (open.length) this.line(`Open notes:\n${open.map((n) => `- ${oneLine(n.text)} _(${n.author})_`).join('\n')}`);
  }

  private codeList(refs: CodeRef[], label = 'Code'): void {
    if (!this.options.code || !refs.length) return;
    this.line(`${label}:\n${refs.map((r) => `- ${formatRef(r)}`).join('\n')}`);
  }

  private dataElements(): Element[] {
    const data = this.model.elements.filter((e) => e.kind === 'data');
    if (!this.scope) return data;
    const touched = new Set<string>();
    for (const r of this.model.relations) {
      if (this.inRange.has(r.from) || this.inRange.has(r.to)) {
        touched.add(r.from);
        touched.add(r.to);
        for (const d of r.dataIds) touched.add(d);
      }
    }
    return data.filter((d) => this.inRange.has(d.id) || touched.has(d.id));
  }

  private data(): void {
    const data = this.dataElements();
    if (!data.length) return;
    this.line('## Data');
    this.line(fence(classDiagram(data, this.model)));
    if (this.options.diagramsOnly) return;
    for (const d of data) {
      this.line(`### ${d.name}`);
      const owner = d.parentId ? this.byId.get(d.parentId) : undefined;
      const facts = [d.format ? `\`${d.format}\`` : undefined, d.status !== 'built' ? d.status : undefined, owner ? `defined in ${owner.name}` : undefined].filter(Boolean);
      if (facts.length) this.line(facts.join(' · '));
      if (d.summary) this.line(d.summary);
      if (d.description.trim()) this.line(d.description.trim());
      if (d.fields.length) {
        const rows = d.fields.map((f) => {
          const ref = f.ref ? this.byId.get(f.ref) : undefined;
          const type = `\`${cell(f.type || '—')}\`${ref ? ` → ${cell(ref.name)}` : ''}`;
          return `| ${cell(f.name)}${f.optional ? ' (optional)' : ''} | ${type} | ${cell(f.description ?? '')} |`;
        });
        this.line(['| Field | Type | Description |', '| --- | --- | --- |', ...rows].join('\n'));
      }
      const users = this.usersOf(d.id);
      if (users.length) this.line(`Used by: ${users.join(', ')}.`);
      if (d.example?.trim()) this.line(`Example:\n\n${codeFence(d.example.trim(), d.format ?? '')}`);
      this.codeList(d.codeRefs);
    }
  }

  private usersOf(dataId: string): string[] {
    const out: string[] = [];
    for (const r of this.model.relations) {
      const from = this.byId.get(r.from);
      const to = this.byId.get(r.to);
      if (!from || !to) continue;
      if (r.to === dataId && from.kind !== 'data') out.push(`${from.name} (${r.kind})`);
      else if (r.from === dataId && to.kind !== 'data') out.push(`${to.name} (${r.kind} by)`);
      else if (r.dataIds.includes(dataId)) out.push(`${from.name} → ${to.name}${r.label ? ` (${r.label})` : ''}`);
    }
    for (const e of this.model.elements) {
      for (const f of e.fields) if (f.ref === dataId) out.push(`${e.name}.${f.name}`);
    }
    return [...new Set(out)];
  }

  private flows(): void {
    const flows = this.model.flows.filter((f) => !this.scope || f.steps.some((s) => this.inRange.has(s.from) || this.inRange.has(s.to)));
    if (!flows.length) return;
    this.line('## Flows');
    for (const flow of flows) {
      this.line(`### ${flow.name}`);
      if (!this.options.diagramsOnly && flow.summary) this.line(flow.summary);
      if (flow.steps.length) this.line(fence(sequenceDiagram(flow, this.byId)));
      if (this.options.diagramsOnly) continue;
      const steps = flow.steps.map((s, i) => {
        const data = s.dataIds.map((d) => this.byId.get(d)?.name ?? d);
        const parts = [`${i + 1}. **${this.nameOf(s.from)} → ${this.nameOf(s.to)}**: ${oneLine(s.label)}`];
        if (s.description) parts.push(` — ${oneLine(s.description)}`);
        if (data.length) parts.push(` (data: ${data.join(', ')})`);
        if (this.options.code && s.codeRefs.length) parts.push(` (code: ${s.codeRefs.map(formatRef).join('; ')})`);
        return parts.join('');
      });
      if (steps.length) this.line(steps.join('\n'));
    }
  }

  private nameOf(id: string): string {
    return this.byId.get(id)?.name ?? id;
  }
}

function flowchart(projection: ReturnType<typeof projectStructure>): string {
  const ids = new Map(projection.nodes.map((n, i) => [n.element.id, `n${i}`]));
  const lines = ['flowchart LR'];
  for (const node of projection.nodes) lines.push(`  ${ids.get(node.element.id)}${shape(node.element)}`);
  for (const edge of projection.edges) {
    const from = ids.get(edge.from);
    const to = ids.get(edge.to);
    if (!from || !to) continue;
    const label = edge.relations.length === 1 ? edge.relations[0]!.label || edge.relations[0]!.kind : `${edge.relations.length} relations`;
    const arrow = edge.relations.every((r) => r.status === 'planned') ? '-.->' : '-->';
    lines.push(`  ${from} ${arrow}|${edgeText(label)}| ${to}`);
  }
  const neighbors = projection.nodes.filter((n) => n.role === 'neighbor').map((n) => ids.get(n.element.id));
  const planned = projection.nodes.filter((n) => n.element.status === 'planned').map((n) => ids.get(n.element.id));
  const deprecated = projection.nodes.filter((n) => n.element.status === 'deprecated').map((n) => ids.get(n.element.id));
  if (neighbors.length) lines.push('  classDef neighbor opacity:0.6', `  class ${neighbors.join(',')} neighbor`);
  if (planned.length) lines.push('  classDef planned stroke-dasharray:5 4', `  class ${planned.join(',')} planned`);
  if (deprecated.length) lines.push('  classDef deprecated opacity:0.5', `  class ${deprecated.join(',')} deprecated`);
  return lines.join('\n');
}

function shape(element: Element): string {
  const text = `"${label(element.name)}"`;
  switch (element.kind) {
    case 'store':
      return `[(${text})]`;
    case 'queue':
      return `([${text}])`;
    case 'actor':
      return `((${text}))`;
    case 'external':
      return `{{${text}}}`;
    case 'agent':
      return `[[${text}]]`;
    default:
      return `[${text}]`;
  }
}

function classDiagram(data: Element[], model: Model): string {
  const ids = new Map(data.map((d, i) => [d.id, `d${i}`]));
  const lines = ['classDiagram'];
  for (const d of data) {
    const members = d.fields.map((f) => `    ${member(f.type || 'any')} ${member(f.name)}${f.optional ? '?' : ''}`);
    lines.push(`  class ${ids.get(d.id)}["${label(d.name)}"]${members.length ? ` {\n${members.join('\n')}\n  }` : ''}`);
  }
  for (const d of data) {
    for (const f of d.fields) {
      if (f.ref && ids.has(f.ref)) lines.push(`  ${ids.get(d.id)} --> ${ids.get(f.ref)} : ${member(f.name)}`);
    }
  }
  for (const r of model.relations) {
    if (r.kind === 'references' && ids.has(r.from) && ids.has(r.to)) {
      lines.push(`  ${ids.get(r.from)} ..> ${ids.get(r.to)}${r.label ? ` : ${member(r.label)}` : ''}`);
    }
  }
  return lines.join('\n');
}

function sequenceDiagram(flow: Flow, byId: Map<string, Element>): string {
  const ids = new Map<string, string>();
  const lines = ['sequenceDiagram'];
  for (const step of flow.steps) {
    for (const id of [step.from, step.to]) {
      if (ids.has(id)) continue;
      ids.set(id, `p${ids.size}`);
      const element = byId.get(id);
      lines.push(`  ${element?.kind === 'actor' ? 'actor' : 'participant'} ${ids.get(id)} as ${messageText(element?.name ?? id)}`);
    }
  }
  for (const step of flow.steps) {
    const data = step.dataIds.map((d) => byId.get(d)?.name ?? d);
    lines.push(`  ${ids.get(step.from)}->>${ids.get(step.to)}: ${messageText(step.label + (data.length ? ` [${data.join(', ')}]` : ''))}`);
  }
  return lines.join('\n');
}

function formatRef(ref: CodeRef): string {
  const parts = [`\`${ref.path}\``];
  if (ref.symbol) parts.push(`\`${ref.symbol}\``);
  if (ref.startLine) parts.push(ref.endLine && ref.endLine !== ref.startLine ? `lines ${ref.startLine}–${ref.endLine}` : `line ${ref.startLine}`);
  return parts.join(' · ') + (ref.note ? ` — ${oneLine(ref.note)}` : '');
}

function fence(diagram: string): string {
  return codeFence(diagram, 'mermaid');
}

function codeFence(content: string, language: string): string {
  const ticks = content.includes('```') ? '````' : '```';
  return `${ticks}${language}\n${content}\n${ticks}`;
}

function oneLine(text: string): string {
  return text.replace(/\s*\n\s*/g, ' ').trim();
}

function label(text: string): string {
  return oneLine(text).replace(/"/g, '#quot;').replace(/</g, '#lt;').replace(/>/g, '#gt;');
}

function edgeText(text: string): string {
  return label(text).replace(/\|/g, '/');
}

function messageText(text: string): string {
  return oneLine(text).replace(/;/g, '#59;').replace(/#(?!\d+;|quot;|lt;|gt;)/g, '#35;');
}

function member(text: string): string {
  return oneLine(text).replace(/[{}"]/g, '').replace(/</g, '~').replace(/>/g, '~');
}

function cell(text: string): string {
  return oneLine(text).replace(/\|/g, '\\|');
}
