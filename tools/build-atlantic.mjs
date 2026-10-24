// Builds src/data/map-atlantic.json: the European theatre and North America on
// one map, so the game has a single "Europe + North America" mode instead of a
// separate American map.
//
// Both source maps are projections of Natural Earth data, so their rings can be
// un-projected back to lon/lat and re-projected into one Atlantic-centred frame.
// No geometry is copied from anywhere else: the source is the same public
// domain dataset the other two maps are built from.
//
// NB: src/data/map-america.json and src/data/provinces-america.js are *inputs*
// for this script only. The app no longer loads them — the game offers two map
// modes, both of them the single Atlantic map with a different set of nations —
// so do not wire them back into src/ui or src/game.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const read = (file) => JSON.parse(readFileSync(resolve(root, file), 'utf8'));

const europe = read('src/data/map.json');
const america = read('src/data/map-america.json');

// One frame for both continents: the Atlantic in the middle, the Pacific coast
// of America on the left, the Urals on the right.
const BOUNDS = { lonMin: -170, lonMax: 50, latMin: 12, latMax: 72 };
const lonMid = (BOUNDS.lonMin + BOUNDS.lonMax) / 2; // -60
const latMid = (BOUNDS.latMin + BOUNDS.latMax) / 2; // 42
const lonScale = Math.cos((latMid * Math.PI) / 180);

const round = (v, p = 3) => {
  const k = 10 ** p;
  return Math.round(v * k) / k;
};

const unproject = (map, [x, z]) => [x / map.projection.lonScale + map.projection.lonMid, map.projection.latMid - z];
const project = ([lon, lat]) => [round((lon - lonMid) * lonScale), round(latMid - lat)];

// Louisiana used the id «PL», which is Poland on the European map.
const RENAME = { PL: 'LO' };

// Only the American map is renamed: «PL» on the European map is Poland.
const renameIn = (map, id) => (map === america ? RENAME[id] ?? id : id);

/** Rounds a ring back to the Atlantic frame, dropping duplicate points. */
function convertRing(map, ring) {
  const out = [];
  for (const point of ring) {
    const xy = project(unproject(map, point));
    const last = out[out.length - 1];
    if (!last || Math.abs(last[0] - xy[0]) > 0.02 || Math.abs(last[1] - xy[1]) > 0.02) out.push(xy);
  }
  if (out.length < 3) return null;
  return out;
}

function convertProvince(map, province) {
  const rings = province.rings.map((ring) => convertRing(map, ring)).filter(Boolean);
  if (!rings.length) return null;
  const islands = (province.islands ?? []).map((ring) => convertRing(map, ring)).filter(Boolean);
  const centroid = project(unproject(map, province.centroid));
  return {
    id: renameIn(map, province.id),
    name: province.name,
    nameRu: province.nameRu,
    pop: province.pop,
    rings,
    ...(islands.length ? { islands } : {}),
    centroid,
    area: province.area,
    neighbors: province.neighbors.map((id) => renameIn(map, id)),
  };
}

const provinces = [];
for (const map of [europe, america]) {
  for (const province of map.provinces) {
    const converted = convertProvince(map, province);
    if (converted) provinces.push(converted);
  }
}

// Province ids must stay unique across the two continents.
const seen = new Set();
for (const province of provinces) {
  if (seen.has(province.id)) throw new Error(`duplicate province id after the merge: ${province.id}`);
  seen.add(province.id);
}

// Open-sea routes between the continents. The same list feeds the renderer's
// dashed sea arrows and the model's travel times.
const ATLANTIC_LINKS = [
  ['GB', 'CA'],
  ['IS', 'GL'],
  ['ES', 'CU'],
  ['PT', 'HI'],
  ['RU', 'AK'],
  ['FR', 'NE'],
];

const byId = new Map(provinces.map((p) => [p.id, p]));
for (const [a, b] of ATLANTIC_LINKS) {
  const pa = byId.get(a);
  const pb = byId.get(b);
  if (!pa || !pb) throw new Error(`sea link ${a}-${b} points at an unknown province`);
  if (!pa.neighbors.includes(b)) pa.neighbors.push(b);
  if (!pb.neighbors.includes(a)) pb.neighbors.push(a);
}

for (const province of provinces) {
  for (const neighbour of province.neighbors) {
    if (!byId.has(neighbour)) throw new Error(`${province.id} borders unknown ${neighbour}`);
    if (!byId.get(neighbour).neighbors.includes(province.id)) byId.get(neighbour).neighbors.push(province.id);
  }
  province.neighbors.sort();
}

// The same province name may exist on both maps (e.g. «Кипр»), so only the
// ids are guaranteed to be unique — names are already Russian in the data.
const width = round((BOUNDS.lonMax - BOUNDS.lonMin) * lonScale, 2);
const height = round(BOUNDS.latMax - BOUNDS.latMin, 2);

const out = {
  generatedAt: new Date().toISOString(),
  source: 'Natural Earth 110m (public domain) via world-atlas; merged from map.json and map-america.json',
  theatre: 'atlantic',
  bounds: BOUNDS,
  projection: { lonMid, latMid, lonScale: round(lonScale, 5) },
  width,
  height,
  seaLinks: ATLANTIC_LINKS,
  provinces: provinces.sort((a, b) => a.id.localeCompare(b.id)),
};

const target = resolve(root, 'src/data/map-atlantic.json');
writeFileSync(target, `${JSON.stringify(out, null, 1)}\n`);
console.log(`map-atlantic: ${provinces.length} provinces, ${width}×${height} units -> ${target}`);
