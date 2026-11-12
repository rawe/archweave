import { type Actor, type ChangeSet, type CodeRef, type ElementPatch, type FlowPatch, type LineRange, type Model, type RelationPatch, type StaleLink } from '../shared/model.ts';
import { descendantsOf } from '../shared/projection.ts';
import { allCodeRefs, type OwnedRef, type RefStatus, type StaleLinks, staleLink } from './stale.ts';
import type { Store } from './store.ts';

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
  /** Unsealed refs with a line range that passed every check and got a seal. */
  sealed: number;
  /** What still needs attention after the repair. */
  stale: StaleLink[];
}

const ATTEMPTS = 3;

/**
 * Re-anchors every `moved` code ref to its suggested range and seals unsealed refs that pass all checks,
 * in one journaled change set. `changed` and other stale refs are left alone and reported.
 */
export async function repairCodeLinks(store: Store, stale: StaleLinks, options: { actor: Actor; scopeId?: string }): Promise<RepairResult> {
  for (let attempt = 1; ; attempt++) {
    const snapshot = store.snapshot();
    const statuses = await stale.inspect(ownedRefs(snapshot.model, options.scopeId));
    // The check is asynchronous; apply only what was checked against the model as it is now.
    if (store.currentRevision !== snapshot.revision) {
      if (attempt < ATTEMPTS) continue;
      throw new Error('The model changed while the code links were being checked. Try again.');
    }
    const moved = statuses.filter((s) => s.reason === 'moved' && s.suggestion);
    const unsealed = statuses.filter((s) => !s.reason && s.ref.startLine && !s.ref.digest);
    const remaining = statuses.filter((s) => s.reason && s.reason !== 'moved').map(staleLink);
    if (!moved.length && !unsealed.length) return { revision: snapshot.revision, repaired: [], sealed: 0, stale: remaining };

    const summary = repairSummary(moved, unsealed.length);
    const result = store.apply(repairChangeSet(snapshot.model, moved, unsealed, summary), options.actor);
    return {
      revision: result.revision,
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
      sealed: unsealed.length,
      stale: remaining,
    };
  }
}

/**
 * One patch per owner: the full code ref list with moved refs relocated (relocated refs are sealed afresh,
 * the others keep their seals), plus `addCodeRefs` for the refs to seal (re-sending a ref re-seals it).
 */
function repairChangeSet(model: Model, moved: RefStatus[], unsealed: RefStatus[], summary: string): ChangeSet {
  const owners = new Map<string, { owned: OwnedRef; refs: CodeRef[]; seal: CodeRef[] }>();
  const entry = (s: RefStatus) => {
    const key = `${s.ownerType}:${s.ownerId}:${s.step ?? ''}`;
    let found = owners.get(key);
    if (!found) owners.set(key, (found = { owned: s, refs: [...refsOf(model, s)], seal: [] }));
    return found;
  };
  for (const s of moved) {
    const owner = entry(s);
    const { digest: _old, ...ref } = owner.refs[s.index]!;
    const single = ref.endLine === undefined && s.suggestion!.startLine === s.suggestion!.endLine;
    owner.refs[s.index] = { ...ref, startLine: s.suggestion!.startLine, ...(single ? {} : { endLine: s.suggestion!.endLine }) };
  }
  for (const s of unsealed) entry(s).seal.push(s.ref);

  const elements: ElementPatch[] = [];
  const relations: RelationPatch[] = [];
  const flows = new Map<string, NonNullable<FlowPatch['updateSteps']>>();
  for (const { owned, refs, seal } of owners.values()) {
    const patch = { codeRefs: refs, ...(seal.length ? { addCodeRefs: seal } : {}) };
    if (owned.ownerType === 'element') elements.push({ id: owned.ownerId, ...patch });
    else if (owned.ownerType === 'relation') relations.push({ id: owned.ownerId, ...patch });
    else flows.set(owned.ownerId, [...(flows.get(owned.ownerId) ?? []), { index: owned.step! - 1, ...patch }]);
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

/** "Re-anchored 11 code links in src/server/routes.ts; sealed 4 code links". */
export function repairSummary(moved: { ref: CodeRef }[], sealed: number): string {
  const parts: string[] = [];
  if (moved.length) {
    const files = [...new Set(moved.map((m) => m.ref.path))];
    parts.push(`re-anchored ${links(moved.length)} in ${files.length === 1 ? files[0] : `${files.length} files`}`);
  }
  if (sealed) parts.push(`sealed ${links(sealed)}`);
  let text = parts.join('; ');
  if (text.length > 200) text = text.replace(/ in .*?(;|$)/, ' in 1 file$1').slice(0, 200);
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function links(n: number): string {
  return `${n} code link${n === 1 ? '' : 's'}`;
}
