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

  const threatened = owned
    .filter(border)
    .map((p) => ({
      p,
      pressure: game.neighbors(p.id)
        .filter((nid) => state.provinces[nid].owner && state.provinces[nid].owner !== nation.id)
        .reduce((acc, nid) => acc + game.defenseValue(nid), 0) - game.defenseValue(p.id),
    }))
    .sort((a, b) => b.pressure - a.pressure);

  const candidates = [];
  if (threatened.length && threatened[0].pressure > 0) {
    const fortLevel = threatened[0].p.fort;
    const cost = upgradeCost('fort', fortLevel);
    if (fortLevel < BAL.maxLevel && nation.gold >= cost) candidates.push({ p: threatened[0].p, kind: 'fort', cost, weight: 3 });
  }
  const byPop = [...owned].sort((a, b) => b.pop - a.pop);
  for (const p of byPop.slice(0, 3)) {
    const cost = upgradeCost('factory', p.factory);
    if (p.factory < BAL.maxLevel && nation.gold >= cost) {
      candidates.push({ p, kind: 'factory', cost, weight: 2 });
      break;
    }
  }
  const barracksTarget = byPop.find((p) => border(p) && p.barracks < BAL.maxLevel);
  if (barracksTarget) {
    const cost = upgradeCost('barracks', barracksTarget.barracks);
    if (nation.gold >= cost) candidates.push({ p: barracksTarget, kind: 'barracks', cost, weight: 1 });
  }
  if (!candidates.length) return;

  const pick = game.rng.chance(0.6) ? candidates[0] : game.rng.pick(candidates);
  if (pick.cost > nation.gold) return;
  nation.gold -= pick.cost;
  pick.p[pick.kind] += 1;
}

function attack(game, nation, owned) {
  const state = game.state;
  const rules = state.rules ?? {};
  if (rules.aiPassive) return false;
  if (!game.rng.chance(0.55)) return false;

  let best = null;
  for (const p of owned) {
    if (state.armies.some((a) => a.from === p.id)) continue;
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
