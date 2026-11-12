import { useEffect, useMemo, useRef } from 'react';
import type { Element } from '../../shared/model.ts';
import { registerCanvasTarget } from '../lib/canvasTarget.ts';
import { cx } from '../lib/dom.ts';
import { plural } from '../lib/format.ts';
import { navigateToElement, select, setState, useStore } from '../state/store.ts';
import { useIndex } from '../state/selectors.ts';
import { groupStructures } from './groups.ts';

/**
 * Every structure as a compact card, grouped by owner, the groups flowing into
 * as many columns as fit, like the index of a book. Nothing here is drawn on a
 * graph: it is a list to read and pick from.
 */
export function DataCatalog() {
  const index = useIndex();
  const filter = useStore((s) => s.dataFilter);
  const unseen = useStore((s) => s.unseen);
  const fresh = useStore((s) => s.fresh);
  const leaving = useStore((s) => s.leaving);
  const stale = useStore((s) => s.stale);
  const groups = useMemo(() => groupStructures(index, filter), [index, filter]);
  const staleOwners = useMemo(() => new Set(stale.filter((s) => s.ownerType === 'element').map((s) => s.ownerId)), [stale]);
  const sheet = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLDivElement>(null);

  // Structures the agent just removed fade out where they were.
  const last = useRef(new Map<string, { element: Element; owner: string }>());
  const ghosts = useMemo(() => {
    const out = new Map<string, Element[]>();
    for (const [id, { element, owner }] of last.current)
      if (leaving[id] && !index.byId.has(id)) (out.get(owner) ?? out.set(owner, []).get(owner)!).push(element);
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [leaving, index]);
  useEffect(() => {
    last.current = new Map(groups.flatMap((g) => g.items.map((element) => [element.id, { element, owner: g.owner }] as const)));
  }, [groups]);

  useEffect(() => {
    registerCanvasTarget({
      capture: async () => {
        const el = sheet.current;
        if (!el) return null;
        return { node: el, width: el.scrollWidth, height: el.scrollHeight };
      },
    });
    return () => registerCanvasTarget(null);
  }, []);

  const total = index.data.length;
  if (!total)
    return (
      <div className="catalog-empty">
        <p>No data structures yet.</p>
        <p className="catalog-empty-hint">Add one with N, or ask the agent to model the payloads and entities of this repository.</p>
      </div>
    );

  return (
    <div ref={scroller} className="catalog" aria-label="Data structures">
      <div ref={sheet} className="catalog-sheet">
        {groups.map((g) => (
          <section key={g.owner || '_'} className="catalog-group">
            <h3 className="catalog-group-title">
              {g.owner ? (
                <button type="button" className="catalog-owner" title={`Show ${g.path} in Structure`} onClick={() => navigateToElement(g.owner)}>
                  {g.name}
                </button>
              ) : (
                <span className="catalog-owner is-plain" title={g.path}>
                  {g.name}
                </span>
              )}
              <span className="catalog-count">{g.items.length}</span>
            </h3>
            <ul className="catalog-list">
              {[...g.items, ...(ghosts.get(g.owner) ?? [])].map((d) => {
                const gone = !index.byId.has(d.id);
                return (
                  <li key={d.id}>
                    <button
                      type="button"
                      className={cx('catalog-card', `status-${d.status}`, gone && 'is-leaving')}
                      onClick={() => !gone && select({ elementIds: [d.id] })}
                      title={d.summary || undefined}
                    >
                      {fresh[d.id] && <span key={fresh[d.id]} className="node-ring" aria-hidden />}
                      <span className="catalog-name">{d.name}</span>
                      {staleOwners.has(d.id) && <span className="node-stale" title="A code link no longer matches the code" />}
                      {d.format && <span className="catalog-format mono">{d.format}</span>}
                      <span className="catalog-fields" title={plural(d.fields.length, 'field')}>
                        {d.fields.length}
                      </span>
                      {unseen[d.id] && <span className="node-unseen" title="Changed by the agent" />}
                    </button>
                  </li>
                );
              })}
            </ul>
          </section>
        ))}
        {!groups.length && (
          <p className="catalog-nomatch">
            No structure matches “{filter.trim()}”.{' '}
            <button type="button" className="link-btn" onClick={() => setState({ dataFilter: '' })}>
              Clear the filter
            </button>
          </p>
        )}
      </div>
    </div>
  );
}
