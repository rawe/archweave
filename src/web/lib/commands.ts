/** Commands the global keyboard, palette and menus send to whichever canvas is active. */
export type CanvasCommand = 'compose' | 'tidy' | 'fit' | 'zoom-in' | 'zoom-out' | 'zoom-reset' | 'open-selected';

const listeners = new Set<(cmd: CanvasCommand) => void>();

export function sendCanvasCommand(cmd: CanvasCommand) {
  listeners.forEach((l) => l(cmd));
}

export function onCanvasCommand(listener: (cmd: CanvasCommand) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
