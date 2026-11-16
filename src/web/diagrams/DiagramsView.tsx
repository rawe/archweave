import { useEffect, useMemo, useRef, useState } from 'react';
import { Copy, Ellipsis, ImageDown, LayoutGrid, ListPlus, Plus, Trash } from 'lucide-react';
import type { Diagram } from '../../shared/model.ts';
import { Menu } from '../chrome/primitives.tsx';
import { Rail } from '../chrome/Rail.tsx';
import { InlineText } from '../inspector/fields.tsx';
import { cx } from '../lib/dom.ts';
import { fuzzyScore } from '../lib/fuzzy.ts';
import { commit, openDiagram, setOverlay, setState, useStore } from '../state/store.ts';
import { askNewDiagram, createDiagram, deleteDiagram, duplicateDiagram, tidyDiagram } from './actions.ts';
import { DiagramCanvas } from './DiagramCanvas.tsx';
import { setEditor, useEditor } from './editor.ts';
import { SeedPicker } from './SeedPicker.tsx';

/** The Diagrams perspective: a list of drawings on the left, the open one on the canvas. */
export function DiagramsView() {
  const diagrams = useStore((s) => s.model.diagrams);
  const diagramId = useStore((s) => s.diagramId);
  const railOpen = useStore((s) => s.dataRailOpen);
  const diagram = diagrams.find((d) => d.id === diagramId);

  useEffect(() => {
    if (!diagram && diagrams.length) openDiagram([...diagrams].sort(byName)[0]!.id);
  }, [diagram, diagrams]);

  return (
    <div className={cx('diagrams-view', railOpen && 'has-rail')}>
      {diagram ? (
        <DiagramCanvas key={diagram.id} diagram={diagram} />
      ) : (
        <div className="canvas-empty-scope">
          <p>A diagram is a drawing beside the model that explains one idea, for a document or a conversation. Your agent can draw one too.</p>
          <button type="button" className="btn" onClick={askNewDiagram}>
            New diagram
          </button>
        </div>
      )}
      <DiagramRail />
      {diagram && <DiagramHeader diagram={diagram} />}
    </div>
  );
}

function byName(a: Diagram, b: Diagram): number {
  return a.name.localeCompare(b.name);
}

function DiagramHeader({ diagram }: { diagram: Diagram }) {
  const [menu, setMenu] = useState(false);
  const [seeding, setSeeding] = useState(false);
  const moreRef = useRef<HTMLButtonElement>(null);
  return (
    <header className="diagram-head">
      <div className="diagram-head-main">
        <InlineText
          className="diagram-name"
          value={diagram.name}
          label="Diagram name"
          allowEmpty={false}
          maxLength={120}
          onCommit={(name) => void commit({ summary: `Renamed diagram ${diagram.name} to ${name}`, diagrams: [{ id: diagram.id, name }] })}
        />
        <InlineText
          className="diagram-summary"
          value={diagram.summary}
          placeholder="What this drawing explains"
          label="Diagram summary"
          maxLength={280}
          onCommit={(summary) => void commit({ diagrams: [{ id: diagram.id, summary }] })}
        />
      </div>
      <button ref={moreRef} type="button" className="icon-btn" aria-label="Diagram actions" aria-haspopup="menu" onClick={() => setMenu(true)}>
        <Ellipsis size={16} strokeWidth={1.7} />
      </button>
      {menu && (
        <Menu
          anchor={moreRef}
          align="end"
          onClose={() => setMenu(false)}
          items={[
            { label: 'Add from model…', icon: ListPlus, onSelect: () => setSeeding(true) },
            { label: 'Tidy', icon: LayoutGrid, onSelect: () => void tidyDiagram(diagram) },
            { label: 'Duplicate', icon: Copy, onSelect: () => duplicateDiagram(diagram) },
            { label: 'Export image…', icon: ImageDown, onSelect: () => setOverlay('export') },
            'sep',
            { label: 'Delete diagram', icon: Trash, danger: true, onSelect: () => void deleteDiagram(diagram) },
          ]}
        />
      )}
      {seeding && <SeedPicker anchor={moreRef} diagram={diagram} onClose={() => setSeeding(false)} />}
    </header>
  );
}

function DiagramRail() {
  const diagrams = useStore((s) => s.model.diagrams);
  const diagramId = useStore((s) => s.diagramId);
  const unseen = useStore((s) => s.unseen);
  const open = useStore((s) => s.dataRailOpen);
  const naming = useEditor((s) => s.naming);
  const [filter, setFilter] = useState('');
  const [name, setName] = useState('');
  const list = useMemo(
    () => diagrams.filter((d) => !filter.trim() || fuzzyScore(filter, `${d.name} ${d.summary}`) >= 0).sort(byName),
    [diagrams, filter],
  );
  const create = () => {
    const n = name.trim();
    setEditor({ naming: false });
    setName('');
    if (n) createDiagram(n);
  };
  return (
    <Rail
      open={open}
      onToggle={() => setState((s) => ({ dataRailOpen: !s.dataRailOpen }))}
      label="Diagrams"
      filter={filter}
      onFilter={setFilter}
      placeholder="Filter diagrams"
      footer={
        naming ? (
          <input
            className="rail-new"
            autoFocus
            value={name}
            placeholder="Diagram name"
            aria-label="New diagram name"
            onChange={(e) => setName(e.target.value)}
            onBlur={create}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === 'Enter') create();
              if (e.key === 'Escape') {
                setName('');
                setEditor({ naming: false });
              }
            }}
          />
        ) : (
          <button type="button" className="rail-add" onClick={() => setEditor({ naming: true })}>
            <Plus size={14} strokeWidth={1.8} aria-hidden />
            New diagram
          </button>
        )
      }
    >
      <ul>
        {list.map((d) => (
          <li key={d.id}>
            <button type="button" className={cx('rail-item', d.id === diagramId && 'is-active')} onClick={() => openDiagram(d.id)}>
              <span className="rail-item-name">{d.name}</span>
              {unseen[`diagram:${d.id}`] && <span className="dot-agent" aria-label="Changed by the agent" />}
              <span className="rail-item-meta">{d.shapes.length}</span>
            </button>
          </li>
        ))}
      </ul>
      {!list.length && <p className="rail-empty">{filter ? 'No diagram matches.' : 'No diagrams yet.'}</p>}
    </Rail>
  );
}
