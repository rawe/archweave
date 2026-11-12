import { describe, expect, it } from 'vitest';
import { fuzzyFilter, fuzzyScore } from '../../src/web/lib/fuzzy.ts';
import { highlightLines } from '../../src/web/code/highlight.ts';

describe('fuzzy', () => {
  it('ranks word starts and substrings above scattered matches', () => {
    const items = ['Order service', 'Payment gateway', 'src/web/state/store.ts', 'Model store'];
    expect(fuzzyFilter(items, 'store', (s) => s)[0]).toBe('Model store');
    expect(fuzzyScore('osv', 'Order service')).toBeGreaterThan(0);
    expect(fuzzyScore('xyz', 'Order service')).toBe(-1);
  });
});

describe('highlightLines', () => {
  it('keeps one entry per source line and balances spans across breaks', () => {
    const lines = highlightLines('const a = `x\ny`;\nlet b = 1;', 'typescript');
    expect(lines).toHaveLength(3);
    for (const l of lines) expect((l.match(/<span/g) ?? []).length).toBe((l.match(/<\/span>/g) ?? []).length);
  });
});
