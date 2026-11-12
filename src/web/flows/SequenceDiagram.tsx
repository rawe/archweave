import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowUpRight, Plus } from 'lucide-react';
import type { Flow, FlowStep } from '../../shared/model.ts';
import { Picker, type PickItem } from '../chrome/Picker.tsx';
import { Tip } from '../chrome/primitives.tsx';
import { saveSteps } from '../inspector/StepInspector.tsx';
import { navigateToElement, select, setState, useStore } from '../state/store.ts';
import { scopePath, useIndex } from '../state/selectors.ts';
import { registerCanvasTarget } from '../lib/canvasTarget.ts';
import { cx, prefersReducedMotion } from '../lib/dom.ts';
import { KindIcon } from '../lib/kinds.tsx';
import { canvasMeasure, lineCount, SANS, useFontsReady } from '../lib/text.ts';

const COL_W = 168;
const TOP = 16;
const SIDE = 40;
/** Step labels may be wider than a short arrow; they wrap over as many lines as they need. */
const LABEL_MIN = 272;
const PART_W = COL_W - 20;
const LABEL_LINE = 17.2;
const CHIP_H = 20;

interface Row {
  top: number;
  h: number;
  /** Absolute y of the arrow. */
  arrowY: number;
  left: number;
  w: number;
  labelLeft: number;
  labelW: number;
  align: 'start' | 'end' | 'center';
  self: boolean;
}

/** Rows sized from their text: the wrapped label above the arrow, the data chips below it. */
function layoutRows(flow: Flow, col: (id: string) => number, bodyTop: number, dataName: (id: string) => string): Row[] {
  let top = bodyTop;
  return flow.steps.map((s) => {
    const x1 = col(s.from);
    const x2 = col(s.to);
    const self = s.from === s.to;
    const left = self ? x1 + 8 : Math.min(x1, x2);
    const w = self ? COL_W - 24 : Math.abs(x2 - x1);
    // Short arrows center their label; long ones keep it at the sender, next to the step number.
    const long = !self && w > LABEL_MIN * 1.6;
    const labelW = long ? LABEL_MIN * 1.4 : Math.max(w - 32, LABEL_MIN);
    const align = long ? (x2 >= x1 ? 'start' : 'end') : 'center';
    const labelLeft = align === 'start' ? 18 : align === 'end' ? w - labelW - 18 : (Math.max(w, 120) - labelW) / 2;
    const lines = lineCount(s.label, `400 13px ${SANS}`, labelW - 12);
    const arrowRel = 10 + Math.ceil(lines * LABEL_LINE) + 2 + 9;
    let chipRows = 0;
    let used = 0;
    for (const id of s.dataIds) {
      const cw = Math.min(labelW, canvasMeasure.width(dataName(id), `400 11.5px ${SANS}`) + 32);
      if (!chipRows || used + 4 + cw > labelW) {
        chipRows++;
        used = cw;
      } else used += 4 + cw;
    }
    const chipsH = chipRows ? chipRows * CHIP_H + (chipRows - 1) * 4 : 0;
    const h = Math.max(64, arrowRel + (self ? 16 : 0) + (chipsH ? 6 + chipsH : 0) + 16);
    const row: Row = { top, h, arrowY: top + arrowRel, left, w, labelLeft, labelW, align, self };
    top += h;
    return row;
  });
}

export function SequenceDiagram({ flow }: { flow: Flow }) {
  const index = useIndex();
  const stepIndex = useStore((s) => s.stepIndex);
  const selected = useStore((s) => s.selection.elementIds);
  const unseen = useStore((s) => s.unseen);
  const diagram = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<{ from: number; to: number; startY: number } | null>(null);
  /** Set when a drag moved a step, so the click that ends the gesture does not select by the old index. */
  const moved = useRef(false);

  const participants = useMemo(() => {
    const ids: string[] = [];
    for (const s of flow.steps) for (const id of [s.from, s.to]) if (!ids.includes(id)) ids.push(id);
    return ids;
  }, [flow.steps]);
  const fonts = useFontsReady();
  const col = (id: string) => SIDE + participants.indexOf(id) * COL_W + COL_W / 2;
  const width = Math.max(SIDE * 2 + participants.length * COL_W, 520);
  // Participant boxes are as tall as the longest name needs.
  const headBox = useMemo(() => {
    const lines = Math.max(1, ...participants.map((id) => lineCount(index.byId.get(id)?.name ?? id, `560 13px ${SANS}`, PART_W - 2 - 11 - 14 - 7 - 10)));
    return Math.max(52, 18 + Math.ceil(lines * 16.25));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [participants, index, fonts]);
  const headH = TOP + headBox + 8;
  const bodyTop = headH + 20;
  const rows = useMemo(
    () => layoutRows(flow, col, bodyTop, (id) => index.byId.get(id)?.name ?? id),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [flow, participants, bodyTop, index, fonts],
  );
  const bodyBottom = rows.length ? rows[rows.length - 1]!.top + rows[rows.length - 1]!.h : bodyTop;
  const height = bodyBottom + 84;
  const active = stepIndex;

  useEffect(() => {
    registerCanvasTarget({
      capture: async () => (diagram.current ? { node: diagram.current, width: diagram.current.scrollWidth, height: diagram.current.scrollHeight } : null),
    });
    return () => registerCanvasTarget(null);
  }, []);

  // Keep the active step in view while stepping.
  useEffect(() => {
    if (active === null || !scroller.current) return;
    const step = flow.steps[active];
    if (!step) return;
    const box = scroller.current;
    const y = rows[active]?.top ?? bodyTop;
    const xs = [col(step.from), col(step.to)];
    const left = Math.min(...xs) - 60;
    const right = Math.max(...xs) + 60;
    let top = box.scrollTop;
    let scrollLeft = box.scrollLeft;
    if (y < box.scrollTop + 40 || y > box.scrollTop + box.clientHeight - 120) top = y - box.clientHeight / 3;
    const offset = diagram.current?.offsetLeft ?? 0;
    if (left + offset < box.scrollLeft || right + offset > box.scrollLeft + box.clientWidth)
      scrollLeft = right - left > box.clientWidth ? left + offset : (left + right) / 2 + offset - box.clientWidth / 2;
    box.scrollTo({ top, left: scrollLeft, behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, bodyTop]);

  const targetIndex = (clientY: number) => {
    if (!drag || !diagram.current) return 0;
    const y = clientY - diagram.current.getBoundingClientRect().top;
    let to = 0;
    rows.forEach((r, i) => {
      if (y >= r.top) to = i;
    });
    return Math.max(0, Math.min(flow.steps.length - 1, to));
  };
  const dropY = drag && drag.to !== drag.from ? (drag.to > drag.from ? rows[drag.to]!.top + rows[drag.to]!.h : rows[drag.to]!.top) : null;

  return (
    <div className="seq-scroll" ref={scroller}>
      <div
        className={cx('seq', active !== null && 'has-active')}
        ref={diagram}
        style={{ width, height }}
        onPointerMove={(e) => drag && setDrag({ ...drag, to: targetIndex(e.clientY) })}
        onPointerUp={() => {
          if (!drag) return;
          if (drag.to !== drag.from) {
            moved.current = true;
            const steps = [...flow.steps];
            const [s] = steps.splice(drag.from, 1);
            steps.splice(drag.to, 0, s!);
            saveSteps(flow, steps, `Reordered steps of ${flow.name}`);
            setState({ stepIndex: drag.to });
          }
          setDrag(null);
        }}
        onClick={(e) => {
          if (e.target === e.currentTarget) setState({ stepIndex: null, selection: { elementIds: [], relationIds: [] } });
        }}
      >
        {/* Participants stay in view while a long flow scrolls. */}
        <div className="seq-heads" style={{ height: headH, width }}>
          {participants.map((id) => {
            const el = index.byId.get(id);
            return (
              <div
                key={id}
                className={cx('seq-part', selected.includes(id) && 'is-selected', el?.status === 'planned' && 'is-planned')}
                style={{ left: col(id) - PART_W / 2, top: TOP, width: PART_W, height: headBox }}
                title={el?.name ?? id}
              >
                <button type="button" className="seq-part-main" onClick={() => select({ elementIds: [id] })} onDoubleClick={() => navigateToElement(id)}>
                  {el && <KindIcon kind={el.kind} size={14} />}
                  <span className="seq-part-name">{el?.name ?? id}</span>
                  {unseen[id] && <span className="dot-agent" />}
                </button>
                <Tip label="Show in Structure" side="top">
                  <button type="button" className="seq-part-go" aria-label={`Show ${el?.name ?? id} in Structure`} onClick={() => navigateToElement(id)}>
                    <ArrowUpRight size={13} strokeWidth={1.8} />
                  </button>
                </Tip>
              </div>
            );
          })}
        </div>

        <svg className="seq-svg" width={width} height={height} aria-hidden>
          {participants.map((id) => (
            <line key={id} x1={col(id)} x2={col(id)} y1={headH} y2={height - 40} className="seq-lifeline" />
          ))}
          {flow.steps.map((s, i) => (
            <StepArrow key={i} step={s} i={i} x1={col(s.from)} x2={col(s.to)} y={rows[i]!.arrowY} state={stepState(i, active, drag)} />
          ))}
          {dropY !== null && <line x1={SIDE} x2={width - SIDE} y1={dropY} y2={dropY} className="seq-drop" />}
        </svg>

        {flow.steps.map((s, i) => {
          const { left, w, labelLeft, labelW, align, top, h, arrowY, self } = rows[i]!;
          const x1 = col(s.from);
          const x2 = col(s.to);
          const arrow = arrowY - top;
          return (
            <div
              key={i}
              className={cx('seq-step', stepState(i, active, drag), drag?.from === i && 'is-dragging')}
              style={{ left, top, width: Math.max(w, 120), height: h }}
            >
              <button
                type="button"
                className="seq-num"
                style={{ left: self || x2 >= x1 ? -11 : w - 11, top: arrow - 11 }}
                aria-label={`Step ${i + 1}. Drag to reorder`}
                onPointerDown={(e) => {
                  moved.current = false;
                  e.currentTarget.setPointerCapture(e.pointerId);
                  setDrag({ from: i, to: i, startY: e.clientY });
                }}
                onPointerMove={(e) => drag && setDrag({ ...drag, to: targetIndex(e.clientY) })}
                onClick={() => {
                  if (moved.current) return void (moved.current = false);
                  setState({ stepIndex: i, selection: { elementIds: [], relationIds: [] } });
                }}
              >
                {i + 1}
              </button>
              <button type="button" className="seq-label" style={{ left: labelLeft, width: labelW, top: 10, textAlign: align === 'center' ? 'center' : align === 'start' ? 'left' : 'right' }} title={s.label} onClick={() => setState({ stepIndex: i, selection: { elementIds: [], relationIds: [] } })}>
                {s.label}
              </button>
              {s.dataIds.length > 0 && (
                <div className="seq-data" style={{ left: labelLeft, width: labelW, top: arrow + (self ? 22 : 6), justifyContent: align === 'center' ? 'center' : `flex-${align}` }}>
                  {s.dataIds.map((d) => (
                    <button key={d} type="button" className="chip chip-data is-small" title={index.byId.get(d)?.name ?? d} onClick={() => navigateToElement(d)}>
                      <KindIcon kind="data" size={11} />
                      <span className="chip-text">{index.byId.get(d)?.name ?? d}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          );
        })}

        <AddStep flow={flow} participants={participants} top={bodyBottom + 18} left={SIDE} />
      </div>
    </div>
  );
}

function stepState(i: number, active: number | null, drag: { from: number } | null): string {
  if (drag) return '';
  if (active === null) return '';
  return i === active ? 'is-active' : i < active ? 'is-past' : 'is-future';
}

function StepArrow({ step, x1, x2, y, state, i }: { step: FlowStep; x1: number; x2: number; y: number; state: string; i: number }) {
  if (step.from === step.to) {
    const d = `M ${x1} ${y - 8} h 38 a 8 8 0 0 1 8 8 v 4 a 8 8 0 0 1 -8 8 h -30`;
    return (
      <g className={cx('seq-arrow', state)} data-step={i}>
        <path d={d} className="seq-line" fill="none" />
        <path d={`M ${x1 + 1} ${y + 12} l 7 -3.5 l 0 7 z`} className="seq-head" />
      </g>
    );
  }
  const dir = x2 > x1 ? 1 : -1;
  const end = x2 - dir * 2;
  return (
    <g className={cx('seq-arrow', state)} data-step={i}>
      <line x1={x1} x2={end - dir * 7} y1={y} y2={y} className="seq-line" />
      <path d={`M ${end} ${y} l ${-dir * 8} -3.6 q ${dir * 1.5} 3.6 0 7.2 z`} className="seq-head" />
    </g>
  );
}

function AddStep({ flow, participants, top, left }: { flow: Flow; participants: string[]; top: number; left: number }) {
  const index = useIndex();
  const [open, setOpen] = useState(false);
  const [from, setFrom] = useState<string | null>(null);
  const [to, setTo] = useState<string | null>(null);
  const [label, setLabel] = useState('');
  const [picking, setPicking] = useState<'from' | 'to' | null>(null);
  const fromRef = useRef<HTMLButtonElement>(null);
  const toRef = useRef<HTMLButtonElement>(null);
  const labelRef = useRef<HTMLInputElement>(null);

  const items: PickItem[] = useMemo(() => {
    const els = [...index.byId.values()].filter((e) => e.kind !== 'data');
    els.sort((a, b) => Number(participants.includes(b.id)) - Number(participants.includes(a.id)) || a.name.localeCompare(b.name));
    return els.map((e) => ({ id: e.id, label: e.name, detail: participants.includes(e.id) ? 'in this flow' : scopePath(e, index), icon: <KindIcon kind={e.kind} size={13} /> }));
  }, [index, participants]);

  const start = () => {
    const last = flow.steps[flow.steps.length - 1];
    setFrom(last?.to ?? null);
    setTo(null);
    setLabel('');
    setOpen(true);
    requestAnimationFrame(() => (last ? setPicking('to') : setPicking('from')));
  };
  const add = () => {
    if (!from || !to || !label.trim()) return;
    saveSteps(flow, [...flow.steps, { from, to, label: label.trim(), dataIds: [], codeRefs: [] }], `Added a step to ${flow.name}`);
    setState({ stepIndex: flow.steps.length });
    setOpen(false);
  };

  if (!open)
    return (
      <button type="button" className="seq-add" style={{ top, left }} onClick={start}>
        <Plus size={14} strokeWidth={1.8} aria-hidden />
        Add step
      </button>
    );
  return (
    <div className="seq-add-form" style={{ top, left }} onKeyDown={(e) => e.key === 'Escape' && (e.stopPropagation(), setOpen(false))}>
      <button ref={fromRef} type="button" className={cx('endpoint', 'is-editable', !from && 'is-empty')} onClick={() => setPicking('from')}>
        {from ? index.byId.get(from)?.name : 'From'}
      </button>
      <span className="endpoint-arrow">→</span>
      <button ref={toRef} type="button" className={cx('endpoint', 'is-editable', !to && 'is-empty')} onClick={() => setPicking('to')}>
        {to ? index.byId.get(to)?.name : 'To'}
      </button>
      <input
        ref={labelRef}
        className="inline-text seq-add-label"
        value={label}
        placeholder="What happens"
        aria-label="Step label"
        onChange={(e) => setLabel(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') add();
        }}
      />
      <button type="button" className="btn btn-primary btn-small" disabled={!from || !to || !label.trim()} onClick={add}>
        Add
      </button>
      <button type="button" className="btn btn-small" onClick={() => setOpen(false)}>
        Cancel
      </button>
      {picking && (
        <Picker
          anchor={picking === 'from' ? fromRef : toRef}
          placeholder={picking === 'from' ? 'From' : 'To'}
          items={items}
          onClose={() => setPicking(null)}
          onPick={(item) => {
            if (picking === 'from') {
              setFrom(item.id);
              if (!to) requestAnimationFrame(() => setPicking('to'));
            } else {
              setTo(item.id);
              requestAnimationFrame(() => labelRef.current?.focus());
            }
          }}
        />
      )}
    </div>
  );
}
