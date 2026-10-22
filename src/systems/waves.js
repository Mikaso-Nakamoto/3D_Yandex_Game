import { clamp, weightedPick } from '../core/utils.js';
import { ENEMY_TYPES } from '../entities/enemy.js';

/**
 * Режиссёр волн.
 *
 * Волна — единица pacing'а: короткая (15–35 c), чтобы игрок регулярно получал
 * награду в виде выбора перка и регулярно доходил до естественной точки
 * показа interstitial (между волнами, никогда не во время геймплея —
 * это требование Яндекс Игр и главное правило сохранения retention).
 */

export const WAVE_STATE = {
  IDLE: 'idle',
  BREAK: 'break',
  SPAWNING: 'spawning',
  CLEARING: 'clearing',
  DONE: 'done',
};

const BOSS_EVERY = 5;

/** Какие типы врагов доступны на данной волне и с каким весом. */
function availableTypes(n) {
  const pool = [{ key: 'grunt', cost: ENEMY_TYPES.grunt.cost, w: 1.0 }];
  if (n >= 2) pool.push({ key: 'runner', cost: ENEMY_TYPES.runner.cost, w: 1.15 });
  if (n >= 3) pool.push({ key: 'shooter', cost: ENEMY_TYPES.shooter.cost, w: 0.72 });
  if (n >= 4) pool.push({ key: 'tank', cost: ENEMY_TYPES.tank.cost, w: 0.46 });
  if (n >= 6) pool.push({ key: 'runner', cost: ENEMY_TYPES.runner.cost, w: 0.85 });
  if (n >= 8) pool.push({ key: 'shooter', cost: ENEMY_TYPES.shooter.cost, w: 0.5 });
  if (n >= 11) pool.push({ key: 'tank', cost: ENEMY_TYPES.tank.cost, w: 0.42 });
  return pool;
}

/** Состав волны: список ключей врагов. */
function buildWave(n) {
  const out = [];

  if (n % BOSS_EVERY === 0) {
    const bosses = 1 + Math.floor((n - BOSS_EVERY) / 15);
    for (let i = 0; i < bosses; i++) out.push('boss');
    const adds = 8 + Math.floor(n * 1.15);
    for (let i = 0; i < adds; i++) out.push(i % 2 === 0 ? 'runner' : 'grunt');
    if (n >= 10) {
      const ranged = Math.floor(n / 4);
      for (let i = 0; i < ranged; i++) out.push('shooter');
    }
    return out;
  }

  // Бюджет в «очках стоимости» растёт быстрее линейного — сложность ускоряется
  // и за счёт числа врагов, а не только их HP.
  let budget = 7 + n * 3.2 + Math.pow(n, 1.5) * 0.5;
  const full = availableTypes(n);
  let guard = 0;

  while (budget >= 1 && guard++ < 500) {
    const affordable = full.filter((t) => t.cost <= budget);
    if (affordable.length === 0) break;
    const chosen = weightedPick(affordable, (t) => t.w);
    out.push(chosen.key);
    budget -= chosen.cost;
  }
  return out;
}

export class Waves {
  constructor(game) {
    this.game = game;
    this.wave = 0;
    this.state = WAVE_STATE.IDLE;
    this.queue = [];
    this.spawned = 0;
    this.spawnTimer = 0;
    this.breakTimer = 0;
    this.duration = 12;
    this.isBossWave = false;
    this._maxAlive = game.profile.maxEnemies;
  }

  reset() {
    this.wave = 0;
    this.state = WAVE_STATE.IDLE;
    this.queue.length = 0;
    this.spawned = 0;
    this.spawnTimer = 0;
    this.breakTimer = 0;
    this.isBossWave = false;
  }

  /**
   * Масштабирование характеристик врагов под номер волны.
   *
   * HP растёт быстрее линейного намеренно: сила игрока складывается
   * мультипликативно (тиры оружия × перки × число слотов), поэтому линейная
   * кривая даёт провал сложности в середине забега — волны 12–20 проходятся
   * без напряжения, и игрок уходит.
   *
   * Степень 2.1 подобрана симуляцией (npm run check): с ней «нагрузка»
   * (нужный DPS / доступный DPS) держится в диапазоне 0.35–0.9 на всём
   * протяжении забега. При степени 1.85 поздние волны проваливались до 0.33 —
   * игрок переставал чувствовать угрозу ровно тогда, когда должен напрягаться.
   */
  scale() {
    const n = Math.max(1, this.wave);
    return {
      hp: 1 + (n - 1) * 0.3 + Math.pow(n, 2.1) * 0.02,
      dmg: 1 + (n - 1) * 0.075,
      speed: 1 + Math.min(0.6, (n - 1) * 0.021),
    };
  }

  /** Начинает волну: IDLE/BREAK → подготовка → спавн. */
  startNextWave(breakTime = 2.4) {
    this.wave += 1;
    const n = this.wave;
    this.isBossWave = n % BOSS_EVERY === 0;
    this.queue = buildWave(n);
    this.spawned = 0;
    this.duration = clamp(9 + n * 1.15, 10, 32);
    this.spawnTimer = this.isBossWave ? 0.6 : 0.25;
    this.breakTimer = breakTime;
    this.state = WAVE_STATE.BREAK;
    this._maxAlive = this.game.profile.maxEnemies;

    this.game.onWaveStart(this.wave, this.isBossWave, this.queue.length);
  }

  /** Сколько врагов ещё появится. */
  get pending() {
    return this.queue.length - this.spawned;
  }

  /** Сколько врагов осталось убить (для HUD). */
  get remaining() {
    return this.pending + this.game.enemies.aliveCount;
  }

  update(dt) {
    if (this.state === WAVE_STATE.IDLE || this.state === WAVE_STATE.DONE) return;

    if (this.state === WAVE_STATE.BREAK) {
      this.breakTimer -= dt;
      if (this.breakTimer <= 0) {
        this.state = WAVE_STATE.SPAWNING;
      }
      return;
    }

    if (this.state === WAVE_STATE.SPAWNING) {
      this.spawnTimer -= dt;
      if (this.spawnTimer <= 0) {
        this._spawnBatch();
        // Ритм спавна: пачки каждые ~0.45–1.1 c, к концу волны чаще.
        const progress = this.spawned / Math.max(1, this.queue.length);
        const base = this.isBossWave ? 0.5 : 0.85 - progress * 0.42;
        this.spawnTimer = Math.max(0.16, base * (0.7 + Math.random() * 0.6));
      }
      if (this.spawned >= this.queue.length) {
        this.state = WAVE_STATE.CLEARING;
      }
      return;
    }

    if (this.state === WAVE_STATE.CLEARING) {
      if (this.game.enemies.aliveCount === 0) {
        this.state = WAVE_STATE.DONE;
        this.game.onWaveCleared(this.wave);
      }
    }
  }

  _spawnBatch() {
    const game = this.game;
    const player = game.player;
    const alive = game.enemies.aliveCount;

    // Не переполняем арену: на слабых устройствах потолок ниже.
    if (alive >= this._maxAlive) return;

    const room = this._maxAlive - alive;
    // Босса всегда выпускаем одним, без пачки.
    const nextKey = this.queue[this.spawned];
    const size = nextKey === 'boss' ? 1 : Math.min(room, 1 + ((Math.random() * 3) | 0));

    const scale = this.scale();
    for (let i = 0; i < size; i++) {
      const key = this.queue[this.spawned];
      if (!key) break;
      const pt = game.arena.edgeSpawnPoint(player.x, player.z, key === 'boss' ? 16 : 20);
      const e = game.enemies.spawn(key, pt.x, pt.z, scale);
      if (e) {
        this.spawned++;
        game.effects.particles.ring(pt.x, 0.35, pt.z, e.def.color, 14, 2.6, 0.4);
      }
    }
  }
}
