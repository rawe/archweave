import { useEffect } from 'react';
import type { ShapeKind } from '../../shared/model.ts';
import { isTypingTarget } from '../lib/dom.ts';
import { getState } from '../state/store.ts';
import { copySelection, duplicateSelection, flushNudge, nudgeSelection, pasteClip, removeShapes, reorder, selectAll } from './actions.ts';
import { clipText, parseClip } from './clipboard.ts';
import { arm, getEditor } from './editor.ts';
import { GRID } from './geometry.ts';

/** Single keys that arm a shape kind for the next click on the canvas. */
export const KIND_KEYS: Record<string, ShapeKind> = { b: 'box', g: 'group', s: 'note', t: 'text' };

const ARROWS: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };

/**
 * Editor keys act on the canvas only: not while text has focus, focus is in a panel or menu, or a dialog,
 * the palette or the export dialog is open.
 */
function blocked(target: EventTarget | null): boolean {
  const s = getState();
  if (isTypingTarget(target) || document.querySelector('[aria-modal="true"]') || (s.overlay && s.overlay !== 'activity')) return true;
  return target instanceof HTMLElement && target !== document.body && !target.closest('.canvas-diagram, .dtoolbar');
}

/**
 * The diagram editor's own keys. They run before the canvas library and the global shortcuts see the
 * event, so arrows nudge shapes instead of moving them in unsnapped steps.
 */
export function useDiagramKeys() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (blocked(e.target)) return;
      const take = () => {
        e.preventDefault();
        e.stopPropagation();
      };
      if (e.metaKey || e.ctrlKey) {
        if (e.altKey || e.shiftKey) return;
        const key = e.key.toLowerCase();
        if (key === 'd') {
          take();
          duplicateSelection();
        } else if (key === 'a') {
          take();
          selectAll();
        }
        return;
      }
      if (e.altKey) return;
      const arrow = ARROWS[e.key];
      if (arrow) {
        const step = e.shiftKey ? 1 : GRID;
        if (nudgeSelection(arrow[0] * step, arrow[1] * step)) take();
        return;
      }
      if (e.key === ']' || e.key === '[') {
        take();
        reorder(e.key === ']');
      } else if (e.key === 'Escape' && getEditor().armed) {
        take();
        arm(null);
      } else if (KIND_KEYS[e.key]) {
        take();
        const kind = KIND_KEYS[e.key]!;
        arm(getEditor().armed === kind ? null : kind);
      }
    };
    const onCopy = (e: ClipboardEvent, cut: boolean) => {
      if (blocked(document.activeElement)) return;
      const clip = copySelection();
      if (!clip || !e.clipboardData) return;
      e.preventDefault();
      e.clipboardData.setData('text/plain', clipText(clip));
      if (cut) removeShapes(getState().selectedShapeIds);
    };
    const onPaste = (e: ClipboardEvent) => {
      if (blocked(document.activeElement)) return;
      const clip = parseClip(e.clipboardData?.getData('text/plain') ?? '');
      if (!clip) return;
      e.preventDefault();
      pasteClip(clip);
    };
    const copy = (e: ClipboardEvent) => onCopy(e, false);
    const cut = (e: ClipboardEvent) => onCopy(e, true);
    window.addEventListener('keydown', onKey, true);
    document.addEventListener('copy', copy);
    document.addEventListener('cut', cut);
    document.addEventListener('paste', onPaste);
    return () => {
      flushNudge();
      window.removeEventListener('keydown', onKey, true);
      document.removeEventListener('copy', copy);
      document.removeEventListener('cut', cut);
      document.removeEventListener('paste', onPaste);
    };
  }, []);
}
