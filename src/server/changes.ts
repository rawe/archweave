import { descendantsOf } from '../shared/projection.ts';
import {
  type Actor,
  type ChangeResult,
  CODELESS_KINDS,
  ChangeSet,
  type CodeRef,
  Element,
  type ElementPatch,
  type Field,
  Flow,
  type FlowPatch,
  type FlowStep,
  type Layout,
  type Model,
  type Note,
  Relation,
  type RelationPatch,
  normalizeCodePath,
  slugify,
  uniqueId,
} from '../shared/model.ts';
import { integrityProblems } from './integrity.ts';
import { PathError } from './repo.ts';
import type { CodeAccess } from './stale.ts';
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

export type Collection = keyof IdLists;

export function parseChangeSet(input: unknown): ChangeSet {
  const parsed = ChangeSet.safeParse(input);
  if (parsed.success) return parsed.data;
  const issues = parsed.error.issues.slice(0, 10).map((issue) => `${describePath(input, issue.path)}: ${issue.message}`);
  throw new ChangeError(`Invalid change set:\n${issues.join('\n')}`, parsed.error.issues);
}

/**
 * Applies a change set to copies of model and layout. Throws ChangeError, leaving the inputs untouched.
 * With `code`, code ref paths are normalized against the repository and refs written by the change set
 * are sealed (see `CodeRef.digest`).
 */
export function applyChangeSet(base: { model: Model; layout: Layout }, changes: ChangeSet, actor: Actor, now: Date, code?: CodeAccess): Applied {
  return new Draft(base, actor, now, code).run(changes);
}

/** An id the caller wrote into this change set that must name a data structure. */
interface SuppliedDataRef {
  where: string;
  id: string;
  what: 'data id' | 'ref';
}

const ELEMENT_HELPERS = new Set(['id', 'addNotes', 'resolveNotes', 'addCodeRefs', 'removeCodeRefs', 'setFields', 'removeFields']);
const RELATION_HELPERS = new Set(['addCodeRefs', 'removeCodeRefs']);
const FLOW_HELPERS = new Set(['updateSteps', 'insertSteps', 'removeSteps']);
const STEP_HELPERS = new Set(['index', 'addCodeRefs', 'removeCodeRefs']);

class Draft {
  private model: Model;
  private layout: Layout;
  private elements: Map<string, Element>;
  private relations: Map<string, Relation>;
  private flows: Map<string, Flow>;
  /** Kinds before this change set, to find elements that stopped being data structures. */
  private baseKinds: Map<string, Element['kind']>;
  private created = sets();
  private updated = sets();
  private removed = sets();
  private touched = sets();
  private supplied: SuppliedDataRef[] = [];
  private warnings: string[] = [];
  private errors: string[] = [];
  private metaChanged = false;
  private layoutChanged = false;

  constructor(
    base: { model: Model; layout: Layout },
    private actor: Actor,
    private now: Date,
    private code?: CodeAccess,
  ) {
    this.model = structuredClone(base.model);
    this.layout = structuredClone(base.layout);
    this.elements = new Map(this.model.elements.map((e) => [e.id, e]));
    this.relations = new Map(this.model.relations.map((r) => [r.id, r]));
    this.flows = new Map(this.model.flows.map((f) => [f.id, f]));
    this.baseKinds = new Map(this.model.elements.map((e) => [e.id, e.kind]));
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
    this.checkSuppliedData();
    this.failOnErrors();
    this.dropLostData();
    if (changes.layout) this.applyLayout(changes.layout);

    this.model.elements = [...this.elements.values()];
    this.model.relations = [...this.relations.values()];
    this.model.flows = [...this.flows.values()];
    // The same check the store runs on load: no change set may persist a model that would not load again.
    const problems = integrityProblems(this.model);
    if (problems.length) throw new ChangeError(`Nothing was applied. The change set would leave the model inconsistent:\n${problems.slice(0, 10).map((p) => `- ${p}`).join('\n')}`, problems);
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
      }
    }
    for (const id of remove.flows ?? []) {
      this.flows.delete(id);
      this.removed.flows.add(id);
    }
    if (!doomed.size) return;
    for (const flow of [...this.flows.values()]) {
      const steps = flow.steps.filter((s) => !doomed.has(s.from) && !doomed.has(s.to));
      if (steps.length !== flow.steps.length) {
        this.flows.set(flow.id, { ...flow, steps });
        this.markUpdated('flows', flow.id);
      }
    }
    for (const canvas of Object.keys(this.layout)) {
      if (canvas.startsWith('structure:') && doomed.has(canvas.slice('structure:'.length))) {
        delete this.layout[canvas];
        this.layoutChanged = true;
        continue;
      }
      for (const id of Object.keys(this.layout[canvas]!)) {
        if (!doomed.has(id)) continue;
        delete this.layout[canvas]![id];
        this.layoutChanged = true;
      }
      if (!Object.keys(this.layout[canvas]!).length) delete this.layout[canvas];
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
      if (value === undefined || ELEMENT_HELPERS.has(key)) continue;
      if (key === 'parentId' && value === null) delete next.parentId;
      else next[key] = value;
    }
    next.id = id;
    next.notes = this.applyNotes(where, next.notes as Note[], patch);
    next.codeRefs = this.applyCodeRefs(where, existing?.codeRefs ?? [], (next.codeRefs as CodeRef[] | undefined) ?? [], patch);
    next.fields = this.applyFields(where, (next.fields as Field[] | undefined) ?? [], patch);
    for (const field of [...(patch.fields ?? []), ...(patch.setFields ?? [])]) {
      if (field.ref) this.supplied.push({ where: `element \`${id}\` field \`${field.name}\``, id: field.ref, what: 'ref' });
    }

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
    if (patch.kind && CODELESS_KINDS.includes(patch.kind)) return 'built';
    return patch.codeRefs?.length || patch.addCodeRefs?.length ? 'built' : 'planned';
  }

  private applyNotes(where: string, notes: Note[], patch: ElementPatch): Note[] {
    let result = notes;
    if (patch.resolveNotes?.length) {
      result = result.map((n) => (patch.resolveNotes!.includes(n.id) ? { ...n, resolved: true } : n));
      for (const id of patch.resolveNotes) {
        if (!notes.some((n) => n.id === id)) {
          const hint = notes.length ? ` Its notes are: ${notes.map((n) => `\`${n.id}\``).join(', ')}.` : ' It has no notes.';
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

  /**
   * Writes a code ref list: normalizes paths, then applies `removeCodeRefs` and `addCodeRefs` (de-duplicated).
   * Seals, per ref written:
   * - same location and digest as a ref stored before (`previous`) → kept as is, no file read (resending a list never accepts drift);
   * - a digest otherwise → a claim that the code at the new location is the sealed text: verified against the file, an error when it is not;
   * - no digest → sealed afresh against the current file. A ref re-sent in `addCodeRefs` without a digest is always sealed afresh.
   */
  private applyCodeRefs(where: string, previous: CodeRef[], refs: CodeRef[], patch: Pick<ElementPatch, 'addCodeRefs' | 'removeCodeRefs'>): CodeRef[] {
    const stored = new Set(previous.flatMap((ref) => [sealKey(ref), sealKey({ ...ref, path: this.storedPath(ref.path) ?? ref.path })]));
    let result = refs.map((ref) => this.writeRef(where, stored, ref, true));
    for (const selector of patch.removeCodeRefs ?? []) {
      const path = this.storedPath(selector.path) ?? normalizeCodePath(selector.path);
      const matches = (r: CodeRef) =>
        r.path === path && (selector.symbol === undefined || r.symbol === selector.symbol) && (selector.startLine === undefined || r.startLine === selector.startLine);
      const kept = result.filter((r) => !matches(r));
      if (kept.length === result.length) {
        const known = result.map(describeRef);
        const hint = known.length ? ` Its code refs are: ${known.join(', ')}.` : ' It has no code refs.';
        const narrowed = [selector.symbol !== undefined ? ` and symbol \`${selector.symbol}\`` : '', selector.startLine !== undefined ? ` starting at line ${selector.startLine}` : ''].join('');
        this.errors.push(`${where}: removeCodeRefs: no code ref with path \`${path}\`${narrowed}.${hint}`);
      }
      result = kept;
    }
    for (const ref of patch.addCodeRefs ?? []) {
      const sent = this.normalizeRef(where, ref);
      if (!sent) continue;
      const at = result.findIndex((r) => sameRef(r, sent));
      if (at < 0) {
        result.push(this.writeRef(where, stored, sent, false));
        continue;
      }
      const { digest: _old, ...current } = result[at]!;
      const merged: CodeRef = { ...current, ...(sent.note !== undefined ? { note: sent.note } : {}), ...(sent.digest !== undefined ? { digest: sent.digest } : {}) };
      result[at] = this.writeRef(where, stored, merged, false);
    }
    return result;
  }

  /** One ref as stored, per the seal rules of `applyCodeRefs`. `keepUnsealed`: a ref without digest matching an unsealed stored one stays as is. */
  private writeRef(where: string, stored: Set<string>, ref: CodeRef, keepUnsealed: boolean): CodeRef {
    const keepable = keepUnsealed || ref.digest !== undefined;
    // A stored ref passing through untouched keeps its path even when it cannot be normalized any more.
    if (keepable && stored.has(sealKey(ref))) return { ...ref, path: this.storedPath(ref.path) ?? ref.path };
    const normalized = this.normalizeRef(where, ref);
    if (!normalized) return ref;
    if (keepable && stored.has(sealKey(normalized))) return normalized;
    return this.sealed(where, normalized);
  }

  /**
   * The ref with its seal: a sent digest must match the text at the ref's range (a verified move); without one
   * the ref is sealed afresh. Warns when the ref is stale already.
   */
  private sealed(where: string, ref: CodeRef): CodeRef {
    const { digest: claimed, ...bare } = ref;
    if (!this.code) return bare;
    const seal = this.code.seal(bare);
    if (claimed !== undefined && seal.digest !== claimed) {
      this.errors.push(
        `${where}: the code at ${describeRef(bare)} is not the text this link was sealed to. Send the ref without \`digest\` to seal it to the current text.`,
      );
      return ref;
    }
    if (seal.reason) this.warnings.push(`${where}: code ref ${describeRef(bare)}: ${staleWarning(bare, seal.reason)}`);
    return seal.digest ? { ...bare, digest: seal.digest } : bare;
  }

  /** The stored form of a path, repository-aware when the repository is known; undefined when it is outside the repository. */
  private storedPath(path: string): string | undefined {
    if (!this.code) return normalizeCodePath(path);
    try {
      return this.code.normalizePath(path);
    } catch (error) {
      if (error instanceof PathError) return undefined;
      throw error;
    }
  }

  /** The ref with its stored path, or undefined (and an error) when the path is outside the repository. */
  private normalizeRef(where: string, ref: CodeRef): CodeRef | undefined {
    const path = this.storedPath(ref.path);
    if (path === undefined) {
      this.errors.push(`${where}: code ref path \`${ref.path}\` is outside the repository. Use a path relative to the repository root.`);
      return undefined;
    }
    return { ...ref, path };
  }

  /** Applies `removeFields`, then `setFields` (upsert by name). */
  private applyFields(where: string, fields: Field[], patch: ElementPatch): Field[] {
    let result = [...fields];
    for (const name of patch.removeFields ?? []) {
      if (!result.some((f) => f.name === name)) {
        const hint = fields.length ? ` Its fields are: ${fields.map((f) => `\`${f.name}\``).join(', ')}.` : ' It has no fields.';
        this.errors.push(`${where}: removeFields: no field \`${name}\`.${hint}`);
      }
      result = result.filter((f) => f.name !== name);
    }
    for (const fieldPatch of patch.setFields ?? []) {
      const at = result.findIndex((f) => f.name === fieldPatch.name);
      const merged: Record<string, unknown> = at >= 0 ? { ...result[at] } : { name: fieldPatch.name, type: '' };
      for (const [key, value] of Object.entries(fieldPatch)) {
        if (value === undefined) continue;
        if (key === 'ref' && value === null) delete merged.ref;
        else merged[key] = value;
      }
      if (at >= 0) result[at] = merged as Field;
      else result.push(merged as Field);
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
    const next: Record<string, unknown> = { ...existing, ...withoutKeys(definedOnly(patch), RELATION_HELPERS), id };
    next.codeRefs = this.applyCodeRefs(where, existing?.codeRefs ?? [], (next.codeRefs as CodeRef[] | undefined) ?? [], patch);
    for (const dataId of patch.dataIds ?? []) this.supplied.push({ where: `relation \`${id}\``, id: dataId, what: 'data id' });
    const parsed = Relation.safeParse(next);
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
    const suppliedSteps = new Set<object>(patch.steps ?? []);
    const previousRefs = existing?.steps.flatMap((s) => s.codeRefs) ?? [];
    const settled = new Set<object>();
    const steps = this.applySteps(where, patch.steps ?? existing?.steps ?? [], patch, suppliedSteps, previousRefs, settled);
    steps.forEach((step, i) => {
      if (!suppliedSteps.has(step)) return;
      for (const dataId of step.dataIds ?? []) this.supplied.push({ where: `flow \`${id}\` step ${i + 1}`, id: dataId, what: 'data id' });
    });
    const parsed = Flow.safeParse({ ...existing, ...withoutKeys(definedOnly(patch), FLOW_HELPERS), steps, id });
    if (!parsed.success) {
      this.errors.push(`${where}: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
      return;
    }
    const flow = dropUndefined({
      ...parsed.data,
      steps: parsed.data.steps.map((s, i) =>
        dropUndefined({ ...s, codeRefs: settled.has(steps[i]!) ? s.codeRefs : this.applyCodeRefs(`flow \`${id}\` step ${i + 1}`, previousRefs, s.codeRefs, {}) }),
      ),
    });
    if (existing && JSON.stringify(existing) === JSON.stringify(flow)) return;
    this.flows.set(id, flow);
    this.touched.flows.add(id);
    if (existing) this.markUpdated('flows', id);
    else this.created.flows.add(id);
  }

  /**
   * Applies `updateSteps`, `removeSteps` and `insertSteps`. All indices are 0-based and
   * refer to `steps` as given; steps whose data ids come from the patch go into `supplied`.
   */
  private applySteps(where: string, steps: FlowStep[], patch: FlowPatch, supplied: Set<object>, previousRefs: CodeRef[], settled: Set<object>): FlowStep[] {
    const count = steps.length;
    const inRange = (op: string, index: number, max: number) => {
      if (index <= max) return true;
      const extent = count ? `the flow has ${count} step${count === 1 ? '' : 's'}, indices 0 to ${count - 1}` : 'the flow has no steps';
      this.errors.push(`${where}: ${op}: index ${index} is out of range (${extent}).`);
      return false;
    };
    const slots: (FlowStep | undefined)[] = [...steps];
    const removed = new Set(patch.removeSteps ?? []);
    for (const update of patch.updateSteps ?? []) {
      if (!inRange('updateSteps', update.index, count - 1)) continue;
      if (removed.has(update.index)) {
        this.errors.push(`${where}: index ${update.index} is both updated and removed.`);
        continue;
      }
      const { index } = update;
      const changes = withoutKeys(definedOnly(update), STEP_HELPERS);
      const before = slots[index]!;
      const merged = { ...before, ...changes } as FlowStep;
      // Provenance follows the step through merges: later updates to the same index keep what earlier ones supplied.
      if (changes.dataIds || supplied.has(before)) supplied.add(merged);
      if (changes.codeRefs || update.addCodeRefs || update.removeCodeRefs) {
        merged.codeRefs = this.applyCodeRefs(`${where} step ${index + 1}`, previousRefs, merged.codeRefs ?? [], update);
        settled.add(merged);
      } else if (settled.has(before)) settled.add(merged);
      slots[index] = merged;
    }
    for (const index of removed) if (inRange('removeSteps', index, count - 1)) slots[index] = undefined;
    const inserts = new Map<number, FlowStep[]>();
    for (const insert of patch.insertSteps ?? []) {
      if (!inRange('insertSteps', insert.index, count)) continue;
      inserts.set(insert.index, [...(inserts.get(insert.index) ?? []), insert.step]);
      supplied.add(insert.step);
    }
    const out: FlowStep[] = [];
    for (let i = 0; i <= count; i++) {
      out.push(...(inserts.get(i) ?? []));
      if (slots[i]) out.push(slots[i]!);
    }
    return out;
  }

  private checkElements(): void {
    for (const id of this.touched.elements) {
      const element = this.elements.get(id)!;
      if (element.parentId === undefined) continue;
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
  }

  private checkRelations(): void {
    for (const id of this.touched.relations) {
      const relation = this.relations.get(id)!;
      for (const end of ['from', 'to'] as const) {
        if (!this.elements.has(relation[end])) {
          this.errors.push(`relation \`${id}\`: unknown element \`${relation[end]}\` in \`${end}\`.${didYouMean(relation[end], this.elements.values())}`);
        }
      }
    }
  }

  private checkFlows(): void {
    for (const id of this.touched.flows) {
      this.flows.get(id)!.steps.forEach((step, i) => {
        for (const end of ['from', 'to'] as const) {
          if (!this.elements.has(step[end])) {
            this.errors.push(`flow \`${id}\` step ${i + 1}: unknown element \`${step[end]}\` in \`${end}\`.${didYouMean(step[end], this.elements.values())}`);
          }
        }
      });
    }
  }

  /** Data ids and field refs written in this change set must name data structures after it is applied. */
  private checkSuppliedData(): void {
    for (const ref of this.supplied) {
      if (!this.isData(ref.id)) this.errors.push(`${ref.where}: ${ref.what} \`${ref.id}\`: ${this.notDataReason(ref.id)}`);
    }
  }

  /** Cleans stored data ids and field refs that point at elements removed or no longer of kind data. */
  private dropLostData(): void {
    const lost = new Set([...this.baseKinds].filter(([id, kind]) => kind === 'data' && !this.isData(id)).map(([id]) => id));
    if (!lost.size) return;
    for (const element of [...this.elements.values()]) {
      if (!element.fields.some((f) => f.ref && lost.has(f.ref))) continue;
      const fields = element.fields.map((f) => {
        if (!f.ref || !lost.has(f.ref)) return f;
        this.warnings.push(`element \`${element.id}\` field \`${f.name}\`: dropped ref \`${f.ref}\`, ${this.notDataReason(f.ref)}`);
        return dropUndefined({ ...f, ref: undefined });
      });
      this.elements.set(element.id, { ...element, fields });
      this.markUpdated('elements', element.id);
    }
    const keep = (ids: string[], where: string) =>
      ids.filter((dataId) => {
        if (!lost.has(dataId)) return true;
        this.warnings.push(`${where}: dropped data id \`${dataId}\`, ${this.notDataReason(dataId)}`);
        return false;
      });
    for (const relation of [...this.relations.values()]) {
      if (!relation.dataIds.some((d) => lost.has(d))) continue;
      this.relations.set(relation.id, { ...relation, dataIds: keep(relation.dataIds, `relation \`${relation.id}\``) });
      this.markUpdated('relations', relation.id);
    }
    for (const flow of [...this.flows.values()]) {
      if (!flow.steps.some((s) => s.dataIds.some((d) => lost.has(d)))) continue;
      const steps = flow.steps.map((s, i) => (s.dataIds.some((d) => lost.has(d)) ? { ...s, dataIds: keep(s.dataIds, `flow \`${flow.id}\` step ${i + 1}`) } : s));
      this.flows.set(flow.id, { ...flow, steps });
      this.markUpdated('flows', flow.id);
    }
  }

  private isData(id: string): boolean {
    return this.elements.get(id)?.kind === 'data';
  }

  private notDataReason(id: string): string {
    if (this.removed.elements.has(id)) return 'it is removed in this change set.';
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

/** The one element, relation or flow a change only updated (nothing created or removed), if that is all it did. */
export function onlyUpdated(lists: { created: IdLists; updated: IdLists; removed: IdLists }): { collection: Collection; id: string } | undefined {
  const all = (l: IdLists) => [...l.elements, ...l.relations, ...l.flows];
  if (all(lists.created).length || all(lists.removed).length || all(lists.updated).length !== 1) return undefined;
  const collection = (['elements', 'relations', 'flows'] as const).find((c) => lists.updated[c].length)!;
  return { collection, id: lists.updated[collection][0]! };
}

const PROPERTY_WORDS: Record<string, string> = { codeRefs: 'code links', parentId: 'parent', dataIds: 'data', from: 'ends', to: 'ends' };

/** A generated summary for an update of one item, naming what changed between `before` and `after`: "Edited Order: fields, summary". */
export function describeEdit(collection: Collection, before: object | undefined, after: object, model: Model): string {
  const name = (id: string) => model.elements.find((e) => e.id === id)?.name ?? id;
  const item = after as { id: string; name?: string; from?: string; to?: string };
  const label = collection === 'relations' ? `${name(item.from!)} → ${name(item.to!)}` : (item.name ?? item.id);
  const old = (before ?? {}) as Record<string, unknown>;
  const now = after as Record<string, unknown>;
  const keys = [...new Set([...Object.keys(old), ...Object.keys(now)])].filter((k) => JSON.stringify(old[k]) !== JSON.stringify(now[k]));
  const words = [...new Set(keys.map((k) => PROPERTY_WORDS[k] ?? k))];
  return words.length ? `Edited ${label}: ${words.join(', ')}` : `Edited ${label}`;
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

function withoutKeys<T extends object>(value: T, keys: ReadonlySet<string>): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([key]) => !keys.has(key))) as Partial<T>;
}

function sameRef(a: CodeRef, b: CodeRef): boolean {
  return a.path === b.path && a.symbol === b.symbol && a.startLine === b.startLine && a.endLine === b.endLine;
}

/** What a ref points at and its seal, for recognizing a resent ref as the stored one. */
function sealKey(ref: CodeRef): string {
  return JSON.stringify([ref.path, ref.symbol ?? null, ref.startLine ?? null, ref.endLine ?? null, ref.digest ?? null]);
}

function describeRef(ref: CodeRef): string {
  const lines = ref.startLine ? ` lines ${lineSpan(ref)}` : '';
  return `\`${ref.path}\`${ref.symbol ? ` (\`${ref.symbol}\`)` : ''}${lines}`;
}

function lineSpan(ref: CodeRef): string {
  return ref.endLine && ref.endLine !== ref.startLine ? `${ref.startLine}–${ref.endLine}` : `${ref.startLine}`;
}

function staleWarning(ref: CodeRef, reason: string): string {
  switch (reason) {
    case 'missing-file':
      return 'the file does not exist (yet).';
    case 'line-out-of-range':
      return 'the line range is past the end of the file.';
    case 'symbol-not-found':
      return `\`${ref.symbol}\` does not occur in the file as an identifier.`;
    case 'symbol-outside-range':
      return `\`${ref.symbol}\` does not occur within lines ${lineSpan(ref)}. A symbol must literally occur in its range; for things registered by a string name (routes, tool names), give the line range without a symbol.`;
    default:
      return reason;
  }
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
