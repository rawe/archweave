import { createElement, type ReactNode } from 'react';
import type { SvgNode } from '../../shared/diagram/svg.ts';

/** SVG attribute names as React wants them: `stroke-width` becomes `strokeWidth`, `class` becomes `className`. */
export function reactAttrs(attrs: SvgNode['attrs']): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  for (const [name, value] of Object.entries(attrs)) out[name === 'class' ? 'className' : name.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase())] = value;
  return out;
}

export function paintElement(node: SvgNode, key: number | string): ReactNode {
  return createElement(node.tag, { key, ...reactAttrs(node.attrs) }, node.text ?? node.children?.map(paintElement));
}

/** Draws a paint tree from the shared renderer, exactly as the image exports serialise it. */
export function Paint({ nodes }: { nodes: SvgNode[] }) {
  return <>{nodes.map(paintElement)}</>;
}
