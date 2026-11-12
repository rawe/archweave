/** Connects the store to the server and to the address bar. Called once from main. */
import type { Perspective, UiState } from '../../shared/model.ts';
import { api, subscribe } from '../api.ts';
import { refreshStale } from './codeLinks.ts';
import { dataFocusId, getState, handleFocusRequest, receiveSnapshot, setAgent, setState, useStore, type State } from './store.ts';

export function bootstrap(): () => void {
  const fromHash = parseHash(location.hash);
  if (fromHash) setState(fromHash);

  void api
    .snapshot()
    .then((s) => {
      if (!getState().server || getState().server!.revision <= s.revision) receiveSnapshot(s);
    })
    .catch(() => setState({ connection: 'offline' }));

  void api
    .session()
    .then((session) => {
      setAgent(session.agent);
      setState({ repo: session.repo ?? { name: '' } });
      if (!fromHash && session.ui) {
        const ui = session.ui;
        setState({ perspective: ui.perspective ?? 'structure', scopeId: ui.scopeId, flowId: ui.flowId });
      }
    })
    .catch(() => undefined);

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
    status: (connection) => setState({ connection }),
  });

  // Report what the human sees, debounced.
  let uiTimer: ReturnType<typeof setTimeout> | undefined;
  let lastUi = '';
  const unsubscribeUi = useStore.subscribe((s) => {
    const ui = uiStateOf(s);
    const key = JSON.stringify(ui);
    if (key === lastUi) return;
    lastUi = key;
    clearTimeout(uiTimer);
    uiTimer = setTimeout(() => void api.putUi(ui).catch(() => undefined), 150);
  });

  // Keep perspective, scope and flow in the address bar so Back drills out.
  let lastHash = location.hash;
  const unsubscribeHash = useStore.subscribe((s) => {
    const hash = hashOf(s);
    if (hash === lastHash || !s.loaded) return;
    lastHash = hash;
    history.pushState(null, '', hash);
  });
  const onPop = () => {
    const parsed = parseHash(location.hash);
    lastHash = location.hash;
    if (parsed) setState({ selection: { elementIds: [], relationIds: [] }, stepIndex: null, ...parsed });
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
    selectedElementIds: s.selection.elementIds,
    selectedRelationIds: s.selection.relationIds,
  };
}

function hashOf(s: State): string {
  if (s.perspective === 'structure') return s.scopeId ? `#/structure/${s.scopeId}` : '#/structure';
  if (s.perspective === 'flows') return s.flowId ? `#/flows/${s.flowId}` : '#/flows';
  // The focused structure is part of the address, so Back returns to the previous focus.
  const focus = dataFocusId(s);
  return focus ? `#/data/${focus}` : '#/data';
}

function parseHash(hash: string): Partial<State> | null {
  const [perspective, id] = hash.replace(/^#\/?/, '').split('/') as [string, string | undefined];
  if (!(['structure', 'data', 'flows'] as string[]).includes(perspective)) return null;
  const p = perspective as Perspective;
  return {
    perspective: p,
    scopeId: p === 'structure' && id ? decodeURIComponent(id) : undefined,
    flowId: p === 'flows' && id ? decodeURIComponent(id) : undefined,
    ...(p === 'data' ? { selection: { elementIds: id ? [decodeURIComponent(id)] : [], relationIds: [] } } : {}),
  };
}
