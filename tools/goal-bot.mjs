// К2: can the aim of every scenario be reached inside the eight-minute clock?
//
// A simple bot plays each scenario with the same policy a casual player would
// use — press the orders when they are ready, send 60 % of a province at any
// neighbour where the odds are at least 45 % — and the script prints how long
// the aim took. If a scenario ends with «время вышло» for the bot, its goal is
// too far for a player who is slower than a bot.
//
//   node tools/goal-bot.mjs            # every scenario, first nation of each
//   node tools/goal-bot.mjs eve1939:GER concert:FRA
import { readFileSync } from 'node:fs';
import { Game } from '../src/game/game.js';
import { SCENARIOS } from '../src/data/scenarios.js';

const MAPS = {
  europe: JSON.parse(readFileSync(new URL('../src/data/map.json', import.meta.url), 'utf8')),
  atlantic: JSON.parse(readFileSync(new URL('../src/data/map-atlantic.json', import.meta.url), 'utf8')),
  world: JSON.parse(readFileSync(new URL('../src/data/map-world.json', import.meta.url), 'utf8')),
};

function play(scenarioId, nationId, { ratio = 0.6, odds = 0.45, seed = 4242 } = {}) {
  const scenario = SCENARIOS.find((s) => s.id === scenarioId);
  const game = new Game({
    scenarioId,
    nationId,
    map: MAPS[scenario.theatre ?? 'europe'],
    seed,
    rules: { mode: 'goal', autoBuild: true, autoSend: true },
  });
  let next = 0;
  while (game.state.status === 'playing' && game.state.time < 4000) {
    game.update(0.1);
    if (game.state.time < next) continue;
    next = game.state.time + 1.5;
    // К3.3: exactly what a player does now — press the one order the game
    // recommends, then drag arrows where the odds look good.
    const advice = game.suggestOrder();
    if (advice?.ready) game.castOrder(advice.kind);
    for (const province of Object.values(game.state.provinces)) {
      if (province.owner !== nationId || province.garrison < 60) continue;
      const targets = (game.byId[province.id].neighbors ?? [])
        .map((id) => game.state.provinces[id])
        .filter((target) => target && target.owner !== nationId)
        .map((target) => ({ target, odds: game.attackOdds(province.id, target.id, ratio) }))
        .filter((entry) => entry.odds && entry.odds.chance >= odds)
        .sort((a, b) => b.odds.chance - a.odds.chance);
      if (targets.length) game.launchArmy(nationId, province.id, targets[0].target.id, ratio);
    }
  }
  const score = game.score();
  return {
    status: game.state.status,
    seconds: Math.round(game.state.time),
    owned: Object.values(game.state.provinces).filter((p) => p.owner === nationId).length,
    goal: game.state.goal.text,
    stars: score.starCount,
  };
}

const specs = process.argv.slice(2);
const cases = specs.length
  ? specs.map((spec) => spec.split(':'))
  : SCENARIOS.map((scenario) => [scenario.id, scenario.nations[0].id]);

for (const [scenarioId, nationId] of cases) {
  const result = play(scenarioId, nationId);
  const mm = Math.floor(result.seconds / 60);
  const ss = String(result.seconds % 60).padStart(2, '0');
  const mark = result.status === 'goal' ? 'OK ' : '!! ';
  console.log(
    `${mark}${scenarioId} ${nationId}: ${result.goal} — ${result.status} за ${mm}:${ss}, провинций ${result.owned}, звёзд ${result.stars}`,
  );
}
