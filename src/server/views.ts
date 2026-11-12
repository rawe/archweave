import { type CodeRef, type Element, type ElementKind, type Flow, type Model, normalizeCodePath, type Relation } from '../shared/model.ts';
import { ancestorsOf, indexById } from '../shared/projection.ts';

/** How many underlying relation ids a merged thread lists. */
export const THREAD_ID_CAP = 10;

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

  /** Non-data elements that touch a data structure, once each, with every way they use it. */
  usersOfData(dataId: string): { id: string; name: string; kind: string; via: string[] }[] {
    const out = new Map<string, { id: string; name: string; kind: string; via: string[] }>();
    const add = (id: string, via: string) => {
      const e = this.byId.get(id);
      if (!e) return;
      const entry = out.get(id) ?? { id: e.id, name: e.name, kind: e.kind, via: [] };
      if (!entry.via.includes(via)) entry.via.push(via);
      out.set(id, entry);
    };
    for (const r of this.model.relations) {
      const otherId = r.to === dataId ? r.from : r.from === dataId ? r.to : undefined;
      if (otherId && this.byId.get(otherId)?.kind !== 'data') add(otherId, r.to === dataId ? r.kind : `${r.kind} (incoming)`);
      if (r.dataIds.includes(dataId)) for (const end of [r.from, r.to]) add(end, `carried by ${r.id}`);
    }
    return [...out.values()];
  }

  fieldRefsTo(dataId: string): { id: string; name: string; field: string }[] {
    return this.model.elements.flatMap((e) => e.fields.filter((f) => f.ref === dataId).map((f) => ({ id: e.id, name: e.name, field: f.name })));
  }

  /**
   * Nested outline below a scope, `depth` levels deep. Elements filtered out by kind pass their children up.
   * Relations are lifted to the listed elements (and, for a scope, to the outside neighbors they connect to),
   * the way the diagram draws them.
   */
  outline(options: { scopeId?: string; depth: number; kinds?: ElementKind[]; includeData: boolean }): Record<string, unknown> {
    const included = new Set<string>();
    const shown = (e: Element) => options.includeData || e.kind !== 'data';
    const keep = (e: Element) => shown(e) && (!options.kinds?.length || options.kinds.includes(e.kind));
    const build = (parentId: string | undefined, level: number): Record<string, unknown>[] => {
      const nodes: Record<string, unknown>[] = [];
      for (const child of this.children(parentId)) {
        if (child.id === parentId || !shown(child)) continue;
        if (!keep(child)) {
          if (level <= options.depth) nodes.push(...build(child.id, level));
          continue;
        }
        included.add(child.id);
        const node: Record<string, unknown> = { ...compact(child) };
        delete node.parentId;
        if (child.technology) node.technology = child.technology;
        const kids = this.children(child.id);
        const childCount = kids.filter((k) => k.kind !== 'data').length;
        const dataCount = kids.length - childCount;
        if (childCount) node.childCount = childCount;
        if (dataCount) node.dataCount = dataCount;
        if (level < options.depth) {
          const nested = build(child.id, level + 1);
          if (nested.length) node.children = nested;
        }
        nodes.push(node);
      }
      return nodes;
    };
    const tree = build(options.scopeId, 1);
    const scope = options.scopeId ? this.byId.get(options.scopeId) : undefined;
    const { threads, neighbors } = this.liftRelations(included, scope, options.includeData);
    const byKind: Record<string, number> = {};
    for (const e of this.model.elements) byKind[e.kind] = (byKind[e.kind] ?? 0) + 1;
    return pruned({
      model: { name: this.model.name, description: this.model.description || undefined },
      scope: scope ? { ...compact(scope), breadcrumb: [...ancestorsOf(scope.id, this.byId), scope].map((e) => ({ id: e.id, name: e.name })) } : undefined,
      elements: tree,
      neighbors: neighbors.map((id) => this.ref(id)),
      relations: threads,
      flows: this.model.flows.map((f) => ({ id: f.id, name: f.name, steps: f.steps.length })),
      counts: { elements: this.model.elements.length, byKind, relations: this.model.relations.length, flows: this.model.flows.length },
    });
  }

  /**
   * Maps every relation onto the listed elements: each end goes to its nearest listed ancestor-or-self,
   * or, outside a scope, to the highest ancestor that is not the scope or above it. A single relation
   * between two listed elements stays as itself; everything else becomes a merged thread.
   */
  private liftRelations(included: Set<string>, scope: Element | undefined, includeData: boolean): { threads: Record<string, unknown>[]; neighbors: string[] } {
    const hidden = new Set(scope ? [...ancestorsOf(scope.id, this.byId), scope].map((e) => e.id) : []);
    const visibleFor = (id: string): { id: string; neighbor: boolean } | undefined => {
      const element = this.byId.get(id);
      if (!element) return undefined;
      if (element.kind === 'data') return includeData && included.has(id) ? { id, neighbor: false } : undefined;
      const chain = [...ancestorsOf(id, this.byId), element];
      if (!scope || chain.some((e) => e.id === scope.id)) {
        const nearest = chain.findLast((e) => included.has(e.id));
        return nearest ? { id: nearest.id, neighbor: false } : undefined;
      }
      const outside = chain.find((e) => !hidden.has(e.id));
      return outside ? { id: outside.id, neighbor: true } : undefined;
    };
    const threads = new Map<string, { from: string; to: string; relations: Relation[] }>();
    const neighbors = new Set<string>();
    for (const relation of this.model.relations) {
      const from = visibleFor(relation.from);
      const to = visibleFor(relation.to);
      if (!from || !to || from.id === to.id || (from.neighbor && to.neighbor)) continue;
      if (from.neighbor) neighbors.add(from.id);
      if (to.neighbor) neighbors.add(to.id);
      const key = `${from.id}->${to.id}`;
      const thread = threads.get(key) ?? { from: from.id, to: to.id, relations: [] };
      thread.relations.push(relation);
      threads.set(key, thread);
    }
    return {
      neighbors: [...neighbors],
      threads: [...threads.values()].map((t) => {
        const only = t.relations.length === 1 ? t.relations[0]! : undefined;
        if (only && only.from === t.from && only.to === t.to) return compactRelation(only);
        return {
          from: t.from,
          to: t.to,
          count: t.relations.length,
          relationIds: t.relations.slice(0, THREAD_ID_CAP).map((r) => r.id),
          kinds: [...new Set(t.relations.map((r) => r.kind))],
        };
      }),
    };
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

  /** Elements, relations and flow steps whose code refs touch any of these normalized repo-relative files or directories. */
  findByCode(paths: string[]): FoundByCode {
    const touches = (ref: CodeRef) => {
      const stored = normalizeCodePath(ref.path);
      if (stored === '.') return paths;
      return paths.filter((p) => !p || stored === p || stored.startsWith(`${p}/`) || p.startsWith(`${stored}/`));
    };
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

export interface FoundByCode {
  elements: (CompactElement & { codeRefs: CodeRef[] })[];
  relations: (Record<string, unknown> & { codeRefs: CodeRef[] })[];
  flowSteps: { flowId: string; flowName: string; step: number; from: string; to: string; label: string; codeRefs: CodeRef[] }[];
  unmatchedPaths: string[];
}

/** Drops undefined values, empty strings and empty arrays so tool output stays small. */
export function pruned<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, v]) => v !== undefined && v !== '' && !(Array.isArray(v) && v.length === 0)),
  ) as T;
}
