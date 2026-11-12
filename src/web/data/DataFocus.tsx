import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Background, BackgroundVariant, ReactFlow, useReactFlow } from '@xyflow/react';
import { captureFlow, freeArea, useZoomClass } from '../canvas/flowUtils.ts';
import { registerCanvasTarget } from '../lib/canvasTarget.ts';
import { onCanvasCommand } from '../lib/commands.ts';
import { cx, prefersReducedMotion } from '../lib/dom.ts';
import { markSeen, navigateToElement, select, useStore } from '../state/store.ts';
import { DataCard, ThreadsNode, UsersNode, type DataCardType, type FocusHover, type ThreadsNodeType, type UsersNodeType } from './DataCard.tsx';
import { layoutFocus } from './focusLayout.ts';
import { useFontsReady } from '../lib/text.ts';

const nodeTypes = { card: DataCard, threads: ThreadsNode, users: UsersNode };
type AnyNode = DataCardType | ThreadsNodeType | UsersNodeType;

const MOVE_MS = 300;

/**
 * One structure in the middle with every field, what it references on the
 * right, what references it on the left and who touches it below. Laid out
 * from the model each time; clicking a neighbor moves the focus to it.
 */
export function DataFocus({ focusId }: { focusId: string }) {
  const model = useStore((s) => s.model);
  const fresh = useStore((s) => s.fresh);
  const unseen = useStore((s) => s.unseen);
  const stale = useStore((s) => s.stale);
  const railOpen = useStore((s) => s.dataRailOpen);
  const rf = useReactFlow<AnyNode>();
  const wrapper = useRef<HTMLDivElement>(null);
  const zoomClass = useZoomClass(wrapper);
  const reduced = prefersReducedMotion();
  const [hover, setHover] = useState<FocusHover>(null);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const fonts = useFontsReady();
  const toggleFields = useCallback((id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  }, []);

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const layout = useMemo(() => layoutFocus(model, focusId, { expanded }), [model, focusId, expanded, fonts]);
  const staleOwners = useMemo(() => new Set(stale.map((s) => s.ownerId)), [stale]);
  const refNames = useMemo(() => Object.fromEntries(model.elements.filter((e) => e.kind === 'data').map((e) => [e.id, e.name])), [model.elements]);
  const owner = useMemo(() => {
    const parentId = layout?.center.element.parentId;
    return parentId ? model.elements.find((e) => e.id === parentId) : undefined;
  }, [layout, model.elements]);

  const focusOn = useCallback((id: string) => {
    setHover(null);
    select({ elementIds: [id] });
    markSeen([id]);
  }, []);

  // A focus change moves cards to their new places; threads fade back in once they have arrived.
  const [moving, setMoving] = useState(false);
  const lastFocus = useRef(focusId);
  useLayoutEffect(() => {
    if (lastFocus.current === focusId) return;
    lastFocus.current = focusId;
    setHover(null);
    setExpanded(new Set());
    if (reduced) return;
    setMoving(true);
    const t = setTimeout(() => setMoving(false), MOVE_MS + 40);
    return () => clearTimeout(t);
  }, [focusId, reduced]);

  const nodes = useMemo<AnyNode[]>(() => {
    if (!layout) return [];
    const out: AnyNode[] = [];
    const pad = 24;
    const b = layout.bounds;
    out.push({
      id: `threads:${focusId}`,
      type: 'threads',
      position: { x: b.x - pad, y: b.y - pad },
      data: { threads: layout.threads, origin: { x: b.x - pad, y: b.y - pad }, width: b.width + pad * 2, height: b.height + pad * 2, hover },
      draggable: false,
      selectable: false,
      focusable: false,
      zIndex: 0,
      className: 'rf-threads',
    });
    for (const card of layout.cards) {
      out.push({
        id: card.id,
        type: 'card',
        position: { x: card.x, y: card.y },
        width: card.w,
        height: card.h,
        data: {
          card,
          hover,
          fresh: fresh[card.id],
          unseen: !!unseen[card.id],
          stale: staleOwners.has(card.id),
          refNames,
          ownerName: card.role === 'center' ? owner?.name : undefined,
          onHover: setHover,
          onFocus: focusOn,
          onOwner: owner ? () => navigateToElement(owner.id) : undefined,
          onToggleFields: toggleFields,
        },
        draggable: false,
        selectable: false,
        focusable: card.role !== 'center',
        // Not selectable or draggable, so React Flow would switch pointer events off; cards are interactive.
        style: { pointerEvents: 'all' },
        zIndex: 1,
        className: `rf-dcard is-${card.role}`,
      });
    }
    if (layout.users)
      out.push({
        id: `users:${focusId}`,
        type: 'users',
        position: { x: layout.users.x, y: layout.users.y },
        data: { groups: layout.users.groups, width: layout.users.w, onOpen: (id: string) => navigateToElement(id) },
        draggable: false,
        selectable: false,
        focusable: false,
        style: { pointerEvents: 'all' },
        zIndex: 1,
      });
    return out;
  }, [layout, focusId, hover, fresh, unseen, staleOwners, refNames, owner, focusOn, toggleFields]);

  // Frame the focus: the whole picture across the free width, its top below the top bar.
  const frame = useCallback(
    (duration: number) => {
      if (!layout) return;
      const free = freeArea(wrapper.current, true, 16, railOpen);
      const b = layout.bounds;
      const width = free.right - free.left;
      const zoom = Math.max(0.5, Math.min(1, width / b.width));
      const x = free.left + (width - b.width * zoom) / 2 - b.x * zoom;
      const y = free.top + 12 - b.y * zoom;
      void rf.setViewport({ x, y, zoom }, { duration: reduced ? 0 : duration });
    },
    [layout, railOpen, rf, reduced],
  );
  const framedFor = useRef<string | null>(null);
  useEffect(() => {
    const first = framedFor.current === null;
    if (framedFor.current === focusId) return;
    framedFor.current = focusId;
    // Wait a frame so the inspector, which opens with the focus, can be measured.
    const raf = requestAnimationFrame(() => frame(first ? 0 : MOVE_MS));
    return () => cancelAnimationFrame(raf);
  }, [focusId, frame]);
  useEffect(() => {
    if (framedFor.current) frame(200);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [railOpen]);

  useEffect(
    () =>
      onCanvasCommand((cmd) => {
        if (cmd === 'fit') frame(300);
        else if (cmd === 'zoom-in') void rf.zoomIn({ duration: reduced ? 0 : 160 });
        else if (cmd === 'zoom-out') void rf.zoomOut({ duration: reduced ? 0 : 160 });
        else if (cmd === 'zoom-reset') void rf.zoomTo(1, { duration: reduced ? 0 : 200 });
      }),
    [frame, rf, reduced],
  );

  useEffect(() => {
    registerCanvasTarget({ capture: () => captureFlow(rf, wrapper.current) });
    return () => registerCanvasTarget(null);
  }, [rf]);

  if (!layout) return null;
  return (
    <div ref={wrapper} className={cx('canvas', 'canvas-data', zoomClass, moving && 'is-moving', hover && 'has-hover')}>
      <ReactFlow<AnyNode>
        nodes={nodes}
        edges={[]}
        nodeTypes={nodeTypes}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable={false}
        zoomOnDoubleClick={false}
        deleteKeyCode={null}
        minZoom={0.3}
        maxZoom={2}
        panOnScroll
        aria-label={`Focus on ${layout.center.element.name}`}
      >
        <Background variant={BackgroundVariant.Dots} gap={22} size={1.2} className="canvas-dots" />
      </ReactFlow>
    </div>
  );
}

