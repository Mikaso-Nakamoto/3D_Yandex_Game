import * as THREE from 'three';
import { Pool, KeyedMeshPool } from '../core/pool.js';
import { clamp, TAU } from '../core/utils.js';

/**
 * Враги. Процедурная low-poly геометрия, никаких моделей извне.
 *
 * Типы подобраны так, чтобы волна читалась визуально: быстрые мелкие,
 * медленные толстые, стрелки держат дистанцию, босс раз в 5 волн.
 * Именно разнообразие угроз создаёт «ещё один забег» — основу удержания,
 * от которого на Яндекс Играх напрямую зависит доход.
 */

export const ENEMY_TYPES = {
  grunt: {
    name: 'Громила',
    r: 0.78, hp: 24, speed: 4.7, dmg: 9, color: 0xff5566, cost: 1, xp: 1, coins: 1,
  },
  runner: {
    name: 'Юркий',
    r: 0.5, hp: 13, speed: 8.6, dmg: 6, color: 0xffc23d, cost: 1, xp: 1, coins: 1,
  },
  tank: {
    name: 'Броневик',
    r: 1.5, hp: 125, speed: 2.6, dmg: 20, color: 0x9966ff, cost: 4, xp: 4, coins: 5, hpBar: true,
  },
  shooter: {
    name: 'Стрелок',
    r: 0.8, hp: 36, speed: 3.4, dmg: 11, color: 0x44ddff, cost: 3, xp: 3, coins: 3,
    ranged: true, keepDist: 15, fireCd: 2.1, projSpeed: 20, projDmg: 10,
  },
  boss: {
    name: 'БОСС',
    r: 2.8, hp: 1150, speed: 2.35, dmg: 28, color: 0xff2288, cost: 0, xp: 40, coins: 60,
    boss: true, hpBar: true, ranged: true, keepDist: 0, fireCd: 3.0, projSpeed: 17, projDmg: 14,
  },
};

export const ENEMY_KEYS = Object.keys(ENEMY_TYPES);

/* ---------- Меши ---------- */

function bodyMat(color, emissiveIntensity = 0.7) {
  return new THREE.MeshStandardMaterial({
    color: 0x141a34,
    emissive: color,
    emissiveIntensity,
    roughness: 0.42,
    metalness: 0.55,
    flatShading: true,
  });
}

function glowMat(color) {
  return new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.95 });
}

function buildEnemyMesh(key) {
  const def = ENEMY_TYPES[key];
  const color = def.color;
  const g = new THREE.Group();
  const body = bodyMat(color, key === 'boss' ? 1.25 : 0.7);
  g.userData.bodyMat = body;
  g.userData.baseEmissive = body.emissiveIntensity;

  if (key === 'grunt') {
    const torso = new THREE.Mesh(new THREE.BoxGeometry(1.15, 1.35, 1.0), body);
    torso.position.y = 0.85;
    g.add(torso);
    const head = new THREE.Mesh(new THREE.BoxGeometry(0.62, 0.5, 0.6), body);
    head.position.y = 1.75;
    g.add(head);
    const eye = new THREE.Mesh(new THREE.BoxGeometry(0.44, 0.1, 0.06), glowMat(color));
    eye.position.set(0, 1.78, 0.31);
    g.add(eye);
    g.userData.parts = [torso, head];
  } else if (key === 'runner') {
    const cone = new THREE.Mesh(new THREE.ConeGeometry(0.52, 1.25, 5), body);
    cone.position.y = 0.68;
    cone.rotation.x = Math.PI / 2; // «летит» вперёд
    g.add(cone);
    const core = new THREE.Mesh(new THREE.SphereGeometry(0.2, 8, 6), glowMat(color));
    core.position.y = 0.68;
    g.add(core);
    g.userData.parts = [cone];
  } else if (key === 'tank') {
    const torso = new THREE.Mesh(new THREE.BoxGeometry(2.3, 2.1, 2.1), body);
    torso.position.y = 1.15;
    g.add(torso);
    const edges = new THREE.LineSegments(
      new THREE.EdgesGeometry(torso.geometry),
      new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.9 }),
    );
    edges.position.copy(torso.position);
    g.add(edges);
    for (const sx of [-1, 1]) {
      const eye = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.16, 0.08), glowMat(color));
      eye.position.set(sx * 0.5, 1.6, 1.08);
      g.add(eye);
    }
    g.userData.parts = [torso];
  } else if (key === 'shooter') {
    const orb = new THREE.Mesh(new THREE.SphereGeometry(0.62, 12, 10), body);
    orb.position.y = 1.0;
    g.add(orb);
    const ring = new THREE.Mesh(new THREE.TorusGeometry(0.95, 0.07, 6, 20), glowMat(color));
    ring.position.y = 1.0;
    ring.rotation.x = Math.PI / 2.4;
    g.add(ring);
    g.userData.ring = ring;
    g.userData.parts = [orb];
  } else if (key === 'boss') {
    const core = new THREE.Mesh(new THREE.IcosahedronGeometry(2.05, 0), body);
    core.position.y = 2.5;
    g.add(core);
    const inner = new THREE.Mesh(new THREE.IcosahedronGeometry(1.1, 0), glowMat(0xffffff));
    inner.position.y = 2.5;
    inner.material.opacity = 0.4;
    g.add(inner);
    const shards = new THREE.Group();
    for (let i = 0; i < 6; i++) {
      const s = new THREE.Mesh(new THREE.TetrahedronGeometry(0.5, 0), glowMat(color));
      const a = (i / 6) * TAU;
      s.position.set(Math.cos(a) * 3.1, 2.5 + Math.sin(a * 2) * 0.5, Math.sin(a) * 3.1);
      shards.add(s);
    }
    g.add(shards);
    g.userData.shards = shards;
    g.userData.core = core;
    g.userData.parts = [core];
  }

  // Полоска здоровья — только для «толстых» врагов, иначе замусориваем кадр.
  if (def.hpBar) {
    const bg = new THREE.Mesh(
      new THREE.PlaneGeometry(2.4, 0.22),
      new THREE.MeshBasicMaterial({ color: 0x0a0d1c, transparent: true, opacity: 0.85, depthTest: false }),
    );
    const fg = new THREE.Mesh(
      new THREE.PlaneGeometry(2.4, 0.22),
      new THREE.MeshBasicMaterial({ color, depthTest: false }),
    );
    bg.renderOrder = 998;
    fg.renderOrder = 999;
    const holder = new THREE.Group();
    holder.add(bg);
    holder.add(fg);
    fg.position.z = 0.01;
    holder.position.y = key === 'boss' ? 5.4 : 2.7;
    holder.scale.setScalar(key === 'boss' ? 1.9 : 0.85);
    g.add(holder);
    g.userData.hpBar = fg;
    g.userData.hpBarWidth = 2.4;
  }

  g.traverse((o) => {
    o.frustumCulled = false;
    if (o.isMesh) o.castShadow = false;
  });

  return g;
}

/* ---------- Система ---------- */

let UID = 1;

// Переиспользуемый кватернион для биллборда полосок здоровья:
// без него каждый танк и босс создавали бы по объекту на кадр.
const _invQ = new THREE.Quaternion();

export class Enemies {
  constructor(game, max) {
    this.game = game;
    this.max = max;

    this.meshes = new KeyedMeshPool(buildEnemyMesh);

    this.pool = new Pool(
      () => ({
        uid: 0,
        alive: false,
        isEnemy: true,
        key: '',
        def: null,
        mesh: null,
        x: 0, z: 0, y: 0,
        vx: 0, vz: 0,
        kx: 0, kz: 0,
        r: 0.7,
        hp: 1, maxHp: 1,
        speed: 4, dmg: 8,
        contactCd: 0,
        fireCd: 0,
        flash: 0,
        phase: 0,
        spawnT: 0,
        boss: false,
        summonCd: 0,
        burstIndex: 0,
      }),
      (o) => {
        o.alive = true;
        o.contactCd = 0;
        o.flash = 0;
        o.kx = 0;
        o.kz = 0;
      },
      40,
    );

    this.live = this.pool.live;
    this._near = [];
  }

  spawn(key, x, z, scale = { hp: 1, dmg: 1, speed: 1 }) {
    if (this.pool.count >= this.max) return null;

    const def = ENEMY_TYPES[key];
    const e = this.pool.obtain();
    e.uid = UID++;
    e.key = key;
    e.def = def;
    e.mesh = this.meshes.obtain(key);
    e.r = def.r;
    e.maxHp = def.hp * scale.hp;
    e.hp = e.maxHp;
    e.speed = def.speed * scale.speed;
    e.dmg = def.dmg * scale.dmg;
    e.boss = !!def.boss;
    e.x = x;
    e.z = z;
    e.y = 0;
    e.vx = 0;
    e.vz = 0;
    e.fireCd = def.fireCd ? def.fireCd * (0.4 + Math.random() * 0.8) : 0;
    e.summonCd = 5;
    e.burstIndex = 0;
    e.phase = Math.random() * TAU;
    e.spawnT = 0;

    const mat = e.mesh.userData.bodyMat;
    if (mat) mat.emissiveIntensity = e.mesh.userData.baseEmissive;
    if (e.mesh.userData.hpBar) e.mesh.userData.hpBar.scale.x = 1;
    e.mesh.position.set(x, 0, z);
    e.mesh.scale.setScalar(1);
    this.game.scene.add(e.mesh);
    return e;
  }

  kill(e) {
    e.alive = false;
    if (e.mesh) {
      this.meshes.release(e.key, e.mesh);
      e.mesh = null;
    }
  }

  clear() {
    for (let i = this.live.length - 1; i >= 0; i--) this.kill(this.live[i]);
    this.pool.releaseAll();
  }

  /** Сколько живых врагов сейчас на арене. */
  get aliveCount() {
    return this.pool.count;
  }

  update(dt, player, time) {
    const game = this.game;
    const half = game.arena.half - 1.2;
    const list = this.live;

    // Сетка нужна для сепарации и для попаданий снарядов.
    game.grid.clear();
    for (let i = 0; i < list.length; i++) {
      const e = list[i];
      if (e.alive) game.grid.insert(e);
    }

    for (let i = list.length - 1; i >= 0; i--) {
      const e = list[i];
      if (!e.alive) {
        game.enemies.pool.releaseAt(i);
        continue;
      }

      const def = e.def;
      e.spawnT += dt;

      // Появление: враг «вырастает» из земли — читается и скрывает спавн.
      const grow = clamp(e.spawnT / 0.32, 0, 1);
      const growEased = 1 - Math.pow(1 - grow, 3);

      const dx = player.x - e.x;
      const dz = player.z - e.z;
      const d = Math.hypot(dx, dz) || 0.0001;
      const nx = dx / d;
      const nz = dz / d;

      let moveX = nx;
      let moveZ = nz;

      if (def.ranged && def.keepDist > 0) {
        // Стрелок держит дистанцию: подходит, если далеко, отступает, если близко.
        const err = d - def.keepDist;
        const k = clamp(err / 6, -1, 1);
        moveX = nx * k;
        moveZ = nz * k;
      }

      // Сепарация: не даём врагам слипаться в одну точку.
      const near = game.grid.query(e.x, e.z, e.r * 2.6, this._near);
      let sepX = 0;
      let sepZ = 0;
      for (const o of near) {
        if (o === e || !o.alive) continue;
        const ox = e.x - o.x;
        const oz = e.z - o.z;
        const rr = e.r + o.r;
        const d2 = ox * ox + oz * oz;
        if (d2 > 0.0001 && d2 < rr * rr) {
          const dd = Math.sqrt(d2);
          const push = (rr - dd) / dd;
          sepX += ox * push * 0.55;
          sepZ += oz * push * 0.55;
        }
      }

      // Отдача от попаданий.
      const kx = e.kx;
      const kz = e.kz;
      e.kx *= Math.max(0, 1 - 9 * dt);
      e.kz *= Math.max(0, 1 - 9 * dt);

      const wob = e.boss ? 0 : Math.sin(time * 6 + e.phase) * 0.06;
      const speed = e.speed * growEased;
      e.vx = moveX * speed + sepX * 6 + kx + wob;
      e.vz = moveZ * speed + sepZ * 6 + kz;

      e.x += e.vx * dt;
      e.z += e.vz * dt;

      // Границы арены.
      const lim = half - e.r;
      e.x = clamp(e.x, -lim, lim);
      e.z = clamp(e.z, -lim, lim);

      // Препятствия.
      game.arena.resolveObstacles(e);

      // Поворот в сторону движения.
      const targetYaw = Math.atan2(e.vx, e.vz);
      const mesh = e.mesh;
      mesh.position.set(e.x, 0, e.z);
      mesh.rotation.y = THREE.MathUtils.damp(mesh.rotation.y, targetYaw, 9, dt);
      mesh.scale.setScalar(growEased);

      // Анимация «дыхания» и спец-элементы.
      if (def.boss) {
        const shards = mesh.userData.shards;
        if (shards) shards.rotation.y += dt * 1.1;
        const core = mesh.userData.core;
        if (core) core.rotation.y -= dt * 0.6;
      } else if (mesh.userData.ring) {
        mesh.userData.ring.rotation.z += dt * 2.6;
      } else if (mesh.userData.parts) {
        for (const p of mesh.userData.parts) {
          p.position.y += Math.sin(time * 7 + e.phase) * 0.0022;
        }
      }

      // Вспышка от урона.
      if (e.flash > 0) {
        e.flash = Math.max(0, e.flash - dt * 5.5);
        const mat = mesh.userData.bodyMat;
        if (mat) mat.emissiveIntensity = mesh.userData.baseEmissive + e.flash * 4.5;
      }

      // Полоска здоровья всегда смотрит в камеру.
      //
      // Важно: полоска — дочерний объект ГРУППЫ врага, а группа поворачивается
      // по направлению движения. Просто скопировать кватернион камеры в локальный
      // нельзя: мировая ориентация получится как «поворот врага × камера»,
      // и полоску будет закручивать вслед за врагом. Нужна компенсация —
      // локальный кватернион = обратный кватернион родителя × кватернион камеры.
      const bar = mesh.userData.hpBar;
      if (bar) {
        _invQ.copy(mesh.quaternion).invert();
        bar.parent.quaternion.copy(_invQ).multiply(game.cameraRig.billboard);
        bar.scale.x = clamp(e.hp / e.maxHp, 0.001, 1);
      }

      // --- Атаки ---
      e.contactCd -= dt;
      const touchDist = e.r + player.r;
      if (d < touchDist && e.contactCd <= 0 && grow > 0.6) {
        e.contactCd = 0.85;
        game.damagePlayer(e.dmg);
        game.applyThorns(e);
        // Отталкиваем игрока — иначе его «зажимают» толпой.
        player.applyKnock(nx * 6, nz * 6);
      }

      if (def.ranged && def.fireCd) {
        e.fireCd -= dt;
        if (e.fireCd <= 0 && grow > 0.6) {
          e.fireCd = def.fireCd * (0.75 + Math.random() * 0.5);
          if (def.boss) this._bossFire(e, player, time);
          else this._fire(e, nx, nz, def);
        }
      }

      if (def.boss) {
        e.summonCd -= dt;
        if (e.summonCd <= 0) {
          e.summonCd = 9;
          this._bossSummon(e);
        }
      }
    }
  }

  _fire(e, nx, nz, def) {
    const angle = Math.atan2(nz, nx);
    this.game.projectiles.spawn({
      x: e.x, y: 1.1, z: e.z,
      angle,
      speed: def.projSpeed ?? 20,
      dmg: def.projDmg ?? e.dmg,
      life: 3.2,
      size: 0.34,
      hostile: true,
    });
    this.game.audio.shoot(5, 1);
  }

  /** Босс: радиальный веер + призыв мелких. */
  _bossFire(e, player, time) {
    const pattern = e.burstIndex++ % 3;
    const base = Math.atan2(player.z - e.z, player.x - e.x);

    if (pattern === 0) {
      const n = 14;
      for (let i = 0; i < n; i++) {
        const a = base + (i / n) * TAU;
        this.game.projectiles.spawn({
          x: e.x, y: 1.4, z: e.z, angle: a,
          speed: (ENEMY_TYPES.boss.projSpeed ?? 17),
          dmg: ENEMY_TYPES.boss.projDmg ?? 14,
          life: 3.4, size: 0.4, hostile: true,
        });
      }
      this.game.effects.particles.ring(e.x, 1.0, e.z, ENEMY_TYPES.boss.color, 22, 6, 0.45);
    } else {
      for (let i = -2; i <= 2; i++) {
        const a = base + i * 0.19;
        this.game.projectiles.spawn({
          x: e.x, y: 1.4, z: e.z, angle: a,
          speed: 24, dmg: 13, life: 3, size: 0.36, hostile: true,
        });
      }
    }
    this.game.audio.shoot(4, 3);
  }

  _bossSummon(e) {
    const keys = ['runner', 'grunt', 'shooter'];
    for (let i = 0; i < 4; i++) {
      const a = Math.random() * TAU;
      const r = e.r + 2.2;
      const x = clamp(e.x + Math.cos(a) * r, -this.game.arena.half + 3, this.game.arena.half - 3);
      const z = clamp(e.z + Math.sin(a) * r, -this.game.arena.half + 3, this.game.arena.half - 3);
      const spawned = this.spawn(keys[i % keys.length], x, z, this.game.waveScale());
      if (spawned) this.game.effects.particles.ring(x, 0.4, z, spawned.def.color, 12, 2.4, 0.35);
    }
    this.game.audio.boss();
  }
}
