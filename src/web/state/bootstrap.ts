/** Connects the store to the server and to the address bar. Called once from main. */
import type { Perspective, UiState } from '../../shared/model.ts';
import { api, subscribe } from '../api.ts';
import { getState, handleFocusRequest, receiveSnapshot, setAgent, setState, useStore, type State } from './store.ts';

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

  let staleTimer: ReturnType<typeof setTimeout> | undefined;
  const refreshStale = () => {
    clearTimeout(staleTimer);
    staleTimer = setTimeout(() => {
      api.stale().then((stale) => setState({ stale: Array.isArray(stale) ? stale : [] }), () => undefined);
    }, 600);
  };
  refreshStale();

  const unsubscribeEvents = subscribe({
    snapshot: ({ snapshot, entry }) => {
      receiveSnapshot(snapshot, entry);
      if (entry || snapshot.revision !== getState().revision) refreshStale();
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
    if (parsed) setState({ ...parsed, selection: { elementIds: [], relationIds: [] }, stepIndex: null });
  };
  window.addEventListener('popstate', onPop);

  return () => {
    unsubscribeEvents();
    unsubscribeUi();
    unsubscribeHash();
    window.removeEventListener('popstate', onPop);
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
  return '#/data';
}

function parseHash(hash: string): Partial<State> | null {
  const [perspective, id] = hash.replace(/^#\/?/, '').split('/') as [string, string | undefined];
  if (!(['structure', 'data', 'flows'] as string[]).includes(perspective)) return null;
  const p = perspective as Perspective;
  return {
    perspective: p,
    scopeId: p === 'structure' && id ? decodeURIComponent(id) : undefined,
    flowId: p === 'flows' && id ? decodeURIComponent(id) : undefined,
  };
}
