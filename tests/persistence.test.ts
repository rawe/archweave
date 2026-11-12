import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Persistence } from '../src/server/persistence.ts';
import { Store, type StoreChange } from '../src/server/store.ts';
import { tempDir, waitFor } from './helpers.ts';

const open: Persistence[] = [];

async function boot(dataDir: string) {
  const persistence = new Persistence(dataDir, { debounceMs: 10, defaultName: 'shop', log: () => undefined });
  open.push(persistence);
  const store = new Store(await persistence.load());
  persistence.attach(store);
  return { persistence, store };
}

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
});
