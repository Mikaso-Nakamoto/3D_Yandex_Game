import * as THREE from 'three';
import { Pool, KeyedMeshPool } from '../core/pool.js';
import { clamp, rand, TAU } from '../core/utils.js';
import { WEAPONS, MAX_TIER } from '../systems/weapons.js';

/**
 * Пикапы: кубы оружия, монеты, аптечки, магниты и «ядерка».
 *
 * Это ядро монетизации: кубы оружия падают редко, и именно вокруг них
 * строятся rewarded-показы (удвоить выпавшее, поднять тир, открыть слот).
 * Магнитное притяжение обязательно — без него игрок бегает за лутом и злится.
 */

const LIFETIME = 15;

/**
 * Доля дропа, намеренно совпадающая с уже имеющимся у игрока типом оружия.
 *
 * Значение 0.85 получено перебором (scripts/balance-check.mjs): при нём
 * слияния случаются 18–19 раз за забег и 6 раз уже к 10-й волне, а средний
 * тир растёт 2.4 → 3.2 → 5.8. При 0.55 слияний вдвое меньше и игрок
 * не успевает понять механику.
 */
const OWN_TYPE_BIAS = 0.85;

const KIND_COLOR = {
  coin: 0xffc23d,
  health: 0x7dff5e,
  nuke: 0xff3ea5,
  magnet: 0x35e6ff,
  tier: 0xa06bff,
};

function makeMesh(key) {
  // key: 'weapon:<typeIndex>:<tier>' | 'coin' | 'health' | 'nuke' | 'magnet' | 'tier'
  const g = new THREE.Group();

  if (key.startsWith('weapon')) {
    const [, ti, tr] = key.split(':');
    const type = Number(ti);
    const tier = Number(tr);
    const w = WEAPONS[type];
    const size = 0.44 + tier * 0.055;
    const mat = new THREE.MeshStandardMaterial({
      color: 0x0f1430,
      emissive: w.color,
      emissiveIntensity: 1.15 + tier * 0.22,
      roughness: 0.22,
      metalness: 0.6,
      flatShading: true,
    });
    const cube = new THREE.Mesh(new THREE.BoxGeometry(size, size, size), mat);
    cube.position.y = 0.85;
    g.add(cube);

    const edges = new THREE.LineSegments(
      new THREE.EdgesGeometry(cube.geometry),
      new THREE.LineBasicMaterial({ color: w.color, transparent: true, opacity: 0.95 }),
    );
    edges.position.copy(cube.position);
    g.add(edges);

    // Маркер тира: маленькие сферы вокруг куба — читается без HUD.
    for (let i = 0; i < tier; i++) {
      const pip = new THREE.Mesh(
        new THREE.SphereGeometry(0.07, 6, 5),
        new THREE.MeshBasicMaterial({ color: 0xffffff }),
      );
      const a = (i / Math.max(1, tier)) * TAU;
      pip.position.set(Math.cos(a) * (size * 0.95), 0.85, Math.sin(a) * (size * 0.95));
      g.add(pip);
    }
    g.userData.spinCube = cube;
  } else {
    const color = KIND_COLOR[key] ?? 0xffffff;
    const mat = new THREE.MeshStandardMaterial({
      color: 0x10152e,
      emissive: color,
      emissiveIntensity: 1.5,
      roughness: 0.25,
      metalness: 0.45,
      flatShading: true,
    });
    let mesh;
    if (key === 'coin') {
      mesh = new THREE.Mesh(new THREE.OctahedronGeometry(0.28, 0), mat);
      mesh.position.y = 0.6;
    } else if (key === 'health') {
      mesh = new THREE.Mesh(new THREE.SphereGeometry(0.34, 10, 8), mat);
      mesh.position.y = 0.7;
      const cross1 = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.13, 0.13), new THREE.MeshBasicMaterial({ color: 0xffffff }));
      cross1.position.y = 0.7;
      const cross2 = cross1.clone();
      cross2.rotation.y = Math.PI / 2;
      g.add(cross1, cross2);
    } else if (key === 'nuke') {
      mesh = new THREE.Mesh(new THREE.IcosahedronGeometry(0.42, 0), mat);
      mesh.position.y = 0.8;
    } else if (key === 'magnet') {
      mesh = new THREE.Mesh(new THREE.TorusGeometry(0.32, 0.11, 6, 14), mat);
      mesh.position.y = 0.7;
      mesh.rotation.x = Math.PI / 2;
    } else {
      mesh = new THREE.Mesh(new THREE.TetrahedronGeometry(0.4, 0), mat);
      mesh.position.y = 0.8;
    }
    g.add(mesh);
    g.userData.spinCube = mesh;
  }

  // Тень-круг на полу: помогает читать позицию пикапа в 3D.
  const shadow = new THREE.Mesh(
    new THREE.RingGeometry(0.16, 0.3, 16),
    new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.35, depthWrite: false }),
  );
  shadow.rotation.x = -Math.PI / 2;
  shadow.position.y = 0.03;
  g.add(shadow);

  g.traverse((o) => { o.frustumCulled = false; });
  return g;
}

export class Pickups {
  constructor(game, max = 160) {
    this.game = game;
    this.max = max;
    this.meshes = new KeyedMeshPool(makeMesh);

    this.pool = new Pool(
      () => ({
        alive: false, kind: '', key: '', mesh: null,
        x: 0, y: 0, z: 0, vy: 0,
        life: 0, phase: 0,
        weaponType: 0, tier: 1, value: 1,
      }),
      (o) => { o.alive = true; },
      50,
    );

    this.live = this.pool.live;
  }

  _keyFor(cfg) {
    return cfg.kind === 'weapon' ? `weapon:${cfg.weaponType}:${cfg.tier}` : cfg.kind;
  }

  spawn(cfg) {
    if (this.pool.count >= this.max) return null;
    const p = this.pool.obtain();
    p.kind = cfg.kind;
    p.key = this._keyFor(cfg);
    p.mesh = this.meshes.obtain(p.key);
    p.x = cfg.x;
    p.z = cfg.z;
    p.y = 0;
    p.vy = cfg.vy ?? rand(4.5, 7.5);
    p.life = cfg.life ?? LIFETIME;
    p.phase = rand(0, TAU);
    p.weaponType = cfg.weaponType ?? 0;
    p.tier = cfg.tier ?? 1;
    p.value = cfg.value ?? 1;
    p.mesh.position.set(p.x, p.y, p.z);
    p.mesh.visible = true;
    this.game.scene.add(p.mesh);
    return p;
  }

  /**
   * Выбор типа выпадающего оружия.
   *
   * Со смещением к типам, которые у игрока уже есть. Без этого пара для
   * слияния собирается мучительно долго (6 типов × низкий шанс дропа),
   * и главная механика игры просто не успевает раскрыться за забег —
   * игрок уходит, не поняв, в чём суть. Приём стандартный для merge-игр.
   */
  _pickWeaponType() {
    const owned = this.game.weapons.slots.map((s) => s.type);
    if (owned.length > 0 && Math.random() < OWN_TYPE_BIAS) {
      return owned[(Math.random() * owned.length) | 0];
    }
    return (Math.random() * WEAPONS.length) | 0;
  }

  /**
   * Тир выпадающего куба.
   *
   * Привязан к САМОМУ СЛАБОМУ оружию игрока, а не к номеру волны. Это ключевое
   * решение для пейсинга: пока в инвентаре есть оружие низкого тира, кубы
   * падают под него и сливаются; когда всё инвентарное «дно» поднялось,
   * подрастает и тир дропа. Привязка к волне давала бы либо мусорный лут
   * (слишком низкий тир), либо мгновенный потолок (слишком высокий).
   *
   * Перебор вариантов показал: схема «min − 1» даёт кривую тира 2.4 → 3.2 → 5.8
   * на волнах 10 / 20 / 40, то есть прогрессия не выгорает до конца забега.
   * Вариант с накопительным «зарядом слияния» отброшен: он доводил тир до
   * потолка (6.0) уже к 20-й волне и убивал мотивацию играть дальше.
   */
  _pickWeaponTier(isBoss) {
    const slots = this.game.weapons.slots;
    const minTier = slots.length ? Math.min(...slots.map((s) => s.tier)) : 1;
    let tier = Math.max(1, minTier - 1);
    if (isBoss) tier += 1;
    return clamp(tier, 1, MAX_TIER);
  }

  /** Выпадение лута с врага. Вероятности тюнятся под экономику забега. */
  dropFromEnemy(e, luck = 1) {
    const def = e.def;

    // Монеты — почти всегда, это валюта мета-прогрессии.
    const coinCount = def.boss ? 22 : Math.random() < 0.55 ? 1 : 0;
    for (let i = 0; i < coinCount; i++) {
      this.spawn({
        kind: 'coin',
        x: e.x + rand(-0.8, 0.8),
        z: e.z + rand(-0.8, 0.8),
        value: def.boss ? 12 : 2,
      });
    }

    // Оружие. Босс гарантирует два куба повышенного тира — это «награда-веха»,
    // ради которой игрок терпит сложную волну.
    const weaponChance = (def.cost >= 3 ? 0.1 : 0.055) * luck;
    const weaponDrops = def.boss ? 2 : Math.random() < weaponChance ? 1 : 0;

    for (let i = 0; i < weaponDrops; i++) {
      this.spawn({
        kind: 'weapon',
        x: e.x + rand(-0.5, 0.5),
        z: e.z + rand(-0.5, 0.5),
        weaponType: this._pickWeaponType(),
        tier: this._pickWeaponTier(def.boss),
        life: 22,
      });
    }
    if (weaponDrops > 0) return 'weapon';

    // Вспомогательные пикапы — только если оружие не выпало,
    // иначе лут засыпает арену и теряет ценность.
    const roll = Math.random();
    if (roll < 0.05) {
      this.spawn({ kind: 'health', x: e.x, z: e.z, value: 18, life: 18 });
      return 'health';
    }
    if (roll < 0.062) {
      this.spawn({ kind: 'magnet', x: e.x, z: e.z, life: 18 });
      return 'magnet';
    }
    if (roll < 0.066) {
      this.spawn({ kind: 'nuke', x: e.x, z: e.z, life: 18 });
      return 'nuke';
    }
    return null;
  }

  kill(p) {
    p.alive = false;
    if (p.mesh) {
      this.meshes.release(p.key, p.mesh);
      p.mesh = null;
    }
  }

  clear() {
    for (let i = this.live.length - 1; i >= 0; i--) this.kill(this.live[i]);
    this.pool.releaseAll();
  }

  update(dt, player, time) {
    const game = this.game;
    const list = this.live;
    const magnetR = player.magnetRadius;
    const magnetR2 = magnetR * magnetR;
    const collectR = player.r + 0.55;
    const collectR2 = collectR * collectR;
    const half = game.arena.half - 1;

    for (let i = list.length - 1; i >= 0; i--) {
      const p = list[i];
      if (!p.alive) {
        game.pickups.pool.releaseAt(i);
        continue;
      }

      p.life -= dt;
      if (p.life <= 0) {
        this.kill(p);
        game.pickups.pool.releaseAt(i);
        continue;
      }

      // Физика «прыжка» при появлении.
      p.vy -= 22 * dt;
      p.y += p.vy * dt;
      if (p.y <= 0) {
        p.y = 0;
        if (p.vy < -1.2) p.vy = -p.vy * 0.42;
        else p.vy = 0;
      }

      const dx = player.x - p.x;
      const dz = player.z - p.z;
      const d2 = dx * dx + dz * dz;

      // Магнит: пикап летит к игроку. Радиус для оружия чуть больше —
      // его ценнее, и терять обиднее.
      const mr2 = p.kind === 'weapon' ? magnetR2 * 1.5 : magnetR2;
      if (d2 < mr2 && d2 > 0.0001) {
        const d = Math.sqrt(d2);
        const pull = clamp((1 - d / Math.sqrt(mr2)) * 26 + 7, 0, 30);
        p.x += (dx / d) * pull * dt;
        p.z += (dz / d) * pull * dt;
      }

      if (d2 < collectR2 && p.y < 1.8) {
        game.collectPickup(p);
        this.kill(p);
        game.pickups.pool.releaseAt(i);
        continue;
      }

      p.x = clamp(p.x, -half, half);
      p.z = clamp(p.z, -half, half);

      // Анимация: вращение и парение; мигание перед исчезновением.
      const bob = p.y + 0.06 + Math.sin(time * 3.2 + p.phase) * 0.09;
      p.mesh.position.set(p.x, bob, p.z);
      if (p.mesh.userData.spinCube) {
        p.mesh.userData.spinCube.rotation.y += dt * 2.2;
        p.mesh.userData.spinCube.rotation.x += dt * 0.9;
      }
      if (p.life < 3.4) {
        // Мигание перед исчезновением — масштабом, а не opacity:
        // материалы здесь общие и переиспользуются из пула, их трогать нельзя.
        const blink = Math.sin(p.life * 22) > 0 ? 1 : 0.42;
        p.mesh.scale.setScalar(blink);
      } else if (p.mesh.scale.x !== 1) {
        p.mesh.scale.setScalar(1);
      }
    }
  }
}
