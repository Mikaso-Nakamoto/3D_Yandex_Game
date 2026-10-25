// К3: можно ли пройти партию, ничего не нажимая, кроме «Приказ»?
//
// This bot has no strategy of its own: it presses the one button the game
// recommends and never touches a province, a building or an arrow. Everything
// else must come from the automatic helpers of К3 — auto-build and the
// capital's auto-send. If a scenario ends with «время вышло» here, the
// acceptance criterion «весь сценарий проходится только «Приказом»» is not met.
//
//   node tools/press-only-bot.mjs
//   node tools/press-only-bot.mjs eve1939:GER
import { readFileSync } from 'node:fs';
import { Game } from '../src/game/game.js';
import { SCENARIOS } from '../src/data/scenarios.js';

const MAPS = {
  europe: JSON.parse(readFileSync(new URL('../src/data/map.json', import.meta.url), 'utf8')),
  atlantic: JSON.parse(readFileSync(new URL('../src/data/map-atlantic.json', import.meta.url), 'utf8')),
  world: JSON.parse(readFileSync(new URL('../src/data/map-world.json', import.meta.url), 'utf8')),
};

export function pressOnly(scenarioId, nationId, { seed = 4242, press = true } = {}) {
  const scenario = SCENARIOS.find((s) => s.id === scenarioId);
  const game = new Game({
    scenarioId,
    nationId,
    map: MAPS[scenario.theatre ?? 'europe'],
    seed,
    rules: { mode: 'goal', autoBuild: true, autoSend: true },
  });
  if (!press) {
    // The control run: the helpers work, nobody presses «Приказ».
    game.castOrder = () => ({ ok: false, reason: 'off' });
  }
  let nextPress = 0;
  while (game.state.status === 'playing' && game.state.time < 4000) {
    game.update(0.1);
    if (game.state.time < nextPress) continue;
    nextPress = game.state.time + 1;
    const advice = game.suggestOrder();
    if (advice?.ready) game.castOrder(advice.kind);
  }
  const score = game.score();
  return {
    status: game.state.status,
    seconds: Math.round(game.state.time),
    owned: Object.values(game.state.provinces).filter((p) => p.owner === nationId).length,
    goal: game.state.goal.text,
    stars: score.starCount,
    built: Object.values(game.state.provinces)
      .filter((p) => p.owner === nationId)
      .reduce((sum, p) => sum + p.factory + p.barracks + p.fort, 0),
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const specs = process.argv.slice(2);
  const cases = specs.length
    ? specs.map((spec) => spec.split(':'))
    : SCENARIOS.map((scenario) => [scenario.id, scenario.nations[0].id]);
  for (const [scenarioId, nationId] of cases) {
    const withPress = pressOnly(scenarioId, nationId, { press: true });
    const without = pressOnly(scenarioId, nationId, { press: false });
    const mark = withPress.status === 'goal' ? 'OK ' : '!! ';
    const mm = Math.floor(withPress.seconds / 60);
    const ss = String(withPress.seconds % 60).padStart(2, '0');
    console.log(
      `${mark}${scenarioId} ${nationId}: ${withPress.goal} — ${withPress.status} за ${mm}:${ss}, ` +
        `провинций ${withPress.owned}, построек ${withPress.built}, звёзд ${withPress.stars} ` +
        `(без «Приказа»: ${without.status}, ${without.owned})`,
    );
  }
}
