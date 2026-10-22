import * as THREE from 'three';

import { Renderer } from './world/renderer.js';
import { Arena } from './world/arena.js';
import { Player } from './entities/player.js';
import { Enemies } from './entities/enemy.js';
import { Projectiles } from './entities/projectile.js';
import { Pickups } from './entities/pickup.js';
import { Effects } from './entities/effects.js';
import { Weapons, WEAPONS, MAX_TIER } from './systems/weapons.js';
import { Waves, WAVE_STATE } from './systems/waves.js';
import { defaultStats, rollChoices, perkById } from './systems/perks.js';
import { Input } from './core/input.js';
import { Audio } from './core/audio.js';
import { Hud } from './ui/hud.js';
import { Screens } from './ui/screens.js';
import { SpatialGrid, clamp, damp, fmt } from './core/utils.js';
import { detectTier, profileFor, AutoQuality, TIER } from './core/quality.js';

/**
 * Игра целиком: состояние, порядок систем, камера, прогресс и сохранение.
 *
 * Порядок апдейта важен: сначала враги (они перестраивают пространственную
 * сетку), затем всё, что эту сетку читает — игрок, оружие, снаряды, пикапы.
 */

const STATE = {
  BOOT: 'boot',
  MENU: 'menu',
  PLAYING: 'playing',
  PERK: 'perk',
  PAUSED: 'paused',
  OVER: 'over',
};

class CameraRig {
  constructor(camera) {
    this.camera = camera;
    this.billboard = new THREE.Quaternion();
    this.target = new THREE.Vector3();
    this.desired = new THREE.Vector3(0, 24, 17);
    // Переиспользуемый вектор: без него каждый кадр создаётся новый объект,
    // а это лишний груз для сборщика мусора на мобильном вебе.
    this._goal = new THREE.Vector3();
    this.menuAngle = 0;
    this.portrait = false;
  }

  _computeOffset() {
    const aspect = window.innerWidth / Math.max(1, window.innerHeight);
    this.portrait = aspect < 1;
    // В портрете камера выше и дальше: иначе игрок не видит врагов сверху и снизу.
    const h = this.portrait ? 34 : 25;
    const back = this.portrait ? 21 : 17.5;
    this.desired.set(0, h, back);
  }

  updateMenu(dt) {
    this._computeOffset();
    this.menuAngle += dt * 0.16;
    const r = 26;
    const x = Math.cos(this.menuAngle) * r;
    const z = Math.sin(this.menuAngle) * r;
    this.camera.position.set(x, 18, z);
    this.camera.lookAt(0, 1.5, 0);
    this.billboard.copy(this.camera.quaternion);
  }

  update(dt, player, shake) {
    this._computeOffset();
    const px = player.x;
    const pz = player.z;

    // Небольшое упреждение по движению: камера «смотрит туда, куда едешь».
    const lead = 2.6;
    const tx = px + clamp(player.vx * 0.18, -lead, lead);
    const tz = pz + clamp(player.vz * 0.18, -lead, lead);

    this.target.set(tx, 0, tz);
    const goal = this._goal.copy(this.target).add(this.desired);

    this.camera.position.x = damp(this.camera.position.x, goal.x, 9, dt);
    this.camera.position.y = damp(this.camera.position.y, goal.y, 9, dt);
    this.camera.position.z = damp(this.camera.position.z, goal.z, 9, dt);

    if (shake > 0) {
      const s = shake * 0.85;
      this.camera.position.x += (Math.random() - 0.5) * s;
      this.camera.position.y += (Math.random() - 0.5) * s * 0.6;
      this.camera.position.z += (Math.random() - 0.5) * s;
    }

    this.camera.lookAt(this.target.x, this.portrait ? 0.5 : 1.2, this.target.z - 1.5);
    this.billboard.copy(this.camera.quaternion);
  }

  snap(player) {
    this._computeOffset();
    this.camera.position.set(player.x + this.desired.x, this.desired.y, player.z + this.desired.z);
    this.camera.lookAt(player.x, 1, player.z);
    this.billboard.copy(this.camera.quaternion);
  }
}

export class Game {
  constructor({ canvas, uiRoot, fxLayer, adapter }) {
    this.canvas = canvas;
    this.uiRoot = uiRoot;
    this.fxLayer = fxLayer;
    this.adapter = adapter;

    this.tier = detectTier();
    this.profile = profileFor(this.tier);

    this.state = STATE.BOOT;
    this.time = 0;
    this.elapsed = 0;
    this.kills = 0;
    this.coins = 0;
    this.maxTier = 1;
    this.perksTaken = 0;
    this.levels = {};

    this.stats = defaultStats();
    this.magnetBoost = { t: 0, mul: 1 };

    this.grid = new SpatialGrid(4);
    this._queryScratch = [];
    this._queryScratch2 = [];
    this._queryScratch3 = [];

    this.best = { wave: 0, kills: 0, coins: 0, time: 0 };

    this._raf = 0;
    this._last = 0;
    this._running = false;

    this._init();
  }

  _init() {
    this.renderer = new Renderer(this.canvas, this.profile);
    this.scene = this.renderer.scene;
    this.camera = this.renderer.camera;
    this.cameraRig = new CameraRig(this.camera);

    this.audio = new Audio();
    this.input = new Input(this.canvas, this.uiRoot);
    this.input.onPause = () => this.togglePause();
    this.input.onAnyInput = () => this.audio.unlock();

    this.arena = new Arena(this.scene, this.profile);
    this.effects = new Effects(this.scene, this.fxLayer, this.camera, this.profile);
    this.player = new Player(this);
    this.enemies = new Enemies(this, this.profile.maxEnemies);
    this.projectiles = new Projectiles(this, this.profile.maxProjectiles);
    this.pickups = new Pickups(this, 180);
    this.weapons = new Weapons(this);
    this.waves = new Waves(this);

    this.hud = new Hud(this.uiRoot, {
      pause: () => this.togglePause(),
      sound: () => this._toggleSound(),
      music: () => this._toggleMusic(),
    });

    this.screens = new Screens(this.uiRoot, {
      play: () => this.startRun(),
      resume: () => this.resume(),
      restart: () => this.startRun(),
      toMenu: () => this.toMenu(),
    });

    this.autoQuality = new AutoQuality(() => this._downgrade());

    window.addEventListener('resize', () => this.effects.resize());
    this.effects.resize();

    // Горячие клавиши выбора перка: 1 / 2 / 3.
    window.addEventListener('keydown', (e) => {
      if (this.state !== STATE.PERK) return;
      const n = Number(e.key);
      if (n >= 1 && n <= 3) {
        const card = this.screens.perkCards.children[n - 1];
        card?.click();
      }
    });
  }

  /* ================= Жизненный цикл ================= */

  start() {
    if (this._running) return;
    this._running = true;
    this._last = performance.now() / 1000;
    this._raf = requestAnimationFrame(this._tick);
  }

  _tick = (nowMs) => {
    this._raf = requestAnimationFrame(this._tick);
    const now = nowMs / 1000;
    let dt = now - this._last;
    this._last = now;
    // Защита от «скачка» после возврата на вкладку: иначе враги телепортируются.
    if (dt > 1 / 15) dt = 1 / 15;
    if (dt <= 0) dt = 1 / 240;

    this.time += dt;
    this.autoQuality.update(dt);

    switch (this.state) {
      case STATE.MENU:
        this.arena.update(dt, this.time);
        this.cameraRig.updateMenu(dt);
        break;
      case STATE.PLAYING:
        this._update(dt);
        break;
      case STATE.PERK:
      case STATE.PAUSED:
      case STATE.OVER:
        // Сцена живая, но геймплей заморожен — честно для GameplayAPI.
        this.arena.update(dt * 0.25, this.time);
        this.cameraRig.update(dt * 0.2, this.player, 0);
        break;
      default:
        this.arena.update(dt, this.time);
    }

    this.renderer.render();
  };

  _update(dt) {
    this.elapsed += dt;
    if (this.magnetBoost.t > 0) {
      this.magnetBoost.t -= dt;
      if (this.magnetBoost.t <= 0) this.magnetBoost.mul = 1;
    }

    this.input.update();
    this.enemies.update(dt, this.player, this.time);
    this.player.update(dt, this.time, this.input);
    if (this.state !== STATE.PLAYING) return; // игрок мог умереть внутри update

    this.weapons.update(dt, this.player, this.time);
    this.projectiles.update(dt);
    this.pickups.update(dt, this.player, this.time);
    this.waves.update(dt);

    this.arena.update(dt, this.time);
    this.effects.update(dt);
    this.cameraRig.update(dt, this.player, this.effects.shake.update(dt));

    this.hud.update(this);
    this.hud.updateCooldowns(this.weapons);
  }

  /* ================= Управление состоянием ================= */

  async toMenu() {
    this._clearRun();
    this.state = STATE.MENU;
    this.input.enabled = false;
    this.hud.setVisible(false);
    this.audio.stopMusic();
    await this._loadBest();
    this.screens.showMenu(this.best);
    this.adapter.gameplayStop();
  }

  async startRun() {
    this.audio.unlock();
    this._clearRun();

    this.state = STATE.PLAYING;
    this.time = 0;
    this.elapsed = 0;
    this.kills = 0;
    this.coins = 0;
    this.maxTier = 1;
    this.perksTaken = 0;
    this.levels = {};
    this.stats = defaultStats();
    this.magnetBoost = { t: 0, mul: 1 };

    this.player.reset();
    this.weapons.reset();
    this.waves.reset();

    // Стартовое оружие: бластер тира 1 — игрок сразу понимает механику.
    this.weapons.addWeapon(0, 1);
    this.hud.setSlots(this.weapons);
    this.hud.setPerks(this.levels);

    this.screens.hideAll();
    this.hud.setVisible(true);
    this.input.enabled = true;
    this.input.releaseAll();
    this.cameraRig.snap(this.player);

    this.audio.startMusic();
    this.adapter.gameplayStart();

    this.waves.startNextWave(1.6);
  }

  _clearRun() {
    this.enemies.clear();
    this.projectiles.clear();
    this.pickups.clear();
    this.effects.clear();
    this.weapons.reset();
    this.player.group.visible = false;
  }

  togglePause() {
    if (this.state === STATE.PLAYING) this.pause();
    else if (this.state === STATE.PAUSED) this.resume();
  }

  pause() {
    if (this.state !== STATE.PLAYING) return;
    this.state = STATE.PAUSED;
    this.input.enabled = false;
    this.input.releaseAll();
    this.screens.showPause();
    this.audio.stopMusic();
    this.audio.suspend();
    // Честная пауза: платформа должна знать, что игровой процесс остановлен.
    this.adapter.gameplayStop();
  }

  resume() {
    if (this.state !== STATE.PAUSED) return;
    this.state = STATE.PLAYING;
    this.input.enabled = true;
    this.screens.hideAll();
    this.audio.resume();
    this.audio.startMusic();
    this.adapter.gameplayStart();
  }

  /** Вызывается извне при уходе со вкладки / показе рекламы. */
  externalPause() {
    if (this.state === STATE.PLAYING) this.pause();
    else this.audio.suspend();
  }

  externalResume() {
    if (this.state === STATE.PAUSED) return; // игрок сам нажмёт «Продолжить»
    this.audio.resume();
  }

  /* ================= Бой ================= */

  spawnProjectile(cfg) {
    return this.projectiles.spawn(cfg);
  }

  damageEnemy(e, dmg, opts = {}) {
    if (!e.alive || this.state !== STATE.PLAYING) return;

    e.hp -= dmg;
    e.flash = 1;

    if (opts.knock) {
      const dx = e.x - (opts.x ?? e.x);
      const dz = e.z - (opts.z ?? e.z);
      const d = Math.hypot(dx, dz) || 1;
      const power = opts.knock / (e.boss ? 6 : Math.max(0.6, e.r));
      e.kx += (dx / d) * power;
      e.kz += (dz / d) * power;
    }

    this.effects.damage(e.x, 1.4 + e.r, e.z, dmg, !!opts.crit);
    this.effects.spark(opts.x ?? e.x, 1.15, opts.z ?? e.z, opts.color ?? 0xffffff, opts.crit ? 11 : 5);
    this.audio.hit();

    if (e.hp <= 0) this._killEnemy(e);
  }

  _killEnemy(e) {
    const def = e.def;
    this.kills++;
    this.coins += Math.round(def.coins * this.stats.coinMul);

    this.effects.death(e.x, 0.9, e.z, def.color, !!def.boss);
    this.audio.kill();

    if (def.boss) {
      this.effects.explosion(e.x, e.z, 9, def.color);
      this.audio.explode();
      this.effects.shake.add(0.9);
      this.effects.text(e.x, 3.6, e.z, 'БОСС ПОВЕРЖЕН', '#ff3ea5');
    }

    this.pickups.dropFromEnemy(e, 1 + this.levels.coins * 0.1);
    this.enemies.kill(e);
  }

  damagePlayer(amount) {
    if (this.state !== STATE.PLAYING || !this.player.alive) return;
    this.player.damage(amount);
  }

  /** Перк «Шипы»: враг в упор получает ответный урон. */
  applyThorns(e) {
    if (this.stats.thorns > 0 && e.alive) {
      this.damageEnemy(e, this.stats.thorns, { crit: false, x: this.player.x, z: this.player.z, knock: 4, color: 0xff5566 });
    }
  }

  explode(x, z, radius, dmg, color) {
    this.effects.explosion(x, z, radius, color);
    this.audio.explode();
    const near = this.grid.query(x, z, radius + 4, this._queryScratch3);
    for (const e of near) {
      if (!e.alive || !e.isEnemy) continue;
      const d = Math.hypot(e.x - x, e.z - z);
      if (d > radius + e.r) continue;
      const falloff = 1 - (Math.max(0, d - e.r) / Math.max(0.001, radius)) * 0.5;
      this.damageEnemy(e, dmg * falloff, { crit: false, x, z, knock: 10 * falloff, color });
    }
  }

  /* ================= Пикапы ================= */

  collectPickup(p) {
    switch (p.kind) {
      case 'coin': {
        const value = Math.round(p.value * this.stats.coinMul);
        this.coins += value;
        this.audio.coin();
        this.effects.spark(p.x, 0.8, p.z, 0xffc23d, 4);
        break;
      }
      case 'health': {
        this.player.heal(p.value);
        this.audio.heal();
        this.effects.particles.ring(p.x, 0.7, p.z, 0x7dff5e, 16, 3, 0.4);
        break;
      }
      case 'magnet': {
        this.magnetBoost.t = 12;
        this.magnetBoost.mul = 2.1;
        this.audio.pickup();
        this.effects.text(this.player.x, 2.6, this.player.z, 'МАГНИТ 12с', '#35e6ff');
        this.effects.particles.ring(this.player.x, 0.6, this.player.z, 0x35e6ff, 28, 8, 0.6);
        break;
      }
      case 'nuke': {
        this.audio.explode();
        this.effects.shake.add(1.1);
        const list = this.enemies.live;
        for (const e of list) {
          if (!e.alive) continue;
          this.effects.death(e.x, 0.9, e.z, 0xff3ea5, e.boss);
          this.damageEnemy(e, e.boss ? 260 : 190, { crit: false, x: e.x, z: e.z, knock: 3, color: 0xff3ea5 });
        }
        this.effects.particles.ring(this.player.x, 0.8, this.player.z, 0xff3ea5, 46, 26, 0.8);
        this.effects.text(this.player.x, 3.0, this.player.z, 'ЗАЧИСТКА', '#ff3ea5');
        break;
      }
      case 'weapon': {
        const result = this.weapons.addWeapon(p.weaponType, p.tier);
        if (result === 'overflow') {
          // Инвентарь полон и пары нет: куб честно превращается в монеты.
          // Обязательно показываем это визуально — иначе подбор выглядит
          // как «ничего не произошло», а это главный источник раздражения
          // в merge-играх.
          const value = Math.round(18 * p.tier * this.stats.coinMul);
          this.coins += value;
          this.audio.coin();
          this.effects.spark(p.x, 0.9, p.z, 0xffc23d, 9);
          this.effects.text(this.player.x, 2.4, this.player.z, `+${value} ⬤`, '#ffc23d');
        } else {
          this.audio.pickup();
        }
        break;
      }
      default:
        break;
    }
  }

  onWeaponAdded(slot) {
    const idx = this.weapons.slots.indexOf(slot);
    this.hud.setSlots(this.weapons);
    if (idx >= 0) this.hud.flashSlot(idx);
    this.effects.text(this.player.x, 2.5, this.player.z, WEAPONS[slot.type].name.toUpperCase(), WEAPONS[slot.type].css);
    this._trackTier(slot.tier);
  }

  onMerge(slot, type) {
    const idx = this.weapons.slots.indexOf(slot);
    const w = WEAPONS[type];
    this.audio.merge(slot.tier);
    this.effects.merge(slot.mesh.position.x, slot.mesh.position.y, slot.mesh.position.z, w.color);
    this.effects.text(this.player.x, 2.8, this.player.z, `${w.name} ТИР ${slot.tier}`, w.css);
    this.hud.setSlots(this.weapons);
    if (idx >= 0) this.hud.flashSlot(idx);
    this._trackTier(slot.tier);
  }

  _trackTier(tier) {
    if (tier > this.maxTier) this.maxTier = tier;
  }

  /* ================= Волны и перки ================= */

  waveScale() {
    return this.waves.scale();
  }

  onWaveStart(wave, isBoss, count) {
    this.hud.setSlots(this.weapons);
    if (isBoss) {
      this.hud.showBanner(`Волна ${wave}`, '⚠ Прибыл босс ⚠', true);
      this.audio.boss();
    } else {
      this.hud.showBanner(`Волна ${wave}`, `${count} противников`);
      this.audio.wave();
    }
  }

  async onWaveCleared(wave) {
    // Небольшая награда за волну: удержание держится на таких мелочах.
    this.player.heal(this.player.maxHp * 0.12);
    this.coins += Math.round((12 + wave * 4) * this.stats.coinMul);
    this.effects.levelUp(this.player.x, 1.2, this.player.z);

    this.state = STATE.PERK;
    this.input.enabled = false;
    this.input.releaseAll();
    this.audio.stopMusic();
    this.adapter.gameplayStop();

    // Interstitial — только между волнами и не чаще, чем раз в N волн.
    // Частота намеренно мягкая: агрессивная реклама обваливает retention.
    await this.adapter.interstitial({ wave });

    const choices = rollChoices(this.levels, this.weapons);
    this.screens.showPerk(choices, this.levels, wave, (perk) => this._pickPerk(perk));
  }

  _pickPerk(perk) {
    if (this.state !== STATE.PERK) return;

    if (perk.special === 'heal') {
      this.player.heal(this.player.maxHp);
    } else {
      perk.apply?.(this.stats);
      perk.after?.(this);
      this.levels[perk.id] = (this.levels[perk.id] ?? 0) + 1;
      this.perksTaken++;
      if (perk.id === 'hp') {
        // maxHpBonus уже увеличен в apply; синхронизируем текущий максимум.
        this.player.maxHp = 100 + this.stats.maxHpBonus;
      }
    }

    this.audio.merge(3);
    this.audio.uiClick();
    this.effects.particles.ring(this.player.x, 1.0, this.player.z, 0x35e6ff, 30, 6, 0.55);
    this.hud.setSlots(this.weapons);
    this.hud.setPerks(this._perkNames());

    this.screens.hideAll();
    this.state = STATE.PLAYING;
    this.input.enabled = true;
    this.audio.startMusic();
    this.adapter.gameplayStart();
    this.waves.startNextWave(1.8);
  }

  _perkNames() {
    const out = {};
    for (const [id, lvl] of Object.entries(this.levels)) {
      const p = perkById(id);
      out[p ? p.name : id] = lvl;
    }
    return out;
  }

  /* ================= Смерть и рекорды ================= */

  async onPlayerDeath() {
    this.state = STATE.OVER;
    this.input.enabled = false;
    this.input.releaseAll();
    this.audio.stopMusic();
    this.audio.gameOver();
    this.audio.suspend();
    this.adapter.gameplayStop();

    this.effects.death(this.player.x, 1.0, this.player.z, 0x35e6ff, true);
    this.effects.explosion(this.player.x, this.player.z, 7, 0x35e6ff);
    this.effects.shake.add(1.2);

    const result = {
      wave: this.waves.wave,
      kills: this.kills,
      coins: this.coins,
      time: this.elapsed,
      maxTier: this.maxTier,
      perks: this.perksTaken,
    };

    const isRecord = result.wave > this.best.wave ||
      (result.wave === this.best.wave && result.kills > this.best.kills);
    if (isRecord) this.best = { ...result };
    await this._saveBest(result);

    this.screens.showGameOver(result, this.best, isRecord);
    this.adapter.submitScore('main', Math.round(result.wave * 1000 + result.kills * 10 + result.coins));
  }

  async _loadBest() {
    try {
      const data = await this.adapter.loadData({ best: null });
      if (data?.best) this.best = data.best;
    } catch {
      /* сохранение недоступно — играем без рекордов */
    }
    return this.best;
  }

  async _saveBest(result) {
    try {
      await this.adapter.saveData({
        best: {
          wave: Math.max(this.best.wave, result.wave),
          kills: Math.max(this.best.kills, result.kills),
          coins: Math.max(this.best.coins, result.coins),
          time: Math.max(this.best.time, result.time),
        },
        lastRun: result,
      });
    } catch {
      /* не критично */
    }
  }

  /* ================= Настройки и качество ================= */

  _toggleSound() {
    const on = !this.audio.enabled;
    this.audio.setEnabled(on);
    this.hud.setSound(on);
    if (on) this.audio.uiClick();
  }

  _toggleMusic() {
    const on = !this.audio.musicEnabled;
    this.audio.setMusicEnabled(on);
    this.hud.setMusic(on);
    if (on && this.state === STATE.PLAYING) this.audio.startMusic();
    else this.audio.stopMusic();
  }

  _downgrade() {
    // Авто-снижение качества при стабильно низком FPS (пункт 1.15 требований:
    // игра не должна тормозить).
    this.renderer.disableBloom();
    this.renderer.downgradePixelRatio(1);
    this.profile.maxEnemies = Math.max(40, Math.floor(this.profile.maxEnemies * 0.7));
    this.waves._maxAlive = this.profile.maxEnemies;
    this.enemies.max = this.profile.maxEnemies;
  }

  get magnetMultiplier() {
    return this.magnetBoost.mul;
  }
}

export { STATE, MAX_TIER, fmt, WAVE_STATE, TIER, clamp };
