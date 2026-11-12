import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Persistence } from '../src/server/persistence.ts';
import { Store, type StoreChange } from '../src/server/store.ts';
import { tempDir, waitFor } from './helpers.ts';

const open: Persistence[] = [];

async function boot(dataDir: string, debounceMs = 10) {
  const logs: string[] = [];
  const persistence = new Persistence(dataDir, { debounceMs, defaultName: 'shop', log: (m) => logs.push(m) });
  open.push(persistence);
  const store = new Store(await persistence.load());
  persistence.attach(store);
  return { persistence, store, logs };
}

const settle = () => new Promise((r) => setTimeout(r, 250));
const readModel = (dir: string) => JSON.parse(fs.readFileSync(path.join(dir, 'model.json'), 'utf8'));

afterEach(async () => {
  await Promise.all(open.splice(0).map((p) => p.close()));
});

describe('Persistence', () => {
  it('creates the data directory with a .gitignore for state/', async () => {
    const dir = path.join(tempDir(), '.archweave');
    const { store } = await boot(dir);
    expect(fs.readFileSync(path.join(dir, '.gitignore'), 'utf8')).toBe('state/\n');
    expect(store.snapshot().model.name).toBe('shop');
  });

  it('writes a stable, sorted file without default values and reads it back', async () => {
    const dir = tempDir();
    const first = await boot(dir);
    first.store.apply(
      {
        summary: 'Seed',
        elements: [
          { id: 'zeta', kind: 'service', name: 'Zeta', codeRefs: [{ path: 'z.ts' }] },
          { id: 'alpha', kind: 'store', name: 'Alpha', summary: 'Keeps things.' },
        ],
        relations: [{ from: 'zeta', to: 'alpha', kind: 'writes' }],
        layout: { 'structure:root': { zeta: { x: 1.04, y: 2 }, alpha: { x: 0, y: 0 } } },
      },
      'agent',
    );
    await first.persistence.flush();

    const text = fs.readFileSync(path.join(dir, 'model.json'), 'utf8');
    expect(text).toBe(
      `${JSON.stringify(
        {
          version: 1,
          name: 'shop',
          elements: [
            { id: 'alpha', kind: 'store', name: 'Alpha', summary: 'Keeps things.', status: 'planned' },
            { id: 'zeta', kind: 'service', name: 'Zeta', codeRefs: [{ path: 'z.ts' }] },
          ],
          relations: [{ id: 'zeta-writes-alpha', from: 'zeta', to: 'alpha', kind: 'writes' }],
        },
        null,
        2,
      )}\n`,
    );
    expect(fs.readFileSync(path.join(dir, 'layout.json'), 'utf8')).toBe(
      `${JSON.stringify({ 'structure:root': { alpha: { x: 0, y: 0 }, zeta: { x: 1, y: 2 } } }, null, 2)}\n`,
    );
    const journal = fs.readFileSync(path.join(dir, 'state', 'journal.jsonl'), 'utf8').trim().split('\n');
    expect(journal.map((l) => JSON.parse(l).summary)).toEqual(['Seed']);

    await first.persistence.close();
    const second = await boot(dir);
    expect(second.store.snapshot().model).toEqual(
      expect.objectContaining({ elements: expect.arrayContaining(first.store.snapshot().model.elements) }),
    );
    expect(second.store.currentRevision).toBe(1);
    second.store.apply({ elements: [{ id: 'alpha', summary: 'Keeps things.' }] }, 'human');
    await second.persistence.flush();
    expect(fs.readFileSync(path.join(dir, 'model.json'), 'utf8')).toBe(text);
  });

  it('reloads when model.json changes on disk and broadcasts', async () => {
    const dir = tempDir();
    const { store, persistence } = await boot(dir);
    store.apply({ elements: [{ id: 'a', kind: 'service', name: 'A' }] }, 'human');
    await persistence.flush();
    await new Promise((r) => setTimeout(r, 250));
    expect(store.currentRevision).toBe(1);

    const changes: StoreChange[] = [];
    store.subscribe((c) => changes.push(c));
    const edited = JSON.parse(fs.readFileSync(path.join(dir, 'model.json'), 'utf8'));
    edited.elements.push({ id: 'b', kind: 'store', name: 'B' });
    fs.writeFileSync(path.join(dir, 'model.json'), JSON.stringify(edited));

    await waitFor(() => changes.length > 0);
    expect(changes[0]!.cause).toBe('reload');
    expect(store.currentRevision).toBe(2);
    expect(store.snapshot().model.elements.map((e) => e.id)).toEqual(['a', 'b']);
    expect(store.canUndo()).toBe(false);
  });

  it('ignores unreadable edits on disk', async () => {
    const dir = tempDir();
    const { store } = await boot(dir);
    fs.writeFileSync(path.join(dir, 'model.json'), '{ not json');
    await new Promise((r) => setTimeout(r, 300));
    expect(store.currentRevision).toBe(0);
  });

  it('reloads only the document that changed on disk and keeps pending edits', async () => {
    const dir = tempDir();
    const { store, persistence } = await boot(dir, 600);
    store.apply({ elements: [{ id: 'a', kind: 'service', name: 'A' }] }, 'human');
    await persistence.flush();
    await settle();

    fs.writeFileSync(path.join(dir, 'layout.json'), JSON.stringify({ 'structure:root': { a: { x: 5, y: 5 } } }));
    store.apply({ elements: [{ id: 'b', kind: 'store', name: 'B' }] }, 'human');
    await waitFor(() => store.snapshot().layout['structure:root']?.a?.x === 5);
    expect(store.snapshot().model.elements.map((e) => e.id)).toEqual(['a', 'b']);
    await persistence.flush();
    expect(readModel(dir).elements.map((e: { id: string }) => e.id)).toEqual(['a', 'b']);
  });

  it('keeps an unsaved edit when model.json changes on disk at the same time', async () => {
    const dir = tempDir();
    const { store, persistence, logs } = await boot(dir, 600);
    store.apply({ elements: [{ id: 'a', kind: 'service', name: 'A' }] }, 'human');
    await persistence.flush();
    await settle();

    fs.writeFileSync(path.join(dir, 'model.json'), JSON.stringify({ name: 'shop', elements: [{ id: 'x', kind: 'service', name: 'X' }] }));
    store.apply({ elements: [{ id: 'b', kind: 'store', name: 'B' }] }, 'human');
    await waitFor(() => logs.some((l) => /model\.json changed on disk while an edit was not saved yet/.test(l)));
    expect(store.snapshot().model.elements.map((e) => e.id)).toEqual(['a', 'b']);
    await persistence.flush();
    expect(readModel(dir).elements.map((e: { id: string }) => e.id)).toEqual(['a', 'b']);
  });

  it('retries a failed write on the next flush', async () => {
    const dir = tempDir();
    const { store, persistence } = await boot(dir);
    store.apply({ elements: [{ id: 'a', kind: 'service', name: 'A' }] }, 'human');
    await persistence.flush();
    await settle();

    const target = path.join(dir, 'model.json');
    fs.rmSync(target);
    fs.mkdirSync(target);
    fs.writeFileSync(path.join(target, 'blocker'), '');
    store.apply({ elements: [{ id: 'b', kind: 'store', name: 'B' }] }, 'human');
    await expect(persistence.flush()).rejects.toThrow();
    fs.rmSync(target, { recursive: true });
    await persistence.flush();
    expect(readModel(dir).elements.map((e: { id: string }) => e.id)).toEqual(['a', 'b']);
  });

  it('writes layout.json when a removal drops layout entries', async () => {
    const dir = tempDir();
    const { store, persistence } = await boot(dir);
    store.apply(
      { elements: [{ id: 'a', kind: 'service', name: 'A' }, { id: 'b', kind: 'store', name: 'B' }], layout: { 'structure:root': { a: { x: 1, y: 1 }, b: { x: 2, y: 2 } } } },
      'human',
    );
    await persistence.flush();
    store.apply({ remove: { elements: ['b'] } }, 'human');
    await persistence.flush();
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'layout.json'), 'utf8'))).toEqual({ 'structure:root': { a: { x: 1, y: 1 } } });
  });

  it('refuses to start from a model with broken references', async () => {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, 'model.json'), JSON.stringify({ elements: [{ id: 'a', kind: 'service', name: 'A', parentId: 'gone' }] }));
    await expect(boot(dir)).rejects.toThrow(/element `a`: unknown parent `gone`/);
  });

  it('ignores a reload whose model has broken references and says why', async () => {
    const dir = tempDir();
    const { store, persistence, logs } = await boot(dir);
    store.apply({ elements: [{ id: 'a', kind: 'service', name: 'A' }] }, 'human');
    await persistence.flush();
    await settle();
    fs.writeFileSync(path.join(dir, 'model.json'), JSON.stringify({ elements: [{ id: 'a', kind: 'service', name: 'A' }, { id: 'r', kind: 'store', name: 'R', parentId: 'nope' }] }));
    await waitFor(() => logs.some((l) => /unknown parent `nope`/.test(l)));
    expect(store.currentRevision).toBe(1);
    expect(store.snapshot().model.elements.map((e) => e.id)).toEqual(['a']);
  });

  it('skips structurally invalid journal lines with a diagnostic', async () => {
    const dir = tempDir();
    const good = { revision: 4, at: '2026-01-01T00:00:00.000Z', actor: 'agent', summary: 'Seed', created: { elements: ['a'], relations: [], flows: [] }, updated: { elements: [], relations: [], flows: [] }, removed: { elements: [], relations: [], flows: [] } };
    fs.mkdirSync(path.join(dir, 'state'));
    fs.writeFileSync(
      path.join(dir, 'state', 'journal.jsonl'),
      ['null', '{"summary":"no revision"}', JSON.stringify({ ...good, revision: 'x' }), '42', '{broken', JSON.stringify(good), ''].join('\n'),
    );
    const { store, logs } = await boot(dir);
    expect(store.currentRevision).toBe(4);
    expect(store.journal()).toEqual([good]);
    expect(logs.filter((l) => /journal/.test(l))).toHaveLength(5);
    expect(logs.join('\n')).toMatch(/line 2/);
  });
});
