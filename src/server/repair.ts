import type { Actor, ChangeSet, CodeRef, ElementPatch, FlowPatch, LineRange, Model, RelationPatch, StaleLink } from '../shared/model.ts';
import { descendantsOf } from '../shared/projection.ts';
import { allCodeRefs, type OwnedRef, type RefStatus, type StaleLinks, staleLink } from './stale.ts';
import { ChangeError, RevisionConflict, type Store } from './store.ts';

/** Code refs held by an element in the subtree of `scopeId`, by a relation touching it, or by a flow step touching it. */
export function ownedRefs(model: Model, scopeId?: string): OwnedRef[] {
  const all = allCodeRefs(model);
  if (!scopeId) return all;
  const inScope = new Set([scopeId, ...descendantsOf(scopeId, model.elements).map((e) => e.id)]);
  const relations = new Map(model.relations.map((r) => [r.id, r]));
  const flows = new Map(model.flows.map((f) => [f.id, f]));
  return all.filter((o) => {
    if (o.ownerType === 'element') return inScope.has(o.ownerId);
    if (o.ownerType === 'relation') {
      const r = relations.get(o.ownerId);
      return !!r && (inScope.has(r.from) || inScope.has(r.to));
    }
    const step = flows.get(o.ownerId)?.steps[o.step! - 1];
    return !!step && (inScope.has(step.from) || inScope.has(step.to));
  });
}

export interface RepairedLink {
  ownerType: StaleLink['ownerType'];
  ownerId: string;
  step?: number;
  path: string;
  symbol?: string;
  from: LineRange;
  to: LineRange;
}

export interface RepairResult {
  revision: number;
  /** The journal summary, when anything was changed. */
  summary?: string;
  /** Moved refs that were re-anchored. */
  repaired: RepairedLink[];
  /** What still needs attention after the repair. */
  stale: StaleLink[];
}

/** Checks before giving up: once more after the model or a file changed between checking and applying. */
const ATTEMPTS = 2;

/**
 * Re-anchors every `moved` code ref to its suggested range in one journaled change set. `changed` and other
 * stale refs are left alone and reported. Each re-anchored ref keeps its digest, so the store verifies the text
 * at the new range when it applies the change set; when the model or a file changed since the check, the refs are
 * checked again once, and what still cannot be repaired is reported in `stale`.
 */
export async function repairCodeLinks(store: Store, stale: StaleLinks, options: { actor: Actor; scopeId?: string }): Promise<RepairResult> {
  for (let attempt = 1; ; attempt++) {
    const snapshot = store.snapshot();
    const statuses = await stale.inspect(ownedRefs(snapshot.model, options.scopeId));
    const moved = statuses.filter((s) => s.reason === 'moved' && s.suggestion);
    const remaining = statuses.filter((s) => s.reason && s.reason !== 'moved').map(staleLink);
    if (!moved.length) return { revision: snapshot.revision, repaired: [], stale: remaining };

    const summary = repairSummary(moved);
    let revision: number;
    try {
      revision = store.apply({ ...repairChangeSet(snapshot.model, moved, summary), expectedRevision: snapshot.revision }, options.actor).revision;
    } catch (error) {
      if (!(error instanceof RevisionConflict || error instanceof ChangeError)) throw error;
      if (attempt < ATTEMPTS) continue;
      if (error instanceof RevisionConflict) throw new Error('The model changed while the code links were being checked. Try again.');
      return { revision: store.currentRevision, repaired: [], stale: [...moved.map(staleLink), ...remaining] };
    }
    return {
      revision,
      summary,
      repaired: moved.map((s) => ({
        ownerType: s.ownerType,
        ownerId: s.ownerId,
        ...(s.step ? { step: s.step } : {}),
        path: s.ref.path,
        ...(s.ref.symbol ? { symbol: s.ref.symbol } : {}),
        from: { startLine: s.ref.startLine!, endLine: s.ref.endLine ?? s.ref.startLine! },
        to: s.suggestion!,
      })),
      stale: remaining,
    };
  }
}

/** One patch per owner: the full code ref list with moved refs relocated, keeping their digests; the other refs as read. */
function repairChangeSet(model: Model, moved: RefStatus[], summary: string): ChangeSet {
  const owners = new Map<string, { owned: OwnedRef; refs: CodeRef[] }>();
  for (const s of moved) {
    const key = `${s.ownerType}:${s.ownerId}:${s.step ?? ''}`;
    let owner = owners.get(key);
    if (!owner) owners.set(key, (owner = { owned: s, refs: [...refsOf(model, s)] }));
    const ref = owner.refs[s.index]!;
    const single = ref.endLine === undefined && s.suggestion!.startLine === s.suggestion!.endLine;
    const { endLine: _end, ...rest } = ref;
    owner.refs[s.index] = { ...rest, startLine: s.suggestion!.startLine, ...(single ? {} : { endLine: s.suggestion!.endLine }) };
  }

  const elements: ElementPatch[] = [];
  const relations: RelationPatch[] = [];
  const flows = new Map<string, NonNullable<FlowPatch['updateSteps']>>();
  for (const { owned, refs } of owners.values()) {
    if (owned.ownerType === 'element') elements.push({ id: owned.ownerId, codeRefs: refs });
    else if (owned.ownerType === 'relation') relations.push({ id: owned.ownerId, codeRefs: refs });
    else flows.set(owned.ownerId, [...(flows.get(owned.ownerId) ?? []), { index: owned.step! - 1, codeRefs: refs }]);
  }
  return {
    summary,
    ...(elements.length ? { elements } : {}),
    ...(relations.length ? { relations } : {}),
    ...(flows.size ? { flows: [...flows].map(([id, updateSteps]) => ({ id, updateSteps })) } : {}),
  };
}

function refsOf(model: Model, owned: OwnedRef): CodeRef[] {
  if (owned.ownerType === 'element') return model.elements.find((e) => e.id === owned.ownerId)!.codeRefs;
  if (owned.ownerType === 'relation') return model.relations.find((r) => r.id === owned.ownerId)!.codeRefs;
  return model.flows.find((f) => f.id === owned.ownerId)!.steps[owned.step! - 1]!.codeRefs;
}

/** "Re-anchored 11 code links in src/server/routes.ts". */
export function repairSummary(moved: { ref: CodeRef }[]): string {
  const files = [...new Set(moved.map((m) => m.ref.path))];
  const text = `Re-anchored ${moved.length} code link${moved.length === 1 ? '' : 's'} in ${files.length === 1 ? files[0] : `${files.length} files`}`;
  return text.length > 200 ? `Re-anchored ${moved.length} code links in 1 file` : text;
}
