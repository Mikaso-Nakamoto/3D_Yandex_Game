// Renders a map file to SVG, flat, so the geometry can be checked without a
// browser: provinces as filled shapes, every ring outline, and the province id
// above each centroid. Long straight lines across the sea or a ring that runs
// over a whole continent are obvious here, while in the 3D view they read as a
// camera trick.
//
// Usage: node tools/map-svg.mjs src/data/map-world.json [out.svg]
import { readFileSync, writeFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';

const target = process.argv[2];
if (!target) {
  console.error('usage: node tools/map-svg.mjs <map.json> [out.svg]');
  process.exit(1);
}
const out = process.argv[3] ?? resolve('/tmp', `${basename(target, '.json')}.svg`);
const map = JSON.parse(readFileSync(resolve(target), 'utf8'));

const { width, height } = map;
const scale = Math.min(1600 / width, 900 / height);
const sx = (x) => (x + width / 2) * scale + (1600 - width * scale) / 2;
const sz = (z) => (z + height / 2) * scale + (900 - height * scale) / 2;

// A calm palette: neighbours must not look alike, so no two adjacent hues.
const palette = [
  '#5b8fd4', '#c96f6f', '#7fb069', '#c9a227', '#8a7fc4', '#4aa3a3',
  '#c47fa8', '#a8a05a', '#6f9ec9', '#b06f4a', '#7a9f7a', '#9b8bc4',
];
const fillOf = (province, index) => palette[index % palette.length];

const ringsOf = (p) => [...(p.rings ?? []), ...(p.islands ?? [])];
const pathOf = (ring) => `M${ring.map(([x, z]) => `${sx(x).toFixed(1)},${sz(z).toFixed(1)}`).join('L')}Z`;

const parts = [];
parts.push(`<rect width="1600" height="900" fill="#0d1521"/>`);
map.provinces.forEach((p, i) => {
  const d = ringsOf(p).map(pathOf).join('');
  if (!d) return;
  parts.push(`<path d="${d}" fill="${fillOf(p, i)}" fill-opacity="0.55" stroke="none"/>`);
});
// Outlines on top, thin: a ring that crosses the whole map is unmistakable.
map.provinces.forEach((p, i) => {
  const d = ringsOf(p).map(pathOf).join('');
  if (!d) return;
  parts.push(`<path d="${d}" fill="none" stroke="#cfe3f7" stroke-width="0.6" stroke-opacity="0.55"/>`);
  const [cx, cz] = p.centroid ?? [0, 0];
  parts.push(
    `<text x="${sx(cx).toFixed(1)}" y="${sz(cz).toFixed(1)}" fill="#ffffff" font-size="13" text-anchor="middle" font-family="sans-serif">${p.id}</text>`,
  );
});

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="900">${parts.join('')}</svg>`;
writeFileSync(out, svg);
console.log(`${map.provinces.length} provinces, ${width} x ${height} -> ${out}`);
