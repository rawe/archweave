import { descendantsOf } from '../shared/projection.ts';
import {
  type Actor,
  type ChangeResult,
  ChangeSet,
  Element,
  type ElementPatch,
  Flow,
  type FlowPatch,
  type Layout,
  type Model,
  type Note,
  Relation,
  type RelationPatch,
  slugify,
  uniqueId,
} from '../shared/model.ts';
import { didYouMean } from './suggest.ts';

export class ChangeError extends Error {
  constructor(
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ChangeError';
  }
}

export type IdLists = ChangeResult['created'];

export interface Applied {
  model: Model;
  layout: Layout;
  created: IdLists;
  updated: IdLists;
  removed: IdLists;
  warnings: string[];
  modelChanged: boolean;
  layoutChanged: boolean;
}

type Collection = keyof IdLists;

export function parseChangeSet(input: unknown): ChangeSet {
  const parsed = ChangeSet.safeParse(input);
  if (parsed.success) return parsed.data;
  const issues = parsed.error.issues.slice(0, 10).map((issue) => `${describePath(input, issue.path)}: ${issue.message}`);
  throw new ChangeError(`Invalid change set:\n${issues.join('\n')}`, parsed.error.issues);
}

/** Applies a change set to copies of model and layout. Throws ChangeError, leaving the inputs untouched. */
export function applyChangeSet(base: { model: Model; layout: Layout }, changes: ChangeSet, actor: Actor, now: Date): Applied {
  return new Draft(base, actor, now).run(changes);
}

class Draft {
  private model: Model;
  private layout: Layout;
  private elements: Map<string, Element>;
  private relations: Map<string, Relation>;
  private flows: Map<string, Flow>;
  private created = sets();
  private updated = sets();
  private removed = sets();
  private touched = sets();
  private warnings: string[] = [];
  private errors: string[] = [];
  private metaChanged = false;
  private layoutChanged = false;

  constructor(
    base: { model: Model; layout: Layout },
    private actor: Actor,
    private now: Date,
  ) {
    this.model = structuredClone(base.model);
    this.layout = structuredClone(base.layout);
    this.elements = new Map(this.model.elements.map((e) => [e.id, e]));
    this.relations = new Map(this.model.relations.map((r) => [r.id, r]));
    this.flows = new Map(this.model.flows.map((f) => [f.id, f]));
  }

  run(changes: ChangeSet): Applied {
    this.applyMeta(changes.model);
    this.applyRemovals(changes);
    changes.elements?.forEach((patch, i) => this.upsertElement(patch, i));
    changes.relations?.forEach((patch, i) => this.upsertRelation(patch, i));
    changes.flows?.forEach((patch, i) => this.upsertFlow(patch, i));
    this.failOnErrors();
    this.checkElements();
    this.checkRelations();
    this.checkFlows();
    this.failOnErrors();
    if (changes.layout) this.applyLayout(changes.layout);

    this.model.elements = [...this.elements.values()];
    this.model.relations = [...this.relations.values()];
    this.model.flows = [...this.flows.values()];
    const lists = (s: Record<Collection, Set<string>>): IdLists => ({
      elements: [...s.elements],
      relations: [...s.relations],
      flows: [...s.flows],
    });
    const created = lists(this.created);
    const updated = lists(this.updated);
    const removed = lists(this.removed);
    const modelChanged = this.metaChanged || [created, updated, removed].some((l) => l.elements.length + l.relations.length + l.flows.length > 0);
    return { model: this.model, layout: this.layout, created, updated, removed, warnings: this.warnings, modelChanged, layoutChanged: this.layoutChanged };
  }

  private failOnErrors(): void {
    if (!this.errors.length) return;
    const shown = this.errors.slice(0, 10);
    const more = this.errors.length > shown.length ? `\n…and ${this.errors.length - shown.length} more` : '';
    throw new ChangeError(`Nothing was applied.\n${shown.join('\n')}${more}`, this.errors);
  }

  private applyMeta(meta: ChangeSet['model']): void {
    if (meta?.name !== undefined && meta.name !== this.model.name) {
      this.model.name = meta.name;
      this.metaChanged = true;
    }
    if (meta?.description !== undefined && meta.description !== this.model.description) {
      this.model.description = meta.description;
      this.metaChanged = true;
    }
  }

  private applyRemovals(changes: ChangeSet): void {
    const remove = changes.remove ?? {};
    const upserted = (patches: { id?: string }[] | undefined) => new Set((patches ?? []).map((p) => p.id).filter(Boolean));
    const checkUnknown = (ids: string[] | undefined, collection: Collection, known: Map<string, { id: string; name?: string }>, singular: string) => {
      const changed = upserted(changes[collection]);
      for (const id of ids ?? []) {
        if (!known.has(id)) this.errors.push(`remove.${collection}: unknown ${singular} \`${id}\`.${didYouMean(id, known.values())}`);
        else if (changed.has(id)) this.errors.push(`${singular} \`${id}\` is both removed and changed in this change set.`);
      }
    };
    checkUnknown(remove.elements, 'elements', this.elements, 'element');
    checkUnknown(remove.relations, 'relations', this.relations, 'relation');
    checkUnknown(remove.flows, 'flows', this.flows, 'flow');
    this.failOnErrors();

    const doomed = new Set<string>();
    for (const id of remove.elements ?? []) {
      doomed.add(id);
      for (const d of descendantsOf(id, this.model.elements)) doomed.add(d.id);
    }
    const changedElements = upserted(changes.elements);
    for (const id of doomed) {
      if (changedElements.has(id)) this.errors.push(`element \`${id}\` is removed (it is inside a removed element) and changed in this change set.`);
      this.elements.delete(id);
      this.removed.elements.add(id);
    }

    for (const relation of [...this.relations.values()]) {
      if (doomed.has(relation.from) || doomed.has(relation.to) || remove.relations?.includes(relation.id)) {
        this.relations.delete(relation.id);
        this.removed.relations.add(relation.id);
        continue;
      }
      const kept = relation.dataIds.filter((id) => !doomed.has(id));
      if (kept.length !== relation.dataIds.length) {
        this.relations.set(relation.id, { ...relation, dataIds: kept });
        this.markUpdated('relations', relation.id);
      }
    }
    for (const id of remove.flows ?? []) {
      this.flows.delete(id);
      this.removed.flows.add(id);
    }
    if (doomed.size) {
      for (const flow of [...this.flows.values()]) {
        const steps = flow.steps
          .filter((s) => !doomed.has(s.from) && !doomed.has(s.to))
          .map((s) => (s.dataIds.some((d) => doomed.has(d)) ? { ...s, dataIds: s.dataIds.filter((d) => !doomed.has(d)) } : s));
        if (JSON.stringify(steps) !== JSON.stringify(flow.steps)) {
          this.flows.set(flow.id, { ...flow, steps });
          this.markUpdated('flows', flow.id);
        }
      }
      for (const element of [...this.elements.values()]) {
        if (!element.fields.some((f) => f.ref && doomed.has(f.ref))) continue;
        const fields = element.fields.map((f) => (f.ref && doomed.has(f.ref) ? { ...f, ref: undefined } : f));
        this.elements.set(element.id, { ...element, fields: fields.map(dropUndefined) });
        this.markUpdated('elements', element.id);
      }
      for (const canvas of Object.keys(this.layout)) {
        if (canvas.startsWith('structure:') && doomed.has(canvas.slice('structure:'.length))) {
          delete this.layout[canvas];
          continue;
        }
        for (const id of Object.keys(this.layout[canvas]!)) if (doomed.has(id)) delete this.layout[canvas]![id];
      }
    }
  }

  private upsertElement(patch: ElementPatch, index: number): void {
    const where = entryLabel('elements', index, patch.id, patch.name);
    const existing = patch.id ? this.elements.get(patch.id) : undefined;
    if (!existing && !(patch.kind && patch.name)) {
      this.errors.push(
        patch.id
          ? `${where}: there is no element \`${patch.id}\`. To create it, give \`kind\` and \`name\`.${didYouMean(patch.id, this.elements.values())}`
          : `${where}: a new element needs \`kind\` and \`name\`.`,
      );
      return;
    }
    const id = existing?.id ?? patch.id ?? uniqueId(slugify(patch.name!), new Set(this.elements.keys()));
    const next: Record<string, unknown> = existing
      ? { ...existing }
      : { status: patch.status ?? this.defaultStatus(patch), notes: [] };
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined || key === 'id' || key === 'addNotes' || key === 'resolveNotes') continue;
      if (key === 'parentId' && value === null) delete next.parentId;
      else next[key] = value;
    }
    next.id = id;
    next.notes = this.applyNotes(where, next.notes as Note[], patch);

    const parsed = Element.safeParse(next);
    if (!parsed.success) {
      this.errors.push(`${where}: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
      return;
    }
    const element = dropUndefined(parsed.data);
    if (existing && JSON.stringify(existing) === JSON.stringify(element)) return;
    this.elements.set(id, element);
    this.touched.elements.add(id);
    if (existing) this.markUpdated('elements', id);
    else this.created.elements.add(id);
  }

  private defaultStatus(patch: ElementPatch): Element['status'] {
    if (this.actor === 'human') return 'planned';
    return patch.codeRefs?.length ? 'built' : 'planned';
  }

  private applyNotes(where: string, notes: Note[], patch: ElementPatch): Note[] {
    let result = notes;
    if (patch.resolveNotes?.length) {
      result = result.map((n) => (patch.resolveNotes!.includes(n.id) ? { ...n, resolved: true } : n));
      for (const id of patch.resolveNotes) {
        if (!notes.some((n) => n.id === id)) {
          const known = notes.map((n) => ({ id: n.id }));
          const hint = known.length ? ` Its notes are: ${known.map((n) => `\`${n.id}\``).join(', ')}.` : ' It has no notes.';
          this.errors.push(`${where}: unknown note \`${id}\`.${hint}`);
        }
      }
    }
    for (const text of patch.addNotes ?? []) {
      const taken = new Set(result.map((n) => n.id));
      result = [...result, { id: uniqueId(`note-${result.length + 1}`, taken), text, author: this.actor, createdAt: this.now.toISOString() }];
    }
    return result;
  }

  private upsertRelation(patch: RelationPatch, index: number): void {
    const where = entryLabel('relations', index, patch.id, patch.label || (patch.from && patch.to ? `${patch.from} → ${patch.to}` : undefined));
    const existing = patch.id ? this.relations.get(patch.id) : undefined;
    if (!existing && !(patch.from && patch.to)) {
      this.errors.push(
        patch.id
          ? `${where}: there is no relation \`${patch.id}\`. To create it, give \`from\` and \`to\`.${didYouMean(patch.id, this.relations.values())}`
          : `${where}: a new relation needs \`from\` and \`to\`.`,
      );
      return;
    }
    const id = existing?.id ?? patch.id ?? uniqueId(slugify(`${patch.from}-${patch.kind ?? 'uses'}-${patch.to}`), new Set(this.relations.keys()));
    const parsed = Relation.safeParse({ ...existing, ...definedOnly(patch), id });
    if (!parsed.success) {
      this.errors.push(`${where}: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
      return;
    }
    const relation = dropUndefined(parsed.data);
    if (existing && JSON.stringify(existing) === JSON.stringify(relation)) return;
    this.relations.set(id, relation);
    this.touched.relations.add(id);
    if (existing) this.markUpdated('relations', id);
    else this.created.relations.add(id);
  }

  private upsertFlow(patch: FlowPatch, index: number): void {
    const where = entryLabel('flows', index, patch.id, patch.name);
    const existing = patch.id ? this.flows.get(patch.id) : undefined;
    if (!existing && !patch.name) {
      this.errors.push(
        patch.id
          ? `${where}: there is no flow \`${patch.id}\`. To create it, give \`name\`.${didYouMean(patch.id, this.flows.values())}`
          : `${where}: a new flow needs \`name\`.`,
      );
      return;
    }
    const id = existing?.id ?? patch.id ?? uniqueId(slugify(patch.name!), new Set(this.flows.keys()));
    const parsed = Flow.safeParse({ ...existing, ...definedOnly(patch), id });
    if (!parsed.success) {
      this.errors.push(`${where}: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
      return;
    }
    const flow = dropUndefined(parsed.data);
    if (existing && JSON.stringify(existing) === JSON.stringify(flow)) return;
    this.flows.set(id, flow);
    this.touched.flows.add(id);
    if (existing) this.markUpdated('flows', id);
    else this.created.flows.add(id);
  }

  private checkElements(): void {
    for (const id of this.touched.elements) {
      const element = this.elements.get(id)!;
      if (element.parentId !== undefined) {
        if (element.parentId === id) this.errors.push(`element \`${id}\`: cannot be its own parent.`);
        else if (!this.elements.has(element.parentId)) {
          this.errors.push(`element \`${id}\`: unknown parent \`${element.parentId}\`.${didYouMean(element.parentId, this.elements.values())}`);
        } else {
          const seen = new Set<string>([id]);
          let cursor = this.elements.get(element.parentId);
          while (cursor) {
            if (seen.has(cursor.id)) {
              this.errors.push(`element \`${id}\`: putting it inside \`${element.parentId}\` creates a containment cycle (\`${element.parentId}\` is inside \`${id}\`).`);
              break;
            }
            seen.add(cursor.id);
            cursor = cursor.parentId ? this.elements.get(cursor.parentId) : undefined;
          }
        }
      }
      if (element.fields.some((f) => f.ref && !this.isData(f.ref))) {
        const fields = element.fields.map((f) => {
          if (!f.ref || this.isData(f.ref)) return f;
          this.warnings.push(`element \`${id}\` field \`${f.name}\`: dropped ref \`${f.ref}\`, ${this.notDataReason(f.ref)}`);
          return dropUndefined({ ...f, ref: undefined });
        });
        this.elements.set(id, { ...element, fields });
      }
    }
  }

  private checkRelations(): void {
    for (const id of this.touched.relations) {
      const relation = this.relations.get(id)!;
      for (const end of ['from', 'to'] as const) {
        if (!this.elements.has(relation[end])) {
          this.errors.push(`relation \`${id}\`: unknown element \`${relation[end]}\` in \`${end}\`.${didYouMean(relation[end], this.elements.values())}`);
        }
      }
      const dataIds = this.keepData(relation.dataIds, `relation \`${id}\``);
      if (dataIds.length !== relation.dataIds.length) this.relations.set(id, { ...relation, dataIds });
    }
  }

  private checkFlows(): void {
    for (const id of this.touched.flows) {
      const flow = this.flows.get(id)!;
      const steps = flow.steps.map((step, i) => {
        for (const end of ['from', 'to'] as const) {
          if (!this.elements.has(step[end])) {
            this.errors.push(`flow \`${id}\` step ${i + 1}: unknown element \`${step[end]}\` in \`${end}\`.${didYouMean(step[end], this.elements.values())}`);
          }
        }
        const dataIds = this.keepData(step.dataIds, `flow \`${id}\` step ${i + 1}`);
        return dataIds.length === step.dataIds.length ? step : { ...step, dataIds };
      });
      this.flows.set(id, { ...flow, steps });
    }
  }

  private keepData(ids: string[], where: string): string[] {
    return ids.filter((dataId) => {
      if (this.isData(dataId)) return true;
      this.warnings.push(`${where}: dropped data id \`${dataId}\`, ${this.notDataReason(dataId)}`);
      return false;
    });
  }

  private isData(id: string): boolean {
    return this.elements.get(id)?.kind === 'data';
  }

  private notDataReason(id: string): string {
    const element = this.elements.get(id);
    if (element) return `it is a ${element.kind}, not a data structure.`;
    const data = [...this.elements.values()].filter((e) => e.kind === 'data');
    return `no such data structure.${didYouMean(id, data)}`;
  }

  private applyLayout(patch: NonNullable<ChangeSet['layout']>): void {
    for (const [canvas, positions] of Object.entries(patch)) {
      const target = { ...this.layout[canvas] };
      for (const [id, position] of Object.entries(positions)) {
        const current = target[id];
        if (position === null) {
          if (current) {
            delete target[id];
            this.layoutChanged = true;
          }
        } else if (!current || current.x !== position.x || current.y !== position.y) {
          target[id] = { x: position.x, y: position.y };
          this.layoutChanged = true;
        }
      }
      if (Object.keys(target).length) this.layout[canvas] = target;
      else delete this.layout[canvas];
    }
  }

  private markUpdated(collection: Collection, id: string): void {
    if (!this.created[collection].has(id)) this.updated[collection].add(id);
  }
}

/** Compares two models and lists what differs, for journaling undo and reloads. */
export function diffModels(before: Model, after: Model): { created: IdLists; updated: IdLists; removed: IdLists } {
  const result = { created: emptyLists(), updated: emptyLists(), removed: emptyLists() };
  for (const collection of ['elements', 'relations', 'flows'] as const) {
    const old = new Map<string, unknown>(before[collection].map((e) => [e.id, e]));
    const now = new Map<string, unknown>(after[collection].map((e) => [e.id, e]));
    for (const [id, item] of now) {
      if (!old.has(id)) result.created[collection].push(id);
      else if (JSON.stringify(old.get(id)) !== JSON.stringify(item)) result.updated[collection].push(id);
    }
    for (const id of old.keys()) if (!now.has(id)) result.removed[collection].push(id);
  }
  return result;
}

export function emptyLists(): IdLists {
  return { elements: [], relations: [], flows: [] };
}

export function describeChanges(created: IdLists, updated: IdLists, removed: IdLists): string {
  const parts: string[] = [];
  const phrase = (verb: string, lists: IdLists) => {
    const items = (['elements', 'relations', 'flows'] as const)
      .filter((c) => lists[c].length)
      .map((c) => `${lists[c].length} ${lists[c].length === 1 ? c.slice(0, -1) : c}`);
    if (items.length) parts.push(`${verb} ${items.join(', ')}`);
  };
  phrase('added', created);
  phrase('updated', updated);
  phrase('removed', removed);
  if (!parts.length) return 'Updated the model';
  const text = parts.join('; ');
  return text[0]!.toUpperCase() + text.slice(1);
}

function sets(): Record<Collection, Set<string>> {
  return { elements: new Set(), relations: new Set(), flows: new Set() };
}

function entryLabel(collection: Collection, index: number, id?: string, name?: string): string {
  if (id) return `${collection.slice(0, -1)} \`${id}\``;
  return `${collection}[${index}]${name ? ` ("${name}")` : ''}`;
}

function definedOnly<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as Partial<T>;
}

function dropUndefined<T extends object>(value: T): T {
  return definedOnly(value) as T;
}

function describePath(input: unknown, path: readonly PropertyKey[]): string {
  let out = '';
  let cursor: unknown = input;
  path.forEach((key, i) => {
    if (typeof key === 'number') {
      out += `[${key}]`;
      cursor = Array.isArray(cursor) ? cursor[key] : undefined;
      const entry = cursor as { id?: unknown; name?: unknown } | undefined;
      const tag = typeof entry?.id === 'string' ? entry.id : typeof entry?.name === 'string' ? entry.name : undefined;
      if (tag && i < path.length - 1) out += ` ("${tag}")`;
    } else {
      out += `${out ? '.' : ''}${String(key)}`;
      cursor = cursor && typeof cursor === 'object' ? (cursor as Record<string, unknown>)[key as string] : undefined;
    }
  });
  return out || '(root)';
}
