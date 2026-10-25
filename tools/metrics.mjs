// Метрики из §7 плана, посчитанные локально: бот играет партии так же, как
// tools/goal-bot.mjs (приказы по подсказке игры, 60 % в любой сосед с шансом
// ≥ 45 %), и скрипт печатает то, что план обещает измерять.
//
//   node tools/metrics.mjs            # 20 партий на первом сценарии каждого театра
import { readFileSync } from 'node:fs';
import { Game } from '../src/game/game.js';
import { SCENARIOS } from '../src/data/scenarios.js';

const MAPS = {
  europe: JSON.parse(readFileSync(new URL('../src/data/map.json', import.meta.url), 'utf8')),
  atlantic: JSON.parse(readFileSync(new URL('../src/data/map-atlantic.json', import.meta.url), 'utf8')),
  world: JSON.parse(readFileSync(new URL('../src/data/map-world.json', import.meta.url), 'utf8')),
};

const SCENARIO_IDS = SCENARIOS.filter((s) => !s.tutorial).map((s) => s.id);

function play(scenarioId, seed) {
  const scenario = SCENARIOS.find((s) => s.id === scenarioId);
  const nationId = scenario.nations[0].id;
  const game = new Game({
    scenarioId,
    nationId,
    map: MAPS[scenario.theatre ?? 'europe'],
    seed,
    rules: { mode: 'goal', autoBuild: true, autoSend: true },
  });
  let decisions = 0;
  let firstCapture = 0;
  let toasts = 0;
  game.on((type) => {
    if (type === 'capture' && !firstCapture) firstCapture = game.state.time;
    // Пул сообщений журнала — то же, что игрок видит тостами и в журнале.
    if (type === 'log') toasts += 1;
  });
  let next = 0;
  while (game.state.status === 'playing' && game.state.time < 4000) {
    game.update(0.1);
    if (game.state.time < next) continue;
    next = game.state.time + 1.5;
    const advice = game.suggestOrder();
    if (advice?.ready && game.castOrder(advice.kind).ok) decisions += 1;
    for (const province of Object.values(game.state.provinces)) {
      if (province.owner !== nationId || province.garrison < 60) continue;
      const targets = (game.byId[province.id].neighbors ?? [])
        .map((id) => game.state.provinces[id])
        .filter((target) => target && target.owner !== nationId)
        .map((target) => ({ target, odds: game.attackOdds(province.id, target.id, 0.6) }))
        .filter((entry) => entry.odds && entry.odds.chance >= 0.45)
        .sort((a, b) => b.odds.chance - a.odds.chance);
      if (targets.length && game.launchArmy(nationId, province.id, targets[0].target.id, 0.6) > 0) decisions += 1;
    }
  }
  return { status: game.state.status, seconds: Math.round(game.state.time), firstCapture, toasts, decisions };
}

const runs = [];
for (let i = 0; i < 20; i += 1) {
  const scenarioId = SCENARIO_IDS[i % SCENARIO_IDS.length];
  runs.push({ scenarioId, ...play(scenarioId, 1000 + i * 7) });
}

const finished = runs.filter((r) => r.status === 'goal' || r.status === 'victory' || r.status === 'defeat');
const avg = (list, key) => (list.length ? Math.round(list.reduce((sum, r) => sum + r[key], 0) / list.length) : 0);
console.log(`Партий: ${runs.length}`);
console.log(`Доля с финалом: ${Math.round((finished.length / runs.length) * 100)} % (${finished.length}/${runs.length})`);
console.log(`Длина партии, среднее: ${Math.floor(avg(runs, 'seconds') / 60)}:${String(avg(runs, 'seconds') % 60).padStart(2, '0')}`);
console.log(`Время до первого захвата, среднее: ${avg(runs.filter((r) => r.firstCapture), 'firstCapture')} с`);
console.log(`Сообщений за партию, среднее: ${avg(runs, 'toasts')}`);
console.log(`Решений игрока за партию, среднее: ${avg(runs, 'decisions')} (разброс ${Math.min(...runs.map((r) => r.decisions))}–${Math.max(...runs.map((r) => r.decisions))})`);
const byStatus = runs.reduce((acc, r) => ({ ...acc, [r.status]: (acc[r.status] ?? 0) + 1 }), {});
console.log('Исходы:', JSON.stringify(byStatus));
const slow = runs.filter((r) => r.seconds > 480).length;
console.log(`Дольше восьми минут: ${slow}`);
