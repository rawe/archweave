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

const COL_W = 176;
const HEAD_H = 64;
const ROW_H = 64;
const TOP = 28;
const SIDE = 40;

export function SequenceDiagram({ flow }: { flow: Flow }) {
  const index = useIndex();
  const stepIndex = useStore((s) => s.stepIndex);
  const selected = useStore((s) => s.selection.elementIds);
  const unseen = useStore((s) => s.unseen);
  const diagram = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<{ from: number; to: number; startY: number } | null>(null);

  const participants = useMemo(() => {
    const ids: string[] = [];
    for (const s of flow.steps) for (const id of [s.from, s.to]) if (!ids.includes(id)) ids.push(id);
    return ids;
  }, [flow.steps]);
  const col = (id: string) => SIDE + participants.indexOf(id) * COL_W + COL_W / 2;
  const width = Math.max(SIDE * 2 + participants.length * COL_W, 520);
  const bodyTop = TOP + HEAD_H + 24;
  const height = bodyTop + flow.steps.length * ROW_H + 84;
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
    const y = bodyTop + active * ROW_H;
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
    if (!drag) return 0;
    const delta = Math.round((clientY - drag.startY) / ROW_H);
    return Math.max(0, Math.min(flow.steps.length - 1, drag.from + delta));
  };

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
        <svg className="seq-svg" width={width} height={height} aria-hidden>
          {participants.map((id) => (
            <line key={id} x1={col(id)} x2={col(id)} y1={TOP + HEAD_H} y2={height - 40} className="seq-lifeline" />
          ))}
          {flow.steps.map((s, i) => (
            <StepArrow key={i} step={s} i={i} x1={col(s.from)} x2={col(s.to)} y={bodyTop + i * ROW_H + ROW_H / 2} state={stepState(i, active, drag)} />
          ))}
          {drag && drag.to !== drag.from && (
            <line x1={SIDE} x2={width - SIDE} y1={bodyTop + (drag.to > drag.from ? drag.to + 1 : drag.to) * ROW_H} y2={bodyTop + (drag.to > drag.from ? drag.to + 1 : drag.to) * ROW_H} className="seq-drop" />
          )}
        </svg>

        {participants.map((id) => {
          const el = index.byId.get(id);
          return (
            <div
              key={id}
              className={cx('seq-part', selected.includes(id) && 'is-selected', el?.status === 'planned' && 'is-planned')}
              style={{ left: col(id) - (COL_W - 28) / 2, top: TOP, width: COL_W - 28, height: HEAD_H - 16 }}
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

        {flow.steps.map((s, i) => {
          const x1 = col(s.from);
          const x2 = col(s.to);
          const self = s.from === s.to;
          const left = self ? x1 + 8 : Math.min(x1, x2);
          const w = self ? COL_W - 24 : Math.abs(x2 - x1);
          const y = bodyTop + i * ROW_H;
          return (
            <div
              key={i}
              className={cx('seq-step', stepState(i, active, drag), drag?.from === i && 'is-dragging')}
              style={{ left, top: y, width: Math.max(w, 120), height: ROW_H }}
            >
              <button
                type="button"
                className="seq-num"
                style={{ left: self || x2 >= x1 ? -11 : w - 11 }}
                aria-label={`Step ${i + 1}. Drag to reorder`}
                onPointerDown={(e) => {
                  e.currentTarget.setPointerCapture(e.pointerId);
                  setDrag({ from: i, to: i, startY: e.clientY });
                }}
                onPointerMove={(e) => drag && setDrag({ ...drag, to: targetIndex(e.clientY) })}
                onClick={() => setState({ stepIndex: i, selection: { elementIds: [], relationIds: [] } })}
              >
                {i + 1}
              </button>
              <button type="button" className="seq-label" onClick={() => setState({ stepIndex: i, selection: { elementIds: [], relationIds: [] } })}>
                {s.label}
              </button>
              {s.dataIds.length > 0 && (
                <div className="seq-data">
                  {s.dataIds.map((d) => (
                    <button key={d} type="button" className="chip chip-data is-small" onClick={() => navigateToElement(d)}>
                      <KindIcon kind="data" size={11} />
                      {index.byId.get(d)?.name ?? d}
                    </button>
                  ))}
                </div>
              )}
            </div>
          );
        })}

        <AddStep flow={flow} participants={participants} top={bodyTop + flow.steps.length * ROW_H + 18} left={SIDE} />
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
