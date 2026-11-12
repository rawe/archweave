import { useRef, useState } from 'react';
import { ArrowDown, ArrowRight, ArrowUp, Plus, Trash, X } from 'lucide-react';
import type { Flow, FlowStep } from '../../shared/model.ts';
import { Picker } from '../chrome/Picker.tsx';
import { Tip } from '../chrome/primitives.tsx';
import { commit, navigateToElement, setState } from '../state/store.ts';
import { scopePath, type ModelIndex } from '../state/selectors.ts';
import { KindIcon } from '../lib/kinds.tsx';
import { CodeRefs } from './CodeRefs.tsx';
import { InlineText, MarkdownField, Section } from './fields.tsx';

export function saveSteps(flow: Flow, steps: FlowStep[], summary: string) {
  void commit({ summary, flows: [{ id: flow.id, steps }] });
}

export function StepInspector({ flow, stepIndex, index }: { flow: Flow; stepIndex: number; index: ModelIndex }) {
  const step = flow.steps[stepIndex];
  const [picking, setPicking] = useState<'from' | 'to' | 'data' | null>(null);
  const fromRef = useRef<HTMLButtonElement>(null);
  const toRef = useRef<HTMLButtonElement>(null);
  const dataRef = useRef<HTMLButtonElement>(null);
  if (!step) return null;
  const from = index.byId.get(step.from);
  const to = index.byId.get(step.to);
  const update = (p: Partial<FlowStep>, summary = `Edited step ${stepIndex + 1} of ${flow.name}`) =>
    saveSteps(flow, flow.steps.map((s, i) => (i === stepIndex ? { ...s, ...p } : s)), summary);
  const move = (delta: number) => {
    const target = stepIndex + delta;
    if (target < 0 || target >= flow.steps.length) return;
    const steps = [...flow.steps];
    const [s] = steps.splice(stepIndex, 1);
    steps.splice(target, 0, s!);
    saveSteps(flow, steps, `Reordered steps of ${flow.name}`);
    setState({ stepIndex: target });
  };
  const participants = [...index.byId.values()].filter((e) => e.kind !== 'data');
  const participantItems = participants.map((e) => ({ id: e.id, label: e.name, detail: scopePath(e, index), icon: <KindIcon kind={e.kind} size={13} /> }));

  return (
    <div className="inspector-body">
      <header className="insp-head">
        <div className="insp-step-no">
          Step {stepIndex + 1} of {flow.steps.length}
        </div>
        <div className="endpoints">
          <button ref={fromRef} type="button" className="endpoint is-editable" onClick={() => setPicking('from')} onDoubleClick={() => from && navigateToElement(from.id)}>
            {from && <KindIcon kind={from.kind} size={14} />}
            <span>{from?.name ?? step.from}</span>
          </button>
          <ArrowRight size={14} strokeWidth={1.7} className="endpoint-arrow" aria-label="to" />
          <button ref={toRef} type="button" className="endpoint is-editable" onClick={() => setPicking('to')} onDoubleClick={() => to && navigateToElement(to.id)}>
            {to && <KindIcon kind={to.kind} size={14} />}
            <span>{to?.name ?? step.to}</span>
          </button>
        </div>
      </header>
      <InlineText multiline className="insp-summary" value={step.label} label="Step label" allowEmpty={false} placeholder="What happens" onCommit={(label) => update({ label })} />
      <div className="insp-desc">
        <MarkdownField value={step.description ?? ''} onCommit={(description) => update({ description })} placeholder="Add a description" label="Step description" />
      </div>
      <Section
        label="Data"
        action={
          index.data.length > 0 ? (
            <button ref={dataRef} type="button" className="section-action" onClick={() => setPicking('data')}>
              <Plus size={13} strokeWidth={1.8} aria-hidden />
              Add
            </button>
          ) : undefined
        }
      >
        {step.dataIds.length > 0 && (
          <div className="chips">
            {step.dataIds.map((id) => (
              <span key={id} className="chip chip-data">
                <button type="button" className="chip-main" onClick={() => navigateToElement(id)}>
                  <KindIcon kind="data" size={12} />
                  {index.byId.get(id)?.name ?? id}
                </button>
                <button type="button" className="chip-x" aria-label="Remove" onClick={() => update({ dataIds: step.dataIds.filter((x) => x !== id) })}>
                  <X size={11} strokeWidth={2} />
                </button>
              </span>
            ))}
          </div>
        )}
      </Section>
      <CodeRefs ownerId={flow.id} refs={step.codeRefs} onChange={(codeRefs) => update({ codeRefs })} />
      <footer className="insp-foot">
        <Tip label="Move earlier" side="top">
          <button type="button" className="foot-btn" aria-label="Move earlier" disabled={stepIndex === 0} onClick={() => move(-1)}>
            <ArrowUp size={14} strokeWidth={1.7} />
          </button>
        </Tip>
        <Tip label="Move later" side="top">
          <button type="button" className="foot-btn" aria-label="Move later" disabled={stepIndex === flow.steps.length - 1} onClick={() => move(1)}>
            <ArrowDown size={14} strokeWidth={1.7} />
          </button>
        </Tip>
        <span className="foot-spacer" />
        <Tip label="Delete step" side="top">
          <button
            type="button"
            className="foot-btn is-danger"
            aria-label="Delete step"
            onClick={() => {
              saveSteps(flow, flow.steps.filter((_, i) => i !== stepIndex), `Removed step ${stepIndex + 1} from ${flow.name}`);
              setState({ stepIndex: flow.steps.length > 1 ? Math.min(stepIndex, flow.steps.length - 2) : null });
            }}
          >
            <Trash size={14} strokeWidth={1.7} />
          </button>
        </Tip>
      </footer>
      {(picking === 'from' || picking === 'to') && (
        <Picker
          anchor={picking === 'from' ? fromRef : toRef}
          placeholder={picking === 'from' ? 'From' : 'To'}
          items={participantItems}
          onClose={() => setPicking(null)}
          onPick={(item) => update(picking === 'from' ? { from: item.id } : { to: item.id })}
        />
      )}
      {picking === 'data' && (
        <Picker
          anchor={dataRef}
          placeholder="Structure carried"
          items={index.data.filter((d) => !step.dataIds.includes(d.id)).map((d) => ({ id: d.id, label: d.name, detail: scopePath(d, index), icon: <KindIcon kind="data" size={13} /> }))}
          onClose={() => setPicking(null)}
          onPick={(item) => update({ dataIds: [...step.dataIds, item.id] })}
        />
      )}
    </div>
  );
}
