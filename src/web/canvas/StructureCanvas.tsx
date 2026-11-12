import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  Background,
  BackgroundVariant,
  ConnectionMode,
  ReactFlow,
  useNodesInitialized,
  useReactFlow,
  useStoreApi,
  type EdgeChange,
  type OnConnect,
  type OnNodeDrag,
  type Viewport,
} from '@xyflow/react';
import { ArrowUpRight, Copy, Crosshair, LayoutGrid, Plus, Trash, Maximize } from 'lucide-react';
import type { Element } from '../../shared/model.ts';
import { focusSet, projectStructure, type ProjectedEdge } from '../../shared/projection.ts';
import { Menu, type MenuItem } from '../chrome/primitives.tsx';
import { canvasKey, connect, createElement, deleteSelection, reparent } from '../state/actions.ts';
import {
  clearSelection,
  commit,
  enterScope,
  getState,
  markSeen,
  navigateToElement,
  setState,
  toast,
  useStore,
} from '../state/store.ts';
import { onCanvasCommand } from '../lib/commands.ts';
import { copyText, cx, prefersReducedMotion } from '../lib/dom.ts';
import { layoutAll, separate, type LayoutEdge, type LayoutNode } from '../lib/layout.ts';
import { STRUCTURE_KINDS } from '../lib/kinds.tsx';
import { registerCanvasTarget } from '../lib/canvasTarget.ts';
import { ElementNode, type ElementNodeData, type ElementNodeType } from './ElementNode.tsx';
import { ThreadEdge, type ThreadEdgeType } from './ThreadEdge.tsx';
import { Composer } from './Composer.tsx';
import { useAutoPlace } from './useAutoPlace.ts';
import { useSyncedNodes } from './useSyncedNodes.ts';
import { captureFlow, fitOptions, freeArea, useZoomClass } from './flowUtils.ts';
import { chipHeight, chipWidth, insideHeight, INSIDE_W } from './nodeSize.ts';
import { assignPorts } from '../lib/ports.ts';
import { useFontsReady } from '../lib/text.ts';
import type { Rect } from '../lib/geometry.ts';

const nodeTypes = { element: ElementNode };
const edgeTypes = { thread: ThreadEdge };

const DWELL_MS = 280;

/** Remembered viewports per canvas, so switching perspectives returns to the same view. */
export const viewports = new Map<string, Viewport>();

type Transition = { kind: 'in'; from: { x: number; y: number; w: number; h: number } } | { kind: 'out'; child: string } | { kind: 'jump' };

export function StructureCanvas() {
  const model = useStore((s) => s.model);
  const layout = useStore((s) => s.layout);
  const scopeId = useStore((s) => s.scopeId);
  const selection = useStore((s) => s.selection);
  const fresh = useStore((s) => s.fresh);
  const unseen = useStore((s) => s.unseen);
  const stale = useStore((s) => s.stale);
  const leaving = useStore((s) => s.leaving);
  const revealToken = useStore((s) => s.revealToken);

  const rf = useReactFlow<ElementNodeType, ThreadEdgeType>();
  const flowStore = useStoreApi();
  const wrapper = useRef<HTMLDivElement>(null);
  const zoomClass = useZoomClass(wrapper);
  const reduced = prefersReducedMotion();
  const key = canvasKey(scopeId);

  const projection = useMemo(() => projectStructure(model, scopeId), [model, scopeId]);
  const scope = projection.scope;

  // ── Placement ──
  // Neighbors sit on the rim: those that mostly call into the scope on the left, the rest on the right.
  const rims = useMemo(() => {
    const out = new Map<string, 'left' | 'right'>();
    for (const n of projection.nodes) {
      if (n.role !== 'neighbor') continue;
      const id = n.element.id;
      const calls = projection.edges.filter((e) => e.from === id).length;
      const called = projection.edges.filter((e) => e.to === id).length;
      out.set(id, calls > called ? 'left' : 'right');
    }
    return out;
  }, [projection]);
  // Real rendered sizes. Nodes waiting for a position render invisibly first, so placement uses them.
  const [measured, setMeasured] = useState<Record<string, { w: number; h: number }>>({});
  const fonts = useFontsReady();
  const layoutNodes = useMemo<LayoutNode[]>(
    () =>
      projection.nodes.map((n) => {
        const neighbor = n.role === 'neighbor';
        const m = measured[`${n.role}:${n.element.id}`];
        // Never smaller than the full node: summaries may be hidden right now (names only, far zoom) but positions must suit both.
        const full = neighbor ? chipHeight(n.element.name) : insideHeight(n.element);
        return {
          id: n.element.id,
          width: m?.w ?? (neighbor ? chipWidth(n.element.name) : INSIDE_W),
          height: Math.max(m?.h ?? 0, full),
          rim: rims.get(n.element.id),
        };
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [projection.nodes, rims, measured, fonts],
  );
  const measuredIds = useMemo(
    () => new Set(projection.nodes.filter((n) => measured[`${n.role}:${n.element.id}`]).map((n) => n.element.id)),
    [projection.nodes, measured],
  );
  const layoutEdges = useMemo<LayoutEdge[]>(() => projection.edges.map((e) => ({ from: e.from, to: e.to })), [projection.edges]);
  const { positions: stored, placing } = useAutoPlace(key, layoutNodes, layoutEdges, layout[key], measuredIds);
  // Shown positions: stored ones, with nodes that grew since they were arranged moved clear of each other.
  const positions = useMemo(
    () => separate(stored, new Map(layoutNodes.map((n) => [n.id, { width: n.width, height: n.height }]))),
    [stored, layoutNodes],
  );

  // ── Focus ──
  const selectedIds = selection.elementIds;
  const selectedEdgeIds = useMemo(
    () => new Set(projection.edges.filter((e) => e.relations.some((r) => selection.relationIds.includes(r.id))).map((e) => e.id)),
    [projection.edges, selection.relationIds],
  );
  const focus = useMemo(() => {
    const f = focusSet(projection, selectedIds);
    for (const e of projection.edges) {
      if (selectedEdgeIds.has(e.id)) {
        f.edges.add(e.id);
        f.nodes.add(e.from);
        f.nodes.add(e.to);
      }
    }
    return f;
  }, [projection, selectedIds, selectedEdgeIds]);
  const hasFocus = selectedIds.some((id) => projection.nodes.some((n) => n.element.id === id)) || selectedEdgeIds.size > 0;

  // ── Interaction state ──
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [hoverEdge, setHoverEdge] = useState<string | null>(null);
  const [composer, setComposer] = useState<{ screen: { x: number; y: number }; flow: { x: number; y: number } } | null>(null);
  const [menu, setMenu] = useState<{ at: { x: number; y: number }; items: (MenuItem | 'sep')[] } | null>(null);
  const [tidying, setTidying] = useState(false);
  const pointer = useRef<{ x: number; y: number } | null>(null);
  const dwell = useRef<{ id: string; since: number } | null>(null);

  const staleOwners = useMemo(() => new Set(stale.filter((s) => s.ownerType === 'element').map((s) => s.ownerId)), [stale]);
  const unseenInside = useMemo(() => {
    const out = new Set<string>();
    const byId = new Map(model.elements.map((e) => [e.id, e]));
    for (const id of Object.keys(unseen)) {
      let parent = byId.get(id)?.parentId;
      const seen = new Set<string>();
      while (parent && !seen.has(parent)) {
        seen.add(parent);
        out.add(parent);
        parent = byId.get(parent)?.parentId;
      }
    }
    return out;
  }, [unseen, model.elements]);

  const openElement = useCallback((id: string) => {
    const node = rf.getInternalNode(id);
    if (node) {
      const vp = rf.getViewport();
      const w = node.measured.width ?? INSIDE_W;
      const h = node.measured.height ?? 60;
      pendingFrom.current = {
        x: node.internals.positionAbsolute.x * vp.zoom + vp.x,
        y: node.internals.positionAbsolute.y * vp.zoom + vp.y,
        w: w * vp.zoom,
        h: h * vp.zoom,
      };
    }
    enterScope(id);
  }, [rf]);

  // Ghosts of nodes the agent just removed, so they can fade instead of vanishing.
  const lastNodes = useRef<ElementNodeType[]>([]);

  const derivedNodes = useMemo<ElementNodeType[]>(() => {
    const out: ElementNodeType[] = [];
    for (const n of projection.nodes) {
      const id = n.element.id;
      const pos = positions[id];
      const data: ElementNodeData = {
        element: n.element,
        role: n.role,
        childCount: n.childCount,
        dim: hasFocus && !focus.nodes.has(id),
        related: hasFocus && focus.nodes.has(id) && !selectedIds.includes(id),
        fresh: fresh[id],
        unseen: !!unseen[id],
        unseenInside: unseenInside.has(id),
        stale: staleOwners.has(id),
        openNotes: n.element.notes.filter((note) => !note.resolved).length,
        dropTarget: dropTarget === id,
        leaving: false,
        onOpen: openElement,
      };
      if (!pos) {
        out.push({ id, type: 'element', position: { x: 0, y: 0 }, data, className: 'is-unplaced', selectable: false, draggable: false, focusable: false });
        continue;
      }
      out.push({
        id,
        type: 'element',
        position: pos,
        data,
        selected: selectedIds.includes(id),
        className: n.role === 'neighbor' ? 'rf-neighbor' : undefined,
        zIndex: n.role === 'neighbor' ? 0 : 1,
      });
    }
    for (const prev of lastNodes.current) {
      if (leaving[prev.id] && !out.some((n) => n.id === prev.id)) {
        out.push({ ...prev, selected: false, draggable: false, selectable: false, data: { ...prev.data, leaving: true, dim: false } });
      }
    }
    return out;
  }, [projection.nodes, positions, hasFocus, focus, selectedIds, fresh, unseen, staleOwners, unseenInside, dropTarget, openElement, leaving]);
  useEffect(() => {
    // Ghosts stay remembered too, so a re-render in the middle of their fade does not drop them.
    lastNodes.current = derivedNodes.filter((n) => !String(n.className ?? '').includes('is-unplaced'));
  }, [derivedNodes]);

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

  useEffect(() => {
    const next: Record<string, { w: number; h: number }> = {};
    let changed = false;
    for (const n of nodes) {
      if (n.data.leaving || !n.measured?.width || !n.measured.height) continue;
      const k = `${n.data.role}:${n.id}`;
      next[k] = { w: n.measured.width, h: n.measured.height };
      const m = measured[k];
      if (!m || Math.abs(m.w - n.measured.width) > 0.5 || Math.abs(m.h - n.measured.height) > 0.5) changed = true;
    }
    if (changed) setMeasured((m) => ({ ...m, ...next }));
  }, [nodes, measured]);

  // Thread attachment points follow the live node rectangles, including during a drag.
  const routes = useMemo(() => {
    const rects = new Map<string, Rect>();
    for (const n of nodes) {
      if (n.data.leaving || !positions[n.id] || !n.measured?.width || !n.measured.height) continue;
      rects.set(n.id, { x: n.position.x, y: n.position.y, width: n.measured.width, height: n.measured.height });
    }
    return assignPorts(rects, projection.edges);
  }, [nodes, projection.edges, positions]);

  const zoomNear = zoomClass === 'zoom-near';
  const edges = useMemo<ThreadEdgeType[]>(() => {
    const byId = new Map(model.elements.map((e) => [e.id, e]));
    return projection.edges
      .filter((e) => positions[e.from] && positions[e.to])
      .map((e: ProjectedEdge) => {
        const carries = [...new Set(e.relations.flatMap((r) => r.dataIds))]
          .map((id) => byId.get(id))
          .filter((d): d is Element => !!d)
          .map((d) => ({ id: d.id, name: d.name }));
        const lastFresh = Math.max(0, ...e.relations.map((r) => fresh[r.id] ?? 0));
        return {
          id: e.id,
          source: e.from,
          target: e.to,
          type: 'thread',
          selected: selectedEdgeIds.has(e.id),
          // Threads never cross over a card, lit or not: a thread drawn across a summary would strike it through.
          zIndex: 0,
          data: {
            relations: e.relations,
            dim: hasFocus && !focus.edges.has(e.id),
            focus: hasFocus && focus.edges.has(e.id),
            hover: hoverEdge === e.id,
            fresh: lastFresh || undefined,
            planned: e.relations.every((r) => r.status === 'planned'),
            carries,
            near: zoomNear,
            route: routes.get(e.id),
            onSelect: selectEdge,
          },
        };
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projection.edges, positions, selectedEdgeIds, focus, hasFocus, hoverEdge, fresh, zoomNear, model.elements, routes]);

  function selectEdge(edgeId: string) {
    const edge = getProjection().edges.find((e) => e.id === edgeId);
    if (!edge) return;
    setState({ selection: { elementIds: [], relationIds: edge.relations.map((r) => r.id), edgeKey: edge.id } });
    markSeen(edge.relations.map((r) => r.id));
  }
  const projectionRef = useRef(projection);
  projectionRef.current = projection;
  const getProjection = () => projectionRef.current;

  const onEdgesChange = useCallback((changes: EdgeChange<ThreadEdgeType>[]) => {
    const selects = changes.filter((c) => c.type === 'select');
    if (!selects.length) return;
    const proj = projectionRef.current;
    const sel = getState().selection;
    const keys = new Set(proj.edges.filter((e) => e.relations.some((r) => sel.relationIds.includes(r.id))).map((e) => e.id));
    for (const c of selects) {
      if (c.selected) keys.add(c.id);
      else keys.delete(c.id);
    }
    const chosen = proj.edges.filter((e) => keys.has(e.id));
    const relationIds = chosen.flatMap((e) => e.relations.map((r) => r.id));
    if (relationIds.length === sel.relationIds.length && relationIds.every((id) => sel.relationIds.includes(id))) return;
    setState({ selection: { ...getState().selection, relationIds, edgeKey: chosen.length === 1 ? chosen[0]!.id : undefined } });
    markSeen(relationIds);
  }, []);

  // ── Viewport transitions ──
  const pendingFrom = useRef<{ x: number; y: number; w: number; h: number } | null>(null);
  const prevScope = useRef<string | undefined>(scopeId);
  const transition = useRef<Transition | null>({ kind: 'jump' });
  const wasEmpty = useRef(!projection.nodes.length);
  const [entering, setEntering] = useState(false);
  useLayoutEffect(() => {
    const prev = prevScope.current;
    if (prev === scopeId) return;
    prevScope.current = scopeId;
    const byId = new Map(model.elements.map((e) => [e.id, e]));
    const newScope = scopeId ? byId.get(scopeId) : undefined;
    if (newScope && newScope.parentId === prev && pendingFrom.current) {
      transition.current = { kind: 'in', from: pendingFrom.current };
    } else if (prev) {
      // Moving up: find the child of the new scope that contains the old one.
      let child: string | undefined = prev;
      while (child && byId.get(child)?.parentId !== scopeId) child = byId.get(child)?.parentId;
      transition.current = child ? { kind: 'out', child } : { kind: 'jump' };
    } else transition.current = { kind: 'jump' };
    pendingFrom.current = null;
    wasEmpty.current = false;
    setDropTarget(null);
    setComposer(null);
  }, [scopeId, model.elements]);

  const initialized = useNodesInitialized();
  // A canvas that goes from empty to having nodes (an agent filled it) is fitted once, after placement.
  useEffect(() => {
    if (!projection.nodes.length) {
      wasEmpty.current = true;
      return;
    }
    if (!wasEmpty.current || placing || !initialized) return;
    if (nodes.filter((n) => !n.data.leaving).length !== projection.nodes.length) return;
    wasEmpty.current = false;
    const pending = transition.current;
    transition.current = null;
    void rf.fitView(fitOptions({ duration: pending || reduced ? 0 : 300 }));
  }, [placing, initialized, nodes, projection.nodes.length, rf, reduced]);

  useEffect(() => {
    const t = transition.current;
    if (!t || placing || !initialized) return;
    const visible = nodes.filter((n) => !n.data.leaving);
    if (visible.length !== projection.nodes.length) return;
    transition.current = null;
    const duration = reduced ? 0 : 420;
    if (!visible.length) {
      rf.setViewport({ x: (wrapper.current?.clientWidth ?? 800) / 2, y: (wrapper.current?.clientHeight ?? 600) / 2, zoom: 1 });
      return;
    }
    const bounds = rf.getNodesBounds(visible);
    const width = wrapper.current?.clientWidth ?? window.innerWidth;
    const height = wrapper.current?.clientHeight ?? window.innerHeight;
    if (t.kind === 'in' && duration) {
      const zoom = Math.min(t.from.w / bounds.width, t.from.h / bounds.height);
      const x = t.from.x + t.from.w / 2 - (bounds.x + bounds.width / 2) * zoom;
      const y = t.from.y + t.from.h / 2 - (bounds.y + bounds.height / 2) * zoom;
      rf.setViewport({ x, y, zoom });
      setEntering(true);
      requestAnimationFrame(() => {
        void rf.fitView(fitOptions({ duration }));
        setTimeout(() => setEntering(false), 30);
      });
    } else if (t.kind === 'out' && duration && rf.getInternalNode(t.child)) {
      const node = rf.getInternalNode(t.child)!;
      const w = node.measured.width ?? INSIDE_W;
      const h = node.measured.height ?? 60;
      const zoom = Math.min(width / w, height / h) * 0.9;
      rf.setViewport({
        x: width / 2 - (node.internals.positionAbsolute.x + w / 2) * zoom,
        y: height / 2 - (node.internals.positionAbsolute.y + h / 2) * zoom,
        zoom,
      });
      requestAnimationFrame(() => void rf.fitView(fitOptions({ duration })));
    } else {
      const saved = viewports.get(key);
      if (saved && t.kind === 'jump') rf.setViewport(saved);
      else void rf.fitView(fitOptions({ duration: 0 }));
    }
  }, [placing, initialized, nodes, projection.nodes.length, rf, reduced, key]);

  // Bring a revealed selection into view.
  const lastReveal = useRef(revealToken);
  useEffect(() => {
    if (lastReveal.current === revealToken || transition.current || placing) return;
    const ids = getState().selection.elementIds;
    const relIds = getState().selection.relationIds;
    let target = ids.map((id) => rf.getInternalNode(id)).find(Boolean);
    if (!target && relIds.length) {
      const edge = projection.edges.find((e) => e.relations.some((r) => relIds.includes(r.id)));
      if (edge) target = rf.getInternalNode(edge.from);
    }
    if (!target) return;
    lastReveal.current = revealToken;
    const vp = rf.getViewport();
    const w = target.measured.width ?? INSIDE_W;
    const h = target.measured.height ?? 60;
    const cx = target.internals.positionAbsolute.x + w / 2;
    const cy = target.internals.positionAbsolute.y + h / 2;
    const sx = cx * vp.zoom + vp.x;
    const sy = cy * vp.zoom + vp.y;
    const free = freeArea(wrapper.current, true);
    if (sx < free.left + 24 || sy < free.top + 24 || sx > free.right - 24 || sy > free.bottom - 24) {
      const zoom = Math.max(vp.zoom, 0.8);
      const fx = (free.left + free.right) / 2;
      const fy = (free.top + free.bottom) / 2;
      void rf.setViewport({ x: fx - cx * zoom, y: fy - cy * zoom, zoom }, { duration: reduced ? 0 : 320 });
    }
  }, [revealToken, nodes, placing, rf, reduced, projection.edges]);

  // Keep the focused set clear of the inspector: pan just enough when the selection changes.
  const selectionKey = `${selectedIds.join(',')}|${selection.relationIds.join(',')}`;
  const lastSelectionKey = useRef(selectionKey);
  useEffect(() => {
    if (lastSelectionKey.current === selectionKey) return;
    lastSelectionKey.current = selectionKey;
    if (!hasFocus || transition.current || placing) return;
    const frame = requestAnimationFrame(() => {
      const box = (ids: Iterable<string>) => {
        let l = Infinity, t = Infinity, r = -Infinity, b = -Infinity;
        for (const id of ids) {
          const n = rf.getInternalNode(id);
          if (!n?.measured.width) continue;
          l = Math.min(l, n.internals.positionAbsolute.x);
          t = Math.min(t, n.internals.positionAbsolute.y);
          r = Math.max(r, n.internals.positionAbsolute.x + (n.measured.width ?? 0));
          b = Math.max(b, n.internals.positionAbsolute.y + (n.measured.height ?? 0));
        }
        return l === Infinity ? null : { l, t, r, b };
      };
      const all = box(focus.nodes);
      const core = box(selectedIds.length ? selectedIds : focus.nodes);
      if (!all || !core) return;
      const vp = rf.getViewport();
      const free = freeArea(wrapper.current, true, 20);
      const toScreen = (bx: { l: number; t: number; r: number; b: number }) => ({
        l: bx.l * vp.zoom + vp.x,
        t: bx.t * vp.zoom + vp.y,
        r: bx.r * vp.zoom + vp.x,
        b: bx.b * vp.zoom + vp.y,
      });
      const a = toScreen(all);
      const c = toScreen(core);
      const dx = nudge(a.l, a.r, c.l, c.r, free.left, free.right);
      const dy = nudge(a.t, a.b, c.t, c.b, free.top, free.bottom);
      if (Math.abs(dx) < 1 && Math.abs(dy) < 1) return;
      void rf.setViewport({ x: vp.x + dx, y: vp.y + dy, zoom: vp.zoom }, { duration: reduced ? 0 : 260 });
    });
    return () => cancelAnimationFrame(frame);
  }, [selectionKey, hasFocus, focus, selectedIds, placing, rf, reduced]);

  // ── Commands ──
  const tidy = useCallback(async () => {
    const placed = await layoutAll(layoutNodes, layoutEdges);
    if (!reduced) {
      setTidying(true);
      setTimeout(() => setTidying(false), 460);
    }
    await commit({ layout: { [key]: placed } });
    setTimeout(() => void rf.fitView(fitOptions({ duration: reduced ? 0 : 360 })), reduced ? 0 : 40);
  }, [layoutNodes, layoutEdges, key, rf, reduced]);

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
        else if (cmd === 'fit') void rf.fitView(fitOptions({ duration: reduced ? 0 : 300 }));
        else if (cmd === 'zoom-in') void rf.zoomIn({ duration: reduced ? 0 : 160 });
        else if (cmd === 'zoom-out') void rf.zoomOut({ duration: reduced ? 0 : 160 });
        else if (cmd === 'zoom-reset') void rf.zoomTo(1, { duration: reduced ? 0 : 200 });
        else if (cmd === 'open-selected') {
          const ids = getState().selection.elementIds;
          if (ids.length === 1) {
            const node = projection.nodes.find((n) => n.element.id === ids[0]);
            if (node?.role === 'inside') openElement(node.element.id);
            else if (node) navigateToElement(node.element.id);
          }
        }
      }),
    [openComposer, tidy, rf, reduced, projection.nodes, openElement],
  );

  useEffect(() => {
    registerCanvasTarget({ capture: () => captureFlow(rf, wrapper.current) });
    return () => registerCanvasTarget(null);
  }, [rf]);

  // ── Gestures ──
  const onConnect: OnConnect = useCallback((c) => {
    if (c.source && c.target) connect(c.source, c.target);
  }, []);

  const onNodeDrag: OnNodeDrag<ElementNodeType> = useCallback(
    (event, _node, dragged) => {
      const point = 'touches' in event ? event.touches[0] : event;
      if (!point) return;
      const p = rf.screenToFlowPosition({ x: point.clientX, y: point.clientY });
      const draggedIds = new Set(dragged.map((n) => n.id));
      if (dragged.some((n) => n.data.role === 'neighbor')) return setDropTarget(null);
      const hit = rf
        .getNodes()
        .find((n) => {
          if (draggedIds.has(n.id) || n.data.leaving) return false;
          const internal = rf.getInternalNode(n.id);
          if (!internal) return false;
          const { x, y } = internal.internals.positionAbsolute;
          const w = internal.measured.width ?? 0;
          const h = internal.measured.height ?? 0;
          return p.x >= x && p.x <= x + w && p.y >= y && p.y <= y + h;
        });
      if (!hit) {
        dwell.current = null;
        return setDropTarget(null);
      }
      if (dwell.current?.id !== hit.id) dwell.current = { id: hit.id, since: performance.now() };
      if (performance.now() - dwell.current.since >= DWELL_MS) setDropTarget(hit.id);
    },
    [rf],
  );

  const onNodeDragStop: OnNodeDrag<ElementNodeType> = useCallback(
    (_e, _node, dragged) => {
      dwell.current = null;
      const target = dropTarget;
      setDropTarget(null);
      if (target) {
        reparent(
          dragged.map((n) => n.id),
          target,
          key,
        );
        return;
      }
      const moved = Object.fromEntries(dragged.map((n) => [n.id, { x: Math.round(n.position.x), y: Math.round(n.position.y) }]));
      void commit({ layout: { [key]: moved } });
    },
    [dropTarget, key],
  );

  const paneMenu = (at: { x: number; y: number }): (MenuItem | 'sep')[] => [
    { label: 'New element here', icon: Plus, keys: 'N', onSelect: () => openComposer(at) },
    { label: 'Tidy layout', icon: LayoutGrid, onSelect: () => void tidy() },
    { label: 'Fit to screen', icon: Maximize, keys: '⇧ 1', onSelect: () => void rf.fitView(fitOptions({ duration: reduced ? 0 : 300 })) },
  ];

  const nodeMenu = (node: ElementNodeType): (MenuItem | 'sep')[] => {
    const el = node.data.element;
    const items: (MenuItem | 'sep')[] = [];
    if (node.data.role === 'inside') items.push({ label: 'Open', icon: ArrowUpRight, keys: '↵', onSelect: () => openElement(el.id) });
    else items.push({ label: 'Show where it lives', icon: Crosshair, onSelect: () => navigateToElement(el.id) });
    items.push(
      { label: 'Copy id', icon: Copy, onSelect: () => void copyText(el.id).then(() => toast({ tone: 'info', text: `Copied ${el.id}` })) },
      'sep',
      { label: 'Delete', icon: Trash, keys: '⌫', danger: true, onSelect: () => void deleteSelection() },
    );
    return items;
  };

  const empty = !projection.nodes.length && !placing;

  return (
    <div
      ref={wrapper}
      className={cx('canvas', 'canvas-structure', zoomClass, hasFocus && 'has-focus', tidying && 'is-tidying', entering && 'is-entering')}
      onPointerMove={(e) => (pointer.current = { x: e.clientX, y: e.clientY })}
      onPointerLeave={() => (pointer.current = null)}
    >
      <ReactFlow<ElementNodeType, ThreadEdgeType>
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        connectionMode={ConnectionMode.Loose}
        connectionRadius={36}
        connectionLineStyle={{ stroke: 'var(--human)', strokeWidth: 1.5 }}
        onNodeDoubleClick={(_e, node) => (node.data.role === 'inside' ? openElement(node.id) : navigateToElement(node.id))}
        onNodeDrag={onNodeDrag}
        onNodeDragStop={onNodeDragStop}
        onNodeContextMenu={(e, node) => {
          e.preventDefault();
          if (!getState().selection.elementIds.includes(node.id)) setState({ selection: { elementIds: [node.id], relationIds: [] } });
          setMenu({ at: { x: e.clientX, y: e.clientY }, items: nodeMenu(node) });
        }}
        onPaneContextMenu={(e) => {
          e.preventDefault();
          setMenu({ at: { x: e.clientX, y: e.clientY }, items: paneMenu({ x: e.clientX, y: e.clientY }) });
        }}
        onPaneClick={() => {
          clearSelection();
          setComposer(null);
        }}
        onDoubleClick={(e) => {
          if ((e.target as HTMLElement).classList.contains('react-flow__pane')) openComposer({ x: e.clientX, y: e.clientY });
        }}
        onEdgeMouseEnter={(_e, edge) => setHoverEdge(edge.id)}
        onEdgeMouseLeave={() => setHoverEdge(null)}
        onMoveEnd={(_e, vp) => viewports.set(key, vp)}
        zoomOnDoubleClick={false}
        deleteKeyCode={null}
        selectionKeyCode="Shift"
        multiSelectionKeyCode={['Shift', 'Meta', 'Control']}
        selectNodesOnDrag={false}
        elevateNodesOnSelect={false}
        nodeDragThreshold={3}
        minZoom={0.15}
        maxZoom={2.5}
        proOptions={{ hideAttribution: false }}
        nodesFocusable
        edgesFocusable
        disableKeyboardA11y={false}
        aria-label={scope ? `Inside ${scope.name}` : 'Architecture'}
      >
        <Background variant={BackgroundVariant.Dots} gap={22} size={1.2} className="canvas-dots" />
      </ReactFlow>
      {empty && scope && (
        <div className="canvas-empty-scope">
          <p>Nothing inside {scope.name} yet.</p>
          <button type="button" className="btn" onClick={() => openComposer()}>
            Add the first part
          </button>
        </div>
      )}
      {composer && (
        <Composer
          at={composer.screen}
          defaultKind={scopeId ? 'component' : 'service'}
          kinds={STRUCTURE_KINDS}
          onCancel={() => setComposer(null)}
          onCreate={(name, kind) => {
            setComposer(null);
            void createElement({ name, kind, parentId: scopeId, position: { x: Math.round(composer.flow.x), y: Math.round(composer.flow.y) }, canvas: key });
          }}
        />
      )}
      {menu && <Menu at={menu.at} items={menu.items} onClose={() => setMenu(null)} />}
    </div>
  );
}

/**
 * The smallest shift along one axis that brings [lo, hi] into [min, max]. When
 * the whole range cannot fit, the core range (the selection itself) decides.
 */
function nudge(lo: number, hi: number, coreLo: number, coreHi: number, min: number, max: number): number {
  const fit = (a: number, b: number) => (a < min ? Math.min(min - a, max - b) : b > max ? Math.max(max - b, min - a) : 0);
  if (hi - lo <= max - min) return fit(lo, hi);
  return fit(coreLo, coreHi);
}
