import { memo, useContext, useLayoutEffect, useMemo, useRef } from 'react';
import { EdgeLabelRenderer, type Edge, type EdgeProps } from '@xyflow/react';
import type { DiagramConnector } from '../../shared/model.ts';
import { paintConnector, paintConnectorLabel } from '../../shared/diagram/connectors.ts';
import { CONNECTOR_LABEL_SIZE, type ConnectorGeometry } from '../../shared/diagram/route.ts';
import { blockWidth, FONT_FAMILY, lineHeight } from '../../shared/diagram/text.ts';
import type { DiagramTheme } from '../../shared/diagram/theme.ts';
import { cx } from '../lib/dom.ts';
import { finishEditing } from './actions.ts';
import { RoutesContext } from './context.ts';
import { setEditor, useEditor } from './editor.ts';
import { midpoint } from './geometry.ts';
import { Paint } from './Paint.tsx';

export interface ConnectorEdgeData extends Record<string, unknown> {
  connector: DiagramConnector;
  /** The line to a shape still being placed: drawn, not selectable. */
  draft?: boolean;
  fresh?: number;
}

export type ConnectorEdgeType = Edge<ConnectorEdgeData, 'connector'>;

function ConnectorEdgeImpl({ id, data, selected }: EdgeProps<ConnectorEdgeType>) {
  const { routes, theme, startReconnect } = useContext(RoutesContext)!;
  const editing = useEditor((s) => s.editing?.target === 'connector' && s.editing.id === id);
  const geometry = routes.get(id);
  const connector = data?.connector;
  const line = useMemo(() => (geometry && connector ? paintConnector(geometry, connector, theme) : []), [geometry, connector, theme]);
  const label = useMemo(() => (geometry && !editing ? paintConnectorLabel(geometry, theme) : []), [geometry, theme, editing]);
  if (!geometry || !connector) return null;
  const start = geometry.points[0]!;
  const end = geometry.points.at(-1)!;

  return (
    <>
      {selected && <path d={geometry.hitPath} className="dconn-halo" />}
      {data.fresh && <path key={data.fresh} d={geometry.hitPath} className="dconn-fresh" />}
      {!data.draft && <path d={geometry.hitPath} className="dconn-hit" />}
      <Paint nodes={line} />
      {label.length > 0 && (
        <g className="dconn-label">
          <Paint nodes={label} />
        </g>
      )}
      {selected && !editing && (
        <>
          <circle className="dconn-grip nodrag nopan" cx={start.x} cy={start.y} r={4} onPointerDown={(e) => startReconnect(id, 'from', e)} />
          <circle className="dconn-grip nodrag nopan" cx={end.x} cy={end.y} r={4} onPointerDown={(e) => startReconnect(id, 'to', e)} />
        </>
      )}
      {editing && <LabelEditor geometry={geometry} theme={theme} />}
    </>
  );
}

export const ConnectorEdge = memo(ConnectorEdgeImpl);

/** The connector label typed in place, on the patch the renderer puts behind it. */
function LabelEditor({ geometry, theme }: { geometry: ConnectorGeometry; theme: DiagramTheme }) {
  const draft = useEditor((s) => s.editing?.draft ?? '');
  const ref = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    ref.current?.focus({ preventScroll: true });
    ref.current?.select();
  }, []);
  const leading = lineHeight(CONNECTOR_LABEL_SIZE);
  const box = geometry.label;
  const mid = midpoint(geometry.points);
  const frame = box ?? { x: mid.x - 28, y: mid.y - leading / 2 - 3, w: 56, h: leading + 6, lines: [''] };
  const padX = box ? (box.w - blockWidth(box.lines, CONNECTOR_LABEL_SIZE)) / 2 : 6;
  const padY = (frame.h - frame.lines.length * leading) / 2;
  return (
    <EdgeLabelRenderer>
      <textarea
        ref={ref}
        className={cx('dconn-editor', 'nodrag', 'nopan', 'nowheel')}
        value={draft}
        maxLength={120}
        rows={1}
        aria-label="Line label"
        style={{
          transform: `translate(${frame.x}px, ${frame.y}px)`,
          width: frame.w,
          height: frame.h,
          padding: `${padY}px ${padX}px`,
          fontFamily: FONT_FAMILY,
          fontSize: CONNECTOR_LABEL_SIZE,
          lineHeight: `${leading}px`,
          color: theme.ink2,
          background: theme.canvas,
        }}
        onChange={(e) => {
          const value = e.target.value;
          setEditor((s) => (s.editing ? { editing: { ...s.editing, draft: value } } : {}));
        }}
        onPointerDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            finishEditing(true);
          } else if (e.key === 'Escape') {
            e.preventDefault();
            finishEditing(false);
          }
        }}
        onBlur={() => finishEditing(true)}
      />
    </EdgeLabelRenderer>
  );
}
