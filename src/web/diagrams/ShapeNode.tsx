import { memo, useContext, useLayoutEffect, useMemo, useRef } from 'react';
import { Handle, Position, useConnection, type Node, type NodeProps } from '@xyflow/react';
import { Link2 } from 'lucide-react';
import type { DiagramShape } from '../../shared/model.ts';
import { layoutShape, textFrame } from '../../shared/diagram/layout.ts';
import { paintShape } from '../../shared/diagram/shapes.ts';
import { shapeStyle, textStyle } from '../../shared/diagram/style.ts';
import type { SvgNode } from '../../shared/diagram/svg.ts';
import { baselineOffset, FONT_FAMILY, lineHeight } from '../../shared/diagram/text.ts';
import type { DiagramTheme } from '../../shared/diagram/theme.ts';
import { cx } from '../lib/dom.ts';
import { finishEditing } from './actions.ts';
import { ShapeToolsContext } from './context.ts';
import { setEditor, useEditor } from './editor.ts';
import type { ResizeHandle } from './geometry.ts';
import { Paint } from './Paint.tsx';

export interface ShapeNodeData extends Record<string, unknown> {
  /** The shape as drawn: live geometry, grown to hold its text. */
  shape: DiagramShape;
  label: string;
  /** The name of what it links to, for the link glyph. */
  linkName?: string;
  editing: boolean;
  resizable: boolean;
  dropTarget: boolean;
  connectTarget: boolean;
  fresh?: number;
}

export type ShapeNodeType = Node<ShapeNodeData, 'shape'>;

const SIDES = [Position.Top, Position.Right, Position.Bottom, Position.Left] as const;
const HANDLES: ResizeHandle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];

function ShapeNodeImpl({ id, data, selected }: NodeProps<ShapeNodeType>) {
  const tools = useContext(ShapeToolsContext)!;
  const { shape, label, editing } = data;
  const connection = useConnection();
  const connecting = connection.inProgress;
  const connectingHere = connecting && connection.fromNode.id !== id;
  const paint = useMemo(() => {
    const nodes = paintShape(shape, label, tools.theme);
    return editing ? withoutLabel(nodes, shape, label) : nodes;
  }, [shape, label, tools.theme, editing]);

  return (
    <div
      className={cx(
        'dshape',
        `kind-${shape.kind}`,
        selected && 'is-selected',
        editing && 'is-editing',
        data.dropTarget && 'is-drop-target',
        (data.connectTarget || connectingHere) && 'is-connect-target',
      )}
      style={{ width: shape.w, height: shape.h }}
      data-id={id}
    >
      {data.fresh && <span key={data.fresh} className="dshape-fresh" aria-hidden />}
      <svg className="dshape-paint" width={shape.w} height={shape.h} viewBox={`0 0 ${shape.w} ${shape.h}`} fontFamily={FONT_FAMILY} textRendering="geometricPrecision" aria-hidden>
        <Paint nodes={paint} />
      </svg>
      <Handle type="source" position={Position.Top} id="anchor" className="handle-anchor" isConnectable={false} />
      <Handle type="target" position={Position.Top} id="in" className={cx('handle-in', connectingHere && 'is-live')} />
      {!editing && SIDES.map((side) => <Handle key={side} type="source" position={side} id={`out-${side}`} className="handle-out" />)}
      {editing && <ShapeTextEditor shape={shape} theme={tools.theme} />}
      {shape.link && !editing && (
        <button
          type="button"
          className="dshape-link nodrag nopan"
          title={data.linkName ? `Go to ${data.linkName}` : 'Linked item'}
          aria-label={data.linkName ? `Go to ${data.linkName}` : 'Go to the linked item'}
          tabIndex={-1}
          onClick={(e) => {
            e.stopPropagation();
            tools.openLink(shape.link!);
          }}
        >
          <Link2 size={11} strokeWidth={2} aria-hidden />
        </button>
      )}
      {data.resizable &&
        HANDLES.map((handle) => (
          <span key={handle} className={cx('dshape-resize', `is-${handle}`, 'nodrag', 'nopan')} onPointerDown={(e) => tools.startResize(id, handle, e)} aria-hidden />
        ))}
    </div>
  );
}

export const ShapeNode = memo(ShapeNodeImpl);

/** The paint without the label's lines, which the editor shows in their place. Text lines come label first. */
function withoutLabel(nodes: SvgNode[], shape: DiagramShape, label: string): SvgNode[] {
  let skip = layoutShape({ kind: shape.kind, label, detail: shape.detail, size: shape.size, w: shape.w, h: shape.h }).lines.filter((l) => l.role === 'label').length;
  return nodes.filter((n) => n.tag !== 'text' || skip-- <= 0);
}

/** The label typed in place: same frame, font, size, weight, alignment and line breaks as the renderer draws. */
function ShapeTextEditor({ shape, theme }: { shape: DiagramShape; theme: DiagramTheme }) {
  const draft = useEditor((s) => s.editing?.draft ?? '');
  const ref = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    ref.current?.focus({ preventScroll: true });
    ref.current?.select();
  }, []);
  const type = textStyle(shape.kind, shape.size);
  const lines = layoutShape({ kind: shape.kind, label: draft.trim() ? draft : 'M', detail: shape.detail, size: shape.size, w: shape.w, h: shape.h }).lines.filter((l) => l.role === 'label');
  const first = lines[0]!;
  const frame = textFrame(shape.kind, shape.w, shape.h, shape.size);
  const leading = lineHeight(type.labelSize);
  return (
    <textarea
      ref={ref}
      className="dshape-editor nodrag nopan nowheel"
      value={draft}
      maxLength={400}
      rows={1}
      spellCheck
      aria-label="Shape text"
      style={{
        left: frame.left,
        top: first.y - baselineOffset(type.labelSize),
        width: frame.right - frame.left,
        height: lines.length * leading,
        fontFamily: FONT_FAMILY,
        fontSize: type.labelSize,
        fontWeight: type.labelWeight,
        lineHeight: `${leading}px`,
        textAlign: first.anchor === 'middle' ? 'center' : 'left',
        color: shapeStyle(shape, theme).ink,
      }}
      onChange={(e) => {
        const value = e.target.value;
        setEditor((s) => (s.editing ? { editing: { ...s.editing, draft: value } } : {}));
      }}
      onPointerDown={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
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
  );
}
