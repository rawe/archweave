// Renders sample diagrams to .work/gallery as SVG and PNG, to judge the visual language by eye.
//
//   npx tsx scripts/diagram-gallery.ts
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderDiagramPng, renderDiagramSvg } from '../src/server/render.ts';
import { fitShape } from '../src/shared/diagram/fit.ts';
import { CONNECTOR_ROUTES, Diagram, FILLS, Model, OUTLINES, SHAPE_KINDS, TONES } from '../src/shared/model.ts';

type ShapeInput = Parameters<typeof Diagram.parse>[0] extends infer D ? (D extends { shapes?: (infer S)[] } ? S : never) : never;
type ConnectorInput = Parameters<typeof Diagram.parse>[0] extends infer D ? (D extends { connectors?: (infer C)[] } ? C : never) : never;

function shape(id: string, kind: (typeof SHAPE_KINDS)[number], x: number, y: number, text: string, extra: Partial<ShapeInput> = {}): ShapeInput {
  const fit = fitShape({ kind, label: text, detail: extra.detail, size: extra.size });
  return { id, kind, x, y, text, w: fit.w, h: fit.h, ...extra };
}

let connectorCount = 0;
function line(from: string, to: string, label = '', extra: Partial<ConnectorInput> = {}): ConnectorInput {
  return { id: `c${++connectorCount}`, from, to, label, ...extra };
}

function kindsAndOutlines(): Diagram {
  const shapes: ShapeInput[] = [];
  OUTLINES.forEach((outline, row) => {
    SHAPE_KINDS.forEach((kind, col) => {
      const text = kind === 'group' ? `Group, ${outline}` : kind === 'note' ? `A note, ${outline}` : kind === 'text' ? `Free text, ${outline}` : `${kind[0]!.toUpperCase()}${kind.slice(1)}`;
      const size = kind === 'group' ? { w: 144, h: 88 } : kind === 'cylinder' ? { w: 112, h: 80 } : kind === 'diamond' ? { w: 120, h: 80 } : {};
      const s = shape(`${kind}-${outline}`, kind, 0, 0, text, { outline, detail: kind === 'box' ? outline : undefined, ...size });
      shapes.push({ ...s, x: col * 176 + (144 - s.w!) / 2, y: row * 128 + (88 - s.h!) / 2 });
    });
  });
  return Diagram.parse({ id: 'kinds', name: 'Kinds and outlines', shapes });
}

function tonesAndFills(): Diagram {
  const shapes: ShapeInput[] = [];
  const connectors: ConnectorInput[] = [];
  TONES.forEach((tone, row) => {
    FILLS.forEach((fill, col) => {
      shapes.push(shape(`${tone}-${fill}`, col === 3 ? 'pill' : 'box', col * 208, row * 96, `${tone[0]!.toUpperCase()}${tone.slice(1)}`, { tone, fill, detail: `fill ${fill}`, w: 136, h: 56 }));
      if (col > 0) connectors.push(line(`${tone}-${FILLS[col - 1]}`, `${tone}-${fill}`, col === 2 ? tone : '', { tone, line: col === 1 ? 'solid' : col === 2 ? 'dashed' : 'dotted' }));
    });
    shapes.push(shape(`${tone}-group`, 'group', 4 * 208, row * 96 - 8, 'Group', { tone, w: 136, h: 72 }));
    shapes.push(shape(`${tone}-note`, 'note', 5 * 208 - 32, row * 96, 'Note', { tone, w: 104, h: 56, detail: 'tinted' }));
    shapes.push(shape(`${tone}-text`, 'text', 6 * 208 - 96, row * 96 + 12, 'Free text', { tone }));
  });
  return Diagram.parse({ id: 'tones', name: 'Tones and fills', shapes, connectors });
}

function architecture(route: (typeof CONNECTOR_ROUTES)[number]): Diagram {
  const shapes: ShapeInput[] = [
    shape('edge', 'group', 96, 120, 'Clients', { w: 440, h: 136 }),
    shape('platform', 'group', 24, 312, 'Order platform', { w: 760, h: 456, detail: 'Kubernetes, eu-central-1' }),
    shape('customer', 'actor', 280, 0, 'Customer'),
    shape('web', 'box', 128, 168, 'Web shop', { detail: 'React, Vite', w: 168, h: 64 }),
    shape('mobile', 'box', 336, 168, 'Mobile app', { detail: 'iOS and Android', w: 168, h: 64 }),
    shape('gateway', 'box', 232, 368, 'API gateway', { w: 168, h: 56, tone: 'blue', fill: 'tint' }),
    shape('orders', 'box', 64, 480, 'Order service', { detail: 'owns the order lifecycle', w: 184, h: 64 }),
    shape('billing', 'box', 392, 480, 'Billing service', { detail: 'invoices and refunds', w: 184, h: 64 }),
    shape('events', 'pill', 264, 600, 'order-events', { w: 136, h: 40, tone: 'teal', fill: 'tint' }),
    shape('worker', 'box', 248, 688, 'Notification worker', { w: 168, h: 56, outline: 'dashed' }),
    shape('ordersdb', 'cylinder', 64, 624, 'Orders', { detail: 'PostgreSQL', w: 120, h: 80 }),
    shape('ledger', 'cylinder', 424, 624, 'Ledger', { detail: 'append-only', w: 120, h: 80 }),
    shape('fraud', 'diamond', 848, 456, 'High risk?', { w: 136, h: 112 }),
    shape('provider', 'box', 840, 648, 'Payment provider', { detail: 'external', w: 152, h: 56, outline: 'dashed', fill: 'none' }),
    shape('review', 'box', 1048, 484, 'Manual review', { w: 136, h: 56, tone: 'red', fill: 'tint' }),
    shape('pci', 'note', 824, 312, 'Card data never reaches our services. The provider hands back a token.', { w: 200 }),
    shape('retry', 'note', 568, 152, 'Clients retry with the same idempotency key.', { w: 184 }),
    shape('title', 'text', 824, 8, 'Order platform', { size: 'l', detail: 'Runtime view, checkout path' }),
  ];
  const connectors: ConnectorInput[] = [
    line('customer', 'web', 'shops'),
    line('customer', 'mobile'),
    line('web', 'gateway', 'HTTPS, JSON'),
    line('mobile', 'gateway'),
    line('gateway', 'orders', 'REST'),
    line('gateway', 'billing'),
    line('orders', 'ordersdb', 'SQL'),
    line('orders', 'events', 'publishes', { line: 'dashed' }),
    line('events', 'worker', 'consumes', { line: 'dashed' }),
    line('billing', 'ledger', 'appends'),
    line('billing', 'fraud', 'charge'),
    line('fraud', 'provider', 'no', { tone: 'green' }),
    line('fraud', 'review', 'yes', { tone: 'red' }),
    line('retry', 'mobile', '', { line: 'dotted', ends: 'none', tone: 'amber' }),
    line('pci', 'fraud', '', { line: 'dotted', ends: 'none', tone: 'amber' }),
  ];
  return Diagram.parse({ id: `architecture-${route}`, name: `Order platform, ${route}`, shapes, connectors: connectors.map((c) => ({ ...c, route })) });
}

function connectorStress(): Diagram {
  const shapes: ShapeInput[] = [
    shape('hub', 'box', 320, 0, 'Hub', { w: 200, h: 56 }),
    ...[0, 1, 2, 3, 4].map((i) => shape(`leaf${i}`, 'box', i * 176, 168, `Leaf ${i + 1}`, { w: 128, h: 48 })),
    shape('a', 'box', 0, 320, 'Aligned', { w: 128, h: 48 }),
    shape('b', 'box', 240, 320, 'Aligned', { w: 128, h: 48 }),
    shape('c', 'box', 480, 344, 'Offset a little', { w: 136, h: 48 }),
    shape('d', 'box', 736, 392, 'Offset a lot', { w: 128, h: 48 }),
    shape('e', 'box', 0, 480, 'Both ways', { w: 128, h: 48 }),
    shape('f', 'box', 264, 480, 'Both ways', { w: 128, h: 48 }),
    shape('g', 'pill', 0, 600, 'Pinned right', { w: 128, h: 40 }),
    shape('h', 'box', 40, 720, 'Pinned right too', { w: 144, h: 48 }),
    shape('i', 'diamond', 280, 600, 'Decide', { w: 120, h: 88 }),
    shape('j', 'cylinder', 480, 608, 'Store', { w: 104, h: 72 }),
    shape('k', 'box', 288, 752, 'Loops back', { w: 128, h: 48 }),
    shape('l', 'box', 664, 520, 'A long label follows', { w: 144, h: 48 }),
    shape('m', 'box', 664, 720, 'Target', { w: 144, h: 48 }),
    shape('frame', 'group', 880, 0, 'A group', { w: 280, h: 240 }),
    shape('inner', 'box', 1008, 56, 'Inside', { w: 112, h: 48, parent: 'frame' }),
    shape('inner2', 'box', 912, 160, 'Also inside', { w: 112, h: 48, parent: 'frame' }),
    shape('outer', 'box', 944, 328, 'Outside', { w: 128, h: 48 }),
    shape('self', 'box', 936, 480, 'Calls itself', { w: 128, h: 48 }),
    shape('n', 'actor', 944, 616, 'Operator'),
    shape('o', 'note', 1064, 632, 'Attached to an actor'),
  ];
  const connectors: ConnectorInput[] = [
    ...[0, 1, 2, 3, 4].map((i) => line('hub', `leaf${i}`, i === 4 ? 'last' : '')),
    line('a', 'b', 'straight on'),
    line('b', 'c', 'a jog'),
    line('c', 'd'),
    line('e', 'f', 'request'),
    line('f', 'e', 'reply', { line: 'dashed' }),
    line('g', 'h', 'around', { fromSide: 'right', toSide: 'right' }),
    line('g', 'i', '', { ends: 'both' }),
    line('i', 'j', 'yes', { ends: 'none' }),
    line('i', 'k', 'no'),
    line('k', 'h', '', { fromSide: 'left', toSide: 'bottom', line: 'dotted' }),
    line('l', 'm', 'This label is long enough that it has to wrap onto a second line'),
    line('j', 'm', '', { toSide: 'left' }),
    line('inner', 'frame', 'to its group'),
    line('inner', 'inner2'),
    line('inner2', 'outer', 'leaves the group'),
    line('frame', 'd', '', { line: 'dashed' }),
    line('self', 'self', 'retry'),
    line('n', 'o', '', { ends: 'none', line: 'dotted' }),
    line('outer', 'self'),
  ];
  return Diagram.parse({ id: 'connectors', name: 'Connector stress', shapes, connectors });
}

function textStress(): Diagram {
  const long = 'Pneumonoultramicroscopicsilicovolcanoconiosis and Donaudampfschifffahrtsgesellschaftskapitän in one label';
  const shapes: ShapeInput[] = [
    shape('s', 'box', 0, 0, 'Small label', { size: 's', detail: 'detail text at the small size' }),
    shape('m', 'box', 200, 0, 'Medium label', { size: 'm', detail: 'detail text at the medium size' }),
    shape('l', 'box', 416, 0, 'Large label', { size: 'l', detail: 'detail text at the large size' }),
    shape('umlaut', 'box', 672, 0, 'Größe ändern → naïve façade', { detail: 'Łódź, Čeština, Ångström — “quoted”, 1 ≤ 2 ≠ 3' }),
    shape('long', 'box', 0, 120, long),
    shape('narrow', 'box', 216, 120, long, { w: 96, h: 48 }),
    shape('lines', 'box', 448, 120, 'First line\nSecond line\n\nAfter an empty line', { detail: 'Detail\nwith its own breaks' }),
    shape('pill', 'pill', 640, 120, 'A pill that carries rather a lot of text for a pill', { detail: 'and detail too' }),
    shape('diamond', 'diamond', 880, 112, 'Is the payment above the review threshold?'),
    shape('cylinder', 'cylinder', 0, 400, 'Customer orders archive', { detail: 'partitioned by month, retained for ten years' }),
    shape('actor', 'actor', 216, 400, 'Site reliability engineer on call', { detail: 'weekdays' }),
    shape('note', 'note', 400, 400, 'Notes are prose. They wrap at a longer line than labels, stay left-aligned and keep explicit\nline breaks.', { detail: 'Detail text sits below, quieter.' }),
    shape('text', 'text', 400, 536, 'Free text has no outline and can still wrap over several lines when it is long enough.', { tone: 'violet' }),
    shape('tiny', 'box', 1040, 400, 'Stored far too small for its text, so the renderer grows it', { w: 60, h: 20 }),
    shape('solid', 'box', 864, 400, 'Solid fill', { tone: 'violet', fill: 'solid', detail: 'light text on the tone' }),
    shape('group', 'group', 760, 520, 'A group whose title is long enough to need a second line', { w: 240, h: 136, detail: 'and a detail line under the title' }),
    shape('ls', 'pill', 0, 560, 'Small', { size: 's' }),
    shape('lm', 'pill', 104, 560, 'Medium', { size: 'm' }),
    shape('ll', 'pill', 216, 560, 'Large', { size: 'l' }),
    shape('cjk', 'box', 0, 632, '設計 · архитектура · αρχιτεκτονική'),
  ];
  return Diagram.parse({ id: 'text', name: 'Text stress', shapes });
}

function obstacles(): Diagram {
  const b = (id: string, x: number, y: number, text: string, extra: Partial<ShapeInput> = {}): ShapeInput => shape(id, 'box', x, y, text, { w: 120, h: 48, ...extra });
  const shapes: ShapeInput[] = [
    shape('t1', 'text', 0, -40, 'A box between two connected shapes', { w: 320, h: 24 }),
    b('a1', 0, 0, 'From'),
    b('x1', 200, 0, 'In the way', { tone: 'amber', fill: 'tint' }),
    b('b1', 400, 0, 'To'),

    shape('t2', 'text', 640, -40, 'Around a foreign group', { w: 320, h: 24 }),
    b('a2', 640, 40, 'From'),
    shape('g2', 'group', 824, 0, 'Not its group', { w: 216, h: 128 }),
    b('i2', 872, 48, 'Inside', { parent: 'g2' }),
    b('b2', 1104, 40, 'To'),

    shape('t3', 'text', 0, 160, 'Out of its group, around a neighbour', { w: 320, h: 24 }),
    shape('g3', 'group', 0, 200, 'Its group', { w: 200, h: 136 }),
    b('a3', 40, 256, 'From', { parent: 'g3' }),
    b('x3', 264, 256, 'Neighbour', { tone: 'amber', fill: 'tint' }),
    b('b3', 448, 256, 'To'),

    shape('t4', 'text', 640, 160, 'Parallel detours', { w: 320, h: 24 }),
    ...[0, 1, 2].flatMap((i) => [b(`a4${i}`, 640, 216 + i * 72, `From ${i + 1}`), b(`b4${i}`, 1104, 216 + i * 72, `To ${i + 1}`)]),
    b('x4', 872, 200, 'Wall', { w: 120, h: 224, tone: 'amber', fill: 'tint' }),

    shape('t5', 'text', 0, 488, 'Eight shapes, twelve connectors', { w: 320, h: 24 }),
    b('d1', 0, 536, 'Gateway'),
    b('d2', 216, 536, 'Orders'),
    b('d3', 432, 536, 'Billing'),
    b('d4', 0, 664, 'Auth'),
    b('d5', 216, 664, 'Catalog'),
    b('d6', 432, 664, 'Ledger', { kind: 'cylinder', h: 64 }),
    b('d7', 108, 792, 'Events', { kind: 'pill' }),
    b('d8', 324, 792, 'Mailer'),

    shape('t6', 'text', 640, 488, 'Pinned sides with an obstacle', { w: 320, h: 24 }),
    b('a6', 640, 536, 'Pinned bottom'),
    b('x6', 656, 640, 'In the way', { tone: 'amber', fill: 'tint' }),
    b('b6', 640, 744, 'Pinned top'),
    b('a7', 872, 536, 'Pinned right'),
    b('x7', 1040, 600, 'In the way', { tone: 'amber', fill: 'tint' }),
    b('b7', 1000, 744, 'Pinned right'),
    shape('n7', 'note', 872, 648, 'Notes are\nin the way too', { w: 120 }),
    b('c7', 872, 760, 'Below'),
  ];
  const connectors: ConnectorInput[] = [
    line('a1', 'b1', 'around'),
    line('a2', 'b2', 'past the group'),
    line('a3', 'b3', 'leaves'),
    ...[0, 1, 2].map((i) => line(`a4${i}`, `b4${i}`)),
    line('d1', 'd2'),
    line('d2', 'd3'),
    line('d1', 'd3', 'skips'),
    line('d1', 'd4'),
    line('d2', 'd5'),
    line('d3', 'd6'),
    line('d1', 'd7'),
    line('d4', 'd7'),
    line('d5', 'd7'),
    line('d2', 'd8', 'notifies'),
    line('d7', 'd8'),
    line('d4', 'd6', 'audits', { line: 'dashed' }),
    line('a6', 'b6', '', { fromSide: 'bottom', toSide: 'top' }),
    line('a7', 'b7', '', { fromSide: 'right', toSide: 'right' }),
    line('a7', 'c7'),
  ];
  return Diagram.parse({ id: 'obstacles', name: 'Obstacles', shapes, connectors });
}

const diagrams = [kindsAndOutlines(), tonesAndFills(), ...CONNECTOR_ROUTES.map(architecture), connectorStress(), textStress(), obstacles()];
const model = Model.parse({ diagrams });
const out = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../.work/gallery');
fs.mkdirSync(out, { recursive: true });

for (const diagram of diagrams) {
  for (const theme of ['light', 'dark'] as const) {
    const name = `${diagram.id}-${theme}`;
    fs.writeFileSync(path.join(out, `${name}.svg`), renderDiagramSvg(model, diagram.id, { theme })!);
    fs.writeFileSync(path.join(out, `${name}.png`), (await renderDiagramPng(model, diagram.id, { theme, scale: 2 }))!);
    console.log(name);
  }
}
fs.writeFileSync(path.join(out, 'architecture-elbow-white.png'), (await renderDiagramPng(model, 'architecture-elbow', { background: 'white', scale: 2 }))!);
fs.writeFileSync(path.join(out, 'architecture-elbow-transparent.png'), (await renderDiagramPng(model, 'architecture-elbow', { background: 'transparent', scale: 1 }))!);
console.log(`written to ${out}`);
