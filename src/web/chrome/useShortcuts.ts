import { useEffect } from 'react';
import { deleteSelection } from '../state/actions.ts';
import {
  clearSelection,
  closeCode,
  getState,
  scopeOut,
  setOverlay,
  setPerspective,
  setState,
  undo,
} from '../state/store.ts';
import { sendCanvasCommand } from '../lib/commands.ts';
import { isTypingTarget } from '../lib/dom.ts';
import { toggleTheme } from '../lib/theme.ts';

/** Global keyboard map. Overlays handle their own keys and stop propagation. */
export function useShortcuts() {
  useEffect(() => {
    // The state as it was when the key went down. A focused canvas node handles Escape itself
    // (it deselects) before the event reaches the window; Escape must not then also drill out.
    let atKeyDown = getState();
    const onKeyCapture = () => {
      atKeyDown = getState();
    };
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      const s = getState();
      const modal = document.querySelector('[aria-modal="true"]');
      if (mod && e.key.toLowerCase() === 'k') {
        if (modal && s.overlay !== 'palette') return;
        e.preventDefault();
        setOverlay(s.overlay === 'palette' ? null : 'palette');
        return;
      }
      if (isTypingTarget(e.target) || e.defaultPrevented) return;
      if (modal || (s.overlay && s.overlay !== 'activity')) return;

      if (mod && e.key.toLowerCase() === 'z' && !e.shiftKey) {
        e.preventDefault();
        void undo();
        return;
      }
      if (mod && e.key.toLowerCase() === 'e') {
        e.preventDefault();
        setOverlay('export');
        return;
      }
      if (mod && e.key === 'ArrowUp') {
        e.preventDefault();
        scopeOut();
        return;
      }
      if (e.altKey || mod) return;
      if (e.shiftKey && (e.code === 'Digit1' || e.code === 'Digit0')) {
        e.preventDefault();
        sendCanvasCommand(e.code === 'Digit1' ? 'fit' : 'zoom-reset');
        return;
      }

      switch (e.key) {
        case '1':
        case '2':
        case '3':
          if (e.shiftKey) break;
          setPerspective((['structure', 'data', 'flows'] as const)[Number(e.key) - 1]!);
          return;
        case '+':
        case '=':
          sendCanvasCommand('zoom-in');
          return;
        case '-':
          sendCanvasCommand('zoom-out');
          return;
        case '?':
          setOverlay('help');
          return;
        case 'T':
          toggleTheme();
          return;
        case 'n':
        case 'N':
          if (s.perspective === 'flows') return;
          e.preventDefault();
          sendCanvasCommand('compose');
          return;
        case 'Enter':
          if (s.perspective === 'structure' && s.selection.elementIds.length === 1 && isCanvasFocus(e.target)) {
            e.preventDefault();
            sendCanvasCommand('open-selected');
          }
          return;
        case 'Backspace':
        case 'Delete':
          if (s.perspective === 'flows') return;
          e.preventDefault();
          void deleteSelection();
          return;
        case 'Escape': {
          if (s.overlay) return setOverlay(null);
          if (s.code) return closeCode();
          const before = atKeyDown;
          if (before.selection.elementIds.length || before.selection.relationIds.length || before.stepIndex !== null) return clearSelection();
          if (s.perspective === 'structure') scopeOut();
          return;
        }
        case 'ArrowRight':
        case 'ArrowLeft':
        case 'j':
        case 'k':
        case 'J':
        case 'K': {
          if (s.perspective !== 'flows' || !s.flowId) return;
          const flow = s.model.flows.find((f) => f.id === s.flowId);
          if (!flow?.steps.length) return;
          e.preventDefault();
          const forward = e.key === 'ArrowRight' || e.key.toLowerCase() === 'j';
          const current = s.stepIndex;
          const next = current === null ? (forward ? 0 : flow.steps.length - 1) : Math.max(0, Math.min(flow.steps.length - 1, current + (forward ? 1 : -1)));
          setState({ stepIndex: next, selection: { elementIds: [], relationIds: [] } });
          return;
        }
      }
    };
    window.addEventListener('keydown', onKeyCapture, true);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKeyCapture, true);
      window.removeEventListener('keydown', onKey);
    };
  }, []);
}

/** Enter on a focused button or link should click it, not drill in. */
function isCanvasFocus(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return true;
  if (target === document.body) return true;
  return !!target.closest('.react-flow') && !target.closest('button, a');
}
