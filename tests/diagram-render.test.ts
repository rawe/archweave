import { describe, expect, it } from 'vitest';
import { fitShape, grownToFit, minSize } from '../src/shared/diagram/fit.ts';
import type { Rect } from '../src/shared/diagram/geometry.ts';
import { layoutShape, textFrame } from '../src/shared/diagram/layout.ts';
import { type RouteShape, routeConnectors } from '../src/shared/diagram/route.ts';
import { buildScene, drawingOrder, renderSvg } from '../src/shared/diagram/scene.ts';
import { paintShape } from '../src/shared/diagram/shapes.ts';
import { shapeStyle } from '../src/shared/diagram/style.ts';
import { type SvgNode, toSvgString } from '../src/shared/diagram/svg.ts';
import { measureText, wrapText } from '../src/shared/diagram/text.ts';
import { contrast, LIGHT_THEME, THEMES } from '../src/shared/diagram/theme.ts';
import { Diagram, FILLS, Model, SHAPE_KINDS, TONES } from '../src/shared/model.ts';

describe('text metrics', () => {
  it('measures with the real advance widths of IBM Plex Sans', () => {
    expect(measureText('', 14)).toBe(0);
    expect(measureText('iii', 14)).toBeLessThan(measureText('mmm', 14));
    expect(measureText('Hello', 28)).toBeCloseTo(2 * measureText('Hello', 14));
    expect(measureText('Hello', 14, 600)).toBeGreaterThan(measureText('Hello', 14, 400));
    // H 741, e 568, l 258, l 258, o 598 units of 1000 in the regular weight.
    expect(measureText('Hello', 10)).toBeCloseTo(measureText('H', 10) + measureText('e', 10) + 2 * measureText('l', 10) + measureText('o', 10));
  });

  it('knows Latin-1, Latin Extended-A, arrows and dashes, and falls back for the rest', () => {
    for (const char of 'äößéçñŁčř→←↔–—…“”') expect(measureText(char, 1000), char).not.toBe(measureText('\u{10ffff}', 1000));
    expect(measureText('設', 10)).toBe(10);
  });

  it('breaks at spaces and keeps every line within the width', () => {
    const lines = wrapText('The quick brown fox jumps over the lazy dog', 90, 14);
    expect(lines.length).toBeGreaterThan(1);
    expect(lines.join(' ')).toBe('The quick brown fox jumps over the lazy dog');
    for (const line of lines) expect(measureText(line, 14)).toBeLessThanOrEqual(90);
  });

  it('splits a word wider than the line and loses no character', () => {
    const lines = wrapText('Donaudampfschifffahrtsgesellschaft', 60, 14);
    expect(lines.length).toBeGreaterThan(2);
    expect(lines.join('')).toBe('Donaudampfschifffahrtsgesellschaft');
    for (const line of lines) expect(measureText(line, 14)).toBeLessThanOrEqual(60);
  });

  it('keeps explicit line breaks, empty lines included', () => {
    expect(wrapText('one\ntwo\n\nfour', 500, 14)).toEqual(['one', 'two', '', 'four']);
    expect(wrapText('', 100, 14)).toEqual(['']);
    expect(wrapText('wide', 0.5, 14)).toEqual(['w', 'i', 'd', 'e']);
  });
});

/** The box the painted text of a shape occupies, from the same metrics the painter uses. */
function textBox(input: Parameters<typeof layoutShape>[0]): Rect | undefined {
  const { lines } = layoutShape(input);
  if (!lines.length) return undefined;
  const boxes = lines.map((line) => {
    const width = measureText(line.text, line.size, line.weight);
    const left = line.anchor === 'middle' ? line.x - width / 2 : line.x;
    return { left, right: left + width, top: line.y - line.size, bottom: line.y + line.size * 0.3 };
  });
  const x = Math.min(...boxes.map((b) => b.left));
  const y = Math.min(...boxes.map((b) => b.top));
  return { x, y, w: Math.max(...boxes.map((b) => b.right)) - x, h: Math.max(...boxes.map((b) => b.bottom)) - y };
}

const LONG = 'Pneumonoultramicroscopicsilicovolcanoconiosis and a few more words to wrap over lines';

describe('fit and minimum size', () => {
  it('sizes every kind on the grid with the text inside', () => {
    for (const kind of SHAPE_KINDS) {
      for (const size of ['s', 'm', 'l'] as const) {
        for (const label of ['', 'Api', LONG, 'Two\nlines']) {
          const input = { kind, label, detail: label ? 'A detail sentence of some length' : undefined, size };
          const { w, h } = fitShape(input);
          expect(w % 8, `${kind} w`).toBe(0);
          expect(h % 8, `${kind} h`).toBe(0);
          expect(layoutShape({ ...input, w, h }).fits, `${kind} ${size} "${label}"`).toBe(true);
          const box = textBox({ ...input, w, h });
          if (!box) continue;
          expect(box.x, `${kind} left`).toBeGreaterThanOrEqual(0);
          expect(box.x + box.w, `${kind} right`).toBeLessThanOrEqual(w);
          expect(box.y, `${kind} top`).toBeGreaterThanOrEqual(0);
          expect(box.y + box.h, `${kind} bottom`).toBeLessThanOrEqual(h);
        }
      }
    }
  });

  it('gives short labels one comfortable size and long ones more room', () => {
    expect(fitShape({ kind: 'box', label: 'Api' })).toEqual(fitShape({ kind: 'box', label: 'Db' }));
    expect(fitShape({ kind: 'box', label: LONG }).h).toBeGreaterThan(fitShape({ kind: 'box', label: 'Api' }).h);
    expect(fitShape({ kind: 'group', label: 'Group' })).toEqual({ w: 320, h: 200 });
  });

  it('asks for more height as a shape gets narrower', () => {
    for (const kind of SHAPE_KINDS) {
      const wide = minSize({ kind, w: 320 }, LONG);
      const narrow = minSize({ kind, w: 120 }, LONG);
      expect(narrow.h, kind).toBeGreaterThan(wide.h);
      expect(layoutShape({ kind, label: LONG, w: 120, h: narrow.h }).fits, kind).toBe(true);
      expect(layoutShape({ kind, label: LONG, w: 120, h: narrow.h - 2 }).fits, kind).toBe(false);
    }
  });

  it('grows a stored shape that is too small and leaves a fitting one alone', () => {
    const fitting = { kind: 'box' as const, w: 200, h: 80 };
    expect(grownToFit(fitting, 'Api')).toBe(fitting);
    for (const kind of SHAPE_KINDS) {
      const grown = grownToFit({ kind, w: 30, h: 10, detail: 'with detail text' }, LONG);
      expect(layoutShape({ kind, label: LONG, detail: 'with detail text', w: grown.w, h: grown.h }).fits, kind).toBe(true);
    }
  });

  it('keeps the text frame inside a diamond', () => {
    const frame = textFrame('diamond', 200, 120);
    const cornerReach = Math.abs(frame.left - 100) / 100 + Math.abs(frame.top - 60) / 60;
    expect(cornerReach).toBeLessThan(1);
  });
});

describe('style and palette', () => {
  it('resolves the defaults of a kind and lets the author override them', () => {
    expect(shapeStyle({ kind: 'box' }, LIGHT_THEME)).toMatchObject({ outline: 'solid', tone: 'neutral', fill: 'plain', fillColor: '#ffffff', labelSize: 14, labelWeight: 500 });
    expect(shapeStyle({ kind: 'note' }, LIGHT_THEME)).toMatchObject({ tone: 'amber', fill: 'tint' });
    expect(shapeStyle({ kind: 'text' }, LIGHT_THEME).stroke).toBeUndefined();
    expect(shapeStyle({ kind: 'text' }, LIGHT_THEME).fillColor).toBeUndefined();
    expect(shapeStyle({ kind: 'group' }, LIGHT_THEME).labelWeight).toBe(600);
    expect(shapeStyle({ kind: 'box', tone: 'red', fill: 'solid', size: 'l' }, LIGHT_THEME)).toMatchObject({ fillColor: LIGHT_THEME.tones.red.solid, ink: '#ffffff', labelSize: 18 });
  });

  it('passes WCAG AA for all text on every fill in both themes', () => {
    for (const theme of Object.values(THEMES)) {
      for (const tone of TONES) {
        const paint = theme.tones[tone];
        for (const fill of FILLS) {
          const style = shapeStyle({ kind: 'box', tone, fill }, theme);
          const behind = style.fillColor ?? theme.canvas;
          expect(contrast(style.ink, behind), `${theme.name} ${tone} ${fill} label`).toBeGreaterThanOrEqual(4.5);
          expect(contrast(style.detailInk, behind), `${theme.name} ${tone} ${fill} detail`).toBeGreaterThanOrEqual(4.5);
        }
        for (const behind of [theme.canvas, theme.surface, paint.tint]) expect(contrast(paint.text, behind), `${theme.name} ${tone} text`).toBeGreaterThanOrEqual(4.5);
      }
      expect(contrast(theme.ink2, theme.canvas)).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('keeps the diagram blue and amber apart from the cobalt and saffron of the app chrome', () => {
    for (const theme of Object.values(THEMES)) {
      const used = Object.values(theme.tones).flatMap((paint) => Object.values(paint));
      for (const reserved of ['#2456e6', '#d99a0b', '#6e96ff', '#f2bc3d']) expect(used).not.toContain(reserved);
    }
  });
});

const box = (id: string, x: number, y: number, w = 120, h = 48): RouteShape => ({ id, x, y, w, h });

/** Whether the segment from p to q passes through the inside of a rectangle. */
function crosses(rect: Rect, p: { x: number; y: number }, q: { x: number; y: number }): boolean {
  for (let i = 0; i <= 40; i++) {
    const x = p.x + ((q.x - p.x) * i) / 40;
    const y = p.y + ((q.y - p.y) * i) / 40;
    if (x > rect.x + 0.5 && x < rect.x + rect.w - 0.5 && y > rect.y + 0.5 && y < rect.y + rect.h - 0.5) return true;
  }
  return false;
}

function crossesAny(points: { x: number; y: number }[], rects: Rect[]): boolean {
  return points.slice(1).some((q, i) => rects.some((rect) => crosses(rect, points[i]!, q)));
}

describe('connector routing', () => {
  it('picks the sides that face each other', () => {
    const shapes = [box('a', 0, 0), box('right', 300, 0), box('below', 0, 200), box('left', -300, 0), box('above', 0, -200)];
    const routes = routeConnectors(
      shapes,
      ['right', 'below', 'left', 'above'].map((to) => ({ id: to, from: 'a', to })),
    );
    expect([routes.get('right')!.fromSide, routes.get('right')!.toSide]).toEqual(['right', 'left']);
    expect([routes.get('below')!.fromSide, routes.get('below')!.toSide]).toEqual(['bottom', 'top']);
    expect([routes.get('left')!.fromSide, routes.get('left')!.toSide]).toEqual(['left', 'right']);
    expect([routes.get('above')!.fromSide, routes.get('above')!.toSide]).toEqual(['top', 'bottom']);
  });

  it('follows the reading direction for shapes placed diagonally, and pinned sides always', () => {
    const shapes = [box('a', 0, 0), box('b', 300, 200)];
    const connector = { id: 'c', from: 'a', to: 'b' };
    expect(routeConnectors(shapes, [connector], { direction: 'down' }).get('c')!.fromSide).toBe('bottom');
    expect(routeConnectors(shapes, [connector], { direction: 'right' }).get('c')!.fromSide).toBe('right');
    const pinned = routeConnectors(shapes, [{ ...connector, fromSide: 'top', toSide: 'right' }]).get('c')!;
    expect([pinned.fromSide, pinned.toSide]).toEqual(['top', 'right']);
    expect(pinned.points[0]!.y).toBeLessThan(0);
    expect(pinned.points.at(-1)!.x).toBeGreaterThan(420);
  });

  it('collapses to one straight segment between aligned shapes and leaves a gap at both ends', () => {
    const route = routeConnectors([box('a', 0, 0), box('b', 300, 0)], [{ id: 'c', from: 'a', to: 'b' }]).get('c')!;
    expect(route.points).toHaveLength(2);
    expect(route.points[0]!.y).toBe(route.points[1]!.y);
    expect(route.points[0]!.x).toBeGreaterThan(120);
    expect(route.points[1]!.x).toBeLessThan(300);
    expect(route.path).not.toContain('Q');
  });

  it('straightens a slightly offset pair and bends a far offset one at right angles', () => {
    const near = routeConnectors([box('a', 0, 0), box('b', 300, 16)], [{ id: 'c', from: 'a', to: 'b' }]).get('c')!;
    expect(near.points).toHaveLength(2);
    const far = routeConnectors([box('a', 0, 0), box('b', 300, 160)], [{ id: 'c', from: 'a', to: 'b' }], { direction: 'right' }).get('c')!;
    expect(far.points).toHaveLength(4);
    far.points.slice(1).forEach((q, i) => expect(q.x === far.points[i]!.x || q.y === far.points[i]!.y).toBe(true));
    expect(far.path).toContain('Q');
  });

  it('spreads several connectors along one side, in the order of their targets', () => {
    const shapes = [box('hub', 200, 0, 200, 56), box('l', 0, 200), box('m', 240, 200), box('r', 480, 200)];
    const routes = routeConnectors(shapes, [
      { id: 'to-r', from: 'hub', to: 'r' },
      { id: 'to-l', from: 'hub', to: 'l' },
      { id: 'to-m', from: 'hub', to: 'm' },
    ]);
    const starts = ['to-l', 'to-m', 'to-r'].map((id) => routes.get(id)!.points[0]!.x);
    expect(starts[0]).toBeLessThan(starts[1]!);
    expect(starts[1]).toBeLessThan(starts[2]!);
    expect(new Set(starts).size).toBe(3);
    for (const x of starts) {
      expect(x).toBeGreaterThan(200);
      expect(x).toBeLessThan(400);
    }
  });

  it('runs a pair of opposite connectors side by side', () => {
    const routes = routeConnectors(
      [box('a', 0, 0), box('b', 300, 0)],
      [
        { id: 'there', from: 'a', to: 'b' },
        { id: 'back', from: 'b', to: 'a' },
      ],
    );
    const there = routes.get('there')!;
    const back = routes.get('back')!;
    expect(there.points).toHaveLength(2);
    expect(back.points).toHaveLength(2);
    expect(there.points[0]!.y).not.toBe(back.points[0]!.y);
  });

  it('never runs a line through its own two end shapes', () => {
    const sides = ['top', 'right', 'bottom', 'left'] as const;
    const a = box('a', 0, 0);
    for (const [x, y] of [[300, 0], [300, 200], [0, 200], [-300, 200], [-300, 0], [-300, -200], [0, -200], [300, -200], [140, 90], [60, 120]] as const) {
      const b = box('b', x, y);
      for (const route of ['elbow', 'curve'] as const) {
        for (const fromSide of [undefined, ...sides]) {
          for (const toSide of [undefined, ...sides]) {
            if (route === 'curve' && (fromSide || toSide)) continue;
            const g = routeConnectors([a, b], [{ id: 'c', from: 'a', to: 'b', route, fromSide, toSide }]).get('c')!;
            expect(crossesAny(g.points, [a, b]), `${route} to ${x},${y} ${fromSide}/${toSide}: ${JSON.stringify(g.points)}`).toBe(false);
          }
        }
      }
      const straight = routeConnectors([a, b], [{ id: 'c', from: 'a', to: 'b', route: 'straight' }]).get('c')!;
      expect(crossesAny(straight.points, [a, b])).toBe(false);
    }
  });

  it('connects a shape to the group around it from the inside, and to itself with a loop', () => {
    const shapes = [{ ...box('group', 0, 0, 400, 300), kind: 'group' as const }, box('inner', 40, 100)];
    const inside = routeConnectors(shapes, [{ id: 'c', from: 'inner', to: 'group' }]).get('c')!;
    expect(inside.fromSide).toBe('left');
    expect(inside.points.at(-1)!.x).toBeGreaterThan(0);
    expect(inside.points.at(-1)!.x).toBeLessThan(40);
    const loop = routeConnectors(shapes, [{ id: 'c', from: 'inner', to: 'inner' }]).get('c')!;
    expect(loop.points.length).toBeGreaterThan(2);
    expect(crossesAny(loop.points, [shapes[1]!])).toBe(false);
  });

  it('places the label on the line and off the end shapes when there is room', () => {
    const a = box('a', 0, 0);
    const b = box('b', 400, 0);
    const route = routeConnectors([a, b], [{ id: 'c', from: 'a', to: 'b', label: 'publishes events' }]).get('c')!;
    const label = route.label!;
    expect(label.lines).toEqual(['publishes events']);
    expect(label.x).toBeGreaterThan(120);
    expect(label.x + label.w).toBeLessThan(400);
    expect(label.y + label.h / 2).toBeCloseTo(24, 0);
    expect(label.w).toBeGreaterThanOrEqual(measureText('publishes events', 12));
  });

  it('draws arrowheads for the chosen ends and skips connectors with a missing shape', () => {
    const shapes = [box('a', 0, 0), box('b', 300, 0)];
    const heads = (ends: 'arrow' | 'both' | 'none') => routeConnectors(shapes, [{ id: 'c', from: 'a', to: 'b', ends }]).get('c')!.heads;
    expect(heads('arrow')).toHaveLength(1);
    expect(heads('arrow')[0]).toMatchObject({ dx: 1, dy: 0 });
    expect(heads('both')).toHaveLength(2);
    expect(heads('none')).toHaveLength(0);
    expect(routeConnectors(shapes, [{ id: 'c', from: 'a', to: 'gone' }]).size).toBe(0);
  });
});

const sample = Diagram.parse({
  id: 'sample',
  name: 'Sample <diagram> & more',
  shapes: [
    { id: 'api', kind: 'box', text: 'Api & "gateway"', x: 0, y: 0, w: 144, h: 56, parent: 'frame' },
    { id: 'frame', kind: 'group', text: 'Platform', x: -40, y: -60, w: 520, h: 180 },
    { id: 'db', kind: 'cylinder', text: 'Orders', detail: 'PostgreSQL', x: 300, y: -8, w: 120, h: 80, parent: 'frame' },
    { id: 'linked', kind: 'pill', x: 0, y: 200, w: 120, h: 40, link: { type: 'element', id: 'el' } },
  ],
  connectors: [
    { id: 'reads', from: 'api', to: 'db', label: 'reads <fast>' },
    { id: 'dangling', from: 'api', to: 'nowhere' },
  ],
});
const model = Model.parse({ elements: [{ id: 'el', kind: 'service', name: 'Linked name' }], diagrams: [sample] });

function wellFormed(markup: string): void {
  const open: string[] = [];
  for (const [, closing, tag, , selfClosing] of markup.matchAll(/<(\/?)([a-zA-Z]+)((?:\s+[a-zA-Z:-]+="[^"<]*")*)\s*(\/?)>/g)) {
    if (selfClosing) continue;
    if (closing) expect(open.pop()).toBe(tag);
    else open.push(tag!);
  }
  expect(open).toEqual([]);
  expect(markup.replace(/<\/?[a-zA-Z]+(?:\s+[a-zA-Z:-]+="[^"<]*")*\s*\/?>/g, '')).not.toMatch(/[<>]/);
}

describe('svg output', () => {
  it('serialises and escapes paint nodes', () => {
    const node: SvgNode = { tag: 'g', attrs: { id: 'a"b' }, children: [{ tag: 'text', attrs: { x: 1.23456, y: -0 }, text: '1 < 2 & 3' }, { tag: 'rect', attrs: { width: 10 } }] };
    expect(toSvgString(node)).toBe('<g id="a&quot;b"><text x="1.23" y="0">1 &lt; 2 &amp; 3</text><rect width="10"/></g>');
  });

  it('paints a shape in its own coordinates', () => {
    const nodes = paintShape({ kind: 'box', w: 160, h: 64, detail: 'detail' }, 'Label', LIGHT_THEME);
    expect(nodes.map((n) => n.tag)).toEqual(['rect', 'text', 'text']);
    expect(nodes[0]!.attrs).toMatchObject({ x: 0.625, y: 0.625, width: 158.75, height: 62.75, fill: '#ffffff', stroke: LIGHT_THEME.tones.neutral.stroke });
    expect(nodes[1]).toMatchObject({ text: 'Label', attrs: { x: 80, 'text-anchor': 'middle', 'font-weight': 500, fill: LIGHT_THEME.ink } });
    expect(nodes[2]).toMatchObject({ text: 'detail', attrs: { 'font-weight': 400, fill: LIGHT_THEME.ink2 } });
    expect(paintShape({ kind: 'text', w: 100, h: 30 }, 'Plain', LIGHT_THEME).map((n) => n.tag)).toEqual(['text']);
  });

  it('draws groups first, outer before inner, then shapes in their order', () => {
    const order = drawingOrder([
      { id: 'a', kind: 'box' as const, parent: 'inner' },
      { id: 'inner', kind: 'group' as const, parent: 'outer' },
      { id: 'b', kind: 'note' as const },
      { id: 'outer', kind: 'group' as const },
    ]);
    expect(order.map((s) => s.id)).toEqual(['outer', 'inner', 'a', 'b']);
  });

  it('builds a scene with labels resolved and dangling connectors dropped', () => {
    const scene = buildScene(sample, model, LIGHT_THEME);
    expect(scene.shapes.map((s) => s.shape.id)).toEqual(['frame', 'api', 'db', 'linked']);
    expect(scene.shapes.at(-1)!.label).toBe('Linked name');
    expect(scene.connectors.map((c) => c.connector.id)).toEqual(['reads']);
    expect(scene.bounds).toEqual({ x: -40, y: -60, w: 520, h: 300 });
  });

  it('renders a well-formed standalone document sized to the content', () => {
    const scene = buildScene(sample, model, LIGHT_THEME);
    const markup = renderSvg(scene, { padding: 20 });
    wellFormed(markup);
    expect(markup).toMatch(/^<svg xmlns="http:\/\/www.w3.org\/2000\/svg" width="560" height="340" viewBox="-60 -80 560 340"/);
    expect(markup).toContain('<title>Sample &lt;diagram&gt; &amp; more</title>');
    expect(markup).toContain('>Api &amp; &quot;gateway&quot;</text>');
    expect(markup).toContain('>reads &lt;fast&gt;</text>');
    expect(markup).toContain('>Linked name</text>');
    expect(markup).toContain(`<rect x="-60" y="-80" width="560" height="340" fill="${LIGHT_THEME.canvas}"/>`);
    expect(markup.indexOf('>Platform<')).toBeLessThan(markup.indexOf('>Orders<'));
    expect(markup.indexOf('>Orders<')).toBeLessThan(markup.indexOf('>reads'));
    expect(renderSvg(scene, { padding: 20 })).toBe(markup);
  });

  it('honours background and font options', () => {
    const scene = buildScene(sample, model, THEMES.dark);
    expect(renderSvg(scene)).toContain(`fill="${THEMES.dark.canvas}"`);
    expect(renderSvg(scene, { background: 'transparent' })).not.toMatch(/<rect x="-72" y="-92"/);
    expect(renderSvg(scene, { background: 'white' })).toContain('height="244" fill="#ffffff"'.replace('244', String(300 + 64)));
    const withFont = renderSvg(scene, { fontCss: '@font-face{font-family:x}' });
    expect(withFont).toContain('<style>@font-face{font-family:x}</style>');
    wellFormed(withFont);
  });

  it('renders an empty diagram', () => {
    const empty = Diagram.parse({ id: 'empty', name: 'Empty' });
    wellFormed(renderSvg(buildScene(empty, model, LIGHT_THEME)));
  });
});
