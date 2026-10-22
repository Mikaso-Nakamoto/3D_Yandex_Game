import * as THREE from 'three';
import { clamp, TAU } from '../core/utils.js';

/**
 * Оружие и главная фича игры — слияние (merge).
 *
 * Два одинаковых оружия одного тира превращаются в оружие тира выше.
 * Это одновременно:
 *  - петля прогрессии внутри забега (растёт урон и число снарядов);
 *  - источник «вкусных» моментов, на которые вешается rewarded-реклама
 *    (удвоить тир, получить оружие N-го тира, открыть пятый слот).
 *
 * Оружие стреляет само по ближайшей цели: игрок управляет только движением.
 * Это стандарт для survivor-like на вебе и делает управление тривиальным
 * на телефоне — один джойстик.
 */

export const MAX_SLOTS = 4;
export const MAX_TIER = 6;

export const WEAPONS = [
  {
    id: 'blaster',
    name: 'Бластер',
    glyph: '⚡',
    color: 0x35e6ff,
    css: '#35e6ff',
    desc: 'Точный одиночный снаряд',
    kind: 'projectile',
    dmg: 13,
    cd: 0.44,
    speed: 36,
    range: 30,
    spread: 0.04,
    size: 0.26,
    aoe: 0,
    life: 1.25,
    tierDmg: 0.58,
    tierCd: 0.9,
    tierCount: [1, 1, 2, 2, 3, 4],
    tierPierce: [0, 0, 0, 1, 1, 2],
  },
  {
    id: 'shotgun',
    name: 'Дробовик',
    glyph: '🔥',
    color: 0xffc23d,
    css: '#ffc23d',
    desc: 'Веер картечи вблизи',
    kind: 'projectile',
    dmg: 7,
    cd: 0.88,
    speed: 30,
    range: 15,
    spread: 0.44,
    size: 0.2,
    aoe: 0,
    life: 0.52,
    tierDmg: 0.52,
    tierCd: 0.93,
    tierCount: [4, 5, 6, 7, 8, 10],
    tierPierce: [0, 0, 0, 0, 1, 1],
  },
  {
    id: 'smg',
    name: 'Пулемёт',
    glyph: '✦',
    color: 0x7dff5e,
    css: '#7dff5e',
    desc: 'Шквал огня, малый урон за выстрел',
    kind: 'projectile',
    dmg: 5.5,
    cd: 0.135,
    speed: 42,
    range: 22,
    spread: 0.17,
    size: 0.17,
    aoe: 0,
    life: 0.95,
    tierDmg: 0.5,
    tierCd: 0.88,
    tierCount: [1, 1, 2, 2, 3, 3],
    tierPierce: [0, 0, 0, 0, 1, 2],
  },
  {
    id: 'sniper',
    name: 'Рельса',
    glyph: '➶',
    color: 0xa06bff,
    css: '#a06bff',
    desc: 'Пробивает всех врагов на линии',
    kind: 'projectile',
    dmg: 36,
    cd: 1.28,
    speed: 66,
    range: 48,
    spread: 0,
    size: 0.2,
    aoe: 0,
    life: 1.5,
    tierDmg: 0.62,
    tierCd: 0.92,
    tierCount: [1, 1, 1, 2, 2, 3],
    tierPierce: [3, 4, 5, 6, 8, 10],
  },
  {
    id: 'rocket',
    name: 'Ракеты',
    glyph: '✸',
    color: 0xff3ea5,
    css: '#ff3ea5',
    desc: 'Взрыв по площади',
    kind: 'projectile',
    dmg: 21,
    cd: 1.55,
    speed: 21,
    range: 27,
    spread: 0.1,
    size: 0.34,
    aoe: 4.2,
    life: 2.0,
    tierDmg: 0.55,
    tierCd: 0.93,
    tierCount: [1, 2, 2, 3, 3, 4],
    tierPierce: [0, 0, 0, 0, 0, 0],
  },
  {
    id: 'orbital',
    name: 'Орбиты',
    glyph: '◎',
    color: 0xff8a3d,
    css: '#ff8a3d',
    desc: 'Сферы вокруг героя бьют врагов',
    kind: 'orbital',
    dmg: 11,
    cd: 0.55,
    speed: 0,
    range: 5.6,
    spread: 0,
    size: 0.55,
    aoe: 0,
    life: 0,
    tierDmg: 0.6,
    tierCd: 0.95,
    tierCount: [2, 3, 3, 4, 5, 6],
    tierPierce: [0, 0, 0, 0, 0, 0],
  },
];

export const WEAPON_IDS = WEAPONS.map((w) => w.id);

export function weaponIndexById(id) {
  return WEAPONS.findIndex((w) => w.id === id);
}

/** Итоговые характеристики оружия на данном тире. */
export function weaponStats(type, tier) {
  const w = WEAPONS[type];
  const t = clamp(tier, 1, MAX_TIER) - 1;
  return {
    kind: w.kind,
    dmg: w.dmg * (1 + w.tierDmg * t),
    cd: w.cd * Math.pow(w.tierCd, t),
    count: w.tierCount[t],
    pierce: w.tierPierce[t],
    speed: w.speed * (1 + 0.05 * t),
    range: w.range * (1 + 0.06 * t),
    size: w.size * (1 + 0.13 * t),
    aoe: w.aoe * (1 + 0.12 * t),
    life: w.life,
    spread: w.spread,
  };
}

const SAT_GEO = new THREE.OctahedronGeometry(1, 0);

export class Weapons {
  /** @param {import('../game.js').Game} game */
  constructor(game) {
    this.game = game;
    /** @type {Array<{type:number, tier:number, cd:number, angle:number, mesh:THREE.Mesh|null, hitCd:number}>} */
    this.slots = [];
    this.slotCount = MAX_SLOTS;
    this._tmpTargets = [];
    this._meshes = [];
  }

  reset() {
    for (const m of this._meshes) {
      m.visible = false;
      if (m.parent) m.parent.remove(m);
    }
    this._meshes.length = 0;
    this.slots.length = 0;
    this.slotCount = MAX_SLOTS;
  }

  _makeSatellite(type, tier) {
    const w = WEAPONS[type];
    const mat = new THREE.MeshStandardMaterial({
      color: w.color,
      emissive: w.color,
      emissiveIntensity: 1.5 + tier * 0.35,
      roughness: 0.25,
      metalness: 0.4,
      flatShading: true,
    });
    const mesh = new THREE.Mesh(SAT_GEO, mat);
    const s = 0.3 + tier * 0.055;
    mesh.scale.setScalar(s);
    this.game.scene.add(mesh);
    this._meshes.push(mesh);
    return mesh;
  }

  get freeSlot() {
    return this.slots.length < this.slotCount;
  }

  /** Есть ли уже точно такое же оружие (для слияния). */
  findSame(type, tier) {
    return this.slots.findIndex((s) => s.type === type && s.tier === tier);
  }

  findLowestTier() {
    let idx = -1;
    let best = Infinity;
    for (let i = 0; i < this.slots.length; i++) {
      if (this.slots[i].tier < best) {
        best = this.slots[i].tier;
        idx = i;
      }
    }
    return idx;
  }

  /**
   * Добавить оружие из пикапа.
   * @returns {'added'|'merged'|'replaced'|'overflow'} что произошло — для звука и effects
   */
  addWeapon(type, tier = 1) {
    // 1. Прямое слияние, если есть пара.
    const sameIdx = this.findSame(type, tier);
    if (sameIdx >= 0) {
      const slot = this.slots[sameIdx];
      if (slot.tier >= MAX_TIER) return 'overflow';
      slot.tier += 1;
      slot.cd = 0;
      this._refreshSatellite(slot);
      this.game.onMerge(slot, type);
      return 'merged';
    }

    // 2. Свободный слот.
    if (this.freeSlot) {
      const slot = {
        type, tier,
        cd: Math.random() * 0.2,
        cdFull: 1,
        _lastCdRatio: 0,
        angle: 0,
        mesh: null,
        hitCd: 0,
      };
      slot.mesh = this._makeSatellite(type, tier);
      this.slots.push(slot);
      this._layout();
      this.game.onWeaponAdded(slot);
      return 'added';
    }

    // 3. Слотов нет — меняем самый слабый, если новое оружие сильнее.
    const lowest = this.findLowestTier();
    if (lowest >= 0 && tier > this.slots[lowest].tier) {
      const old = this.slots[lowest];
      this._releaseSatellite(old);
      old.type = type;
      old.tier = tier;
      old.cd = 0;
      old.mesh = this._makeSatellite(type, tier);
      this._layout();
      this.game.onWeaponAdded(old);
      return 'replaced';
    }

    return 'overflow';
  }

  _releaseSatellite(slot) {
    if (!slot.mesh) return;
    slot.mesh.visible = false;
    if (slot.mesh.parent) slot.mesh.parent.remove(slot.mesh);
    slot.mesh.material.dispose();
    const i = this._meshes.indexOf(slot.mesh);
    if (i >= 0) this._meshes.splice(i, 1);
    slot.mesh = null;
  }

  _refreshSatellite(slot) {
    const w = WEAPONS[slot.type];
    slot.mesh.material.emissiveIntensity = 1.5 + slot.tier * 0.35;
    slot.mesh.material.color.setHex(w.color);
    slot.mesh.material.emissive.setHex(w.color);
    slot.mesh.scale.setScalar(0.3 + slot.tier * 0.055);
  }

  addSlot() {
    if (this.slotCount < MAX_SLOTS + 2) {
      this.slotCount++;
      this._layout();
      return true;
    }
    return false;
  }

  _layout() {
    const n = this.slots.length;
    for (let i = 0; i < n; i++) {
      this.slots[i].angle = (i / n) * TAU;
    }
  }

  /** Ближайший живой враг в радиусе. */
  _nearestEnemy(x, z, range) {
    const enemies = this.game.enemies.live;
    let best = null;
    let bestD = range * range;
    for (let i = 0; i < enemies.length; i++) {
      const e = enemies[i];
      if (!e.alive) continue;
      const dx = e.x - x;
      const dz = e.z - z;
      const d2 = dx * dx + dz * dz;
      if (d2 < bestD) {
        bestD = d2;
        best = e;
      }
    }
    return best;
  }

  update(dt, player, time) {
    const stats = this.game.stats;
    const n = this.slots.length;

    for (let i = 0; i < n; i++) {
      const slot = this.slots[i];
      const st = weaponStats(slot.type, slot.tier);
      const w = WEAPONS[slot.type];

      // --- Визуал: сателлиты вращаются вокруг игрока ---
      const orbitR = st.kind === 'orbital' ? st.range : 1.45;
      slot.angle += dt * (st.kind === 'orbital' ? 1.9 : 1.15);
      const ox = player.x + Math.cos(slot.angle) * orbitR;
      const oz = player.z + Math.sin(slot.angle) * orbitR;
      const oy = st.kind === 'orbital' ? 1.0 : 1.35 + Math.sin(time * 3 + i) * 0.12;
      slot.mesh.position.set(ox, oy, oz);
      slot.mesh.rotation.y += dt * 2.4;
      slot.mesh.rotation.x += dt * 1.3;

      // --- Орбитальное оружие: урон контактом, с личным кулдауном ---
      if (st.kind === 'orbital') {
        slot.hitCd -= dt;
        if (slot.hitCd <= 0) {
          const dmg = st.dmg * stats.damage;
          let hitAny = false;
          const near = this.game.grid.query(ox, oz, 1.6, this._tmpTargets);
          for (const e of near) {
            if (!e.alive || !e.isEnemy) continue;
            const rr = e.r + st.size + 0.4;
            if ((e.x - ox) ** 2 + (e.z - oz) ** 2 <= rr * rr) {
              this.game.damageEnemy(e, dmg, { crit: false, x: ox, z: oz, knock: 2, color: w.color });
              hitAny = true;
            }
          }
          if (hitAny) slot.hitCd = st.cd * stats.cooldown;
        }
        continue;
      }

      // --- Стрелковое оружие ---
      slot.cd -= dt;
      if (slot.cd > 0) continue;

      const target = this._nearestEnemy(ox, oz, st.range);
      if (!target) continue;

      slot.cd = st.cd * stats.cooldown;
      slot.cdFull = slot.cd;

      // Небольшое упреждение: целимся туда, куда враг придёт.
      const flight = Math.hypot(target.x - ox, target.z - oz) / Math.max(1, st.speed);
      const tx = target.x + (target.vx || 0) * flight * 0.7;
      const tz = target.z + (target.vz || 0) * flight * 0.7;

      let base = Math.atan2(tz - oz, tx - ox);
      const count = st.count + stats.extraProjectiles;
      const spread = st.spread * (count > 1 ? 1 : 0.35);

      for (let k = 0; k < count; k++) {
        const off = count === 1 ? 0 : (k / (count - 1) - 0.5) * spread * 2;
        const jitter = (Math.random() - 0.5) * spread * 0.35;
        this.game.spawnProjectile({
          x: ox,
          y: oy,
          z: oz,
          angle: base + off + jitter,
          speed: st.speed,
          dmg: st.dmg * stats.damage,
          pierce: st.pierce + stats.pierce,
          size: st.size,
          aoe: st.aoe,
          life: st.life,
          type: slot.type,
          tier: slot.tier,
          hostile: false,
          critChance: stats.crit,
        });
      }

      this.game.audio.shoot(slot.type, slot.tier);
      this.game.effects.muzzle(ox, oy, oz, w.color);
      slot.mesh.scale.setScalar((0.3 + slot.tier * 0.055) * 1.35);
    }

    // Возврат масштаба сателлитов после «отдачи» + отношение перезарядки для HUD.
    for (let i = 0; i < n; i++) {
      const slot = this.slots[i];
      const target = 0.3 + slot.tier * 0.055;
      if (slot.mesh.scale.x > target) {
        slot.mesh.scale.setScalar(THREE.MathUtils.damp(slot.mesh.scale.x, target, 14, dt));
      }
      slot._lastCdRatio = slot.cdFull > 0 ? Math.max(0, Math.min(1, slot.cd / slot.cdFull)) : 0;
    }
  }

  /** Позиции сателлитов для HUD (чтобы слоты подсвечивались при выстреле). */
  getSlotSnapshot() {
    return this.slots.map((s) => ({ type: s.type, tier: s.tier }));
  }
}
