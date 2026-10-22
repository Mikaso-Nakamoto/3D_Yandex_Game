/**
 * Аудит перекрёстных ссылок между модулями.
 *
 * В песочнице нет браузера, поэтому рантайм-ошибки вида
 * «game.something is not a function» глазами не увидеть. Самый частый класс
 * багов в такой архитектуре — опечатка в обращении к хабу (Game) из сущностей
 * и систем. Скрипт собирает всё, что Game реально предоставляет
 * (свойства из конструктора/_init + методы класса), и сверяет с тем,
 * к чему обращаются другие модули.
 *
 * Ложные срабатывания отсечены явно:
 *   - имена файлов в импортах и комментариях (game.js → «свойство js»);
 *   - одноимённые локальные поля внутри модуля-владельца
 *     (this.renderer в world/renderer.js — это THREE.WebGLRenderer,
 *      this.hud в ui/hud.js — это DOM-элемент);
 *   - платформенный слой, который ничего не знает о классах игры
 *     (this.player в yandex.js — это объект SDK Яндекса).
 *
 * Запуск: npm run audit
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const SRC = join(ROOT, 'src');

/** Расширения, которые регэксп может принять за имя свойства в «game.js». */
const FILE_EXT = new Set(['js', 'mjs', 'cjs', 'ts', 'css', 'html', 'json', 'md', 'map']);

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.m?js$/.test(name)) out.push(full);
  }
  return out;
}

const files = walk(SRC);
const rel = (p) => relative(SRC, p).split('\\').join('/');
const read = (p) => readFileSync(p, 'utf8');
const lineOf = (src, index) => src.slice(0, index).split('\n').length;

/* ---------- Что предоставляет класс ---------- */

function collectApi(src) {
  const api = new Set();
  // Поля: this.foo = ...
  for (const m of src.matchAll(/this\.([A-Za-z_$][\w$]*)\s*=/g)) api.add(m[1]);
  // Методы класса на отступе 2: foo(...) {  /  async foo(...) {
  for (const m of src.matchAll(/^ {2}(?:async\s+)?([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{/gm)) {
    if (m[1] !== 'constructor') api.add(m[1]);
  }
  // Стрелочные поля класса: _tick = (...) => {
  for (const m of src.matchAll(/^ {2}([A-Za-z_$][\w$]*)\s*=\s*\(/gm)) api.add(m[1]);
  // Геттеры: get foo() {
  for (const m of src.matchAll(/^ {2}get\s+([A-Za-z_$][\w$]*)\s*\(/gm)) api.add(m[1]);
  return api;
}

/* ---------- Карта подсистем: имя поля в Game → модуль-владелец ---------- */

const SUBSYSTEMS = {
  player: 'entities/player.js',
  waves: 'systems/waves.js',
  enemies: 'entities/enemy.js',
  projectiles: 'entities/projectile.js',
  pickups: 'entities/pickup.js',
  weapons: 'systems/weapons.js',
  effects: 'entities/effects.js',
  hud: 'ui/hud.js',
  screens: 'ui/screens.js',
  arena: 'world/arena.js',
  input: 'core/input.js',
  audio: 'core/audio.js',
  renderer: 'world/renderer.js',
};

/**
 * Файлы, в которых обращение к подсистеме имеет смысл проверять.
 * Платформенный слой исключён намеренно: он не знает о классах игры,
 * и this.player там означает профиль игрока из SDK Яндекса.
 */
const GAME_AWARE = files.filter((f) => !rel(f).startsWith('platform/'));

const problems = [];
let refs = 0;

/* ---------- 1. Обращения к Game ---------- */

const gameApi = collectApi(read(join(SRC, 'game.js')));

for (const file of GAME_AWARE) {
  const r = rel(file);
  if (r === 'game.js') continue;
  const src = read(file);
  const seen = new Set();

  const patterns = [/(?:this\.)?\bgame\.([A-Za-z_$][\w$]*)/g];
  // HUD получает игру параметром g — проверяем только в нём,
  // иначе g совпадёт с локальными переменными в других файлах.
  if (r === 'ui/hud.js') patterns.push(/\bg\.([A-Za-z_$][\w$]*)/g);

  for (const re of patterns) {
    for (const m of src.matchAll(re)) {
      const prop = m[1];
      if (FILE_EXT.has(prop)) continue; // имя файла, а не свойство
      if (seen.has(prop)) continue;
      seen.add(prop);
      refs++;
      if (!gameApi.has(prop)) problems.push({ file: r, line: lineOf(src, m.index), expr: `game.${prop}` });
    }
  }
}

/* ---------- 2. Обращения к подсистемам ---------- */

for (const [name, owner] of Object.entries(SUBSYSTEMS)) {
  const api = collectApi(read(join(SRC, owner)));
  const re = new RegExp(`(?:this|game|g)\\.${name}\\.([A-Za-z_$][\\w$]*)`, 'g');

  for (const file of GAME_AWARE) {
    const r = rel(file);
    // Внутри модуля-владельца одноимённое поле — это сторонний объект
    // (THREE.WebGLRenderer, DOM-элемент), проверять его бессмысленно.
    if (r === owner) continue;

    const src = read(file);
    const seen = new Set();
    for (const m of src.matchAll(re)) {
      const prop = m[1];
      if (FILE_EXT.has(prop)) continue;
      if (seen.has(prop)) continue;
      seen.add(prop);
      refs++;
      if (!api.has(prop)) problems.push({ file: r, line: lineOf(src, m.index), expr: `${name}.${prop}` });
    }
  }
}

/* ---------- 3. CSS-классы: JS ↔ style.css ---------- */

/**
 * Классы, которые JS навешивает на элементы, но которых нет в стилях,
 * ломают интерфейс МОЛЧА: ничего не падает, просто HUD или экран едет.
 * Без браузера это не увидеть, поэтому сверяем statically.
 */
const cssPath = join(SRC, 'style.css');
const cssClasses = new Set();
if (existsSync(cssPath)) {
  for (const m of read(cssPath).matchAll(/\.(-?[A-Za-z_][\w-]*)/g)) cssClasses.add(m[1]);
}

const usedClasses = new Map(); // класс -> файлы, где используется
function noteClass(className, file) {
  if (!className) return;
  for (const c of className.split(/\s+/)) {
    if (!c) continue;
    if (!usedClasses.has(c)) usedClasses.set(c, new Set());
    usedClasses.get(c).add(rel(file));
  }
}

for (const file of files) {
  const src = read(file);
  // _el('div', 'a b', ...) / createElement + className = '...'
  for (const m of src.matchAll(/_el\(\s*'[^']*'\s*,\s*'([^']*)'/g)) noteClass(m[1], file);
  for (const m of src.matchAll(/class(?:Name)?\s*=\s*'([^']*)'/g)) noteClass(m[1], file);
  for (const m of src.matchAll(/classList\.(?:add|remove|toggle)\(\s*'([^']*)'/g)) noteClass(m[1], file);
  // class="..." внутри innerHTML-шаблонов
  for (const m of src.matchAll(/class="([^"]+)"/g)) noteClass(m[1], file);
}

for (const [cls, where] of usedClasses) {
  if (!cssClasses.has(cls)) {
    problems.push({ file: [...where].join(', '), line: 0, expr: `CSS-класс .${cls}` });
  }
}

/* ---------- Отчёт ---------- */

console.log('');
console.log('═'.repeat(62));
console.log('  Аудит перекрёстных ссылок');
console.log('═'.repeat(62));
console.log(`  Модулей в src/:            ${files.length}`);
console.log(`  Game предоставляет:        ${gameApi.size} свойств и методов`);
console.log(`  Подсистем проверено:       ${Object.keys(SUBSYSTEMS).length}`);
console.log(`  Обращений сверено:         ${refs}`);
console.log(`  CSS-классов сверено:       ${usedClasses.size} (в стилях ${cssClasses.size})`);
console.log('─'.repeat(62));

if (problems.length) {
  console.log(`\n✗ Ссылок на несуществующие поля (${problems.length}):`);
  for (const p of problems) console.log(`    ${p.file}:${p.line} → ${p.expr}`);
} else {
  console.log('\n✓ Все перекрёстные ссылки соответствуют реальному API модулей');
}

console.log('\n' + '═'.repeat(62));
console.log(problems.length === 0 ? '  ✓ Расхождений не найдено' : `  ✗ Найдено расхождений: ${problems.length}`);
console.log('═'.repeat(62) + '\n');

process.exit(problems.length === 0 ? 0 : 1);
