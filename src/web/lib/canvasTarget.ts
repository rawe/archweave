/** The active perspective registers how its picture can be captured for image export. */
export interface CanvasTarget {
  /** Element to render, already transformed to show everything at a readable scale. */
  capture(): Promise<{ node: HTMLElement; width: number; height: number; style?: Partial<CSSStyleDeclaration> } | null>;
}

let target: CanvasTarget | null = null;

export function registerCanvasTarget(t: CanvasTarget | null) {
  target = t;
}

export function getCanvasTarget(): CanvasTarget | null {
  return target;
}
