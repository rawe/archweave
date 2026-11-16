import { describe, expect, it } from 'vitest';
import { renderDiagramPng, renderDiagramSvg } from '../src/server/render.ts';
import { type ApiDeps, apiRoutes } from '../src/server/routes.ts';
import { Model } from '../src/shared/model.ts';

const model = Model.parse({
  diagrams: [
    {
      id: 'checkout',
      name: 'Checkout Flow',
      shapes: [
        { id: 'a', text: 'Größe ändern → naïve façade', x: 0, y: 0, w: 220, h: 56 },
        { id: 'b', kind: 'cylinder', text: 'Łódź', x: 0, y: 160, w: 120, h: 80 },
      ],
      connectors: [{ id: 'c', from: 'a', to: 'b', label: 'writes' }],
    },
  ],
});

const api = apiRoutes({ store: { snapshot: () => ({ model, layout: {}, revision: 1 }) } } as unknown as ApiDeps);
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function pngSize(bytes: Uint8Array): { width: number; height: number } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

describe('diagram rendering on the server', () => {
  it('embeds the web font unless asked not to, with the extended subset only when the text needs it', () => {
    const svg = renderDiagramSvg(model, 'checkout')!;
    expect(svg.match(/@font-face/g)).toHaveLength(2);
    expect(svg).toContain("font-family:'IBM Plex Sans'");
    expect(svg).toContain('url(data:font/woff2;base64,d09GMg');
    expect(renderDiagramSvg(model, 'checkout', { embedFont: false })).not.toContain('@font-face');
    const latin = Model.parse({ diagrams: [{ id: 'd', name: 'D', shapes: [{ id: 'a', text: 'Plain', x: 0, y: 0, w: 100, h: 48 }] }] });
    expect(renderDiagramSvg(latin, 'd')!.match(/@font-face/g)).toHaveLength(1);
  });

  it('rasterises at the requested scale and answers undefined for an unknown diagram', async () => {
    const one = (await renderDiagramPng(model, 'checkout', { scale: 1 }))!;
    const three = (await renderDiagramPng(model, 'checkout', { scale: 3 }))!;
    expect([...one.slice(0, 8)]).toEqual(PNG_SIGNATURE);
    expect(pngSize(three)).toEqual({ width: pngSize(one).width * 3, height: pngSize(one).height * 3 });
    expect(pngSize(one)).toEqual({ width: 220 + 64, height: 240 + 64 });
    expect(await renderDiagramPng(model, 'nope')).toBeUndefined();
    expect(renderDiagramSvg(model, 'nope')).toBeUndefined();
  });

  it('draws text with the bundled fonts: a labelled picture differs from an unlabelled one', async () => {
    const blank = Model.parse({ diagrams: [{ id: 'checkout', name: 'x', shapes: model.diagrams[0]!.shapes.map((s) => ({ ...s, text: '' })), connectors: [{ id: 'c', from: 'a', to: 'b' }] }] });
    const withText = (await renderDiagramPng(model, 'checkout', { scale: 1 }))!;
    const without = (await renderDiagramPng(blank, 'checkout', { scale: 1 }))!;
    expect(withText.length).toBeGreaterThan(without.length + 500);
  });
});

describe('GET /diagrams/:id/image', () => {
  it('serves svg by default', async () => {
    const res = await api.request('/diagrams/checkout/image');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/svg+xml; charset=utf-8');
    expect(res.headers.get('content-disposition')).toBeNull();
    const body = await res.text();
    expect(body.startsWith('<svg xmlns="http://www.w3.org/2000/svg"')).toBe(true);
    expect(body).toContain('fill="#edf0f3"');
  });

  it('serves png with theme, scale and background', async () => {
    const res = await api.request('/diagrams/checkout/image?format=png&theme=dark&scale=1&background=transparent');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect([...bytes.slice(0, 8)]).toEqual(PNG_SIGNATURE);
    expect(pngSize(bytes).width).toBe(284);
  });

  it('applies theme and background to svg and names the download after the diagram', async () => {
    const dark = await (await api.request('/diagrams/checkout/image?theme=dark')).text();
    expect(dark).toContain('fill="#12161c"');
    const white = await (await api.request('/diagrams/checkout/image?background=white')).text();
    expect(white).toContain('height="304" fill="#ffffff"');
    const res = await api.request('/diagrams/checkout/image?format=png&download=1');
    expect(res.headers.get('content-disposition')).toBe('attachment; filename="checkout-flow.png"');
  });

  it('answers 404 for an unknown diagram and 400 for bad parameters', async () => {
    const missing = await api.request('/diagrams/nope/image');
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: 'Unknown diagram `nope`' });
    for (const query of ['format=gif', 'theme=sepia', 'scale=9', 'scale=x', 'background=pink']) {
      const res = await api.request(`/diagrams/checkout/image?${query}`);
      expect(res.status, query).toBe(400);
      expect(await res.json()).toHaveProperty('error');
    }
  });
});
