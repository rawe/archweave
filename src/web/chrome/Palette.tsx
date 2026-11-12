import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { CircleQuestionMark, Download, FileCheck, FileCode, LayoutGrid, Maximize, Moon, Plus, Rows3, Undo2, Workflow, Network, Braces, Text } from 'lucide-react';
import { fuzzyScore } from '../lib/fuzzy.ts';
import { cx } from '../lib/dom.ts';
import { MOD, plural } from '../lib/format.ts';
import { KindIcon } from '../lib/kinds.tsx';
import { sendCanvasCommand } from '../lib/commands.ts';
import { toggleTheme } from '../lib/theme.ts';
import { checkLinks, sealLinks, unsealedLinks } from '../state/codeLinks.ts';
import { getState, navigateToElement, openCode, openFlow, setOverlay, setPerspective, toast, toggleNamesOnly, undo, useStore } from '../state/store.ts';
import { scopePath, useIndex } from '../state/selectors.ts';
import { Keys } from './primitives.tsx';

interface Entry {
  id: string;
  label: string;
  detail?: string;
  hint?: string;
  keys?: string;
  icon: ReactNode;
  group: 'Elements' | 'Data' | 'Flows' | 'Files' | 'Commands';
  mono?: boolean;
  run: () => void;
}

const ICON = { size: 15, strokeWidth: 1.6 } as const;

export function Palette() {
  const index = useIndex();
  const model = useStore((s) => s.model);
  const perspective = useStore((s) => s.perspective);
  const stale = useStore((s) => s.stale);
  const unsealed = useMemo(() => unsealedLinks(model, stale), [model, stale]);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const list = useRef<HTMLUListElement>(null);

  const entries = useMemo<Entry[]>(() => {
    const out: Entry[] = [];
    for (const el of model.elements) {
      const path = scopePath(el, index);
      out.push({
        id: `el:${el.id}`,
        label: el.name,
        detail: path || undefined,
        hint: el.kind === 'data' ? 'data' : el.kind,
        icon: <KindIcon kind={el.kind} size={15} />,
        group: el.kind === 'data' ? 'Data' : 'Elements',
        run: () => navigateToElement(el.id),
      });
    }
    for (const f of model.flows)
      out.push({ id: `flow:${f.id}`, label: f.name, detail: f.summary || undefined, hint: 'flow', icon: <Workflow {...ICON} />, group: 'Flows', run: () => openFlow(f.id) });
    const files = new Map<string, { owner: string; line?: number; ownerId: string }>();
    for (const el of model.elements) for (const r of el.codeRefs) if (!files.has(r.path)) files.set(r.path, { owner: el.name, line: r.startLine, ownerId: el.id });
    for (const r of model.relations) for (const c of r.codeRefs) if (!files.has(c.path)) files.set(c.path, { owner: 'a relation', line: c.startLine, ownerId: r.id });
    for (const [path, info] of files)
      out.push({
        id: `file:${path}`,
        label: path,
        detail: `linked from ${info.owner}`,
        icon: <FileCode {...ICON} />,
        group: 'Files',
        mono: true,
        run: () => openCode({ path, startLine: info.line, ownerId: info.ownerId }),
      });
    const cmd = (id: string, label: string, icon: ReactNode, run: () => void, keys?: string): Entry => ({ id: `cmd:${id}`, label, icon, run, keys, group: 'Commands' });
    out.push(
      cmd('structure', 'Go to Structure', <Network {...ICON} />, () => setPerspective('structure'), '1'),
      cmd('data', 'Go to Data', <Braces {...ICON} />, () => setPerspective('data'), '2'),
      cmd('flows', 'Go to Flows', <Rows3 {...ICON} />, () => setPerspective('flows'), '3'),
      cmd('new', perspective === 'data' ? 'New data structure' : 'New element', <Plus {...ICON} />, () => setTimeout(() => sendCanvasCommand('compose'), 30), 'N'),
      cmd('tidy', 'Tidy layout', <LayoutGrid {...ICON} />, () => sendCanvasCommand('tidy')),
      cmd('names-only', useStore.getState().namesOnly ? 'Show summaries on nodes' : 'Names only on nodes', <Text {...ICON} />, toggleNamesOnly),
      cmd('fit', 'Fit to screen', <Maximize {...ICON} />, () => sendCanvasCommand('fit'), '⇧ 1'),
      cmd('check-links', 'Check code links', <FileCheck {...ICON} />, () =>
        void checkLinks().then((stale) => (stale.length ? setOverlay('activity') : toast({ tone: 'info', text: 'Every code link matches the code' }))),
      ),
      ...(unsealed ? [cmd('seal-links', `Seal ${plural(unsealed, 'unchecked code link')}…`, <FileCheck {...ICON} />, () => void sealLinks())] : []),
      cmd('export', 'Export…', <Download {...ICON} />, () => setOverlay('export'), `${MOD} E`),
      cmd('theme', 'Toggle theme', <Moon {...ICON} />, toggleTheme, '⇧ T'),
      cmd('undo', 'Undo last change', <Undo2 {...ICON} />, () => void undo(), `${MOD} Z`),
      cmd('help', 'Shortcuts and help', <CircleQuestionMark {...ICON} />, () => setOverlay('help'), '?'),
    );
    return out;
  }, [model, index, perspective, unsealed]);

  const results = useMemo(() => {
    const q = query.trim();
    if (!q) {
      const { scopeId } = getState();
      const here = entries.filter((e) => e.group === 'Elements' && model.elements.find((el) => `el:${el.id}` === e.id)?.parentId === scopeId).slice(0, 8);
      const flows = entries.filter((e) => e.group === 'Flows').slice(0, 3);
      return [...here, ...flows, ...entries.filter((e) => e.group === 'Commands')];
    }
    const weight: Record<Entry['group'], number> = { Elements: 30, Data: 28, Flows: 26, Commands: 10, Files: 0 };
    return entries
      .map((e) => ({ e, score: Math.max(fuzzyScore(q, e.label), fuzzyScore(q, `${e.detail ?? ''} ${e.label}`) - 40) }))
      .filter((x) => x.score >= 0)
      .sort((a, b) => b.score + weight[b.e.group] - (a.score + weight[a.e.group]))
      .slice(0, 40)
      .map((x) => x.e);
  }, [entries, query, model.elements]);

  useEffect(() => setActive(0), [query]);
  useEffect(() => {
    list.current?.querySelector('.palette-item.is-active')?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  const run = (entry?: Entry) => {
    if (!entry) return;
    setOverlay(null);
    entry.run();
  };

  return (
    <div className="scrim scrim-top" onPointerDown={(e) => e.target === e.currentTarget && setOverlay(null)}>
      <div className="palette" role="dialog" aria-modal="true" aria-label="Search and commands">
        <input
          className="palette-input"
          autoFocus
          value={query}
          placeholder="Search elements, data, flows, files, commands"
          role="combobox"
          aria-expanded
          aria-controls="palette-list"
          aria-activedescendant={results[active] ? `pal-${active}` : undefined}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              setActive((a) => Math.min(results.length - 1, a + 1));
            } else if (e.key === 'ArrowUp') {
              e.preventDefault();
              setActive((a) => Math.max(0, a - 1));
            } else if (e.key === 'Enter') {
              e.preventDefault();
              run(results[active]);
            } else if (e.key === 'Escape') {
              e.preventDefault();
              e.stopPropagation();
              setOverlay(null);
            }
          }}
        />
        <ul className="palette-list" id="palette-list" role="listbox" ref={list}>
          {results.map((r, i) => {
            const groupStart = i === 0 || results[i - 1]!.group !== r.group;
            return (
              <li key={r.id} role="presentation">
                {groupStart && !query.trim() && <div className="palette-group">{r.group === 'Elements' ? 'Here' : r.group}</div>}
                <button
                  id={`pal-${i}`}
                  type="button"
                  role="option"
                  aria-selected={i === active}
                  className={cx('palette-item', i === active && 'is-active')}
                  onPointerMove={() => i !== active && setActive(i)}
                  onClick={() => run(r)}
                >
                  <span className="palette-icon">{r.icon}</span>
                  <span className={cx('palette-label', r.mono && 'mono')}>{r.label}</span>
                  {r.detail && <span className="palette-detail">{r.detail}</span>}
                  {r.keys ? <Keys keys={r.keys} /> : r.hint && query.trim() ? <span className="palette-hint">{r.hint}</span> : null}
                </button>
              </li>
            );
          })}
          {!results.length && <li className="palette-empty">Nothing matches “{query}”.</li>}
        </ul>
      </div>
    </div>
  );
}
