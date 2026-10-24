// Real regional borders for countries that are cut into several provinces.
//
// The map builders used to cut a country by straight bisectors between province
// seeds, which drew perfect straight lines across whole continents. This module
// takes the Natural Earth admin-1 units (states, oblasts, provinces — see
// tools/build-admin1.mjs) and glues whole units into the provinces of the game,
// so China's internal borders look like China and not like a Voronoi diagram.
//
// Every unit of a country belongs to exactly one province: the ones named in a
// group are taken as written, the rest are handed to the nearest group. That
// way the provinces always cover the whole country — no holes, no slivers, and
// no fragile polygon subtraction in the build.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import polygonClipping from 'polygon-clipping';

/** Reads src/data/admin1.json; a missing file means «no real borders». */
export function loadAdmin1(root) {
  try {
    const data = JSON.parse(readFileSync(resolve(root, 'src/data/admin1.json'), 'utf8'));
    return data.countries ?? {};
  } catch {
    return {};
  }
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

const ringCentroid = (ring) => {
  let a = 0;
  let cx = 0;
  let cy = 0;
  for (let i = 0, n = ring.length; i < n; i += 1) {
    const [x1, y1] = ring[i];
    const [x2, y2] = ring[(i + 1) % n];
    const cross = x1 * y2 - x2 * y1;
    a += cross;
    cx += (x1 + x2) * cross;
    cy += (y1 + y2) * cross;
  }
  if (Math.abs(a) < 1e-12) {
    const avg = ring.reduce((acc, p) => [acc[0] + p[0], acc[1] + p[1]], [0, 0]);
    return [avg[0] / ring.length, avg[1] / ring.length];
  }
  a *= 0.5;
  return [cx / (6 * a), cy / (6 * a)];
};

/** Douglas–Peucker for a closed ring, so a country keeps a readable outline. */
export function simplifyRing(points, tolerance) {
  if (points.length <= 4 || tolerance <= 0) return points;
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

/** A ring the boolean library accepts: closed, four points or more, finite. */
function validRing(ring) {
  if (!Array.isArray(ring) || ring.length < 3) return null;
  const points = [];
  for (const point of ring) {
    if (!Array.isArray(point) || point.length < 2) return null;
    // Snapping to a 0.01° grid keeps boolean operations stable: unrounded
    // neighbours differ in the last bits and the clipper then refuses to close
    // a ring.
    const x = Math.round(point[0] * 100) / 100;
    const y = Math.round(point[1] * 100) / 100;
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    const last = points[points.length - 1];
    if (last && last[0] === x && last[1] === y) continue;
    points.push([x, y]);
  }
  const [fx, fy] = points[0];
  const [lx, ly] = points[points.length - 1];
  if (fx !== lx || fy !== ly) points.push([fx, fy]);
  return points.length >= 4 ? points : null;
}

/**
 * Splits one country into `groups` (province id -> admin-1 unit names) and
 * returns projected rings per province.
 *
 * @param units        admin-1 units of the country: [{ name, rings: [[[lon, lat]]] }]
 * @param groups       { provinceId: [unitName, ...] }
 * @param project      ([lon, lat]) => [x, z]
 * @param tolerance    simplification tolerance in projected units
 * @param fallback     extra seed points to hand unclaimed units to, when a
 *                     province in `groups` has no unit at all
 */
export function admin1Cells({ units, groups, project, tolerance = 0.06, fallback = [] }) {
  const { union } = polygonClipping;

  const prepared = [];
  for (const unit of units) {
    const rings = [];
    for (const ring of unit.rings) {
      const clean = validRing(ring);
      if (clean) rings.push(clean);
    }
    if (rings.length) prepared.push({ name: unit.name, rings });
  }
  if (!prepared.length) return new Map();

  // Centroids of the groups that were named explicitly; anything unnamed is
  // handed to the closest one so the country stays whole.
  const owner = new Map();
  const seeds = new Map();
  for (const [id, names] of Object.entries(groups)) {
    let area = 0;
    let cx = 0;
    let cy = 0;
    for (const unit of prepared) {
      if (!names.includes(unit.name)) continue;
      for (const ring of unit.rings) {
        const [lon, lat] = ringCentroid(ring);
        const weight = ringArea(ring);
        area += weight;
        cx += lon * weight;
        cy += lat * weight;
        owner.set(unit.name, id);
      }
    }
    if (area > 0) seeds.set(id, [cx / area, cy / area]);
  }
  // Fallback seeds keep provinces alive when a name in the table is spelled
  // differently in a future dataset.
  for (const point of fallback) if (!seeds.has(point.id)) seeds.set(point.id, [point.lon, point.lat]);

  for (const unit of prepared) {
    if (owner.has(unit.name)) continue;
    let best = null;
    let bestDist = Infinity;
    for (const [id, [lon, lat]] of seeds) {
      for (const ring of unit.rings) {
        const [ux, uy] = ringCentroid(ring);
        const dist = (ux - lon) ** 2 + (uy - lat) ** 2;
        if (dist < bestDist) {
          bestDist = dist;
          best = id;
        }
      }
    }
    if (best) owner.set(unit.name, best);
  }

  const byGroup = new Map();
  for (const unit of prepared) {
    const id = owner.get(unit.name);
    if (!id) continue;
    if (!byGroup.has(id)) byGroup.set(id, []);
    byGroup.get(id).push(unit);
  }

  const out = new Map();
  for (const [id, groupUnits] of byGroup) {
    const polygons = [];
    for (const unit of groupUnits) for (const ring of unit.rings) polygons.push([ring]);
    let merged;
    try {
      merged = union(polygons);
    } catch {
      merged = polygons;
    }
    const rings = [];
    for (const poly of merged) {
      if (!poly?.length) continue;
      const ring = poly[0];
      if (ring.length < 3) continue;
      const projected = ring.map(([lon, lat]) => project(lon, lat));
      const simple = simplifyRing(projected, tolerance);
      if (simple.length < 3) continue;
      if (ringArea(simple) < 0.02) continue;
      rings.push(simple);
    }
    if (rings.length) out.set(id, rings);
  }
  if (process.env.DEBUG_ADMIN1) {
    for (const [id] of out) console.error('admin1 cell', id);
  }
  return out;
}
