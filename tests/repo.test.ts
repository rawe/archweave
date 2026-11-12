import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { Model } from '../src/shared/model.ts';
import { PathError, Repo } from '../src/server/repo.ts';
import { StaleLinks } from '../src/server/stale.ts';
import { tempDir, tempRepo } from './helpers.ts';

const SOURCE = ['export class Store {', '  apply() {}', '}', 'export function createOrder() {}', ''].join('\n');

describe('Repo', () => {
  it('normalizes paths and refuses to leave the repository or enter .git', async () => {
    const dir = tempRepo({ 'src/a.ts': SOURCE, '.git/config': '[core]' });
    const repo = new Repo(dir);
    expect(repo.normalize('./src//a.ts')).toBe('src/a.ts');
    expect(repo.normalize(path.join(dir, 'src/a.ts'))).toBe('src/a.ts');
    expect(() => repo.normalize('../outside')).toThrow(PathError);
    expect(() => repo.normalize('/etc/passwd')).toThrow(PathError);
    expect(() => repo.normalize('.git/config')).toThrow(PathError);
    await expect(repo.readFile('src/../../x')).rejects.toThrow(PathError);
  });

  it('rejects symlinks that point outside the repository', async () => {
    const outside = tempDir();
    fs.writeFileSync(path.join(outside, 'secret.txt'), 'secret');
    const dir = tempRepo({ 'a.txt': 'a' });
    fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(dir, 'link.txt'));
    await expect(new Repo(dir).readFile('link.txt')).rejects.toThrow(/outside the repository/);
  });

  it('reads text files with line count and language', async () => {
    const repo = new Repo(tempRepo({ 'src/a.ts': SOURCE }));
    expect(await repo.readFile('src/a.ts')).toEqual({ path: 'src/a.ts', exists: true, content: SOURCE, lineCount: 4, language: 'typescript' });
    expect(await repo.readFile('src/missing.ts')).toEqual({ path: 'src/missing.ts', exists: false });
  });

  it('lists files without dependencies or dot-directories and matches fuzzily', async () => {
    const repo = new Repo(
      tempRepo({ 'src/orders/service.ts': '', 'src/billing/invoice.ts': '', 'node_modules/x/index.js': '', '.cache/y': '', 'README.md': '' }),
    );
    expect(await repo.listFiles()).toEqual(['README.md', 'src/billing/invoice.ts', 'src/orders/service.ts']);
    expect((await repo.searchFiles('ordsvc'))[0]).toBe('src/orders/service.ts');
    expect(await repo.searchFiles('invoice', 1)).toEqual(['src/billing/invoice.ts']);
  });
});

describe('StaleLinks', () => {
  it('detects missing files, lines out of range and missing symbols', async () => {
    const dir = tempRepo({ 'src/a.ts': SOURCE });
    const model = Model.parse({
      elements: [
        {
          id: 'store',
          kind: 'component',
          name: 'Store',
          codeRefs: [
            { path: 'src/a.ts', symbol: 'Store.apply', startLine: 1, endLine: 3 },
            { path: 'src/a.ts', symbol: 'createOrder' },
            { path: 'src' },
            { path: 'src/gone.ts' },
            { path: 'src/a.ts', startLine: 2, endLine: 40 },
            { path: 'src/a.ts', symbol: 'Order' },
            { path: '../escape.ts' },
          ],
        },
      ],
      relations: [{ id: 'r', from: 'store', to: 'store', codeRefs: [{ path: 'src/a.ts', startLine: 9 }] }],
      flows: [{ id: 'f', name: 'F', steps: [{ from: 'store', to: 'store', label: 'x', codeRefs: [{ path: 'src/b.ts' }] }] }],
    });
    const stale = new StaleLinks(new Repo(dir));
    const links = await stale.check(model);
    expect(links.map((l) => [l.ownerType, l.ref.path, l.ref.symbol ?? l.ref.endLine ?? l.ref.startLine ?? null, l.reason])).toEqual([
      ['element', 'src/gone.ts', null, 'missing-file'],
      ['element', 'src/a.ts', 40, 'line-out-of-range'],
      ['element', 'src/a.ts', 'Order', 'symbol-not-found'],
      ['element', '../escape.ts', null, 'missing-file'],
      ['relation', 'src/a.ts', 9, 'line-out-of-range'],
      ['flow', 'src/b.ts', null, 'missing-file'],
    ]);

    fs.writeFileSync(path.join(dir, 'src/a.ts'), 'export const nothing = 1;\n');
    const future = new Date(Date.now() + 5000);
    fs.utimesSync(path.join(dir, 'src/a.ts'), future, future);
    const after = await stale.check(model);
    expect(after.filter((l) => l.ref.symbol).map((l) => [l.ref.symbol, l.reason])).toEqual([
      ['Store.apply', 'line-out-of-range'],
      ['createOrder', 'symbol-not-found'],
      ['Order', 'symbol-not-found'],
    ]);
  });
});
