/** Connects the store to the server and to the address bar. Called once from main. */
import type { Perspective, UiState } from '../../shared/model.ts';
import { api, subscribe } from '../api.ts';
import { refreshStale } from './codeLinks.ts';
import { NavHistory, restorable, type NavSelection } from './navHistory.ts';
import { dataFocusId, getState, handleFocusRequest, receiveSnapshot, setAgent, setState, useStore, type State } from './store.ts';

export function bootstrap(): () => void {
  const fromHash = parseHash(location.hash);
  if (fromHash) setState(fromHash);
  const nav = new NavHistory(history, location.hash);
  // A reload keeps the selection of the entry; the first snapshot drops what no longer exists.
  const saved = nav.restored;
  if (saved)
    setState({
      selection: { elementIds: saved.elementIds, relationIds: saved.relationIds, ...(saved.edgeKey ? { edgeKey: saved.edgeKey } : {}) },
      selectedShapeIds: saved.shapeIds,
      stepIndex: saved.step ?? null,
    });
  const syncNav = () => {
    const { navIndex, navMax } = getState();
    if (navIndex !== nav.index || navMax !== nav.max) setState({ navIndex: nav.index, navMax: nav.max });
  };
  syncNav();

  void api
    .snapshot()
    .then((s) => {
      if (!getState().server || getState().server!.revision <= s.revision) receiveSnapshot(s);
    })
    .catch(() => setState({ connection: 'offline' }));

  // Report what the human sees: debounced on change, at once whenever the event stream (re)connects,
  // so a restarted server knows the view without waiting for a click. The first report waits for the
  // session, which may restore the last view.
  let uiTimer: ReturnType<typeof setTimeout> | undefined;
  let lastUi = '';
  let sessionSettled = false;
  const reportUi = () => {
    clearTimeout(uiTimer);
    const ui = uiStateOf(getState());
    lastUi = JSON.stringify(ui);
    void api.putUi(ui).catch(() => undefined);
  };

  void api
    .session()
    .then((session) => {
      setAgent(session.agent);
      setState({ repo: session.repo ?? { name: '' } });
      if (!fromHash && session.ui) {
        const ui = session.ui;
        setState({ perspective: ui.perspective ?? 'structure', scopeId: ui.scopeId, flowId: ui.flowId, diagramId: ui.diagramId });
      }
    })
    .catch(() => undefined)
    .finally(() => {
      sessionSettled = true;
      reportUi();
    });

  void api
    .journal(0)
    .then((entries) => {
      const known = getState().journal;
      const merged = [...entries, ...known.filter((k) => !entries.some((e) => e.revision === k.revision && e.at === k.at))];
      merged.sort((a, b) => a.revision - b.revision);
      setState({ journal: merged, agentEverSeen: getState().agentEverSeen || merged.some((e) => e.actor === 'agent') });
    })
    .catch(() => undefined);

  refreshStale();
  // Code changes in the editor, not here: look again whenever the human comes back to the page.
  const onReturn = () => document.visibilityState === 'visible' && refreshStale(150);
  window.addEventListener('focus', onReturn);
  document.addEventListener('visibilitychange', onReturn);

  const unsubscribeEvents = subscribe({
    snapshot: ({ snapshot, entry }) => {
      const previous = getState().server?.revision;
      receiveSnapshot(snapshot, entry);
      // A disk reload bumps the revision without a journal entry; links may have changed with it.
      if (entry || snapshot.revision !== previous) refreshStale();
      if (entry?.actor === 'agent') setState((s) => ({ agentEverSeen: true, agent: { ...s.agent, connected: true } }));
    },
    agent: setAgent,
    focus: handleFocusRequest,
    status: (connection) => {
      setState({ connection });
      if (connection === 'live' && sessionSettled) reportUi();
    },
  });

  const unsubscribeUi = useStore.subscribe((s) => {
    const ui = uiStateOf(s);
    const key = JSON.stringify(ui);
    if (key === lastUi) return;
    lastUi = key;
    clearTimeout(uiTimer);
    uiTimer = setTimeout(() => void api.putUi(ui).catch(() => undefined), 150);
  });

  // Keep the view in the address bar and the selection in the history entry, so Back returns to both.
  // A new view or a deliberate jump is a new entry; a selection change within the view rewrites the current one.
  let lastHash = location.hash;
  let lastJump = getState().navToken;
  const unsubscribeHash = useStore.subscribe((s) => {
    if (!s.loaded) return;
    const hash = hashOf(s);
    const jump = s.navToken !== lastJump;
    lastJump = s.navToken;
    if (hash !== lastHash && (!parseHash(lastHash) || (!jump && opensFirst(lastHash, hash)))) {
      // The page was opened without a view in its address, or Flows or Diagrams opened their first item by
      // themselves: that view takes over the entry, so Back does not land on a view that moves on again.
      lastHash = hash;
      nav.replace(navSelection(s), hash);
    } else if (hash !== lastHash || jump) {
      lastHash = hash;
      nav.push(hash, navSelection(s));
      syncNav();
    } else nav.replace(navSelection(s));
  });
  const onPop = (event: PopStateEvent) => {
    const entry = nav.pop(event.state, location.hash);
    const parsed = parseHash(location.hash);
    if (!parsed) return syncNav();
    const s = getState();
    const view = { ...s, ...parsed } as State;
    const kept = entry ? restorable(entry, s.model, view) : undefined;
    const patch: Partial<State> = {
      selection: { elementIds: [], relationIds: [] },
      selectedShapeIds: [],
      stepIndex: null,
      ...parsed,
      ...(kept
        ? {
            selection: { elementIds: kept.elementIds, relationIds: kept.relationIds, ...(kept.edgeKey ? { edgeKey: kept.edgeKey } : {}) },
            selectedShapeIds: kept.shapeIds,
            stepIndex: kept.stepIndex,
          }
        : {}),
      navIndex: nav.index,
      navMax: nav.max,
    };
    // What this sets is the entry just shown: it must not count as a new view.
    lastHash = hashOf({ ...s, ...patch } as State);
    setState(patch);
  };
  window.addEventListener('popstate', onPop);

  return () => {
    unsubscribeEvents();
    unsubscribeUi();
    unsubscribeHash();
    window.removeEventListener('popstate', onPop);
    window.removeEventListener('focus', onReturn);
    document.removeEventListener('visibilitychange', onReturn);
  };
}

function uiStateOf(s: State): UiState {
  return {
    perspective: s.perspective,
    scopeId: s.perspective === 'structure' ? s.scopeId : undefined,
    flowId: s.perspective === 'flows' ? s.flowId : undefined,
    diagramId: s.perspective === 'diagrams' ? s.diagramId : undefined,
    selectedElementIds: s.selection.elementIds,
    selectedRelationIds: s.selection.relationIds,
    selectedShapeIds: s.perspective === 'diagrams' ? s.selectedShapeIds : [],
  };
}

/** `to` is `from`, an empty Flows or Diagrams view, with the item that view opens on its own. */
function opensFirst(from: string, to: string): boolean {
  return /^#\/(flows|diagrams)$/.test(from) && to.startsWith(`${from}/`);
}

function navSelection(s: State): NavSelection {
  return {
    elementIds: s.selection.elementIds,
    relationIds: s.selection.relationIds,
    shapeIds: s.selectedShapeIds,
    ...(s.selection.edgeKey ? { edgeKey: s.selection.edgeKey } : {}),
    ...(s.stepIndex !== null ? { step: s.stepIndex } : {}),
  };
}

function hashOf(s: State): string {
  if (s.perspective === 'structure') return s.scopeId ? `#/structure/${s.scopeId}` : '#/structure';
  if (s.perspective === 'flows') return s.flowId ? `#/flows/${s.flowId}` : '#/flows';
  if (s.perspective === 'diagrams') return s.diagramId ? `#/diagrams/${s.diagramId}` : '#/diagrams';
  // The focused structure is part of the address, so Back returns to the previous focus.
  const focus = dataFocusId(s);
  return focus ? `#/data/${focus}` : '#/data';
}

function parseHash(hash: string): Partial<State> | null {
  const [perspective, id] = hash.replace(/^#\/?/, '').split('/') as [string, string | undefined];
  if (!(['structure', 'data', 'flows', 'diagrams'] as string[]).includes(perspective)) return null;
  const p = perspective as Perspective;
  return {
    perspective: p,
    scopeId: p === 'structure' && id ? decodeURIComponent(id) : undefined,
    flowId: p === 'flows' && id ? decodeURIComponent(id) : undefined,
    ...(p === 'diagrams' ? { diagramId: id ? decodeURIComponent(id) : undefined } : {}),
    ...(p === 'data' ? { selection: { elementIds: id ? [decodeURIComponent(id)] : [], relationIds: [] } } : {}),
  };
}
