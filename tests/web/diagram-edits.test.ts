import { afterEach, describe, expect, it } from 'vitest';
import { Model, type Snapshot } from '../../src/shared/model.ts';
import { flushNudge, nudgeSelection } from '../../src/web/diagrams/actions.ts';
import { editedText, getEditor } from '../../src/web/diagrams/editor.ts';
import { getState, setState } from '../../src/web/state/store.ts';

describe('ending a text edit', () => {
  it('writes nothing when the editor was not touched, so a change that arrived meanwhile stays', () => {
    expect(editedText({ initial: 'Old', draft: 'Old' }, 'Agent edit')).toBeUndefined();
  });

  it('writes what the human typed, also over a change that arrived meanwhile', () => {
    expect(editedText({ initial: 'Old', draft: 'Mine ' }, 'Agent edit')).toBe('Mine');
    expect(editedText({ initial: 'Old', draft: 'Old!' }, 'Old')).toBe('Old!');
    expect(editedText({ initial: 'Old', draft: '' }, 'Old')).toBe('');
  });

  it('keeps a linked shape on its live name unless the human wrote something else', () => {
    expect(editedText({ initial: 'Billing', draft: 'Billing ' }, '', 'Billing')).toBeUndefined();
    expect(editedText({ initial: 'Billing', draft: 'Invoices' }, '', 'Billing')).toBe('Invoices');
  });
});

describe('a nudge waiting to be committed', () => {
  const shape = (x: number) => ({ id: 'a', text: 'A', x, y: 0, w: 112, h: 48 });
  const model = Model.parse({
    diagrams: [
      { id: 'one', name: 'One', shapes: [shape(0)] },
      { id: 'two', name: 'Two', shapes: [shape(400)] },
    ],
  });
  const snapshot: Snapshot = { revision: 1, model, layout: {} };
  const diagram = (id: string) => getState().model.diagrams.find((d) => d.id === id)!;

  afterEach(() => {
    flushNudge();
    setState({ server: null, pending: [], diagramId: undefined, selectedShapeIds: [] });
  });

  it('lands in the diagram it was made in, at once, when another diagram opens', () => {
    setState({ server: snapshot, model, pending: [], perspective: 'diagrams', diagramId: 'one', selectedShapeIds: ['a'] });
    expect(nudgeSelection(8, 0)).toBe(true);
    expect(getEditor().overrides.a).toEqual({ x: 8, y: 0 });
    setState({ diagramId: 'two', selectedShapeIds: [] });
    expect(getState().pending.map((p) => p.cs.diagrams?.[0]?.id)).toEqual(['one']);
    expect(diagram('one').shapes[0]!.x).toBe(8);
    expect(diagram('two').shapes[0]!.x).toBe(400);
    expect(getEditor().overrides.a).toBeUndefined();
  });

  it('is committed before another edit starts, and never to the diagram open at flush time', () => {
    setState({ server: snapshot, model, pending: [], perspective: 'diagrams', diagramId: 'one', selectedShapeIds: ['a'] });
    nudgeSelection(0, 8);
    nudgeSelection(0, 8);
    setState({ diagramId: 'two' });
    flushNudge();
    expect(getState().pending).toHaveLength(1);
    expect(diagram('one').shapes[0]!.y).toBe(16);
    expect(diagram('two').shapes[0]!.y).toBe(0);
  });
});
