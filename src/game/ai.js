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
  maybeSueForPeace(game, nation, owned);
  maybeBreakPact(game, nation, owned);
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

/**
 * A tired AI reaches out: a peace deal if it has actually fought the player,
 * otherwise a non-aggression pact. Nations that do not border the player have
 * nothing to negotiate about.
 */
function maybeSueForPeace(game, nation, owned) {
  const state = game.state;
  const playerId = state.nationId;
  if (!state.nations[playerId]?.alive) return;
  if (nation.exhaustion < BAL.peaceOfferAt) return;
  if (game.hasTruce(nation.id, playerId)) return;
  if (state.offers.some((offer) => offer.from === nation.id)) return;
  const bordersPlayer = owned.some((p) =>
    game.neighbors(p.id).some((nid) => state.provinces[nid].owner === playerId),
  );
  if (!bordersPlayer) return;

  const fought = game.hasFoughtRecently(nation.id, playerId);
  if (fought) {
    const losing = game.provinceCount(playerId) >= game.provinceCount(nation.id);
    if (!losing) return;
    if (!game.rng.chance(0.4)) return;
  } else {
    // No war with the player yet: a wary, tired neighbour offers a pact.
    const playerLooksStrong = game.provinceCount(playerId) >= game.provinceCount(nation.id) * 0.8;
    if (!playerLooksStrong) return;
    if (!game.rng.chance(0.22)) return;
  }
  game.offerPeace(nation.id);
}

/**
 * A pact is not eternal for the AI either. When a nation has grown far stronger
 * than the player and the player's land lies right across the border, it may
 * tear the treaty up — rarely, and never before it is genuinely stronger.
 */
function maybeBreakPact(game, nation, owned) {
  const state = game.state;
  const playerId = state.nationId;
  if (!nation.alive || !state.nations[playerId]?.alive) return;
  if (!game.hasTruce(nation.id, playerId)) return;
  // Do not re-roll every thought: check once every ~45 game seconds.
  if (state.time < (nation.pactBreakAt ?? 0)) return;
  nation.pactBreakAt = state.time + 45;
  const rel = state.relations?.[`${nation.id < playerId ? nation.id : playerId}|${nation.id < playerId ? playerId : nation.id}`];
  const grudge = rel?.grudge === nation.id;
  const myPower = game.armyTotal(nation.id);
  const playerPower = game.armyTotal(playerId);
  const needs = grudge ? 1.15 : 1.7;
  if (myPower < playerPower * needs) return;
  const touches = owned.some((p) =>
    game.neighbors(p.id).some((nid) => state.provinces[nid].owner === playerId),
  );
  if (!touches) return;
  const odds = grudge ? 0.18 : 0.05;
  if (!game.rng.chance(odds)) return;
  game.breakTruce(playerId, nation.id);
}

/** How many nations may be at war with one country at the same time. */
function coalitionLimit(state) {
  const style = state.rules?.aiStyle ?? 'normal';
  if (style === 'calm') return 1;
  if (style === 'hard') return 3;
  return 2;
}

function attack(game, nation, owned) {
  const state = game.state;
  const rules = state.rules ?? {};
  if (rules.aiPassive) return false;
  // War weariness makes a nation hesitate; total exhaustion rules out new offensives.
  if (nation.exhaustion > 85) return false;
  // Early game the whole world expands more slowly, so the player is not left
  // behind before the first minute is over.
  const ramp = Math.min(1, state.time / (BAL.aiOpeningRamp || 300));
  const tempo = (BAL.aiOpeningTempo ?? 0.45) + (1 - BAL.aiOpeningTempo) * ramp;
  if (!game.rng.chance(0.55 * tempo * (1 - nation.exhaustion / 160))) return false;

  let best = null;
  for (const p of owned) {
    // It may already have armies on the road: only troops still at home matter.
    if (p.garrison < 28) continue;
    const atk = p.garrison * game.attackModifier(nation.id);
    for (const nid of game.neighbors(p.id)) {
      const target = state.provinces[nid];
      if (!target || target.owner === nation.id) continue;
      // The defender keeps reinforcing during the march, so plan against the
      // province as it will look on arrival — the same number the player sees.
      const def = game.projectedDefense(nid, game.travelTime(p.id, nid, nation.id));
      if (atk < def * 1.5) continue;

      let score = def;
      if (!target.owner) score *= 0.75;
      if (target.owner) {
        const enemy = state.nations[target.owner];
        if (enemy?.isPlayer) {
          // A truce is a real pause: the AI keeps its word.
          if (game.hasTruce(nation.id, target.owner)) continue;
          // Peace guarantee: no AI declares war on the player until the player strikes first.
          if (rules.peaceUntilFirstWar && !state.playerAggro) continue;
          if (state.time < 120 && !state.playerAggro) continue;
          // Coalition limit: a nation that is not yet at war with the player
          // joins only while the player still has a war to fight on one or two
          // fronts. Five simultaneous invaders is not a fight, it is a funeral.
          const alreadyFighting = game.hasFoughtRecently(nation.id, target.owner);
          if (!alreadyFighting && game.activeAttackers(target.owner) >= coalitionLimit(state)) continue;
          score *= state.time < 240 ? 1.45 : 1.12;
          // The stronger the player looks, the less tempting the target.
          const playerPower = game.armyTotal ? game.armyTotal(target.owner) : 0;
          if (playerPower > atk * 2.5) score *= 1.5;
          // A king who broke his word is a king worth punishing.
          const rel = state.relations?.[game.constructor.pairKey(nation.id, target.owner)];
          if (rel?.grudge === target.owner) score *= 0.75;
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
