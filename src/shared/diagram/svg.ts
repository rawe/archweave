/**
 * The paint tree every consumer draws from: the browser maps the nodes to React elements,
 * the exports serialise them. Attribute names are the SVG ones (`stroke-width`, not `strokeWidth`).
 */
export interface SvgNode {
  tag: string;
  attrs: Record<string, string | number>;
  children?: SvgNode[];
  text?: string;
}

export function svg(tag: string, attrs: Record<string, string | number | undefined>, children?: SvgNode[] | string): SvgNode {
  const kept: Record<string, string | number> = {};
  for (const [name, value] of Object.entries(attrs)) if (value !== undefined) kept[name] = value;
  if (typeof children === 'string') return { tag, attrs: kept, text: children };
  return children?.length ? { tag, attrs: kept, children } : { tag, attrs: kept };
}

/** A coordinate as written into paths and attributes: at most two decimals, no trailing zeros. */
export function num(value: number): string {
  const rounded = Math.round(value * 100) / 100;
  return Object.is(rounded, -0) ? '0' : String(rounded);
}

export function escapeXml(text: string): string {
  return text.replace(/[&<>"]/g, (c) => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : '&quot;'));
}

/** Serialises paint nodes to SVG markup. */
export function toSvgString(nodes: SvgNode | SvgNode[]): string {
  return (Array.isArray(nodes) ? nodes : [nodes]).map(nodeString).join('');
}

function nodeString(node: SvgNode): string {
  let out = `<${node.tag}`;
  for (const [name, value] of Object.entries(node.attrs)) out += ` ${name}="${typeof value === 'number' ? num(value) : escapeXml(value)}"`;
  if (node.text === undefined && !node.children?.length) return `${out}/>`;
  return `${out}>${node.text !== undefined ? escapeXml(node.text) : ''}${(node.children ?? []).map(nodeString).join('')}</${node.tag}>`;
}
