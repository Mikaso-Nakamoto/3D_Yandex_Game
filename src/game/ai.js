import { BAL } from './balance.js';

export function assignDoctrine(nation, rng) {
  const aggression = nation.ai?.aggression ?? 0.9;
  if (aggression >= 1.05) return rng.chance(0.7) ? 'sword' : 'coin';
  if (aggression <= 0.74) return rng.chance(0.6) ? 'wall' : 'coin';
  return rng.pick(['coin', 'sword', 'wall']);
}

/** One AI "thought". Called every few seconds per nation. */
export function aiThink(game, nation) {
  const owned = game.provinces.filter((p) => p.owner === nation.id);
  if (!owned.length) return;

  if (nation.gold > BAL.aiSpendReserve && game.rng.chance(0.75)) {
    build(game, nation, owned);
  }
  if (!attack(game, nation, owned)) {
    reinforceLine(game, nation, owned);
  }
}

function upgradeCost(kind, level) {
  const costs = BAL.upgradeCosts[kind];
  return level < costs.length ? costs[level] : Infinity;
}

function build(game, nation, owned) {
  const state = game.state;
  const border = (p) =>
    game.neighbors(p.id).some((nid) => {
      const t = state.provinces[nid];
      return !t.owner || t.owner !== nation.id;
    });
  const pressured = (p) =>
    border(p) &&
    game.neighbors(p.id)
      .filter((nid) => state.provinces[nid].owner && state.provinces[nid].owner !== nation.id)
      .reduce((acc, nid) => acc + game.defenseValue(nid), 0) > game.defenseValue(p.id);

  // Value per gold, with a planning horizon of roughly four minutes of play.
  const HORIZON = 240;
  const candidates = [];
  for (const p of owned) {
    const threat = pressured(p);
    for (const kind of ['factory', 'barracks', 'fort']) {
      if (p[kind] >= BAL.maxLevel) continue;
      const cost = upgradeCost(kind, p[kind]);
      if (nation.gold < cost) continue;
      const preview = game.upgradePreview(p.id, kind);
      if (!preview) continue;
      let value = 0;
      if (kind === 'factory') value = (preview.gold ?? 0) * HORIZON;
      else if (kind === 'barracks') value = (preview.garrison ?? 0) * (border(p) ? 1.6 : 1);
      else value = (preview.defense ?? 0) * (threat ? 1.8 : 0.5);
      if (value <= 0) continue;
      candidates.push({ p, kind, cost, score: value / cost });
    }
  }
  if (!candidates.length) return;
  candidates.sort((a, b) => b.score - a.score);

  // Mostly buy the best value, sometimes a near-best option so AI play varies.
  const pool = candidates.slice(0, 3);
  const pick = game.rng.chance(0.6) ? pool[0] : game.rng.pick(pool);
  if (pick.cost > nation.gold) return;
  nation.gold -= pick.cost;
  pick.p[pick.kind] += 1;
  game.state.stats.aiUpgrades = (game.state.stats.aiUpgrades ?? 0) + 1;
}

function attack(game, nation, owned) {
  const state = game.state;
  const rules = state.rules ?? {};
  if (rules.aiPassive) return false;
  if (!game.rng.chance(0.55)) return false;

  let best = null;
  for (const p of owned) {
    // It may already have armies on the road: only troops still at home matter.
    if (p.garrison < 28) continue;
    const atk = p.garrison * game.attackModifier(nation.id);
    for (const nid of game.neighbors(p.id)) {
      const target = state.provinces[nid];
      if (!target || target.owner === nation.id) continue;
      const def = game.defenseValue(nid);
      if (atk < def * 1.5) continue;

      let score = def;
      if (!target.owner) score *= 0.75;
      if (target.owner) {
        const enemy = state.nations[target.owner];
        if (enemy?.isPlayer) {
          // Peace guarantee: no AI declares war on the player until the player strikes first.
          if (rules.peaceUntilFirstWar && !state.playerAggro) continue;
          if (state.time < 120 && !state.playerAggro) continue;
          score *= state.time < 240 ? 1.45 : 1.12;
        }
        if (enemy && game.provinceCount(enemy.id) > owned.length * 2) score *= 1.35;
      }
      if (target.pop > 25) score *= 0.95;
      if (!best || score < best.score) best = { from: p.id, to: nid, def, atk, score };
    }
  }
  if (!best) return false;

  const margin = best.def / best.atk;
  const ratio = margin < 0.45 ? 0.7 : margin < 0.7 ? 0.82 : 0.95;
  const troops = game.launchArmy(nation.id, best.from, best.to, ratio);
  return troops > 0;
}

function reinforceLine(game, nation, owned) {
  const state = game.state;
  if (!game.rng.chance(0.5)) return;
  const isBorder = (p) =>
    game.neighbors(p.id).some((nid) => state.provinces[nid].owner !== nation.id);

  const borderProvinces = owned.filter((p) => isBorder(p) && !state.armies.some((a) => a.from === p.id));
  if (!borderProvinces.length) return;
  const weakest = borderProvinces.reduce((a, b) => (a.garrison < b.garrison ? a : b));
  if (weakest.garrison > game.maxGarrison(weakest.id) * 0.55) return;

  let bestSource = null;
  for (const p of owned) {
    if (p.id === weakest.id || isBorder(p)) continue;
    if (state.armies.some((a) => a.from === p.id)) continue;
    const path = game.neighbors(p.id);
    if (!path.includes(weakest.id)) continue;
    if (p.garrison > game.maxGarrison(p.id) * 0.75) {
      if (!bestSource || p.garrison > bestSource.garrison) bestSource = p;
    }
  }
  if (bestSource) game.launchArmy(nation.id, bestSource.id, weakest.id, 0.5);
}
