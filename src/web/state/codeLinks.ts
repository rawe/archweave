/** Code links that need attention: keeping the list fresh, and the human's ways to fix them. */
import type { ChangeSet, CodeRef, LineRange, Model, StaleLink } from '../../shared/model.ts';
import { api, ApiError, type RepairResult } from '../api.ts';
import { confirmAction } from '../chrome/Confirm.tsx';
import { sameLink, sameLocation, replaceRef, withRange } from '../lib/codeRefs.ts';
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

/** A change set that gives the link's owner a new refs list; other refs go back exactly as read. */
function withRefs(model: Model, link: StaleLink, refs: CodeRef[], summary: string): ChangeSet {
  if (link.ownerType === 'element') return { summary, elements: [{ id: link.ownerId, codeRefs: refs }] };
  if (link.ownerType === 'relation') return { summary, relations: [{ id: link.ownerId, codeRefs: refs }] };
  const flow = model.flows.find((f) => f.id === link.ownerId)!;
  return { summary, flows: [{ id: flow.id, steps: flow.steps.map((s, i) => (i === (link.step ?? 0) - 1 ? { ...s, codeRefs: refs } : s)) }] };
}

/** The stored ref the link names, or undefined (with a toast) when it changed in the meantime. */
function storedRef(link: StaleLink): CodeRef | undefined {
  const ref = refsOf(getState().model, link)?.find((r) => sameLocation(r, link.ref));
  if (!ref) {
    toast({ tone: 'info', text: 'This code link changed in the meantime' });
    refreshStale(0);
  }
  return ref;
}

/** Points the link at `range` (a moved link's new place, or a changed link's suggestion). The server seals it afresh. */
export function reanchorLink(link: StaleLink, range: LineRange) {
  const ref = storedRef(link);
  if (!ref) return;
  const { model } = getState();
  const refs = replaceRef(refsOf(model, link)!, ref, withRange(ref, range));
  forget(link);
  const summary = `Re-anchored ${ref.path} on ${ownerName(model, link)} to ${linesLabel(range.startLine, range.endLine)}`;
  void commit(withRefs(model, link, refs, summary)).then((ok) => ok || refreshStale(0));
  const code = getState().code;
  if (code?.link && sameLink(code.link, link)) setState({ code: { path: code.path, startLine: range.startLine, endLine: range.endLine, ownerId: code.ownerId } });
}

/** Accepts the edited code as still right: re-sending the ref in `addCodeRefs` re-seals it at its current text. */
export function keepLink(link: StaleLink) {
  const ref = storedRef(link);
  if (!ref) return;
  const { model } = getState();
  const { digest: _seal, ...bare } = ref;
  const where = ref.startLine ? `${ref.path}:${lineRange(ref.startLine, ref.endLine)}` : ref.path;
  const summary = `Confirmed ${where} on ${ownerName(model, link)}`;
  const cs: ChangeSet =
    link.ownerType === 'element'
      ? { summary, elements: [{ id: link.ownerId, addCodeRefs: [bare] }] }
      : link.ownerType === 'relation'
        ? { summary, relations: [{ id: link.ownerId, addCodeRefs: [bare] }] }
        : { summary, flows: [{ id: link.ownerId, updateSteps: [{ index: (link.step ?? 1) - 1, addCodeRefs: [bare] }] }] };
  forget(link);
  void commit(cs).then((ok) => ok || refreshStale(0));
  const code = getState().code;
  if (code?.link && sameLink(code.link, link)) setState({ code: { ...code, link: undefined } });
}

let repairing = false;

/** Runs the repair endpoint once at a time, keeps the list current and reports errors. */
async function runRepair(opts: { seal?: boolean }, report: (result: RepairResult) => string): Promise<void> {
  if (repairing) return;
  repairing = true;
  try {
    const result = await api.repairLinks(opts);
    setStale(Array.isArray(result.stale) ? result.stale : []);
    const left = result.stale?.length ?? 0;
    const done = report(result);
    toast({ tone: 'info', text: left ? `${done}. ${plural(left, 'link')} still ${left === 1 ? 'needs' : 'need'} a look.` : `${done}.` }, 4500);
  } catch (err) {
    toast({ tone: 'error', text: err instanceof ApiError ? err.message : 'Could not reach the ArchWeave server.' });
    refreshStale(0);
  } finally {
    repairing = false;
  }
}

/** Re-anchors every moved link in one change set, then says what happened. Never seals. */
export function repairLinks(): Promise<void> {
  return runRepair({}, (r) => (r.repaired.length ? `Re-anchored ${plural(r.repaired.length, 'code link')}` : 'No code links had moved'));
}

/**
 * Links with a line range but no seal (written before sealing existed, or while the file was unreadable)
 * that currently pass every check. Moves of these cannot be followed until they are sealed.
 */
export function unsealedLinks(model: Model, stale: StaleLink[]): number {
  const flagged = (ownerType: StaleLink['ownerType'], ownerId: string, ref: CodeRef, step?: number) =>
    stale.some((s) => s.ownerType === ownerType && s.ownerId === ownerId && s.step === step && sameLocation(s.ref, ref));
  const count = (refs: CodeRef[], ownerType: StaleLink['ownerType'], ownerId: string, step?: number) =>
    refs.filter((r) => r.startLine && !r.digest && !flagged(ownerType, ownerId, r, step)).length;
  let n = 0;
  for (const e of model.elements) n += count(e.codeRefs, 'element', e.id);
  for (const r of model.relations) n += count(r.codeRefs, 'relation', r.id);
  for (const f of model.flows) f.steps.forEach((s, i) => (n += count(s.codeRefs, 'flow', f.id, i + 1)));
  return n;
}

/**
 * Seals unsealed links that pass every check, after the human confirms. Sealing records the current
 * lines as correct, which a passing check cannot prove, so it is never done on the side.
 */
export async function sealLinks(): Promise<void> {
  const n = unsealedLinks(getState().model, getState().stale);
  if (!n) {
    toast({ tone: 'info', text: 'Every code link with a line range is sealed' });
    return;
  }
  const ok = await confirmAction({
    title: `Seal ${plural(n, 'unchecked code link')}?`,
    body:
      'Sealing records the lines each link points at now as correct, so ArchWeave can follow them when the code moves and tell you when it changes. ' +
      'These links pass the basic checks, but nothing has confirmed their ranges are right. Look at the ranges first.',
    confirmLabel: `Seal ${plural(n, 'link')}`,
  });
  if (!ok) return;
  await runRepair({ seal: true }, (r) => {
    const parts = [r.sealed ? `Sealed ${plural(r.sealed, 'code link')}` : 'No code links needed a seal'];
    if (r.repaired.length) parts.push(`re-anchored ${plural(r.repaired.length, 'moved link')}`);
    return parts.join(' and ');
  });
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
