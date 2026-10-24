// Builds src/data/map-world.json — the third theatre: the whole planet on one
// cylinder you can scroll through endlessly.
//
// It is assembled from three public-domain sources, all Natural Earth 110m via
// `world-atlas`, so every piece has the same stylisation:
//   1. the European map (already with Kaliningrad and Crimea cut out),
//   2. the American map (uncompressed: the world is drawn to scale, the
//      Atlantic theatre is the one that squeezes America for playability),
//   3. the rest of the world from countries-110m.json + provinces-world.js.
//
// One longitude scale is used everywhere (cos 53°, from the European map), so a
// country is exactly as wide here as on the Europe theatre.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { feature, neighbors } from 'topojson-client';
import { WORLD } from '../src/data/provinces-world.js';
import { loadAdmin1, admin1Cells } from './admin1-cells.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const read = (file) => JSON.parse(readFileSync(resolve(root, file), 'utf8'));
const round = (v, p = 3) => {
  const k = 10 ** p;
  return Math.round(v * k) / k;
};

const europe = read('src/data/map.json');
const america = read('src/data/map-america.json');

const BOUNDS = WORLD.bounds;
const lonScale = europe.projection.lonScale;
const period = round(360 * lonScale, 4); // how far you scroll before the world repeats

// One frame for the planet: longitude 0 in the middle, the equator flat.
const project = (lon, lat) => [round(lon * lonScale), round(-lat)];
const unprojectEurope = ([x, z]) => [x / europe.projection.lonScale + europe.projection.lonMid, europe.projection.latMid - z];
const unprojectAmerica = ([x, z]) => [
  x / america.projection.lonScale + america.projection.lonMid,
  america.projection.latMid - z,
];

const ringArea = (ring) => {
  let s = 0;
  for (let i = 0, n = ring.length; i < n; i += 1) {
    const [x1, z1] = ring[i];
    const [x2, z2] = ring[(i + 1) % n];
    s += x1 * z2 - x2 * z1;
  }
  return Math.abs(s) / 2;
};

const ringCentroid = (ring) => {
  let a = 0;
  let cx = 0;
  let cz = 0;
  for (let i = 0, n = ring.length; i < n; i += 1) {
    const [x1, z1] = ring[i];
    const [x2, z2] = ring[(i + 1) % n];
    const cross = x1 * z2 - x2 * z1;
    a += cross;
    cx += (x1 + x2) * cross;
    cz += (z1 + z2) * cross;
  }
  if (Math.abs(a) < 1e-9) {
    const avg = ring.reduce((acc, p) => [acc[0] + p[0], acc[1] + p[1]], [0, 0]);
    return [avg[0] / ring.length, avg[1] / ring.length];
  }
  a *= 0.5;
  return [cx / (6 * a), cz / (6 * a)];
};

function clipHalfPlane(points, f) {
  if (points.length < 3) return [];
  const out = [];
  for (let i = 0; i < points.length; i += 1) {
    const cur = points[i];
    const prev = points[(i + points.length - 1) % points.length];
    const fc = f(cur);
    const fp = f(prev);
    if (fc <= 0) {
      if (fp > 0) {
        const t = fp / (fp - fc || 1e-9);
        out.push([prev[0] + (cur[0] - prev[0]) * t, prev[1] + (cur[1] - prev[1]) * t]);
      }
      out.push(cur);
    } else if (fp <= 0) {
      const t = fp / (fp - fc || 1e-9);
      out.push([prev[0] + (cur[0] - prev[0]) * t, prev[1] + (cur[1] - prev[1]) * t]);
    }
  }
  return out;
}

const bisector = (ax, az, bx, bz) => {
  const k = bx * bx + bz * bz - ax * ax - az * az;
  return ([x, z]) => 2 * (bx - ax) * x + 2 * (bz - az) * z - k;
};

// Rings that cross the antimeridian must not jump a whole world to the left:
// unwrap them point by point, then let the renderer's copies show the far side.
function unwrap(ring) {
  const out = [];
  let prev = null;
  for (const [lon, lat] of ring) {
    let value = lon;
    if (prev !== null) {
      while (value - prev > 180) value -= 360;
      while (prev - value > 180) value += 360;
    }
    out.push([value, lat]);
    prev = value;
  }
  return out;
}

// Countries that are cut into several provinces along their real regional
// borders instead of straight bisectors. Unit names come from the Natural Earth
// admin-1 table (src/data/admin1.json); every unit of the country belongs to
// exactly one group, so the country stays whole.
const ADMIN_GROUPS = {
  // China: eight provinces of the 1939 map.
  CN: {
    XIN: ['Xinjiang'],
    TIB: ['Xizang', 'Qinghai'],
    NMG: ['Inner Mongol'],
    MAN: ['Heilongjiang', 'Jilin', 'Liaoning'],
    NCH: ['Beijing', 'Tianjin', 'Hebei', 'Shanxi', 'Shandong', 'Henan', 'Shaanxi'],
    SIC: ['Sichuan', 'Chongqing', 'Yunnan', 'Guizhou', 'Gansu', 'Ningxia'],
    SCH: [
      'Anhui', 'Fujian', 'Guangdong', 'Guangxi', 'Hainan', 'Hubei', 'Hunan',
      'Jiangsu', 'Jiangxi', 'Shanghai', 'Zhejiang', 'Paracel Islands',
    ],
  },
  // Russia east of the Europe theatre edge: the seven Siberian provinces.
  RU: {
    SIB: ['Tyumen\'', 'Sverdlovsk', 'Chelyabinsk', 'Kurgan', 'Omsk', 'Khanty-Mansiy', 'Yamal-Nenets'],
    CEN: ['Novosibirsk', 'Tomsk', 'Kemerovo', 'Altay', 'Gorno-Altay', 'Krasnoyarsk', 'Khakass', 'Tuva'],
    BAI: ['Irkutsk', 'Buryat', 'Chita'],
    YAK: ['Sakha (Yakutia)'],
    FAR: ['Khabarovsk', 'Primor\'ye', 'Amur', 'Yevrey', 'Sakhalin', 'Maga Buryatdan'],
    KAM: ['Kamchatka'],
    CHU: ['Chukchi Autonomous Okrug'],
  },
};

// Natural Earth keeps the numeric country code in the 110m features, while the
// admin-1 table is keyed by the two-letter code.
const ISO_A2 = { 156: 'CN', 643: 'RU', 840: 'US', 124: 'CA' };

/** Mean longitude of a set of rings, weighted by ring area. */
function meanLongitude(rings) {
  let sum = 0;
  let total = 0;
  for (const ring of rings) {
    const area = ringArea(ring);
    const lon = ring.reduce((acc, point) => acc + point[0], 0) / ring.length;
    sum += lon * area;
    total += area;
  }
  return total > 0 ? sum / total : 0;
}

const unwrapRing = (ring) => unwrap(ring);

/** Shifts a ring by whole turns so it sits next to the country reference. */
function shiftRing(ring, reference) {
  const mean = ring.reduce((acc, point) => acc + point[0], 0) / ring.length;
  const turns = Math.round((reference - mean) / 360);
  return turns === 0 ? ring : ring.map(([lon, lat]) => [lon + turns * 360, lat]);
}

/**
 * Rings of one country drawn from its real regions. Returns null when there is
 * nothing to use, so the caller falls back to the bisector split.
 */
function admin1Rings(iso, defs, features, admin1) {
  const code = ISO_A2[iso];
  const groups = ADMIN_GROUPS[code];
  const units = admin1[code];
  if (!groups || !units?.length) return null;

  const lonClips = code === 'RU' ? [([lon]) => 50 - lon] : [];
  const countryRings = [];
  for (const feature of features) {
    const polygons = feature.geometry.type === 'Polygon'
      ? [feature.geometry.coordinates]
      : feature.geometry.coordinates;
    for (const poly of polygons) {
      for (const raw of poly) {
        let ring = unwrapRing(raw);
        for (const clip of lonClips) ring = clipHalfPlane(ring, clip);
        if (ring.length >= 3) countryRings.push(ring);
      }
    }
  }
  if (!countryRings.length) return null;
  const reference = meanLongitude(countryRings);

  const prepared = units.map((unit) => ({
    name: unit.name,
    rings: unit.rings.map((ring) => shiftRing(unwrapRing(ring), reference)),
  }));

  const cells = admin1Cells({
    units: prepared,
    groups,
    project: (lon, lat) => project(lon, lat),
    tolerance: 0.01,
    fallback: defs.map((def) => ({ id: def.id, lon: def.seed[0], lat: def.seed[1] })),
  });
  if (!cells.size) return null;

  const out = new Map();
  for (const [id, rings] of cells) {
    if (!defs.some((def) => def.id === id)) continue;
    const clipped = [];
    for (const ring of rings) {
      // Russia is only half on this map: west of the Europe edge belongs to the
      // European provinces, so the Siberian cells are cut at the same meridian.
      let cell = ring;
      if (code === 'RU') cell = clipHalfPlane(cell, ([x]) => 50 * lonScale - x);
      cell = clipHalfPlane(cell, ([, z]) => -BOUNDS.latMax - z);
      cell = clipHalfPlane(cell, ([, z]) => z + BOUNDS.latMin);
      if (cell.length >= 3) clipped.push(cell.map(([x, z]) => [round(x, 3), round(z, 3)]));
    }
    if (clipped.length) out.set(id, clipped);
  }
  return out;
}

const provinces = new Map();
const byId = () => provinces;

/** Europe and America keep their own provinces; only the frame changes. */
function importMap(map, unproject, rename = {}) {
  for (const province of map.provinces) {
    const id = rename[province.id] ?? province.id;
    const rings = province.rings
      .map((ring) => ring.map((point) => project(...unproject(point))))
      .filter((ring) => ring.length >= 3 && ringArea(ring) >= 0.02);
    if (!rings.length) continue;
    const islands = (province.islands ?? [])
      .map((ring) => ring.map((point) => project(...unproject(point))))
      .filter((ring) => ringArea(ring) >= 0.01);
    rings.sort((a, b) => ringArea(b) - ringArea(a));
    const [main, ...rest] = rings;
    const [cx, cz] = ringCentroid(main);
    provinces.set(id, {
      id,
      name: province.name,
      nameRu: province.nameRu,
      // «Чья это страна» — for a province nobody owns yet the map must be able
      // to print the country name, not «neutral territory».
      country: province.country ?? province.nameRu,
      pop: province.pop,
      rings: [main],
      ...(rest.length || islands.length ? { islands: [...rest, ...islands] } : {}),
      centroid: [round(cx, 3), round(cz, 3)],
      area: round(ringArea(main), 2),
      neighbors: province.neighbors.map((n) => rename[n] ?? n),
    });
  }
}

importMap(europe, unprojectEurope);
// Louisiana was «PL» on the American map, which means Poland on the European one.
importMap(america, unprojectAmerica, { PL: 'LO' });

// ------------------------------------------------------------------ dataset
const topo = JSON.parse(readFileSync(resolve(root, 'node_modules/world-atlas/countries-110m.json'), 'utf8'));
const geo = feature(topo, topo.objects.countries);
const adj = neighbors(topo.objects.countries.geometries);

const admin1Table = loadAdmin1(root);

// Countries on this map that are cut into several provinces: an unowned
// province of such a country still has to name the country it belongs to.
const COUNTRY_NAMES_RU = {
  156: 'Китай',
  643: 'Россия',
  124: 'Канада',
  840: 'США',
};

const byIso = new Map();
for (const def of WORLD.provinces) {
  const key = String(Number(def.iso));
  if (!byIso.has(key)) byIso.set(key, []);
  byIso.get(key).push(def);
}

const featureProvince = new Map(); // feature index -> [province ids]
const missing = [];
const created = new Map();

for (const [iso, defs] of byIso) {
  const features = geo.features
    .map((f, i) => ({ f, i }))
    .filter(({ f }) => f.id != null && String(Number(f.id)) === iso);
  if (!features.length) {
    missing.push(`iso ${iso} (${defs[0].id}): no feature`);
    continue;
  }
  const seeds = defs.map((def) => {
    const [x, z] = project(def.seed[0], def.seed[1]);
    return { def, x, z };
  });
  for (const def of defs) {
    created.set(def.id, {
      id: def.id,
      name: def.nameRu,
      nameRu: def.nameRu,
      country: COUNTRY_NAMES_RU[iso] ?? def.nameRu,
      pop: def.pop,
      rings: [],
      centroid: [0, 0],
      area: 0,
      neighbors: [],
      source: iso,
    });
  }
  const real = admin1Rings(iso, defs, features.map((entry) => entry.f), admin1Table);
  if (real) {
    for (const def of defs) {
      const rings = real.get(def.id);
      if (!rings?.length) continue;
      created.get(def.id).rings.push(...rings);
      created.get(def.id).fromAdmin1 = true;
    }
    if (!featureProvince.has(features[0].i)) featureProvince.set(features[0].i, defs.map((d) => d.id));
    continue;
  }
  for (const { f, i } of features) {
    const polygons = f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates;
    for (const poly of polygons) {
      for (const rawRing of poly) {
        let ring = unwrap(rawRing).map(([lon, lat]) => project(lon, lat));
        // Siberia is the half of Russia east of the European map's edge; the
        // western half is already drawn by the European provinces.
        if (iso === '643') ring = clipHalfPlane(ring, ([x]) => 50 * lonScale - x);
        // z = -latitude, so the northern bound is the smaller z.
        ring = clipHalfPlane(ring, ([, z]) => -BOUNDS.latMax - z);
        ring = clipHalfPlane(ring, ([, z]) => z + BOUNDS.latMin);
        if (ring.length < 3) continue;
        for (const seed of seeds) {
          let cell = ring;
          if (seeds.length > 1) {
            for (const other of seeds) {
              if (other === seed) continue;
              cell = clipHalfPlane(cell, bisector(seed.x, seed.z, other.x, other.z));
              if (cell.length < 3) break;
            }
          }
          if (cell.length < 3) continue;
          if (ringArea(cell) < 0.02) continue;
          created.get(seed.def.id).rings.push(cell.map(([x, z]) => [round(x, 3), round(z, 3)]));
        }
      }
    }
    if (!featureProvince.has(i)) featureProvince.set(i, defs.map((d) => d.id));
  }
}

for (const province of created.values()) {
  if (!province.rings.length) {
    missing.push(`${province.id}: empty after clipping`);
    continue;
  }
  province.rings.sort((a, b) => ringArea(b) - ringArea(a));
  const [main, ...rest] = province.rings;
  province.rings = [main];
  if (rest.length) province.islands = rest;
  const [cx, cz] = ringCentroid(main);
  province.centroid = [round(cx, 3), round(cz, 3)];
  province.area = round(ringArea(main), 2);
  delete province.source;
  provinces.set(province.id, province);
}

/**
 * Land borders by geometry.
 *
 * The dataset only says which *countries* touch: Russia is one feature, so the
 * topology alone made Chukotka border Azerbaijan. Once a country is cut into
 * provinces the border has to be measured on the drawn rings instead. Two
 * provinces touch when a vertex of one lies on an edge of the other (shared
 * source topology shares vertices) or the edges run within a hair of each other
 * (the cut lines of a split are computed separately on both sides).
 */
const EPS = 0.08;

const pointToSegment = ([px, pz], [ax, az], [bx, bz]) => {
  const dx = bx - ax;
  const dz = bz - az;
  const len = dx * dx + dz * dz;
  const t = len > 1e-12 ? Math.max(0, Math.min(1, ((px - ax) * dx + (pz - az) * dz) / len)) : 0;
  return Math.hypot(px - (ax + dx * t), pz - (az + dz * t));
};

const near = (a, b) => {
  for (const ringA of [...a.rings, ...(a.islands ?? [])]) {
    for (const point of ringA) {
      for (const ringB of [...b.rings, ...(b.islands ?? [])]) {
        for (let i = 0; i < ringB.length; i += 1) {
          if (pointToSegment(point, ringB[i], ringB[(i + 1) % ringB.length]) <= EPS) return true;
        }
      }
    }
  }
  return false;
};

function linkBorders(list) {
  const boxes = list.map((province) => {
    let minX = Infinity;
    let maxX = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;
    for (const ring of [...province.rings, ...(province.islands ?? [])]) {
      for (const [x, z] of ring) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (z < minZ) minZ = z;
        if (z > maxZ) maxZ = z;
      }
    }
    return { minX, maxX, minZ, maxZ };
  });
  let links = 0;
  for (let i = 0; i < list.length; i += 1) {
    for (let j = i + 1; j < list.length; j += 1) {
      const a = boxes[i];
      const b = boxes[j];
      if (a.maxX + EPS < b.minX || b.maxX + EPS < a.minX) continue;
      if (a.maxZ + EPS < b.minZ || b.maxZ + EPS < a.minZ) continue;
      if (!near(list[i], list[j])) continue;
      const pa = list[i].neighbors;
      const pb = list[j].neighbors;
      if (!pa.includes(list[j].id)) pa.push(list[j].id);
      if (!pb.includes(list[i].id)) pb.push(list[i].id);
      links += 1;
    }
  }
  return links;
}

// Hand-written sea routes of the world theatre. A route may name a province
// that only exists on this map, so links are applied after the merge.
const seaLinks = [...(europe.seaLinks ?? []), ...(america.seaLinks ?? [])]
  .map(([a, b]) => [a === 'PL' ? 'LO' : a, b === 'PL' ? 'LO' : b])
  .filter(([a, b]) => a !== b);
for (const [a, b] of WORLD.seaLinks) {
  const pa = provinces.get(a);
  const pb = provinces.get(b);
  if (!pa || !pb) {
    missing.push(`sea link ${a}-${b} points at an unknown province`);
    continue;
  }
  if (!pa.neighbors.includes(b)) pa.neighbors.push(b);
  if (!pb.neighbors.includes(a)) pb.neighbors.push(a);
  seaLinks.push([a, b]);
}

// Every neighbour must exist on this map: the European list mentions Crimea,
// the American one mentions Hawaii, and both must be present here too.
for (const province of provinces.values()) {
  province.neighbors = [...new Set(province.neighbors)].filter((id) => provinces.has(id) && id !== province.id);
  for (const neighbour of province.neighbors) {
    const other = provinces.get(neighbour);
    if (!other.neighbors.includes(province.id)) other.neighbors.push(province.id);
  }
}

const list = [...provinces.values()].sort((a, b) => a.id.localeCompare(b.id));
const borders = linkBorders(list);

// A pair that already shares a land border must not also be a sea route:
// otherwise troops crawl across the strait that in fact is not there.
const geometryPairs = new Set();
const landPairs = geometryPairs;
for (const [a, b] of seaLinks) {
  const pa = list.find((province) => province.id === a);
  const pb = list.find((province) => province.id === b);
  if (pa && pb && near(pa, pb)) landPairs.add(a < b ? `${a}|${b}` : `${b}|${a}`);
}
const cleanSea = seaLinks.filter(([a, b]) => a !== b && !landPairs.has(a < b ? `${a}|${b}` : `${b}|${a}`));
for (const province of list) province.neighbors.sort();

// Extent and seam flags. A province that reaches the edges of the cylinder is
// drawn twice more, one world to the left and one to the right, so scrolling
// past the date line never shows a gap.
let minX = Infinity;
let maxX = -Infinity;
let minZ = Infinity;
let maxZ = -Infinity;
const seamLimit = period / 2 - 6;
for (const province of list) {
  let crosses = false;
  for (const ring of [...province.rings, ...(province.islands ?? [])]) {
    for (const [x, z] of ring) {
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (z < minZ) minZ = z;
      if (z > maxZ) maxZ = z;
      if (Math.abs(x) >= seamLimit) crosses = true;
    }
  }
  if (crosses) province.seam = true;
}

const out = {
  generatedAt: new Date().toISOString(),
  source:
    'Natural Earth 110m (public domain) via world-atlas; Europe from map.json, America from map-america.json, the rest from countries-110m.json',
  theatre: 'world',
  bounds: BOUNDS,
  // The cylinder: scrolling one period shows the same land again.
  wrap: { period },
  extent: { minX: round(Math.max(minX, -period / 2), 2), maxX: round(Math.min(maxX, period / 2), 2), minZ: round(minZ, 2), maxZ: round(maxZ, 2) },
  projection: { lonMid: 0, latMid: 0, lonScale: round(lonScale, 5) },
  seaLinks: cleanSea,
  width: period,
  height: round(maxZ - minZ, 2),
  provinces: list,
};

const target = resolve(root, 'src/data/map-world.json');
writeFileSync(target, JSON.stringify(out));
const kb = (JSON.stringify(out).length / 1024).toFixed(1);
console.log(`world: ${list.length} provinces, ${borders} land borders, ${out.width} x ${out.height} units, ${kb} KB`);
if (missing.length) console.warn(missing.slice(0, 20).join('\n'));
const orphans = list.filter((p) => p.neighbors.length === 0).map((p) => p.id);
if (orphans.length) console.warn('provinces without neighbours:', orphans.join(', '));
