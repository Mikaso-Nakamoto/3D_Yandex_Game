import { getScenario } from '../data/scenarios.js';
import { BAL, UPGRADES, ORDERS, doctrineMod } from './balance.js';
import { Rng } from './rng.js';
import { aiThink, assignDoctrine } from './ai.js';

export const SAVE_VERSION = 1;

/**
 * Pure simulation core. Knows nothing about three.js, DOM or the Yandex SDK,
 * so the whole game can be stepped and tested headlessly.
 */
export class Game {
  constructor({ scenarioId, nationId, doctrineId = 'coin', map, seed = 20261023 }) {
    this.scenario = getScenario(scenarioId);
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
      orders: { mobilizeReady: 0, taxReady: 0, marchReady: 0, taxUntil: 0, marchUntil: 0 },
      stats: { battles: 0, captured: 0, lostProvinces: 0, battlesWon: 0, peak: 0 },
      sendRatio: 0.5,
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
        gold: BAL.startGoldBase + n.provinces.length * BAL.startGoldPerProvince,
        manpower: BAL.startManpower,
        alive: true,
        eliminated: false,
        isPlayer,
        pop: 0,
        income: 0,
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
        p.garrison = this.#maxGarrison(p, state) * (cfg?.garrison ?? 0.8) * (sc.balance.neutralStrength ?? 1);
      } else {
        p.garrison = this.#maxGarrison(p, state);
      }
    }

    state.stats.peak = this.#provinceCount(nationId, state);
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
    return Math.round((BAL.garrisonBase + p.pop * BAL.garrisonPop) * (1 + p.barracks * BAL.barracksGarrison) * mod);
  }

  defenseValue(provinceId) {
    const p = this.state.provinces[provinceId];
    const owner = p.owner ? this.state.nations[p.owner] : null;
    return p.garrison * (1 + p.fort * BAL.fortDefense) * (1 + doctrineMod(owner?.doctrine, 'defense'));
  }

  attackModifier(nationId) {
    return 1 + doctrineMod(this.state.nations[nationId]?.doctrine, 'attack');
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

  #armyFrom(provinceId) {
    return this.state.armies.find((a) => a.from === provinceId);
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
    if (!this.neighbors(fromId).includes(toId)) return { ok: false, reason: 'Провинции не граничат' };
    if (this.#armyFrom(fromId)) return { ok: false, reason: 'Гарнизон уже в походе' };
    if (from.garrison * this.state.sendRatio < BAL.minSend) return { ok: false, reason: 'Слишком мало войск' };
    return { ok: true };
  }

  sendTroops(fromId, toId, ratio = this.state.sendRatio) {
    const check = this.canSend(fromId, toId);
    if (!check.ok) return check;
    if (this.state.provinces[toId].owner !== this.state.nationId) this.state.playerAggro = true;
    const amount = this.launchArmy(this.state.nationId, fromId, toId, ratio);
    if (amount < BAL.minSend) return { ok: false, reason: 'Слишком мало войск' };
    return { ok: true, amount, duration: this.state.armies[this.state.armies.length - 1]?.duration, sea: this.isSeaRoute(fromId, toId) };
  }

  /** Shared by the player and the AI. Returns the number of troops that marched. */
  launchArmy(nationId, fromId, toId, ratio = 0.5) {
    const from = this.state.provinces[fromId];
    if (!from || from.owner !== nationId) return 0;
    if (!this.neighbors(fromId).includes(toId)) return 0;
    if (this.#armyFrom(fromId)) return 0;
    const amount = Math.floor(from.garrison * Math.max(0.05, Math.min(1, ratio)));
    if (amount < BAL.minSend) return 0;

    const sea = this.isSeaRoute(fromId, toId);
    const marchBuff = nationId === this.state.nationId && this.state.orders.marchUntil > this.state.time ? 1.6 : 1;
    const raw = (this.distance(fromId, toId) / (BAL.armySpeed * marchBuff)) * (sea ? BAL.seaTravelMul : 1);
    const duration = Math.max(sea ? BAL.seaMinTravel : BAL.minTravel, Math.min(BAL.maxTravel, raw));

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
    return amount;
  }

  provinceCount(nationId) {
    return this.#provinceCount(nationId);
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
    this.#log(`${this.provinceName(provinceId)}: ${UPGRADES[kind].name} → ур. ${level + 1}`, 'build');
    this.#emit('upgrade', { provinceId, kind, level: level + 1 });
    return { ok: true, level: level + 1, cost };
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
      const wants = owned.map((p) => Math.min(this.#maxGarrison(p) * BAL.mobilizeShare, this.#maxGarrison(p) - p.garrison));
      const totalWanted = wants.reduce((a, b) => a + b, 0);
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
    this.#reinforce(dt);
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
      income *= (1 + doctrineMod(nation.doctrine, 'income')) * nation.ai.eco;
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

  #reinforce(dt) {
    const s = this.state;
    for (const p of Object.values(s.provinces)) {
      if (!p.owner) continue;
      const nation = s.nations[p.owner];
      if (!nation?.alive) continue;
      const max = this.#maxGarrison(p);
      if (p.garrison >= max || nation.manpower <= 0) continue;
      const rate = max * BAL.reinforceShare * (1 + p.barracks * 0.12) * dt;
      const amount = Math.min(rate, max - p.garrison, nation.manpower);
      p.garrison += amount;
      nation.manpower -= amount;
    }
  }

  #moveArmies(dt) {
    const s = this.state;
    for (let i = s.armies.length - 1; i >= 0; i -= 1) {
      const army = s.armies[i];
      const buff = army.owner === s.nationId && s.time < s.orders.marchUntil ? 1.6 : 1;
      army.t += dt * buff;
      if (army.t >= army.duration) {
        s.armies.splice(i, 1);
        this.#resolveArrival(army);
      }
    }
  }

  #resolveArrival(army) {
    const s = this.state;
    const target = s.provinces[army.to];
    const attacker = s.nations[army.owner];
    if (!target || !attacker) return;

    // Friendly move: reinforce.
    if (target.owner === army.owner) {
      const max = this.#maxGarrison(target);
      target.garrison = Math.min(max * 1.5, target.garrison + army.troops);
      return;
    }

    const defender = target.owner ? s.nations[target.owner] : null;
    const defPower = this.defenseValue(target.id);
    const atkPower = army.troops * this.attackModifier(army.owner);
    const roll = this.rng.range(1 - BAL.combatSwing, 1 + BAL.combatSwing);
    s.stats.battles += 1;

    const attackerWins = atkPower * roll >= defPower;
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

      this.#log(
        previousOwner
          ? `${this.provinceName(target.id)}: ${s.nations[previousOwner]?.short ?? '—'} → ${attacker.short}`
          : `${this.provinceName(target.id)}: нейтральная → ${attacker.short}`,
        previousOwner === s.nationId ? 'bad' : attacker.isPlayer ? 'good' : 'war',
      );
      this.#emit('capture', {
        provinceId: target.id,
        from: previousOwner,
        to: army.owner,
        losers: Math.round(defPower),
      });
      if (previousOwner) this.#refreshNation(previousOwner);
      this.#refreshNation(army.owner);
    } else {
      const ratio = (atkPower * roll) / Math.max(1, defPower);
      const survivors = Math.max(1, Math.round(target.garrison * (1 - BAL.loserSurvivorBase * Math.min(0.95, ratio))));
      target.garrison = survivors;
      if (defender?.isPlayer) s.stats.battlesWon += 1;
      this.#log(
        `Отбита атака: ${this.provinceName(target.id)}${defender ? ` (${defender.short})` : ''}`,
        defender?.isPlayer ? 'good' : 'war',
      );
      this.#emit('battle', { provinceId: target.id, attacker: army.owner, defender: target.owner, success: false });
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
      const aggression = nation.ai.aggression * (this.scenario.balance.aiAggression ?? 1);
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
    if (owned / total >= BAL.victoryShare) {
      s.status = 'victory';
      this.#log('Победа: половина Европы под вашей короной', 'good');
      this.#emit('end', { result: 'victory', owned, total });
      return;
    }
    this.#refreshNation(player.id);
    if (!player.alive) {
      s.status = 'defeat';
      this.#log('Поражение: держава потеряла все земли', 'bad');
      this.#emit('end', { result: 'defeat', owned, total });
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
    game.rng.s = save.rng >>> 0;
    return game;
  }
}
