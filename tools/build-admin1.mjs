// Turns the big Natural Earth admin-1 file into the small table the map
// builders use: real regional borders for the countries that are cut into
// several provinces (China, Russia, the USA, Canada).
//
// Why this file exists: a country used to be split by straight bisectors
// between a handful of seeds, which drew perfect straight lines across whole
// continents. Real state/oblast borders look like a map instead of a diagram.
//
// Usage (the source is 63 MB, so it is not committed):
//   mkdir -p .cache && curl -L -H 'Accept: application/vnd.github.raw' \
//     https://api.github.com/repos/martynafford/natural-earth-geojson/git/blobs/<sha> \
//     -o .cache/ne_10m_admin_1_states_provinces.json
//   node tools/build-admin1.mjs
//
// Source: Natural Earth 10m admin-1 states/provinces, public domain.
// Output: src/data/admin1.json (plain lon/lat rings, simplified).
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

const SOURCE = process.env.NE_ADMIN1 ?? resolve(root, '.cache/ne_10m_admin_1_states_provinces.json');
const TARGET = resolve(root, 'src/data/admin1.json');

// Only countries that are split into more than one province. Everything else
// is a single polygon and needs no internal borders.
const WANTED = new Set(['CN', 'RU', 'US', 'CA']);

// Douglas–Peucker on [lon, lat]; tolerance in degrees. 0.02° is about 2 km and
// invisible at the zoom the game is played at.
const TOLERANCE = 0.08;
// Rings smaller than this (square degrees) are islands nobody will ever click.
const MIN_AREA = 0.004;

function simplify(points, tolerance) {
  if (points.length <= 4) return points;
  const sq = tolerance * tolerance;
  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;
  const stack = [[0, points.length - 1]];
  while (stack.length) {
    const [first, last] = stack.pop();
    if (last - first < 2) continue;
    const [ax, ay] = points[first];
    const [bx, by] = points[last];
    const dx = bx - ax;
    const dy = by - ay;
    const len = dx * dx + dy * dy;
    let index = -1;
    let maxDist = 0;
    for (let i = first + 1; i < last; i += 1) {
      const [px, py] = points[i];
      let dist;
      if (len < 1e-18) {
        dist = (px - ax) ** 2 + (py - ay) ** 2;
      } else {
        const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len));
        dist = (px - (ax + dx * t)) ** 2 + (py - (ay + dy * t)) ** 2;
      }
      if (dist > maxDist) {
        maxDist = dist;
        index = i;
      }
    }
    if (maxDist > sq) {
      keep[index] = 1;
      stack.push([first, index], [index, last]);
    }
  }
  return points.filter((_, i) => keep[i]);
}

const ringArea = (ring) => {
  let s = 0;
  for (let i = 0, n = ring.length; i < n; i += 1) {
    const [x1, y1] = ring[i];
    const [x2, y2] = ring[(i + 1) % n];
    s += x1 * y2 - x2 * y1;
  }
  return Math.abs(s) / 2;
};

const source = JSON.parse(readFileSync(SOURCE, 'utf8'));
const out = {};
let kept = 0;
let pointsBefore = 0;
let pointsAfter = 0;

for (const feature of source.features) {
  const props = feature.properties ?? {};
  const iso = props.iso_a2;
  if (!WANTED.has(iso)) continue;
  const name = props.name ?? props.name_local;
  if (!name) continue;
  const geometry = feature.geometry;
  if (!geometry) continue;
  const polygons = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;
  const rings = [];
  for (const poly of polygons) {
    for (const raw of poly) {
      let ring = raw.map(([lon, lat]) => [lon, lat]);
      pointsBefore += ring.length;
      if (ringArea(ring) < MIN_AREA) continue;
      ring = simplify(ring, TOLERANCE);
      // Close the ring, rounding to 3 decimals (~100 m) keeps the file small.
      if (ring.length < 3) continue;
      const rounded = ring.map(([lon, lat]) => [Math.round(lon * 100) / 100, Math.round(lat * 100) / 100]);
      pointsAfter += rounded.length;
      if (ringArea(rounded) < MIN_AREA / 2) continue;
      rings.push(rounded);
    }
  }
  if (!rings.length) continue;
  if (!out[iso]) out[iso] = [];
  out[iso].push({ name, rings });
  kept += 1;
}

mkdirSync(dirname(TARGET), { recursive: true });
writeFileSync(
  TARGET,
  `${JSON.stringify({
    generatedAt: new Date().toISOString(),
    source: 'Natural Earth 10m admin-1 states/provinces (public domain)',
    tolerance: TOLERANCE,
    countries: out,
  })}\n`,
);
console.log(
  `admin1: ${kept} units, ${pointsBefore} -> ${pointsAfter} points, ${(JSON.stringify(out).length / 1024).toFixed(0)} KB`,
);
