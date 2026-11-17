// Puts the files the server reads at run time beside its bundle, in dist/server/assets:
// the fonts diagrams are rasterised with, the web font embedded in SVG exports, and the SVG rasteriser.
// Run after the server is bundled (see `build:server` and the Dockerfile).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'dist/server/assets');
const webFonts = path.join(root, 'node_modules/@fontsource-variable/ibm-plex-sans/files');

fs.rmSync(out, { recursive: true, force: true });
fs.cpSync(path.join(root, 'assets'), out, { recursive: true });
for (const subset of ['latin', 'latin-ext']) {
  const file = `ibm-plex-sans-${subset}-wght-normal.woff2`;
  fs.copyFileSync(path.join(webFonts, file), path.join(out, 'fonts', file));
}
fs.copyFileSync(path.join(root, 'node_modules/@resvg/resvg-wasm/index_bg.wasm'), path.join(out, 'resvg.wasm'));
