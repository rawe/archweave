import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Background, BackgroundVariant, ReactFlow, useNodesInitialized, useReactFlow, type EdgeChange, type OnNodeDrag } from '@xyflow/react';
import { Users } from 'lucide-react';
import type { Element, Position, Relation } from '../../shared/model.ts';
import { Composer } from '../canvas/Composer.tsx';
import { ElementNode, type ElementNodeType } from '../canvas/ElementNode.tsx';
import { ThreadEdge, type ThreadEdgeType } from '../canvas/ThreadEdge.tsx';
import { captureFlow, fitOptions, useZoomClass } from '../canvas/flowUtils.ts';
import { useAutoPlace } from '../canvas/useAutoPlace.ts';
import { useSyncedNodes } from '../canvas/useSyncedNodes.ts';
import { viewports } from '../canvas/StructureCanvas.tsx';
import { Menu, type MenuItem } from '../chrome/primitives.tsx';
import { createElement } from '../state/actions.ts';
import { buildIndex } from '../state/selectors.ts';
import { clearSelection, commit, getState, markSeen, setState, useStore } from '../state/store.ts';
import { registerCanvasTarget } from '../lib/canvasTarget.ts';
import { onCanvasCommand } from '../lib/commands.ts';
import { cx, prefersReducedMotion } from '../lib/dom.ts';
import { freeSpot, layoutAll, type LayoutEdge } from '../lib/layout.ts';
import { Plus, LayoutGrid, Maximize } from 'lucide-react';
import { CARD_W, DataCard, cardHeight, type DataCardType } from './DataCard.tsx';
import { FieldEdge, type FieldEdgeType } from './FieldEdge.tsx';
import { DataRail } from './DataRail.tsx';

const nodeTypes = { card: DataCard, element: ElementNode };
const edgeTypes = { field: FieldEdge, thread: ThreadEdge };
const KEY = 'data';

type AnyNode = DataCardType | ElementNodeType;
type AnyEdge = FieldEdgeType | ThreadEdgeType;

const PRODUCING = new Set(['produces', 'writes', 'publishes']);

export function DataView() {
  const showUsers = useStore((s) => s.showDataUsers);
  const railOpen = useStore((s) => s.dataRailOpen);
  const hasData = useStore((s) => s.model.elements.some((e) => e.kind === 'data'));
  return (
    <div className={cx('data-view', railOpen && 'has-rail')}>
      <DataRail />
      <DataCanvas />
      <div className={cx('canvas-toggle', railOpen && 'with-rail')}>
        {hasData && (
          <button type="button" className={cx('pill', showUsers && 'is-active')} aria-pressed={showUsers} onClick={() => setState((s) => ({ showDataUsers: !s.showDataUsers }))}>
            <Users size={14} strokeWidth={1.7} aria-hidden />
            Show users
          </button>
        )}
      </div>
    </div>
  );
}

function DataCanvas() {
  const model = useStore((s) => s.model);
  const layout = useStore((s) => s.layout);
  const selection = useStore((s) => s.selection);
  const fresh = useStore((s) => s.fresh);
  const unseen = useStore((s) => s.unseen);
  const stale = useStore((s) => s.stale);
  const showUsers = useStore((s) => s.showDataUsers);
  const revealToken = useStore((s) => s.revealToken);
  const rf = useReactFlow<AnyNode, AnyEdge>();
  const wrapper = useRef<HTMLDivElement>(null);
  const zoomClass = useZoomClass(wrapper);
  const reduced = prefersReducedMotion();
  const [composer, setComposer] = useState<{ screen: { x: number; y: number }; flow: { x: number; y: number } } | null>(null);
  const [menu, setMenu] = useState<{ at: { x: number; y: number }; items: (MenuItem | 'sep')[] } | null>(null);
  const pointer = useRef<{ x: number; y: number } | null>(null);

  const index = useMemo(() => buildIndex(model), [model]);
  const cards = index.data;
  const cardIds = useMemo(() => new Set(cards.map((c) => c.id)), [cards]);

  // Threads between structures: field refs and data-to-data relations.
  const links = useMemo(() => {
    const out: { id: string; from: string; to: string; row: number; relation?: Relation; planned: boolean }[] = [];
    for (const c of cards)
      c.fields.forEach((f, row) => {
        if (f.ref && cardIds.has(f.ref) && f.ref !== c.id) out.push({ id: `f:${c.id}:${row}`, from: c.id, to: f.ref, row, planned: c.status === 'planned' });
      });
    for (const r of model.relations)
      if (cardIds.has(r.from) && cardIds.has(r.to) && r.from !== r.to && !out.some((o) => o.from === r.from && o.to === r.to))
        out.push({ id: `r:${r.id}`, from: r.from, to: r.to, row: -1, relation: r, planned: r.status === 'planned' });
    return out;
  }, [cards, cardIds, model.relations]);

  const layoutNodes = useMemo(() => cards.map((c) => ({ id: c.id, width: CARD_W, height: cardHeight(c) })), [cards]);
  const layoutEdges = useMemo<LayoutEdge[]>(() => links.map((l) => ({ from: l.from, to: l.to })), [links]);
  const { positions, placing } = useAutoPlace(KEY, layoutNodes, layoutEdges, layout[KEY]);

  // Who touches which structure.
  const users = useMemo(() => {
    if (!showUsers) return [];
    const byUser = new Map<string, { el: Element; rels: { rel: Relation; data: string; producing: boolean }[] }>();
    const add = (userId: string, rel: Relation, data: string, producing: boolean) => {
      const el = index.byId.get(userId);
      if (!el || el.kind === 'data' || !positions[data]) return;
      const entry = byUser.get(userId) ?? { el, rels: [] };
      const existing = entry.rels.find((r) => r.data === data);
      if (existing) {
        if (producing && !existing.producing) Object.assign(existing, { rel, producing });
      } else entry.rels.push({ rel, data, producing });
      byUser.set(userId, entry);
    };
    for (const r of model.relations) {
      if (cardIds.has(r.to) && !cardIds.has(r.from)) add(r.from, r, r.to, PRODUCING.has(r.kind));
      else if (cardIds.has(r.from) && !cardIds.has(r.to)) add(r.to, r, r.from, false);
      for (const d of r.dataIds)
        if (cardIds.has(d)) {
          add(r.from, r, d, true);
          add(r.to, r, d, false);
        }
    }
    return [...byUser.values()];
  }, [showUsers, model.relations, cardIds, index, positions]);

  const userPositions = useMemo(() => {
    const out: Record<string, Position> = {};
    const occupied = cards.filter((c) => positions[c.id]).map((c) => ({ ...positions[c.id]!, w: CARD_W, h: cardHeight(c) }));
    for (const u of users) {
      const producing = u.rels.filter((r) => r.producing).length >= u.rels.length / 2;
      const rects = u.rels.map((r) => ({ ...positions[r.data]!, h: cardHeight(index.byId.get(r.data)!) }));
      const y = rects.reduce((s, r) => s + r.y + r.h / 2, 0) / rects.length - 20;
      const x = producing ? Math.min(...rects.map((r) => r.x)) - 260 : Math.max(...rects.map((r) => r.x)) + CARD_W + 76;
      const spot = freeSpot({ x, y, w: 184, h: 40 }, occupied);
      occupied.push(spot);
      out[u.el.id] = { x: spot.x, y: spot.y };
    }
    return out;
  }, [users, cards, positions, index]);

  // Focus: the selected structures, what they reference and what references them.
  const selectedIds = selection.elementIds;
  const focus = useMemo(() => {
    const nodes = new Set<string>(selectedIds);
    const edges = new Set<string>();
    for (const l of links)
      if (selectedIds.includes(l.from) || selectedIds.includes(l.to) || (l.relation && selection.relationIds.includes(l.relation.id))) {
        edges.add(l.id);
        nodes.add(l.from);
        nodes.add(l.to);
      }
    for (const u of users)
      for (const r of u.rels)
        if (selectedIds.includes(u.el.id) || selectedIds.includes(r.data)) {
          edges.add(`u:${u.el.id}:${r.rel.id}:${r.data}`);
          nodes.add(u.el.id);
          nodes.add(r.data);
        }
    return { nodes, edges };
  }, [selectedIds, selection.relationIds, links, users]);
  const hasFocus = focus.nodes.size > 0;
  const staleOwners = useMemo(() => new Set(stale.map((s) => s.ownerId)), [stale]);
  const refNames = useMemo(() => Object.fromEntries(cards.map((c) => [c.id, c.name])), [cards]);

  const derivedNodes = useMemo<AnyNode[]>(() => {
    const out: AnyNode[] = [];
    for (const c of cards) {
      const pos = positions[c.id];
      if (!pos) continue;
      const lit = links.filter((l) => focus.edges.has(l.id) && l.from === c.id && l.row >= 0).map((l) => c.fields[l.row]!.name);
      out.push({
        id: c.id,
        type: 'card',
        position: pos,
        selected: selectedIds.includes(c.id),
        data: {
          element: c,
          dim: hasFocus && !focus.nodes.has(c.id),
          related: hasFocus && focus.nodes.has(c.id) && !selectedIds.includes(c.id),
          fresh: fresh[c.id],
          unseen: !!unseen[c.id],
          stale: staleOwners.has(c.id),
          litFields: lit,
          refNames,
          leaving: false,
        },
      });
    }
    for (const u of users) {
      const pos = userPositions[u.el.id];
      if (!pos) continue;
      out.push({
        id: u.el.id,
        type: 'element',
        position: pos,
        draggable: false,
        selected: selectedIds.includes(u.el.id),
        data: {
          element: u.el,
          role: 'neighbor',
          childCount: 0,
          dim: hasFocus && !focus.nodes.has(u.el.id),
          related: false,
          unseen: !!unseen[u.el.id],
          stale: false,
          openNotes: 0,
          dropTarget: false,
          leaving: false,
        },
      });
    }
    return out;
  }, [cards, positions, links, focus, selectedIds, hasFocus, fresh, unseen, staleOwners, refNames, users, userPositions]);

  const onSelectNodes = useCallback((changes: { id: string; selected: boolean }[]) => {
    const sel = getState().selection;
    const ids = new Set(sel.elementIds);
    for (const c of changes) {
      if (c.selected) ids.add(c.id);
      else ids.delete(c.id);
    }
    const elementIds = [...ids];
    if (elementIds.length === sel.elementIds.length && elementIds.every((id) => sel.elementIds.includes(id))) return;
    setState({ selection: { ...sel, elementIds } });
    markSeen(elementIds);
  }, []);
  const [nodes, onNodesChange] = useSyncedNodes(derivedNodes, onSelectNodes);

  const edges = useMemo<AnyEdge[]>(() => {
    const out: AnyEdge[] = links
      .filter((l) => positions[l.from] && positions[l.to])
      .map(
        (l): FieldEdgeType => ({
          id: l.id,
          source: l.from,
          target: l.to,
          type: 'field',
          selectable: !!l.relation,
          selected: !!l.relation && selection.relationIds.includes(l.relation.id),
          zIndex: focus.edges.has(l.id) ? 2 : 0,
          data: { row: l.row, dim: hasFocus && !focus.edges.has(l.id), lit: hasFocus && focus.edges.has(l.id), planned: l.planned, fresh: l.relation ? fresh[l.relation.id] : undefined },
        }),
      );
    for (const u of users)
      for (const r of u.rels) {
        const id = `u:${u.el.id}:${r.rel.id}:${r.data}`;
        const inFocus = focus.edges.has(id);
        out.push({
          id,
          source: r.producing ? u.el.id : r.data,
          target: r.producing ? r.data : u.el.id,
          type: 'thread',
          selectable: false,
          zIndex: inFocus ? 2 : 0,
          className: 'is-user-thread',
          data: {
            relations: [r.rel],
            dim: hasFocus && !inFocus,
            focus: hasFocus && inFocus,
            hover: false,
            planned: r.rel.status === 'planned',
            carries: [],
            showLabel: zoomClass === 'zoom-near',
            shift: 0,
          },
        });
      }
    return out;
  }, [links, positions, selection.relationIds, focus, hasFocus, fresh, users, zoomClass]);

  const onEdgesChange = useCallback(
    (changes: EdgeChange<AnyEdge>[]) => {
      const selects = changes.filter((c) => c.type === 'select');
      if (!selects.length) return;
      const sel = getState().selection;
      const ids = new Set(sel.relationIds);
      for (const c of selects) {
        const rel = links.find((l) => l.id === c.id)?.relation;
        if (!rel) continue;
        if (c.selected) ids.add(rel.id);
        else ids.delete(rel.id);
      }
      const relationIds = [...ids];
      if (relationIds.length === sel.relationIds.length && relationIds.every((id) => sel.relationIds.includes(id))) return;
      setState({ selection: { ...getState().selection, relationIds, edgeKey: undefined } });
    },
    [links],
  );

  // Initial view and reveal on selection from the rail or elsewhere.
  const initialized = useNodesInitialized();
  const framed = useRef(false);
  useEffect(() => {
    if (framed.current || placing || !initialized) return;
    framed.current = true;
    const saved = viewports.get(KEY);
    const sel = getState().selection.elementIds.find((id) => positions[id]);
    if (sel) revealNode(sel, true);
    else if (saved) rf.setViewport(saved);
    else void rf.fitView(fitOptions({ rail: getState().dataRailOpen }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [placing, initialized]);

  // Bring the users into view when they appear, and refit when they go.
  const usersShown = useRef(showUsers);
  useEffect(() => {
    if (usersShown.current === showUsers || !framed.current) return;
    usersShown.current = showUsers;
    const t = setTimeout(() => void rf.fitView(fitOptions({ rail: getState().dataRailOpen, duration: reduced ? 0 : 320 })), 60);
    return () => clearTimeout(t);
  }, [showUsers, rf, reduced]);

  const lastReveal = useRef(revealToken);
  useEffect(() => {
    if (lastReveal.current === revealToken || !framed.current) return;
    lastReveal.current = revealToken;
    const id = getState().selection.elementIds[0];
    if (id) revealNode(id, false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revealToken]);

  function revealNode(id: string, instant: boolean) {
    const node = rf.getInternalNode(id);
    if (!node) return;
    const vp = rf.getViewport();
    const zoom = Math.max(vp.zoom, 0.85);
    const w = node.measured.width ?? CARD_W;
    const h = node.measured.height ?? 120;
    const inspectorShift = window.innerWidth >= 900 ? 180 / zoom : 0;
    const railShift = getState().dataRailOpen ? -110 / zoom : 0;
    void rf.setCenter(node.internals.positionAbsolute.x + w / 2 + inspectorShift + railShift, node.internals.positionAbsolute.y + Math.min(h / 2, 160), {
      zoom,
      duration: instant || reduced ? 0 : 340,
    });
  }

  const tidy = useCallback(async () => {
    const placed = await layoutAll(layoutNodes, layoutEdges);
    await commit({ layout: { [KEY]: placed } });
    setTimeout(() => void rf.fitView(fitOptions({ rail: getState().dataRailOpen, duration: reduced ? 0 : 360 })), 40);
  }, [layoutNodes, layoutEdges, rf, reduced]);

  const openComposer = useCallback(
    (screen?: { x: number; y: number }) => {
      const box = wrapper.current?.getBoundingClientRect();
      if (!box) return;
      const at = screen ?? pointer.current ?? { x: box.left + box.width / 2 - 120, y: box.top + box.height / 2 - 20 };
      setComposer({ screen: { x: at.x - box.left, y: at.y - box.top }, flow: rf.screenToFlowPosition(at) });
    },
    [rf],
  );

  useEffect(
    () =>
      onCanvasCommand((cmd) => {
        if (cmd === 'compose') openComposer();
        else if (cmd === 'tidy') void tidy();
        else if (cmd === 'fit') void rf.fitView(fitOptions({ rail: getState().dataRailOpen, duration: reduced ? 0 : 300 }));
        else if (cmd === 'zoom-in') void rf.zoomIn({ duration: reduced ? 0 : 160 });
        else if (cmd === 'zoom-out') void rf.zoomOut({ duration: reduced ? 0 : 160 });
        else if (cmd === 'zoom-reset') void rf.zoomTo(1, { duration: reduced ? 0 : 200 });
      }),
    [openComposer, tidy, rf, reduced],
  );

  useEffect(() => {
    registerCanvasTarget({ capture: () => captureFlow(rf, wrapper.current) });
    return () => registerCanvasTarget(null);
  }, [rf]);

  const onNodeDragStop: OnNodeDrag<AnyNode> = useCallback((_e, _n, dragged) => {
    const moved = Object.fromEntries(dragged.filter((n) => n.type === 'card').map((n) => [n.id, { x: Math.round(n.position.x), y: Math.round(n.position.y) }]));
    if (Object.keys(moved).length) void commit({ layout: { [KEY]: moved } });
  }, []);

  return (
    <div
      ref={wrapper}
      className={cx('canvas', 'canvas-data', zoomClass, hasFocus && 'has-focus')}
      onPointerMove={(e) => (pointer.current = { x: e.clientX, y: e.clientY })}
    >
      <ReactFlow<AnyNode, AnyEdge>
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onNodeDragStop={onNodeDragStop}
        onPaneClick={() => {
          clearSelection();
          setComposer(null);
        }}
        onDoubleClick={(e) => {
          if ((e.target as HTMLElement).classList.contains('react-flow__pane')) openComposer({ x: e.clientX, y: e.clientY });
        }}
        onPaneContextMenu={(e) => {
          e.preventDefault();
          const at = { x: e.clientX, y: e.clientY };
          setMenu({
            at,
            items: [
              { label: 'New structure here', icon: Plus, keys: 'N', onSelect: () => openComposer(at) },
              { label: 'Tidy layout', icon: LayoutGrid, onSelect: () => void tidy() },
              { label: 'Fit to screen', icon: Maximize, keys: '⇧ 1', onSelect: () => void rf.fitView(fitOptions({ rail: getState().dataRailOpen, duration: reduced ? 0 : 300 })) },
            ],
          });
        }}
        onMoveEnd={(_e, vp) => viewports.set(KEY, vp)}
        nodesConnectable={false}
        zoomOnDoubleClick={false}
        deleteKeyCode={null}
        selectionKeyCode="Shift"
        multiSelectionKeyCode={['Shift', 'Meta', 'Control']}
        selectNodesOnDrag={false}
        elevateNodesOnSelect={false}
        nodeDragThreshold={3}
        minZoom={0.15}
        maxZoom={2.5}
        aria-label="Data structures"
      >
        <Background variant={BackgroundVariant.Dots} gap={22} size={1.2} className="canvas-dots" />
      </ReactFlow>
      {!cards.length && !placing && (
        <div className="canvas-empty-scope">
          <p>No data structures yet.</p>
          <button type="button" className="btn" onClick={() => openComposer()}>
            Add the first structure
          </button>
        </div>
      )}
      {composer && (
        <Composer
          at={composer.screen}
          defaultKind="data"
          kinds={['data']}
          placeholder="Structure name"
          onCancel={() => setComposer(null)}
          onCreate={(name) => {
            setComposer(null);
            void createElement({ name, kind: 'data', position: { x: Math.round(composer.flow.x), y: Math.round(composer.flow.y) }, canvas: KEY });
          }}
        />
      )}
      {menu && <Menu at={menu.at} items={menu.items} onClose={() => setMenu(null)} />}
    </div>
  );
}
