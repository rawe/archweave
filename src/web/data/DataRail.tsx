import { useMemo } from 'react';
import { Plus } from 'lucide-react';
import { Rail } from '../chrome/Rail.tsx';
import { sendCanvasCommand } from '../lib/commands.ts';
import { cx } from '../lib/dom.ts';
import { dataFocusId, select, setState, useStore } from '../state/store.ts';
import { useIndex } from '../state/selectors.ts';
import { groupStructures } from './groups.ts';

export function DataRail() {
  const open = useStore((s) => s.dataRailOpen);
  const focus = useStore(dataFocusId);
  const unseen = useStore((s) => s.unseen);
  const filter = useStore((s) => s.dataFilter);
  const index = useIndex();
  const groups = useMemo(() => groupStructures(index, filter), [index, filter]);

  return (
    <Rail
      open={open}
      onToggle={() => setState((s) => ({ dataRailOpen: !s.dataRailOpen }))}
      label="Data structures"
      filter={filter}
      onFilter={(dataFilter) => setState({ dataFilter })}
      placeholder="Filter structures"
      footer={
        <button type="button" className="rail-add" onClick={() => sendCanvasCommand('compose')}>
          <Plus size={14} strokeWidth={1.8} aria-hidden />
          New structure
        </button>
      }
    >
      {groups.map((g) => (
        <section key={g.owner || '_'} className="rail-group">
          <h3 className="rail-group-label">{g.name}</h3>
          <ul>
            {g.items.map((d) => (
              <li key={d.id}>
                <button
                  type="button"
                  className={cx('rail-item', focus === d.id && 'is-active', d.status === 'planned' && 'is-planned')}
                  onClick={() => select({ elementIds: [d.id] }, { reveal: true })}
                >
                  <span className="rail-item-name">{d.name}</span>
                  {unseen[d.id] && <span className="dot-agent" aria-label="Changed by the agent" />}
                  <span className="rail-item-meta">{d.fields.length}</span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      ))}
      {!groups.length && <p className="rail-empty">{filter ? 'No structure matches.' : 'No data structures yet.'}</p>}
    </Rail>
  );
}
