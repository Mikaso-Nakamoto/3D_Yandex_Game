import { BAL } from './balance.js';

/**
 * How the chosen AI style shapes a single decision. Tempo (in game.js) decides
 * how often a nation thinks; these two numbers decide what it dares to do when
 * it does — otherwise «жёсткая» and «спокойная» would only differ in the number
 * of identical decisions per minute, which a player cannot feel.
 */
const STYLE = {
  calm: { chance: 0.72, margin: 1.85, columns: 1, react: 0, orders: 0 },
  normal: { chance: 1, margin: 1.5, columns: 2, react: 0.5, orders: 1 },
  hard: { chance: 1.32, margin: 1.16, columns: 3, react: 1, orders: 1 },
};

function styleOf(game) {
  return STYLE[game.state.rules?.aiStyle] ?? STYLE.normal;
}

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

  if (styleOf(game).orders) maybeOrders(game, nation);
  if (game.rng.chance(0.75)) build(game, nation, owned);
  maybeSueForPeace(game, nation, owned);
  game.maybeAiPeace(nation.id);
  maybeBreakPact(game, nation, owned);
  maybeAskPassage(game, nation, owned);
  // A column already marching at us is more important than a new offensive.
  const helped = game.rng.chance(styleOf(game).react) ? defendThreats(game, nation, owned) : false;
  if (!attack(game, nation, owned) && !helped) {
    reinforceLine(game, nation, owned);
  }
}

/**
 * The same three orders the player has, with the same cooldowns and the same
 * price. Before this the AI fought with a handicap it never agreed to: it
 * could not mobilise a reserve, double its income for a push, or speed a
 * marching column up — and a player who used all three simply out-tempoed it.
 */
function maybeOrders(game, nation) {
  const state = game.state;
  const o = game.ordersOf(nation.id);
  if (!o) return;
  if (!game.warsOf(nation.id).length) return; // in peacetime gold is better spent on buildings
  const ready = (kind) => state.time >= (o[`${kind}Ready`] ?? 0);
  const affordable = (kind) => nation.gold >= BAL.orderGold[kind] + BAL.aiOrderReserve;

  if (ready('tax') && affordable('tax')) game.castOrderFor(nation.id, 'tax');
  if (ready('mobilize') && affordable('mobilize') && nation.manpower > 60) {
    const thin = game.provinces.some(
      (p) => p.owner === nation.id && p.garrison < game.maxGarrison(p.id) * 0.7,
    );
    if (thin) game.castOrderFor(nation.id, 'mobilize');
  }
  if (ready('march') && affordable('march')) {
    const marching = state.armies.some((a) => a.owner === nation.id);
    if (marching) game.castOrderFor(nation.id, 'march');
  }
}

function upgradeCost(kind, level) {
  const costs = BAL.upgradeCosts[kind];
  return level < costs.length ? costs[level] : Infinity;
}

function build(game, nation, owned) {
  const state = game.state;
  const atWar = game.warsOf(nation.id).length > 0;
  // While fighting, part of the treasury is kept for orders; in peacetime the
  // whole purse may go into buildings.
  const reserve = atWar ? BAL.aiWarReserve : BAL.aiSpendReserve;
  if (nation.gold <= reserve) return;
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
      // A factory in the rear keeps producing when the border is on fire.
      if (kind === 'factory') value = (preview.gold ?? 0) * HORIZON * (atWar && !border(p) ? 1.35 : 1);
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
    // A nation that is clearly losing does not ask for a white peace: it buys
    // one with land and gold. That is the difference between «перемирие» and
    // «мир с уступкой» on the card, and it gives the player a real choice.
    const terms = game.tributeTerms(nation.id);
    if (terms) {
      game.offerPeace(nation.id, 'tribute', terms);
      return;
    }
  } else {
    // No war with the player yet: a wary, tired neighbour offers a pact.
    const playerLooksStrong = game.provinceCount(playerId) >= game.provinceCount(nation.id) * 0.8;
    if (!playerLooksStrong) return;
    if (!game.rng.chance(0.22)) return;
  }
  game.offerPeace(nation.id);
}

/**
 * An AI at war with a nation it cannot touch — the enemy borders the player,
 * not the AI — asks the player for a road. Without this the right of passage
 * would be a player-only button; with it, a war on the far side of a neutral
 * country gives that country a real decision to make.
 */
/**
 * A province matching `wanted` that touches the player's land but cannot be
 * reached from our own: the one case where asking for a road is worth it.
 */
function unreachableOnPlayerBorder(game, mine, touchesPlayer, wanted) {
  for (const p of game.provinces) {
    if (!wanted(p)) continue;
    if (game.neighbors(p.id).some((nid) => mine.has(nid))) continue; // reachable
    if (!touchesPlayer(p.id)) continue;
    return p;
  }
  return null;
}

function maybeAskPassage(game, nation, owned) {
  const state = game.state;
  const playerId = state.nationId;
  const player = state.nations[playerId];
  if (!player?.alive || !nation.alive || nation.isPlayer) return;
  if (game.hasPassage(playerId, nation.id)) return; // already have a road
  if (game.hasWar(nation.id, playerId)) return; // an enemy gets nothing
  // A nation asks for a road when a war is stuck, not on the first day of it.
  if (nation.exhaustion > 70) return;
  if (game.rng.chance(0.8)) return; // rare thought, not a queue of requests
  const touchesPlayer = (pid) =>
    game.neighbors(pid).some((nid) => state.provinces[nid].owner === playerId);
  const mine = new Set(owned.map((p) => p.id));
  // A province we cannot reach, standing on the player's border: the player's
  // land is the only road to it. Enemies at war come first — a war that cannot
  // be reached is worse than an unclaimed field — and neutral land second.
  let blocked = null;
  for (const enemy of Object.values(state.nations)) {
    if (!enemy.alive || enemy.id === nation.id || enemy.id === playerId) continue;
    const since = game.warSince(nation.id, enemy.id);
    if (since == null || state.time - since < 30) continue;
    blocked = unreachableOnPlayerBorder(game, mine, touchesPlayer, (p) => p.owner === enemy.id);
    if (blocked) break;
  }
  // Unclaimed land: a nation that has room at home does not push through a
  // neighbour for it, so this is a rare thought.
  if (!blocked && game.rng.chance(0.75)) {
    blocked = unreachableOnPlayerBorder(game, mine, touchesPlayer, (p) => !p.owner);
  }
  if (!blocked) return;
  // Our own land has to touch the player, otherwise the road leads nowhere.
  const adjacent = owned.some((p) => touchesPlayer(p.id));
  if (!adjacent) return;
  // A nation does not beg someone who will obviously refuse, but a refusal is
  // not a disaster either: asking is how a road gets opened in the first place.
  if (game.passageChance(nation.id, playerId) < 0.12) return;
  game.offerPassage(nation.id);
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

/** Where a column is really heading: a route may pass through several provinces. */
function finalTarget(army) {
  return army.path ? army.path[army.path.length - 1] : army.to;
}

/**
 * Provinces of `nation` that an enemy column is marching at right now. The AI
 * needs this list for two things: it does not pull troops out of a province
 * that is about to be attacked, and it sends help to that province instead of
 * opening a new front elsewhere.
 */
function threatenedProvinces(game, nation) {
  const state = game.state;
  const set = new Set();
  for (const army of state.armies) {
    if (army.owner === nation.id) continue;
    const target = state.provinces[finalTarget(army)];
    if (target?.owner !== nation.id) continue;
    if (game.hasTruce(army.owner, nation.id)) continue;
    set.add(target.id);
  }
  return set;
}

/**
 * Help for a province with a column already marching at it. The AI looks at
 * the projected defence on arrival — the same number the player sees — and
 * tops it up from a quiet neighbour. This is the answer to «the AI never
 * notices my army until it lands».
 */
function defendThreats(game, nation, owned) {
  const state = game.state;
  const threatened = threatenedProvinces(game, nation);
  if (!threatened.size) return false;
  const committed = new Set(state.armies.filter((a) => a.owner === nation.id).map((a) => a.from));
  let acted = false;
  for (const tid of threatened) {
    const target = state.provinces[tid];
    if (!target || target.owner !== nation.id) continue;
    // How long until the first column lands, and what will be standing there.
    let eta = Infinity;
    let incoming = 0;
    let incomingMod = 1;
    for (const army of state.armies) {
      if (army.owner === nation.id) continue;
      if (finalTarget(army) !== tid) continue;
      const left = Math.max(0, army.duration - army.t);
      if (left < eta) eta = left;
      incoming += army.troops;
      incomingMod = Math.max(incomingMod, game.attackModifier(army.owner));
    }
    if (!incoming) continue;
    const threat = incoming * incomingMod;
    const def = game.projectedDefense(tid, eta);
    if (def >= threat * 0.6) continue; // the garrison can hold on its own
    // Find the quietest neighbour with men to spare.
    let best = null;
    for (const nid of game.neighbors(tid)) {
      const src = state.provinces[nid];
      if (!src || src.owner !== nation.id) continue;
      if (threatened.has(nid) || committed.has(nid)) continue;
      if (src.garrison < 30) continue;
      // The capital is not emptied to save a border village.
      if (src.id === nation.capital) {
        const keep = game.maxGarrison(src.id) * BAL.aiCapitalReserve;
        if (src.garrison - keep < 30) continue;
      }
      if (!best || src.garrison > best.garrison) best = src;
    }
    if (!best) continue;
    const need = Math.min(best.garrison, threat * 1.05 - def);
    if (need < BAL.minSend) continue;
    const ratio = Math.max(0.3, Math.min(BAL.aiThreatShare, need / best.garrison));
    if (game.launchArmy(nation.id, best.id, tid, ratio) > 0) {
      committed.add(best.id);
      acted = true;
    }
  }
  return acted;
}

/**
 * One attack decision, with concentration. The AI collects every hostile
 * province on its border together with the troops that could reach it, and
 * sends two or three columns at one target when one column would not be enough
 * — the same «сборный удар» the player has. A target it has chosen stays «the
 * front» for 45 seconds, so an offensive does not change direction every think.
 */
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
  const style = styleOf(game);
  if (!game.rng.chance(0.55 * tempo * style.chance * (1 - nation.exhaustion / 160))) return false;

  const margin = nation.exhaustion > BAL.warWearyAt ? BAL.warWearyMargin : style.margin;
  const threatened = threatenedProvinces(game, nation);
  const committed = new Set();
  for (const army of state.armies) if (army.owner === nation.id) committed.add(army.from);
  const inFlight = new Map();
  for (const army of state.armies) {
    if (army.owner !== nation.id) continue;
    const to = finalTarget(army);
    inFlight.set(to, (inFlight.get(to) ?? 0) + army.troops);
  }
  const capitalId = nation.capital;
  const capitalCap = capitalId ? game.maxGarrison(capitalId) * BAL.aiCapitalReserve : 0;
  // Men that may leave a province: the capital always keeps a reserve at home.
  const usable = (p, to) => {
    if (p.id === to || p.id !== capitalId) return p.garrison;
    return Math.max(0, p.garrison - capitalCap);
  };

  const plans = new Map();
  for (const p of owned) {
    if (p.garrison < 28) continue;
    if (committed.has(p.id)) continue;
    if (threatened.has(p.id)) continue; // its men stay home to meet the column
    for (const nid of game.neighbors(p.id)) {
      const target = state.provinces[nid];
      if (!target || target.owner === nation.id) continue;
      if (target.owner && game.hasTruce(nation.id, target.owner)) continue;
      if (usable(p, nid) < BAL.minSend) continue;
      let plan = plans.get(nid);
      if (!plan) {
        plan = { to: nid, owner: target.owner, sources: [], def: 0, score: 0 };
        plans.set(nid, plan);
      }
      plan.sources.push(p);
    }
  }
  if (!plans.size && !game.passagesOf(nation.id).length) return false;

  const front = nation.ai.front;
  for (const plan of plans.values()) {
    const target = state.provinces[plan.to];
    const enemy = plan.owner ? state.nations[plan.owner] : null;
    if (enemy?.isPlayer) {
      if (rules.peaceUntilFirstWar && !state.playerAggro) continue;
      if (state.time < 120 && !state.playerAggro) continue;
      // К6.1: the seconds after «второго шанса» belong to the player.
      if (state.time < (state.reviveGrace ?? 0)) continue;
      const alreadyFighting = game.hasFoughtRecently(nation.id, plan.owner);
      if (!alreadyFighting && game.activeAttackers(plan.owner) >= coalitionLimit(state)) continue;
    }
    plan.sources.sort((a, b) => usable(b, plan.to) - usable(a, plan.to));
    // Plan against the province as it will look on arrival, as the player does.
    const travel = game.travelTime(plan.sources[0].id, plan.to, nation.id);
    plan.def = game.projectedDefense(plan.to, travel);
    // A little extra on top of the style's margin: a joint attack that only
    // barely outweighs the defender is a coin toss that costs three provinces.
    plan.required = plan.def * margin * 1.1;
    let have = inFlight.get(plan.to) ?? 0;
    plan.take = [];
    for (const src of plan.sources) {
      if (have >= plan.required || plan.take.length >= Math.min(BAL.aiMaxColumns, style.columns)) break;
      have += usable(src, plan.to) * BAL.aiColumnShare * game.attackModifier(nation.id);
      plan.take.push(src);
    }
    if (have < plan.required) {
      // Not enough even together: do not feed the grinder. Clearing `take`
      // matters — a half-filled plan used to look like a ready one.
      plan.take = [];
      continue;
    }
    plan.ready = true;

    let score = plan.def;
    if (!plan.owner) score *= 0.75;
    if (plan.owner) {
      if (enemy?.isPlayer) {
        score *= state.time < 240 ? 1.45 : 1.12;
        const playerPower = game.armyTotal ? game.armyTotal(plan.owner) : 0;
        if (playerPower > plan.def * 2.5) score *= 1.5;
        const rel = state.relations?.[game.constructor.pairKey(nation.id, plan.owner)];
        if (rel?.grudge === plan.owner) score *= 0.75;
      }
      if (enemy && game.provinceCount(enemy.id) > owned.length * 2) score *= 1.35;
    }
    if (target.pop > 25) score *= 0.95;
    // The front chosen a few seconds ago keeps its priority: one offensive at a time.
    if (front && front.to === plan.to && front.until > state.time) score *= 0.7;
    plan.score = score;
  }

  let best = null;
  for (const plan of plans.values()) {
    if (!plan.ready || !plan.take?.length) continue;
    if (!best || plan.score < best.score) best = plan;
  }
  if (!best && game.passagesOf(nation.id).length) {
    // No neighbour worth attacking, but a road through a friendly country may
    // open a front that is otherwise out of reach.
    if (attackThroughPassage(game, nation, owned)) return true;
  }
  if (!best) return false;

  nation.ai.front = { to: best.to, until: state.time + BAL.aiFrontSeconds };
  if (globalThis.__AIDEBUG) globalThis.__AIDEBUG.push({ t: +state.time.toFixed(1), who: nation.id, to: best.to, est: Math.round(best.def), need: Math.round(best.required), take: best.take.length, real: Math.round(game.defenseValue(best.to)), owner: state.provinces[best.to].owner });
  let sent = 0;
  for (const src of best.take) {
    const ratio = Math.min(BAL.aiColumnShare, usable(src, best.to) / Math.max(1, src.garrison));
    const troops = game.launchArmy(nation.id, src.id, best.to, ratio);
    if (troops > 0) sent += troops;
  }
  return sent > 0;
}

/**
 * Picks a hostile province on the far side of a passage and marches at it.
 * Only provinces that are the *final* step of a route count: the column walks
 * through the friendly country without a fight and battles on arrival.
 */
function attackThroughPassage(game, nation, owned) {
  const state = game.state;
  const style = styleOf(game);
  const margin = nation.exhaustion > BAL.warWearyAt ? BAL.warWearyMargin : style.margin;
  let best = null;
  for (const p of owned) {
    if (p.garrison < 28) continue;
    for (const holder of game.passagesOf(nation.id)) {
      for (const landId of Object.keys(state.provinces)) {
        if (state.provinces[landId].owner !== holder.id) continue;
        for (const nid of game.neighbors(landId)) {
          const target = state.provinces[nid];
          if (!target.owner || target.owner === nation.id) continue;
          if (target.owner === holder.id) continue; // do not bite the hand that feeds
          if (game.hasTruce(nation.id, target.owner)) continue;
          const route = game.routeBetween(p.id, nid, nation.id);
          if (!route || route.length < 2) continue;
          const travel = game.routeTime(route, nation.id);
          const atk = p.garrison * game.attackModifier(nation.id);
          const def = game.projectedDefense(nid, travel);
          if (atk < def * margin) continue;
          const score = def + travel;
          if (!best || score < best.score) best = { from: p.id, to: nid, score };
        }
      }
    }
  }
  if (!best) return false;
  return game.launchRouteFor(nation.id, best.from, best.to, 0.75) > 0;
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
