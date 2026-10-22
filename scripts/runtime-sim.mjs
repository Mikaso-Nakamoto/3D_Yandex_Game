/**
 * Headless-симуляция настоящего игрового цикла.
 *
 * Браузера в песочнице нет, а аудит ссылок проверяет только имена полей —
 * он не ловит ошибки исполнения (undefined в рантайме, NaN в координатах,
 * утечки пулов, бесконечные циклы). Этот скрипт запускает РЕАЛЬНЫЙ Game
 * на 30+ секунд игрового времени и проверяет инварианты каждый кадр.
 *
 * Настоящее: THREE.Scene, камера, арена, игрок, враги, снаряды, пикапы,
 *           оружие, волны, перки, эффекты, пространственная сетка, пулы.
 * Подставное: DOM, Canvas2D (процедурная текстура пола), WebGL-рендерер,
 *             WebAudio (в Node его нет — игра обязана работать молча),
 *             requestAnimationFrame (кадры ведём вручную, детерминированно).
 *
 * Запуск: npm run sim
 */

import * as THREE from 'three';

/* ==================== 1. Стабы браузерного окружения ==================== */

const VOID_TAGS = new Set(['br', 'img', 'input', 'hr', 'meta', 'link', 'source']);

class FakeClassList {
  constructor(el) {
    this.el = el;
  }
  get _set() {
    return new Set((this.el.className || '').split(/\s+/).filter(Boolean));
  }
  _write(s) {
    this.el.className = [...s].join(' ');
  }
  add(...names) {
    const s = this._set;
    for (const n of names) s.add(n);
    this._write(s);
  }
  remove(...names) {
    const s = this._set;
    for (const n of names) s.delete(n);
    this._write(s);
  }
  toggle(name, force) {
    const s = this._set;
    const on = force === undefined ? !s.has(name) : !!force;
    if (on) s.add(name);
    else s.delete(name);
    this._write(s);
    return on;
  }
  contains(name) {
    return this._set.has(name);
  }
}

class FakeElement {
  constructor(tag = 'div') {
    this.tagName = String(tag).toUpperCase();
    this._tag = String(tag).toLowerCase();
    this.className = '';
    this.classList = new FakeClassList(this);
    this.style = { setProperty() {}, removeProperty() {} };
    this.children = [];
    this.childNodes = this.children;
    this.dataset = {};
    this._attrs = {};
    this._listeners = {};
    this._text = '';
    this._html = '';
    this.parentElement = null;
    this.offsetWidth = 100;
    this.offsetHeight = 20;
    this.clientWidth = 1280;
    this.clientHeight = 720;
    // canvas
    this.width = 300;
    this.height = 150;
  }

  get textContent() {
    return this._text || this.children.map((c) => c.textContent).join('');
  }
  set textContent(v) {
    this._text = String(v ?? '');
    this.children.length = 0;
  }

  get innerHTML() {
    return this._html;
  }
  set innerHTML(v) {
    this._html = String(v ?? '');
    this.children.length = 0;
    parseInto(this, this._html);
  }

  appendChild(c) {
    if (!c) return c;
    c.parentElement = this;
    this.children.push(c);
    return c;
  }
  append(...cs) {
    for (const c of cs) this.appendChild(c);
  }
  removeChild(c) {
    const i = this.children.indexOf(c);
    if (i >= 0) this.children.splice(i, 1);
    c.parentElement = null;
    return c;
  }
  remove() {
    this.parentElement?.removeChild(this);
  }
  insertBefore(c) {
    return this.appendChild(c);
  }

  setAttribute(k, v) {
    this._attrs[k] = String(v);
    if (k === 'class') this.className = String(v);
    if (k.startsWith('data-')) {
      const name = k.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      this.dataset[name] = String(v);
    }
  }
  getAttribute(k) {
    return this._attrs[k] ?? null;
  }
  hasAttribute(k) {
    return k in this._attrs;
  }

  addEventListener(type, fn) {
    (this._listeners[type] ||= []).push(fn);
  }
  removeEventListener(type, fn) {
    const l = this._listeners[type];
    if (!l) return;
    const i = l.indexOf(fn);
    if (i >= 0) l.splice(i, 1);
  }
  dispatchEvent(ev) {
    const l = this._listeners[ev.type] ?? [];
    for (const fn of l.slice()) fn.call(this, ev);
    return true;
  }
  click() {
    this.dispatchEvent({ type: 'click', target: this, preventDefault() {}, stopPropagation() {} });
  }
  focus() {}
  blur() {}

  getBoundingClientRect() {
    return { left: 0, top: 0, right: 1280, bottom: 720, width: 1280, height: 720, x: 0, y: 0 };
  }
  closest(sel) {
    let el = this;
    while (el) {
      if (matches(el, sel)) return el;
      el = el.parentElement;
    }
    return null;
  }
  querySelector(sel) {
    return this.querySelectorAll(sel)[0] ?? null;
  }
  querySelectorAll(sel) {
    const out = [];
    const walk = (el) => {
      for (const c of el.children) {
        if (matches(c, sel)) out.push(c);
        walk(c);
      }
    };
    walk(this);
    return out;
  }

  getContext(kind) {
    if (kind === '2d') return makeCtx2D(this);
    return null; // WebGL недоступен — на этом и построена подмена рендерера
  }
}

function matches(el, sel) {
  const s = String(sel).trim();
  const attr = s.match(/^\[([\w-]+)(?:="([^"]*)")?\]$/);
  if (attr) return el.getAttribute(attr[1]) !== null && (attr[2] === undefined || el.getAttribute(attr[1]) === attr[2]);
  if (s.startsWith('.')) return el.classList.contains(s.slice(1));
  if (s.startsWith('#')) return el.getAttribute('id') === s.slice(1);
  return el._tag === s.toLowerCase();
}

/** Минимальный парсер разметки: нужен, потому что HUD/Screens строят DOM через innerHTML. */
function parseInto(root, html) {
  const re = /<\/?([a-zA-Z][\w-]*)((?:\s+[\w:-]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)\s*(\/?)>/g;
  const stack = [root];
  let last = 0;
  let m;
  while ((m = re.exec(html)) !== null) {
    const text = html.slice(last, m.index);
    if (text.trim()) stack[stack.length - 1]._text += text;
    last = re.lastIndex;

    const closing = m[0][1] === '/';
    const tag = m[1].toLowerCase();
    if (closing) {
      if (stack.length > 1) stack.pop();
      continue;
    }
    const el = new FakeElement(tag);
    const attrRe = /([\w:-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
    let a;
    while ((a = attrRe.exec(m[2] || '')) !== null) {
      el.setAttribute(a[1], a[2] ?? a[3] ?? a[4] ?? '');
    }
    stack[stack.length - 1].appendChild(el);
    if (!VOID_TAGS.has(tag) && m[3] !== '/') stack.push(el);
  }
  const tail = html.slice(last);
  if (tail.trim()) stack[stack.length - 1]._text += tail;
}

function makeCtx2D(canvas) {
  const grad = { addColorStop() {} };
  return {
    canvas,
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
    globalAlpha: 1,
    font: '',
    textAlign: '',
    textBaseline: '',
    fillRect() {},
    clearRect() {},
    strokeRect() {},
    beginPath() {},
    closePath() {},
    moveTo() {},
    lineTo() {},
    arc() {},
    stroke() {},
    fill() {},
    fillText() {},
    save() {},
    restore() {},
    translate() {},
    rotate() {},
    scale() {},
    createRadialGradient: () => grad,
    createLinearGradient: () => grad,
    getImageData: (x, y, w, h) => ({ data: new Uint8ClampedArray(Math.max(1, w * h * 4)), width: w, height: h }),
    putImageData() {},
    drawImage() {},
  };
}

const fakeDocument = {
  createElement: (tag) => new FakeElement(tag),
  createElementNS: (_ns, tag) => new FakeElement(tag),
  createTextNode: (t) => ({ textContent: t }),
  body: new FakeElement('body'),
  head: new FakeElement('head'),
  documentElement: new FakeElement('html'),
  addEventListener() {},
  removeEventListener() {},
  querySelector: () => null,
  getElementById: () => null,
  hidden: false,
};

const listeners = {};
const fakeWindow = {
  innerWidth: 1280,
  innerHeight: 720,
  devicePixelRatio: 2,
  screen: { width: 1920, height: 1080 },
  document: fakeDocument,
  navigator: { maxTouchPoints: 0, hardwareConcurrency: 8, deviceMemory: 8, userAgent: 'node-sim' },
  matchMedia: () => ({ matches: false, addEventListener() {}, addListener() {} }),
  addEventListener(type, fn) {
    (listeners[type] ||= []).push(fn);
  },
  removeEventListener(type, fn) {
    const l = listeners[type];
    if (!l) return;
    const i = l.indexOf(fn);
    if (i >= 0) l.splice(i, 1);
  },
  dispatchEvent() {
    return true;
  },
  requestAnimationFrame: () => 0,
  cancelAnimationFrame() {},
  AudioContext: undefined, // звука в Node нет — проверяем, что игра не падает
  localStorage: makeStorage(),
  performance: { now: () => Date.now() },
};

function makeStorage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
    clear: () => map.clear(),
  };
}

globalThis.window = fakeWindow;
globalThis.document = fakeDocument;
// В Node 22 navigator — геттер только для чтения, обычное присваивание падает.
Object.defineProperty(globalThis, 'navigator', {
  value: fakeWindow.navigator,
  configurable: true,
  writable: true,
});
globalThis.localStorage = fakeWindow.localStorage;
globalThis.requestAnimationFrame = (cb) => {
  rafCallback = cb;
  return 1;
};
globalThis.cancelAnimationFrame = () => {};
let rafCallback = null;

/* ==================== 2. Подмена WebGL-рендерера ==================== */

function createFakeRenderer(_canvas, profile) {
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(52, 1280 / 720, 0.5, 220);
  camera.position.set(0, 25, 18);
  camera.lookAt(0, 0, 0);
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld(true);

  let frames = 0;
  return {
    profile,
    scene,
    camera,
    get frames() {
      return frames;
    },
    render() {
      frames++;
      // Настоящий рендерер обновляет мировые матрицы; без этого
      // проекция всплывающих цифр урона считалась бы по устаревшей матрице.
      scene.updateMatrixWorld(true);
      camera.updateMatrixWorld(true);
    },
    disableBloom() {},
    downgradePixelRatio() {},
    resize() {},
    // Зеркалит Renderer._onResize: aspect и проекция — зона рендерера,
    // а FOV и геометрию кадра задаёт CameraRig._computeOffset().
    _onResize() {
      const w = fakeWindow.innerWidth;
      const h = fakeWindow.innerHeight;
      if (!w || !h) return;
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    },
    dispose() {},
  };
}

/* ==================== 3. Запуск настоящей игры ==================== */

const { Game } = await import('../src/game.js');
const { WebAdapter } = await import('../src/platform/web.js');
const { MAX_TIER, WEAPONS } = await import('../src/systems/weapons.js');

let failures = 0;
let checks = 0;
function ok(cond, label, extra = '') {
  checks++;
  if (!cond) {
    failures++;
    if (failures <= 25) console.log(`  ✗ ${label}${extra ? ` — ${extra}` : ''}`);
  }
}
function section(t) {
  console.log(`\n${t}\n${'─'.repeat(60)}`);
}

const canvas = new FakeElement('canvas');
const uiRoot = new FakeElement('div');
const fxLayer = new FakeElement('div');
const boot = new FakeElement('div');

const adapter = new WebAdapter();
let game;
try {
  game = new Game({ canvas, uiRoot, fxLayer, adapter, createRenderer: createFakeRenderer });
} catch (e) {
  console.log('\n✗ Game не сконструировался:', e.message);
  console.log(e.stack.split('\n').slice(0, 6).join('\n'));
  process.exit(1);
}

ok(game.scene instanceof THREE.Scene, 'создана настоящая THREE.Scene');
ok(game.camera instanceof THREE.PerspectiveCamera, 'создана настоящая камера');
ok(!!game.player && !!game.enemies && !!game.projectiles && !!game.pickups, 'все подсистемы созданы');

/* ---------- Прогон кадров ---------- */

const DT = 1 / 60;
let simTime = 0;
let frameNo = 0;
const violations = { nan: 0, outOfBounds: 0, poolOverflow: 0, particleOverflow: 0 };
let maxEnemiesSeen = 0;
let maxProjectilesSeen = 0;
let maxPickupsSeen = 0;
let maxParticlesSeen = 0;

let autoPerk = true;
let perkPicks = 0;

/**
 * Прогон кадров.
 *
 * Обязательная уступка event loop каждый кадр — не удобство теста, а точность:
 * в браузере между вызовами requestAnimationFrame стек освобождается и
 * микрозадачи выполняются. Именно так показывается экран перка после
 * `await adapter.interstitial()` в onWaveCleared(). Полностью синхронный
 * прогон эту стадию не дал бы выполнить никогда, и симуляция расходилась
 * бы с реальным поведением игры.
 */
async function step(seconds, onFrame) {
  const frames = Math.round(seconds / DT);
  for (let i = 0; i < frames; i++) {
    frameNo++;
    simTime += DT;
    onFrame?.(i);
    game._tick(simTime * 1000);

    await new Promise((r) => setImmediate(r));

    // Игрок не зависает на экране перка — берём первое предложение.
    if (autoPerk && game.state === 'perk') {
      const cards = game.screens.perkCards.children;
      if (cards.length) {
        cards[0].click();
        perkPicks++;
        await new Promise((r) => setImmediate(r));
      }
    }

    // Инварианты — каждый кадр, иначе баг найдётся только постфактум.
    const p = game.player;
    if (!Number.isFinite(p.x) || !Number.isFinite(p.z) || !Number.isFinite(p.hp)) violations.nan++;
    const half = game.arena.half;
    if (Math.abs(p.x) > half + 2 || Math.abs(p.z) > half + 2) violations.outOfBounds++;

    for (const e of game.enemies.live) {
      if (!Number.isFinite(e.x) || !Number.isFinite(e.z) || !Number.isFinite(e.hp)) violations.nan++;
      if (Math.abs(e.x) > half + 6 || Math.abs(e.z) > half + 6) violations.outOfBounds++;
    }
    for (const pr of game.projectiles.live) {
      if (!Number.isFinite(pr.x) || !Number.isFinite(pr.z)) violations.nan++;
    }

    if (game.enemies.live.length > game.enemies.max) violations.poolOverflow++;
    if (game.projectiles.live.length > game.projectiles.max) violations.poolOverflow++;
    if (game.pickups.live.length > game.pickups.max) violations.poolOverflow++;
    if (game.effects.particles.count > game.effects.particles.max) violations.particleOverflow++;

    maxEnemiesSeen = Math.max(maxEnemiesSeen, game.enemies.live.length);
    maxProjectilesSeen = Math.max(maxProjectilesSeen, game.projectiles.live.length);
    maxPickupsSeen = Math.max(maxPickupsSeen, game.pickups.live.length);
    maxParticlesSeen = Math.max(maxParticlesSeen, game.effects.particles.count);
  }
}

const flush = () => new Promise((r) => setImmediate(r));

/**
 * Возвращает игру в состояние PLAYING, из какого бы она ни была.
 * Нужно потому, что часть проверок (урон, пикапы, зачистка волны) имеет смысл
 * только во время боя: вне его game.damageEnemy/damagePlayer честно
 * игнорируются — и это правильное поведение, а не баг.
 */
async function ensurePlaying() {
  if (game.state === 'paused') game.resume();
  if (game.state === 'menu' || game.state === 'over') {
    await game.startRun();
    return;
  }
  if (game.state === 'perk') {
    const cards = game.screens.perkCards.children;
    if (cards.length) {
      cards[0].click();
      await flush();
    }
  }
}

/** Имитация ввода: игрок непрерывно двигается, как живой. */
function driveInput(dirX, dirZ) {
  game.input.keys.clear();
  if (dirX > 0) game.input.keys.add('KeyD');
  if (dirX < 0) game.input.keys.add('KeyA');
  if (dirZ > 0) game.input.keys.add('KeyS');
  if (dirZ < 0) game.input.keys.add('KeyW');
}

section('1. Запуск из меню');

game.start();
ok(typeof rafCallback === 'function', 'игровой цикл зарегистрирован через requestAnimationFrame');

await game.toMenu();
ok(game.state === 'menu', 'состояние menu после загрузки', game.state);
ok(game.screens.current === 'menu', 'экран меню показан', String(game.screens.current));
await step(1.0); // меню рендерится и камера облетает арену
ok(game.renderer.frames > 0, 'кадры отрисовываются в меню', `${game.renderer.frames}`);

section('2. Старт забега и бой (30 секунд)');

await game.startRun();
ok(game.state === 'playing', 'состояние playing после старта', game.state);
ok(game.weapons.slots.length === 1, 'стартовое оружие выдано', `${game.weapons.slots.length}`);
ok(game.waves.wave === 1, 'первая волна запущена', `${game.waves.wave}`);
ok(game.player.alive, 'игрок жив');

// Двигаем игрока непрерывно, как живой человек: работают коллизии, камера, магнит.
let t = 0;
await step(30, () => {
  t += DT;
  driveInput(Math.cos(t * 1.7), Math.sin(t * 2.3));
  // Раз в 3 секунды «поворачиваем телефон» — проверяем портрет и альбом.
  if (Math.abs(t % 3) < DT / 2) {
    const w = fakeWindow.innerWidth;
    fakeWindow.innerWidth = fakeWindow.innerHeight;
    fakeWindow.innerHeight = w;
    game.camera.aspect = fakeWindow.innerWidth / fakeWindow.innerHeight;
    game.camera.updateProjectionMatrix();
    game.effects.resize();
  }
});

ok(game.kills > 0, 'враги погибают от оружия', `фрагов ${game.kills}`);
ok(game.waves.wave >= 2, 'за 30 секунд прошла хотя бы одна волна', `волна ${game.waves.wave}`);
ok(perkPicks >= 1, 'экран перка открывался и принимал выбор', `${perkPicks}`);
ok(maxEnemiesSeen > 0, 'враги появлялись на арене', `максимум ${maxEnemiesSeen}`);
ok(maxProjectilesSeen > 0, 'снаряды создавались', `максимум ${maxProjectilesSeen}`);
ok(violations.nan === 0, 'нет NaN в координатах и HP', `${violations.nan}`);
ok(violations.outOfBounds === 0, 'никто не вышел за пределы арены', `${violations.outOfBounds}`);
ok(violations.poolOverflow === 0, 'пулы не переполняются', `${violations.poolOverflow}`);
ok(violations.particleOverflow === 0, 'пул частиц не переполняется', `${violations.particleOverflow}`);

console.log(`  кадров: ${frameNo}, врагов пик: ${maxEnemiesSeen}, снарядов пик: ${maxProjectilesSeen},`);
console.log(`  пикапов пик: ${maxPickupsSeen}, частиц пик: ${maxParticlesSeen}`);
console.log(`  фрагов: ${game.kills}, волна: ${game.waves.wave}, перков взято: ${perkPicks}`);

section('3. Слияние оружия');

// Слияние — ядро монетизации, проверяем его явно, а не «надеемся на дроп».
game.weapons.reset();
game.weapons.addWeapon(0, 1);
ok(game.weapons.slots.length === 1 && game.weapons.slots[0].tier === 1, 'первый куб занял слот 1-го тира');

const mergeResult = game.weapons.addWeapon(0, 1);
ok(mergeResult === 'merged', 'второй такой же куб дал слияние', String(mergeResult));
ok(game.weapons.slots[0].tier === 2, 'после слияния тир стал 2', `${game.weapons.slots[0].tier}`);
ok(game.weapons.slots.length === 1, 'слияние не занимает новый слот', `${game.weapons.slots.length}`);

// Потолок тира: дубликат оружия максимального тира не должен уходить выше.
game.weapons.reset();
const capFirst = game.weapons.addWeapon(0, MAX_TIER);
const capSecond = game.weapons.addWeapon(0, MAX_TIER);
ok(capFirst === 'added', 'оружие максимального тира занимает свободный слот', String(capFirst));
ok(capSecond === 'overflow', 'его дубликат отклоняется, а не повышает тир', String(capSecond));
ok(
  game.weapons.slots.every((s) => s.tier <= MAX_TIER && s.tier >= 1),
  'ни один слот не выходит за пределы 1..MAX_TIER',
  game.weapons.slots.map((s) => s.tier).join(','),
);
// Много мусорных кубов подряд не должны ни сломать инвентарь, ни размножить слоты.
for (let i = 0; i < 40; i++) game.weapons.addWeapon(i % WEAPONS.length, 1 + (i % MAX_TIER));
ok(game.weapons.slots.length <= game.weapons.slotCount, 'число слотов не превышает лимит', `${game.weapons.slots.length}`);
ok(
  game.weapons.slots.every((s) => s.tier <= MAX_TIER),
  'после 40 добавлений тир всё ещё в допустимых пределах',
);

// Переполнение: полные слоты максимального тира отклоняют слабый куб.
game.weapons.reset();
for (let i = 0; i < game.weapons.slotCount; i++) game.weapons.addWeapon(i % WEAPONS.length, MAX_TIER);
const overflow = game.weapons.addWeapon(game.weapons.slotCount % WEAPONS.length, 1);
ok(overflow === 'overflow', 'слабый куб при полных слотах отклоняется', String(overflow));
ok(game.weapons.slots.length === game.weapons.slotCount, 'число слотов не превышает лимит', `${game.weapons.slots.length}`);

await step(2);
ok(violations.nan === 0, 'нет NaN после манипуляций с оружием');

section('4. Пикапы');

// Пикапы проверяем по идентичности объекта, а не по количеству в пуле:
// во время прогона враги продолжают ронять собственный лут.
// Проверяем по факту вызова collectPickup, а не по идентичности объекта:
// пул переиспользует освобождённые объекты, поэтому ссылка на «наш» пикап
// за секунду прогона успевает превратиться в чужой дроп с убитого врага
// и снова стать alive. Такая проверка в пулируемой системе ненадёжна.
const collected = [];
const realCollect = game.collectPickup.bind(game);
game.collectPickup = (p) => {
  collected.push(p.kind);
  return realCollect(p);
};

for (const kind of ['coin', 'health', 'magnet', 'nuke', 'weapon']) {
  await ensurePlaying();
  // Обязательно отпускаем ввод: в секции боя клавиши остаются зажатыми,
  // и игрок бежит (9.2 ед/с) быстрее, чем магнит тянет пикап (радиус 4.2).
  game.input.releaseAll();
  game.pickups.clear();
  collected.length = 0;

  const px = game.player.x;
  const pz = game.player.z;
  game.player.hp = Math.min(game.player.hp, game.player.maxHp * 0.6); // аптечке нужно что-то лечить
  const pk = game.pickups.spawn({
    kind, x: px, z: pz, weaponType: 2, tier: 2, value: 12,
  });
  ok(!!pk, `пикап «${kind}» создан`);
  await step(1.0);

  const drifted = Math.hypot(game.player.x - px, game.player.z - pz);
  ok(drifted < 1.5, `игрок стоит на месте во время проверки «${kind}»`, `смещение ${drifted.toFixed(2)}`);
  ok(collected.includes(kind), `пикап «${kind}» подобран у ног игрока`, `собрано: ${collected.join(',') || 'ничего'}`);
}

game.collectPickup = realCollect;

ok(game.coins > 0, 'монеты зачисляются', `${game.coins}`);
ok(game.magnetBoost.t > 0, 'магнит активируется и имеет длительность', `${game.magnetBoost.t.toFixed(1)} c`);
ok(Number.isFinite(game.player.hp) && game.player.hp > 0, 'игрок пережил все пикапы', game.player.hp.toFixed(0));
ok(violations.nan === 0, 'нет NaN после пикапов');

section('5. Перк между волнами');

autoPerk = false; // наблюдаем экран, а не прокликаем его автоматически
await ensurePlaying();
const perksBefore = game.perksTaken;

// Зачищаем волну: очередь помечаем отспавненной и убиваем всех врагов.
game.waves.queue.length = game.waves.spawned;
for (const e of [...game.enemies.live]) game.damageEnemy(e, 1e6, {});
await step(0.6);

ok(game.state === 'perk', 'после зачистки волны открывается выбор перка', game.state);
const cards = game.screens.perkCards.children;
ok(cards.length >= 1 && cards.length <= 3, 'предложено 1–3 перка', `${cards.length}`);

// На экране перка бой обязан стоять: иначе игрока убьют, пока он читает описание.
const frozenEnemies = game.enemies.live.length;
const frozenKills = game.kills;
await step(1.2);
ok(
  game.enemies.live.length === frozenEnemies && game.kills === frozenKills,
  'на экране перка бой заморожен',
);

if (cards.length) {
  cards[0].click();
  await flush();
}
ok(game.state === 'playing', 'после выбора перка игра продолжается', game.state);
ok(game.perksTaken === perksBefore + 1, 'перк засчитан', `${perksBefore} → ${game.perksTaken}`);
ok(game.waves.wave > 1, 'запущена следующая волна', `${game.waves.wave}`);

autoPerk = true;
await step(3);
ok(violations.nan === 0, 'нет NaN после выбора перка');

section('6. Пауза и возврат со вкладки');

await ensurePlaying();
game.pause();
ok(game.state === 'paused', 'пауза включается', game.state);
ok(game.screens.current === 'pause', 'показан экран паузы', String(game.screens.current));

const killsAtPause = game.kills;
const enemiesAtPause = game.enemies.live.length;
const timeAtPause = game.elapsed;
await step(2);
ok(game.kills === killsAtPause, 'на паузе фраги не начисляются');
ok(game.enemies.live.length === enemiesAtPause, 'на паузе враги не спавнятся');
ok(game.elapsed === timeAtPause, 'на паузе таймер забега стоит', `${timeAtPause.toFixed(2)} → ${game.elapsed.toFixed(2)}`);

game.resume();
ok(game.state === 'playing', 'пауза снимается', game.state);
await step(1);
ok(game.elapsed > timeAtPause, 'после возобновления таймер снова идёт');

// Уход со вкладки: пауза ставится, но НЕ снимается автоматически —
// иначе вернувшегося игрока сразу бросает обратно в бой.
game.externalPause();
ok(game.state === 'paused', 'уход со вкладки ставит игру на паузу', game.state);
game.externalResume();
ok(game.state === 'paused', 'возврат на вкладку не снимает паузу сам', game.state);
await ensurePlaying();

section('7. Смерть игрока и рекорд');

await ensurePlaying();
const waveAtDeath = game.waves.wave;
game.player.hp = 1;
game.damagePlayer(9999);
await flush();
await flush();

ok(game.state === 'over', 'после смертельного урона — экран итогов', game.state);
ok(!game.player.alive, 'игрок помечен мёртвым');
ok(game.screens.current === 'over', 'показан экран итогов', String(game.screens.current));
ok(game.screens.overGrid.children.length === 6, 'в итогах шесть строк статистики', `${game.screens.overGrid.children.length}`);
ok(game.best.wave >= waveAtDeath, 'рекорд сохранён', JSON.stringify(game.best));

// Повторный смертельный урон по уже мёртвому игроку не должен ничего сломать.
game.damagePlayer(9999);
await flush();
await step(1.5);
ok(violations.nan === 0, 'нет NaN после смерти');

section('8. Повторный забег (переиспользование пулов)');

const enemiesBefore = game.enemies.pool.count;
await game.startRun();
ok(game.state === 'playing', 'второй забег стартует', game.state);
ok(game.enemies.aliveCount === 0, 'арена очищена перед новым забегом', `${game.enemies.aliveCount}`);
ok(game.projectiles.live.length === 0, 'снаряды очищены', `${game.projectiles.live.length}`);
ok(game.pickups.live.length === 0, 'пикапы очищены', `${game.pickups.live.length}`);
ok(game.kills === 0 && game.coins === 0, 'счётчики забега обнулены');
ok(game.waves.wave === 1, 'волны начаты заново', `${game.waves.wave}`);

await step(25, () => {
  t += DT;
  driveInput(Math.sin(t * 2.1), Math.cos(t * 1.3));
});

ok(game.kills > 0, 'второй забег тоже играбелен', `фрагов ${game.kills}`);
ok(violations.nan === 0, 'нет NaN во втором забеге', `${violations.nan}`);
ok(violations.poolOverflow === 0, 'пулы не протекают между забегами', `${violations.poolOverflow}`);
ok(game.enemies.pool.count <= Math.max(enemiesBefore, game.enemies.max), 'пул врагов не растёт бесконечно', `${game.enemies.pool.count}`);

section('9. Деградация качества на слабом устройстве');

game._downgrade();
await step(2);
ok(violations.nan === 0, 'после снижения качества игра работает');
ok(game.enemies.max >= 40, 'потолок врагов не обрушен в ноль', `${game.enemies.max}`);

section('10. Возврат в меню');

await game.toMenu();
ok(game.state === 'menu', 'возврат в меню', game.state);
ok(game.enemies.aliveCount === 0, 'в меню арена пуста');
await step(2);
ok(violations.nan === 0, 'нет NaN в меню');

section('11. Композиция кадра (математика проекции)');

/**
 * Реальная проверка того, что игрок видит арену, а не её угол.
 *
 * Проекция считается настоящей математикой three.js — WebGL для этого не
 * нужен. Главный риск здесь игровой, а не технический: враги спавнятся
 * в 20–22 единицах от игрока (arena.edgeSpawnPoint), и если видимый радиус
 * меньше, игрок получает урон «из ниоткуда». Несправедливые смерти —
 * самая частая причина низкого retention в survivor-играх.
 */

const _projV = new THREE.Vector3();

function ndcOf(x, y, z) {
  _projV.set(x, y, z).project(game.camera);
  return { x: _projV.x, y: _projV.y, z: _projV.z };
}

function onScreen(p) {
  return p.x >= -1 && p.x <= 1 && p.y >= -1 && p.y <= 1 && p.z < 1;
}

/** Максимальная дистанция по земле от игрока, ещё попадающая в кадр, по 8 направлениям. */
function measureVisibleRadius(px, pz) {
  const dirs = [];
  for (let i = 0; i < 8; i++) dirs.push((i / 8) * Math.PI * 2);
  const perDir = dirs.map((a) => {
    const dx = Math.cos(a);
    const dz = Math.sin(a);
    let lastVisible = 0;
    // Шагаем наружу с шагом 0.5 и запоминаем последнюю видимую точку.
    for (let d = 0; d <= 60; d += 0.5) {
      const p = ndcOf(px + dx * d, 0.9, pz + dz * d);
      if (onScreen(p)) lastVisible = d;
    }
    return { angle: a, radius: lastVisible };
  });
  return {
    perDir,
    min: Math.min(...perDir.map((d) => d.radius)),
    max: Math.max(...perDir.map((d) => d.radius)),
  };
}

const VIEWPORTS = [
  ['десктоп 1920×1080', 1920, 1080],
  ['ноутбук 1440×900', 1440, 900],
  ['ультраширокий 2560×1080', 2560, 1080],
  ['планшет 820×1180', 820, 1180],
  ['телефон портрет 390×844', 390, 844],
  ['телефон альбом 844×390', 844, 390],
];

// SPAWN_DIST должен совпадать с минимальной дистанцией в arena.edgeSpawnPoint.
const SPAWN_DIST = 20;
const REACTION_MIN = 13.0; // ≈1.0 c реакции при скорости бегуна 13.8 ед/с

console.log('  экран                     | игрок NDC     | видимый радиус (мин/макс) | реакция');
for (const [label, w, h] of VIEWPORTS) {
  fakeWindow.innerWidth = w;
  fakeWindow.innerHeight = h;
  // Идём настоящим путём ресайза. Задавать FOV вручную здесь нельзя:
  // иначе тест замаскировал бы расхождение между Renderer и CameraRig,
  // которые оба претендовали на владение композицией кадра.
  game.renderer._onResize();

  // Ставим игрока в типичную позицию и обновляем настоящим ригом камеры.
  game.player.x = 4;
  game.player.z = -3;
  game.cameraRig.snap(game.player); // сошедшаяся позиция, без переходного damp()
  game.camera.updateMatrixWorld(true);

  ok(
    game.camera.fov === (w / h < 1 ? 66 : 50),
    `${label}: FOV выставлен CameraRig (портрет 66 / альбом 50)`,
    `fov ${game.camera.fov}`,
  );

  const me = ndcOf(game.player.x, 1.0, game.player.z);
  const vis = measureVisibleRadius(game.player.x, game.player.z);

  ok(onScreen(me), `${label}: игрок в кадре`, `NDC ${me.x.toFixed(2)},${me.y.toFixed(2)}`);
  ok(Math.abs(me.x) < 0.62, `${label}: игрок не прижат к краю по X`, me.x.toFixed(2));
  ok(Math.abs(me.y) < 0.86, `${label}: игрок не прижат к краю по Y`, me.y.toFixed(2));
  ok(game.camera.position.y > 2, `${label}: камера не уходит под землю`, game.camera.position.y.toFixed(1));

  ok(
    vis.min >= REACTION_MIN,
    `${label}: видно минимум ${REACTION_MIN} ед. во все стороны (реакция на спавн в ${SPAWN_DIST})`,
    `мин ${vis.min.toFixed(1)}`,
  );
  ok(vis.max <= 200, `${label}: дальность обзора конечна`, vis.max.toFixed(1));

  console.log(
    `  ${label.padEnd(27)} | ${me.x.toFixed(2)},${me.y.toFixed(2)}      | ` +
      `${vis.min.toFixed(1).padStart(5)} / ${vis.max.toFixed(1).padStart(5)}          | ` +
      `${vis.min >= SPAWN_DIST ? 'спавн виден' : `спавн за кадром, видно ${vis.min.toFixed(0)} ед.`}`,
  );
  console.log(`      по направлениям: ${vis.perDir.map((d) => d.radius.toFixed(0)).join(' ')}`);
}

// Враг на дистанции спавна должен быть виден хотя бы в портрете и альбоме,
// иначе игрок реагирует только на уже подошедшего противника.
for (const [label, w, h] of VIEWPORTS) {
  fakeWindow.innerWidth = w;
  fakeWindow.innerHeight = h;
  game.renderer._onResize();
  game.player.x = 0;
  game.player.z = 0;
  game.cameraRig.snap(game.player); // сошедшаяся позиция, без переходного damp()
  game.camera.updateMatrixWorld(true);

  const foe = ndcOf(0, 1.2, -SPAWN_DIST); // враг впереди на дистанции спавна
  const foeBehind = ndcOf(0, 1.2, SPAWN_DIST); // враг позади
  ok(onScreen(foe) || onScreen(foeBehind), `${label}: хотя бы один враг на дистанции спавна виден`);
}

// Возвращаем рабочий viewport.
fakeWindow.innerWidth = 1280;
fakeWindow.innerHeight = 720;
game.renderer._onResize();
game.cameraRig.snap(game.player);

/* ==================== Итог ==================== */

console.log('\n' + '═'.repeat(60));
console.log(`  Кадров симуляции:      ${frameNo} (${(simTime).toFixed(1)} c игрового времени)`);
console.log(`  Отрисовано кадров:     ${game.renderer.frames}`);
console.log(`  Пик врагов/снарядов:   ${maxEnemiesSeen} / ${maxProjectilesSeen}`);
console.log(`  Пик пикапов/частиц:    ${maxPickupsSeen} / ${maxParticlesSeen}`);
console.log('═'.repeat(60));
if (failures === 0) console.log(`  ✓ Игровой цикл отработал без ошибок (${checks} проверок)`);
else console.log(`  ✗ Провалено ${failures} из ${checks}`);
console.log('═'.repeat(60) + '\n');

process.exit(failures === 0 ? 0 : 1);
