import * as THREE from 'three';
import { Pool, KeyedMeshPool } from '../core/pool.js';
import { clamp } from '../core/utils.js';
import { WEAPONS } from '../systems/weapons.js';

/**
 * Снаряды: свои (оружие игрока) и вражеские.
 *
 * Всё в пулах, геометрия и материалы кэшируются по типу оружия.
 * Трассер — вытянутый бокс вдоль оси +X, поэтому поворот вокруг Y равен -angle.
 */

const ENEMY_COLOR = 0xff4d5e;

function makeGeometry(key) {
  switch (key) {
    case 'blaster':
      return new THREE.BoxGeometry(1.9, 0.22, 0.22);
    case 'shotgun':
      return new THREE.BoxGeometry(0.9, 0.19, 0.19);
    case 'smg':
      return new THREE.BoxGeometry(1.15, 0.15, 0.15);
    case 'sniper':
      return new THREE.BoxGeometry(3.6, 0.16, 0.16);
    case 'rocket':
      return new THREE.ConeGeometry(0.34, 1.15, 6);
    case 'orbital':
      return new THREE.OctahedronGeometry(0.5, 0);
    default:
      return new THREE.SphereGeometry(0.3, 8, 6);
  }
}

function makeMaterial(key) {
  const color = key === 'enemy' ? ENEMY_COLOR : WEAPONS.find((w) => w.id === key)?.color ?? 0xffffff;
  return new THREE.MeshBasicMaterial({
    color,
    transparent: true,
    opacity: 0.96,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
}

export class Projectiles {
  constructor(game, max) {
    this.game = game;
    this.max = max;

    this.meshes = new KeyedMeshPool((key) => {
      const mesh = new THREE.Mesh(makeGeometry(key), makeMaterial(key));
      mesh.frustumCulled = false;
      if (key === 'rocket') mesh.rotation.z = -Math.PI / 2; // конус смотрит вдоль +X
      return mesh;
    });

    this.pool = new Pool(
      () => ({
        mesh: null,
        key: '',
        x: 0, y: 0, z: 0,
        vx: 0, vz: 0,
        dmg: 0, pierce: 0, size: 0.25, aoe: 0,
        life: 0, maxLife: 1,
        hostile: false,
        crit: false,
        type: 0,
        alive: false,
        spin: 0,
        hitIds: null,
      }),
      (o) => {
        o.alive = true;
        if (!o.hitIds) o.hitIds = new Set();
        else o.hitIds.clear();
      },
      80,
    );

    this.live = this.pool.live;
  }

  spawn(cfg) {
    if (this.pool.count >= this.max) return null;

    const p = this.pool.obtain();
    const key = cfg.hostile ? 'enemy' : WEAPONS[cfg.type]?.id ?? 'blaster';
    if (p.key !== key) {
      if (p.mesh) this.meshes.release(p.key, p.mesh);
      p.key = key;
      p.mesh = this.meshes.obtain(key);
      if (key === 'rocket') p.mesh.rotation.z = -Math.PI / 2;
      else p.mesh.rotation.z = 0;
    } else if (!p.mesh) {
      p.mesh = this.meshes.obtain(key);
    } else {
      p.mesh.visible = true;
    }

    p.x = cfg.x;
    p.y = cfg.y ?? 1.0;
    p.z = cfg.z;
    const a = cfg.angle;
    p.vx = Math.cos(a) * cfg.speed;
    p.vz = Math.sin(a) * cfg.speed;
    p.dmg = cfg.dmg;
    p.pierce = cfg.pierce ?? 0;
    p.size = cfg.size ?? 0.25;
    p.aoe = cfg.aoe ?? 0;
    p.life = cfg.life ?? 1;
    p.maxLife = p.life;
    p.hostile = !!cfg.hostile;
    p.type = cfg.type ?? 0;
    p.crit = false;
    p.spin = cfg.spin ?? 0;

    p.mesh.position.set(p.x, p.y, p.z);
    p.mesh.rotation.y = -a;
    const s = p.size * (1 + (cfg.tier ? (cfg.tier - 1) * 0.1 : 0));
    p.mesh.scale.set(s, s, s);
    this.game.scene.add(p.mesh);
    return p;
  }

  _kill(p) {
    p.alive = false;
    if (p.mesh) {
      p.mesh.visible = false;
      if (p.mesh.parent) p.mesh.parent.remove(p.mesh);
    }
  }

  clear() {
    for (let i = this.live.length - 1; i >= 0; i--) this._kill(this.live[i]);
    this.pool.releaseAll();
  }

  update(dt) {
    const game = this.game;
    const arena = game.arena;
    const list = this.live;
    const near = game._queryScratch;

    for (let i = list.length - 1; i >= 0; i--) {
      const p = list[i];
      if (!p.alive) {
        game.projectiles.pool.releaseAt(i);
        continue;
      }

      p.life -= dt;
      if (p.life <= 0) {
        if (p.aoe > 0) game.explode(p.x, p.z, p.aoe, p.dmg, WEAPONS[p.type]?.color ?? 0xff3ea5);
        this._kill(p);
        game.projectiles.pool.releaseAt(i);
        continue;
      }

      const nx = p.x + p.vx * dt;
      const nz = p.z + p.vz * dt;
      p.x = nx;
      p.z = nz;
      if (p.spin) p.mesh.rotation.x += p.spin * dt;

      // Выход за арену.
      if (Math.abs(p.x) > arena.half + 1 || Math.abs(p.z) > arena.half + 1) {
        this._kill(p);
        game.projectiles.pool.releaseAt(i);
        continue;
      }

      // Препятствия.
      let hitWall = false;
      for (const o of arena.obstacles) {
        const rr = o.r + p.size;
        if ((p.x - o.x) ** 2 + (p.z - o.z) ** 2 < rr * rr) {
          hitWall = true;
          break;
        }
      }
      if (hitWall) {
        game.effects.spark(p.x, p.y, p.z, p.hostile ? ENEMY_COLOR : WEAPONS[p.type].color, 5);
        if (p.aoe > 0) game.explode(p.x, p.z, p.aoe, p.dmg, WEAPONS[p.type].color);
        this._kill(p);
        game.projectiles.pool.releaseAt(i);
        continue;
      }

      if (p.hostile) {
        // По игроку.
        const pl = game.player;
        const rr = pl.r + p.size + 0.2;
        if ((p.x - pl.x) ** 2 + (p.z - pl.z) ** 2 < rr * rr) {
          game.damagePlayer(p.dmg);
          game.effects.spark(p.x, p.y, p.z, ENEMY_COLOR, 8);
          this._kill(p);
          game.projectiles.pool.releaseAt(i);
          continue;
        }
      } else {
        // По врагам: берём кандидатов из пространственной сетки.
        const cands = game.grid.query(p.x, p.z, p.size + 3.2, near);
        let done = false;
        for (const e of cands) {
          if (!e.alive || !e.isEnemy) continue;
          if (p.hitIds.has(e.uid)) continue;
          const rr = e.r + p.size;
          if ((p.x - e.x) ** 2 + (p.z - e.z) ** 2 > rr * rr) continue;

          const crit = Math.random() < (game.stats.crit ?? 0);
          const dmg = p.dmg * (crit ? 2 : 1);
          game.damageEnemy(e, dmg, {
            crit,
            x: p.x,
            z: p.z,
            knock: p.aoe > 0 ? 1 : 3.2,
            color: WEAPONS[p.type]?.color ?? 0xffffff,
          });

          if (p.aoe > 0) {
            game.explode(p.x, p.z, p.aoe, p.dmg * 0.72, WEAPONS[p.type].color);
            this._kill(p);
            game.projectiles.pool.releaseAt(i);
            done = true;
            break;
          }

          p.hitIds.add(e.uid);
          if (p.pierce > 0) {
            p.pierce--;
          } else {
            this._kill(p);
            game.projectiles.pool.releaseAt(i);
            done = true;
            break;
          }
        }
        if (done) continue;
      }

      p.mesh.position.set(p.x, p.y, p.z);
      // Трассер «сдувается» к концу жизни. Именно масштабом, а не opacity:
      // материалы здесь общие на весь тип оружия и переиспользуются из пула,
      // трогать их у отдельного снаряда нельзя — заденет все остальные.
      const fade = clamp(p.life / Math.max(0.001, p.maxLife * 0.35), 0, 1);
      const s = p.size * (0.55 + 0.45 * fade);
      p.mesh.scale.set(s, s, s);
    }
  }
}
