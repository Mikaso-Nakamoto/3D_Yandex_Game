// Generates src/data/map.json from Natural Earth 110m data (public domain, via `world-atlas`).
// Pipeline: TopoJSON -> GeoJSON -> clip to the European theatre -> equirectangular projection
// (longitude compressed by cos(latitude)) -> province rings + adjacency.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { feature, neighbors } from 'topojson-client';
import { COUNTRIES, MERGE_INTO, SEA_LINKS } from '../src/data/countries.js';
import { AMERICA } from '../src/data/provinces-america.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

const BOUNDS = { lonMin: -25.5, lonMax: 50, latMin: 34, latMax: 72 };

/** Equirectangular projection with longitude compressed by cos(mid latitude). */
function makeProjector(bounds) {
  const lonMid = (bounds.lonMin + bounds.lonMax) / 2;
  const latMid = (bounds.latMin + bounds.latMax) / 2;
  const lonScale = Math.cos((latMid * Math.PI) / 180);
  return {
    lonMid,
    latMid,
    lonScale,
    project(lon, lat) {
      return [round((lon - lonMid) * lonScale, 3), round(latMid - lat, 3)];
    },
  };
}

function round(v, p) {
  const k = 10 ** p;
  return Math.round(v * k) / k;
}

// Longitudes are wrapped onto a cylinder starting at b.lonMin. This keeps rings that cross
// the antimeridian (Russia) contiguous, so the clipper never sees a 360-degree jump.
function normalizeLongitude(lon, lonMin) {
  const span = 360;
  return ((((lon - lonMin) % span) + span) % span) + lonMin;
}

// Sutherland-Hodgman clipping of a ring against an axis-aligned box in lon/lat space.
function clipRing(rawRing, b) {
  const ring = rawRing.map(([lon, lat]) => [normalizeLongitude(lon, b.lonMin), lat]);
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

function loadWorld() {
  const topoPath = resolve(root, 'node_modules/world-atlas/countries-110m.json');
  const topo = JSON.parse(readFileSync(topoPath, 'utf8'));
  return {
    geo: feature(topo, topo.objects.countries),
    adj: neighbors(topo.objects.countries.geometries),
  };
}

/** Shared tail: pick the main ring, project metadata and write the file. */
function finish(out, target, notes) {
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, JSON.stringify(out));
  const bytes = JSON.stringify(out).length;
  console.log(`${notes.name}: ${out.provinces.length} provinces, ${out.width} x ${out.height} units, ${(bytes / 1024).toFixed(1)} KB`);
  for (const line of notes.warnings ?? []) console.warn(line);
  const orphans = out.provinces.filter((p) => p.neighbors.length === 0).map((p) => p.id);
  if (orphans.length) console.warn('provinces without neighbors:', orphans.join(', '));
}

function projectProvince(p, projector) {
  if (p.rings.length === 0) return;
  p.rings.sort((a, b) => ringArea(b) - ringArea(a));
  const main = p.rings[0];
  p.area = round(ringArea(main), 2);
  const [cx, cz] = ringCentroid(main);
  p.centroid = [round(cx, 3), round(cz, 3)];
  p.islands = p.rings.slice(1);
  p.rings = [main];
}

function buildEurope(topo) {
  const { geo, adj } = topo;
  const projector = makeProjector(BOUNDS);
  const project = projector.project;

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
  for (const p of provinces.values()) projectProvince(p, projector);

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

  const target = resolve(root, 'src/data/map.json');
  const out = {
    generatedAt: new Date().toISOString(),
    source: 'Natural Earth 110m (public domain) via world-atlas',
    theatre: 'europe',
    bounds: BOUNDS,
    projection: {
      lonMid: projector.lonMid,
      latMid: projector.latMid,
      lonScale: round(projector.lonScale, 5),
    },
    width: round((BOUNDS.lonMax - BOUNDS.lonMin) * projector.lonScale, 2),
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
  const warnings = [];
  if (missing.length) warnings.push(`missing geometry: ${missing.join(', ')}`);
  if (skipped.length) warnings.push(`ignored ${skipped.length} non-European features`);
  finish(out, target, { name: 'europe', warnings });
}

/** Clips a projected ring against a half-plane where f(p) <= 0 is inside. */
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

/** Half-plane of points at least as close to seed A as to seed B. */
function bisector(ax, az, bx, bz) {
  const k = bx * bx + bz * bz - ax * ax - az * az;
  return ([x, z]) => 2 * (bx - ax) * x + 2 * (bz - az) * z - k;
}

/**
 * North America. Country-level geometry is cut into the regions declared in
 * src/data/provinces-america.js. Regions of one country split its land with
 * nearest-seed bisectors, so borders follow geography instead of a grid.
 */
function buildAmerica(topo) {
  const { geo } = topo;
  const { bounds, provinces: defs, seaLinks } = AMERICA;
  const projector = makeProjector(bounds);
  const project = projector.project;
  const toProjected = ([lon, lat]) => project(normalizeLongitude(lon, bounds.lonMin), lat);

  const bySource = new Map();
  for (const f of geo.features) {
    const name = f.properties?.name ?? '';
    if (!bySource.has(name)) bySource.set(name, []);
    bySource.get(name).push(f);
  }

  const provinces = new Map();
  const sourceOf = new Map();
  for (const def of defs) {
    provinces.set(def.id, {
      id: def.id,
      name: def.name,
      nameRu: def.nameRu,
      pop: def.pop,
      rings: [],
      centroid: [0, 0],
      area: 0,
      neighbors: [...def.neighbors],
    });
    sourceOf.set(def.id, Array.isArray(def.source) ? def.source : [def.source]);
  }

  // Group seeds by source country: those are the only provinces that compete
  // for the same piece of land.
  const byCountry = new Map();
  for (const def of defs) {
    const key = (Array.isArray(def.source) ? def.source : [def.source]).join('|');
    if (!byCountry.has(key)) byCountry.set(key, []);
    byCountry.get(key).push(def);
  }

  const boundsBox = {
    xMin: (bounds.lonMin - projector.lonMid) * projector.lonScale,
    xMax: (bounds.lonMax - projector.lonMid) * projector.lonScale,
    zMin: projector.latMid - bounds.latMax,
    zMax: projector.latMid - bounds.latMin,
  };
  const insideBounds = (p) =>
    p[0] >= boundsBox.xMin && p[0] <= boundsBox.xMax && p[1] >= boundsBox.zMin && p[1] <= boundsBox.zMax;

  const missing = [];
  for (const [countryKey, group] of byCountry) {
    const sources = countryKey.split('|');
    const seeds = group.map((def) => {
      const [x, z] = project(def.seed[0], def.seed[1]);
      return { def, x, z };
    });
    for (const source of sources) {
      const features = bySource.get(source) ?? [];
      if (!features.length) missing.push(`${group[0].id}: no feature "${source}"`);
      for (const f of features) {
        for (const poly of collectPolygons(f.geometry)) {
          for (const ring of poly) {
            let pts = ring.map(toProjected);
            if (pts.length < 3) continue;
            // Keep a ring only in the province(s) whose part of the country it
            // belongs to. Islands outside every `only` box are dropped.
            for (const seed of seeds) {
              const province = provinces.get(seed.def.id);
              let cell = pts;
              if (seed.def.ringBox) {
                const [lonMin, lonMax, latMin, latMax] = seed.def.ringBox;
                const box = {
                  xMin: (lonMin - projector.lonMid) * projector.lonScale,
                  xMax: (lonMax - projector.lonMid) * projector.lonScale,
                  zMin: projector.latMid - latMax,
                  zMax: projector.latMid - latMin,
                };
                // Decide by the ring, not by the clipped cell: a ring either
                // belongs to this province's part of the country or it does not.
                const cx = pts.reduce((a, p) => a + p[0], 0) / pts.length;
                const cz = pts.reduce((a, p) => a + p[1], 0) / pts.length;
                if (cx < box.xMin || cx > box.xMax || cz < box.zMin || cz > box.zMax) continue;
              }
              for (const other of seeds) {
                if (other === seed) continue;
                cell = clipHalfPlane(cell, bisector(seed.x, seed.z, other.x, other.z));
                if (cell.length < 3) break;
              }
              if (cell.length < 3) continue;
              cell = clipHalfPlane(cell, ([x]) => boundsBox.xMin - x);
              cell = clipHalfPlane(cell, ([x]) => x - boundsBox.xMax);
              cell = clipHalfPlane(cell, ([, z]) => boundsBox.zMin - z);
              cell = clipHalfPlane(cell, ([, z]) => z - boundsBox.zMax);
              if (cell.length < 3) continue;
              if (ringArea(cell) < 0.02) continue;
              province.rings.push(cell.map(([x, z]) => [round(x, 3), round(z, 3)]));
            }
          }
        }
      }
    }
  }

  for (const p of provinces.values()) projectProvince(p, projector);

  for (const [a, b] of seaLinks) {
    const pa = provinces.get(a);
    const pb = provinces.get(b);
    if (!pa || !pb) {
      missing.push(`sea link ${a}-${b} points at an unknown province`);
      continue;
    }
    if (!pa.neighbors.includes(b)) pa.neighbors.push(b);
    if (!pb.neighbors.includes(a)) pb.neighbors.push(a);
  }

  for (const p of provinces.values()) if (!p.rings.length) missing.push(`${p.id}: empty after clipping`);

  const target = resolve(root, 'src/data/map-america.json');
  const out = {
    generatedAt: new Date().toISOString(),
    source: 'Natural Earth 110m (public domain) via world-atlas',
    theatre: 'america',
    bounds,
    projection: {
      lonMid: projector.lonMid,
      latMid: projector.latMid,
      lonScale: round(projector.lonScale, 5),
    },
    width: round((bounds.lonMax - bounds.lonMin) * projector.lonScale, 2),
    height: round(bounds.latMax - bounds.latMin, 2),
    seaLinks,
    provinces: [...provinces.values()]
      .filter((p) => p.rings.length)
      .map(({ islands, ...p }) => ({ ...p, islands, neighbors: p.neighbors.sort() }))
      .sort((a, b) => a.id.localeCompare(b.id)),
  };
  finish(out, target, { name: 'america', warnings: missing });
}

function main() {
  const topo = loadWorld();
  buildEurope(topo);
  buildAmerica(topo);
}

main();
