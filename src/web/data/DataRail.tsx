import { useMemo, useState } from 'react';
import { Plus } from 'lucide-react';
import { Rail } from '../chrome/Rail.tsx';
import { sendCanvasCommand } from '../lib/commands.ts';
import { cx } from '../lib/dom.ts';
import { fuzzyScore } from '../lib/fuzzy.ts';
import { select, setState, useStore } from '../state/store.ts';
import { useIndex } from '../state/selectors.ts';

export function DataRail() {
  const open = useStore((s) => s.dataRailOpen);
  const selected = useStore((s) => s.selection.elementIds);
  const unseen = useStore((s) => s.unseen);
  const index = useIndex();
  const [filter, setFilter] = useState('');

  const groups = useMemo(() => {
    const q = filter.trim();
    const list = index.data.filter((d) => !q || fuzzyScore(q, `${d.name} ${d.fields.map((f) => f.name).join(' ')}`) >= 0);
    const byOwner = new Map<string, typeof list>();
    for (const d of list) {
      const owner = d.parentId && index.byId.get(d.parentId) ? d.parentId : '';
      (byOwner.get(owner) ?? byOwner.set(owner, []).get(owner)!).push(d);
    }
    return [...byOwner.entries()]
      .map(([owner, items]) => ({ owner, name: owner ? index.byId.get(owner)!.name : 'Shared', items: items.sort((a, b) => a.name.localeCompare(b.name)) }))
      .sort((a, b) => (a.owner ? 0 : 1) - (b.owner ? 0 : 1) || a.name.localeCompare(b.name));
  }, [index, filter]);

  return (
    <Rail
      open={open}
      onToggle={() => setState((s) => ({ dataRailOpen: !s.dataRailOpen }))}
      label="Data structures"
      filter={filter}
      onFilter={setFilter}
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
                  className={cx('rail-item', selected.includes(d.id) && 'is-active', d.status === 'planned' && 'is-planned')}
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
