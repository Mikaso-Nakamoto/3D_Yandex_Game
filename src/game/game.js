import { getScenario, THEATRE_GENITIVE } from '../data/scenarios.js';
import { BAL, UPGRADES, ORDERS, doctrineMod } from './balance.js';
import { Rng } from './rng.js';
import { aiThink, assignDoctrine } from './ai.js';
import { normalizeRules, AI_STYLE, AI_ECONOMY, NEUTRAL_STRENGTH } from './rules.js';
import { offerSentence, marchesVerb } from './text.js';
import { buildFocusChain } from '../data/focuses.js';

export const SAVE_VERSION = 1;

/**
 * Pure simulation core. Knows nothing about three.js, DOM or the Yandex SDK,
 * so the whole game can be stepped and tested headlessly.
 */
export class Game {
  constructor({ scenarioId, nationId, doctrineId = 'coin', map, seed = 20261023, rules = {} }) {
    this.scenario = getScenario(scenarioId);
    this.rules = normalizeRules(rules);
    if (map.theatre && this.scenario.theatre && map.theatre !== this.scenario.theatre) {
      throw new Error(
        `Сценарий «${this.scenario.title}» относится к театру ${this.scenario.theatre}, а передана карта ${map.theatre}`,
      );
    }
    this.map = map;
    this.byId = Object.fromEntries(map.provinces.map((p) => [p.id, p]));
    this.seaSet = new Set();
    for (const [a, b] of map.seaLinks ?? []) {
      this.seaSet.add(`${a}|${b}`);
      this.seaSet.add(`${b}|${a}`);
    }
    this.rng = new Rng(seed);
    this.listeners = new Set();
    this.baseSeed = seed >>> 0;
    this.state = this.#createState(nationId, doctrineId);
    this.state.rng = this.rng.s;
  }

  // ---------------------------------------------------------------- setup

  #createState(nationId, doctrineId) {
    const sc = this.scenario;
    const state = {
      version: SAVE_VERSION,
      scenarioId: sc.id,
      nationId,
      time: 0,
      speed: 1,
      months: sc.startYear * 12 + (sc.startMonth - 1),
      status: 'playing',
      provinces: {},
      nations: {},
      armies: [],
      log: [],
      rules: this.rules,
      orders: { mobilizeReady: 0, taxReady: 0, marchReady: 0, taxUntil: 0, marchUntil: 0 },
      stats: { battles: 0, captured: 0, lostProvinces: 0, battlesWon: 0, peak: 0, recruited: 0, deserted: 0 },
      sendRatio: 0.5,
      relations: {},
      offers: [],
      nextOfferId: 1,
      nextArmyId: 1,
      nextLogId: 1,
      playerAggro: false,
      rng: this.rng.s,
    };

    for (const p of this.map.provinces) {
      state.provinces[p.id] = {
        id: p.id,
        pop: p.pop,
        owner: null,
        garrison: 0,
        fort: 0,
        factory: 0,
        barracks: 0,
      };
    }

    for (const n of sc.nations) {
      const isPlayer = n.id === nationId;
      state.nations[n.id] = {
        id: n.id,
        name: n.name,
        short: n.short,
        color: n.color,
        capital: n.capital,
        doctrine: isPlayer ? doctrineId : assignDoctrine(n, this.rng),
        armyMul: n.army ?? 1,
        gold: BAL.startGoldBase + n.provinces.length * BAL.startGoldPerProvince,
        manpower: BAL.startManpower,
        alive: true,
        eliminated: false,
        isPlayer,
        pop: 0,
        income: 0,
        morale: BAL.moraleStart,
        exhaustion: 0,
        lastClash: -999,
        ai: {
          aggression: n.ai?.aggression ?? 0.9,
          eco: n.ai?.eco ?? 1,
          nextThink: this.rng.range(1.5, 4),
        },
      };
      for (const pid of n.provinces) {
        if (state.provinces[pid]) state.provinces[pid].owner = n.id;
      }
    }

    // Capitals start with a fort so small nations are not instantly overrun.
    for (const n of sc.nations) {
      const capital = state.provinces[n.capital];
      if (capital && capital.owner === n.id) capital.fort = Math.max(1, capital.fort);
    }

    // Neutral provinces: fixed garrisons, no economy.
    const neutralCfg = Object.fromEntries((sc.neutrals ?? []).map((n) => [n.province, n]));
    for (const p of Object.values(state.provinces)) {
      if (!p.owner) {
        const cfg = neutralCfg[p.id];
        p.fort = cfg?.fort ?? 0;
        const neutralMul = NEUTRAL_STRENGTH[this.rules.neutrals]?.strength ?? 1;
        p.garrison =
          this.#maxGarrison(p, state) * (cfg?.garrison ?? 0.8) * (sc.balance.neutralStrength ?? 1) * neutralMul;
      } else {
        p.garrison = this.#maxGarrison(p, state);
      }
    }

    state.stats.peak = this.#provinceCount(nationId, state);

    // Historical focus chains are built last: they look at who owns what, and
    // an ambition the nation already fulfils is skipped.
    for (const nation of Object.values(state.nations)) {
      nation.focus = {
        chain: buildFocusChain(this, nation, sc.id, state),
        index: 0,
      };
    }
    return state;
  }

  // ---------------------------------------------------------------- helpers

  get player() {
    return this.state.nations[this.state.nationId];
  }

  get nations() {
    return Object.values(this.state.nations);
  }

  get provinces() {
    return Object.values(this.state.provinces);
  }

  province(id) {
    return this.state.provinces[id];
  }

  provinceName(id) {
    return this.byId[id]?.nameRu ?? id;
  }

  neighbors(id) {
    return this.byId[id]?.neighbors ?? [];
  }

  isSeaRoute(a, b) {
    return this.seaSet.has(`${a}|${b}`);
  }

  distance(a, b) {
    const pa = this.byId[a]?.centroid;
    const pb = this.byId[b]?.centroid;
    if (!pa || !pb) return 3;
    return Math.hypot(pa[0] - pb[0], pa[1] - pb[1]);
  }

  maxGarrison(provinceId) {
    return this.#maxGarrison(this.state.provinces[provinceId]);
  }

  #maxGarrison(p, state = this.state) {
    const owner = p.owner ? state.nations[p.owner] : null;
    const mod = 1 + doctrineMod(owner?.doctrine, 'garrison');
    const strength = owner?.armyMul ?? 1;
    return Math.round(
      (BAL.garrisonBase + p.pop * BAL.garrisonPop) * (1 + p.barracks * BAL.barracksGarrison) * mod * strength,
    );
  }

  /** Military potential of a nation: what its garrisons are scaled by. */
  armyMultiplier(nationId) {
    return this.state.nations[nationId]?.armyMul ?? 1;
  }

  defenseValue(provinceId) {
    return this.#defensePower(this.state.provinces[provinceId]);
  }

  /**
   * Defence power of a province. Troops above the garrison norm count at
   * BAL.overstackDefense: they are real soldiers and never disappear, but a
   * province cannot supply unlimited men.
   */
  #defensePower(p) {
    const owner = p.owner ? this.state.nations[p.owner] : null;
    const max = this.#maxGarrison(p);
    const above = Math.max(0, p.garrison - max);
    const effective = Math.min(p.garrison, max) + above * BAL.overstackDefense;
    const morale = owner ? this.moraleModifier(owner.id) : 1;
    return effective * (1 + p.fort * BAL.fortDefense) * (1 + doctrineMod(owner?.doctrine, 'defense')) * morale;
  }

  /** Human-readable breakdown of the defence number shown in the UI. */
  defenseBreakdown(provinceId) {
    const p = this.state.provinces[provinceId];
    if (!p) return null;
    const owner = p.owner ? this.state.nations[p.owner] : null;
    const max = this.#maxGarrison(p);
    const above = Math.max(0, p.garrison - max);
    const fortMul = 1 + p.fort * BAL.fortDefense;
    const doctrineMul = 1 + doctrineMod(owner?.doctrine, 'defense');
    const moraleMul = owner ? this.moraleModifier(owner.id) : 1;
    return {
      garrison: p.garrison,
      above,
      effective: Math.min(p.garrison, max) + above * BAL.overstackDefense,
      max,
      fortMul,
      doctrineMul,
      moraleMul,
      total: this.#defensePower(p),
    };
  }

  /**
   * Probability that `attack` power beats `defense` power. Monotone, with hard
   * certainty at the edges — a 1.34x force never loses and never needs luck.
   */
  static winChance(attack, defense) {
    if (!(defense > 0)) return 1;
    const ratio = attack / defense;
    if (ratio >= BAL.combatCertain) return 1;
    if (ratio <= BAL.combatHopeless) return 0;
    return 1 / (1 + Math.exp(-BAL.combatSteepness * (ratio - 1)));
  }

  /**
   * What the player would get by dragging troops from `fromId` to `toId` now.
   * `chance` is the exact probability used by the battle resolver; `guarantee`
   * is the number of troops that wins without any luck at all.
   */
  attackOdds(fromId, toId, ratio = this.state.sendRatio) {
    const from = this.state.provinces[fromId];
    const to = this.state.provinces[toId];
    if (!from || !to || from.owner !== this.state.nationId) return null;
    const troops = this.sendableTroops(fromId, ratio);
    if (troops < BAL.minSend) return null;
    const modifier = this.attackModifier(this.state.nationId);
    const attack = troops * modifier;
    const seconds = this.travelTime(fromId, toId);
    const defenseNow = this.defenseValue(toId);
    // The defender reinforces while we march, so judge the battle by what the
    // province will look like on arrival.
    const defense = this.projectedDefense(toId, seconds);
    const need = defense / Math.max(1e-6, attack); // strength ratio required to win
    const chance = Game.winChance(attack, defense);
    // Troops that win outright, without leaving anything to chance...
    const guarantee = Math.ceil((defense * BAL.combatCertain) / modifier);
    // ...and the smallest force that still has a chance at all (below this the
    // resolver returns 0 % by rule, which used to look like a bug in the UI).
    const minToWin = Math.ceil((defense * BAL.combatHopeless) / modifier) + 1;
    return {
      troops,
      attack,
      defense,
      defenseNow,
      seconds,
      chance,
      need,
      guarantee,
      minToWin,
      from: fromId,
      to: toId,
    };
  }

  /** Best odds the player has against a province from any adjacent own land. */
  bestAttackOdds(toId, ratio = this.state.sendRatio) {
    let best = null;
    for (const neighbour of this.neighbors(toId)) {
      const odds = this.attackOdds(neighbour, toId, ratio);
      if (!odds) continue;
      if (!best || odds.chance > best.chance || (odds.chance === best.chance && odds.troops > best.troops)) best = odds;
    }
    return best;
  }

  attackModifier(nationId) {
    return (1 + doctrineMod(this.state.nations[nationId]?.doctrine, 'attack')) * this.moraleModifier(nationId);
  }

  #provinceCount(nationId, state = this.state) {
    let n = 0;
    for (const p of Object.values(state.provinces)) if (p.owner === nationId) n += 1;
    return n;
  }

  #ownedProvinces(nationId) {
    return Object.values(this.state.provinces).filter((p) => p.owner === nationId);
  }

  #hasArmies(nationId) {
    return this.state.armies.some((a) => a.owner === nationId);
  }

  /** Armies currently marching out of a province (a province may send several). */
  armiesFrom(provinceId) {
    return this.state.armies.filter((a) => a.from === provinceId);
  }

  /** Troops already committed to the road from this province. */
  troopsInTransit(provinceId) {
    return this.armiesFrom(provinceId).reduce((sum, army) => sum + army.troops, 0);
  }

  /** How many troops a send with this ratio would actually take right now. */
  sendableTroops(provinceId, ratio = this.state.sendRatio) {
    const province = this.state.provinces[provinceId];
    if (!province) return 0;
    return Math.floor(province.garrison * Math.max(0.05, Math.min(1, ratio)));
  }

  // ---------------------------------------------------------------- events

  on(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  #emit(type, payload) {
    for (const fn of this.listeners) fn(type, payload);
  }

  #log(text, kind = 'info') {
    const entry = {
      id: this.state.nextLogId++,
      text,
      kind,
      months: this.state.months,
      year: Math.floor(this.state.months / 12),
    };
    this.state.log.push(entry);
    if (this.state.log.length > BAL.logLimit) this.state.log.shift();
    this.#emit('log', entry);
    return entry;
  }

  // ---------------------------------------------------------------- commands

  setSendRatio(ratio) {
    this.state.sendRatio = Math.max(0.05, Math.min(1, ratio));
    return this.state.sendRatio;
  }

  /** Applies partial rule changes mid-game (AI temperament, victory threshold, etc.). */
  setRules(patch) {
    this.state.rules = normalizeRules({ ...this.state.rules, ...patch });
    this.#checkEnd();
    this.#emit('rules', this.state.rules);
    return this.state.rules;
  }

  setSpeed(speed) {
    this.state.speed = speed;
    return speed;
  }

  canSend(fromId, toId) {
    const from = this.state.provinces[fromId];
    const to = this.state.provinces[toId];
    if (this.state.status !== 'playing') return { ok: false, reason: 'Партия завершена' };
    if (!from || !to) return { ok: false, reason: 'Нет такой провинции' };
    if (from.owner !== this.state.nationId) return { ok: false, reason: 'Это не ваша провинция' };
    if (fromId === toId) return { ok: false, reason: 'Выберите другую провинцию' };
    // A direct neighbour is always reachable. Anything beyond it needs a land
    // route through the player's own provinces — that is how a column can be
    // sent to the far end of the realm without waiting for each hop by hand.
    if (!this.neighbors(fromId).includes(toId) && !this.routeBetween(fromId, toId)) {
      return { ok: false, reason: 'Нет пути по своим провинциям' };
    }
    // Several armies may leave the same province at once; only the troops that are
    // still at home can march, so the garrison is the single source of truth.
    if (this.sendableTroops(fromId, this.state.sendRatio) < BAL.minSend) {
      return { ok: false, reason: 'В провинции осталось слишком мало войск' };
    }
    // A pact is a promise, not a wall: the player may break it, but deliberately.
    if (to.owner && to.owner !== this.state.nationId && this.hasTruce(to.owner, this.state.nationId)) {
      return {
        ok: false,
        needsBreak: true,
        with: to.owner,
        reason: `Пакт о ненападении с ${this.state.nations[to.owner]?.short ?? 'противником'}`,
      };
    }
    return { ok: true };
  }

  /**
   * Every province the player can order troops to from `fromId`, own or foreign.
   * Used for the drag highlight: the whole interior lights up, not just the
   * immediate neighbours.
   */
  routeTargets(fromId) {
    const me = this.state.nationId;
    const reach = new Set([fromId]);
    const dist = new Map([[fromId, 0]]);
    const queue = [fromId];
    while (queue.length) {
      const current = queue.shift();
      for (const nid of this.neighbors(current)) {
        const p = this.state.provinces[nid];
        if (!p || p.owner !== me) continue;
        const cost = dist.get(current) + this.travelTime(current, nid);
        if (dist.has(nid) && dist.get(nid) <= cost) continue;
        dist.set(nid, cost);
        reach.add(nid);
        queue.push(nid);
      }
    }
    const targets = new Set(reach);
    for (const nid of Object.keys(this.state.provinces)) {
      if (reach.has(nid)) continue;
      if (this.neighbors(nid).some((adj) => reach.has(adj))) targets.add(nid);
    }
    targets.delete(fromId);
    return targets;
  }

  /**
   * Shortest land/sea route from the player's province to `toId`. Intermediate
   * provinces must already belong to the player; only the last one may be
   * foreign (that is the assault). Returns an array of province ids or null.
   */
  routeBetween(fromId, toId, nationId = this.state.nationId) {
    const s = this.state;
    const from = s.provinces[fromId];
    const to = s.provinces[toId];
    if (!from || !to || from.owner !== nationId) return null;
    if (fromId === toId) return [fromId];
    const dist = new Map([[fromId, 0]]);
    const prev = new Map();
    const done = new Set();
    const queue = [fromId];
    while (queue.length) {
      let bestIndex = 0;
      for (let i = 1; i < queue.length; i += 1) if (dist.get(queue[i]) < dist.get(queue[bestIndex])) bestIndex = i;
      const current = queue.splice(bestIndex, 1)[0];
      if (done.has(current)) continue;
      done.add(current);
      if (current === toId) break;
      for (const nid of this.neighbors(current)) {
        if (done.has(nid)) continue;
        const p = s.provinces[nid];
        if (!p) continue;
        // Walk only through our own land; the destination itself may be hostile.
        if (nid !== toId && p.owner !== nationId) continue;
        const cost = dist.get(current) + this.travelTime(current, nid, nationId);
        if (dist.has(nid) && dist.get(nid) <= cost) continue;
        dist.set(nid, cost);
        prev.set(nid, current);
        queue.push(nid);
      }
    }
    if (!dist.has(toId)) return null;
    const path = [toId];
    let cursor = toId;
    while (cursor !== fromId) {
      cursor = prev.get(cursor);
      if (!cursor) return null;
      path.unshift(cursor);
    }
    return path;
  }

  /** Total march time along a route, used for the arrival forecast. */
  routeTime(path, nationId = this.state.nationId) {
    let total = 0;
    for (let i = 1; i < path.length; i += 1) total += this.travelTime(path[i - 1], path[i], nationId);
    return total;
  }

  sendTroops(fromId, toId, ratio = this.state.sendRatio, options = {}) {
    const check = this.canSend(fromId, toId);
    if (!check.ok) return check;
    const route = this.neighbors(fromId).includes(toId) && !options.forceRoute
      ? [fromId, toId]
      : this.routeBetween(fromId, toId);
    if (!route) return { ok: false, reason: 'Нет пути по своим провинциям' };
    if (this.state.provinces[toId].owner !== this.state.nationId) this.state.playerAggro = true;
    const amount = options.leave || route.length > 2
      ? this.#launchRoute(this.state.nationId, route, ratio, options.leave ?? {})
      : this.launchArmy(this.state.nationId, fromId, toId, ratio);
    if (amount < BAL.minSend) return { ok: false, reason: 'Слишком мало войск' };
    const army = this.state.armies[this.state.armies.length - 1];
    return {
      ok: true,
      amount,
      duration: army?.duration,
      sea: this.isSeaRoute(fromId, toId),
      route,
      routeTime: this.routeTime(route),
    };
  }

  /**
   * Column with a planned route: it walks through the player's own provinces,
   * optionally leaving a garrison in any of them, and only fights at the end.
   */
  #launchRoute(nationId, route, ratio = 0.5, leave = {}) {
    const from = this.state.provinces[route[0]];
    if (!from || from.owner !== nationId) return 0;
    const amount = Math.floor(from.garrison * Math.max(0.05, Math.min(1, ratio)));
    if (amount < BAL.minSend) return 0;
    from.garrison -= amount;
    const first = route[1];
    const army = {
      id: this.state.nextArmyId++,
      owner: nationId,
      from: route[0],
      to: first,
      troops: amount,
      t: 0,
      duration: this.travelTime(route[0], first, nationId),
      sea: this.isSeaRoute(route[0], first),
      path: route.slice(),
      // Index of the province this column is currently marching to.
      leg: 1,
      leave: Object.fromEntries(
        Object.entries(leave)
          .map(([id, n]) => [id, Math.max(0, Math.floor(n))])
          .filter(([, n]) => n > 0),
      ),
    };
    this.state.armies.push(army);
    this.#announceIncoming(army, nationId);
    return amount;
  }

  /** Shared by the player and the AI. Returns the number of troops that marched. */
  launchArmy(nationId, fromId, toId, ratio = 0.5) {
    const from = this.state.provinces[fromId];
    if (!from || from.owner !== nationId) return 0;
    if (!this.neighbors(fromId).includes(toId)) return 0;
    const amount = Math.floor(from.garrison * Math.max(0.05, Math.min(1, ratio)));
    if (amount < BAL.minSend) return 0;

    const sea = this.isSeaRoute(fromId, toId);
    const duration = this.travelTime(fromId, toId, nationId);

    from.garrison -= amount;
    this.state.armies.push({
      id: this.state.nextArmyId++,
      owner: nationId,
      from: fromId,
      to: toId,
      troops: amount,
      t: 0,
      duration,
      sea,
    });

    this.#announceIncoming({ to: toId, from: fromId, troops: amount }, nationId);
    return amount;
  }

  /**
   * An enemy column heading for your land used to be visible only as an arrow
   * on the globe: easy to miss, and the first news was the province falling.
   */
  #announceIncoming(army, nationId) {
    const target = this.state.provinces[army.to];
    if (target?.owner !== this.state.nationId || nationId === this.state.nationId) return;
    const attacker = this.state.nations[nationId];
    // No case declension of province names: the arrow form already used for
    // captures reads the same for «Латвия», «Кипр» and «США».
    const who = attacker?.short ?? 'Противник';
    this.#log(`${who} ${marchesVerb(who)} войска: ${army.troops} → ${this.provinceName(army.to)}`, 'bad');
    // The folded log must not hide the one message that needs an answer now.
    this.#emit('incoming', { to: army.to, from: army.from, amount: army.troops, attacker: nationId });
  }

  /** Seconds an army needs for the march. Includes the player's march bonus. */
  travelTime(fromId, toId, nationId = this.state.nationId) {
    const sea = this.isSeaRoute(fromId, toId);
    const marchBuff = nationId === this.state.nationId && this.state.orders.marchUntil > this.state.time ? 1.6 : 1;
    const raw = (this.distance(fromId, toId) / (BAL.armySpeed * marchBuff)) * (sea ? BAL.seaTravelMul : 1);
    return Math.max(sea ? BAL.seaMinTravel : BAL.minTravel, Math.min(BAL.maxTravel, raw));
  }

  /** Where automatic recruitment stops for a province. */
  garrisonCeiling(provinceId) {
    return this.#maxGarrison(this.state.provinces[provinceId]) * BAL.overfillCeiling;
  }

  /** Garrison growth per second for a province (0 when the owner has no recruits). */
  garrisonRate(p) {
    const nation = p.owner ? this.state.nations[p.owner] : null;
    if (!nation || !nation.alive || nation.manpower <= 0) return 0;
    const max = this.#maxGarrison(p);
    const rate = max * BAL.reinforceShare * (1 + p.barracks * BAL.barracksReinforce);
    // Full provinces keep flowing above the norm, just slower, and stop at the ceiling.
    if (p.garrison >= max * BAL.overfillCeiling) return 0;
    return p.garrison >= max ? rate * BAL.overfillShare : rate;
  }

  /**
   * Garrison after `seconds` of uninterrupted reinforcement. Below the norm it
   * fills at full speed, then continues at the over-norm rate; both are capped
   * by the owner's recruit pool.
   */
  projectedGarrison(p, seconds) {
    const nation = p.owner ? this.state.nations[p.owner] : null;
    if (!nation || !nation.alive || seconds <= 0) return p.garrison;
    const max = this.#maxGarrison(p);
    const full = max * BAL.reinforceShare * (1 + p.barracks * BAL.barracksReinforce);
    let garrison = p.garrison;
    let pool = nation.manpower;
    let left = seconds;
    if (garrison < max && full > 0) {
      const fillTime = (max - garrison) / full;
      const spendTime = Math.min(left, fillTime);
      const spend = Math.min(full * spendTime, pool);
      garrison += spend;
      pool -= spend;
      left -= spendTime;
    }
    if (left > 0) {
      const ceiling = max * BAL.overfillCeiling;
      const room = Math.max(0, ceiling - garrison);
      const spend = Math.min(full * BAL.overfillShare * left, pool, room);
      garrison += spend;
    }
    return garrison;
  }

  /**
   * Defence a province will have when an army arrives. The defender keeps
   * reinforcing during the march, so the odds must use this number — that is
   * what the battle resolver sees.
   */
  projectedDefense(provinceId, seconds) {
    const p = this.state.provinces[provinceId];
    if (!p) return 0;
    if (!p.owner) return this.defenseValue(provinceId);
    const projected = { ...p, garrison: this.projectedGarrison(p, seconds) };
    return this.#defensePower(projected);
  }

  // ---------------------------------------------------------------- morale & peace

  static pairKey(a, b) {
    return a < b ? `${a}|${b}` : `${b}|${a}`;
  }

  /** Breadth-first search for the closest province a nation still owns. */
  #nearestOwnProvince(nationId, provinceId) {
    if (!provinceId) return null;
    const seen = new Set([provinceId]);
    const queue = [provinceId];
    while (queue.length) {
      const id = queue.shift();
      const p = this.state.provinces[id];
      if (p && p.owner === nationId) return p;
      for (const nid of this.neighbors(id)) {
        if (seen.has(nid)) continue;
        seen.add(nid);
        queue.push(nid);
      }
    }
    return null;
  }

  /**
   * A pact is signed while columns are already on the road. Leaving them to
   * march would mean signing a treaty and losing a province to it in the same
   * breath, so every column aimed at the new partner's land turns back.
   */
  #recallColumns(aId, bId) {
    const s = this.state;
    const finalTarget = (army) => (army.path ? army.path[army.path.length - 1] : army.to);
    const kept = [];
    for (const army of s.armies) {
      const enemy = army.owner === aId ? bId : army.owner === bId ? aId : null;
      const target = enemy ? s.provinces[finalTarget(army)] : null;
      if (!enemy || !target || target.owner !== enemy) {
        kept.push(army);
        continue;
      }
      const home = s.provinces[army.from];
      if (home && home.owner === army.owner) {
        home.garrison += army.troops;
        if (army.owner === s.nationId || enemy === s.nationId) {
          this.#log(`Перемирие: колонна ${s.nations[army.owner]?.short ?? ''} возвращена в ${this.provinceName(home.id)}`, 'good');
        }
        continue;
      }
      // Nowhere to go back to: the column keeps walking and is stopped at the
      // border on arrival (see #resolveArrival).
      army.haltedByTruce = true;
      kept.push(army);
    }
    s.armies = kept;
  }

  /** True while the two nations are bound by a truce. */
  hasTruce(a, b) {
    const rel = this.state.relations?.[Game.pairKey(a, b)];
    return Boolean(rel) && rel.truceUntil > this.state.time;
  }

  truceLeft(a, b) {
    const rel = this.state.relations?.[Game.pairKey(a, b)];
    return rel ? Math.max(0, rel.truceUntil - this.state.time) : 0;
  }

  /** How much morale shifts attack and defence (1 ± BAL.moraleRange). */
  moraleModifier(nationId) {
    const nation = this.state.nations[nationId];
    if (!nation) return 1;
    const offset = (nation.morale - 50) / 50;
    return 1 + BAL.moraleRange * Math.max(-1, Math.min(1, offset));
  }

  /** War weariness: long wars cost income. */
  exhaustionModifier(nationId) {
    const nation = this.state.nations[nationId];
    if (!nation) return 1;
    return 1 - BAL.exhaustionIncome * (nation.exhaustion / 100);
  }

  #markClash(a, b) {
    if (!a || !b || a === b) return;
    const key = Game.pairKey(a, b);
    this.state.relations[key] = this.state.relations[key] ?? { truceUntil: 0 };
    // Hostility is a property of the pair, not of a nation: fighting someone
    // else must not look like being at war with the player.
    this.state.relations[key].lastClash = this.state.time;
    const nationA = this.state.nations[a];
    const nationB = this.state.nations[b];
    if (nationA) nationA.lastClash = this.state.time;
    if (nationB) nationB.lastClash = this.state.time;
  }

  /**
   * Should this event go to the player's log? The log is a small window (seven
   * lines) over a map where every AI fights every other AI. Without a filter
   * the two lines that matter — the player's own battle and a column marching
   * at his land — scrolled out of sight within seconds. World news is kept
   * when it is close enough to matter: neutral land being carved up, a capture
   * on the player's border, or a nation about to disappear.
   */
  #logWorthTelling(provinceId, a, b) {
    const s = this.state;
    const playerId = s.nationId;
    if (a === playerId || b === playerId) return true;
    const province = s.provinces[provinceId];
    if (!province) return false;
    // Land on the player's border, or taken from a nation that borders him.
    const touches = this.neighbors(provinceId).some((n) => s.provinces[n].owner === playerId);
    if (touches) return true;
    if (!b) return true; // neutral land being claimed: the map is changing
    const loser = s.nations[b];
    if (loser && this.#provinceCount(b) <= 2) return true; // someone is being finished
    return false;
  }

  /** All men a nation has on the map, garrisons and marching columns alike. */
  armyTotal(nationId) {
    let total = 0;
    for (const p of Object.values(this.state.provinces)) if (p.owner === nationId) total += p.garrison;
    for (const a of this.state.armies) if (a.owner === nationId) total += a.troops;
    return total;
  }

  /**
   * How many other nations are currently fighting `nationId`. Used to stop the
   * whole map from piling onto one country at once: being attacked by two
   * neighbours is a war, being attacked by five is a scripted execution.
   */
  activeAttackers(nationId) {
    let count = 0;
    for (const other of Object.values(this.state.nations)) {
      if (!other.alive || other.id === nationId) continue;
      if (this.hasFoughtRecently(other.id, nationId)) count += 1;
    }
    return count;
  }

  /** True when these two nations traded blows recently (i.e. they are at war). */
  hasFoughtRecently(a, b, window = BAL.peaceTalksWindow) {
    const rel = this.state.relations?.[Game.pairKey(a, b)];
    if (!rel || rel.lastClash === undefined) return false;
    return this.state.time - rel.lastClash < window;
  }

  #adjustMorale(nationId, delta) {
    const nation = this.state.nations[nationId];
    if (!nation) return;
    nation.morale = Math.max(0, Math.min(100, nation.morale + delta));
  }

  #adjustExhaustion(nationId, delta) {
    const nation = this.state.nations[nationId];
    if (!nation) return;
    nation.exhaustion = Math.max(0, Math.min(100, nation.exhaustion + delta));
  }

  /**
   * An AI reaches out to the player. If the two have actually fought, this is a
   * peace offer; if they never clashed, it is a non-aggression pact — offering
   * "peace" to someone you are not fighting makes no sense.
   */
  offerPeace(fromId, kind = null) {
    const from = this.state.nations[fromId];
    if (!from || from.isPlayer) return { ok: false, reason: 'Нельзя' };
    if (this.state.status !== 'playing') return { ok: false, reason: 'Партия завершена' };
    if (this.hasTruce(fromId, this.state.nationId)) return { ok: false, reason: 'Уже перемирие' };
    if (this.state.offers.some((o) => o.from === fromId)) return { ok: false, reason: 'Предложение уже сделано' };
    // One negotiation window per nation: without this the same neighbour asked
    // again the second an offer expired, and the log read like a stuck record.
    if (this.state.time < (from.offersFrom ?? 0)) return { ok: false, reason: 'Слишком рано' };
    const type = kind ?? (this.hasFoughtRecently(fromId, this.state.nationId) ? 'peace' : 'pact');
    const offer = {
      id: this.state.nextOfferId++,
      from: fromId,
      to: this.state.nationId,
      kind: type,
      expires: this.state.time + 45,
    };
    this.state.offers.push(offer);
    from.offersFrom = this.state.time + BAL.offerCooldown;
    this.#log(offerSentence(from.short ?? 'Противник', type), 'war');
    this.#emit('offer', offer);
    return { ok: true, offer };
  }

  /** Player answers a peace offer or a non-aggression pact. */
  answerPeace(offerId, accept) {
    const index = this.state.offers.findIndex((o) => o.id === offerId);
    if (index < 0) return { ok: false, reason: 'Предложение устарело' };
    const offer = this.state.offers[index];
    this.state.offers.splice(index, 1);
    const from = this.state.nations[offer.from];
    const pact = offer.kind === 'pact';
    if (!accept) {
      if (from) from.offersFrom = this.state.time + BAL.offerCooldownAfterRefusal;
      this.#log(
        `${from?.short ?? 'Противник'}: ${pact ? 'пакт отклонён' : 'мир отклонён'}`,
        'war',
      );
      this.#emit('offerClosed', { offer, accepted: false });
      return { ok: true, accepted: false };
    }
    const key = Game.pairKey(offer.from, this.state.nationId);
    const duration = pact ? BAL.pactTruce : BAL.peaceTruce;
    const relief = pact ? BAL.pactRelief : BAL.peaceRelief;
    this.state.relations[key] = this.state.relations[key] ?? { truceUntil: 0 };
    this.state.relations[key].truceUntil = this.state.time + duration;
    this.state.relations[key].kind = pact ? 'pact' : 'peace';
    this.#adjustExhaustion(offer.from, -relief);
    this.#adjustExhaustion(this.state.nationId, -relief);
    this.#recallColumns(offer.from, this.state.nationId);
    this.#log(
      pact
        // Nation names are quoted in the nominative: «с Пруссией» would need
        // hand-written declensions for a dozen shapes of name.
        ? `Пакт о ненападении: ${from?.short ?? 'противник'} — ${Math.round(duration)} с без нападений`
        : `Мир: ${from?.short ?? 'противник'} — перемирие ${Math.round(duration)} с`,
      'good',
    );
    this.#emit('peace', { with: offer.from, until: this.state.relations[key].truceUntil, kind: offer.kind ?? 'peace' });
    this.#emit('offerClosed', { offer, accepted: true });
    return { ok: true, accepted: true, until: this.state.relations[key].truceUntil };
  }

  /** Expires unanswered offers. */
  #tickOffers() {
    const s = this.state;
    if (!s.offers?.length) return;
    const expired = s.offers.filter((o) => o.expires <= s.time);
    if (!expired.length) return;
    s.offers = s.offers.filter((o) => o.expires > s.time);
    for (const offer of expired) {
      // An ignored offer counts as a soft refusal: do not re-ask immediately.
      const from = s.nations[offer.from];
      if (from) from.offersFrom = s.time + BAL.offerCooldown;
      this.#emit('offerClosed', { offer, accepted: false, expired: true });
    }
  }

  /**
   * Breaking a truce is allowed for anyone — the player and the AI alike — but
   * it leaves a mark: the breaker's word is worth less, so every other nation
   * is warier about signing with them later. The victim also remembers.
   */
  breakTruce(withId, byId = this.state.nationId) {
    const key = Game.pairKey(withId, byId);
    const rel = this.state.relations[key];
    if (!rel || rel.truceUntil <= this.state.time) return false;
    const kind = rel.kind ?? 'peace';
    rel.truceUntil = 0;
    rel.kind = null;
    rel.grudge = byId;
    const breaker = this.state.nations[byId];
    const victim = this.state.nations[withId];
    if (breaker) breaker.oathbreaks = (breaker.oathbreaks ?? 0) + 1;
    this.#adjustExhaustion(byId, 8);
    if (byId === this.state.nationId) this.state.playerAggro = true;
    this.#log(
      `${breaker?.short ?? 'Противник'} нарушает ${kind === 'pact' ? 'пакт' : 'перемирие'}: ${victim?.short ?? 'противник'}`,
      breaker?.isPlayer ? 'bad' : 'war',
    );
    this.#emit('truceBroken', { with: withId, by: byId, kind });
    return true;
  }

  /** How many nations this country is currently fighting (used by the AI and the pacts). */
  warCount(nationId) {
    return this.activeAttackers(nationId);
  }

  /**
   * 0..1 estimate of how willing a nation is to sign with the player. The
   * player never sees this number directly: the panel turns it into words.
   * Fear of a strong neighbour, war weariness and other wars all help; a
   * broken word makes everyone warier.
   */
  pactOutlook(nationId) {
    const s = this.state;
    const me = s.nations[s.nationId];
    const them = s.nations[nationId];
    if (!me || !them || !them.alive || !me.alive) return 0;
    if (this.hasTruce(nationId, me.id)) return 1;
    let score = 0.3;
    const power = this.armyTotal(me.id) / Math.max(1, this.armyTotal(nationId));
    // A neighbour that could crush them is a neighbour worth placating.
    score += Math.max(-0.2, Math.min(0.32, Math.log(Math.max(0.2, power)) * 0.2));
    // A hopeless weakling gets no treaty.
    if (power < 0.4) score -= 0.16;
    // Tired armies sign more readily.
    score += (them.exhaustion / 100) * 0.34;
    score += Math.max(0, (55 - them.morale) / 100) * 0.3;
    // Everyone knows a nation already fighting on three fronts wants quiet.
    score += Math.min(0.24, this.warCount(them.id) * 0.08);
    if (this.hasFoughtRecently(nationId, me.id)) {
      // Peace with someone who is losing is easy; with a winner, hard.
      score += this.#provinceCount(them.id) < this.#provinceCount(me.id) ? 0.22 : -0.1;
      score += 0.08;
    }
    // Reputation: every broken pact is remembered by everyone.
    score -= Math.min(0.5, (me.oathbreaks ?? 0) * 0.17);
    const aggression = them.ai?.aggression ?? 0.9;
    if (aggression > 1.05) score -= 0.08;
    else if (aggression < 0.85) score += 0.06;
    return Math.max(0.02, Math.min(0.97, score));
  }

  /** The player offers a pact (or peace, if the two have actually fought). */
  proposePact(nationId) {
    const s = this.state;
    if (s.status !== 'playing') return { ok: false, reason: 'Партия завершена' };
    const them = s.nations[nationId];
    if (!them || !them.alive) return { ok: false, reason: 'Державы больше нет' };
    if (nationId === s.nationId) return { ok: false, reason: 'Это ваша держава' };
    if (this.hasTruce(nationId, s.nationId)) return { ok: false, reason: 'Пакт уже действует' };
    if (s.time < (them.pactAskedUntil ?? 0)) {
      return { ok: false, reason: 'Они уже ответили — попробуйте позже' };
    }
    const chance = this.pactOutlook(nationId);
    const accepted = this.rng.chance(chance);
    them.pactAskedUntil = s.time + (accepted ? BAL.offerCooldown : BAL.offerCooldownAfterRefusal);
    const pact = !this.hasFoughtRecently(nationId, s.nationId);
    if (!accepted) {
      this.#log(`Отказ: ${them.short} не подписывает ${pact ? 'пакт' : 'мир'}`, 'war');
      this.#emit('pact', { with: nationId, accepted: false, chance, kind: pact ? 'pact' : 'peace' });
      return { ok: true, accepted: false, chance };
    }
    const key = Game.pairKey(nationId, s.nationId);
    const duration = pact ? BAL.pactTruce : BAL.peaceTruce;
    s.relations[key] = s.relations[key] ?? { truceUntil: 0 };
    s.relations[key].truceUntil = s.time + duration;
    s.relations[key].kind = pact ? 'pact' : 'peace';
    s.relations[key].grudge = null;
    this.#adjustExhaustion(nationId, -(pact ? BAL.pactRelief : BAL.peaceRelief) * 0.5);
    this.#recallColumns(nationId, s.nationId);
    this.#log(
      pact
        ? `Пакт о ненападении: ${them.short} — ${Math.round(duration)} с без нападений`
        : `Мир: ${them.short} — перемирие ${Math.round(duration)} с`,
      'good',
    );
    this.#emit('peace', { with: nationId, until: s.relations[key].truceUntil, kind: pact ? 'pact' : 'peace' });
    this.#emit('pact', { with: nationId, accepted: true, chance, kind: pact ? 'pact' : 'peace' });
    return { ok: true, accepted: true, chance, until: s.relations[key].truceUntil, kind: pact ? 'pact' : 'peace' };
  }

  /** Seconds left on a truce with `withId` (0 when there is none). */
  truceLeft(withId, nationId = this.state.nationId) {
    const rel = this.state.relations?.[Game.pairKey(withId, nationId)];
    if (!rel) return 0;
    return Math.max(0, rel.truceUntil - this.state.time);
  }

  /** True when the player broke a pact with this nation and it remembers. */
  holdsGrudge(nationId) {
    const rel = this.state.relations?.[Game.pairKey(nationId, this.state.nationId)];
    return rel?.grudge === this.state.nationId;
  }

  /** Truce partners of a nation (for the diplomacy list in the pause menu). */
  trucesOf(nationId) {
    const out = [];
    for (const [key, rel] of Object.entries(this.state.relations ?? {})) {
      if (rel.truceUntil <= this.state.time) continue;
      const [a, b] = key.split('|');
      if (a === nationId) out.push({ id: b, left: rel.truceUntil - this.state.time });
      else if (b === nationId) out.push({ id: a, left: rel.truceUntil - this.state.time });
    }
    return out;
  }

  provinceCount(nationId) {
    return this.#provinceCount(nationId);
  }

  /** Current ambition of a nation, or null when the whole chain is done. */
  focusOf(nationId = this.state.nationId) {
    const nation = this.state.nations[nationId];
    const chain = nation?.focus?.chain;
    if (!chain?.length) return null;
    return chain[nation.focus.index] ?? null;
  }

  /** 1-based position in the chain and its length, for «2 из 3» in the panel. */
  focusProgress(nationId = this.state.nationId) {
    const nation = this.state.nations[nationId];
    const chain = nation?.focus?.chain ?? [];
    return { step: Math.min(chain.length, (nation?.focus?.index ?? 0) + 1), total: chain.length, done: nation?.focus?.index ?? 0 };
  }

  /** Test hook: the same check the capture path runs. */
  checkFocusForTests(nationId) {
    this.#checkFocus(nationId);
  }

  /**
   * Called whenever land changes hands: a focus whose target is now ours pays
   * out and the next one becomes active. AI nations run the same chains, so the
   * bonus is not a player-only advantage.
   */
  #checkFocus(nationId) {
    const nation = this.state.nations[nationId];
    if (!nation?.focus) return;
    for (let guard = 0; guard < 4; guard += 1) {
      const step = this.focusOf(nationId);
      if (!step) return;
      const target = this.state.provinces[step.target];
      if (!target || target.owner !== nationId) return;
      nation.gold += step.gold;
      this.#adjustMorale(nationId, step.morale);
      nation.focus.index += 1;
      if (nation.isPlayer) {
        this.#log(`Фокус выполнен: ${step.name} — +${step.gold} золота, +${step.morale} духа`, 'good');
      }
      this.#emit('focus', { nationId, step, index: nation.focus.index });
    }
  }

  upgrade(provinceId, kind) {
    const p = this.state.provinces[provinceId];
    const nation = this.player;
    if (this.state.status !== 'playing') return { ok: false, reason: 'Партия завершена' };
    if (!UPGRADES[kind]) return { ok: false, reason: 'Неизвестное улучшение' };
    if (!p || p.owner !== nation.id) return { ok: false, reason: 'Провинция не ваша' };
    const level = p[kind] ?? 0;
    if (level >= BAL.maxLevel) return { ok: false, reason: 'Максимальный уровень' };
    const cost = BAL.upgradeCosts[kind][level];
    if (nation.gold < cost) return { ok: false, reason: 'Не хватает золота' };
    nation.gold -= cost;
    p[kind] = level + 1;
    this.#emit('upgrade', { provinceId, kind, level: level + 1 });
    return { ok: true, level: level + 1, cost };
  }

  /** What one more level of an upgrade would change in this province right now. */
  upgradePreview(provinceId, kind) {
    const p = this.state.provinces[provinceId];
    if (!p || !UPGRADES[kind]) return null;
    if (kind === 'factory') {
      const gold = (BAL.incomeBase + p.pop * BAL.incomePop) * BAL.factoryIncome;
      const recruits = (BAL.manpowerBase + p.pop * BAL.manpowerPop) * BAL.factoryManpower;
      return {
        gold,
        recruits,
        text: `+${gold.toFixed(2)} золота/с, +${Math.round(recruits * 60)} рекрутов/мин`,
      };
    }
    if (kind === 'barracks') {
      const before = this.#maxGarrison(p);
      const after = this.#maxGarrison({ ...p, barracks: p.barracks + 1 });
      return {
        garrison: after - before,
        text: `+${Math.round(after - before)} к гарнизону, быстрее пополнение`,
      };
    }
    // Use the same defence function the battle uses, so the preview cannot drift
    // from reality (it also covers the over-norm supply discount).
    const before = this.#defensePower(p);
    const after = this.#defensePower({ ...p, fort: p.fort + 1 });
    const defense = after - before;
    return { defense, text: `+${Math.round(defense)} к обороне сейчас` };
  }

  castOrder(kind) {
    const nation = this.player;
    const o = this.state.orders;
    if (this.state.status !== 'playing') return { ok: false, reason: 'Партия завершена' };
    if (!ORDERS[kind]) return { ok: false, reason: 'Неизвестный приказ' };
    if (this.state.time < o[`${kind}Ready`]) {
      return { ok: false, reason: 'Приказ ещё не готов', cooldown: o[`${kind}Ready`] - this.state.time };
    }
    const cost = BAL.orderGold[kind];
    if (nation.gold < cost) return { ok: false, reason: 'Не хватает золота' };
    nation.gold -= cost;

    if (kind === 'mobilize') {
      const owned = this.#ownedProvinces(nation.id);
      const wants = owned.map((p) =>
        Math.max(0, Math.min(this.#maxGarrison(p) * BAL.mobilizeShare, this.#maxGarrison(p) - p.garrison)),
      );
      const totalWanted = wants.reduce((a, b) => a + b, 0);
      if (totalWanted < 1) {
        nation.gold += cost;
        return { ok: false, reason: 'Все гарнизоны уже полны' };
      }
      const budget = Math.min(nation.manpower, totalWanted);
      if (budget < 1) {
        nation.gold += cost;
        return { ok: false, reason: 'Нет рекрутов' };
      }
      const scale = budget / (totalWanted || 1);
      owned.forEach((p, i) => {
        p.garrison += wants[i] * scale;
      });
      nation.manpower -= budget;
      this.#log(`Мобилизация: +${Math.round(budget)} рекрутов в строй`, 'order');
    } else if (kind === 'tax') {
      o.taxUntil = this.state.time + BAL.buffDuration.tax;
      this.#log('Военный налог: доход удвоен', 'order');
    } else if (kind === 'march') {
      o.marchUntil = this.state.time + BAL.buffDuration.march;
      this.#log('Форсированный марш: армии ускорены', 'order');
    }
    o[`${kind}Ready`] = this.state.time + BAL.orderCooldown;
    this.#emit('order', { kind });
    return { ok: true };
  }

  // ---------------------------------------------------------------- simulation

  update(dt) {
    if (this.state.status !== 'playing' || !(dt > 0)) return;
    const steps = Math.max(1, Math.min(8, Math.ceil(dt / 0.05)));
    const h = dt / steps;
    for (let i = 0; i < steps && this.state.status === 'playing'; i += 1) {
      this.#step(h);
    }
  }

  #step(dt) {
    const s = this.state;
    s.time += dt;
    s.months += dt * this.scenario.monthsPerSecond;
    this.#economy(dt);
    this.#morale(dt);
    this.#tickOffers();
    this.#reinforce(dt);
    this.#desertion(dt);
    this.#moveArmies(dt);
    this.#think(dt);
    this.#checkEnd();
    s.rng = this.rng.s;
  }

  #economy(dt) {
    const s = this.state;
    for (const nation of Object.values(s.nations)) {
      if (!nation.alive) {
        nation.income = 0;
        continue;
      }
      let income = 0;
      let manpower = 0;
      let pop = 0;
      for (const p of Object.values(s.provinces)) {
        if (p.owner !== nation.id) continue;
        pop += p.pop;
        income += (BAL.incomeBase + p.pop * BAL.incomePop) * (1 + p.factory * BAL.factoryIncome);
        manpower +=
          (BAL.manpowerBase + p.pop * BAL.manpowerPop) * (1 + p.factory * BAL.factoryManpower);
      }
      const ruleEco = nation.isPlayer ? 1 : AI_ECONOMY[this.rules.aiEconomy]?.eco ?? 1;
      income *= (1 + doctrineMod(nation.doctrine, 'income')) * nation.ai.eco * ruleEco;
      income *= this.exhaustionModifier(nation.id);
      if (nation.isPlayer && s.time < s.orders.taxUntil) income *= 2;
      nation.income = income;
      nation.manpowerRate = manpower;
      nation.pop = pop;
      nation.gold += income * dt;
      const cap = BAL.manpowerCapBase + pop * BAL.manpowerCapPop;
      nation.manpower = Math.min(cap, nation.manpower + manpower * dt);
      nation.manpowerCap = cap;
    }
  }

  /** Morale drifts back to neutral; war weariness cools down in quiet times. */
  #morale(dt) {
    const s = this.state;
    for (const nation of Object.values(s.nations)) {
      if (!nation.alive) continue;
      const drift = (BAL.moraleNeutral - nation.morale) * Math.min(1, BAL.moraleDrift * dt);
      nation.morale = Math.max(0, Math.min(100, nation.morale + drift));
      if (s.time - (nation.lastClash ?? -999) > BAL.exhaustionCalmAfter) {
        nation.exhaustion = Math.max(0, nation.exhaustion - BAL.exhaustionDecay * dt);
      }
    }
  }

  /** A beaten nation loses men to desertion until its morale recovers. */
  #desertion(dt) {
    const s = this.state;
    for (const p of Object.values(s.provinces)) {
      if (!p.owner) continue;
      const nation = s.nations[p.owner];
      if (!nation?.alive) continue;
      if (nation.morale >= BAL.desertionBelow) continue;
      const severity = (BAL.desertionBelow - nation.morale) / BAL.desertionBelow;
      const loss = p.garrison * BAL.desertionRate * severity * dt;
      if (loss <= 0) continue;
      p.garrison = Math.max(0, p.garrison - loss);
      if (nation.isPlayer) s.stats.deserted = (s.stats.deserted ?? 0) + loss;
    }
  }

  #reinforce(dt) {
    const s = this.state;

    // Two passes so a full province never starves a depleted one:
    // 1) top every province up to its norm,
    // 2) only then let full provinces keep producing above the norm.
    const owned = Object.values(s.provinces).filter((p) => p.owner && s.nations[p.owner]?.alive);
    const growth = (p) =>
      this.#maxGarrison(p) * BAL.reinforceShare * (1 + p.barracks * BAL.barracksReinforce) * dt;
    const spend = (nation, p, want) => {
      if (want <= 0) return 0;
      const gain = Math.min(want, nation.manpower);
      if (gain <= 0) return 0;
      p.garrison += gain;
      nation.manpower -= gain;
      if (nation.isPlayer) s.stats.recruited = (s.stats.recruited ?? 0) + gain;
      return gain;
    };

    for (const p of owned) {
      const nation = s.nations[p.owner];
      const max = this.#maxGarrison(p);
      if (p.garrison >= max) continue;
      spend(nation, p, Math.min(growth(p), max - p.garrison));
    }

    for (const p of owned) {
      const nation = s.nations[p.owner];
      if (nation.manpower <= 0) continue;
      const max = this.#maxGarrison(p);
      if (p.garrison < max) continue;
      // Beyond the norm the flow continues, just slower: the province is
      // already supplied to capacity, so extra men are a permanent drain.
      const ceiling = max * BAL.overfillCeiling;
      if (p.garrison >= ceiling) continue;
      spend(nation, p, Math.min(growth(p) * BAL.overfillShare, ceiling - p.garrison));
    }
  }

  #moveArmies(dt) {
    const s = this.state;
    const finished = [];
    for (const army of s.armies) {
      const buff = army.owner === s.nationId && s.time < s.orders.marchUntil ? 1.6 : 1;
      army.t += dt * buff;
      if (army.t < army.duration) continue;
      if (!this.#advanceArmy(army)) finished.push(army);
    }
    if (finished.length) s.armies = s.armies.filter((army) => !finished.includes(army));
  }

  /**
   * One hop of a planned march. A column with a route does not stop at every
   * friendly province: it leaves the requested garrison there (if any) and
   * walks on, so an order to the far side of the realm does not need a second
   * drag once the first hop lands.
   */
  #advanceArmy(army) {
    const s = this.state;
    const path = army.path;
    const target = s.provinces[army.to];
    const isFinal = !path || army.leg >= path.length - 1;

    if (!isFinal && target && target.owner === army.owner) {
      const leave = Math.max(0, Math.min(army.leave?.[army.to] ?? 0, army.troops));
      if (leave > 0) {
        target.garrison += leave;
        army.troops -= leave;
        if (army.owner === s.nationId) {
          this.#log(`${this.provinceName(army.to)}: оставлен гарнизон +${Math.round(leave)}`, 'good');
        }
      }
      const nextId = path[army.leg + 1];
      const next = s.provinces[nextId];
      // Only the destination may be hostile; if an intermediate province falls
      // to the enemy mid-march the column has nowhere to walk.
      const blocked = next && next.owner !== army.owner && army.leg + 1 < path.length - 1;
      if (army.troops < BAL.minSend || blocked) {
        // The road ahead is gone (province lost) or nobody is left to march:
        // the column stays where it is instead of vanishing with its men.
        if (army.troops > 0) target.garrison += army.troops;
        if (blocked && army.owner === s.nationId) {
          this.#log(`Поход прерван: ${this.provinceName(nextId)} больше не ваша`, 'bad');
        }
        return false;
      }
      army.leg += 1;
      army.from = army.to;
      army.to = nextId;
      army.duration = this.travelTime(army.from, army.to, army.owner);
      army.sea = this.isSeaRoute(army.from, army.to);
      army.t = 0;
      return true;
    }

    this.#resolveArrival(army);
    return false;
  }

  #resolveArrival(army) {
    const s = this.state;
    const target = s.provinces[army.to];
    const attacker = s.nations[army.owner];
    if (!target || !attacker) return;

    // The treaty was signed while this column was already marching at the
    // partner's land (its home province may have been lost meanwhile). It must
    // not capture anything: send the men to the nearest friendly province.
    if (target.owner && target.owner !== army.owner && this.hasTruce(army.owner, target.owner)) {
      const home = s.provinces[army.from]?.owner === army.owner ? s.provinces[army.from] : this.#nearestOwnProvince(army.owner, army.from);
      if (home) home.garrison += army.troops;
      if (army.owner === s.nationId) {
        this.#log(`Перемирие: колонна остановлена на границе, ${Math.round(army.troops)} возвращены`, 'good');
      }
      return;
    }

    // Friendly move: reinforce. Troops stack above the garrison cap instead of
    // evaporating, and the excess is reported so the player can see it.
    if (target.owner === army.owner) {
      const before = target.garrison;
      target.garrison += army.troops;
      const over = target.garrison - this.#maxGarrison(target);
      if (over > 0) {
        this.#emit('overstack', { provinceId: target.id, troops: army.troops, over });
      }
      if (this.state.provinces[army.to] && before !== target.garrison && army.owner === this.state.nationId) {
        this.#log(`${this.provinceName(target.id)}: подкрепление +${Math.round(army.troops)}`, 'good');
      }
      return;
    }

    const defender = target.owner ? s.nations[target.owner] : null;
    const defPower = this.defenseValue(target.id);
    const atkPower = army.troops * this.attackModifier(army.owner);
    const chance = Game.winChance(atkPower, defPower);
    // rng.next() is always < 1, so chance 1 wins and chance 0 loses by construction.
    const roll = this.rng.next();
    s.stats.battles += 1;

    const attackerWins = roll < chance;
    if (attackerWins) {
      const ratio = defPower / Math.max(1, atkPower);
      const survivors = Math.max(1, Math.round(army.troops * (1 - BAL.loserSurvivorBase * Math.min(0.95, ratio))));
      const previousOwner = target.owner;
      target.owner = army.owner;
      target.garrison = survivors;
      if (target.fort > 0) target.fort -= 1;
      attacker.alive = true;
      attacker.eliminated = false;

      if (attacker.isPlayer) s.stats.captured += 1;
      if (previousOwner === s.nationId) s.stats.lostProvinces += 1;

      if (this.#logWorthTelling(target.id, army.owner, previousOwner)) {
        this.#log(
          previousOwner
            ? `${this.provinceName(target.id)}: ${s.nations[previousOwner]?.short ?? '—'} → ${attacker.short} (${Math.round(atkPower)} против ${Math.round(defPower)})`
            : `${this.provinceName(target.id)}: нейтральная → ${attacker.short} (${Math.round(atkPower)} против ${Math.round(defPower)})`,
          previousOwner === s.nationId ? 'bad' : attacker.isPlayer ? 'good' : 'war',
        );
      }
      this.#emit('capture', {
        provinceId: target.id,
        from: previousOwner,
        to: army.owner,
        losers: Math.round(defPower),
        defense: Math.round(defPower),
        attack: Math.round(atkPower),
        roll,
        survivors,
        sent: army.troops,
      });
      this.#markClash(previousOwner, army.owner);
      this.#adjustMorale(army.owner, BAL.moraleWin);
      this.#adjustExhaustion(army.owner, BAL.exhaustionWin);
      if (previousOwner) {
        this.#adjustMorale(previousOwner, -BAL.moraleLose);
        this.#adjustExhaustion(previousOwner, BAL.exhaustionCapture);
        this.#adjustExhaustion(previousOwner, BAL.exhaustionLose);
        this.#markClash(previousOwner, army.owner);
      }
      if (previousOwner) this.#refreshNation(previousOwner);
      this.#refreshNation(army.owner);
      this.#checkFocus(army.owner);
    } else {
      const ratio = (atkPower * roll) / Math.max(1, defPower);
      const survivors = Math.max(1, Math.round(target.garrison * (1 - BAL.loserSurvivorBase * Math.min(0.95, ratio))));
      target.garrison = survivors;
      this.#markClash(target.owner, army.owner);
      this.#adjustMorale(army.owner, -BAL.moraleLose);
      this.#adjustExhaustion(army.owner, BAL.exhaustionLose);
      if (target.owner) {
        this.#adjustMorale(target.owner, BAL.moraleWin);
        this.#adjustExhaustion(target.owner, BAL.exhaustionWin);
      }
      if (defender?.isPlayer) s.stats.battlesWon += 1;
      // A beaten defender may sally out and hit the province the attack came from.
      if (
        target.owner &&
        defender?.alive &&
        !this.hasTruce(target.owner, army.owner) &&
        target.garrison > BAL.minSend * 4 &&
        this.rng.chance(BAL.counterAttack)
      ) {
        const home = s.provinces[army.from];
        if (home && home.owner === army.owner && this.neighbors(army.from).includes(target.id)) {
          const marched = Math.floor(target.garrison * BAL.counterAttackMargin);
          if (marched >= BAL.minSend) {
            this.#log(`Контрудар: ${defender.short} → ${this.provinceName(army.from)}`, 'war');
            this.launchArmy(target.owner, target.id, army.from, BAL.counterAttackMargin);
          }
        }
      }
      // A failed AI attack on another AI is background noise; the player's own
      // battles always show.
      if (this.#logWorthTelling(target.id, army.owner, target.owner)) {
        this.#log(
          `Отбита атака: ${this.provinceName(target.id)}${defender ? ` (${defender.short})` : ''} — ${Math.round(atkPower)} против ${Math.round(defPower)}`,
          defender?.isPlayer ? 'good' : 'war',
        );
      }
      this.#emit('battle', {
        provinceId: target.id,
        attacker: army.owner,
        defender: target.owner,
        success: false,
        attack: Math.round(atkPower),
        defense: Math.round(defPower),
        roll,
        sent: army.troops,
      });
      this.#refreshNation(army.owner);
    }
  }

  #refreshNation(nationId) {
    const s = this.state;
    const nation = s.nations[nationId];
    if (!nation) return;
    const owns = this.#provinceCount(nationId) > 0;
    const hasArmy = this.#hasArmies(nationId);
    const alive = owns || hasArmy;
    if (nation.alive && !alive) {
      nation.alive = false;
      nation.eliminated = true;
      if (nation.isPlayer) {
        this.#log('Ваша держава пала', 'bad');
      } else if (!nation.isPlayer) {
        this.#log(`Держава «${nation.short}» уничтожена`, 'war');
      }
      this.#emit('eliminated', { nationId });
    } else if (!nation.alive && alive) {
      nation.alive = true;
    }
  }

  #think(dt) {
    for (const nation of Object.values(this.state.nations)) {
      if (!nation.alive || nation.isPlayer) continue;
      nation.ai.nextThink -= dt;
      if (nation.ai.nextThink > 0) continue;
      const aggression =
        nation.ai.aggression *
        (this.scenario.balance.aiAggression ?? 1) *
        (AI_STYLE[this.rules.aiStyle]?.aggression ?? 1);
      nation.ai.nextThink = BAL.aiThinkBase / Math.max(0.35, aggression) + this.rng.range(0, 1.4);
      aiThink(this, nation);
    }
  }

  #checkEnd() {
    const s = this.state;
    if (s.status !== 'playing') return;
    const player = this.player;
    const total = Object.keys(s.provinces).length;
    const owned = this.#provinceCount(player.id);
    s.stats.peak = Math.max(s.stats.peak, owned);
    // One victory condition only: the whole theatre under your crown. Taking a
    // share of the map is progress, not a win, and nobody else can win early either.
    if (owned >= total) {
      s.status = 'victory';
      this.#log(`Победа: ${THEATRE_GENITIVE[this.scenario.theatre] ?? 'Европы'} под вашей короной`, 'good');
      this.#emit('end', { result: 'victory', owned, total });
      return;
    }
    this.#refreshNation(player.id);
    if (!player.alive) {
      s.status = 'defeat';
      this.#log('Поражение: держава потеряла все земли', 'bad');
      this.#emit('end', { result: 'defeat', reason: 'eliminated', owned, total });
    }
  }

  // ---------------------------------------------------------------- meta

  get progress() {
    const total = Object.keys(this.state.provinces).length;
    const owned = this.#provinceCount(this.state.nationId);
    return { owned, total, share: total ? owned / total : 0 };
  }

  get dateLabel() {
    const total = Math.floor(this.state.months);
    const year = Math.floor(total / 12);
    const month = total % 12;
    const names = ['янв', 'фев', 'мар', 'апр', 'мая', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];
    return `${names[month]} ${year}`;
  }

  serialize() {
    return {
      version: SAVE_VERSION,
      scenarioId: this.state.scenarioId,
      nationId: this.state.nationId,
      rng: this.rng.s,
      state: this.state,
    };
  }

  /** Final score: land, conquests and speed, minus losses. Pure and testable. */
  score() {
    const s = this.state;
    const stats = s.stats;
    const total = Object.keys(s.provinces).length;
    const owned = this.#provinceCount(s.nationId);
    const years = Math.max(0, (s.months - this.scenario.startYear * 12) / 12);
    const share = owned / total;
    const speedBonus = Math.round(Math.max(0, 1 - years / 25) * 400);
    const base = Math.round(
      share * 1000 +
        (stats.captured ?? 0) * 60 +
        (stats.battlesWon ?? 0) * 25 -
        (stats.lostProvinces ?? 0) * 40 +
        speedBonus,
    );
    const victory = s.status === 'victory';
    return {
      total: Math.max(0, base + (victory ? 500 : 0)),
      base,
      share,
      owned,
      speedBonus,
      victory,
      years,
    };
  }

  static deserialize(save, map) {
    if (!save || save.version !== SAVE_VERSION) return null;
    const nation = save.state?.nations?.[save.state.nationId];
    if (!nation) return null;
    const game = new Game({
      scenarioId: save.state.scenarioId,
      nationId: save.state.nationId,
      doctrineId: nation.doctrine,
      map,
      seed: save.rng ?? 1,
    });
    game.state = save.state;
    game.state.rules = normalizeRules(save.state.rules ?? {});
    game.rules = game.state.rules;
    game.rng.s = save.rng >>> 0;
    return game;
  }
}
