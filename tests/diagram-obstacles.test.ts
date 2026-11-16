import { describe, expect, it } from 'vitest';
import type { Point, Rect } from '../src/shared/diagram/geometry.ts';
import { type RouteConnector, type RouteShape, routeConnectors } from '../src/shared/diagram/route.ts';

const box = (id: string, x: number, y: number, w = 120, h = 48, extra: Partial<RouteShape> = {}): RouteShape => ({ id, x, y, w, h, ...extra });
const link = (id: string, from: string, to: string, extra: Partial<RouteConnector> = {}): RouteConnector => ({ id, from, to, ...extra });

/** Whether a polyline passes through the inside of a rectangle grown by `within`. */
function through(points: Point[], rect: Rect, within = 0): boolean {
  return points.slice(1).some((q, i) => {
    const p = points[i]!;
    for (let step = 0; step <= 200; step++) {
      const x = p.x + ((q.x - p.x) * step) / 200;
      const y = p.y + ((q.y - p.y) * step) / 200;
      if (x > rect.x - within + 0.5 && x < rect.x + rect.w + within - 0.5 && y > rect.y - within + 0.5 && y < rect.y + rect.h + within - 0.5) return true;
    }
    return false;
  });
}

const rightAngled = (points: Point[]): boolean => points.slice(1).every((q, i) => q.x === points[i]!.x || q.y === points[i]!.y);
const bends = (points: Point[]): number => points.length - 2;

/** A crowded diagram from a fixed seed: 40 shapes on a loose grid, 60 connectors between random pairs. */
function crowd(): { shapes: RouteShape[]; connectors: RouteConnector[] } {
  let seed = 7;
  const random = (): number => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const shapes = Array.from({ length: 40 }, (_, i) => box(`s${i}`, (i % 8) * 200 + Math.floor(random() * 40), Math.floor(i / 8) * 130 + Math.floor(random() * 30)));
  const connectors = Array.from({ length: 60 }, (_, i) => link(`c${i}`, `s${Math.floor(random() * 40)}`, `s${Math.floor(random() * 40)}`, i % 3 ? {} : { label: 'label' })).filter((c) => c.from !== c.to);
  return { shapes, connectors };
}

describe('routing around obstacles', () => {
  it('goes around a shape between two connected shapes, at right angles and at a distance', () => {
    const shapes = [box('a', 0, 0), box('x', 200, 0), box('b', 400, 0)];
    const route = routeConnectors(shapes, [link('c', 'a', 'b')]).get('c')!;
    expect(through(route.points, shapes[1]!, 6)).toBe(false);
    expect(rightAngled(route.points)).toBe(true);
    expect(bends(route.points)).toBe(4);
    expect([route.fromSide, route.toSide]).toEqual(['right', 'left']);
    // It leaves the direct way beside the obstacle and is back on it right after: no early turn at the end shapes.
    expect(route.points.map((p) => p.x)).toEqual([123, 188, 188, 332, 332, 397]);
    expect(route.points[0]!.y).toBe(24);
    expect(route.points.at(-1)!.y).toBe(24);
  });

  it('treats notes and free text as obstacles too', () => {
    for (const kind of ['note', 'text'] as const) {
      const shapes = [box('a', 0, 0), box('x', 200, 0, 120, 48, { kind }), box('b', 400, 0)];
      expect(through(routeConnectors(shapes, [link('c', 'a', 'b')]).get('c')!.points, shapes[1]!, 6)).toBe(false);
    }
  });

  it('leaves a route that crosses nothing exactly as it is without the other shapes', () => {
    const pair = [box('a', 0, 0), box('b', 300, 160)];
    const others = [box('far', 0, 400), box('beside', 600, 0), box('frame', -40, -40, 800, 600, { kind: 'group' })];
    for (const connector of [link('c', 'a', 'b', { label: 'reads' }), link('c', 'a', 'b', { fromSide: 'bottom', toSide: 'left' }), link('c', 'b', 'a', { ends: 'both' })]) {
      const alone = routeConnectors(pair, [connector]).get('c')!;
      const among = routeConnectors([...pair.map((s) => ({ ...s, parent: 'frame' })), ...others], [connector]).get('c')!;
      expect(among).toEqual(alone);
    }
  });

  it('crosses the frames around its own ends and goes around any other group', () => {
    const own = [box('home', 0, 0, 200, 140, { kind: 'group' }), box('a', 40, 60, 120, 48, { parent: 'home' }), box('b', 400, 60)];
    const direct = routeConnectors(own, [link('c', 'a', 'b')]).get('c')!;
    expect(direct.points).toHaveLength(2);
    expect(through(direct.points, own[0]!)).toBe(true);

    const nested = [box('outer', -40, -60, 320, 260, { kind: 'group' }), { ...own[0]!, parent: 'outer' }, own[1]!, own[2]!];
    expect(routeConnectors(nested, [link('c', 'a', 'b')]).get('c')!.points).toEqual(direct.points);

    const foreign = [box('a', 0, 60), box('other', 200, 0, 200, 168, { kind: 'group' }), box('inside', 240, 60, 120, 48, { parent: 'other' }), box('b', 480, 60)];
    const around = routeConnectors(foreign, [link('c', 'a', 'b')]).get('c')!;
    expect(through(around.points, foreign[1]!, 6)).toBe(false);
    expect(rightAngled(around.points)).toBe(true);
  });

  it('keeps pinned sides when it has to go around something', () => {
    const shapes = [box('a', 0, 0), box('x', 16, 104), box('b', 0, 208)];
    const pinned = routeConnectors(shapes, [link('c', 'a', 'b', { fromSide: 'bottom', toSide: 'top' })]).get('c')!;
    expect([pinned.fromSide, pinned.toSide]).toEqual(['bottom', 'top']);
    expect(pinned.points[0]).toEqual({ x: 60, y: 51 });
    expect(pinned.points.at(-1)).toEqual({ x: 60, y: 205 });
    expect(through(pinned.points, shapes[1]!, 6)).toBe(false);

    const sideways = routeConnectors([box('a', 0, 0), box('x', 180, 60), box('b', 120, 200)], [link('c', 'a', 'b', { fromSide: 'right', toSide: 'right' })]).get('c')!;
    expect([sideways.fromSide, sideways.toSide]).toEqual(['right', 'right']);
    expect(through(sideways.points, box('x', 180, 60), 6)).toBe(false);
  });

  it('may leave by another side when that saves a long way round, never against a pin', () => {
    // A wall right of `a`: around it from the right side is a long detour, down from the bottom is direct.
    const shapes = [box('a', 0, 0), box('wall', 160, -200, 60, 460), box('b', 0, 300)];
    const free = routeConnectors(shapes, [link('c', 'a', 'b', { toSide: 'right' })]).get('c')!;
    expect(free.toSide).toBe('right');
    expect(through(free.points, shapes[1]!, 6)).toBe(false);
    const walled = [box('a', 0, 0), box('x', 180, -60, 60, 400), box('b', 400, 0)];
    const swapped = routeConnectors(walled, [link('c', 'a', 'b')]).get('c')!;
    expect(through(swapped.points, walled[1]!, 6)).toBe(false);
    expect(bends(swapped.points)).toBeLessThanOrEqual(4);
  });

  it('gives parallel detours lanes of their own and nests them without crossing', () => {
    const shapes = [...[0, 1, 2].flatMap((i) => [box(`a${i}`, 0, i * 72), box(`b${i}`, 460, i * 72)]), box('wall', 230, -16, 120, 224)];
    const routes = routeConnectors(shapes, [0, 1, 2].map((i) => link(`c${i}`, `a${i}`, `b${i}`)));
    const segments = [0, 1, 2].map((i) => routes.get(`c${i}`)!.points).map((points) => points.slice(1).map((q, k) => [points[k]!, q] as const));
    for (const points of [0, 1, 2].map((i) => routes.get(`c${i}`)!.points)) expect(through(points, shapes[6]!, 6)).toBe(false);
    const overlap = (p: readonly [Point, Point], q: readonly [Point, Point]): boolean => {
      const level = (s: readonly [Point, Point]) => s[0].y === s[1].y;
      if (level(p) !== level(q)) return false;
      const [at, lo, hi] = level(p) ? (['y', 'x', 'x'] as const) : (['x', 'y', 'y'] as const);
      if (Math.abs(p[0][at] - q[0][at]) >= 4) return false;
      return Math.min(Math.max(p[0][hi], p[1][hi]), Math.max(q[0][hi], q[1][hi])) - Math.max(Math.min(p[0][lo], p[1][lo]), Math.min(q[0][lo], q[1][lo])) > 4;
    };
    for (let i = 0; i < 3; i++) for (let j = i + 1; j < 3; j++) for (const p of segments[i]!) for (const q of segments[j]!) expect(overlap(p, q), `c${i} on c${j}`).toBe(false);
  });

  it('falls back to the direct route when a shape is walled in', () => {
    const pair = [box('a', 0, 0), box('b', 400, 0)];
    const walls = [box('n', -80, -70, 280, 40), box('s', -80, 78, 280, 40), box('w', -80, -30, 50, 108), box('e', 150, -30, 50, 108)];
    const direct = routeConnectors(pair, [link('c', 'a', 'b')]).get('c')!;
    expect(routeConnectors([...pair, ...walls], [link('c', 'a', 'b')]).get('c')!.points).toEqual(direct.points);
  });

  it('moves a label off a shape and off another label when the line has room elsewhere', () => {
    const shapes = [box('a', 0, 0), box('b', 600, 0), box('on', 270, 14, 60, 20, { kind: 'text' })];
    const plain = routeConnectors(shapes.slice(0, 2), [link('c', 'a', 'b', { label: 'writes' })]).get('c')!.label!;
    expect(plain.x + plain.w / 2).toBeCloseTo(360, 0);
    const pinned = { fromSide: 'right', toSide: 'left' } as const;
    const two = routeConnectors(shapes.slice(0, 2), [link('c', 'a', 'b', { label: 'writes', ...pinned }), link('d', 'a', 'b', { label: 'reads', route: 'straight' })]);
    const first = two.get('c')!.label!;
    const second = two.get('d')!.label!;
    expect(first.x + first.w <= second.x || second.x + second.w <= first.x || first.y + first.h <= second.y || second.y + second.h <= first.y).toBe(true);
  });

  it('keeps every elbow clear of foreign shapes in a crowded diagram, the same on every run, within a frame', () => {
    const { shapes, connectors } = crowd();
    const routes = routeConnectors(shapes, connectors);
    expect(routes.size).toBe(connectors.length);
    for (const c of connectors) {
      const points = routes.get(c.id)!.points;
      expect(rightAngled(points), c.id).toBe(true);
      for (const s of shapes) if (s.id !== c.from && s.id !== c.to) expect(through(points, s, 4), `${c.id} through ${s.id}`).toBe(false);
    }
    expect(routeConnectors(shapes, connectors)).toEqual(routes);
    expect(routeConnectors([...shapes].reverse(), connectors).get('c5')!.points).toEqual(routes.get('c5')!.points);

    for (let i = 0; i < 5; i++) routeConnectors(shapes, connectors);
    const started = performance.now();
    for (let i = 0; i < 5; i++) routeConnectors(shapes, connectors);
    expect((performance.now() - started) / 5).toBeLessThan(120);
  });
});
