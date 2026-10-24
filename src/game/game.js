import { getScenario, THEATRE_GENITIVE } from '../data/scenarios.js';
import { BAL, UPGRADES, ORDERS, doctrineMod } from './balance.js';
import { Rng } from './rng.js';
import { aiThink, assignDoctrine } from './ai.js';
import { normalizeRules, AI_STYLE, AI_ECONOMY, NEUTRAL_STRENGTH } from './rules.js';
import { offerSentence, marchesVerb, plural } from './text.js';
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
      // Standing orders: «when this province holds N men, send the rest to X».
      autos: [],
      nextAutoId: 1,
      // Columns that have arrived and are waiting for the rest of the force.
      assaults: [],
      nextAssaultId: 1,
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
    // A nation that holds a single province gets a second level: one province
    // means the capital *is* the country.
    for (const n of sc.nations) {
      const capital = state.provinces[n.capital];
      if (!capital || capital.owner !== n.id) continue;
      const single = n.provinces.length === 1;
      capital.fort = Math.max(single ? 2 : 1, capital.fort);
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
        // The player is asked which way to go first; the AI picks its own road
        // without a card, since nobody would answer for it.
        pick: nation.isPlayer ? null : 'main',
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
    let dx = pa[0] - pb[0];
    // The world map is a cylinder: Chukotka and Alaska are two units apart
    // across the date line, not a whole planet apart the other way round.
    const period = this.map?.wrap?.period;
    if (period) {
      dx = Math.abs(dx) % period;
      if (dx > period / 2) dx = period - dx;
    }
    return Math.hypot(dx, pa[1] - pb[1]);
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
    return (
      effective *
      (1 + p.fort * BAL.fortDefense) *
      (1 + doctrineMod(owner?.doctrine, 'defense')) *
      morale *
      this.#homelandMul(p)
    );
  }

  /**
   * Capitals and the last two provinces of a nation defend harder. It is the
   * same rule for the player and the AI: a nation is not wiped out in one
   * afternoon, and a rump state can still bite.
   */
  #homelandMul(p) {
    if (!p.owner) return 1;
    let mul = 1;
    if (this.state.nations[p.owner]?.capital === p.id) mul += BAL.capitalDefense;
    if (this.#provinceCount(p.owner) <= 2) mul += BAL.lastStandDefense;
    return mul;
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
    const homelandMul = this.#homelandMul(p);
    return {
      garrison: p.garrison,
      above,
      effective: Math.min(p.garrison, max) + above * BAL.overstackDefense,
      max,
      fortMul,
      doctrineMul,
      moraleMul,
      homelandMul,
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
    // route: through the player's own provinces, or through a nation that gave
    // us a right of passage — that is how a column reaches the far end of the
    // realm (or Alaska reaches the mainland) without waiting for each hop.
    const route = this.neighbors(fromId).includes(toId) ? [fromId, toId] : this.routeBetween(fromId, toId);
    if (!route) return { ok: false, reason: 'Нет пути: нужен проход через чужую землю' };
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
        route,
        through: this.routeThrough(route),
        reason: `Пакт о ненападении с ${this.state.nations[to.owner]?.short ?? 'противником'}`,
      };
    }
    // Marching into the land of a nation that let us through is a betrayal:
    // allowed, but the player is told about it by the caller.
    const betrayal =
      to.owner && to.owner !== this.state.nationId && this.hasPassage(to.owner, this.state.nationId)
        ? to.owner
        : null;
    return { ok: true, route, through: this.routeThrough(route), betrayal };
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
        if (!p) continue;
        // Own land and land we hold a right of passage through: both are road.
        if (p.owner !== me && !this.hasPassage(p.owner, me)) continue;
        const foreign = p.owner !== me;
        const cost =
          dist.get(current) + this.travelTime(current, nid) * (foreign ? BAL.passageTravelMul : 1);
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
        // Walk through our own land or through a nation that signed us a right
        // of passage; the destination itself may be hostile.
        if (nid !== toId && !this.canTransit(nationId, nid)) continue;
        const foreign = p.owner !== nationId && nid !== toId;
        const cost =
          dist.get(current) + this.travelTime(current, nid, nationId) * (foreign ? BAL.passageTravelMul : 1);
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
    const last = path.length - 1;
    for (let i = 1; i < path.length; i += 1) {
      const foreign = this.state.provinces[path[i]]?.owner !== nationId && i !== last;
      total += this.travelTime(path[i - 1], path[i], nationId) * (foreign ? BAL.passageTravelMul : 1);
    }
    return total;
  }

  /**
   * Nations whose land a route crosses without owning it. Used by the UI to
   * say «через Канаду» instead of silently marching through a third country.
   */
  routeThrough(path, nationId = this.state.nationId) {
    const seen = [];
    for (const id of path.slice(1, -1)) {
      const owner = this.state.provinces[id]?.owner;
      if (owner && owner !== nationId && !seen.includes(owner)) seen.push(owner);
    }
    return seen;
  }

  sendTroops(fromId, toId, ratio = this.state.sendRatio, options = {}) {
    const check = this.canSend(fromId, toId);
    if (!check.ok) return check;
    const route = options.forceRoute
      ? this.routeBetween(fromId, toId)
      : check.route ?? this.routeBetween(fromId, toId);
    if (!route) return { ok: false, reason: 'Нет пути: нужен проход через чужую землю' };
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
      through: this.routeThrough(route),
      betrayal: check.betrayal,
      routeTime: this.routeTime(route),
    };
  }

  /**
   * Columns of a nation that started in this province and are still on the
   * road. Used by the province card: a march that turns out to be a bad idea
   * must be cancellable, not a decision made once and forever.
   */
  armiesFrom(provinceId, nationId = this.state.nationId) {
    return this.state.armies
      .filter((army) => army.owner === nationId && (army.path ? army.path[0] : army.from) === provinceId)
      .map((army) => ({
        id: army.id,
        to: army.path ? army.path[army.path.length - 1] : army.to,
        troops: army.troops,
        left: Math.max(0, army.duration - army.t),
        returning: Boolean(army.recalled),
        sea: Boolean(army.sea),
      }));
  }

  /**
   * Turns a column back before it reaches its target. The men walk home
   * instead of disappearing: a recalled march costs the time already spent and
   * nothing else. Shared by the player and the AI.
   */
  recallArmy(armyId, nationId = this.state.nationId) {
    const army = this.state.armies.find((a) => a.id === armyId && a.owner === nationId);
    if (!army) return { ok: false, reason: 'Колонны уже нет' };
    if (army.recalled) return { ok: false, reason: 'Уже возвращается' };
    const s = this.state;
    // Everything behind the leg in progress, the province it left first.
    const behind = army.path ? army.path.slice(0, Math.max(1, army.leg)) : [army.from];
    const back = [...behind].reverse();
    const remaining = Math.max(BAL.minTravel, Math.min(army.t || BAL.minTravel, army.duration));
    army.recalled = true;
    army.path = back;
    army.leg = 0;
    army.from = back[0];
    army.to = back[0];
    army.t = 0;
    army.duration = remaining;
    army.sea = false;
    if (nationId === s.nationId) {
      this.#log(`Колонна отозвана: ${this.provinceName(back[0])} — ${Math.round(army.troops)} чел. возвращаются`, 'order');
    }
    this.#emit('recall', { armyId, provinceId: back[0], troops: army.troops, by: nationId });
    return { ok: true, troops: army.troops, to: back[0] };
  }

  /**
   * Sends a column along a land/sea route for any nation. The AI uses it to
   * march through a right of passage as well; the player reaches it through
   * sendTroops, which also handles the «через Канаду» feedback.
   */
  launchRouteFor(nationId, fromId, toId, ratio = 0.5) {
    const route = this.routeBetween(fromId, toId, nationId);
    if (!route || route.length < 2) return 0;
    return this.#launchRoute(nationId, route, ratio, {});
  }

  // ---------------------------------------------------------------- auto orders

  /** Every standing order of the player, newest last. */
  autoOrders() {
    return this.state.autos ?? [];
  }

  /** Orders that start in `provinceId`. */
  autoOrdersFrom(provinceId) {
    return this.autoOrders().filter((order) => order.from === provinceId);
  }

  /**
   * «When this province holds `when` men, march everything above `keep` to
   * `to`». A player asking for a repeating transfer used to click the same
   * drag every twenty seconds; this is that click, written down once.
   */
  addAuto(fromId, toId, when, keep) {
    const s = this.state;
    const from = s.provinces[fromId];
    if (!from || from.owner !== s.nationId) return { ok: false, reason: 'Это не ваша провинция' };
    if (fromId === toId) return { ok: false, reason: 'Провинции совпадают' };
    if (!this.neighbors(fromId).includes(toId) && !this.routeBetween(fromId, toId)) {
      return { ok: false, reason: 'Нет пути по своим провинциям' };
    }
    const norm = this.maxGarrison(fromId);
    const threshold = Math.max(BAL.minSend * 2, Math.round(when));
    const left = Math.max(BAL.minSend, Math.min(Math.round(keep), threshold - BAL.minSend));
    const existing = this.autoOrders().find((order) => order.from === fromId && order.to === toId);
    if (existing) {
      existing.when = threshold;
      existing.keep = left;
      return { ok: true, order: existing, updated: true };
    }
    if (this.autoOrdersFrom(fromId).length >= 3) {
      return { ok: false, reason: 'Из одной провинции — не больше трёх приказов' };
    }
    const order = { id: s.nextAutoId ?? 1, from: fromId, to: toId, when: threshold, keep: left, norm };
    s.nextAutoId = (s.nextAutoId ?? 1) + 1;
    s.autos = [...this.autoOrders(), order];
    this.#log(`Автоотправка: ${this.provinceName(fromId)} → ${this.provinceName(toId)} при ${threshold} чел.`, 'info');
    return { ok: true, order };
  }

  removeAuto(id) {
    const before = this.autoOrders();
    const after = before.filter((order) => order.id !== id);
    if (after.length === before.length) return false;
    this.state.autos = after;
    return true;
  }

  /** Visible for tests: how many men one order would send right now. */
  autoAmount(order) {
    const from = this.state.provinces[order.from];
    if (!from || from.owner !== this.state.nationId) return 0;
    return Math.max(0, Math.floor(from.garrison - order.keep));
  }

  #runAutos() {
    const s = this.state;
    for (const order of this.autoOrders()) {
      const from = s.provinces[order.from];
      if (!from || from.owner !== s.nationId) continue;
      if (from.garrison < order.when) continue;
      const amount = Math.floor(from.garrison - order.keep);
      if (amount < BAL.minSend) continue;
      // One column per order at a time: the next one leaves after this arrives.
      if (s.armies.some((army) => army.autoId === order.id)) continue;
      const adjacent = this.neighbors(order.from).includes(order.to);
      const route = adjacent ? null : this.routeBetween(order.from, order.to);
      const ratio = amount / Math.max(1, from.garrison);
      const before = from.garrison;
      let sent = 0;
      if (route) {
        sent = this.#launchRoute(s.nationId, route, ratio, {});
      } else {
        sent = this.launchArmy(s.nationId, order.from, order.to, ratio);
      }
      if (sent <= 0) continue;
      const army = s.armies[s.armies.length - 1];
      if (army) {
        army.autoId = order.id;
        army.autoKeep = order.keep;
      }
      // The province must keep its promise: `launchArmy` rounds down, so put
      // back whatever would have dropped the garrison below the reserve.
      const leftover = from.garrison;
      if (leftover < order.keep && army) {
        const giveBack = Math.min(army.troops, order.keep - leftover);
        army.troops -= giveBack;
        from.garrison += giveBack;
        if (army.troops < BAL.minSend) {
          from.garrison += army.troops;
          s.armies.pop();
          continue;
        }
      }
      this.#log(
        `Автоотправка: ${this.provinceName(order.from)} → ${this.provinceName(order.to)} (${Math.round(army?.troops ?? sent)} из ${Math.round(before)})`,
        'auto',
      );
      this.#emit('auto', { from: order.from, to: order.to, amount: sent });
    }
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
    this.#seaToll(army);
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
    const army = {
      id: this.state.nextArmyId++,
      owner: nationId,
      from: fromId,
      to: toId,
      troops: amount,
      t: 0,
      duration,
      sea,
    };
    this.#seaToll(army);
    this.state.armies.push(army);

    this.#onAttack(nationId, toId);
    this.#announceIncoming({ to: toId, from: fromId, troops: army.troops }, nationId);
    return army.troops;
  }

  /**
   * An enemy column heading for your land used to be visible only as an arrow
   * on the globe: easy to miss, and the first news was the province falling.
   */
  #announceIncoming(army, nationId) {
    // A column may cross our land on its way somewhere else: only its *final*
    // destination matters, otherwise a friendly transit is announced as an
    // attack on the province it merely passes through.
    const finalId = army.path ? army.path[army.path.length - 1] : army.to;
    const target = this.state.provinces[finalId];
    if (target?.owner !== this.state.nationId || nationId === this.state.nationId) return;
    const attacker = this.state.nations[nationId];
    // No case declension of province names: the arrow form already used for
    // captures reads the same for «Латвия», «Кипр» and «США».
    const who = attacker?.short ?? 'Противник';
    this.#log(`${who} ${marchesVerb(who)} войска: ${army.troops} → ${this.provinceName(finalId)}`, 'bad');
    // The folded log must not hide the one message that needs an answer now.
    this.#emit('incoming', { to: finalId, from: army.from, amount: army.troops, attacker: nationId });
  }

  /** Seconds an army needs for the march. Includes the player's march bonus. */
  travelTime(fromId, toId, nationId = this.state.nationId) {
    const sea = this.isSeaRoute(fromId, toId);
    const marchBuff = this.marchBuff(nationId);
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
    // Columns already marching home count: without this, the forecast shown to
    // the player ignored the very help the AI had just sent, and a «70 %»
    // attack landed on a province that had doubled its garrison in the air.
    let inbound = 0;
    for (const army of this.state.armies ?? []) {
      if (army.owner !== p.owner) continue;
      const target = army.path ? army.path[army.path.length - 1] : army.to;
      if (target !== p.id) continue;
      if (army.duration - army.t > seconds) continue;
      inbound += army.troops;
    }
    if (!nation || !nation.alive) return p.garrison + inbound;
    if (seconds <= 0) return p.garrison + inbound;
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
    return garrison + inbound;
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

  // ------------------------------------------------------------- right of passage

  /**
   * Seconds left on the permission `giverId` gave `receiverId` to march through
   * its land (0 when there is none). Stored per giver inside the pair, because
   * two neighbours may grant passage to each other at the same time.
   */
  passageLeft(giverId, receiverId) {
    const rel = this.state.relations?.[Game.pairKey(giverId, receiverId)];
    const until = rel?.passage?.[giverId] ?? 0;
    return Math.max(0, until - this.state.time);
  }

  hasPassage(giverId, receiverId) {
    return Boolean(giverId) && giverId !== receiverId && this.passageLeft(giverId, receiverId) > 0;
  }

  /** Every nation whose land the given country may cross right now. */
  passageHolders(nationId) {
    return Object.values(this.state.nations)
      .filter((other) => other.alive && this.hasPassage(other.id, nationId))
      .map((other) => other.id);
  }

  #grantPassage(giverId, receiverId, seconds = BAL.passageTruce) {
    const key = Game.pairKey(giverId, receiverId);
    this.state.relations[key] = this.state.relations[key] ?? { truceUntil: 0 };
    this.state.relations[key].passage = this.state.relations[key].passage ?? {};
    this.state.relations[key].passage[giverId] = this.state.time + seconds;
  }

  #revokePassage(giverId, receiverId) {
    const rel = this.state.relations?.[Game.pairKey(giverId, receiverId)];
    if (!rel?.passage?.[giverId]) return false;
    delete rel.passage[giverId];
    return true;
  }

  /**
   * Can `nationId` use this province as a step on a march? Own land always,
   * foreign land only with a signed right of passage. A nation that is at war
   * with the owner never gets through — war voids the permission.
   */
  canTransit(nationId, provinceId) {
    const p = this.state.provinces[provinceId];
    if (!p) return false;
    if (p.owner === nationId) return true;
    if (!p.owner) return false;
    return this.hasPassage(p.owner, nationId);
  }

  // --------------------------------------------------------------------- wars

  /** Start of the current war between two nations, or null (no war / truce). */
  warSince(a, b) {
    if (!a || !b || a === b) return null;
    const rel = this.state.relations?.[Game.pairKey(a, b)];
    if (!rel || rel.warSince == null) return null;
    if (rel.truceUntil > this.state.time) return null;
    return rel.warSince;
  }

  hasWar(a, b) {
    return this.warSince(a, b) != null;
  }

  /** Every nation `nationId` is fighting right now, newest war first. */
  warsOf(nationId) {
    const list = [];
    for (const other of Object.values(this.state.nations)) {
      if (other.id === nationId || !other.alive) continue;
      const since = this.warSince(nationId, other.id);
      if (since == null) continue;
      list.push({ id: other.id, since, left: Math.max(0, this.state.time - since) });
    }
    return list.sort((a, b) => a.since - b.since);
  }

  /**
   * Marks a pair as being at war. Called when a column is sent at someone else's
   * land, and again on every battle, so a war does not "expire" because the
   * front went quiet for two minutes.
   */
  #declareWar(a, b) {
    if (!a || !b || a === b) return;
    const key = Game.pairKey(a, b);
    this.state.relations[key] = this.state.relations[key] ?? { truceUntil: 0 };
    const rel = this.state.relations[key];
    if (rel.truceUntil > this.state.time) return; // a truce is still in force
    if (rel.warSince == null) {
      rel.warSince = this.state.time;
      // Snapshot of the front: a capitulation is judged against what the
      // loser held when the war began, not against what is left by the end.
      rel.start = { [a]: this.#provinceCount(a), [b]: this.#provinceCount(b) };
    }
    // War cancels passage in both directions: an enemy does not get a road.
    this.#revokePassage(a, b);
    this.#revokePassage(b, a);
  }

  #endWar(a, b) {
    const rel = this.state.relations?.[Game.pairKey(a, b)];
    if (!rel) return;
    rel.warSince = null;
  }

  /**
   * Ends a war that is already decided. A nation that has lost its capital and
   * most of the land it held when the war began gives up: the rest of its
   * provinces change hands in one step instead of being taken one by one.
   * Only an AI can capitulate — the player's defeat is still «all land lost».
   */
  maybeCapitulate(loserId, winnerId) {
    const s = this.state;
    if (!loserId || !winnerId || loserId === winnerId) return false;
    const loser = s.nations[loserId];
    const winner = s.nations[winnerId];
    if (!loser?.alive || !winner?.alive || loser.isPlayer) return false;
    if (!this.hasWar(loserId, winnerId)) return false;
    const capital = s.provinces[loser.capital];
    if (!capital || capital.owner !== winnerId) return false;
    const rel = s.relations[Game.pairKey(loserId, winnerId)];
    const start = rel?.start?.[loserId] ?? this.#provinceCount(loserId);
    if (start < 2) return false;
    const left = this.#provinceCount(loserId);
    const taken = start - left;
    if (taken < start * BAL.capitulationShare) return false;
    // Nothing left to hand over: that is an ordinary elimination.
    if (left < 1) return false;

    // Transfer everything that is left.
    let moved = 0;
    for (const p of Object.values(s.provinces)) {
      if (p.owner !== loserId) continue;
      p.owner = winnerId;
      moved += 1;
    }
    // Armies in the field are disbanded with the state that raised them.
    s.armies = s.armies.filter((army) => army.owner !== loserId);
    loser.alive = false;
    loser.eliminated = true;
    loser.gold = 0;
    rel.warSince = null;
    rel.start = null;
    rel.truceUntil = s.time + BAL.peaceTruce;
    rel.kind = 'peace';
    this.#adjustExhaustion(winnerId, BAL.capitulationExhaustion);
    this.#log(
      `Капитуляция: ${loser.short} — ${winner.short} получает ${moved} ${moved === 1 ? 'провинцию' : moved < 5 ? 'провинции' : 'провинций'}`,
      winner.isPlayer ? 'good' : 'war',
    );
    this.#emit('capitulation', { loser: loserId, winner: winnerId, provinces: moved });
    this.#refreshNation(winnerId);
    return true;
  }

  /**
   * Two AI nations make peace when the war has worn them both out. Without
   * this the map never stopped burning: every AI fought every neighbour to the
   * last province, and the player's own wars were the only ones that ended.
   */
  maybeAiPeace(nationId) {
    const s = this.state;
    const nation = s.nations[nationId];
    if (!nation?.alive || nation.isPlayer) return false;
    if (nation.exhaustion < BAL.aiPeaceExhaustion) return false;
    if (s.time < (nation.aiPeaceAt ?? 0)) return false;
    nation.aiPeaceAt = s.time + 30;
    for (const other of Object.values(s.nations)) {
      if (!other.alive || other.id === nationId || other.isPlayer) continue;
      const since = this.warSince(nationId, other.id);
      if (since == null || s.time - since < BAL.aiPeaceAfter) continue;
      if (!this.rng.chance(BAL.aiPeaceChance)) continue;
      const key = Game.pairKey(nationId, other.id);
      s.relations[key].truceUntil = s.time + BAL.peaceTruce;
      s.relations[key].kind = 'peace';
      s.relations[key].warSince = null;
      s.relations[key].grudge = null;
      this.#adjustExhaustion(nationId, -BAL.peaceRelief * 0.5);
      this.#adjustExhaustion(other.id, -BAL.peaceRelief * 0.5);
      this.#log(`Мир: ${nation.short} и ${other.short} прекращают войну`, 'war');
      this.#emit('peace', { with: other.id, by: nationId, kind: 'peace', ai: true });
      return true;
    }
    return false;
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
    this.#declareWar(a, b);
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

  /**
   * True when these two nations are fighting: either there is a declared war
   * (which lasts until peace, not for a fixed window) or the last battle was
   * recent. A signed truce makes them peaceful at once.
   */
  hasFoughtRecently(a, b, window = BAL.peaceTalksWindow) {
    const rel = this.state.relations?.[Game.pairKey(a, b)];
    if (!rel) return false;
    if (rel.truceUntil > this.state.time) return false;
    if (rel.warSince != null) return true;
    if (rel.lastClash === undefined) return false;
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
   * What a beaten nation is ready to put on the table: a border province and
   * as much gold as it can spare. Null when it is not the one losing.
   */
  tributeTerms(nationId) {
    const s = this.state;
    const me = s.nationId;
    const them = s.nations[nationId];
    if (!them || !them.alive || !this.hasWar(nationId, me)) return null;
    const province = this.demandTarget(nationId);
    if (!province) return null;
    const power = this.armyTotal(me) / Math.max(1, this.armyTotal(nationId));
    const behind = this.provinceCount(nationId) <= this.provinceCount(me);
    if (!behind && power < 1.3) return null;
    const gold = Math.max(0, Math.min(Math.floor(them.gold), BAL.tributeGold));
    return { province, gold };
  }

  /**
   * An AI reaches out to the player. If the two have actually fought, this is a
   * peace offer; if they never clashed, it is a non-aggression pact — offering
   * "peace" to someone you are not fighting makes no sense.
   */
  offerPeace(fromId, kind = null, terms = null) {
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
      terms: terms ?? null,
      expires: this.state.time + 45,
    };
    this.state.offers.push(offer);
    from.offersFrom = this.state.time + BAL.offerCooldown;
    this.#log(offerSentence(from.short ?? 'Противник', type), 'war');
    this.#emit('offer', offer);
    return { ok: true, offer };
  }

  /**
   * An AI asks the player for a road: its enemy is on the far side of the
   * player's land and the war is going nowhere without it. Offers about land
   * are rare by design — a nation does not beg for a road it can do without.
   */
  offerPassage(fromId) {
    const from = this.state.nations[fromId];
    if (!from || from.isPlayer || !from.alive) return { ok: false, reason: 'Нельзя' };
    if (this.state.status !== 'playing') return { ok: false, reason: 'Партия завершена' };
    if (this.hasPassage(this.state.nationId, fromId)) return { ok: false, reason: 'Проход уже есть' };
    if (this.state.offers.some((o) => o.from === fromId)) return { ok: false, reason: 'Предложение уже сделано' };
    // A card with four requests is a card nobody reads: two at a time is plenty.
    if (this.state.offers.length >= 2) return { ok: false, reason: 'Слишком много предложений' };
    if (this.state.time < (from.offersFrom ?? 0)) return { ok: false, reason: 'Слишком рано' };
    const offer = {
      id: this.state.nextOfferId++,
      from: fromId,
      to: this.state.nationId,
      kind: 'passage',
      expires: this.state.time + 45,
    };
    this.state.offers.push(offer);
    from.offersFrom = this.state.time + BAL.offerCooldown;
    this.#log(offerSentence(from.short ?? 'Противник', 'passage'), 'war');
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
    if (offer.kind === 'passage') {
      if (!accept) {
        if (from) from.offersFrom = this.state.time + BAL.offerCooldownAfterRefusal;
        this.#log(`${from?.short ?? 'Противник'}: проход отклонён`, 'war');
        this.#emit('offerClosed', { offer, accepted: false });
        return { ok: true, accepted: false };
      }
      this.#grantPassage(this.state.nationId, offer.from);
      this.#log(
        `Право прохода: ${from?.short ?? 'противник'} — ${Math.round(BAL.passageTruce)} с через вашу землю`,
        'war',
      );
      this.#emit('passage', { with: offer.from, by: this.state.nationId, granted: true });
      this.#emit('offerClosed', { offer, accepted: true });
      return { ok: true, accepted: true };
    }
    const pact = offer.kind === 'pact';
    const tribute = offer.kind === 'tribute';
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
    // A tribute is the loser's price for stopping the war: it buys a longer truce.
    const duration = pact ? BAL.pactTruce : tribute ? BAL.tributeTruce : BAL.peaceTruce;
    const relief = pact ? BAL.pactRelief : BAL.peaceRelief;
    this.state.relations[key] = this.state.relations[key] ?? { truceUntil: 0 };
    this.state.relations[key].truceUntil = this.state.time + duration;
    this.state.relations[key].kind = pact ? 'pact' : 'peace';
    this.state.relations[key].warSince = null;
    this.state.relations[key].start = null;
    this.#adjustExhaustion(offer.from, -relief);
    this.#adjustExhaustion(this.state.nationId, -relief);
    this.#recallColumns(offer.from, this.state.nationId);
    let tributeLine = '';
    if (tribute && offer.terms) {
      const province = this.state.provinces[offer.terms.province];
      const gold = Math.max(0, Math.min(Math.round(offer.terms.gold ?? 0), Math.floor(from?.gold ?? 0)));
      if (province && province.owner === offer.from) {
        province.owner = this.state.nationId;
        province.garrison = Math.max(1, Math.round(province.garrison * 0.5));
        this.#refreshNation(offer.from);
        this.#refreshNation(this.state.nationId);
        tributeLine = `, провинция «${this.provinceName(province.id)}»`;
      }
      if (gold > 0 && from) {
        from.gold -= gold;
        this.player.gold += gold;
        tributeLine += `${tributeLine ? ' и' : ','} ${gold} золота`;
      }
    }
    this.#log(
      pact
        // Nation names are quoted in the nominative: «с Пруссией» would need
        // hand-written declensions for a dozen shapes of name.
        ? `Пакт о ненападении: ${from?.short ?? 'противник'} — ${Math.round(duration)} с без нападений`
        : `Мир: ${from?.short ?? 'противник'}${tributeLine} — перемирие ${Math.round(duration)} с`,
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
    rel.warSince = this.state.time;
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
    s.relations[key].warSince = null;
    s.relations[key].start = null;
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

  /**
   * 0..1 estimate of how willing a nation is to let our columns cross its land.
   * Unlike a pact, passage is about convenience, not fear: a tired friend says
   * yes, an enemy says no, and a nation that already distrusts us says no too.
   */
  passageOutlook(nationId) {
    return this.passageChance(this.state.nationId, nationId);
  }

  /**
   * How willing `giverId` is to let `askerId` cross its land (0..1). Shared by
   * the player's button and the AI's own judgement, so both sides of the
   * negotiation use the same rules.
   */
  passageChance(askerId, giverId) {
    const s = this.state;
    const me = s.nations[askerId];
    const them = s.nations[giverId];
    if (!me?.alive || !them?.alive || them.id === me.id) return 0;
    if (this.hasPassage(them.id, me.id)) return 1;
    // Nobody opens a road to an enemy.
    if (this.hasWar(them.id, me.id)) return 0.01;
    let score = 0.24;
    const power = this.armyTotal(me.id) / Math.max(1, this.armyTotal(giverId));
    // A strong neighbour is not refused lightly; a weak one is ignored.
    score += Math.max(-0.12, Math.min(0.2, Math.log(Math.max(0.2, power)) * 0.12));
    if (this.hasTruce(giverId, me.id)) score += 0.24;
    // A tired nation wants quiet on its border, not a new war over a road.
    score += (them.exhaustion / 100) * 0.16;
    // Breaking a word costs more than any road is worth.
    score -= Math.min(0.4, (me.oathbreaks ?? 0) * 0.13);
    if (this.holdsGrudge(giverId, askerId)) score -= 0.2;
    // An aggressive nation guards its land.
    if ((them.ai?.aggression ?? 0.9) > 1.05) score -= 0.06;
    return Math.max(0.02, Math.min(0.95, score));
  }

  /** The player asks a nation for a right of passage. */
  requestPassage(nationId) {
    const s = this.state;
    if (s.status !== 'playing') return { ok: false, reason: 'Партия завершена' };
    const them = s.nations[nationId];
    if (!them || !them.alive) return { ok: false, reason: 'Державы больше нет' };
    if (nationId === s.nationId) return { ok: false, reason: 'Это ваша держава' };
    if (this.hasPassage(nationId, s.nationId)) return { ok: false, reason: 'Проход уже есть' };
    if (this.hasWar(nationId, s.nationId)) {
      return { ok: false, reason: 'Сначала нужен мир: врагу дорогу не дают' };
    }
    if (s.time < (them.passageAskedUntil ?? 0)) {
      return { ok: false, reason: 'Они уже ответили — попробуйте позже' };
    }
    const chance = this.passageOutlook(nationId);
    const accepted = this.rng.chance(chance);
    them.passageAskedUntil =
      s.time + (accepted ? BAL.passageAskCooldown : BAL.passageAskCooldownAfterRefusal);
    if (!accepted) {
      this.#log(`Отказ: ${them.short} не даёт право прохода`, 'war');
      this.#emit('passage', { with: nationId, accepted: false, chance });
      return { ok: true, accepted: false, chance };
    }
    this.#grantPassage(nationId, s.nationId);
    this.#log(
      `Право прохода: ${them.short} — ${Math.round(BAL.passageTruce)} с через чужую землю`,
      'good',
    );
    this.#emit('passage', { with: nationId, accepted: true, chance });
    return { ok: true, accepted: true, chance, until: s.time + BAL.passageTruce };
  }

  /**
   * A peace the player can dictate: when the war is clearly won, the loser is
   * asked to give up one border province as the price of stopping the fighting.
   * It is the same treaty as a normal peace, plus land — the alternative is
   * scraping the country off the map province by province.
   */
  demandOutlook(nationId) {
    const s = this.state;
    const me = s.nations[s.nationId];
    const them = s.nations[nationId];
    if (!me?.alive || !them?.alive || them.isPlayer) return 0;
    if (!this.hasWar(nationId, me.id)) return 0;
    const power = this.armyTotal(me.id) / Math.max(1, this.armyTotal(nationId));
    if (power < 1.25) return 0;
    let score = 0.12 + Math.min(0.45, (power - 1.25) * 0.35);
    score += (them.exhaustion / 100) * 0.3;
    score += this.#provinceCount(me.id) > this.#provinceCount(nationId) ? 0.12 : 0;
    score -= Math.min(0.25, (me.oathbreaks ?? 0) * 0.08);
    return Math.max(0.04, Math.min(0.9, score));
  }

  /** The province the loser would have to give up, or null when there is none. */
  demandTarget(nationId) {
    const me = this.state.nationId;
    let best = null;
    for (const p of Object.values(this.state.provinces)) {
      if (p.owner !== nationId) continue;
      const touchesUs = this.neighbors(p.id).some((nid) => this.state.provinces[nid].owner === me);
      if (!touchesUs) continue;
      const weight = this.defenseValue(p.id) + p.pop;
      if (!best || weight < best.weight) best = { id: p.id, weight };
    }
    return best?.id ?? null;
  }

  /** Asks a beaten nation for peace at the price of one border province. */
  demandPeace(nationId) {
    const s = this.state;
    if (s.status !== 'playing') return { ok: false, reason: 'Партия завершена' };
    const them = s.nations[nationId];
    if (!them || !them.alive) return { ok: false, reason: 'Державы больше нет' };
    if (!this.hasWar(nationId, s.nationId)) return { ok: false, reason: 'Вы не воюете' };
    const target = this.demandTarget(nationId);
    if (!target) return { ok: false, reason: 'У них нет провинции у вашей границы' };
    if (s.time < (them.demandAskedUntil ?? 0)) return { ok: false, reason: 'Они уже ответили — попробуйте позже' };
    const chance = this.demandOutlook(nationId);
    if (chance <= 0) return { ok: false, reason: 'Сначала нужно заметное превосходство' };
    const accepted = this.rng.chance(chance);
    them.demandAskedUntil = s.time + (accepted ? BAL.offerCooldown : BAL.offerCooldownAfterRefusal);
    if (!accepted) {
      this.#log(`Отказ: ${them.short} не отдаёт землю за мир`, 'war');
      this.#emit('demand', { with: nationId, accepted: false, chance, province: target });
      return { ok: true, accepted: false, chance, province: target };
    }
    const province = s.provinces[target];
    province.owner = s.nationId;
    province.garrison = Math.max(1, Math.round(province.garrison * 0.5));
    if (province.fort > 0) province.fort -= 1;
    const gold = Math.max(0, Math.min(Math.floor(them.gold), BAL.tributeGold));
    them.gold -= gold;
    this.player.gold += gold;
    const key = Game.pairKey(nationId, s.nationId);
    s.relations[key] = s.relations[key] ?? { truceUntil: 0 };
    s.relations[key].truceUntil = s.time + BAL.peaceTruce * 2;
    s.relations[key].kind = 'peace';
    s.relations[key].warSince = null;
    s.relations[key].start = null;
    s.relations[key].grudge = nationId;
    this.#adjustExhaustion(nationId, -BAL.peaceRelief * 0.5);
    this.#adjustExhaustion(s.nationId, -BAL.peaceRelief * 0.5);
    this.#recallColumns(nationId, s.nationId);
    this.#refreshNation(nationId);
    this.#refreshNation(s.nationId);
    this.#log(
      `Мир с уступкой: ${them.short} отдаёт провинцию «${this.provinceName(target)}»${gold > 0 ? ` и ${gold} золота` : ''} и прекращает войну`,
      'good',
    );
    this.#emit('demand', { with: nationId, accepted: true, chance, province: target, gold });
    return { ok: true, accepted: true, chance, province: target, gold, until: s.relations[key].truceUntil };
  }

  /** Seconds left on a truce with `withId` (0 when there is none). */
  truceLeft(withId, nationId = this.state.nationId) {
    const rel = this.state.relations?.[Game.pairKey(withId, nationId)];
    if (!rel) return 0;
    return Math.max(0, rel.truceUntil - this.state.time);
  }

  /** True when the player broke a pact with this nation and it remembers. */
  holdsGrudge(nationId, byId = this.state.nationId) {
    const rel = this.state.relations?.[Game.pairKey(nationId, byId)];
    return rel?.grudge === byId;
  }

  /** Every nation that gave `nationId` a right of passage, with seconds left. */
  passagesOf(nationId) {
    const out = [];
    for (const other of Object.values(this.state.nations)) {
      if (!other.alive || other.id === nationId) continue;
      const left = this.passageLeft(other.id, nationId);
      if (left > 0) out.push({ id: other.id, left });
    }
    return out;
  }

  /** Every nation that may march through `nationId`'s land (it granted them). */
  passagesGrantedBy(nationId) {
    const out = [];
    for (const other of Object.values(this.state.nations)) {
      if (!other.alive || other.id === nationId) continue;
      const left = this.passageLeft(nationId, other.id);
      if (left > 0) out.push({ id: other.id, left });
    }
    return out;
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

  /**
   * Both roads offered at the current step. One entry means there was no land
   * on the other side of the country; two mean the player has a real choice.
   */
  focusOptions(nationId = this.state.nationId) {
    const nation = this.state.nations[nationId];
    const step = nation?.focus?.chain?.[nation.focus.index];
    if (!step) return [];
    if (!step.alt) return [step];
    // Once the road is picked the fork is closed: only the chosen one remains.
    if (nation.focus.pick === 'alt') return [step.alt];
    if (nation.focus.pick === 'main') return [step];
    return [step, step.alt];
  }

  /** True while the player still has to pick a direction. */
  focusPending(nationId = this.state.nationId) {
    const nation = this.state.nations[nationId];
    if (!nation?.focus) return false;
    return this.focusOptions(nationId).length > 1 && !nation.focus.pick;
  }

  /** Current ambition of a nation, or null when it is done or still unchosen. */
  focusOf(nationId = this.state.nationId) {
    const nation = this.state.nations[nationId];
    const chain = nation?.focus?.chain;
    if (!chain?.length) return null;
    const step = chain[nation.focus.index] ?? null;
    if (!step) return null;
    if (!step.alt) return step;
    if (!nation.focus.pick) return null;
    return nation.focus.pick === 'alt' ? step.alt : step;
  }

  /** Picks the road at the current step. `which` is 'main' or 'alt'. */
  chooseFocus(which, nationId = this.state.nationId) {
    const nation = this.state.nations[nationId];
    if (!nation?.focus) return { ok: false, reason: 'Фокусов нет' };
    const options = this.focusOptions(nationId);
    if (!options.length) return { ok: false, reason: 'Все задачи выполнены' };
    const pick = which === 'alt' && options.length > 1 ? 'alt' : 'main';
    nation.focus.pick = pick;
    // The chosen land may already be ours: pay it out at once instead of
    // leaving a finished step on screen.
    this.#checkFocus(nationId);
    this.#emit('focusChoice', { nationId, pick, focus: this.focusOf(nationId) });
    return { ok: true, focus: this.focusOf(nationId) };
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
      // Every completed step opens a new fork: the next road is chosen again.
      nation.focus.pick = nation.isPlayer ? null : 'main';
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

  /**
   * Order book of any nation. The player's lives in `state.orders` (it is part
   * of the HUD and of every save), an AI's is created on first use — the AI
   * fights by exactly the same cooldowns, so its buffs are not free magic.
   */
  ordersOf(nationId) {
    const nation = this.state.nations[nationId];
    if (!nation) return null;
    if (nation.isPlayer) return this.state.orders;
    nation.orders = nation.orders ?? {
      mobilizeReady: 0,
      taxReady: 0,
      marchReady: 0,
      taxUntil: 0,
      marchUntil: 0,
    };
    return nation.orders;
  }

  /** Income multiplier from the «военный налог» order. */
  taxBuff(nationId) {
    const o = this.ordersOf(nationId);
    return o && this.state.time < o.taxUntil ? 2 : 1;
  }

  /** March-speed multiplier from the «форсированный марш» order. */
  marchBuff(nationId) {
    const o = this.ordersOf(nationId);
    return o && this.state.time < o.marchUntil ? BAL.marchBuff : 1;
  }

  castOrder(kind) {
    return this.castOrderFor(this.state.nationId, kind);
  }

  castOrderFor(nationId, kind) {
    const nation = this.state.nations[nationId];
    if (!nation) return { ok: false, reason: 'Державы нет' };
    const o = this.ordersOf(nationId);
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
      const wants = owned.map((p) => {
        const ceiling = this.#maxGarrison(p) * BAL.mobilizeCeiling;
        return Math.max(0, Math.min(this.#maxGarrison(p) * BAL.mobilizeShare, ceiling - p.garrison));
      });
      const totalWanted = wants.reduce((a, b) => a + b, 0);
      if (totalWanted < 1) {
        nation.gold += cost;
        return { ok: false, reason: 'Гарнизоны уже на пределе мобилизации' };
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
      if (nation.isPlayer) this.#log(`Мобилизация: +${Math.round(budget)} рекрутов в строй`, 'order');
    } else if (kind === 'tax') {
      o.taxUntil = this.state.time + BAL.buffDuration.tax;
      if (nation.isPlayer) this.#log('Военный налог: доход удвоен', 'order');
    } else if (kind === 'march') {
      o.marchUntil = this.state.time + BAL.buffDuration.march;
      if (nation.isPlayer) this.#log('Форсированный марш: армии ускорены', 'order');
    }
    o[`${kind}Ready`] = this.state.time + BAL.orderCooldown;
    if (nation.isPlayer) this.#emit('order', { kind });
    else this.state.stats.aiOrders = (this.state.stats.aiOrders ?? 0) + 1;
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
    this.#runAutos();
    this.#moveArmies(dt);
    this.#tickAssaults();
    this.#think(dt);
    this.#checkEnd();
    // Safety net: whoever lost the last province by any route (a treaty, a
    // tribute, a capitulation) is marked gone within a few seconds, and their
    // wars close with them. Once per five seconds is enough and stays cheap.
    if (s.time >= (this.nextNationSync ?? 0)) {
      this.nextNationSync = s.time + 5;
      for (const nation of Object.values(s.nations)) if (nation.alive) this.#refreshNation(nation.id);
    }
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
      income *= this.taxBuff(nation.id);
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
      const quiet = s.time - (nation.lastClash ?? -999);
      if (quiet > BAL.exhaustionCalmAfter) {
        nation.exhaustion = Math.max(0, nation.exhaustion - BAL.exhaustionDecay * dt);
      } else if (quiet > BAL.exhaustionWarCalm) {
        nation.exhaustion = Math.max(0, nation.exhaustion - BAL.exhaustionWarDecay * dt);
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
    // Snapshot: resolving an arrival can launch a counter-attack, and the new
    // column must not be advanced in the same tick it was created.
    for (const army of [...s.armies]) {
      const buff = this.marchBuff(army.owner);
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
    // Own land or land crossed by a right of passage: the column walks on
    // without a battle, but it can only leave a garrison on its own soil.
    const walkOn = target && this.canTransit(army.owner, army.to);

    if (!isFinal && !walkOn) {
      // The road ahead is no longer ours: the province was lost, or the right
      // of passage that made it a road was revoked. The column turns back
      // instead of treating a waypoint as a target.
      if (army.owner === s.nationId) {
        this.#log(`Поход прерван: ${this.provinceName(army.to)} больше не наша дорога`, 'bad');
      }
      return this.#turnBack(army);
    }

    if (!isFinal && walkOn) {
      const ownHere = target.owner === army.owner;
      const leave = ownHere ? Math.max(0, Math.min(army.leave?.[army.to] ?? 0, army.troops)) : 0;
      if (leave > 0) {
        target.garrison += leave;
        army.troops -= leave;
        if (army.owner === s.nationId) {
          this.#log(`${this.provinceName(army.to)}: оставлен гарнизон +${Math.round(leave)}`, 'good');
        }
      }
      const nextId = path[army.leg + 1];
      const next = s.provinces[nextId];
      // Only the destination may be hostile; if the permission to cross a
      // country is revoked mid-march, the column has nowhere to walk.
      const blocked = next && !this.canTransit(army.owner, nextId) && army.leg + 1 < path.length - 1;
      if (army.troops < BAL.minSend || blocked) {
        // The road ahead is gone (province lost, passage revoked) or nobody is
        // left to march: the column turns back instead of vanishing with its men.
        if (blocked) {
          if (army.owner === s.nationId) {
            this.#log(`Поход прерван: ${this.provinceName(nextId)} больше не наша дорога`, 'bad');
          }
          return this.#turnBack(army);
        }
        if (army.troops > 0) {
          if (ownHere) target.garrison += army.troops;
          else this.#turnBack(army);
        }
        return false;
      }
      army.leg += 1;
      army.from = army.to;
      army.to = nextId;
      army.duration = this.travelTime(army.from, army.to, army.owner);
      army.sea = this.isSeaRoute(army.from, army.to);
      army.t = 0;
      this.#seaToll(army);
      return true;
    }

    this.#resolveArrival(army);
    return false;
  }

  /**
   * Sends a stranded column back the way it came. Used when the right of
   * passage that made the road is revoked while the men are still on foreign
   * soil — they must not be handed over to a nation they no longer have a
   * treaty with, and they must not disappear either.
   */
  #turnBack(army) {
    const s = this.state;
    const travelled = army.path ? army.path.slice(0, army.leg + 1) : [army.from, army.to];
    const back = [];
    for (let i = travelled.length - 1; i >= 0; i -= 1) {
      back.push(travelled[i]);
      if (s.provinces[travelled[i]]?.owner === army.owner) break;
    }
    if (back.length < 2) return false;
    army.path = back;
    army.leg = 1;
    army.from = back[0];
    army.to = back[1];
    army.t = 0;
    army.duration = this.travelTime(army.from, army.to, army.owner);
    army.sea = this.isSeaRoute(army.from, army.to);
    return true;
  }

  /**
   * Storms and transport losses on a sea leg. Small, but it makes a sea route
   * a decision: islands are still reachable, they are just not free.
   */
  #seaToll(army) {
    if (!army.sea || army.troops <= 0) return 0;
    const lost = Math.round(army.troops * BAL.seaAttrition);
    if (lost <= 0) return 0;
    army.troops -= lost;
    if (army.owner === this.state.nationId) {
      this.#log(`Шторм: ${lost} чел. потеряно в море (${Math.round(BAL.seaAttrition * 100)}%)`, 'war');
    }
    return lost;
  }

  /**
   * Consequences of marching into someone else's province: war starts, and if
   * that nation had given us a right of passage, the treaty is torn up. Shared
   * by the player and the AI, so betrayal costs everyone the same.
   */
  #onAttack(nationId, toId) {
    const target = this.state.provinces[toId];
    const owner = target?.owner;
    if (!owner || owner === nationId) return;
    if (this.hasPassage(owner, nationId)) {
      this.#revokePassage(owner, nationId);
      const rel = this.state.relations[Game.pairKey(owner, nationId)];
      if (rel) rel.grudge = nationId;
      const attacker = this.state.nations[nationId];
      if (attacker) attacker.oathbreaks = (attacker.oathbreaks ?? 0) + 1;
      this.#log(
        `Право прохода отменено: ${this.state.nations[owner]?.short ?? 'противник'} закрывает границу`,
        nationId === this.state.nationId ? 'bad' : 'war',
      );
      this.#emit('passage', { with: owner, by: nationId, broken: true });
    }
    this.#declareWar(nationId, owner);
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
      const home = this.#homeFor(army);
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

    // Hostile land: the column joins the assault on this province. Several
    // columns sent at one target fight as one force instead of being defeated
    // one after another by the same garrison.
    this.#joinAssault(army);
  }

  /** Where a column that cannot fight should be placed: its own province. */
  #homeFor(army) {
    const s = this.state;
    const own = s.provinces[army.from]?.owner === army.owner ? s.provinces[army.from] : null;
    return own ?? this.#nearestOwnProvince(army.owner, army.from);
  }

  /**
   * Adds an arrived column to the assault on its target. The battle itself is
   * resolved by #tickAssaults once the other columns that are already on the
   * road have arrived (or the wait runs out).
   */
  #joinAssault(army) {
    const s = this.state;
    s.assaults = s.assaults ?? [];
    const existing = s.assaults.find((a) => a.owner === army.owner && a.to === army.to);
    if (existing) {
      existing.troops += army.troops;
      existing.columns += 1;
      existing.lastAt = s.time;
      if (army.owner === s.nationId) {
        this.#log(
          `Сборный удар: ${this.provinceName(army.to)} — ${plural(existing.columns, 'колонна', 'колонны', 'колонн')}, ${Math.round(existing.troops)} чел.`,
          'good',
        );
      }
      return;
    }
    s.assaults.push({
      id: s.nextAssaultId++,
      owner: army.owner,
      to: army.to,
      from: army.from,
      troops: army.troops,
      columns: 1,
      lastAt: s.time,
    });
  }

  /**
   * Resolves the waiting assaults. A single column fights the moment it
   * arrives (nothing to wait for); the first of several columns waits for the
   * rest, but not longer than `assaultWait` in case one of them is stopped.
   */
  #tickAssaults() {
    const s = this.state;
    if (!s.assaults?.length) return;
    const drop = (assault) => {
      s.assaults = s.assaults.filter((a) => a.id !== assault.id);
    };
    for (const assault of [...s.assaults]) {
      const target = s.provinces[assault.to];
      if (!target) {
        drop(assault);
        continue;
      }
      // The target became ours while the columns were gathering.
      if (target.owner === assault.owner) {
        target.garrison += assault.troops;
        drop(assault);
        continue;
      }
      // Peace signed while the assault was gathering: the men go home.
      if (target.owner && this.hasTruce(assault.owner, target.owner)) {
        const home = this.#homeFor(assault);
        if (home) home.garrison += assault.troops;
        drop(assault);
        continue;
      }
      const inbound = s.armies.some((a) => {
        if (a.owner !== assault.owner) return false;
        const finalTarget = a.path ? a.path[a.path.length - 1] : a.to;
        return finalTarget === assault.to;
      });
      if (inbound && s.time - assault.lastAt < BAL.assaultWait) continue;
      drop(assault);
      this.#fight(assault.owner, assault.to, assault.troops, {
        from: assault.from,
        columns: assault.columns,
      });
    }
  }

  /**
   * One battle for a province. Used by the assault queue, so all the columns
   * that arrived together are counted as a single force.
   */
  #fight(owner, toId, troops, meta = {}) {
    const s = this.state;
    const target = s.provinces[toId];
    const attacker = s.nations[owner];
    if (!target || !attacker || troops <= 0) return;

    const defender = target.owner ? s.nations[target.owner] : null;
    this.#onAttack(owner, toId);
    const defPower = this.defenseValue(toId);
    const atkPower = troops * this.attackModifier(owner);
    const chance = Game.winChance(atkPower, defPower);
    // rng.next() is always < 1, so chance 1 wins and chance 0 loses by construction.
    const roll = this.rng.next();
    s.stats.battles += 1;
    const columns = meta.columns ?? 1;

    const attackerWins = roll < chance;
    if (attackerWins) {
      const ratio = defPower / Math.max(1, atkPower);
      const survivors = Math.max(1, Math.round(troops * (1 - BAL.loserSurvivorBase * Math.min(0.95, ratio))));
      const previousOwner = target.owner;
      target.owner = owner;
      target.garrison = survivors;
      if (target.fort > 0) target.fort -= 1;
      attacker.alive = true;
      attacker.eliminated = false;

      if (attacker.isPlayer) s.stats.captured += 1;
      if (previousOwner === s.nationId) s.stats.lostProvinces += 1;

      if (this.#logWorthTelling(target.id, owner, previousOwner)) {
        const force = columns > 1 ? ` (${plural(columns, 'колонна', 'колонны', 'колонн')})` : '';
        this.#log(
          previousOwner
            ? `${this.provinceName(target.id)}: ${s.nations[previousOwner]?.short ?? '—'} → ${attacker.short} (${Math.round(atkPower)} против ${Math.round(defPower)})${force}`
            : `${this.provinceName(target.id)}: независимая → ${attacker.short} (${Math.round(atkPower)} против ${Math.round(defPower)})${force}`,
          previousOwner === s.nationId ? 'bad' : attacker.isPlayer ? 'good' : 'war',
        );
      }
      this.#emit('capture', {
        provinceId: target.id,
        from: previousOwner,
        to: owner,
        losers: Math.round(defPower),
        defense: Math.round(defPower),
        attack: Math.round(atkPower),
        roll,
        survivors,
        sent: troops,
        columns,
      });
      this.#markClash(previousOwner, owner);
      this.#adjustMorale(owner, BAL.moraleWin);
      this.#adjustExhaustion(owner, BAL.exhaustionWin);
      if (previousOwner) {
        this.#adjustMorale(previousOwner, -BAL.moraleLose);
        this.#adjustExhaustion(previousOwner, BAL.exhaustionCapture);
        this.#adjustExhaustion(previousOwner, BAL.exhaustionLose);
        this.#markClash(previousOwner, owner);
      }
      // A surrender is judged before the ordinary «state destroyed» check, so a
      // won campaign ends with a treaty instead of a line about a dead nation.
      if (previousOwner) this.maybeCapitulate(previousOwner, owner);
      if (previousOwner) this.#refreshNation(previousOwner);
      this.#refreshNation(owner);
      this.#checkFocus(owner);
    } else {
      const ratio = (atkPower * roll) / Math.max(1, defPower);
      const survivors = Math.max(1, Math.round(target.garrison * (1 - BAL.loserSurvivorBase * Math.min(0.95, ratio))));
      target.garrison = survivors;
      this.#markClash(target.owner, owner);
      this.#adjustMorale(owner, -BAL.moraleLose);
      this.#adjustExhaustion(owner, BAL.exhaustionLose);
      if (target.owner) {
        this.#adjustMorale(target.owner, BAL.moraleWin);
        this.#adjustExhaustion(target.owner, BAL.exhaustionWin);
      }
      if (defender?.isPlayer) s.stats.battlesWon += 1;
      // A beaten defender may sally out and hit the province the attack came from.
      if (
        target.owner &&
        defender?.alive &&
        !this.hasTruce(target.owner, owner) &&
        target.garrison > BAL.minSend * 4 &&
        this.rng.chance(BAL.counterAttack)
      ) {
        const home = s.provinces[meta.from];
        if (home && home.owner === owner && this.neighbors(meta.from).includes(target.id)) {
          const marched = Math.floor(target.garrison * BAL.counterAttackMargin);
          if (marched >= BAL.minSend) {
            this.#log(`Контрудар: ${defender.short} → ${this.provinceName(meta.from)}`, 'war');
            this.launchArmy(target.owner, target.id, meta.from, BAL.counterAttackMargin);
          }
        }
      }
      // A failed AI attack on another AI is background noise; the player's own
      // battles always show.
      if (this.#logWorthTelling(target.id, owner, target.owner)) {
        this.#log(
          `Отбита атака: ${this.provinceName(target.id)}${defender ? ` (${defender.short})` : ''} — ${Math.round(atkPower)} против ${Math.round(defPower)}`,
          defender?.isPlayer ? 'good' : 'war',
        );
      }
      this.#emit('battle', { provinceId: target.id, attacker: owner, defender: target.owner, success: false, attack: Math.round(atkPower), defense: Math.round(defPower), roll, sent: troops, columns });
      this.#refreshNation(owner);
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
      // A dead state is not at war with anyone: leaving the wars open made the
      // AI keep planning against a nation that no longer exists.
      for (const [key, rel] of Object.entries(s.relations ?? {})) {
        if (!key.includes(nationId)) continue;
        rel.warSince = null;
        rel.start = null;
      }
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
    if (!player) return;
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
    // Saves written before standing orders existed must still load; the field is
    // simply empty for them.
    game.state.autos = Array.isArray(game.state.autos) ? game.state.autos : [];
    game.state.nextAutoId = game.state.nextAutoId ?? 1;
    game.state.rules = normalizeRules(save.state.rules ?? {});
    game.rules = game.state.rules;
    game.rng.s = save.rng >>> 0;
    return game;
  }
}
