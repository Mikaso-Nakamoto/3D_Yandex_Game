// How many people live in a province, as the player reads it.
//
// The simulation keeps its own abstract weights (`pop` in the map files) and
// those drive income, recruits and garrisons. Showing them as «млн» was a lie:
// the weights come from modern country sizes, so Prussia in 1815 had more
// people than France, and Turkey in 1939 had fifty million.
//
// Here each scenario gets the population its century actually had. The numbers
// are split between a nation's provinces in proportion to the map weights, and
// unowned land is scaled by the average of the scenario, so a neutral Switzerland
// still looks like Switzerland. Nothing here feeds the simulation: it is a label,
// and a label must be true.

import { SCENARIOS } from './scenarios.js';

// Millions, rounded to what a school atlas of the era would print. Colonial
// empires count their colonies, because those provinces are part of the realm.
// `@neutral` is the total population of the land nobody in the scenario owns
// (Italy and Switzerland in 1815, all of Africa and Latin America in 1939). It
// is spread over those provinces by map weight.
export const HISTORICAL_POP = {
  concert: {
    RUS: 45, AUS: 29, PRU: 10.5, FRA: 30, GBR: 20, OTT: 24,
    NLD: 5.5, ESP: 12, SWE: 3.8, DNK: 1.5, POR: 3.5,
    '@neutral': 24,
  },
  'concert-atlantic': {
    USA: 8.5,
    '@neutral': 30,
  },
  eve1939: {
    GER: 78, SOV: 168, ITA: 45, FRA: 41, GBR: 48, POL: 35,
    YUG: 15, ROM: 19, HUN: 9, SVK: 2.6, BUL: 6.3, GRE: 7,
    TUR: 17.5, SWE: 6.3, NOR: 2.9, DNK: 3.8, FIN: 3.7,
    NLD: 8.8, BEL: 8.4, SUI: 4.2, ESP: 26, POR: 7.2,
    '@neutral': 4,
  },
  'eve1939-atlantic': {
    USA: 131,
    '@neutral': 300,
  },
  mosaic: {
    HRE: 12, FRA: 12, OTT: 7, POL: 6.5, HUN: 4,
    KAL: 1.6, MOS: 5, ENG: 2.5, CAS: 4.5, POR: 1, LIV: 0.4,
    '@neutral': 9,
  },
  'mosaic-atlantic': {
    '@neutral': 24,
  },
  civil1861: {
    RUS: 74, AUS: 35, PRU: 18, FRA: 37, GBR: 29, OTT: 24,
    NLD: 5.7, ESP: 15.5, SWE: 4.4, DNK: 1.6, POR: 3.8,
    USA: 23, CSA: 9, BNA: 3.2, MEX: 8.2, HAI: 0.6,
    '@neutral': 14,
  },
  world1939: {
    GER: 78, SOV: 168, USA: 131, BNA: 11.5, GBR: 470, FRA: 88,
    ITA: 47, JPN: 101, CHN: 500, POL: 35, TUR: 17.5,
    '@neutral': 550,
  },
};

/**
 * Province id -> millions, for one scenario.
 *
 * A nation's historical total is spread over its provinces by map weight; land
 * nobody owns is scaled by the average weight of the scenario. Unknown
 * scenarios fall back to the raw weights so a future map still shows something.
 *
 * @param {{id: string, theatre?: string, popScale?: number}} scenario
 * @param {{provinces: Array<{id: string, pop: number}>}} map
 * @returns {Map<string, number>}
 */
export function populationIndex(scenario, map) {
  const fullId = scenario?.id ?? '';
  const baseId = fullId.split('-')[0];
  // The Atlantic variant adds a continent but keeps the same century, so it
  // inherits the base table and overrides only what changed.
  const own = HISTORICAL_POP[fullId] ?? null;
  const merged = own ? { ...(HISTORICAL_POP[baseId] ?? {}), ...own } : HISTORICAL_POP[baseId] ?? null;
  const table = merged;
  const weights = new Map(map.provinces.map((p) => [p.id, Math.max(0, p.pop ?? 0)]));
  const result = new Map();
  if (!table) {
    for (const [id, pop] of weights) result.set(id, pop);
    return result;
  }
  const sc = SCENARIOS.find((s) => s.id === scenario.id) ?? null;
  const owned = new Set();
  let histTotal = 0;
  let weightTotal = 0;
  for (const nation of sc?.nations ?? []) {
    const total = table[nation.id];
    if (!total) continue;
    let sum = 0;
    for (const id of nation.provinces) sum += weights.get(id) ?? 0;
    if (sum <= 0) continue;
    for (const id of nation.provinces) {
      const weight = weights.get(id) ?? 0;
      result.set(id, (weight / sum) * total);
      owned.add(id);
    }
    histTotal += total;
    weightTotal += sum;
  }
  // Unowned land: a fixed total for the scenario (all of Africa, or just Italy
  // and Switzerland) spread by weight. Without a fixed total, a huge empty
  // Brazil would inherit the average of Europe and read as a great power.
  let neutralTotal = table['@neutral'];
  if (neutralTotal == null) neutralTotal = weightTotal > 0 ? histTotal * 0.1 : 0;
  let neutralWeight = 0;
  for (const [id, weight] of weights) if (!owned.has(id)) neutralWeight += weight;
  if (neutralWeight > 0) {
    for (const [id, weight] of weights) {
      if (!owned.has(id)) result.set(id, (weight / neutralWeight) * neutralTotal);
    }
  }
  return result;
}
