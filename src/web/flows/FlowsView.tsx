import { useEffect, useMemo, useRef, useState } from 'react';
import { Ellipsis, Plus, Trash } from 'lucide-react';
import { slugify, uniqueId, type Flow } from '../../shared/model.ts';
import { Menu } from '../chrome/primitives.tsx';
import { Rail } from '../chrome/Rail.tsx';
import { confirmAction } from '../chrome/Confirm.tsx';
import { InlineText } from '../inspector/fields.tsx';
import { commit, openFlow, setState, useStore } from '../state/store.ts';
import { cx } from '../lib/dom.ts';
import { fuzzyScore } from '../lib/fuzzy.ts';
import { plural } from '../lib/format.ts';
import { SequenceDiagram } from './SequenceDiagram.tsx';

export function FlowsView() {
  const flows = useStore((s) => s.model.flows);
  const flowId = useStore((s) => s.flowId);
  const railOpen = useStore((s) => s.dataRailOpen);
  const flow = flows.find((f) => f.id === flowId);

  useEffect(() => {
    if (!flow && flows.length) openFlow(flows[0]!.id);
  }, [flow, flows]);

  return (
    <div className={cx('flows-view', railOpen && 'has-rail')}>
      <FlowRail />
      <div className="flow-stage">
        {flow ? (
          <>
            <FlowHeader flow={flow} />
            <SequenceDiagram flow={flow} />
          </>
        ) : (
          <div className="canvas-empty-scope">
            <p>No flows yet. A flow walks through one scenario step by step, like a request from the browser to the database and back.</p>
          </div>
        )}
      </div>
    </div>
  );
}

function FlowHeader({ flow }: { flow: Flow }) {
  const [menu, setMenu] = useState(false);
  const moreRef = useRef<HTMLButtonElement>(null);
  return (
    <header className="flow-head">
      <div className="flow-head-main">
        <InlineText className="flow-name" value={flow.name} label="Flow name" allowEmpty={false} maxLength={120} onCommit={(name) => void commit({ summary: `Renamed flow ${flow.name} to ${name}`, flows: [{ id: flow.id, name }] })} />
        <InlineText multiline className="flow-summary" value={flow.summary} placeholder="What this scenario shows" label="Flow summary" maxLength={280} onCommit={(summary) => void commit({ summary: `Edited flow ${flow.name}`, flows: [{ id: flow.id, summary }] })} />
      </div>
      <button ref={moreRef} type="button" className="icon-btn" aria-label="Flow actions" onClick={() => setMenu(true)}>
        <Ellipsis size={16} strokeWidth={1.7} />
      </button>
      {menu && (
        <Menu
          anchor={moreRef}
          align="end"
          onClose={() => setMenu(false)}
          items={[
            {
              label: 'Delete flow',
              icon: Trash,
              danger: true,
              onSelect: async () => {
                const ok = await confirmAction({ title: `Delete ${flow.name}?`, body: `Its ${plural(flow.steps.length, 'step')} go with it.`, confirmLabel: 'Delete', danger: true });
                if (ok) {
                  setState({ flowId: undefined, stepIndex: null });
                  void commit({ summary: `Deleted flow ${flow.name}`, remove: { flows: [flow.id] } });
                }
              },
            },
          ]}
        />
      )}
    </header>
  );
}

function FlowRail() {
  const flows = useStore((s) => s.model.flows);
  const flowId = useStore((s) => s.flowId);
  const open = useStore((s) => s.dataRailOpen);
  const [filter, setFilter] = useState('');
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const list = useMemo(
    () => flows.filter((f) => !filter.trim() || fuzzyScore(filter, `${f.name} ${f.summary}`) >= 0).sort((a, b) => a.name.localeCompare(b.name)),
    [flows, filter],
  );
  const create = () => {
    const n = name.trim();
    setAdding(false);
    setName('');
    if (!n) return;
    const id = uniqueId(slugify(n), new Set(flows.map((f) => f.id)));
    void commit({ summary: `Added flow ${n}`, flows: [{ id, name: n, steps: [] }] });
    openFlow(id);
  };
  return (
    <Rail
      open={open}
      onToggle={() => setState((s) => ({ dataRailOpen: !s.dataRailOpen }))}
      label="Flows"
      filter={filter}
      onFilter={setFilter}
      placeholder="Filter flows"
      footer={
        adding ? (
          <input
            className="rail-new"
            autoFocus
            value={name}
            placeholder="Flow name"
            aria-label="New flow name"
            onChange={(e) => setName(e.target.value)}
            onBlur={create}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === 'Enter') create();
              if (e.key === 'Escape') {
                setName('');
                setAdding(false);
              }
            }}
          />
        ) : (
          <button type="button" className="rail-add" onClick={() => setAdding(true)}>
            <Plus size={14} strokeWidth={1.8} aria-hidden />
            New flow
          </button>
        )
      }
    >
      <ul>
        {list.map((f) => (
          <li key={f.id}>
            <button type="button" className={cx('rail-item', 'is-flow', f.id === flowId && 'is-active')} onClick={() => openFlow(f.id)}>
              <span className="rail-item-name">{f.name}</span>
              <span className="rail-item-meta">{f.steps.length}</span>
            </button>
          </li>
        ))}
      </ul>
      {!list.length && <p className="rail-empty">{filter ? 'No flow matches.' : 'No flows yet.'}</p>}
    </Rail>
  );
}
