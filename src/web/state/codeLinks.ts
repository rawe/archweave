/** Code links that need attention: keeping the list fresh, and the human's ways to fix them. */
import type { CodeRef, LineRange, Model, StaleLink } from '../../shared/model.ts';
import { api, ApiError } from '../api.ts';
import { sameLink, sameLocation, replaceRef, withRange } from '../lib/codeRefs.ts';
import type { PlainChangeSet } from './apply.ts';
import { lineRange, linesLabel, plural } from '../lib/format.ts';
import { commit, getState, navigateToElement, navigateToRelation, openFlow, setState, toast } from './store.ts';

// Each request and each local fix takes a number; only the answer to the latest request lands,
// so a slow answer can never bring back a link that was just fixed.
let staleSeq = 0;
let staleTimer: ReturnType<typeof setTimeout> | undefined;

/** Asks the server which links need attention, debounced. */
export function refreshStale(delay = 600) {
  clearTimeout(staleTimer);
  staleTimer = setTimeout(() => {
    const mine = ++staleSeq;
    api.stale().then(
      (stale) => mine === staleSeq && setState({ stale: Array.isArray(stale) ? stale : [] }),
      () => undefined,
    );
  }, delay);
}

/** Asks the server right away; resolves to what needs attention (or the last known list when unreachable). */
export async function checkLinks(): Promise<StaleLink[]> {
  clearTimeout(staleTimer);
  const mine = ++staleSeq;
  try {
    const stale = await api.stale();
    const list = Array.isArray(stale) ? stale : [];
    if (mine === staleSeq) setState({ stale: list });
    return list;
  } catch {
    return getState().stale;
  }
}

function setStale(stale: StaleLink[]) {
  staleSeq++;
  setState({ stale });
}

/** Optimistically drops a link the human just fixed; the refresh after the change is the truth. */
function forget(link: StaleLink) {
  setStale(getState().stale.filter((s) => !sameLink(s, link)));
}

/** The owner's name as a reader knows it: element name, "A → B", or "step 2 of Checkout". */
export function ownerName(model: Model, link: Pick<StaleLink, 'ownerType' | 'ownerId' | 'step'>): string {
  if (link.ownerType === 'element') return model.elements.find((e) => e.id === link.ownerId)?.name ?? link.ownerId;
  if (link.ownerType === 'relation') {
    const rel = model.relations.find((r) => r.id === link.ownerId);
    if (!rel) return link.ownerId;
    const name = (id: string) => model.elements.find((e) => e.id === id)?.name ?? id;
    return `${name(rel.from)} → ${name(rel.to)}`;
  }
  const flow = model.flows.find((f) => f.id === link.ownerId);
  return `step ${link.step ?? '?'} of ${flow?.name ?? link.ownerId}`;
}

/** The refs list that holds the link, as currently in the model. */
function refsOf(model: Model, link: StaleLink): CodeRef[] | undefined {
  if (link.ownerType === 'element') return model.elements.find((e) => e.id === link.ownerId)?.codeRefs;
  if (link.ownerType === 'relation') return model.relations.find((r) => r.id === link.ownerId)?.codeRefs;
  return model.flows.find((f) => f.id === link.ownerId)?.steps[(link.step ?? 0) - 1]?.codeRefs;
}

/**
 * The smallest plain change set that gives the link's owner a new refs list (for a flow step, the flow's step list),
 * other refs going back exactly as read, built from the model at `revision` so the server refuses it when anything
 * changed in the meantime.
 */
function withRefs(model: Model, revision: number, link: StaleLink, refs: CodeRef[], summary: string): PlainChangeSet {
  const base = { summary, expectedRevision: revision };
  if (link.ownerType === 'element') return { ...base, elements: [{ id: link.ownerId, codeRefs: refs }] };
  if (link.ownerType === 'relation') return { ...base, relations: [{ id: link.ownerId, codeRefs: refs }] };
  const flow = model.flows.find((f) => f.id === link.ownerId)!;
  return { ...base, flows: [{ id: flow.id, steps: flow.steps.map((s, i) => (i === (link.step ?? 0) - 1 ? { ...s, codeRefs: refs } : s)) }] };
}

const CHANGED_MEANWHILE = 'This code link or its code changed in the meantime. The links are checked again; have another look.';

/** The stored ref the link names, or undefined (with a toast) when it changed in the meantime. */
function storedRef(link: StaleLink): CodeRef | undefined {
  const ref = refsOf(getState().model, link)?.find((r) => sameLocation(r, link.ref));
  if (!ref) {
    toast({ tone: 'info', text: CHANGED_MEANWHILE });
    refreshStale(0);
  }
  return ref;
}

/** Replaces the link's stored ref with `next`; on a conflict or a rejected seal the links are refreshed and the human told. */
function writeLink(link: StaleLink, ref: CodeRef, next: CodeRef, summary: string) {
  const { model, revision } = getState();
  forget(link);
  void commit(withRefs(model, revision, link, replaceRef(refsOf(model, link)!, ref, next), summary), { failure: CHANGED_MEANWHILE }).then((ok) => ok || refreshStale(0));
}

/**
 * Points the link at `range`. A moved link keeps its seal: the server checks that the code at the new range is
 * the sealed text. A changed link's suggestion is a new choice of lines, sealed afresh.
 */
export function reanchorLink(link: StaleLink, range: LineRange) {
  const ref = storedRef(link);
  if (!ref) return;
  const moved = withRange(ref, range);
  const next = link.reason === 'moved' && ref.digest ? { ...moved, digest: ref.digest } : moved;
  writeLink(link, ref, next, `Re-anchored ${ref.path} on ${ownerName(getState().model, link)} to ${linesLabel(range.startLine, range.endLine)}`);
  const code = getState().code;
  if (code?.link && sameLink(code.link, link)) setState({ code: { path: code.path, startLine: range.startLine, endLine: range.endLine, ownerId: code.ownerId } });
}

/** Accepts the edited code as still right: the ref without its digest is sealed afresh at its current text. */
export function keepLink(link: StaleLink) {
  const ref = storedRef(link);
  if (!ref) return;
  const { digest: _seal, ...bare } = ref;
  const where = ref.startLine ? `${ref.path}:${lineRange(ref.startLine, ref.endLine)}` : ref.path;
  writeLink(link, ref, bare, `Confirmed ${where} on ${ownerName(getState().model, link)}`);
  const code = getState().code;
  if (code?.link && sameLink(code.link, link)) setState({ code: { ...code, link: undefined } });
}

let repairing = false;

/** Re-anchors every moved link in one change set, once at a time, then says what happened. */
export async function repairLinks(): Promise<void> {
  if (repairing) return;
  repairing = true;
  try {
    const result = await api.repairLinks();
    setStale(Array.isArray(result.stale) ? result.stale : []);
    const left = result.stale?.length ?? 0;
    const done = result.repaired.length ? `Re-anchored ${plural(result.repaired.length, 'code link')}` : 'No code links were re-anchored';
    toast({ tone: 'info', text: left ? `${done}. ${plural(left, 'link')} still ${left === 1 ? 'needs' : 'need'} a look.` : `${done}.` }, 4500);
  } catch (err) {
    toast({ tone: 'error', text: err instanceof ApiError ? err.message : 'Could not reach the ArchWeave server.' });
    refreshStale(0);
  } finally {
    repairing = false;
  }
}

/** Shows the link's owner where it lives, so its inspector offers the fixes. */
export function showLinkOwner(link: StaleLink) {
  if (link.ownerType === 'element') navigateToElement(link.ownerId);
  else if (link.ownerType === 'relation') navigateToRelation(link.ownerId);
  else openFlow(link.ownerId, (link.step ?? 1) - 1);
}

/** Short, readable reason; for moved links it already says where to. */
export function linkProblem(link: StaleLink): string {
  if (link.reason === 'moved' && link.suggestion) return `Moved to ${linesLabel(link.suggestion.startLine, link.suggestion.endLine)}`;
  if (link.reason === 'changed') return 'Code changed since it was linked';
  return REASON[link.reason] ?? sentence(String(link.reason || 'stale link'));
}

const REASON: Record<string, string> = {
  'missing-file': 'File no longer exists',
  'line-out-of-range': 'Lines are past the end of the file',
  'symbol-not-found': 'Symbol not found in the file',
  'symbol-outside-range': 'Symbol is outside the linked lines',
  moved: 'Code moved within the file',
};

function sentence(reason: string): string {
  const words = reason.replace(/[-_]+/g, ' ').trim();
  return `${words.charAt(0).toUpperCase()}${words.slice(1)}`;
}
