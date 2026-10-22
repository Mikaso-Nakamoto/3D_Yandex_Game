import * as THREE from 'three';
import { rand, randInt, TAU } from '../core/utils.js';

/**
 * Арена: пол с процедурной текстурой, стены, препятствия, свет.
 *
 * Размер арены — константа, от неё считаются границы движения и спавн врагов.
 * Всё генерируется кодом: ни одной внешней текстуры, что критично для лимита
 * размера архива на Яндекс Играх.
 */
export const ARENA = 34; // половина стороны квадрата арены
export const ARENA_SIZE = ARENA * 2;

/** Процедурная текстура пола: сетка + шум + виньетка. 512×512 — дёшево и чисто. */
function makeGroundTexture() {
  const S = 512;
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const g = c.getContext('2d');

  g.fillStyle = '#080b18';
  g.fillRect(0, 0, S, S);

  // Лёгкий шум, чтобы пол не выглядел плоским пластиком.
  const img = g.getImageData(0, 0, S, S);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const n = (Math.random() - 0.5) * 16;
    d[i] = Math.max(0, Math.min(255, d[i] + n));
    d[i + 1] = Math.max(0, Math.min(255, d[i + 1] + n));
    d[i + 2] = Math.max(0, Math.min(255, d[i + 2] + n * 1.4));
  }
  g.putImageData(img, 0, 0);

  // Крупная сетка.
  const step = S / 17;
  g.lineWidth = 2;
  g.strokeStyle = 'rgba(70, 150, 220, 0.30)';
  g.beginPath();
  for (let i = 0; i <= 17; i++) {
    const p = Math.round(i * step) + 0.5;
    g.moveTo(p, 0);
    g.lineTo(p, S);
    g.moveTo(0, p);
    g.lineTo(S, p);
  }
  g.stroke();

  // Мелкая сетка.
  const step2 = S / 68;
  g.lineWidth = 1;
  g.strokeStyle = 'rgba(60, 120, 200, 0.10)';
  g.beginPath();
  for (let i = 0; i <= 68; i++) {
    const p = Math.round(i * step2) + 0.5;
    g.moveTo(p, 0);
    g.lineTo(p, S);
    g.moveTo(0, p);
    g.lineTo(S, p);
  }
  g.stroke();

  // Виньетка к краям.
  const grad = g.createRadialGradient(S / 2, S / 2, S * 0.18, S / 2, S / 2, S * 0.72);
  grad.addColorStop(0, 'rgba(0,0,0,0)');
  grad.addColorStop(1, 'rgba(0,0,0,0.72)');
  g.fillStyle = grad;
  g.fillRect(0, 0, S, S);

  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(4, 4);
  tex.anisotropy = 4;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

export class Arena {
  constructor(scene, profile) {
    this.scene = scene;
    this.profile = profile;
    /** Половина стороны арены — граница движения всех сущностей. */
    this.half = ARENA;
    /** Препятствия: { x, z, r } — для коллизий используется окружность. */
    this.obstacles = [];
    this._animated = [];

    this._buildLights();
    this._buildFloor();
    this._buildWalls();
    this._buildObstacles();
    this._buildDecor();
  }

  _buildLights() {
    this.scene.add(new THREE.HemisphereLight(0x5f7fd0, 0x0a0c18, 0.85));

    const dir = new THREE.DirectionalLight(0xbfd8ff, 1.15);
    dir.position.set(18, 42, 14);
    if (this.profile.shadows) {
      dir.castShadow = true;
      dir.shadow.mapSize.set(1024, 1024);
      const s = 46;
      dir.shadow.camera.left = -s;
      dir.shadow.camera.right = s;
      dir.shadow.camera.top = s;
      dir.shadow.camera.bottom = -s;
      dir.shadow.camera.near = 1;
      dir.shadow.camera.far = 120;
      dir.shadow.bias = -0.0016;
    }
    this.scene.add(dir);

    if (!this.profile.lights) return;

    // Цветные акценты по углам — дают «синтвейв» и читаемые направления.
    const accents = [
      { c: 0x35e6ff, x: -ARENA, z: -ARENA },
      { c: 0xff3ea5, x: ARENA, z: -ARENA },
      { c: 0xa06bff, x: -ARENA, z: ARENA },
      { c: 0x7dff5e, x: ARENA, z: ARENA },
    ];
    for (const a of accents) {
      const l = new THREE.PointLight(a.c, 90, 62, 2);
      l.position.set(a.x * 0.82, 7, a.z * 0.82);
      this.scene.add(l);
    }
  }

  _buildFloor() {
    const tex = makeGroundTexture();
    const geo = new THREE.PlaneGeometry(ARENA_SIZE, ARENA_SIZE);
    const mat = new THREE.MeshStandardMaterial({
      map: tex,
      roughness: 0.86,
      metalness: 0.16,
      color: 0x9fb6dd,
    });
    const floor = new THREE.Mesh(geo, mat);
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = !!this.profile.shadows;
    this.scene.add(floor);

    // Тонкая светящаяся рамка по периметру — ориентир границы арены.
    const edge = new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.BoxGeometry(ARENA_SIZE, 0.12, ARENA_SIZE)),
      new THREE.LineBasicMaterial({ color: 0x35e6ff, transparent: true, opacity: 0.55 }),
    );
    edge.position.y = 0.06;
    this.scene.add(edge);
  }

  _buildWalls() {
    const h = 3.2;
    const t = 1.2;
    const mat = new THREE.MeshStandardMaterial({
      color: 0x121a36,
      roughness: 0.5,
      metalness: 0.5,
      emissive: 0x1b3f7a,
      emissiveIntensity: 0.85,
    });
    const specs = [
      { w: ARENA_SIZE + t * 2, d: t, x: 0, z: -ARENA - t / 2 },
      { w: ARENA_SIZE + t * 2, d: t, x: 0, z: ARENA + t / 2 },
      { w: t, d: ARENA_SIZE, x: -ARENA - t / 2, z: 0 },
      { w: t, d: ARENA_SIZE, x: ARENA + t / 2, z: 0 },
    ];
    for (const s of specs) {
      const m = new THREE.Mesh(new THREE.BoxGeometry(s.w, h, s.d), mat);
      m.position.set(s.x, h / 2, s.z);
      m.castShadow = false;
      this.scene.add(m);
    }

    // Светящаяся кромка поверх стен.
    const glowMat = new THREE.MeshBasicMaterial({ color: 0x35e6ff, transparent: true, opacity: 0.8 });
    for (const s of specs) {
      const g = new THREE.Mesh(new THREE.BoxGeometry(s.w * 1.001, 0.14, s.d * 1.001), glowMat);
      g.position.set(s.x, h + 0.07, s.z);
      this.scene.add(g);
    }
  }

  _buildObstacles() {
    // Симметричный набор колонн и кристаллов. Расставляем по кольцам,
    // чтобы центр оставался свободным — там игрок стартует.
    const mat = new THREE.MeshStandardMaterial({
      color: 0x1a2348,
      roughness: 0.35,
      metalness: 0.72,
      emissive: 0x2a5fd0,
      emissiveIntensity: 0.35,
    });
    const crystalMat = new THREE.MeshStandardMaterial({
      color: 0x2b1350,
      roughness: 0.18,
      metalness: 0.35,
      emissive: 0xa06bff,
      emissiveIntensity: 1.5,
      flatShading: true,
    });

    const rings = [
      { count: 4, radius: 12, kind: 'pillar' },
      { count: 6, radius: 21, kind: 'crystal' },
      { count: 4, radius: 29, kind: 'pillar' },
    ];

    let seedOffset = rand(0, TAU);
    for (const ring of rings) {
      for (let i = 0; i < ring.count; i++) {
        const a = seedOffset + (i / ring.count) * TAU;
        const jitter = rand(-1.6, 1.6);
        const x = Math.cos(a) * (ring.radius + jitter);
        const z = Math.sin(a) * (ring.radius + jitter);
        if (Math.hypot(x, z) < 6.5) continue; // не закрываем точку старта

        if (ring.kind === 'pillar') {
          const w = rand(2.0, 3.2);
          const hgt = rand(3.4, 6.2);
          const m = new THREE.Mesh(new THREE.BoxGeometry(w, hgt, w), mat);
          m.position.set(x, hgt / 2, z);
          m.rotation.y = rand(0, TAU);
          m.castShadow = !!this.profile.shadows;
          this.scene.add(m);

          const cap = new THREE.Mesh(new THREE.BoxGeometry(w * 1.06, 0.18, w * 1.06), glowCap());
          cap.position.set(x, hgt + 0.09, z);
          cap.rotation.y = m.rotation.y;
          this.scene.add(cap);

          this.obstacles.push({ x, z, r: w * 0.78 });
        } else {
          const r = rand(1.1, 1.9);
          const m = new THREE.Mesh(new THREE.OctahedronGeometry(r, 0), crystalMat);
          m.position.set(x, r * 1.15, z);
          m.rotation.set(rand(0, TAU), rand(0, TAU), rand(0, TAU));
          m.castShadow = !!this.profile.shadows;
          this.scene.add(m);
          this._animated.push({ mesh: m, spin: rand(0.15, 0.5), bob: rand(0.4, 1.0), baseY: r * 1.15, phase: rand(0, TAU) });
          this.obstacles.push({ x, z, r: r * 0.95 });
        }
      }
      seedOffset += 0.4;
    }

    function glowCap() {
      return new THREE.MeshBasicMaterial({ color: 0x35e6ff, transparent: true, opacity: 0.75 });
    }
  }

  _buildDecor() {
    // «Звёздное» поле над ареной — дешёвая глубина кадра через Points.
    const N = this.profile.particles > 400 ? 420 : 180;
    const pos = new Float32Array(N * 3);
    for (let i = 0; i < N; i++) {
      const r = rand(ARENA * 0.6, ARENA * 2.4);
      const a = rand(0, TAU);
      pos[i * 3] = Math.cos(a) * r;
      pos[i * 3 + 1] = rand(12, 68);
      pos[i * 3 + 2] = Math.sin(a) * r;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    const mat = new THREE.PointsMaterial({
      color: 0x8fc6ff,
      size: 0.42,
      sizeAttenuation: true,
      transparent: true,
      opacity: 0.75,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const stars = new THREE.Points(geo, mat);
    stars.frustumCulled = false;
    this.scene.add(stars);
    this._stars = stars;

    // Мерцающие маячки по периметру — ориентир, что стена близко.
    const beaconCount = randInt(10, 14);
    const bGeo = new THREE.SphereGeometry(0.22, 8, 6);
    const bMat = new THREE.MeshBasicMaterial({ color: 0xff3ea5 });
    this._beacons = [];
    for (let i = 0; i < beaconCount; i++) {
      const a = (i / beaconCount) * TAU;
      const m = new THREE.Mesh(bGeo, bMat.clone());
      m.position.set(Math.cos(a) * (ARENA - 0.6), 1.1, Math.sin(a) * (ARENA - 0.6));
      this.scene.add(m);
      this._beacons.push({ mesh: m, phase: rand(0, TAU) });
    }
  }

  /** Коллизия точки с препятствиями: выталкиваем наружу. */
  resolveObstacles(entity) {
    for (const o of this.obstacles) {
      const dx = entity.x - o.x;
      const dz = entity.z - o.z;
      const rr = o.r + entity.r;
      const d2 = dx * dx + dz * dz;
      if (d2 >= rr * rr || d2 === 0) continue;
      const d = Math.sqrt(d2);
      const push = (rr - d) / d;
      entity.x += dx * push;
      entity.z += dz * push;
    }
  }

  /** Спавн-точка на краю арены, вне поля зрения камеры и вне препятствий. */
  edgeSpawnPoint(playerX, playerZ, minDistFromPlayer = 22) {
    for (let attempt = 0; attempt < 24; attempt++) {
      const a = rand(0, TAU);
      const r = rand(ARENA * 0.72, ARENA * 0.95);
      const x = Math.cos(a) * r;
      const z = Math.sin(a) * r;
      const dp = Math.hypot(x - playerX, z - playerZ);
      if (dp < minDistFromPlayer) continue;
      let blocked = false;
      for (const o of this.obstacles) {
        if (Math.hypot(x - o.x, z - o.z) < o.r + 2.2) {
          blocked = true;
          break;
        }
      }
      if (!blocked) return { x, z };
    }
    // Запасной вариант — всегда валидная точка у дальней стены.
    const a = rand(0, TAU);
    return { x: Math.cos(a) * ARENA * 0.9, z: Math.sin(a) * ARENA * 0.9 };
  }

  update(dt, time) {
    for (const a of this._animated) {
      a.mesh.rotation.y += a.spin * dt;
      a.mesh.rotation.x += a.spin * 0.42 * dt;
      a.mesh.position.y = a.baseY + Math.sin(time * a.bob + a.phase) * 0.42;
    }
    if (this._stars) this._stars.rotation.y += dt * 0.006;
    for (const b of this._beacons) {
      const k = 0.45 + 0.55 * Math.abs(Math.sin(time * 1.4 + b.phase));
      b.mesh.material.opacity = k;
      b.mesh.material.transparent = true;
      b.mesh.scale.setScalar(0.8 + k * 0.4);
    }
  }
}
