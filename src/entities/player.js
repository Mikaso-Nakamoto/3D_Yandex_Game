import * as THREE from 'three';
import { clamp, damp, TAU } from '../core/utils.js';

/**
 * Игрок: low-poly мех с процедурной анимацией шага.
 *
 * Управление только движением (оружие стреляет само) — это стандарт
 * survivor-like на вебе и единственный вариант, который нормально живёт
 * на телефоне с одним джойстиком.
 */

const BASE_SPEED = 9.2;
const BASE_HP = 100;
const BASE_MAGNET = 4.2;

export class Player {
  constructor(game) {
    this.game = game;
    this.x = 0;
    this.z = 0;
    this.y = 0;
    this.r = 0.75;
    this.vx = 0;
    this.vz = 0;
    this.kx = 0;
    this.kz = 0;
    this.hp = BASE_HP;
    this.maxHp = BASE_HP;
    this.invuln = 0;
    this.walkPhase = 0;
    this.facing = 0;
    this.alive = true;
    this.auraCd = 0;
    this._build();
  }

  _build() {
    const g = new THREE.Group();

    const hull = new THREE.MeshStandardMaterial({
      color: 0x1b2547,
      roughness: 0.34,
      metalness: 0.78,
      emissive: 0x1d4f9c,
      emissiveIntensity: 0.5,
      flatShading: true,
    });
    const glow = new THREE.MeshBasicMaterial({ color: 0x35e6ff, transparent: true, opacity: 0.95 });

    // Корпус.
    const torso = new THREE.Mesh(new THREE.BoxGeometry(0.95, 0.95, 0.72), hull);
    torso.position.y = 1.25;
    g.add(torso);

    // Нагрудный реактор.
    const core = new THREE.Mesh(new THREE.SphereGeometry(0.19, 10, 8), glow);
    core.position.set(0, 1.32, 0.38);
    g.add(core);

    // Голова.
    const head = new THREE.Mesh(new THREE.BoxGeometry(0.56, 0.42, 0.52), hull);
    head.position.y = 1.95;
    g.add(head);

    // Визор.
    const visor = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.11, 0.06), glow);
    visor.position.set(0, 1.97, 0.27);
    g.add(visor);

    // Плечи.
    const shoulders = [];
    for (const sx of [-1, 1]) {
      const s = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.42, 0.5), hull);
      s.position.set(sx * 0.66, 1.45, 0);
      g.add(s);
      shoulders.push(s);
    }

    // Ноги — анимируются шагом.
    const legs = [];
    for (const sx of [-1, 1]) {
      const pivot = new THREE.Group();
      pivot.position.set(sx * 0.26, 0.82, 0);
      const leg = new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.82, 0.3), hull);
      leg.position.y = -0.38;
      pivot.add(leg);
      const foot = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.16, 0.46), glow);
      foot.position.set(0, -0.76, 0.05);
      foot.material = glow.clone();
      foot.material.opacity = 0.75;
      pivot.add(foot);
      g.add(pivot);
      legs.push(pivot);
    }

    // Сопла — светятся при движении.
    const thrusterMat = new THREE.MeshBasicMaterial({
      color: 0x35e6ff,
      transparent: true,
      opacity: 0.0,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    const thruster = new THREE.Mesh(new THREE.ConeGeometry(0.26, 0.95, 8), thrusterMat);
    thruster.rotation.x = Math.PI;
    thruster.position.y = 0.62;
    g.add(thruster);

    // Кольцо радиуса сбора: подсказывает, как работает перк «Магнит».
    const ringMat = new THREE.MeshBasicMaterial({
      color: 0x35e6ff,
      transparent: true,
      opacity: 0.16,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    const ring = new THREE.Mesh(new THREE.RingGeometry(0.96, 1.0, 48), ringMat);
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.05;
    g.add(ring);

    g.traverse((o) => {
      o.frustumCulled = false;
      if (o.isMesh) {
        o.castShadow = !!this.game.renderer.profile.shadows;
        o.receiveShadow = false;
      }
    });

    this.group = g;
    this.parts = { torso, head, visor, core, legs, shoulders, thruster, thrusterMat, ring, ringMat, hull, glow };
    this.game.scene.add(g);
  }

  reset() {
    const stats = this.game.stats;
    this.x = 0;
    this.z = 0;
    this.vx = 0;
    this.vz = 0;
    this.kx = 0;
    this.kz = 0;
    this.invuln = 0;
    this.alive = true;
    this.auraCd = 0;
    this.walkPhase = 0;
    this.facing = 0;
    this.maxHp = BASE_HP + stats.maxHpBonus;
    this.hp = this.maxHp;
    this.group.position.set(0, 0, 0);
    this.group.visible = true;
    this._setMagnetRing();
  }

  /** Радиус сбора с учётом перков и временного буста от пикапа «Магнит». */
  get magnetRadius() {
    return BASE_MAGNET * this.game.stats.magnet * this.game.magnetBoost.mul;
  }

  _setMagnetRing() {
    const r = this.magnetRadius;
    this.parts.ring.scale.setScalar(clamp(r, 0.4, 14));
  }

  applyKnock(x, z) {
    this.kx += x;
    this.kz += z;
  }

  heal(amount) {
    if (!this.alive) return;
    const before = this.hp;
    this.hp = Math.min(this.maxHp, this.hp + amount);
    if (this.hp > before + 0.01) {
      this.game.effects.healFlash();
      this.game.effects.text(this.x, 2.4, this.z, `+${Math.round(this.hp - before)}`, '#7dff5e');
    }
  }

  damage(amount) {
    if (!this.alive || this.invuln > 0) return false;
    const stats = this.game.stats;
    const reduced = amount * (1 - stats.armor);
    this.hp -= reduced;
    this.invuln = 0.62;
    this.game.effects.hurtFlash();
    this.game.effects.shake.add(0.3);
    this.game.audio.hurt();
    this.game.effects.text(this.x, 2.4, this.z, `-${Math.round(reduced)}`, '#ff4d5e');

    if (this.hp <= 0) {
      this.hp = 0;
      this.alive = false;
      this.game.onPlayerDeath();
    }
    return true;
  }

  update(dt, time, input) {
    const stats = this.game.stats;
    const arena = this.game.arena;

    if (!this.alive) {
      this.group.visible = false;
      return;
    }
    this.group.visible = true;

    this.invuln = Math.max(0, this.invuln - dt);

    // Регенерация.
    if (stats.regen > 0 && this.hp < this.maxHp) {
      this.hp = Math.min(this.maxHp, this.hp + stats.regen * dt);
    }

    // Перк «Плазменное поле»: периодический урон всем вокруг.
    if (stats.aura > 0) {
      this.auraCd -= dt;
      if (this.auraCd <= 0) {
        this.auraCd = 0.55;
        const radius = 5.6;
        const near = this.game.grid.query(this.x, this.z, radius + 3, this.game._queryScratch2);
        let hit = 0;
        for (const e of near) {
          if (!e.alive || !e.isEnemy) continue;
          const rr = radius + e.r;
          if ((e.x - this.x) ** 2 + (e.z - this.z) ** 2 <= rr * rr) {
            this.game.damageEnemy(e, stats.aura, { crit: false, x: e.x, z: e.z, knock: 1.2, color: 0xff8a3d });
            hit++;
          }
        }
        if (hit > 0) {
          this.game.effects.particles.ring(this.x, 0.5, this.z, 0xff8a3d, 20, radius * 0.9, 0.34);
        }
      }
    }

    // Движение.
    const speed = BASE_SPEED * stats.speed;
    const ix = input.mx;
    const iz = input.mz;
    const mag = Math.hypot(ix, iz);

    this.vx = damp(this.vx, ix * speed, 14, dt);
    this.vz = damp(this.vz, iz * speed, 14, dt);

    this.kx *= Math.max(0, 1 - 8 * dt);
    this.kz *= Math.max(0, 1 - 8 * dt);

    this.x += (this.vx + this.kx) * dt;
    this.z += (this.vz + this.kz) * dt;

    const lim = arena.half - this.r - 0.4;
    this.x = clamp(this.x, -lim, lim);
    this.z = clamp(this.z, -lim, lim);
    arena.resolveObstacles(this);

    // Поворот: смотрим туда, куда движемся.
    const moving = Math.hypot(this.vx, this.vz);
    if (moving > 0.6) {
      const target = Math.atan2(this.vx, this.vz);
      let diff = target - this.facing;
      while (diff > Math.PI) diff -= TAU;
      while (diff < -Math.PI) diff += TAU;
      this.facing += diff * Math.min(1, dt * 12);
    }
    this.group.rotation.y = this.facing;
    this.group.position.set(this.x, 0, this.z);

    // Анимация шага.
    this.walkPhase += dt * (2.4 + moving * 1.15);
    const swing = Math.sin(this.walkPhase * 2.4) * clamp(moving / speed, 0, 1) * 0.62;
    this.parts.legs[0].rotation.x = swing;
    this.parts.legs[1].rotation.x = -swing;
    this.parts.shoulders[0].rotation.x = -swing * 0.6;
    this.parts.shoulders[1].rotation.x = swing * 0.6;
    this.group.position.y = Math.abs(Math.sin(this.walkPhase * 2.4)) * 0.09 * clamp(moving / speed, 0, 1);

    // Сопла и реактор.
    this.parts.thrusterMat.opacity = clamp(moving / speed, 0, 1) * 0.55;
    this.parts.thruster.scale.y = 0.6 + clamp(moving / speed, 0, 1) * 0.9;
    this.parts.core.scale.setScalar(1 + Math.sin(time * 5) * 0.09);

    // Мигание в неуязвимости.
    const blink = this.invuln > 0 ? (Math.sin(time * 40) > 0 ? 0.35 : 1) : 1;
    this.parts.hull.emissiveIntensity = 0.5 * blink + (this.invuln > 0 ? 1.4 : 0);
    this.parts.ringMat.opacity = 0.1 + Math.sin(time * 2.2) * 0.05;

    this._setMagnetRing();
  }
}

export { BASE_HP, BASE_MAGNET, BASE_SPEED };
