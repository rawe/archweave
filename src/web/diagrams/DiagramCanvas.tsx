import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import {
  applyNodeChanges,
  Background,
  BackgroundVariant,
  ConnectionMode,
  ReactFlow,
  useNodesInitialized,
  useReactFlow,
  ViewportPortal,
  type EdgeChange,
  type NodeChange,
  type NodePositionChange,
  type OnConnectEnd,
  type Viewport,
} from '@xyflow/react';
import { ArrowLeftRight, BringToFront, Copy, LayoutGrid, Link2, Maximize, PenLine, Plus, SendToBack, Trash } from 'lucide-react';
import type { Diagram, ModelLink } from '../../shared/model.ts';
import { layoutShape } from '../../shared/diagram/layout.ts';
import { linkName, shapeLabel } from '../../shared/diagram/links.ts';
import { grownToFit, minSize } from '../../shared/diagram/fit.ts';
import { routeConnectors } from '../../shared/diagram/route.ts';
import { drawingOrder } from '../../shared/diagram/scene.ts';
import { THEMES } from '../../shared/diagram/theme.ts';
import { Menu, type MenuItem } from '../chrome/primitives.tsx';
import { fitOptions, freeArea, useZoomClass } from '../canvas/flowUtils.ts';
import { onCanvasCommand } from '../lib/commands.ts';
import { cx, prefersReducedMotion } from '../lib/dom.ts';
import { MOD } from '../lib/format.ts';
import { useTheme } from '../lib/theme.ts';
import { clearSelection, commit, getState, selectShapes, useStore } from '../state/store.ts';
import {
  beginPlacing,
  connectShapes,
  duplicateSelection,
  flushNudge,
  openLink,
  reconnect,
  removeShapes,
  reorder,
  reverseConnector,
  startEditing,
  tidyDiagram,
} from './actions.ts';
import { ConnectorEdge, type ConnectorEdgeType } from './ConnectorEdge.tsx';
import { RoutesContext, ShapeToolsContext, type Routes, type ShapeTools } from './context.ts';
import { clearOverrides, DRAFT_ID, getEditor, setEditor, setOverride, useEditor } from './editor.ts';
import { descendants, groupAt, outermost, resizeBox, round1, snapMove, type Box, type ResizeHandle } from './geometry.ts';
import { ShapeNode, type ShapeNodeType } from './ShapeNode.tsx';
import { Toolbar } from './Toolbar.tsx';
import { useDiagramKeys } from './useDiagramKeys.ts';

const nodeTypes = { shape: ShapeNode };
const edgeTypes = { connector: ConnectorEdge };
const DRAFT_LINK = '+line';
/** How close, in screen pixels, an edge or centre must come to another's to line up with it. */
const ALIGN_PX = 6;

/** Remembered viewports per diagram, so returning to one shows it as it was left. */
const viewports = new Map<string, Viewport>();

interface Drag {
  ids: Set<string>;
  /** Shapes inside dragged groups, moved along. */
  carried: Set<string>;
  start: Map<string, { x: number; y: number }>;
  last: Map<string, { x: number; y: number }>;
}

export function DiagramCanvas({ diagram }: { diagram: Diagram }) {
  const model = useStore((s) => s.model);
  const selectedIds = useStore((s) => s.selectedShapeIds);
  const fresh = useStore((s) => s.fresh);
  const revealToken = useStore((s) => s.revealToken);
  const railOpen = useStore((s) => s.dataRailOpen);
  const pendingCount = useStore((s) => s.pending.length);
  const themeName = useTheme();
  const theme = THEMES[themeName];
  const editing = useEditor((s) => s.editing);
  const placing = useEditor((s) => s.placing);
  const overrides = useEditor((s) => s.overrides);
  const armed = useEditor((s) => s.armed);
  const dropGroup = useEditor((s) => s.dropGroup);
  const reconnecting = useEditor((s) => s.reconnect);
  const guides = useEditor((s) => s.guides);
  const fitNext = useEditor((s) => s.fitNext);

  const rf = useReactFlow<ShapeNodeType, ConnectorEdgeType>();
  const wrapper = useRef<HTMLDivElement>(null);
  const zoomClass = useZoomClass(wrapper);
  const reduced = prefersReducedMotion();
  const pointer = useRef<{ x: number; y: number } | null>(null);
  const [menu, setMenu] = useState<{ at: { x: number; y: number }; items: (MenuItem | 'sep')[] } | null>(null);
  const diagramRef = useRef(diagram);
  diagramRef.current = diagram;

  useDiagramKeys();

  // ── Nodes ──
  const ordered = useMemo(() => drawingOrder(diagram.shapes), [diagram.shapes]);
  const selected = useMemo(() => new Set(selectedIds), [selectedIds]);
  const derived = useMemo<ShapeNodeType[]>(() => {
    const list = placing ? [...ordered, placing.shape] : ordered;
    const single = selectedIds.length === 1 && !editing;
    return list.map((stored, i) => {
      const own = editing?.target === 'shape' && editing.id === stored.id;
      const label = own ? editing.draft : shapeLabel(model, stored);
      const shape = grownToFit({ ...stored, ...overrides[stored.id] }, label);
      const draft = stored.id === DRAFT_ID;
      return {
        id: stored.id,
        type: 'shape',
        position: { x: shape.x, y: shape.y },
        width: shape.w,
        height: shape.h,
        zIndex: draft ? list.length + 3 : i + 1,
        selected: selected.has(stored.id),
        draggable: !own && !draft,
        selectable: !draft,
        className: cx(shape.kind === 'group' && 'is-group', own && 'is-editing'),
        data: {
          shape,
          label,
          linkName: stored.link ? linkName(model, stored.link) : undefined,
          editing: own,
          resizable: single && selected.has(stored.id),
          dropTarget: dropGroup === stored.id,
          connectTarget: reconnecting?.over === stored.id,
          fresh: fresh[`${diagram.id}/${stored.id}`],
        },
      };
    });
  }, [ordered, placing, editing, model, overrides, selected, selectedIds.length, dropGroup, reconnecting?.over, fresh, diagram.id]);

  const drag = useRef<Drag | null>(null);
  const [nodes, setNodes] = useState<ShapeNodeType[]>(derived);
  useLayoutEffect(() => {
    setNodes((prev) => {
      const byId = new Map(prev.map((n) => [n.id, n]));
      const moving = drag.current;
      return derived.map((d) => {
        const p = byId.get(d.id);
        if (!p) return d;
        const held = !!moving && (moving.ids.has(d.id) || moving.carried.has(d.id));
        return { ...d, measured: p.measured, position: held ? p.position : d.position, dragging: held && p.dragging };
      });
    });
  }, [derived]);
  const nodesRef = useRef(nodes);
  nodesRef.current = nodes;

  // ── Connectors ──
  const edges = useMemo<ConnectorEdgeType[]>(() => {
    const z = ordered.length + 2;
    const list: ConnectorEdgeType[] = diagram.connectors.map((c) => ({
      id: c.id,
      source: c.from,
      target: c.to,
      type: 'connector',
      zIndex: z,
      selected: selected.has(c.id),
      data: { connector: c, fresh: fresh[`${diagram.id}/${c.id}`] },
    }));
    if (placing?.from) {
      const connector = { id: DRAFT_LINK, from: placing.from, to: DRAFT_ID, label: '' };
      list.push({ id: DRAFT_LINK, source: placing.from, target: DRAFT_ID, type: 'connector', zIndex: z, selectable: false, focusable: false, data: { connector, draft: true } });
    }
    return list;
  }, [diagram.connectors, diagram.id, ordered.length, selected, fresh, placing]);

  // One routing pass over the live rectangles, so lines follow while shapes are dragged, resized or typed into.
  const routes = useMemo(() => {
    const rects = nodes.map((n) => ({ id: n.id, kind: n.data.shape.kind, x: n.position.x, y: n.position.y, w: n.data.shape.w, h: n.data.shape.h }));
    const label = editing?.target === 'connector' ? editing : null;
    const connectors = edges.map((e) => (label && e.id === label.id ? { ...e.data!.connector, label: label.draft } : e.data!.connector));
    return routeConnectors(rects, connectors, { direction: diagram.direction });
  }, [nodes, edges, editing, diagram.direction]);

  // ── Selection ──
  const applySelect = useCallback((changes: { id: string; selected: boolean }[]) => {
    if (!changes.length) return;
    const ids = new Set(getState().selectedShapeIds);
    for (const c of changes) {
      if (c.id === DRAFT_ID || c.id === DRAFT_LINK) continue;
      if (c.selected) ids.add(c.id);
      else ids.delete(c.id);
    }
    const next = [...ids];
    const current = getState().selectedShapeIds;
    if (next.length !== current.length || next.some((id) => !current.includes(id))) selectShapes(next);
  }, []);

  const onEdgesChange = useCallback(
    (changes: EdgeChange<ConnectorEdgeType>[]) => applySelect(changes.flatMap((c) => (c.type === 'select' ? [{ id: c.id, selected: c.selected }] : []))),
    [applySelect],
  );

  // ── Moving ──
  const shapeBoxes = () =>
    nodesRef.current.filter((n) => n.id !== DRAFT_ID).map((n) => ({ id: n.id, kind: n.data.shape.kind, parent: n.data.shape.parent, x: n.position.x, y: n.position.y, w: n.data.shape.w, h: n.data.shape.h }));

  const beginDrag = (ids: string[]): Drag => {
    flushNudge();
    const set = new Set(ids);
    const d: Drag = {
      ids: set,
      carried: descendants(diagramRef.current.shapes, set),
      start: new Map(nodesRef.current.map((n) => [n.id, n.position])),
      last: new Map(),
    };
    drag.current = d;
    return d;
  };

  /** Where the dragged shapes would land: the group under each outermost shape's centre. */
  const landing = (d: Drag, at: (id: string) => { x: number; y: number } | undefined) => {
    const boxes = shapeBoxes();
    const exclude = new Set([...d.ids, ...d.carried]);
    const out = new Map<string, string | undefined>();
    for (const id of outermost(diagramRef.current.shapes, d.ids)) {
      const box = boxes.find((b) => b.id === id);
      const p = at(id);
      if (!box || !p) continue;
      out.set(id, groupAt({ x: p.x + box.w / 2, y: p.y + box.h / 2 }, boxes, exclude));
    }
    return out;
  };

  const onNodesChange = useCallback(
    (changes: NodeChange<ShapeNodeType>[]) => {
      const selects: { id: string; selected: boolean }[] = [];
      let rest: NodeChange<ShapeNodeType>[] = [];
      for (const c of changes) {
        if (c.type === 'select') selects.push({ id: c.id, selected: c.selected });
        else if (c.type === 'dimensions') rest.push(c);
        else if (c.type === 'position' && c.dragging && c.position) rest.push(c);
      }
      // Positions are the model's; only a drag in progress moves a node, snapped here.
      const moves = rest.filter((c): c is NodePositionChange => c.type === 'position');
      if (moves.length) {
        const d = drag.current ?? beginDrag(moves.map((m) => m.id));
        const size = new Map(nodesRef.current.map((n) => [n.id, n.data.shape]));
        const xs = moves.map((m) => m.position!.x);
        const ys = moves.map((m) => m.position!.y);
        const box: Box = {
          x: Math.min(...xs),
          y: Math.min(...ys),
          w: Math.max(...moves.map((m) => m.position!.x + (size.get(m.id)?.w ?? 0))) - Math.min(...xs),
          h: Math.max(...moves.map((m) => m.position!.y + (size.get(m.id)?.h ?? 0))) - Math.min(...ys),
        };
        const still = shapeBoxes().filter((b) => !d.ids.has(b.id) && !d.carried.has(b.id));
        const fit = snapMove(box, still, ALIGN_PX / rf.getViewport().zoom);
        const snapped = moves.map((m) => ({ ...m, position: { x: m.position!.x + fit.dx, y: m.position!.y + fit.dy } }));
        const lead = snapped[0]!;
        const from = d.start.get(lead.id) ?? lead.position;
        const dx = lead.position.x - from.x;
        const dy = lead.position.y - from.y;
        const carried = [...d.carried]
          .filter((id) => !d.ids.has(id) && d.start.has(id))
          .map((id): NodePositionChange & { position: { x: number; y: number } } => ({ type: 'position', id, dragging: true, position: { x: d.start.get(id)!.x + dx, y: d.start.get(id)!.y + dy } }));
        for (const m of [...snapped, ...carried]) d.last.set(m.id, m.position);
        rest = [...rest.filter((c) => c.type !== 'position'), ...snapped, ...carried];
        const lands = landing(d, (id) => d.last.get(id));
        const target = [...lands].find(([id, group]) => group && group !== diagramRef.current.shapes.find((s) => s.id === id)?.parent)?.[1] ?? null;
        setEditor({ guides: fit.guides, dropGroup: target });
      }
      if (rest.length) setNodes((nds) => applyNodeChanges(rest, nds));
      applySelect(selects);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rf, applySelect],
  );

  const onNodeDragStop = useCallback(() => {
    const d = drag.current;
    setEditor({ guides: [], dropGroup: null });
    if (!d) return;
    const lands = landing(d, (id) => d.last.get(id));
    drag.current = null;
    const current = diagramRef.current;
    const byId = new Map(current.shapes.map((s) => [s.id, s]));
    const entries = [...d.last]
      .filter(([id]) => byId.has(id))
      .map(([id, p]) => {
        const entry: { id: string; x: number; y: number; parent?: string | null } = { id, x: round1(p.x), y: round1(p.y) };
        if (lands.has(id) && lands.get(id) !== byId.get(id)!.parent) entry.parent = lands.get(id) ?? null;
        return entry;
      })
      .filter((e) => e.parent !== undefined || e.x !== byId.get(e.id)!.x || e.y !== byId.get(e.id)!.y);
    if (entries.length) void commit({ diagrams: [{ id: current.id, setShapes: entries }] });
    else setNodes((nds) => nds.map((n) => ({ ...n, dragging: false })));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Resizing ──
  const startResize = useCallback(
    (id: string, handle: ResizeHandle, event: ReactPointerEvent) => {
      event.preventDefault();
      event.stopPropagation();
      flushNudge();
      const node = nodesRef.current.find((n) => n.id === id);
      if (!node) return;
      const shape = node.data.shape;
      const label = node.data.label;
      const start: Box = { x: shape.x, y: shape.y, w: shape.w, h: shape.h };
      const origin = rf.screenToFlowPosition({ x: event.clientX, y: event.clientY });
      const move = (e: PointerEvent) => {
        const p = rf.screenToFlowPosition({ x: e.clientX, y: e.clientY });
        setOverride(id, resizeBox(start, handle, p.x - origin.x, p.y - origin.y, (w) => minSize({ ...shape, w }, label)));
      };
      const up = () => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        const box = getEditor().overrides[id];
        const stored = diagramRef.current.shapes.find((s) => s.id === id);
        if (box && stored && (box.x !== stored.x || box.y !== stored.y || box.w !== stored.w || box.h !== stored.h)) {
          void commit({ diagrams: [{ id: diagramRef.current.id, setShapes: [{ id, x: round1(box.x!), y: round1(box.y!), w: round1(box.w!), h: round1(box.h!) }] }] });
        }
        clearOverrides([id]);
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
    },
    [rf],
  );

  // ── Reconnecting a line end ──
  const shapeAt = (p: { x: number; y: number }) => {
    const hits = nodesRef.current
      .filter((n) => n.id !== DRAFT_ID && p.x >= n.position.x && p.x <= n.position.x + n.data.shape.w && p.y >= n.position.y && p.y <= n.position.y + n.data.shape.h)
      .sort((a, b) => (b.zIndex ?? 0) - (a.zIndex ?? 0));
    return (hits.find((n) => n.data.shape.kind !== 'group') ?? hits[0])?.id;
  };

  const startReconnect = useCallback(
    (id: string, end: 'from' | 'to', event: ReactPointerEvent) => {
      event.preventDefault();
      event.stopPropagation();
      const move = (e: PointerEvent) => {
        const point = rf.screenToFlowPosition({ x: e.clientX, y: e.clientY });
        setEditor({ reconnect: { id, end, point, over: shapeAt(point) } });
      };
      const up = () => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        const r = getEditor().reconnect;
        setEditor({ reconnect: null });
        if (r?.over) reconnect(id, end, r.over);
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rf],
  );

  const shapeTools = useMemo<ShapeTools>(() => ({ theme, startResize, openLink }), [theme, startResize]);
  const routeContext = useMemo<Routes>(() => ({ theme, routes, startReconnect }), [theme, routes, startReconnect]);

  // ── View ──
  const flowAt = (clientX: number, clientY: number) => rf.screenToFlowPosition({ x: clientX, y: clientY });
  const viewCentre = useCallback(() => {
    const box = wrapper.current?.getBoundingClientRect();
    const free = freeArea(wrapper.current, getState().selectedShapeIds.length > 0, 0, getState().dataRailOpen);
    return rf.screenToFlowPosition({ x: (box?.left ?? 0) + (free.left + free.right) / 2, y: (box?.top ?? 0) + (free.top + free.bottom) / 2 });
  }, [rf]);
  const here = useCallback(() => (pointer.current ? flowAt(pointer.current.x, pointer.current.y) : viewCentre()), [viewCentre]); // eslint-disable-line react-hooks/exhaustive-deps

  const fitTo = useCallback(
    (ids: string[], duration = reduced ? 0 : 300) => {
      const current = diagramRef.current;
      const shapeIds = new Set(current.shapes.filter((s) => ids.includes(s.id)).map((s) => s.id));
      for (const c of current.connectors) if (ids.includes(c.id)) shapeIds.add(c.from).add(c.to);
      const options = { ...fitOptions({ rail: getState().dataRailOpen, duration }), maxZoom: 1.2 };
      void rf.fitView(shapeIds.size ? { ...options, nodes: [...shapeIds].map((id) => ({ id })) } : options);
    },
    [rf, reduced],
  );

  const initialized = useNodesInitialized();
  const opened = useRef(false);
  const lastReveal = useRef(revealToken);
  useEffect(() => {
    if (opened.current || (diagram.shapes.length && !initialized)) return;
    opened.current = true;
    lastReveal.current = revealToken;
    const saved = viewports.get(diagram.id);
    if (getState().selectedShapeIds.length) fitTo(getState().selectedShapeIds, 0);
    else if (saved) void rf.setViewport(saved);
    else if (diagram.shapes.length) fitTo([], 0);
    else {
      const free = freeArea(wrapper.current, false, 0, getState().dataRailOpen);
      void rf.setViewport({ x: (free.left + free.right) / 2, y: (free.top + free.bottom) / 2, zoom: 1 });
    }
  }, [initialized, diagram.shapes.length, diagram.id, rf, fitTo, revealToken]);

  useEffect(() => {
    if (!opened.current || lastReveal.current === revealToken || !initialized) return;
    lastReveal.current = revealToken;
    fitTo(getState().selectedShapeIds);
  }, [revealToken, initialized, fitTo]);

  // A diagram that goes from empty to drawn by someone else, or that a seed or tidy rearranged, is fitted once.
  const lastShapes = useRef(diagram.shapes);
  useEffect(() => {
    const before = lastShapes.current;
    if (before === diagram.shapes || !initialized) return;
    lastShapes.current = diagram.shapes;
    // The human's own changes are pending until the server answers; those never move the view.
    if (!opened.current || pendingCount > 0) return;
    if ((fitNext && before !== diagram.shapes) || (!before.length && diagram.shapes.length)) {
      setEditor({ fitNext: false });
      fitTo([]);
    }
  }, [diagram.shapes, pendingCount, initialized, fitNext, fitTo]);

  useEffect(
    () =>
      onCanvasCommand((cmd) => {
        if (cmd === 'compose') beginPlacing('box', here());
        else if (cmd === 'tidy') void tidyDiagram(diagramRef.current);
        else if (cmd === 'fit') fitTo([]);
        else if (cmd === 'zoom-in') void rf.zoomIn({ duration: reduced ? 0 : 160 });
        else if (cmd === 'zoom-out') void rf.zoomOut({ duration: reduced ? 0 : 160 });
        else if (cmd === 'zoom-reset') void rf.zoomTo(1, { duration: reduced ? 0 : 200 });
        else if (cmd === 'open-selected') {
          const ids = getState().selectedShapeIds;
          if (ids.length === 1) startEditing(ids[0]!);
        }
      }),
    [here, fitTo, rf, reduced],
  );

  // A shape or line that vanished under an open editor (an agent removed it, an undo) ends the edit.
  useEffect(() => {
    if (!editing || editing.id === DRAFT_ID) return;
    if (![...diagram.shapes, ...diagram.connectors].some((s) => s.id === editing.id)) setEditor({ editing: null });
  }, [diagram, editing]);
  useEffect(() => () => setEditor({ editing: null, placing: null, armed: null, guides: [], dropGroup: null }), []);

  // Keys act on the selection: a shape left focused from before a paste, a duplicate or a placement lets go of the focus.
  useEffect(() => {
    const focused = document.activeElement;
    if (focused instanceof HTMLElement && focused.classList.contains('react-flow__node') && !selected.has(focused.dataset.id ?? '')) focused.blur();
  }, [selected]);

  // ── Gestures ──
  const onConnectEnd: OnConnectEnd = useCallback((event, state) => {
    if (state.isValid || state.toNode || !state.fromNode) return;
    const point = 'changedTouches' in event ? event.changedTouches[0] : event;
    if (point) beginPlacing('box', flowAt(point.clientX, point.clientY), state.fromNode.id);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const nodeMenu = (id: string): (MenuItem | 'sep')[] => {
    const shape = diagram.shapes.find((s) => s.id === id);
    const items: (MenuItem | 'sep')[] = [{ label: 'Edit text', icon: PenLine, keys: '↵', onSelect: () => startEditing(id) }];
    if (shape?.link) items.push({ label: `Go to ${linkName(model, shape.link) ?? 'the linked item'}`, icon: Link2, onSelect: () => openLink(shape.link as ModelLink) });
    items.push(
      { label: 'Duplicate', icon: Copy, keys: `${MOD} D`, onSelect: duplicateSelection },
      { label: 'Bring to front', icon: BringToFront, keys: ']', onSelect: () => reorder(true) },
      { label: 'Send to back', icon: SendToBack, keys: '[', onSelect: () => reorder(false) },
      'sep',
      { label: 'Delete', icon: Trash, keys: '⌫', danger: true, onSelect: () => removeShapes(getState().selectedShapeIds) },
    );
    return items;
  };

  const edgeMenu = (id: string): (MenuItem | 'sep')[] => {
    const connector = diagram.connectors.find((c) => c.id === id);
    return [
      { label: 'Edit label', icon: PenLine, keys: '↵', onSelect: () => startEditing(id) },
      ...(connector ? [{ label: 'Reverse', icon: ArrowLeftRight, onSelect: () => reverseConnector(diagram, connector) }] : []),
      'sep',
      { label: 'Delete', icon: Trash, keys: '⌫', danger: true, onSelect: () => removeShapes([id]) },
    ];
  };

  const paneMenu = (at: { x: number; y: number }): (MenuItem | 'sep')[] => [
    { label: 'New box here', icon: Plus, keys: 'N', onSelect: () => beginPlacing('box', flowAt(at.x, at.y)) },
    { label: 'Tidy', icon: LayoutGrid, onSelect: () => void tidyDiagram(diagram) },
    { label: 'Fit to screen', icon: Maximize, keys: '⇧ 1', onSelect: () => fitTo([]) },
  ];

  const reconnectFrom = reconnecting ? routes.get(reconnecting.id) : undefined;
  const fixedEnd = reconnectFrom && reconnecting ? (reconnecting.end === 'from' ? reconnectFrom.points.at(-1) : reconnectFrom.points[0]) : undefined;
  const empty = !diagram.shapes.length && !placing && !fitNext;

  return (
    <div
      ref={wrapper}
      className={cx('canvas', 'canvas-diagram', zoomClass, armed && 'is-armed', reconnecting && 'is-reconnecting')}
      onPointerMove={(e) => (pointer.current = { x: e.clientX, y: e.clientY })}
      onPointerLeave={() => (pointer.current = null)}
    >
      <ShapeToolsContext.Provider value={shapeTools}>
        <RoutesContext.Provider value={routeContext}>
          <ReactFlow<ShapeNodeType, ConnectorEdgeType>
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            edgeTypes={edgeTypes}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={(c) => c.source && c.target && connectShapes(c.source, c.target)}
            onConnectEnd={onConnectEnd}
            connectionMode={ConnectionMode.Loose}
            connectionRadius={28}
            connectionLineStyle={{ stroke: 'var(--human)', strokeWidth: 1.5 }}
            onNodeDragStop={onNodeDragStop}
            onNodeClick={(e) => {
              const kind = getEditor().armed;
              if (kind) beginPlacing(kind, flowAt(e.clientX, e.clientY));
            }}
            onNodeDoubleClick={(e, node) => {
              const p = flowAt(e.clientX, e.clientY);
              const shape = node.data.shape;
              if (shape.kind === 'group' && p.y > shape.y + titleBottom(node.data.shape, node.data.label)) beginPlacing('box', p);
              else startEditing(node.id);
            }}
            onEdgeDoubleClick={(_e, edge) => startEditing(edge.id)}
            onNodeContextMenu={(e, node) => {
              e.preventDefault();
              if (!getState().selectedShapeIds.includes(node.id)) selectShapes([node.id]);
              setMenu({ at: { x: e.clientX, y: e.clientY }, items: nodeMenu(node.id) });
            }}
            onEdgeContextMenu={(e, edge) => {
              e.preventDefault();
              if (edge.data?.draft) return;
              selectShapes([edge.id]);
              setMenu({ at: { x: e.clientX, y: e.clientY }, items: edgeMenu(edge.id) });
            }}
            onPaneContextMenu={(e) => {
              e.preventDefault();
              setMenu({ at: { x: e.clientX, y: e.clientY }, items: paneMenu({ x: e.clientX, y: e.clientY }) });
            }}
            onPaneClick={(e) => {
              const kind = getEditor().armed;
              if (kind) beginPlacing(kind, flowAt(e.clientX, e.clientY));
              else clearSelection();
            }}
            onDoubleClick={(e) => {
              if ((e.target as HTMLElement).classList.contains('react-flow__pane')) beginPlacing('box', flowAt(e.clientX, e.clientY));
            }}
            onMoveEnd={(_e, vp) => viewports.set(diagram.id, vp)}
            zoomOnDoubleClick={false}
            deleteKeyCode={null}
            selectionKeyCode="Shift"
            multiSelectionKeyCode={['Shift', 'Meta', 'Control']}
            selectNodesOnDrag={false}
            elevateNodesOnSelect={false}
            elevateEdgesOnSelect={false}
            nodeDragThreshold={3}
            minZoom={0.15}
            maxZoom={3}
            nodesFocusable
            edgesFocusable
            aria-label={diagram.name}
          >
            <Background variant={BackgroundVariant.Dots} gap={24} size={1.2} className="canvas-dots" />
            <ViewportPortal>
              <svg className="dguides" aria-hidden>
                {guides.map((g, i) =>
                  g.axis === 'x' ? <line key={i} x1={g.at} x2={g.at} y1={g.from - 12} y2={g.to + 12} /> : <line key={i} x1={g.from - 12} x2={g.to + 12} y1={g.at} y2={g.at} />,
                )}
                {fixedEnd && reconnecting && <line className="is-reconnect" x1={fixedEnd.x} y1={fixedEnd.y} x2={reconnecting.point.x} y2={reconnecting.point.y} />}
              </svg>
            </ViewportPortal>
          </ReactFlow>
        </RoutesContext.Provider>
      </ShapeToolsContext.Provider>
      {empty && (
        <div className="canvas-empty-scope diagram-empty">
          <p>Double-click anywhere to place a box and type its name, or pick a shape below.</p>
        </div>
      )}
      <Toolbar diagramId={diagram.id} centre={viewCentre} />
      {menu && <Menu at={menu.at} items={menu.items} onClose={() => setMenu(null)} />}
    </div>
  );
}

/** How far below a group's top its title reaches: double-clicking below it places a shape inside. */
function titleBottom(shape: ShapeNodeType['data']['shape'], label: string): number {
  const lines = layoutShape({ kind: shape.kind, label, detail: shape.detail, size: shape.size, w: shape.w, h: shape.h }).lines;
  const last = lines.at(-1);
  return last ? last.y + 8 : 28;
}
