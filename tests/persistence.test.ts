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
  const store = new Store({ ...(await persistence.load()), log: (m) => logs.push(m) });
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

  describe('diagrams', () => {
    const file = (dir: string, id: string) => path.join(dir, 'diagrams', `${id}.json`);
    const read = (dir: string, id: string) => fs.readFileSync(file(dir, id), 'utf8');
    const ids = (store: Store) => store.snapshot().model.diagrams.map((d) => d.id);
    const SEED = {
      summary: 'Seed',
      elements: [{ id: 'api', kind: 'service', name: 'API' }],
      diagrams: [
        {
          name: 'Checkout overview',
          summary: 'Who talks to whom.',
          direction: 'right',
          shapes: [
            { id: 'zone', kind: 'group', text: 'Backend', x: 0, y: 0, w: 400, h: 200, outline: 'dashed' },
            { id: 'api', link: { type: 'element', id: 'api' }, parent: 'zone', x: 16.04, y: 40, w: 120, h: 48.26, tone: 'blue', fill: 'tint' },
            { id: 'a-note', kind: 'note', text: 'Two\nlines', detail: 'Later.', x: -8, y: 240, w: 120, h: 48, size: 's' },
          ],
          connectors: [{ from: 'api', to: 'a-note', label: 'see', line: 'dotted', ends: 'none', route: 'curve', tone: 'red', fromSide: 'bottom', toSide: 'top' }, { id: 'plain', from: 'a-note', to: 'zone' }],
        },
        { id: 'empty', name: 'Empty' },
      ],
    };

    async function seeded() {
      const dir = tempDir();
      const booted = await boot(dir);
      booted.store.apply(SEED, 'agent');
      await booted.persistence.flush();
      await settle();
      return { dir, ...booted };
    }

    it('writes one canonical file per diagram and keeps diagrams out of model.json', async () => {
      const { dir, store, persistence } = await seeded();
      expect(read(dir, 'checkout-overview')).toBe(`{
  "version": 1,
  "name": "Checkout overview",
  "summary": "Who talks to whom.",
  "direction": "right",
  "shapes": [
    {
      "id": "zone",
      "kind": "group",
      "text": "Backend",
      "x": 0,
      "y": 0,
      "w": 400,
      "h": 200,
      "outline": "dashed"
    },
    {
      "id": "api",
      "link": {
        "type": "element",
        "id": "api"
      },
      "parent": "zone",
      "x": 16,
      "y": 40,
      "w": 120,
      "h": 48.3,
      "tone": "blue",
      "fill": "tint"
    },
    {
      "id": "a-note",
      "kind": "note",
      "text": "Two\\nlines",
      "detail": "Later.",
      "x": -8,
      "y": 240,
      "w": 120,
      "h": 70,
      "size": "s"
    }
  ],
  "connectors": [
    {
      "id": "api-to-a-note",
      "from": "api",
      "to": "a-note",
      "label": "see",
      "line": "dotted",
      "ends": "none",
      "route": "curve",
      "tone": "red",
      "fromSide": "bottom",
      "toSide": "top"
    },
    {
      "id": "plain",
      "from": "a-note",
      "to": "zone"
    }
  ]
}
`);
      expect(read(dir, 'empty')).toBe('{\n  "version": 1,\n  "name": "Empty"\n}\n');
      expect(fs.readdirSync(path.join(dir, 'diagrams')).sort()).toEqual(['checkout-overview.json', 'empty.json']);
      expect(readModel(dir)).toEqual({ version: 1, name: 'shop', elements: [{ id: 'api', kind: 'service', name: 'API', status: 'planned' }] });

      await persistence.close();
      const second = await boot(dir);
      expect(second.store.snapshot().model.diagrams).toEqual([...store.snapshot().model.diagrams].sort((a, b) => a.id.localeCompare(b.id)));
      expect(second.logs).toEqual([]);
    });

    it('does not create the diagram directory before there is a diagram', async () => {
      const dir = tempDir();
      const { store, persistence } = await boot(dir);
      store.apply({ elements: [{ id: 'a', kind: 'service', name: 'A' }] }, 'human');
      await persistence.flush();
      expect(fs.existsSync(path.join(dir, 'diagrams'))).toBe(false);
    });

    it('writes only the files that changed and deletes the files of removed diagrams', async () => {
      const { dir, store, persistence } = await seeded();
      const stamp = () => fs.statSync(file(dir, 'empty')).mtimeMs;
      const before = stamp();
      store.apply({ diagrams: [{ id: 'checkout-overview', setShapes: [{ id: 'api', x: 32 }] }], elements: [{ id: 'api', summary: 'Serves.' }] }, 'human');
      await persistence.flush();
      expect(JSON.parse(read(dir, 'checkout-overview')).shapes[1].x).toBe(32);
      expect(stamp()).toBe(before);

      store.apply({ remove: { diagrams: ['empty'] } }, 'human');
      await persistence.flush();
      expect(fs.existsSync(file(dir, 'empty'))).toBe(false);
      store.undo();
      await persistence.flush();
      expect(read(dir, 'empty')).toBe('{\n  "version": 1,\n  "name": "Empty"\n}\n');
      expect(fs.readdirSync(path.join(dir, 'diagrams')).filter((name) => !name.endsWith('.json'))).toEqual([]);
    });

    it('reloads a diagram file that changes on disk, keeping the elements', async () => {
      const { dir, store } = await seeded();
      const changes: StoreChange[] = [];
      store.subscribe((c) => changes.push(c));
      const edited = JSON.parse(read(dir, 'empty'));
      fs.writeFileSync(file(dir, 'empty'), JSON.stringify({ ...edited, name: 'Filled', shapes: [{ id: 'x', text: 'Hand made', x: 0, y: 0, w: 100, h: 40 }] }));

      await waitFor(() => changes.length > 0);
      expect(changes[0]).toMatchObject({ cause: 'reload', modelChanged: true });
      expect(store.currentRevision).toBe(2);
      expect(store.snapshot().model.diagrams.find((d) => d.id === 'empty')).toMatchObject({ name: 'Filled', shapes: [{ id: 'x', kind: 'box', text: 'Hand made' }] });
      expect(ids(store)).toEqual(['checkout-overview', 'empty']);
      expect(store.snapshot().model.elements.map((e) => e.id)).toEqual(['api']);
      await settle();
      expect(changes).toHaveLength(1);
    });

    it('takes over diagram files added and deleted on disk, also when the directory appears later', async () => {
      const dir = tempDir();
      const { store, logs } = await boot(dir);
      fs.mkdirSync(path.join(dir, 'diagrams'));
      fs.writeFileSync(file(dir, 'first'), JSON.stringify({ name: 'First' }));
      await waitFor(() => ids(store).includes('first'));
      fs.writeFileSync(file(dir, 'second'), JSON.stringify({ version: 1, id: 'ignored', name: 'Second' }));
      await waitFor(() => ids(store).includes('second'));
      expect(ids(store)).toEqual(['first', 'second']);

      fs.rmSync(file(dir, 'first'));
      await waitFor(() => !ids(store).includes('first'));
      fs.rmSync(path.join(dir, 'diagrams'), { recursive: true });
      await waitFor(() => ids(store).length === 0);
      fs.mkdirSync(path.join(dir, 'diagrams'));
      fs.writeFileSync(file(dir, 'third'), JSON.stringify({ name: 'Third' }));
      await waitFor(() => ids(store).includes('third'));
      expect(logs).toEqual([]);
    });

    it('starts with broken diagram files next to good ones: skips what is not a diagram, repairs what is inconsistent', async () => {
      const dir = tempDir();
      fs.mkdirSync(path.join(dir, 'diagrams'));
      fs.writeFileSync(path.join(dir, 'model.json'), JSON.stringify({ name: 'shop', elements: [{ id: 'api', kind: 'service', name: 'API' }] }));
      fs.writeFileSync(file(dir, 'good'), JSON.stringify({ name: 'Good' }));
      fs.writeFileSync(file(dir, 'conflict'), '{\n<<<<<<< HEAD\n  "name": "Mine"\n=======\n  "name": "Theirs"\n>>>>>>> other\n}\n');
      fs.writeFileSync(file(dir, 'nameless'), JSON.stringify({ shapes: [] }));
      fs.writeFileSync(file(dir, 'future'), JSON.stringify({ version: 2, name: 'Future' }));
      fs.writeFileSync(file(dir, 'Not An Id'), JSON.stringify({ name: 'Odd' }));
      fs.writeFileSync(path.join(dir, 'diagrams', 'good.json.123.tmp'), 'half written');
      const damaged = { name: 'Damaged', shapes: [{ id: 'a', x: 0, y: 0, w: 10, h: 10, link: { type: 'element', id: 'gone' } }], connectors: [{ id: 'c', from: 'a', to: 'b' }] };
      fs.writeFileSync(file(dir, 'damaged'), JSON.stringify(damaged));

      const { store, persistence, logs } = await boot(dir);
      expect(ids(store)).toEqual(['damaged', 'good']);
      expect(store.snapshot().model.diagrams[0]).toMatchObject({ shapes: [{ id: 'a', text: 'gone' }], connectors: [] });
      expect(logs).toEqual([
        'archweave: skipped diagrams/Not An Id.json: the file name is not a diagram id (lowercase letters, digits, ".", "_" or "-")',
        expect.stringMatching(/^archweave: skipped diagrams\/conflict\.json: not valid JSON: /),
        'archweave: skipped diagrams/future.json: version 2 is not supported, this server reads version 1',
        expect.stringMatching(/^archweave: skipped diagrams\/nameless\.json: name: /),
        'archweave: diagram `damaged` shape `a`: unlinked from missing element `gone`, it keeps the name it showed.',
        'archweave: diagram `damaged` connector `c`: dropped, there is no shape `b` (`to`).',
      ]);

      store.apply({ diagrams: [{ id: 'good', summary: 'Edited.' }] }, 'human');
      await persistence.flush();
      expect(JSON.parse(read(dir, 'damaged'))).toEqual({ version: 1, name: 'Damaged', shapes: [{ id: 'a', text: 'gone', x: 0, y: 0, w: 10, h: 10 }] });
      expect(read(dir, 'conflict')).toMatch(/<<<<<<< HEAD/);
      expect(fs.readdirSync(path.join(dir, 'diagrams')).sort()).toEqual(['Not An Id.json', 'conflict.json', 'damaged.json', 'future.json', 'good.json', 'good.json.123.tmp', 'nameless.json']);

      fs.writeFileSync(file(dir, 'conflict'), JSON.stringify({ name: 'Resolved' }));
      await waitFor(() => ids(store).includes('conflict'));
      expect(logs).toHaveLength(6);
    });

    it('keeps the diagram when its file turns unreadable on disk', async () => {
      const { dir, store, logs } = await seeded();
      fs.writeFileSync(file(dir, 'empty'), '{ not json');
      await waitFor(() => logs.some((l) => /skipped diagrams\/empty\.json: not valid JSON/.test(l)));
      expect(ids(store)).toEqual(['checkout-overview', 'empty']);
      expect(store.currentRevision).toBe(1);
    });

    it('keeps an unsaved diagram edit when its file changes on disk, and still takes over the other files', async () => {
      const dir = tempDir();
      const { store, persistence, logs } = await boot(dir, 600);
      store.apply(SEED, 'agent');
      await persistence.flush();
      await settle();

      store.apply({ diagrams: [{ id: 'empty', summary: 'Edited here.' }, { name: 'Unsaved new' }] }, 'human');
      fs.writeFileSync(file(dir, 'empty'), JSON.stringify({ name: 'Edited outside' }));
      fs.writeFileSync(file(dir, 'checkout-overview'), JSON.stringify({ name: 'Replaced outside' }));
      await waitFor(() => store.snapshot().model.diagrams.some((d) => d.name === 'Replaced outside'));
      expect(logs.filter((l) => /changed on disk while an edit was not saved yet/.test(l))).toEqual([
        'archweave: diagrams/empty.json changed on disk while an edit was not saved yet; keeping the edit, it overwrites the file.',
      ]);
      expect(store.snapshot().model.diagrams.map((d) => [d.id, d.name, d.summary])).toEqual([
        ['checkout-overview', 'Replaced outside', ''],
        ['empty', 'Empty', 'Edited here.'],
        ['unsaved-new', 'Unsaved new', ''],
      ]);
      await persistence.flush();
      expect(JSON.parse(read(dir, 'empty'))).toEqual({ version: 1, name: 'Empty', summary: 'Edited here.' });
      expect(JSON.parse(read(dir, 'unsaved-new'))).toEqual({ version: 1, name: 'Unsaved new' });
    });

    it('keeps an edit that lands while a reload is still reading the files', async () => {
      const { dir, store, persistence, logs } = await seeded();
      const internals = persistence as unknown as { readDiagramFiles: () => Promise<unknown> };
      const read = internals.readDiagramFiles.bind(persistence);
      let landed = false;
      internals.readDiagramFiles = async () => {
        const files = await read();
        if (!landed) store.apply({ elements: [{ id: 'late', kind: 'store', name: 'Late' }] }, 'human');
        landed = true;
        return files;
      };
      fs.writeFileSync(path.join(dir, 'model.json'), JSON.stringify({ name: 'shop', elements: [{ id: 'outside', kind: 'service', name: 'Outside' }] }));
      await waitFor(() => logs.some((l) => /model\.json changed on disk while an edit was not saved yet/.test(l)));
      expect(store.snapshot().model.elements.map((e) => e.id)).toEqual(['api', 'late']);
      expect(store.canUndo()).toBe(true);
      await persistence.flush();
      expect(readModel(dir).elements.map((e: { id: string }) => e.id)).toEqual(['api', 'late']);
    });

    it('leaves a diagram file that is not canonically formatted alone and keeps following its outside edits', async () => {
      const dir = tempDir();
      const { store, persistence, logs } = await boot(dir, 600);
      store.apply(SEED, 'agent');
      await persistence.flush();
      await settle();

      const minified = JSON.stringify({ name: 'By hand', shapes: [{ id: 'x', kind: 'box', text: '', x: 0, y: 0, w: 100, h: 40 }] });
      fs.writeFileSync(file(dir, 'empty'), minified);
      await waitFor(() => store.snapshot().model.diagrams.some((d) => d.name === 'By hand'));

      store.apply({ elements: [{ id: 'api', summary: 'Unrelated.' }] }, 'human');
      await persistence.flush();
      expect(read(dir, 'empty')).toBe(minified);
      await settle();

      store.apply({ elements: [{ id: 'api', summary: 'Unrelated again, not saved yet.' }] }, 'human');
      fs.writeFileSync(file(dir, 'empty'), JSON.stringify({ name: 'By hand again' }));
      await waitFor(() => store.snapshot().model.diagrams.some((d) => d.name === 'By hand again'));
      await persistence.flush();
      expect(read(dir, 'empty')).toBe(JSON.stringify({ name: 'By hand again' }));
      expect(readModel(dir).elements[0].summary).toBe('Unrelated again, not saved yet.');
      expect(logs).toEqual([]);

      await persistence.close();
      fs.writeFileSync(file(dir, 'empty'), minified);
      const second = await boot(dir);
      second.store.apply({ elements: [{ id: 'api', summary: 'After a restart.' }] }, 'human');
      await second.persistence.flush();
      expect(read(dir, 'empty')).toBe(minified);
    });

    it('keeps a diagram whose file cannot be read: only a missing file is a deletion', async () => {
      const { dir, store, logs } = await seeded();
      fs.rmSync(file(dir, 'empty'));
      fs.mkdirSync(file(dir, 'empty'));
      fs.writeFileSync(file(dir, 'checkout-overview'), JSON.stringify({ name: 'Renamed outside' }));
      await waitFor(() => store.snapshot().model.diagrams.some((d) => d.name === 'Renamed outside'));
      expect(ids(store)).toEqual(['checkout-overview', 'empty']);
      fs.writeFileSync(file(dir, 'checkout-overview'), JSON.stringify({ name: 'Renamed again' }));
      await waitFor(() => store.snapshot().model.diagrams.some((d) => d.name === 'Renamed again'));
      expect(ids(store)).toEqual(['checkout-overview', 'empty']);
      expect(logs).toEqual([expect.stringMatching(/^archweave: skipped diagrams\/empty\.json: it cannot be read: EISDIR/)]);

      fs.rmdirSync(file(dir, 'empty'));
      await waitFor(() => !ids(store).includes('empty'));
    });

    it('keeps the diagrams when model.json is reloaded, unlinking shapes whose element is gone', async () => {
      const { dir, store } = await seeded();
      fs.writeFileSync(path.join(dir, 'model.json'), JSON.stringify({ name: 'shop', elements: [{ id: 'other', kind: 'store', name: 'Other' }] }));
      await waitFor(() => store.currentRevision === 2);
      expect(ids(store)).toEqual(['checkout-overview', 'empty']);
      expect(store.snapshot().model.diagrams[0]!.shapes[1]).toMatchObject({ id: 'api', text: 'API' });
      expect(store.snapshot().model.diagrams[0]!.shapes[1]!.link).toBeUndefined();
    });
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
    const none = { elements: [], relations: [], flows: [], diagrams: [] };
    expect(store.journal()).toEqual([{ ...good, created: { ...none, elements: ['a'] }, updated: none, removed: none }]);
    expect(logs.filter((l) => /journal/.test(l))).toHaveLength(5);
    expect(logs.join('\n')).toMatch(/line 2/);
  });
});
