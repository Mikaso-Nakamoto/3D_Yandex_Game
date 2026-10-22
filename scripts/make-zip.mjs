/**
 * Сборка и упаковка игры в ZIP для Консоли разработчика Яндекс Игр
 * с автоматической проверкой требований модерации.
 *
 * Запуск:  npm run zip          (соберёт dist и упакует)
 *          node scripts/make-zip.mjs --skip-build
 *
 * Проверяемые пункты требований:
 *   1.21 — суммарный размер распакованных файлов ≤ 100 МБ;
 *   1.22 — index.html в КОРНЕ архива, имена без пробелов и кириллицы;
 *   1.1  — в коде присутствует интеграция Yandex Games SDK;
 *   1.12 — есть вызовы рекламы (fullscreen / rewarded);
 *   1.9  — есть вызовы сохранения прогресса;
 *   —    — нет загрузок данных со сторонних хостов (кроме самого SDK).
 */

import { execSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync, rmSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const DIST = join(ROOT, 'dist');
const OUT = join(ROOT, 'merge-arena-3d.zip');
const MAX_UNCOMPRESSED = 100 * 1024 * 1024; // пункт 1.21
const WARN_UNCOMPRESSED = 20 * 1024 * 1024; // практический ориентир инди-разработчика

const skipBuild = process.argv.includes('--skip-build');

/* ---------- 1. Сборка ---------- */

if (!skipBuild) {
  console.log('› Сборка Vite…');
  execSync('npx vite build', { cwd: ROOT, stdio: 'inherit' });
}

if (!existsSync(join(DIST, 'index.html'))) {
  fail('В dist/ нет index.html. Запусти сборку без --skip-build.');
}

/* ---------- 2. Обход файлов ---------- */

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, out);
    else out.push({ full, rel: relative(DIST, full).split('\\').join('/'), size: st.size });
  }
  return out;
}

const files = walk(DIST);
const totalSize = files.reduce((s, f) => s + f.size, 0);

/* ---------- 3. Проверки ---------- */

const errors = [];
const warnings = [];

// 1.22 — index.html в корне
if (!files.some((f) => f.rel === 'index.html')) {
  errors.push('1.22: index.html должен лежать В КОРНЕ архива.');
}

// 1.22 — имена файлов: только латиница, без пробелов
for (const f of files) {
  if (/\s/.test(f.rel)) errors.push(`1.22: пробел в имени файла: "${f.rel}"`);
  if (/[^\x00-\x7F]/.test(f.rel)) errors.push(`1.22: не-латинские символы в имени: "${f.rel}"`);
}

// 1.21 — размер
if (totalSize > MAX_UNCOMPRESSED) {
  errors.push(`1.21: распакованный размер ${mb(totalSize)} МБ превышает лимит 100 МБ.`);
} else if (totalSize > WARN_UNCOMPRESSED) {
  warnings.push(`Размер ${mb(totalSize)} МБ: выше практического ориентира 20 МБ — долгая загрузка режет конверсию.`);
}

// Содержимое бандлов
const code = files
  .filter((f) => /\.(js|mjs|css|html)$/i.test(f.rel))
  .map((f) => ({ rel: f.rel, text: readFileSync(f.full, 'utf8') }));
const allCode = code.map((c) => c.text).join('\n');

// 1.1 — SDK
if (!/YaGames/.test(allCode)) {
  errors.push('1.1: в коде не найдена интеграция Yandex Games SDK (window.YaGames).');
}
if (!/LoadingAPI/.test(allCode)) warnings.push('1.1: не найден вызов LoadingAPI.ready().');
if (!/GameplayAPI/.test(allCode)) warnings.push('1.1: не найден вызов GameplayAPI.start()/stop().');

// 1.12 — монетизация
if (!/showFullscreenAdv|showRewardedVideo/.test(allCode)) {
  errors.push('1.12: нет вызовов рекламы (showFullscreenAdv / showRewardedVideo). Без монетизации модерация не пропустит.');
}

// 1.9 — сохранения
if (!/setData|getData/.test(allCode)) {
  warnings.push('1.9: не найдены player.setData/getData — прогресс должен сохраняться между сессиями.');
}

// Внешние хосты: почти все данные должны лежать в архиве.
// Комментарийные ссылки (W3C-неймспейсы в SVG, библиография в шейдерах three.js)
// данными не являются — их отфильтровываем, чтобы не плодить ложные срабатывания.
const externalUrls = new Set();
const re = /https?:\/\/[a-z0-9.-]+\.[a-z]{2,}[^\s'"`)]*/gi;
for (const c of code) {
  for (const line of c.text.split('\n')) {
    const trimmed = line.trim();
    const isComment = trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*');
    for (const m of line.match(re) ?? []) {
      const host = m.replace(/^https?:\/\//, '').split('/')[0];
      if (/yandex\.(ru|com)$/i.test(host)) continue; // SDK Яндекса разрешён
      if (/^www\.w3\.org$/i.test(host)) continue; // неймспейсы разметки
      if (isComment) continue; // ссылка в комментарии ничего не загружает
      externalUrls.add(`${m.slice(0, 90)}  (${c.rel})`);
    }
  }
}
if (externalUrls.size) {
  warnings.push(
    `Найдены внешние URL (данные игры должны грузиться из архива):\n    - ${[...externalUrls].slice(0, 6).join('\n    - ')}`,
  );
}

// Отладочные выводы проверяем только в НАШЕМ исходном коде: three.js содержит
// собственные console.log, и считать их нарушением бессмысленно.
const SRC = join(ROOT, 'src');
let ownConsoleCalls = 0;
if (existsSync(SRC)) {
  const ownFiles = walk(SRC).filter((f) => /\.m?js$/.test(f.rel));
  for (const f of ownFiles) {
    const text = readFileSync(f.full, 'utf8');
    const hits = text.match(/console\.(log|debug)\(/g) ?? [];
    ownConsoleCalls += hits.length;
  }
}
if (ownConsoleCalls > 0) {
  warnings.push(`В src/ найдено ${ownConsoleCalls} отладочных console.log/debug — убрать перед релизом.`);
}

/* ---------- 4. Упаковка ---------- */

if (errors.length === 0) {
  if (existsSync(OUT)) rmSync(OUT);
  // Содержимое dist (не сама папка) — чтобы index.html оказался в корне архива.
  execSync(`zip -r -q -X "${OUT}" . -x '*.DS_Store'`, { cwd: DIST, stdio: 'inherit' });
}

/* ---------- 5. Отчёт ---------- */

console.log('');
console.log('═'.repeat(62));
console.log('  Проверка сборки для Яндекс Игр');
console.log('═'.repeat(62));
console.log(`  Файлов:                 ${files.length}`);
console.log(`  Распакованный размер:   ${mb(totalSize)} МБ  (лимит 100 МБ)`);
if (existsSync(OUT)) console.log(`  Архив:                  ${mb(statSync(OUT).size)} МБ  ${relative(ROOT, OUT)}`);
console.log(`  Точка входа:            ${files.some((f) => f.rel === 'index.html') ? 'index.html в корне ✓' : 'ОТСУТСТВУЕТ ✗'}`);
console.log('─'.repeat(62));

for (const f of files) console.log(`    ${f.rel.padEnd(38)} ${(f.size / 1024).toFixed(1).padStart(8)} КБ`);
console.log('─'.repeat(62));

if (warnings.length) {
  console.log(`\n⚠ Предупреждений: ${warnings.length}`);
  for (const w of warnings) console.log(`  • ${w}`);
}
if (errors.length) {
  console.log(`\n✗ Ошибок: ${errors.length} — архив НЕ создан`);
  for (const e of errors) console.log(`  • ${e}`);
  process.exit(1);
}

console.log('\n✓ Готово к загрузке в Консоль разработчика.');
console.log('  Напоминание перед отправкой: заполнить название, описание, «Как играть»,');
console.log('  версию, категории, иконку, обложку, скриншоты и возрастной рейтинг.\n');

function mb(bytes) {
  return (bytes / 1024 / 1024).toFixed(2);
}

function fail(msg) {
  console.error(`\n✗ ${msg}\n`);
  process.exit(1);
}
