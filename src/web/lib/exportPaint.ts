/**
 * Image export serializes the DOM, and SVG paint that comes from CSS variables
 * and color-mix() does not survive that. Before a capture, every SVG shape gets
 * its resolved paint as plain attributes; the returned function puts things back.
 */
const PROPS = ['stroke', 'fill', 'stroke-width', 'stroke-dasharray', 'stroke-linecap', 'opacity'] as const;

export function inlineSvgPaint(root: HTMLElement): () => void {
  const undo: (() => void)[] = [];
  for (const el of root.querySelectorAll<SVGElement>('svg path, svg line, svg circle, svg rect, svg g')) {
    const cs = getComputedStyle(el);
    for (const prop of PROPS) {
      const value = cs.getPropertyValue(prop);
      if (!value) continue;
      const before = el.getAttribute(prop);
      el.setAttribute(prop, prop === 'stroke' || prop === 'fill' ? plainColor(value) : value);
      undo.push(() => (before === null ? el.removeAttribute(prop) : el.setAttribute(prop, before)));
    }
  }
  return () => undo.forEach((u) => u());
}

/** "color(srgb r g b / a)" (what color-mix computes to) as rgba(); anything else unchanged. */
export function plainColor(value: string): string {
  const m = /^color\(srgb\s+([\d.e-]+)\s+([\d.e-]+)\s+([\d.e-]+)(?:\s*\/\s*([\d.e-]+%?))?\)$/.exec(value.trim());
  if (!m) return value;
  const [r, g, b] = [m[1], m[2], m[3]].map((v) => Math.round(Math.min(1, Math.max(0, Number(v))) * 255));
  const alpha = m[4] === undefined ? 1 : m[4].endsWith('%') ? Number(m[4].slice(0, -1)) / 100 : Number(m[4]);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}
