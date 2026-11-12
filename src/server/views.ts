import type { CodeRef, Element, ElementKind, Flow, Model, Relation } from '../shared/model.ts';
import { ancestorsOf, indexById } from '../shared/projection.ts';

/** The compact form every tool uses when listing elements. */
export interface CompactElement {
  id: string;
  kind: ElementKind;
  name: string;
  summary?: string;
  status: Element['status'];
  parentId?: string;
}

export function compact(element: Element): CompactElement {
  return {
    id: element.id,
    kind: element.kind,
    name: element.name,
    ...(element.summary ? { summary: element.summary } : {}),
    status: element.status,
    ...(element.parentId ? { parentId: element.parentId } : {}),
  };
}

export function compactRelation(relation: Relation): Record<string, unknown> {
  return pruned({
    id: relation.id,
    from: relation.from,
    to: relation.to,
    kind: relation.kind,
    label: relation.label,
    technology: relation.technology,
    dataIds: relation.dataIds,
    status: relation.status === 'built' ? undefined : relation.status,
  });
}

/** Read-only queries over one model snapshot. */
export class ModelView {
  readonly byId: Map<string, Element>;
  readonly relationsById: Map<string, Relation>;
  readonly flowsById: Map<string, Flow>;

  constructor(readonly model: Model) {
    this.byId = indexById(model.elements);
    this.relationsById = indexById(model.relations);
    this.flowsById = indexById(model.flows);
  }

  children(id: string | undefined): Element[] {
    return this.model.elements.filter((e) => (id ? e.parentId === id : !e.parentId || !this.byId.has(e.parentId)));
  }

  ref(id: string): { id: string; name: string; kind: ElementKind } | { id: string; missing: true } {
    const e = this.byId.get(id);
    return e ? { id, name: e.name, kind: e.kind } : { id, missing: true };
  }

  /** One element with everything around it: parents, children, relations, flows and data it touches. */
  expandElement(id: string): Record<string, unknown> | undefined {
    const element = this.byId.get(id);
    if (!element) return undefined;
    const out = this.relationsOf(id, 'from');
    const incoming = this.relationsOf(id, 'to');
    const flows = this.model.flows
      .map((f) => ({ flow: f, steps: f.steps.flatMap((s, i) => (s.from === id || s.to === id || s.dataIds.includes(id) ? [i + 1] : [])) }))
      .filter((x) => x.steps.length)
      .map((x) => ({ id: x.flow.id, name: x.flow.name, steps: x.steps }));
    return pruned({
      ...pruned({ ...element }),
      parentChain: ancestorsOf(id, this.byId).map((a) => ({ id: a.id, name: a.name, kind: a.kind })),
      children: this.children(id).map(compact),
      relationsOut: out,
      relationsIn: incoming,
      flows,
      dataTouched: element.kind === 'data' ? undefined : this.dataTouchedBy(id),
      usedBy: element.kind === 'data' ? this.usersOfData(id) : undefined,
      referencedByFields: element.kind === 'data' ? this.fieldRefsTo(id) : undefined,
    });
  }

  expandRelation(id: string): Record<string, unknown> | undefined {
    const relation = this.relationsById.get(id);
    if (!relation) return undefined;
    return pruned({
      ...pruned({ ...relation }),
      type: 'relation',
      fromElement: this.ref(relation.from),
      toElement: this.ref(relation.to),
      data: relation.dataIds.map((d) => this.ref(d)),
    });
  }

  private relationsOf(id: string, end: 'from' | 'to'): Record<string, unknown>[] {
    const other = end === 'from' ? 'to' : 'from';
    return this.model.relations
      .filter((r) => r[end] === id)
      .map((r) => pruned({ id: r.id, kind: r.kind, label: r.label, [other]: this.ref(r[other]), technology: r.technology, dataIds: r.dataIds, status: r.status === 'built' ? undefined : r.status }));
  }

  /** Data structures an element touches directly (reads, writes, produces, consumes…) or that travel over its relations. */
  dataTouchedBy(id: string): { id: string; name: string; via: string }[] {
    const out = new Map<string, { id: string; name: string; via: Set<string> }>();
    const add = (dataId: string, via: string) => {
      const d = this.byId.get(dataId);
      if (!d || d.kind !== 'data') return;
      const entry = out.get(dataId) ?? { id: dataId, name: d.name, via: new Set<string>() };
      entry.via.add(via);
      out.set(dataId, entry);
    };
    for (const r of this.model.relations) {
      if (r.from === id) add(r.to, r.kind);
      if (r.to === id) add(r.from, `${r.kind} (incoming)`);
      if (r.from === id || r.to === id) for (const d of r.dataIds) add(d, `carried by ${r.id}`);
    }
    for (const e of this.model.elements) if (e.kind === 'data' && e.parentId === id) add(e.id, 'defines');
    return [...out.values()].map((e) => ({ id: e.id, name: e.name, via: [...e.via].join(', ') }));
  }

  usersOfData(dataId: string): { id: string; name: string; kind: string; via: string }[] {
    const out: { id: string; name: string; kind: string; via: string }[] = [];
    for (const r of this.model.relations) {
      const otherId = r.to === dataId ? r.from : r.from === dataId ? r.to : undefined;
      const other = otherId ? this.byId.get(otherId) : undefined;
      if (other && other.kind !== 'data') out.push({ id: other.id, name: other.name, kind: other.kind, via: r.to === dataId ? r.kind : `${r.kind} (incoming)` });
      if (r.dataIds.includes(dataId)) {
        for (const end of [r.from, r.to]) {
          const e = this.byId.get(end);
          if (e) out.push({ id: e.id, name: e.name, kind: e.kind, via: `carried by ${r.id}` });
        }
      }
    }
    return out;
  }

  fieldRefsTo(dataId: string): { id: string; name: string; field: string }[] {
    return this.model.elements.flatMap((e) => e.fields.filter((f) => f.ref === dataId).map((f) => ({ id: e.id, name: e.name, field: f.name })));
  }

  /** Nested outline below a scope, `depth` levels deep. Elements filtered out by kind pass their children up. */
  outline(options: { scopeId?: string; depth: number; kinds?: ElementKind[]; includeData: boolean }): Record<string, unknown> {
    const included = new Set<string>();
    const keep = (e: Element) => (options.includeData || e.kind !== 'data') && (!options.kinds?.length || options.kinds.includes(e.kind));
    const build = (parentId: string | undefined, level: number): Record<string, unknown>[] => {
      const nodes: Record<string, unknown>[] = [];
      for (const child of this.children(parentId)) {
        if (child.id === parentId) continue;
        if (!keep(child)) {
          if (level <= options.depth && (options.includeData || child.kind !== 'data')) nodes.push(...build(child.id, level));
          continue;
        }
        included.add(child.id);
        const grandChildren = this.children(child.id).filter((c) => options.includeData || c.kind !== 'data');
        const node: Record<string, unknown> = { ...compact(child) };
        delete node.parentId;
        if (child.technology) node.technology = child.technology;
        if (grandChildren.length) {
          if (level < options.depth) node.children = build(child.id, level + 1);
          else node.childCount = grandChildren.length;
        }
        nodes.push(node);
      }
      return nodes;
    };
    const tree = build(options.scopeId, 1);
    const relations = this.model.relations.filter((r) => included.has(r.from) && included.has(r.to)).map(compactRelation);
    const scope = options.scopeId ? this.byId.get(options.scopeId) : undefined;
    return pruned({
      model: { name: this.model.name, description: this.model.description || undefined },
      scope: scope ? { ...compact(scope), breadcrumb: [...ancestorsOf(scope.id, this.byId), scope].map((e) => ({ id: e.id, name: e.name })) } : undefined,
      elements: tree,
      relations,
      flows: this.model.flows.map((f) => ({ id: f.id, name: f.name, steps: f.steps.length })),
      counts: {
        elements: this.model.elements.filter((e) => e.kind !== 'data').length,
        data: this.model.elements.filter((e) => e.kind === 'data').length,
        relations: this.model.relations.length,
        flows: this.model.flows.length,
      },
    });
  }

  search(query: string, options: { kinds?: ElementKind[]; limit: number }): Record<string, unknown>[] {
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    if (!terms.length) return [];
    const hits: { element: Element; score: number; matched: Set<string> }[] = [];
    for (const element of this.model.elements) {
      if (options.kinds?.length && !options.kinds.includes(element.kind)) continue;
      const haystacks: [string, string, number][] = [
        ['name', element.name, 10],
        ['id', element.id, 6],
        ['tags', element.tags.join(' '), 4],
        ['summary', element.summary, 3],
        ['fields', element.fields.map((f) => `${f.name} ${f.type}`).join(' '), 3],
        ['code', element.codeRefs.map((r) => `${r.path} ${r.symbol ?? ''}`).join(' '), 2],
        ['technology', element.technology ?? '', 2],
        ['description', element.description, 1],
      ];
      let score = 0;
      const matched = new Set<string>();
      let all = true;
      for (const term of terms) {
        let best = 0;
        for (const [field, text, weight] of haystacks) {
          if (text.toLowerCase().includes(term)) {
            matched.add(field);
            best = Math.max(best, weight);
          }
        }
        if (!best) all = false;
        score += best;
      }
      if (all) hits.push({ element, score: score + (element.name.toLowerCase() === query.toLowerCase() ? 20 : 0), matched });
    }
    return hits
      .sort((a, b) => b.score - a.score || a.element.name.localeCompare(b.element.name))
      .slice(0, options.limit)
      .map((h) => ({ ...compact(h.element), matchedIn: [...h.matched] }));
  }

  /** Elements, relations and flow steps whose code refs touch any of these repo-relative files or directories. */
  findByCode(paths: string[]): Record<string, unknown> {
    const touches = (ref: CodeRef) => paths.filter((p) => !p || ref.path === p || ref.path.startsWith(`${p}/`) || p.startsWith(`${ref.path.replace(/\/+$/, '')}/`));
    const matchedPaths = new Set<string>();
    const pick = (refs: CodeRef[]) => {
      const hit = refs.filter((r) => {
        const ps = touches(r);
        ps.forEach((p) => matchedPaths.add(p));
        return ps.length > 0;
      });
      return hit.length ? hit : undefined;
    };
    const elements = this.model.elements.flatMap((e) => {
      const refs = pick(e.codeRefs);
      return refs ? [{ ...compact(e), codeRefs: refs }] : [];
    });
    const relations = this.model.relations.flatMap((r) => {
      const refs = pick(r.codeRefs);
      return refs ? [{ ...compactRelation(r), codeRefs: refs }] : [];
    });
    const flowSteps = this.model.flows.flatMap((f) =>
      f.steps.flatMap((s, i) => {
        const refs = pick(s.codeRefs);
        return refs ? [{ flowId: f.id, flowName: f.name, step: i + 1, from: s.from, to: s.to, label: s.label, codeRefs: refs }] : [];
      }),
    );
    return { elements, relations, flowSteps, unmatchedPaths: paths.filter((p) => !matchedPaths.has(p)) };
  }
}

/** Drops undefined values, empty strings and empty arrays so tool output stays small. */
export function pruned<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, v]) => v !== undefined && v !== '' && !(Array.isArray(v) && v.length === 0)),
  ) as T;
}
