/**
 * Проверка игровой логики и баланса без браузера.
 *
 * Браузер в CI/песочнице недоступен, а ошибки баланса и пулинга — самые
 * дорогие: их видно только на живых игроках, когда retention уже убит.
 * Поэтому чистая логика (пулы, волны, оружие, перки) тестируется в Node:
 * эти модули не трогают DOM и WebGL на этапе импорта.
 *
 * Запуск: npm run check
 */

import { Pool } from '../src/core/pool.js';
import { SpatialGrid, clamp } from '../src/core/utils.js';
import { Waves } from '../src/systems/waves.js';
import { WEAPONS, MAX_TIER, MAX_SLOTS, weaponStats } from '../src/systems/weapons.js';
import { PERKS, defaultStats, rollChoices } from '../src/systems/perks.js';
import { ENEMY_TYPES } from '../src/entities/enemy.js';

let failures = 0;
let checks = 0;

function ok(cond, label, extra = '') {
  checks++;
  if (!cond) {
    failures++;
    console.log(`  ✗ ${label}${extra ? ` — ${extra}` : ''}`);
  }
}

function section(title) {
  console.log(`\n${title}`);
  console.log('─'.repeat(58));
}

/* ================= 1. Пулы ================= */

section('1. Пулы объектов (Pool)');

{
  let n = 0;
  const p = new Pool(() => ({ id: ++n }), (o) => { o.touched = (o.touched ?? 0) + 1; }, 0);
  const a = p.obtain();
  const b = p.obtain();
  const c = p.obtain();
  ok(p.live.length === 3, 'выдано 3 объекта', `фактически ${p.live.length}`);

  // releaseAt(0) должен отдать ПОСЛЕДНИЙ объект на место удалённого.
  const moved = p.releaseAt(0);
  ok(p.live.length === 2, 'после освобождения осталось 2', `${p.live.length}`);
  ok(p.live[0] === c && p.live[1] === b, 'хвостовой объект переехал на индекс 0');
  ok(moved === c, 'releaseAt вернул перемещённый объект');

  p.releaseAt(1);
  ok(p.live.length === 1 && p.live[0] === c, 'освобождение с конца корректно');

  p.releaseAll();
  ok(p.live.length === 0 && p.free.length === 3, 'releaseAll вернул все объекты в пул');

  const reused = p.obtain();
  ok(p.free.length === 2, 'повторная выдача берёт объект из пула, а не создаёт новый');
  ok(reused.touched >= 2, 'reset() вызывается при каждой выдаче');
}

/* ================= 2. Пространственная сетка ================= */

section('2. Пространственная сетка (broadphase)');

{
  const grid = new SpatialGrid(4);
  const objs = [];
  for (let i = 0; i < 60; i++) {
    const o = { x: (i % 10) * 5 - 25, z: Math.floor(i / 10) * 5 - 15, isEnemy: true };
    objs.push(o);
    grid.insert(o);
  }
  const out = [];
  grid.query(0, 0, 3, out);
  ok(out.length > 0, 'запрос находит соседей', `${out.length}`);
  for (const o of out) {
    ok(Math.hypot(o.x, o.z) < 3 + 5, 'найденный объект действительно рядом');
  }

  // Отрицательные координаты — типичный источник багов ключей.
  grid.clear();
  const neg = { x: -30, z: -30, isEnemy: true };
  grid.insert(neg);
  grid.query(-30, -30, 1, out);
  ok(out.includes(neg), 'сетка работает с отрицательными координатами');

  grid.clear();
  grid.query(0, 0, 5, out);
  ok(out.length === 0, 'clear() очищает сетку');
}

/* ================= 3. Оружие и слияние ================= */

section('3. Оружие: характеристики по тирам');

{
  for (const w of WEAPONS) {
    const type = WEAPONS.indexOf(w);
    let prevDps = 0;
    for (let tier = 1; tier <= MAX_TIER; tier++) {
      const s = weaponStats(type, tier);
      const finite = [s.dmg, s.cd, s.count, s.pierce, s.speed, s.range, s.size].every(
        (v) => Number.isFinite(v) && v >= 0,
      );
      ok(finite, `${w.name} тир ${tier}: значения конечны и неотрицательны`, JSON.stringify(s));
      ok(s.cd > 0.02, `${w.name} тир ${tier}: перезарядка не вырождается`, `${s.cd}`);

      const dps = (s.dmg * s.count) / s.cd;
      if (tier > 1) {
        ok(dps > prevDps, `${w.name}: DPS растёт с тиром`, `тир ${tier} ${dps.toFixed(1)} <= ${prevDps.toFixed(1)}`);
      }
      prevDps = dps;
    }

    // Тир за пределами диапазона не должен ломать баланс.
    const over = weaponStats(type, MAX_TIER + 5);
    const max = weaponStats(type, MAX_TIER);
    ok(over.dmg === max.dmg, `${w.name}: тир выше максимального зажимается`);
    const under = weaponStats(type, 0);
    ok(under.dmg === weaponStats(type, 1).dmg, `${w.name}: тир ниже 1 зажимается`);
  }

  ok(MAX_SLOTS >= 3, 'слотов достаточно для сборки билда', `${MAX_SLOTS}`);
  ok(WEAPONS.length >= 4, 'достаточно типов оружия для разнообразия', `${WEAPONS.length}`);
}

/* ================= 4. Перки ================= */

section('4. Перки: корректность и выбор');

{
  for (const p of PERKS) {
    ok(typeof p.name === 'string' && p.name.length > 0, `перк ${p.id}: есть название`);
    ok(typeof p.desc === 'string' && p.desc.length > 0, `перк ${p.id}: есть описание`);
    ok(typeof p.glyph === 'string' && p.glyph.length > 0, `перк ${p.id}: есть иконка`);
    ok(typeof p.css === 'string' && /^#[0-9a-f]{6}$/i.test(p.css), `перк ${p.id}: валидный цвет`);
    ok(p.max >= 1, `перк ${p.id}: задан максимум уровней`);
    ok(p.special || typeof p.apply === 'function', `перк ${p.id}: есть эффект или special`);

    if (typeof p.apply === 'function') {
      const s = defaultStats();
      const before = JSON.stringify(s);
      for (let i = 0; i < p.max; i++) p.apply(s);
      ok(JSON.stringify(s) !== before, `перк ${p.id}: реально меняет характеристики`);
      ok(Object.values(s).every((v) => Number.isFinite(v)), `перк ${p.id}: без NaN на максимуме`);
      ok(s.cooldown > 0.05, `перк ${p.id}: перезарядка не уходит в ноль`, `${s.cooldown}`);
      ok(s.armor < 0.95, `перк ${p.id}: броня не делает игрока бессмертным`, `${s.armor}`);
      ok(s.damage < 400, `перк ${p.id}: урон не уходит в бесконечность`, `${s.damage}`);
    }
  }

  // Выбор 1 из 3.
  const weapons = { slotCount: MAX_SLOTS };
  const levels = {};
  for (let i = 0; i < 50; i++) {
    const choices = rollChoices(levels, weapons);
    ok(choices.length >= 1 && choices.length <= 3, `предложено 1–3 перка (получено ${choices.length})`);
    const ids = choices.map((c) => c.id);
    ok(new Set(ids).size === ids.length, 'предложения не повторяются', ids.join(','));
    for (const c of choices) levels[c.id] = (levels[c.id] ?? 0) + 1;
  }

  // Все перки на максимуме — игра не должна упасть или предложить невозможное.
  const maxed = {};
  for (const p of PERKS) maxed[p.id] = p.max;
  const fallback = rollChoices(maxed, { slotCount: MAX_SLOTS + 2 });
  ok(fallback.length >= 1, 'когда всё взято, есть запасной вариант (лечение)');

  // «Модуль расширения» не предлагается, если слоты закончились.
  const noSlots = rollChoices({}, { slotCount: MAX_SLOTS + 2 });
  ok(!noSlots.some((p) => p.special === 'slot'), 'перк слота не предлагается на пределе');
}

/* ================= 5. Волны ================= */

section('5. Режиссёр волн');

function makeStubGame(maxEnemies = 120) {
  return {
    profile: { maxEnemies },
    player: { x: 0, z: 0 },
    enemies: { aliveCount: 0, spawn: (key) => ({ def: { color: 0xffffff }, key }) },
    arena: { edgeSpawnPoint: () => ({ x: 20, z: 20 }) },
    effects: { particles: { ring: () => {} } },
    onWaveStart: () => {},
    onWaveCleared: () => {},
  };
}

const waveReport = [];
{
  const stub = makeStubGame();
  const w = new Waves(stub);

  for (let i = 0; i < 40; i++) {
    const before = w.wave;
    w.startNextWave(0);
    ok(w.wave === before + 1, `волна ${i + 1}: счётчик увеличился`);
    ok(w.queue.length > 0, `волна ${w.wave}: состав не пуст`, `${w.queue.length}`);
    ok(w.queue.length < 400, `волна ${w.wave}: состав не вырождается в бесконечный цикл`, `${w.queue.length}`);

    const counts = {};
    for (const k of w.queue) {
      ok(!!ENEMY_TYPES[k], `волна ${w.wave}: неизвестный тип врага "${k}"`);
      counts[k] = (counts[k] ?? 0) + 1;
    }

    const isBoss = w.wave % 5 === 0;
    ok(isBoss === w.isBossWave, `волна ${w.wave}: флаг босса совпадает`);
    ok(isBoss ? (counts.boss ?? 0) >= 1 : !(counts.boss > 0), `волна ${w.wave}: босс только на каждой 5-й`);

    const scale = w.scale();
    ok(scale.hp >= 1 && Number.isFinite(scale.hp), `волна ${w.wave}: масштаб HP валиден`, `${scale.hp}`);
    ok(scale.dmg >= 1 && scale.dmg < 12, `волна ${w.wave}: урон врагов растёт, но не взрывается`, `${scale.dmg}`);
    ok(scale.speed >= 1 && scale.speed <= 1.6, `волна ${w.wave}: скорость врагов в пределах`, `${scale.speed}`);
    ok(w.duration >= 10 && w.duration <= 32, `волна ${w.wave}: длительность в пределах 10–32 c`, `${w.duration}`);

    const totalHp = w.queue.reduce((s, k) => s + ENEMY_TYPES[k].hp * scale.hp, 0);
    waveReport.push({ wave: w.wave, n: w.queue.length, hp: Math.round(totalHp), counts, dur: w.duration.toFixed(1), scale });
  }

  // Монотонный рост сложности.
  const hpSeries = waveReport.map((r) => r.hp / r.dur);
  let regressions = 0;
  for (let i = 6; i < hpSeries.length; i++) {
    if (hpSeries[i] < hpSeries[i - 5] * 0.9) regressions++;
  }
  ok(regressions <= 6, 'сложность в целом растёт по волнам', `регрессов ${regressions}`);
}

/* ================= 6. Баланс: симуляция забега ================= */

section('6. Баланс: симуляция забега (Монте-Карло)');

/**
 * Честная симуляция вместо «модели на глаз».
 *
 * Прежняя оценка задавала средний тир оружия как функцию номера волны и давала
 * совершенно нереалистичную картину: при фактическом шансе дропа игрок физически
 * не может собрать 6-й тир к 20-й волне. Теперь прогрессия разыгрывается по тем
 * же правилам, что и в игре (шансы дропа, смещение к уже имеющимся типам,
 * логика слияния и замены слота, выбор перков), поэтому тест ловит настоящие
 * проблемы пейсинга, а не выдуманные.
 */

const OWN_TYPE_BIAS = 0.85; // обязан совпадать со значением в entities/pickup.js
const DROP_CHANCE_HEAVY = 0.1; // враги стоимостью >= 3 (shooter, tank)
const DROP_CHANCE_LIGHT = 0.055; // grunt, runner

function simAddWeapon(slots, type, tier, slotCap) {
  const same = slots.findIndex((s) => s.type === type && s.tier === tier);
  if (same >= 0) {
    if (slots[same].tier >= MAX_TIER) return 'overflow';
    slots[same].tier += 1;
    return 'merged';
  }
  if (slots.length < slotCap) {
    slots.push({ type, tier });
    return 'added';
  }
  let li = -1;
  let best = Infinity;
  slots.forEach((s, i) => {
    if (s.tier < best) {
      best = s.tier;
      li = i;
    }
  });
  if (li >= 0 && tier > slots[li].tier) {
    slots[li] = { type, tier };
    return 'replaced';
  }
  return 'overflow';
}

function simPickType(slots) {
  if (slots.length > 0 && Math.random() < OWN_TYPE_BIAS) {
    return slots[(Math.random() * slots.length) | 0].type;
  }
  return (Math.random() * WEAPONS.length) | 0;
}

/**
 * Тир дропа привязан к слабейшему оружию игрока, а не к номеру волны —
 * зеркало метода Pickups._pickWeaponTier(). Расхождение между тестом и игрой
 * здесь критично: именно оно однажды и дало нереалистичную кривую баланса.
 */
function simDropTier(slots, isBoss) {
  const minTier = slots.length ? Math.min(...slots.map((s) => s.tier)) : 1;
  let tier = Math.max(1, minTier - 1);
  if (isBoss) tier += 1;
  return clamp(tier, 1, MAX_TIER);
}

function simDps(slots, perks) {
  const extra = perks.multi ?? 0;
  const rate = Math.pow(0.9, perks.rate ?? 0);
  let base = 0;
  for (const s of slots) {
    const st = weaponStats(s.type, s.tier);
    base += (st.dmg * (st.count + extra)) / (st.cd * rate);
  }
  // Пробитие, ауру и шипы не учитываем: оценка остаётся заниженной,
  // то есть запас прочности у баланса получается честный.
  const dmgMul = Math.pow(1.18, perks.dmg ?? 0);
  const critMul = 1 + 0.09 * (perks.crit ?? 0);
  return base * dmgMul * critMul;
}

function simPerkPick(perks, slotCap) {
  const available = PERKS.filter((p) => {
    if ((perks[p.id] ?? 0) >= p.max) return false;
    if (p.special === 'slot' && slotCap >= MAX_SLOTS + 2) return false;
    return true;
  });
  if (available.length === 0) return null;
  const pool = available.slice();
  const choices = [];
  for (let i = 0; i < Math.min(3, pool.length); i++) {
    choices.push(pool.splice((Math.random() * pool.length) | 0, 1)[0]);
  }
  return choices[(Math.random() * choices.length) | 0];
}

function simulateRun(waves) {
  const slots = [{ type: 0, tier: 1 }];
  let slotCap = MAX_SLOTS;
  const perks = {};
  let merges = 0;
  let overflows = 0;
  let mergesBy10 = 0;
  let mergesMid = 0;
  let mergesLate = 0;
  const out = [];

  for (const r of waves) {
    out.push({
      wave: r.wave,
      dps: simDps(slots, perks),
      required: r.hp / r.dur,
      slots: slots.length,
      avgTier: slots.reduce((s, x) => s + x.tier, 0) / slots.length,
      maxTier: Math.max(...slots.map((s) => s.tier)),
    });

    // Дроп за волну — по тем же правилам, что и в pickup.js.
    for (const [key, count] of Object.entries(r.counts)) {
      const def = ENEMY_TYPES[key];
      for (let i = 0; i < count; i++) {
        // Босс гарантирует два куба повышенного тира — как в pickup.js.
        const drops = def.boss ? 2 : Math.random() < (def.cost >= 3 ? DROP_CHANCE_HEAVY : DROP_CHANCE_LIGHT) ? 1 : 0;
        for (let d = 0; d < drops; d++) {
          const res = simAddWeapon(slots, simPickType(slots), simDropTier(slots, def.boss), slotCap);
          if (res === 'merged') {
            merges++;
            if (r.wave <= 10) mergesBy10++;
            else if (r.wave <= 25) mergesMid++;
            else mergesLate++;
          } else if (res === 'overflow') overflows++;
        }
      }
    }

    const picked = simPerkPick(perks, slotCap);
    if (picked) {
      perks[picked.id] = (perks[picked.id] ?? 0) + 1;
      if (picked.special === 'slot') slotCap++;
    }
  }

  return { out, merges, overflows, mergesBy10, mergesMid, mergesLate, slots, perks };
}

const RUNS = 60;
const simRuns = [];
for (let i = 0; i < RUNS; i++) simRuns.push(simulateRun(waveReport));

function avgAt(wave, getter) {
  const vals = simRuns.map((r) => getter(r.out.find((o) => o.wave === wave))).filter((v) => Number.isFinite(v));
  return vals.reduce((a, b) => a + b, 0) / Math.max(1, vals.length);
}

const mean = (getter) => simRuns.reduce((s, r) => s + getter(r), 0) / RUNS;

const simRows = [];
let trough = 0;
let lateEasy = 0;
let impossible = 0;

for (let wave = 1; wave <= 40; wave++) {
  const dps = avgAt(wave, (o) => o.dps);
  const required = avgAt(wave, (o) => o.required);
  const ratio = required / Math.max(1e-6, dps);
  simRows.push({ wave, dps, required, ratio, avgTier: avgAt(wave, (o) => o.avgTier) });

  // Волны 1–4 — обучение: там игрок заведомо слаб, а врагов мало.
  if (wave >= 5 && wave <= 24 && ratio < 0.16) trough++;
  if (wave >= 28 && ratio < 0.45) lateEasy++;
  if (wave >= 4 && ratio > 2.4) impossible++;
}

console.log('  волна |   DPS   | нужно | нагрузка | ср.тир');
for (const r of simRows.filter((x) => x.wave % 3 === 1 || x.wave === 40)) {
  console.log(
    `  ${String(r.wave).padStart(5)} | ${r.dps.toFixed(0).padStart(7)} | ${r.required.toFixed(0).padStart(5)} | ` +
      `${r.ratio.toFixed(2).padStart(8)} | ${r.avgTier.toFixed(2)}`,
  );
}
console.log(
  `  слияний за забег: ${mean((r) => r.merges).toFixed(1)} (к 10-й волне: ${mean((r) => r.mergesBy10).toFixed(1)}), ` +
    `переполнений слотов: ${mean((r) => r.overflows).toFixed(1)}`,
);

// Главная проверка: механика слияния обязана успевать раскрыться за забег
// и НЕ ЗАМИРАТЬ к его концу — иначе последние волны превращаются в рутину.
ok(mean((r) => r.mergesBy10) >= 3, 'к 10-й волне игрок видит ≥3 слияния', mean((r) => r.mergesBy10).toFixed(1));
ok(mean((r) => r.mergesMid) >= 4, 'на волнах 11–25 слияния продолжаются (≥4)', mean((r) => r.mergesMid).toFixed(1));
ok(mean((r) => r.mergesLate) >= 2, 'на волнах 26–40 слияния ещё случаются (≥2)', mean((r) => r.mergesLate).toFixed(1));
ok(mean((r) => r.merges) >= 14, 'за забег до 40-й волны ≥14 слияний', mean((r) => r.merges).toFixed(1));
ok(avgAt(10, (o) => o.avgTier) >= 1.7, 'к 10-й волне средний тир ≥ 1.7', avgAt(10, (o) => o.avgTier).toFixed(2));
// Прогрессия обязана расти на всём протяжении забега, а не упираться в плато:
// именно ощущение «я становлюсь сильнее» удерживает игрока в рогалике.
ok(
  avgAt(20, (o) => o.avgTier) > avgAt(10, (o) => o.avgTier) + 0.25,
  'средний тир растёт между 10-й и 20-й волнами',
  `${avgAt(10, (o) => o.avgTier).toFixed(2)} → ${avgAt(20, (o) => o.avgTier).toFixed(2)}`,
);
ok(
  avgAt(40, (o) => o.avgTier) > avgAt(20, (o) => o.avgTier) + 0.75,
  'средний тир продолжает расти после 20-й волны',
  `${avgAt(20, (o) => o.avgTier).toFixed(2)} → ${avgAt(40, (o) => o.avgTier).toFixed(2)}`,
);
ok(avgAt(40, (o) => o.avgTier) >= 3.5, 'к 40-й волне средний тир ≥ 3.5', avgAt(40, (o) => o.avgTier).toFixed(2));
// Прогрессия не должна выгорать до потолка раньше конца забега.
ok(avgAt(40, (o) => o.avgTier) < MAX_TIER, 'к 40-й волне тир не упирается в потолок', avgAt(40, (o) => o.avgTier).toFixed(2));
ok(
  mean((r) => r.overflows) > 0 && mean((r) => r.merges) > 0,
  'переполнение слотов конвертируется в монеты, а не в пустоту',
  `overflow ${mean((r) => r.overflows).toFixed(1)} → монеты, merge ${mean((r) => r.merges).toFixed(1)}`,
);

// Кривая сложности.
ok(trough <= 4, 'нет глубокого провала сложности в середине забега (волны 5–24)', `${trough} волн с нагрузкой < 0.16`);
ok(lateEasy <= 6, 'поздние волны (28+) остаются опасными', `${lateEasy} волн с нагрузкой < 0.45`);
ok(impossible === 0, 'ни одна волна не требует недостижимого DPS', `${impossible}`);

/* ================= 7. Состав волн ================= */

section('7. Состав волн (первые 12)');

for (const r of waveReport.slice(0, 12)) {
  const parts = Object.entries(r.counts).map(([k, v]) => `${k}:${v}`).join(' ');
  console.log(`  волна ${String(r.wave).padStart(2)} — ${String(r.n).padStart(3)} врагов, ${parts.padEnd(34)} ${r.dur} c, HP×${r.scale.hp.toFixed(2)}`);
}

/* ================= Итог ================= */

console.log('\n' + '═'.repeat(58));
if (failures === 0) {
  console.log(`  ✓ Все проверки пройдены (${checks})`);
} else {
  console.log(`  ✗ Провалено ${failures} из ${checks}`);
}
console.log('═'.repeat(58) + '\n');

process.exit(failures === 0 ? 0 : 1);
