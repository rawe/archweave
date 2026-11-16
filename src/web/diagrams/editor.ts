/** What the diagram editor is in the middle of. Lives beside the model store; nothing here is persisted. */
import { create } from 'zustand';
import type { DiagramShape, ShapeKind } from '../../shared/model.ts';
import type { Box, Guide } from './geometry.ts';

/** The id of a shape being placed and named, before it exists in the model. Never a valid model id. */
export const DRAFT_ID = '+new';

export interface TextEdit {
  target: 'shape' | 'connector';
  /** The diagram the edited item belongs to; the edit lands there even if another one is open by then. */
  diagramId: string;
  id: string;
  /** What the editor showed when it opened. */
  initial: string;
  draft: string;
}

/**
 * The text to store when an edit of existing text ends, or undefined when nothing should be written:
 * an untouched editor writes nothing, so a change that arrived meanwhile (an agent edit) is kept; a linked
 * shape left showing its live name keeps showing it. When the human did type, the human's text wins.
 */
export function editedText(edit: Pick<TextEdit, 'initial' | 'draft'>, stored: string, live?: string): string | undefined {
  if (edit.draft === edit.initial) return undefined;
  const text = edit.draft.trim();
  if (live !== undefined && !stored && text === live) return undefined;
  return text === stored ? undefined : text;
}

export interface EditorState {
  /** The shape kind the next click on the canvas places. */
  armed: ShapeKind | null;
  editing: TextEdit | null;
  /** A shape being placed: shown on the canvas with its text open, committed when the text is. */
  placing: { shape: DiagramShape; from?: string } | null;
  /** Live geometry of shapes in the middle of a resize or a nudge. */
  overrides: Record<string, Partial<Box>>;
  guides: Guide[];
  /** The group a dragged shape would drop into. */
  dropGroup: string | null;
  /** A connector end being dragged to another shape. */
  reconnect: { id: string; end: 'from' | 'to'; point: { x: number; y: number }; over?: string } | null;
  /** Fit the view once the open diagram has changed next (after a seed or a tidy, whose result the server decides). */
  fitNext: boolean;
  /** The rail shows its field for a new diagram's name. */
  naming: boolean;
}

export const useEditor = create<EditorState>(() => ({
  armed: null,
  editing: null,
  placing: null,
  overrides: {},
  guides: [],
  dropGroup: null,
  reconnect: null,
  fitNext: false,
  naming: false,
}));

export const setEditor = useEditor.setState;
export const getEditor = useEditor.getState;

export function arm(kind: ShapeKind | null) {
  setEditor({ armed: kind });
}

export function setOverride(id: string, box: Partial<Box>) {
  setEditor((s) => ({ overrides: { ...s.overrides, [id]: { ...s.overrides[id], ...box } } }));
}

export function clearOverrides(ids: Iterable<string>) {
  const next = { ...getEditor().overrides };
  for (const id of ids) delete next[id];
  setEditor({ overrides: next });
}

export function resetEditor() {
  setEditor({ armed: null, editing: null, placing: null, overrides: {}, guides: [], dropGroup: null, reconnect: null });
}
