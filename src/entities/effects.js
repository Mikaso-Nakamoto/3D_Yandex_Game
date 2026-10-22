import * as THREE from 'three';

/**
 * Визуальная обратная связь: частицы, всплывающие цифры урона, тряска камеры.
 *
 * Частицы — один THREE.Points с пулом в BufferGeometry: никаких аллокаций в рантайме,
 * это самый дешёвый способ получить «сочно» на мобильном вебе.
 *
 * Цифры урона — DOM-элементы с проекцией из 3D. Так они остаются crisp на любом DPI
 * и не требуют атласа шрифта в архиве (размер сборки для Яндекс Игр критичен).
 */

const _v = new THREE.Vector3();
const _color = new THREE.Color();

export class Particles {
  constructor(scene, max) {
    this.max = max;
    this.count = 0;

    this.px = new Float32Array(max);
    this.py = new Float32Array(max);
    this.pz = new Float32Array(max);
    this.vx = new Float32Array(max);
    this.vy = new Float32Array(max);
    this.vz = new Float32Array(max);
    this.life = new Float32Array(max);
    this.maxLife = new Float32Array(max);
    this.cr = new Float32Array(max);
    this.cg = new Float32Array(max);
    this.cb = new Float32Array(max);
    this.grav = new Float32Array(max);
    this.drag = new Float32Array(max);

    this.positions = new Float32Array(max * 3);
    this.colors = new Float32Array(max * 3);

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.positions, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(this.colors, 3));
    geo.setDrawRange(0, 0);

    const mat = new THREE.PointsMaterial({
      size: 0.34,
      sizeAttenuation: true,
      vertexColors: true,
      transparent: true,
      opacity: 1,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });

    this.points = new THREE.Points(geo, mat);
    this.points.frustumCulled = false;
    this.geo = geo;
    scene.add(this.points);
  }

  emit(x, y, z, colorHex, count, opts = {}) {
    const {
      speed = 8,
      spread = 1,
      life = 0.5,
      lifeVar = 0.25,
      up = 2.5,
      gravity = 9,
      drag = 2.2,
      dirX = 0,
      dirZ = 0,
      dirBias = 0,
    } = opts;

    _color.setHex(colorHex);
    const r = _color.r, g = _color.g, b = _color.b;

    for (let n = 0; n < count; n++) {
      if (this.count >= this.max) return;
      const i = this.count++;

      const a = Math.random() * Math.PI * 2;
      const rr = Math.random() * spread;
      let dx = Math.cos(a) * rr;
      let dz = Math.sin(a) * rr;
      if (dirBias > 0) {
        dx = dx * (1 - dirBias) + dirX * dirBias;
        dz = dz * (1 - dirBias) + dirZ * dirBias;
      }
      const sp = speed * (0.45 + Math.random() * 0.8);

      this.px[i] = x;
      this.py[i] = y;
      this.pz[i] = z;
      this.vx[i] = dx * sp;
      this.vy[i] = up * (0.35 + Math.random());
      this.vz[i] = dz * sp;
      const l = life * (1 + (Math.random() - 0.5) * lifeVar * 2);
      this.life[i] = l;
      this.maxLife[i] = l;
      this.cr[i] = r;
      this.cg[i] = g;
      this.cb[i] = b;
      this.grav[i] = gravity;
      this.drag[i] = drag;
    }
  }

  /** Кольцевая ударная волна — для взрывов и слияний оружия. */
  ring(x, y, z, colorHex, count = 26, radius = 5, life = 0.42) {
    _color.setHex(colorHex);
    const r = _color.r, g = _color.g, b = _color.b;
    for (let n = 0; n < count; n++) {
      if (this.count >= this.max) return;
      const i = this.count++;
      const a = (n / count) * Math.PI * 2;
      const sp = radius / Math.max(0.05, life);
      this.px[i] = x;
      this.py[i] = y;
      this.pz[i] = z;
      this.vx[i] = Math.cos(a) * sp;
      this.vy[i] = 0.4;
      this.vz[i] = Math.sin(a) * sp;
      this.life[i] = life;
      this.maxLife[i] = life;
      this.cr[i] = r;
      this.cg[i] = g;
      this.cb[i] = b;
      this.grav[i] = 0;
      this.drag[i] = 1.2;
    }
  }

  update(dt) {
    let write = 0;
    const pos = this.positions;
    const col = this.colors;

    for (let i = 0; i < this.count; i++) {
      this.life[i] -= dt;
      if (this.life[i] <= 0) continue;

      const d = Math.max(0, 1 - this.drag[i] * dt);
      this.vx[i] *= d;
      this.vz[i] *= d;
      this.vy[i] = this.vy[i] * d - this.grav[i] * dt;

      this.px[i] += this.vx[i] * dt;
      this.py[i] += this.vy[i] * dt;
      this.pz[i] += this.vz[i] * dt;
      if (this.py[i] < 0.06) {
        this.py[i] = 0.06;
        this.vy[i] *= -0.32;
        this.vx[i] *= 0.7;
        this.vz[i] *= 0.7;
      }

      // Компактизация: живые частицы сдвигаются в начало массива.
      if (write !== i) {
        this.px[write] = this.px[i]; this.py[write] = this.py[i]; this.pz[write] = this.pz[i];
        this.vx[write] = this.vx[i]; this.vy[write] = this.vy[i]; this.vz[write] = this.vz[i];
        this.life[write] = this.life[i]; this.maxLife[write] = this.maxLife[i];
        this.cr[write] = this.cr[i]; this.cg[write] = this.cg[i]; this.cb[write] = this.cb[i];
        this.grav[write] = this.grav[i]; this.drag[write] = this.drag[i];
      }

      const k = this.life[write] / this.maxLife[write];
      const fade = k * k;
      pos[write * 3] = this.px[write];
      pos[write * 3 + 1] = this.py[write];
      pos[write * 3 + 2] = this.pz[write];
      col[write * 3] = this.cr[write] * fade;
      col[write * 3 + 1] = this.cg[write] * fade;
      col[write * 3 + 2] = this.cb[write] * fade;
      write++;
    }

    this.count = write;
    this.geo.setDrawRange(0, write);
    this.geo.attributes.position.needsUpdate = true;
    this.geo.attributes.color.needsUpdate = true;
  }

  clear() {
    this.count = 0;
    this.geo.setDrawRange(0, 0);
  }
}

/** Всплывающие цифры урона поверх canvas'а. */
export class FloatTexts {
  constructor(layer, max = 26) {
    this.layer = layer;
    this.max = max;
    this.items = [];
    for (let i = 0; i < max; i++) {
      const el = document.createElement('div');
      el.className = 'float-num';
      el.style.display = 'none';
      layer.appendChild(el);
      this.items.push({ el, life: 0, maxLife: 1, x: 0, y: 0, z: 0, vy: 0, active: false });
    }
    this.w = window.innerWidth;
    this.h = window.innerHeight;
  }

  resize() {
    this.w = window.innerWidth;
    this.h = window.innerHeight;
  }

  spawn(x, y, z, text, { color = '#ffffff', crit = false, life = 0.72 } = {}) {
    let slot = null;
    for (const it of this.items) {
      if (!it.active) { slot = it; break; }
    }
    if (!slot) slot = this.items[0]; // перезаписываем самый старый

    slot.active = true;
    slot.life = life;
    slot.maxLife = life;
    slot.x = x + (Math.random() - 0.5) * 0.9;
    slot.y = y;
    slot.z = z + (Math.random() - 0.5) * 0.9;
    slot.vy = 4.2 + Math.random() * 1.6;

    const el = slot.el;
    el.textContent = text;
    el.style.color = color;
    el.style.display = 'block';
    el.classList.toggle('crit', crit);
  }

  update(dt, camera) {
    const hw = this.w * 0.5;
    const hh = this.h * 0.5;
    for (const it of this.items) {
      if (!it.active) continue;
      it.life -= dt;
      if (it.life <= 0) {
        it.active = false;
        it.el.style.display = 'none';
        continue;
      }
      it.y += it.vy * dt;
      it.vy -= 5.5 * dt;

      _v.set(it.x, it.y, it.z).project(camera);
      if (_v.z > 1) {
        it.el.style.display = 'none';
        continue;
      }
      it.el.style.display = 'block';
      const sx = (_v.x * hw) + hw;
      const sy = (-_v.y * hh) + hh;
      const k = it.life / it.maxLife;
      it.el.style.transform = `translate(-50%,-50%) translate(${sx.toFixed(1)}px,${sy.toFixed(1)}px) scale(${(0.72 + k * 0.42).toFixed(3)})`;
      it.el.style.opacity = Math.min(1, k * 2.1).toFixed(3);
    }
  }

  clear() {
    for (const it of this.items) {
      it.active = false;
      it.life = 0;
      it.el.style.display = 'none';
    }
  }
}

/** Тряска камеры: затухающий шум. */
export class Shake {
  constructor() {
    this.amount = 0;
    this.decay = 6.5;
  }
  add(v) {
    this.amount = Math.min(1.6, this.amount + v);
  }
  update(dt) {
    if (this.amount <= 0) return 0;
    this.amount = Math.max(0, this.amount - this.decay * dt * this.amount - 0.35 * dt);
    return this.amount;
  }
  get offset() {
    return this.amount;
  }
}

/** Обёртка над всеми эффектами, чтобы game.js дёргал один объект. */
export class Effects {
  constructor(scene, layer, camera, profile) {
    this.particles = new Particles(scene, profile.particles);
    this.texts = new FloatTexts(layer, 26);
    this.shake = new Shake();
    this.camera = camera;
    this._hurt = null;
    this._heal = null;
    this._buildVignettes(layer);
  }

  _buildVignettes(layer) {
    this._hurt = document.createElement('div');
    this._hurt.className = 'vignette hurt';
    this._heal = document.createElement('div');
    this._heal.className = 'vignette heal';
    layer.appendChild(this._hurt);
    layer.appendChild(this._heal);
  }

  _pulse(el) {
    el.classList.remove('show');
    // Перезапуск CSS-анимации.
    void el.offsetWidth;
    el.classList.add('show');
  }

  hurtFlash() { this._pulse(this._hurt); }
  healFlash() { this._pulse(this._heal); }

  spark(x, y, z, color, count = 7) {
    this.particles.emit(x, y, z, color, count, { speed: 7, life: 0.32, up: 1.6, gravity: 7, spread: 1 });
  }

  muzzle(x, y, z, color) {
    this.particles.emit(x, y, z, color, 3, { speed: 4.5, life: 0.16, up: 0.3, gravity: 0, spread: 0.7 });
  }

  death(x, y, z, color, big = false) {
    this.particles.emit(x, y, z, color, big ? 40 : 16, {
      speed: big ? 15 : 9, life: big ? 0.75 : 0.5, up: big ? 5 : 3, gravity: 12, spread: 1,
    });
    if (big) this.particles.ring(x, 0.4, z, color, 34, 9, 0.5);
  }

  explosion(x, z, radius, color) {
    this.particles.emit(x, 1.0, z, color, 34, { speed: radius * 3.2, life: 0.55, up: 3.5, gravity: 8, spread: 1 });
    this.particles.emit(x, 1.0, z, 0xffffff, 10, { speed: radius * 1.6, life: 0.3, up: 2, gravity: 4, spread: 1 });
    this.particles.ring(x, 0.35, z, color, 30, radius * 1.5, 0.4);
    this.shake.add(Math.min(0.55, radius * 0.08));
  }

  merge(x, y, z, color) {
    this.particles.ring(x, y, z, color, 30, 5.2, 0.5);
    this.particles.emit(x, y, z, 0xffffff, 16, { speed: 8, life: 0.55, up: 4, gravity: 3, spread: 1 });
    this.shake.add(0.16);
  }

  levelUp(x, y, z) {
    this.particles.ring(x, y, z, 0x35e6ff, 44, 8, 0.7);
    this.particles.emit(x, y, z, 0x7dff5e, 26, { speed: 10, life: 0.8, up: 6, gravity: 4, spread: 1 });
  }

  damage(x, y, z, amount, crit) {
    this.texts.spawn(x, y, z, String(Math.round(amount)), {
      color: crit ? '#ffc23d' : '#ffffff',
      crit,
    });
  }

  text(x, y, z, str, color) {
    this.texts.spawn(x, y, z, str, { color, crit: false, life: 0.95 });
  }

  update(dt) {
    this.particles.update(dt);
    this.texts.update(dt, this.camera);
  }

  resize() {
    this.texts.resize();
  }

  clear() {
    this.particles.clear();
    this.texts.clear();
  }
}
