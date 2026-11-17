import { describe, expect, it } from 'vitest';
import { Model } from '../../src/shared/model.ts';
import { NavHistory, NO_SELECTION, readEntry, restorable, type HistoryLike, type NavSelection } from '../../src/web/state/navHistory.ts';

/** A browser history in miniature: entries with state and address, Back and Forward reporting what popstate would. */
class FakeHistory implements HistoryLike {
  entries: { state: unknown; url: string }[];
  at = 0;
  constructor(url: string, state: unknown = null) {
    this.entries = [{ state, url }];
  }
  get state() {
    return this.entries[this.at]!.state;
  }
  get url() {
    return this.entries[this.at]!.url;
  }
  pushState(state: unknown, _: string, url?: string) {
    this.entries = [...this.entries.slice(0, this.at + 1), { state: structuredClone(state), url: url ?? this.url }];
    this.at++;
  }
  replaceState(state: unknown, _: string, url?: string) {
    this.entries[this.at] = { state: structuredClone(state), url: url ?? this.url };
  }
  go(delta: number) {
    this.at += delta;
    return { state: this.state, url: this.url };
  }
  /** An address typed by hand: a new entry without state. */
  typed(url: string) {
    this.entries = [...this.entries.slice(0, this.at + 1), { state: null, url }];
    this.at++;
    return { state: null, url };
  }
}

const sel = (elementIds: string[], extra: Partial<NavSelection> = {}): NavSelection => ({ ...NO_SELECTION, elementIds, ...extra });

describe('the app history', () => {
  it('adopts the entry of a fresh load as the first one', () => {
    const h = new FakeHistory('#/structure');
    const nav = new NavHistory(h, '#/structure');
    expect(nav.restored).toBeUndefined();
    expect([nav.index, nav.canBack, nav.canForward]).toEqual([0, false, false]);
    expect(readEntry(h.state)).toMatchObject({ idx: 0, max: 0 });
  });

  it('Back after a jump restores the previous view and its selection', () => {
    const h = new FakeHistory('#/structure');
    const nav = new NavHistory(h, '#/structure');
    nav.replace(sel(['api']));
    nav.push('#/structure/api', sel(['checkout']));
    expect([nav.index, nav.canBack]).toEqual([1, true]);
    const back = h.go(-1);
    const entry = nav.pop(back.state, back.url);
    expect(back.url).toBe('#/structure');
    expect(entry?.elementIds).toEqual(['api']);
    expect([nav.index, nav.canBack, nav.canForward]).toEqual([0, false, true]);
    const forward = h.go(1);
    expect(nav.pop(forward.state, forward.url)?.elementIds).toEqual(['checkout']);
    expect([nav.index, nav.canForward]).toEqual([1, false]);
  });

  it('gives a link followed within the same view its own entry, but not a plain selection change', () => {
    const h = new FakeHistory('#/structure');
    const nav = new NavHistory(h, '#/structure');
    nav.replace(sel(['api']));
    nav.replace(sel(['db']));
    expect(h.entries).toHaveLength(1);
    expect(readEntry(h.state)?.elementIds).toEqual(['db']);
    expect(nav.push('#/structure', sel(['billing']))).toBe(true);
    expect(h.entries).toHaveLength(2);
    expect(nav.push('#/structure', sel(['billing']))).toBe(false);
    expect(h.entries).toHaveLength(2);
  });

  it('drops what Forward led to once a new move is made after going Back', () => {
    const h = new FakeHistory('#/structure');
    const nav = new NavHistory(h, '#/structure');
    nav.push('#/data/order', sel(['order']));
    nav.push('#/flows/buy', NO_SELECTION);
    let to = h.go(-1);
    nav.pop(to.state, to.url);
    to = h.go(-1);
    nav.pop(to.state, to.url);
    expect(nav.canForward).toBe(true);
    expect(h.entries).toHaveLength(3);
    nav.push('#/diagrams/map', NO_SELECTION);
    expect([nav.index, nav.max, nav.canForward]).toEqual([1, 1, false]);
    expect(h.entries).toHaveLength(2);
  });

  it('knows how far Back and Forward reach after a reload on any entry', () => {
    const h = new FakeHistory('#/structure');
    const nav = new NavHistory(h, '#/structure');
    nav.push('#/data', NO_SELECTION);
    nav.push('#/flows', NO_SELECTION);
    const to = h.go(-1);
    nav.pop(to.state, to.url);
    const reloaded = new NavHistory(h, h.url);
    expect(reloaded.restored).toMatchObject({ idx: 1, max: 2 });
    expect([reloaded.canBack, reloaded.canForward]).toEqual([true, true]);
    const back = h.go(-1);
    reloaded.pop(back.state, back.url);
    expect([reloaded.index, reloaded.max]).toEqual([0, 2]);
  });

  it('adopts an address typed by hand as the next entry, keeping Back working', () => {
    const h = new FakeHistory('#/structure');
    const nav = new NavHistory(h, '#/structure');
    nav.push('#/data', NO_SELECTION);
    const typed = h.typed('#/flows/buy');
    expect(nav.pop(typed.state, typed.url)).toBeUndefined();
    expect([nav.index, nav.max, nav.canBack, nav.canForward]).toEqual([2, 2, true, false]);
    expect(readEntry(h.state)).toMatchObject({ idx: 2, max: 2 });
  });

  it('never rewrites the entries Forward leads to when the browser moves', () => {
    const h = new FakeHistory('#/structure');
    const nav = new NavHistory(h, '#/structure');
    nav.push('#/data', sel(['order']));
    const later = structuredClone(h.entries[1]);
    const to = h.go(-1);
    nav.pop(to.state, to.url);
    expect(h.entries).toHaveLength(2);
    expect(h.entries[1]).toEqual(later);
  });

  it('ignores states the app did not write', () => {
    expect(readEntry(null)).toBeUndefined();
    expect(readEntry({ idx: 1 })).toBeUndefined();
    expect(readEntry({ idx: 1, max: 0, elementIds: [], relationIds: [], shapeIds: [] })).toMatchObject({ idx: 1, max: 1 });
  });
});

describe('restoring a selection', () => {
  const model = Model.parse({
    elements: [
      { id: 'api', kind: 'service', name: 'API' },
      { id: 'db', kind: 'store', name: 'DB' },
    ],
    relations: [{ id: 'api-uses-db', from: 'api', to: 'db' }],
    flows: [{ id: 'buy', name: 'Buy', steps: [{ from: 'api', to: 'db', label: 'save' }] }],
    diagrams: [{ id: 'map', name: 'Map', shapes: [{ id: 'a', text: 'A', x: 0, y: 0, w: 112, h: 48 }] }],
  });

  it('keeps only what still exists', () => {
    const kept = restorable(
      { elementIds: ['api', 'gone'], relationIds: ['api-uses-db', 'old'], edgeKey: 'api->db', shapeIds: ['a', 'b'], step: 0 },
      model,
      { flowId: 'buy', diagramId: 'map' },
    );
    expect(kept).toEqual({ elementIds: ['api'], relationIds: ['api-uses-db'], edgeKey: 'api->db', shapeIds: ['a'], stepIndex: 0 });
  });

  it('drops a step past the end of the flow and the thread key of vanished relations', () => {
    const kept = restorable({ elementIds: [], relationIds: ['old'], edgeKey: 'x->y', shapeIds: [], step: 3 }, model, { flowId: 'buy' });
    expect(kept).toEqual({ elementIds: [], relationIds: [], shapeIds: [], stepIndex: null });
  });
});
