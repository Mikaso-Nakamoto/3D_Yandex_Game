// Generates src/data/map.json from Natural Earth 110m data (public domain, via `world-atlas`).
// Pipeline: TopoJSON -> GeoJSON -> clip to the European theatre -> equirectangular projection
// (longitude compressed by cos(latitude)) -> province rings + adjacency.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { feature, neighbors } from 'topojson-client';
import { COUNTRIES, MERGE_INTO, SEA_LINKS } from '../src/data/countries.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

const BOUNDS = { lonMin: -25.5, lonMax: 50, latMin: 34, latMax: 72 };
const LON_MID = (BOUNDS.lonMin + BOUNDS.lonMax) / 2;
const LAT_MID = (BOUNDS.latMin + BOUNDS.latMax) / 2;
const LON_SCALE = Math.cos((LAT_MID * Math.PI) / 180);

function project(lon, lat) {
  return [
    round((lon - LON_MID) * LON_SCALE, 3),
    round(LAT_MID - lat, 3),
  ];
}

function round(v, p) {
  const k = 10 ** p;
  return Math.round(v * k) / k;
}

// Longitudes are wrapped onto a cylinder starting at b.lonMin. This keeps rings that cross
// the antimeridian (Russia) contiguous, so the clipper never sees a 360-degree jump.
function normalizeLongitude(lon) {
  const span = 360;
  return ((((lon - BOUNDS.lonMin) % span) + span) % span) + BOUNDS.lonMin;
}

// Sutherland-Hodgman clipping of a ring against an axis-aligned box in lon/lat space.
function clipRing(rawRing, b) {
  const ring = rawRing.map(([lon, lat]) => [normalizeLongitude(lon), lat]);
  const planes = [
    { inside: (p) => p[0] >= b.lonMin, intersect: (a, c) => lerpX(a, c, b.lonMin) },
    { inside: (p) => p[0] <= b.lonMax, intersect: (a, c) => lerpX(a, c, b.lonMax) },
    { inside: (p) => p[1] >= b.latMin, intersect: (a, c) => lerpY(a, c, b.latMin) },
    { inside: (p) => p[1] <= b.latMax, intersect: (a, c) => lerpY(a, c, b.latMax) },
  ];
  let pts = ring.map((p) => [p[0], p[1]]);
  for (const plane of planes) {
    if (pts.length < 3) return [];
    const out = [];
    for (let i = 0; i < pts.length; i += 1) {
      const cur = pts[i];
      const prev = pts[(i + pts.length - 1) % pts.length];
      const curIn = plane.inside(cur);
      const prevIn = plane.inside(prev);
      if (curIn) {
        if (!prevIn) out.push(plane.intersect(prev, cur));
        out.push(cur);
      } else if (prevIn) {
        out.push(plane.intersect(prev, cur));
      }
    }
    pts = out;
  }
  return pts;
}

function lerpX(a, c, x) {
  const t = (x - a[0]) / (c[0] - a[0] || 1e-9);
  return [x, a[1] + (c[1] - a[1]) * t];
}

function lerpY(a, c, y) {
  const t = (y - a[1]) / (c[1] - a[1] || 1e-9);
  return [a[0] + (c[0] - a[0]) * t, y];
}

function ringArea(ring) {
  let s = 0;
  for (let i = 0, n = ring.length; i < n; i += 1) {
    const [x1, z1] = ring[i];
    const [x2, z2] = ring[(i + 1) % n];
    s += x1 * z2 - x2 * z1;
  }
  return Math.abs(s) / 2;
}

function ringCentroid(ring) {
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
}

function collectPolygons(geometry) {
  if (geometry.type === 'Polygon') return [geometry.coordinates];
  if (geometry.type === 'MultiPolygon') return geometry.coordinates;
  return [];
}

function main() {
  const topoPath = resolve(root, 'node_modules/world-atlas/countries-110m.json');
  const topo = JSON.parse(readFileSync(topoPath, 'utf8'));
  const geo = feature(topo, topo.objects.countries);
  const adj = neighbors(topo.objects.countries.geometries);

  const byIso = new Map();
  const byName = new Map();
  for (const c of COUNTRIES) {
    if (c.iso) byIso.set(String(Number(c.iso)), c.id); // dataset ids are unpadded ("8", "40")
    byName.set(c.name, c.id);
  }

  // Map dataset feature index -> province id.
  const featureProvince = new Map();
  const featureName = new Map();
  geo.features.forEach((f, i) => {
    const name = f.properties?.name ?? '';
    featureName.set(i, name);
    const iso = f.id != null ? String(Number(f.id)) : null;
    let pid = iso ? byIso.get(iso) : null;
    if (!pid) pid = byName.get(name) ?? null;
    if (!pid && MERGE_INTO[name]) pid = MERGE_INTO[name];
    if (pid) featureProvince.set(i, pid);
  });

  const unknown = [...featureName.values()].filter(
    (n) => ![...featureProvince.keys()].some((i) => featureName.get(i) === n),
  );
  const skipped = unknown.filter((n) => n && n !== 'Antarctica');

  const provinces = new Map();
  for (const c of COUNTRIES) {
    provinces.set(c.id, {
      id: c.id,
      name: c.name,
      nameRu: c.nameRu,
      pop: c.pop,
      rings: [],
      centroid: [0, 0],
      area: 0,
      neighbors: [],
      featureIndex: -1,
    });
  }

  geo.features.forEach((f, i) => {
    const pid = featureProvince.get(i);
    if (!pid) return;
    const province = provinces.get(pid);
    const polys = collectPolygons(f.geometry);
    for (const poly of polys) {
      for (const ring of poly) {
        const clipped = clipRing(ring, BOUNDS);
        if (clipped.length < 3) continue;
        const projected = clipped.map(([lon, lat]) => project(lon, lat));
        // Drop rings that are too small to matter (islets, clipping slivers).
        if (ringArea(projected) < 0.02) continue;
        province.rings.push(projected);
        if (province.featureIndex < 0) province.featureIndex = i;
      }
    }
  });

  // Keep only the largest ring per province; smaller islands are painted as part of it
  // but do not get their own interaction surface.
  for (const p of provinces.values()) {
    if (!p.rings.length) continue;
    p.rings.sort((a, b) => ringArea(b) - ringArea(a));
    const main = p.rings[0];
    p.area = round(ringArea(main), 2);
    const [cx, cz] = ringCentroid(main);
    p.centroid = [round(cx, 3), round(cz, 3)];
    p.islands = p.rings.slice(1);
    p.rings = [main];
  }

  // Land borders come straight from the topology.
  for (const [i, nbrs] of adj.entries()) {
    const pid = featureProvince.get(i);
    if (!pid) continue;
    const province = provinces.get(pid);
    for (const j of nbrs) {
      const other = featureProvince.get(j);
      if (!other || other === pid) continue;
      if (!province.neighbors.includes(other)) province.neighbors.push(other);
    }
  }

  // Sea routes.
  for (const [a, b] of SEA_LINKS) {
    if (!provinces.has(a) || !provinces.has(b)) continue;
    const pa = provinces.get(a);
    const pb = provinces.get(b);
    if (!pa.neighbors.includes(b)) pa.neighbors.push(b);
    if (!pb.neighbors.includes(a)) pb.neighbors.push(a);
  }

  const out = {
    generatedAt: new Date().toISOString(),
    source: 'Natural Earth 110m (public domain) via world-atlas',
    bounds: BOUNDS,
    projection: { lonMid: LON_MID, latMid: LAT_MID, lonScale: round(LON_SCALE, 5) },
    width: round((BOUNDS.lonMax - BOUNDS.lonMin) * LON_SCALE, 2),
    height: round(BOUNDS.latMax - BOUNDS.latMin, 2),
    seaLinks: SEA_LINKS,
    provinces: [...provinces.values()]
      .filter((p) => p.rings.length)
      .map(({ featureIndex, islands, ...p }) => ({
        ...p,
        islands,
        neighbors: p.neighbors.sort(),
      }))
      .sort((a, b) => a.id.localeCompare(b.id)),
  };

  const missing = COUNTRIES.filter((c) => !provinces.get(c.id).rings.length).map((c) => c.id);
  const target = resolve(root, 'src/data/map.json');
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, JSON.stringify(out));

  const bytes = JSON.stringify(out).length;
  console.log(`provinces: ${out.provinces.length}`);
  console.log(`map size: ${out.width} x ${out.height} world units`);
  console.log(`json: ${(bytes / 1024).toFixed(1)} KB`);
  if (missing.length) console.warn('missing geometry:', missing.join(', '));
  if (skipped.length) console.log(`ignored ${skipped.length} non-European features`);
  const orphans = out.provinces.filter((p) => p.neighbors.length === 0).map((p) => p.id);
  if (orphans.length) console.warn('provinces without neighbors:', orphans.join(', '));
}

main();
