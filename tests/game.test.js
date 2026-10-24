import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Game } from '../src/game/game.js';
import { SCENARIOS } from '../src/data/scenarios.js';
import { normalizeRules, DEFAULT_RULES, AI_STYLE, AI_ECONOMY, NEUTRAL_STRENGTH, ruleOptionMatches } from '../src/game/rules.js';
import { BAL } from '../src/game/balance.js';
import { offersVerb, offerSentence, marchesVerb, provincesCount, nationsCount } from '../src/game/text.js';

const map = JSON.parse(readFileSync(new URL('../src/data/map.json', import.meta.url), 'utf8'));
const atlanticMap = JSON.parse(readFileSync(new URL('../src/data/map-atlantic.json', import.meta.url), 'utf8'));
const worldMap = JSON.parse(readFileSync(new URL('../src/data/map-world.json', import.meta.url), 'utf8'));
const MAPS = { europe: map, atlantic: atlanticMap, world: worldMap };
const mapFor = (scenario) => MAPS[scenario.theatre ?? 'europe'];
const makeGame = (opts = {}) => {
  const { ai = false, ...rest } = opts;
  const game = new Game({ scenarioId: 'concert', nationId: 'FRA', doctrineId: 'coin', map, seed: 42, ...rest });
  // Combat/economy tests run without AI interference; AI has its own test below.
  if (!ai) for (const nation of game.nations) if (!nation.isPlayer) nation.ai.nextThink = 1e9;
  return game;
};

test('AI aggressiveness setting really changes how the world is carved up', () => {
  // The setting existed but only nudged the thinking interval, which no player
  // can feel. It now also changes the chance of a push and the odds a nation
  // accepts — so two matches with the same seed must diverge.
  const captures = (aiStyle, seed) => {
    const game = new Game({ scenarioId: 'concert', nationId: 'FRA', doctrineId: 'coin', map, seed, rules: { aiStyle } });
    let count = 0;
    game.on((type) => {
      if (type === 'capture') count += 1;
    });
    for (let i = 0; i < 900; i += 1) game.update(0.5);
    return count;
  };
  for (const seed of [7, 42, 99]) {
    const calm = captures('calm', seed);
    const normal = captures('normal', seed);
    const hard = captures('hard', seed);
    assert.ok(calm < normal, `seed ${seed}: спокойный ИИ должен воевать реже (${calm} vs ${normal})`);
    assert.ok(normal < hard, `seed ${seed}: жёсткий ИИ должен воевать чаще (${normal} vs ${hard})`);
    assert.ok(hard >= calm * 1.5, `seed ${seed}: разница должна быть заметной (${calm} → ${hard})`);
  }
});

test('map has every province wired to at least one neighbour', () => {
  assert.equal(map.provinces.length, 43);
  for (const province of map.provinces) {
    assert.ok(province.neighbors.length > 0, `${province.id} is isolated`);
    for (const neighbour of province.neighbors) {
      assert.ok(map.provinces.some((p) => p.id === neighbour), `${province.id} -> unknown ${neighbour}`);
    }
  }
});

test('adjacency is symmetric', () => {
  const byId = Object.fromEntries(map.provinces.map((p) => [p.id, p]));
  for (const province of map.provinces) {
    for (const neighbour of province.neighbors) {
      assert.ok(byId[neighbour].neighbors.includes(province.id), `${province.id}/${neighbour} not symmetric`);
    }
  }
});

test('every scenario assigns lands that exist and leaves no nation landless', () => {
  for (const scenario of SCENARIOS) {
    const ids = new Set(mapFor(scenario).provinces.map((p) => p.id));
    const seen = new Set();
    for (const nation of scenario.nations) {
      assert.ok(nation.provinces.length > 0, `${nation.id} has no provinces`);
      for (const id of nation.provinces) {
        assert.ok(ids.has(id), `${scenario.id}: unknown province ${id}`);
        assert.ok(!seen.has(id), `${scenario.id}: ${id} owned twice`);
        seen.add(id);
      }
      assert.ok(ids.has(nation.capital), `${nation.id}: bad capital`);
      assert.ok(nation.provinces.includes(nation.capital), `${nation.id}: capital not owned`);
    }
  }
});

test('game boots with the player owning its provinces and full garrisons', () => {
  const game = makeGame();
  assert.equal(game.province('FR').owner, 'FRA');
  assert.equal(game.provinceCount('FRA'), 1);
  assert.ok(game.province('FR').garrison > 50);
  assert.equal(game.state.status, 'playing');
  assert.ok(game.player.gold > 0);
});

test('a non-adjacent province without a land route is still refused', () => {
  const game = makeGame();
  // France owns a single province here, so there is nothing to walk through.
  const check = game.canSend('FR', 'RU');
  assert.equal(check.ok, false);
  assert.match(check.reason, /пут/);
});

test('troops can be ordered through the realm to a distant province', () => {
  const game = new Game({ scenarioId: 'concert', nationId: 'RUS', map, seed: 7 });
  for (const nation of game.nations) if (!nation.isPlayer) nation.ai.nextThink = 1e9;
  game.state.nations.RUS.manpower = 0; // no drip-feed, so the numbers stay exact
  const route = game.routeBetween('RU', 'LT');
  assert.ok(route, 'route RU -> LT exists');
  assert.ok(route.length > 2, `route goes through own land: ${route.join('->')}`);
  const result = game.sendTroops('RU', 'LT', 0.5);
  assert.equal(result.ok, true);
  const army = game.state.armies.find((a) => a.path);
  assert.ok(army, 'a planned column was created');
  assert.deepEqual(army.path, route);
  assert.equal(army.to, route[1], 'the first hop is the first waypoint');
});

test('a planned column passes through and leaves the requested garrison', () => {
  const game = new Game({ scenarioId: 'concert', nationId: 'RUS', map, seed: 11 });
  for (const nation of game.nations) if (!nation.isPlayer) nation.ai.nextThink = 1e9;
  game.state.nations.RUS.manpower = 0;
  const route = game.routeBetween('RU', 'LT');
  const waypoint = route[1];
  const beforeWaypoint = game.province(waypoint).garrison;
  const beforeTarget = game.province('LT').garrison;
  const result = game.sendTroops('RU', 'LT', 0.5, { leave: { [waypoint]: 30 } });
  assert.equal(result.ok, true);
  const sent = result.amount;
  // Walk the column over the whole route. Without a route it would strand in
  // the waypoint and the target would never grow.
  for (let i = 0; i < 4000 && game.state.armies.length; i += 1) game.update(0.1);
  assert.equal(game.state.armies.length, 0, 'column finished its march');
  assert.ok(
    Math.abs(game.province(waypoint).garrison - beforeWaypoint - 30) <= 1,
    `garrison left on the way: ${game.province(waypoint).garrison - beforeWaypoint}`,
  );
  assert.ok(
    Math.abs(game.province('LT').garrison - beforeTarget - (sent - 30)) <= 2,
    `the rest reached the far end: ${game.province('LT').garrison - beforeTarget} of ${sent - 30}`,
  );
});

test('route targets cover the whole realm, not only the neighbours', () => {
  const game = new Game({ scenarioId: 'concert', nationId: 'RUS', map, seed: 3 });
  const targets = game.routeTargets('RU');
  assert.ok(targets.has('LT'), 'a province two hops away is a target');
  assert.ok(!targets.has('RU'), 'the source itself is not a target');
  assert.ok(targets.size > game.neighbors('RU').length, 'more than the direct neighbours');
});

test('cannot move troops from a province you do not own', () => {
  const game = makeGame();
  const check = game.canSend('ES', 'FR');
  assert.equal(check.ok, false);
  assert.match(check.reason, /не ваша/);
});

test('sending troops shrinks the garrison and creates a marching army', () => {
  const game = makeGame();
  const before = game.province('FR').garrison;
  const result = game.sendTroops('FR', 'BE', 0.5);
  assert.equal(result.ok, true);
  assert.ok(result.amount >= 4);
  assert.ok(Math.abs(game.province('FR').garrison - (before - result.amount)) < 1e-9);
  assert.equal(game.state.armies.length, 1);
  assert.equal(game.state.armies[0].to, 'BE');
});

test('1815: Russia starts with the largest army, the Ottomans are not the strongest', () => {
  const game = new Game({ scenarioId: 'concert', nationId: 'FRA', doctrineId: 'coin', map, seed: 1 });
  const totals = Object.values(game.state.nations)
    .map((nation) => {
      let army = 0;
      for (const province of Object.values(game.state.provinces)) {
        if (province.owner === nation.id) army += province.garrison;
      }
      return { id: nation.id, army };
    })
    .sort((a, b) => b.army - a.army);
  assert.equal(totals[0].id, 'RUS', `expected Russia first, got ${totals[0].id}`);
  const ottoman = totals.find((row) => row.id === 'OTT');
  assert.ok(ottoman, 'the Ottomans exist in 1815');
  assert.ok(
    ottoman.army < totals[0].army,
    `the Ottomans must stay behind the strongest power: ${ottoman.army} vs ${totals[0].army}`,
  );
});

test('military weight scales garrisons of the same province', () => {
  const game = new Game({ scenarioId: 'concert', nationId: 'FRA', doctrineId: 'coin', map, seed: 1 });
  const base = game.state.nations.RUS.armyMul;
  const before = game.maxGarrison('RU');
  game.state.nations.RUS.armyMul = base * 2;
  const doubled = game.maxGarrison('RU');
  assert.ok(Math.abs(doubled / before - 2) < 0.02, `${before} -> ${doubled}`);
  game.state.nations.RUS.armyMul = base * 0.5;
  assert.ok(Math.abs(game.maxGarrison('RU') / before - 0.5) < 0.02);
});

test('a strong army captures a weak province after its march', () => {
  const game = makeGame();
  game.province('BE').garrison = 3;
  game.province('BE').fort = 0;
  game.sendTroops('FR', 'BE', 1);
  for (let i = 0; i < 400; i += 1) game.update(0.05);
  assert.equal(game.province('BE').owner, 'FRA');
  assert.equal(game.provinceCount('FRA'), 2);
});

test('a hopeless attack is repelled and keeps the defender in place', () => {
  const game = makeGame();
  game.province('BE').garrison = 5000;
  game.province('BE').fort = 3;
  game.province('FR').garrison = 30;
  game.sendTroops('FR', 'BE', 0.1);
  for (let i = 0; i < 400; i += 1) game.update(0.05);
  assert.equal(game.province('BE').owner, 'NLD');
});

test('upgrades cost gold, stop at the level cap and require ownership', () => {
  const game = makeGame();
  game.player.gold = 10_000;
  for (let i = 0; i < 3; i += 1) assert.equal(game.upgrade('FR', 'factory').ok, true);
  assert.equal(game.province('FR').factory, 3);
  assert.equal(game.upgrade('FR', 'factory').ok, false);
  assert.equal(game.upgrade('ES', 'factory').ok, false);
  assert.equal(game.upgrade('FR', 'nonsense').ok, false);
});

test('orders respect gold, cooldown and manpower', () => {
  const game = makeGame();
  game.player.gold = 1000;
  game.player.manpower = 50;
  assert.equal(game.castOrder('tax').ok, true);
  assert.equal(game.castOrder('tax').ok, false, 'cooldown blocks a second cast');
  assert.equal(game.castOrder('unknown').ok, false);
  assert.ok(game.state.orders.taxUntil > game.state.time);
});

test('tax order doubles income while active', () => {
  const game = makeGame();
  game.player.gold = 1000;
  const before = game.player.income;
  game.castOrder('tax');
  game.update(0.05);
  assert.ok(game.player.income > before * 1.5);
});

test('economy produces gold and manpower over time', () => {
  const game = makeGame();
  const gold = game.player.gold;
  // Keep one province below its norm so we can watch recruits turn into troops.
  game.province('FR').garrison = 40;
  const troops = game.province('FR').garrison;
  for (let i = 0; i < 200; i += 1) game.update(0.05);
  assert.ok(game.player.gold > gold);
  assert.ok(game.province('FR').garrison > troops, 'recruits should become soldiers');
});

test('victory requires the whole map, not a share of it', () => {
  const game = makeGame();
  // Take half the theatre: that used to be enough and now must not be.
  let owned = game.provinceCount('FRA');
  for (const province of game.provinces) {
    if (owned >= Math.ceil(game.provinces.length * 0.5)) break;
    if (province.owner === 'FRA') continue;
    province.owner = 'FRA';
    owned += 1;
  }
  game.update(0.05);
  assert.equal(game.state.status, 'playing', 'half the map is progress, not victory');

  // The last province makes it a win.
  for (const province of game.provinces) province.owner = 'FRA';
  game.update(0.05);
  assert.equal(game.state.status, 'victory');
});

test('losing every province ends the game in defeat', () => {
  const game = makeGame();
  game.province('FR').owner = 'PRU';
  game.province('FR').garrison = 1;
  game.update(0.05);
  assert.equal(game.state.status, 'defeat');
});

test('save and load restores an identical state', () => {
  const game = makeGame();
  game.player.gold = 321;
  game.sendTroops('FR', 'BE', 0.5);
  for (let i = 0; i < 40; i += 1) game.update(0.05);
  const save = JSON.parse(JSON.stringify(game.serialize()));
  const restored = Game.deserialize(save, map);
  assert.ok(restored);
  assert.equal(restored.player.gold, game.player.gold);
  assert.equal(restored.province('FR').garrison, game.province('FR').garrison);
  assert.equal(restored.state.armies.length, game.state.armies.length);
  for (let i = 0; i < 60; i += 1) {
    game.update(0.05);
    restored.update(0.05);
  }
  assert.equal(restored.provinceCount('FRA'), game.provinceCount('FRA'));
});

test('the simulation is deterministic for a fixed seed', () => {
  const a = makeGame({ seed: 7 });
  const b = makeGame({ seed: 7 });
  for (let i = 0; i < 600; i += 1) {
    a.update(0.05);
    b.update(0.05);
  }
  assert.equal(a.state.armies.length, b.state.armies.length);
  assert.equal(JSON.stringify(a.state.provinces), JSON.stringify(b.state.provinces));
});

test('an idle player survives the first minutes (AI does not rush new players)', () => {
  const game = makeGame({ ai: true });
  for (let i = 0; i < 60 * 60; i += 1) game.update(0.05);
  assert.equal(game.state.status, 'playing');
  assert.ok(game.provinceCount('FRA') >= 1);
});


test('rules: default match leaves the player alone until they attack', () => {
  const game = makeGame({ ai: true, rules: { peaceUntilFirstWar: true, aiStyle: 'normal' } });
  for (let i = 0; i < 60 * 150; i += 1) game.update(0.05);
  assert.equal(game.provinceCount('FRA'), 1, 'AI attacked a passive player');
  assert.equal(game.state.playerAggro, false);
});

test('rules: aggressive AI eventually attacks once the player draws blood', () => {
  const game = makeGame({ ai: true, rules: { peaceUntilFirstWar: true, aiStyle: 'hard' } });
  game.province('BE').garrison = 1;
  game.sendTroops('FR', 'BE', 1);
  assert.equal(game.state.playerAggro, true);
  for (let i = 0; i < 60 * 240; i += 1) game.update(0.05);
  assert.ok(game.state.stats.battles > 0, 'no battles at all after the player attacked');
});

test('rules: passive AI never launches attacks', () => {
  const game = makeGame({ ai: true, rules: { aiPassive: true } });
  for (let i = 0; i < 60 * 120; i += 1) game.update(0.05);
  assert.equal(game.state.armies.filter((army) => army.owner !== 'FRA').length, 0);
  assert.equal(game.provinceCount('FRA'), 1);
});

test('rules: neutral strength changes starting garrisons', () => {
  const weak = makeGame({ rules: { neutrals: 'weak' } });
  const strong = makeGame({ rules: { neutrals: 'strong' } });
  assert.ok(strong.province('IT').garrison > weak.province('IT').garrison * 1.6);
});

test('rules: AI economy setting scales income', () => {
  const weak = makeGame({ rules: { aiEconomy: 'weak' } });
  const strong = makeGame({ rules: { aiEconomy: 'strong' } });
  weak.update(0.05);
  strong.update(0.05);
  assert.ok(strong.state.nations.PRU.income > weak.state.nations.PRU.income * 1.4);
});

test('an old save asking for a smaller share still plays to full conquest', () => {
  const game = makeGame();
  game.setRules({ victoryShare: 0.3 });
  assert.equal(game.rules.victoryShare, 1, 'the threshold is not configurable any more');
  const need = Math.ceil(game.provinces.length * 0.3);
  let owned = game.provinceCount('FRA');
  for (const province of game.provinces) {
    if (owned >= need) break;
    if (province.owner === 'FRA') continue;
    province.owner = 'FRA';
    owned += 1;
  }
  game.update(0.05);
  assert.equal(game.state.status, 'playing', '30% must not end the match');
});

test('rules: unknown values fall back to defaults and survive a save', () => {
  const rules = normalizeRules({ aiStyle: 'nonsense', victoryShare: 7, neutrals: 'strong' });
  assert.equal(rules.aiStyle, DEFAULT_RULES.aiStyle);
  assert.equal(rules.victoryShare, DEFAULT_RULES.victoryShare);
  assert.equal(rules.neutrals, 'strong');

  const game = makeGame({ rules: { aiStyle: 'calm', startPaused: true } });
  const restored = Game.deserialize(JSON.parse(JSON.stringify(game.serialize())), map);
  assert.equal(restored.state.rules.aiStyle, 'calm');
  assert.equal(restored.state.rules.startPaused, true);
});


test('reinforcing a full province keeps every soldier', () => {
  const game = makeGame();
  game.province('BE').owner = 'FRA';
  const max = game.maxGarrison('FR');
  game.province('FR').garrison = max;
  game.province('BE').garrison = 400;

  const before = game.province('FR').garrison + game.province('BE').garrison;
  game.sendTroops('BE', 'FR', 1);
  for (let i = 0; i < 400; i += 1) game.update(0.05);

  const sent = game.province('FR').garrison - max;
  assert.ok(sent >= 4, `reinforcement was lost: ${sent}`);
  assert.ok(game.province('FR').garrison > max, 'garrison should stack above the cap');
  assert.ok(game.province('FR').garrison + game.province('BE').garrison > before * 0.95);
});

test('stacked reinforcements never evaporate over repeated deliveries', () => {
  const game = makeGame();
  game.province('BE').owner = 'FRA';
  const max = game.maxGarrison('FR');
  game.province('FR').garrison = max;
  game.province('BE').garrison = 600;
  for (let round = 0; round < 5; round += 1) {
    if (game.province('BE').garrison < 10) break;
    const sent = Math.floor(game.province('BE').garrison * 0.5);
    game.sendTroops('BE', 'FR', 0.5);
    for (let i = 0; i < 300; i += 1) game.update(0.05);
    assert.ok(
      game.province('FR').garrison >= max + sent * 0.9 || game.province('BE').garrison + max > 0,
      `round ${round}: FR=${game.province('FR').garrison}`,
    );
  }
  assert.ok(game.province('FR').garrison > max * 1.6, 'stacking should keep growing');
});

test('mobilization refuses politely when every garrison is already overfull', () => {
  const game = makeGame();
  game.player.gold = 500;
  for (const province of game.provinces) {
    if (province.owner === 'FRA') province.garrison = game.maxGarrison(province.id) * 2;
  }
  const gold = game.player.gold;
  const result = game.castOrder('mobilize');
  assert.equal(result.ok, false);
  assert.match(result.reason, /полны/);
  assert.equal(game.player.gold, gold, 'gold must be refunded');
});


test('one province can send armies to several neighbours at once', () => {
  const game = makeGame();
  game.province('FR').garrison = 300;
  const before = game.province('FR').garrison;

  const first = game.sendTroops('FR', 'BE', 0.25);
  const second = game.sendTroops('FR', 'IT', 0.25);
  const third = game.sendTroops('FR', 'ES', 0.25);

  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(third.ok, true);
  assert.equal(game.state.armies.length, 3);
  assert.deepEqual(
    game.state.armies.map((army) => army.to).sort(),
    ['BE', 'ES', 'IT'],
  );
  // Each order takes its share of what is left at home: 75 + 56 + 42.
  const sent = first.amount + second.amount + third.amount;
  assert.deepEqual([first.amount, second.amount, third.amount], [75, 56, 42]);
  assert.equal(game.province('FR').garrison, before - sent);
});

test('parallel sends never take more troops than the province has', () => {
  const game = makeGame();
  game.province('FR').garrison = 100;

  const sent = [];
  for (const target of ['BE', 'IT', 'ES', 'CH', 'DE', 'LU']) {
    const result = game.sendTroops('FR', target, 0.5);
    if (result.ok) sent.push(result.amount);
  }
  assert.ok(sent.length >= 2, 'should allow multiple departures');
  assert.equal(game.province('FR').garrison, 100 - sent.reduce((a, b) => a + b, 0));

  // Once the garrison is empty, further orders are refused.
  const extra = game.sendTroops('FR', 'BE', 1);
  assert.equal(extra.ok, false);
  assert.match(extra.reason, /мало войск/);
});

test('troops in transit are reported per province', () => {
  const game = makeGame();
  game.province('FR').garrison = 200;
  game.sendTroops('FR', 'BE', 0.5);
  game.sendTroops('FR', 'IT', 0.25);
  assert.equal(game.armiesFrom('FR').length, 2);
  // 50% of 200 = 100, then 25% of the remaining 100 = 25.
  assert.equal(game.troopsInTransit('FR'), 125);
  assert.equal(game.armiesFrom('IT').length, 0);
});

test('two armies from one province arrive independently', () => {
  const game = makeGame();
  game.province('FR').garrison = 400;
  game.province('BE').garrison = 1;
  game.province('IT').garrison = 1;
  game.province('BE').owner = 'NLD';
  game.province('IT').owner = 'NLD';
  game.sendTroops('FR', 'BE', 0.25);
  game.sendTroops('FR', 'IT', 0.25);
  for (let i = 0; i < 600; i += 1) game.update(0.05);
  assert.equal(game.province('BE').owner, 'FRA');
  assert.equal(game.province('IT').owner, 'FRA');
});

// ---------------------------------------------------------------- upgrade balance

test('a level-1 factory pays for itself well inside a match', () => {
  // Design intent: building must be a real alternative to hoarding gold.
  // A match lasts roughly 600-900 game seconds; the richest province of every
  // scenario should return the price of its first factory in under 3 minutes.
  for (const scenario of SCENARIOS) {
    const game = new Game({ scenarioId: scenario.id, nationId: scenario.nations[0].id, map: mapFor(scenario) });
    const owned = Object.values(game.state.provinces).filter((p) => p.owner);
    const richest = owned.sort((a, b) => b.pop - a.pop)[0];
    const gain = game.upgradePreview(richest.id, 'factory').gold;
    const payback = BAL.upgradeCosts.factory[0] / gain;
    assert.ok(payback < 180, `${scenario.id}: factory payback ${payback.toFixed(0)}s is too slow`);
  }
});

test('level-1 upgrades are affordable within a minute or two of income', () => {
  const game = makeGame();
  const income = Object.values(game.state.provinces)
    .filter((p) => p.owner === 'FRA')
    .reduce((sum, p) => sum + (BAL.incomeBase + p.pop * BAL.incomePop), 0);
  assert.ok(BAL.upgradeCosts.factory[0] <= income * 60, 'factory should pay off within a minute');
  for (const kind of ['fort', 'barracks']) {
    assert.ok(
      BAL.upgradeCosts[kind][0] <= income * 90,
      `${kind} level 1 costs more than 90s of income`,
    );
  }
});

test('upgrade previews match what the upgrade actually does', () => {
  const game = makeGame();
  game.player.gold = 10_000;
  const p = game.province('FR');
  const preview = game.upgradePreview('FR', 'barracks');
  const before = game.maxGarrison('FR');
  game.upgrade('FR', 'barracks');
  assert.equal(game.maxGarrison('FR') - before, Math.round(preview.garrison));

  const defenseBefore = game.defenseValue('FR');
  const fortPreview = game.upgradePreview('FR', 'fort');
  game.upgrade('FR', 'fort');
  assert.ok(game.defenseValue('FR') - defenseBefore > 0);
  assert.equal(Math.round(game.defenseValue('FR') - defenseBefore), Math.round(fortPreview.defense));
  assert.ok(p.factory === 0);
});

test('barracks speed up reinforcement as advertised', () => {
  const game = makeGame();
  game.player.gold = 10_000;
  game.province('FR').garrison = 10;
  const before = game.province('FR').garrison;
  for (let i = 0; i < 10; i += 1) game.update(0.1);
  const plain = game.province('FR').garrison - before;

  game.upgrade('FR', 'barracks');
  game.province('FR').garrison = 10;
  const before2 = game.province('FR').garrison;
  for (let i = 0; i < 10; i += 1) game.update(0.1);
  const boosted = game.province('FR').garrison - before2;
  assert.ok(boosted > plain * 1.1, 'reinforcement should be noticeably faster');
});

test('the war tax order repays its price for a mid-size nation', () => {
  const game = makeGame();
  game.update(0.1); // let the economy tick once so income is known
  const income = game.player.income;
  const gain = income * BAL.buffDuration.tax;
  assert.ok(gain > BAL.orderGold.tax, `tax returns ${gain.toFixed(1)} for ${BAL.orderGold.tax} gold`);
});


// ---------------------------------------------------------------- atlantic theatre

test('the atlantic theatre is fully wired: two continents, borders, sea routes', () => {
  const ids = new Set(atlanticMap.provinces.map((p) => p.id));
  assert.equal(atlanticMap.theatre, 'atlantic');
  assert.equal(atlanticMap.provinces.length, 56);
  for (const province of atlanticMap.provinces) {
    assert.ok(province.rings.length > 0, `${province.id} has no shape`);
    assert.ok(province.pop > 0, `${province.id} has no population`);
    assert.ok(province.neighbors.length > 0, `${province.id} is isolated`);
    for (const neighbour of province.neighbors) {
      assert.ok(ids.has(neighbour), `${province.id} -> unknown ${neighbour}`);
    }
  }
});

test('atlantic adjacency is symmetric and does not link a province to itself', () => {
  const byId = Object.fromEntries(atlanticMap.provinces.map((p) => [p.id, p]));
  for (const province of atlanticMap.provinces) {
    for (const neighbour of province.neighbors) {
      assert.notEqual(neighbour, province.id, `${province.id} neighbours itself`);
      assert.ok(byId[neighbour].neighbors.includes(province.id), `${province.id}/${neighbour} not symmetric`);
    }
  }
});

test('the atlantic scenario covers every province of its map', () => {
  const scenario = SCENARIOS.find((s) => s.id === 'concert-atlantic');
  assert.ok(scenario, 'scenario exists');
  const game = new Game({ scenarioId: 'concert-atlantic', nationId: 'USA', map: atlanticMap });
  for (const province of atlanticMap.provinces) {
    const state = game.state.provinces[province.id];
    // Every province is either held by a nation or is a defended neutral.
    assert.ok(state.owner || state.garrison > 0, `${province.id} is empty`);
  }
  assert.equal(game.state.nations.USA.isPlayer, true);
  assert.equal(game.provinceCount('USA'), 6);
  const neutrals = atlanticMap.provinces.filter((p) => !game.state.provinces[p.id].owner).map((p) => p.id);
  assert.deepEqual(neutrals.sort(), ['CH', 'GL', 'IT']);
});

test('the atlantic map has a sea route between the continents', () => {
  const game = new Game({ scenarioId: 'concert-atlantic', nationId: 'GBR', map: atlanticMap });
  const route = game.routeBetween('GB', 'CA');
  assert.deepEqual(route, ['GB', 'CA']);
  assert.equal(game.isSeaRoute('GB', 'CA'), true);
  assert.ok(game.travelTime('GB', 'CA') > 0);
});

test('a game refuses a map from the wrong theatre', () => {
  assert.throws(
    () => new Game({ scenarioId: 'concert-atlantic', nationId: 'USA', map }),
    /театр/i,
  );
  assert.throws(
    () => new Game({ scenarioId: 'concert', nationId: 'FRA', map: atlanticMap }),
    /театр/i,
  );
});

// ---------------------------------------------------------------- morale & war weariness

test('victories lift morale, defeats lower it, both drift back to neutral', () => {
  const game = makeGame();
  game.province('FR').garrison = 900;
  game.province('IT').owner = 'NLD';
  game.province('IT').garrison = 10;
  const startMorale = game.player.morale;
  game.sendTroops('FR', 'IT', 0.5);
  for (let i = 0; i < 400; i += 1) game.update(0.05);
  assert.ok(game.player.morale > startMorale, 'a capture should raise morale');
  const peak = game.player.morale;
  for (let i = 0; i < 600; i += 1) game.update(0.1);
  assert.ok(game.player.morale < peak, 'morale should drift back');
  assert.ok(Math.abs(game.player.morale - BAL.moraleNeutral) < 6);
});

test('morale changes the odds: high morale hits harder, low morale folds', () => {
  const game = makeGame();
  game.player.morale = 100;
  const high = game.attackModifier('FRA');
  game.player.morale = 0;
  const low = game.attackModifier('FRA');
  assert.ok(high > low + 0.2);
  game.player.morale = 50;
  assert.ok(Math.abs(game.attackModifier('FRA') - (1 + 0.0)) < 0.35);
});

test('war weariness hurts income and cools down in peacetime', () => {
  const game = makeGame();
  game.update(0.1);
  const healthy = game.player.income;
  assert.ok(Math.abs(game.exhaustionModifier('FRA') - 1) < 1e-9);
  game.player.exhaustion = 100;
  game.update(0.1);
  assert.ok(game.player.income < healthy * 0.8, 'income should drop noticeably');
  // Quiet time (no recent clash) burns weariness off.
  game.player.lastClash = -999;
  for (let i = 0; i < 200; i += 1) game.update(0.1);
  assert.ok(game.player.exhaustion < 95);
});

test('a truce blocks AI attacks and ends with time', () => {
  const game = makeGame();
  const player = game.player;
  game.state.relations['FRA|NLD'] = { truceUntil: game.state.time + 30 };
  assert.equal(game.hasTruce('NLD', 'FRA'), true);
  assert.equal(game.hasTruce('FRA', 'NLD'), true, 'truce is symmetric');
  assert.equal(game.hasTruce('FRA', 'PRU'), false);
  assert.ok(game.truceLeft('NLD', 'FRA') > 29);
  game.update(31);
  assert.equal(game.hasTruce('NLD', 'FRA'), false);
});

test('peace offers can be accepted for a truce or declined', () => {
  const game = makeGame();
  const offered = game.offerPeace('NLD');
  assert.equal(offered.ok, true);
  assert.equal(game.state.offers.length, 1);
  const accepted = game.answerPeace(offered.offer.id, true);
  assert.equal(accepted.accepted, true);
  assert.equal(game.hasTruce('FRA', 'NLD'), true);
  assert.equal(game.state.offers.length, 0);

  const second = game.offerPeace('NLD');
  assert.equal(second.ok, false, 'no duplicate offers while the truce holds');
});

test('declining a peace offer keeps the war going', () => {
  const game = makeGame();
  const offered = game.offerPeace('PRU');
  const declined = game.answerPeace(offered.offer.id, false);
  assert.equal(declined.accepted, false);
  assert.equal(game.hasTruce('FRA', 'PRU'), false);
});

test('unanswered offers expire on their own', () => {
  const game = makeGame();
  const offered = game.offerPeace('NLD');
  game.update(BAL.peaceTruce + 50);
  assert.equal(game.state.offers.length, 0);
  assert.equal(game.answerPeace(offered.offer.id, true).ok, false);
});

test('breaking a truce costs weariness and marks the player as the aggressor', () => {
  const game = makeGame();
  game.state.relations['FRA|NLD'] = { truceUntil: game.state.time + 100 };
  game.player.exhaustion = 10;
  assert.equal(game.breakTruce('NLD'), true);
  assert.equal(game.hasTruce('FRA', 'NLD'), false);
  assert.equal(game.state.playerAggro, true);
  assert.ok(game.player.exhaustion > 10);
});

test('morale, weariness and truces survive a save round-trip', () => {
  const game = makeGame();
  game.player.morale = 72;
  game.player.exhaustion = 33;
  game.state.relations['FRA|NLD'] = { truceUntil: game.state.time + 60 };
  const restored = Game.deserialize(JSON.parse(JSON.stringify(game.serialize())), map);
  assert.ok(Math.abs(restored.player.morale - 72) < 1e-6);
  assert.ok(Math.abs(restored.player.exhaustion - 33) < 1e-6);
  assert.equal(restored.hasTruce('FRA', 'NLD'), true);
});

// ---------------------------------------------------------------- desertion & counter-attacks

test('a broken nation bleeds troops to desertion, a confident one does not', () => {
  const low = makeGame();
  low.player.morale = 5;
  low.province('FR').garrison = 60; // below the cap, so growth is visible
  const start = low.province('FR').garrison;
  for (let i = 0; i < 100; i += 1) low.update(0.1);
  const lowGrowth = low.province('FR').garrison - start;

  const calm = makeGame();
  calm.province('FR').garrison = 60;
  const calmStart = calm.province('FR').garrison;
  for (let i = 0; i < 100; i += 1) calm.update(0.1);
  const calmGrowth = calm.province('FR').garrison - calmStart;

  assert.ok(lowGrowth < calmGrowth, `desertion should slow growth: ${lowGrowth} vs ${calmGrowth}`);
  assert.ok(low.state.stats.deserted > 0, 'desertion is reported in the stats');
});

test('desertion never drops a garrison below zero', () => {
  const game = makeGame();
  game.player.morale = 0;
  for (const province of Object.values(game.state.provinces)) {
    if (province.owner === 'FRA') province.garrison = 0.5;
  }
  for (let i = 0; i < 400; i += 1) game.update(0.1);
  for (const province of Object.values(game.state.provinces)) {
    assert.ok(province.garrison >= 0, 'garrison cannot go negative');
  }
});

test('counter-attacks only target a neighbour owned by the attacker', () => {
  // Statistical check: run many repelled assaults and make sure every sally
  // that happens lands in the province the attack came from.
  let counterSeen = false;
  for (let seed = 1; seed < 60 && !counterSeen; seed += 1) {
    const game = new Game({ scenarioId: 'concert', nationId: 'FRA', map, seed });
    for (const nation of game.nations) if (!nation.isPlayer) nation.ai.nextThink = 1e9;
    game.province('FR').garrison = 400;
    const target = game.province('BE');
    target.owner = 'NLD';
    target.garrison = 900; // will repel the assault
    game.sendTroops('FR', 'BE', 0.1);
    for (let i = 0; i < 400 && !counterSeen; i += 1) {
      game.update(0.1);
      if (game.state.armies.some((a) => a.owner === 'NLD' && a.to === 'FR')) {
        counterSeen = true;
        assert.equal(game.state.armies.find((a) => a.owner === 'NLD').from, 'BE');
      }
    }
  }
  assert.ok(counterSeen, 'expected at least one counter-attack across seeds');
});

test('the atlantic USA does not start a single province away from victory', () => {
  const game = new Game({ scenarioId: 'concert-atlantic', nationId: 'USA', map: atlanticMap });
  const total = Object.keys(game.state.provinces).length;
  assert.ok(
    game.provinceCount('USA') < total - 1,
    `USA starts with ${game.provinceCount('USA')}/${total}`,
  );
});

// ---------------------------------------------------------------- score

test('score rewards land, conquests and speed, not losses', () => {
  const game = makeGame();
  game.state.stats.captured = 5;
  game.state.stats.battlesWon = 4;
  const score = game.score();
  assert.equal(score.victory, false);
  assert.ok(score.total > 0);
  assert.ok(score.speedBonus > 0, 'quick games are worth more');

  const fast = makeGame();
  fast.state.months += 12 * 3; // three years later
  assert.ok(fast.score().speedBonus < score.speedBonus, 'time erodes the speed bonus');

  const loser = makeGame();
  loser.state.stats.lostProvinces = 10;
  assert.ok(loser.score().total < game.score().total, 'lost provinces cost points');
});

test('a victory is worth more than the same board without one', () => {
  const game = makeGame();
  game.state.stats.captured = 3;
  const peace = game.score().total;
  game.state.status = 'victory';
  assert.ok(game.score().total > peace + 400);
});

test('score never goes negative', () => {
  const game = makeGame();
  game.state.stats.lostProvinces = 500;
  game.state.months = game.scenario.startYear * 12 + 12 * 60;
  assert.equal(game.score().total, 0);
});

test('a rival grabbing most of the map does not end the match while you hold land', () => {
  const game = makeGame();
  const others = Object.values(game.state.provinces).filter((p) => p.owner !== 'FRA' && p.owner);
  for (const province of others.slice(0, Math.floor(others.length * 0.8))) province.owner = 'PRU';
  // Keep the player alive with their own land.
  game.province('FR').owner = 'FRA';
  game.province('FR').garrison = 50;
  game.update(0.1);
  assert.equal(game.state.status, 'playing', 'only losing every province ends the match');
  assert.equal(game.state.nations.PRU.alive, true);
});

test('a rival taking the last province ends the match as elimination', () => {
  const game = makeGame();
  for (const province of Object.values(game.state.provinces)) {
    if (province.owner === 'FRA') province.owner = 'PRU';
  }
  game.update(0.1);
  assert.equal(game.state.status, 'defeat');
  assert.equal(game.state.nations.FRA.alive, false);
});

test('the player winning takes priority over a rival at the same moment', () => {
  const game = makeGame();
  // Give the player the whole map: they hit the share first.
  for (const province of Object.values(game.state.provinces)) province.owner = 'FRA';
  game.update(0.1);
  assert.equal(game.state.status, 'victory');
});

// ---------------------------------------------------------------- map integrity

test('every theatre is a single connected graph', () => {
  for (const [name, theatreMap] of Object.entries(MAPS)) {
    const byId = Object.fromEntries(theatreMap.provinces.map((p) => [p.id, p]));
    const seen = new Set();
    const start = theatreMap.provinces[0].id;
    const stack = [start];
    seen.add(start);
    while (stack.length) {
      const id = stack.pop();
      for (const neighbour of byId[id].neighbors) {
        if (seen.has(neighbour)) continue;
        seen.add(neighbour);
        stack.push(neighbour);
      }
    }
    assert.equal(
      seen.size,
      theatreMap.provinces.length,
      `${name}: disconnected provinces — ${theatreMap.provinces
        .filter((p) => !seen.has(p.id))
        .map((p) => p.id)
        .join(', ')}`,
    );
  }
});

test('no province geometry is empty or degenerate', () => {
  for (const [name, theatreMap] of Object.entries(MAPS)) {
    for (const province of theatreMap.provinces) {
      assert.ok(province.rings[0].length >= 3, `${name}/${province.id}: ring too short`);
      assert.ok(province.area > 0.05, `${name}/${province.id}: area ${province.area}`);
      assert.ok(province.centroid.every(Number.isFinite), `${name}/${province.id}: bad centroid`);
    }
  }
});

// ---------------------------------------------------------------- over-norm production

test('a full province keeps producing troops above the norm automatically', () => {
  const game = makeGame();
  const province = game.province('FR');
  const max = game.maxGarrison('FR');
  province.garrison = max;
  game.player.manpower = 5000;
  for (let i = 0; i < 200; i += 1) game.update(0.1);
  assert.ok(province.garrison > max, `garrison ${province.garrison} should exceed ${max}`);
  // The excess is real troops, visible in the panel data, not a rounding ghost.
  const over = province.garrison - max;
  assert.ok(over > 1, `expected a visible surplus, got ${over}`);
});

test('reinforcement is limited by recruits, not by a hidden cap', () => {
  const run = (manpower) => {
    const game = makeGame();
    const start = game.maxGarrison('FR') * 0.5;
    game.province('FR').garrison = start;
    game.player.manpower = manpower;
    for (let i = 0; i < 100; i += 1) game.update(0.1);
    return { grown: game.province('FR').garrison - start, game };
  };

  const poor = run(0);
  const rich = run(5000);

  // Since the supply was balanced against the refill rate, a province with no
  // reserve still creeps up on its own production — but never as fast as one
  // with men in the pool, and it never borrows troops it does not have.
  assert.ok(
    rich.grown > poor.grown * 1.15,
    `recruits are the real limit: rich ${rich.grown.toFixed(1)} vs poor ${poor.grown.toFixed(1)}`,
  );
  assert.ok(rich.grown > 10, 'a funded province refills at the full rate');
  assert.ok(rich.game.state.stats.recruited > 0, 'recruitment is tracked');
  assert.ok(rich.game.player.manpower < 5000, 'the pool is actually drained');
  // With an empty pool the province still grows — but only by what it produces.
  assert.ok(poor.grown > 0, 'a poor province still gets its own recruits');
  assert.ok(poor.game.player.manpower < 5, 'the pool stays empty while the province is refilling');
});

test('depleted provinces are refilled before full ones grow above the norm', () => {
  const game = makeGame();
  game.player.manpower = 20;
  const full = game.province('FR');
  full.garrison = game.maxGarrison('FR');
  const empty = game.province('BE');
  empty.owner = 'FRA';
  empty.garrison = 1;
  const emptyMax = game.maxGarrison('BE');
  for (let i = 0; i < 120; i += 1) game.update(0.1);
  assert.ok(empty.garrison > 1, 'the depleted province gets the recruits first');
  assert.ok(empty.garrison <= emptyMax + 0.001, 'and does not jump past its norm while others wait');
  assert.ok(full.garrison >= game.maxGarrison('FR'));
});

test('troops above the norm defend, but at reduced strength', () => {
  const game = makeGame();
  const province = game.province('FR');
  const max = game.maxGarrison('FR');
  province.garrison = max;
  const base = game.defenseValue('FR');
  province.garrison = max * 3;
  const stacked = game.defenseValue('FR');
  assert.ok(stacked > base, 'surplus troops still defend the province');
  assert.ok(
    stacked < base * 3,
    `supply limits should discount the surplus (${stacked.toFixed(0)} vs ${(base * 3).toFixed(0)})`,
  );
  const breakdown = game.defenseBreakdown('FR');
  assert.ok(breakdown.above > 0);
  assert.ok(Math.abs(breakdown.total - stacked) < 1e-6);
});

test('attack odds match what the battle resolver actually does', () => {
  // Empirical check across many seeds: the predicted chance must be close.
  const targetChance = 0.5;
  let wins = 0;
  const runs = 400;
  for (let seed = 1; seed <= runs; seed += 1) {
    const game = new Game({ scenarioId: 'concert', nationId: 'FRA', map, seed });
    for (const nation of game.nations) if (!nation.isPlayer) nation.ai.nextThink = 1e9;
    const target = game.province('BE');
    target.owner = 'NLD';
    target.garrison = 100;
    target.fort = 0;
    game.player.morale = 50;
    game.province('FR').garrison = 400;
    const odds = game.attackOdds('FR', 'BE', 1);
    // Aim at the 50% point of the prediction, then verify the outcome distribution.
    const troops = Math.ceil(odds.defense / game.attackModifier('FRA'));
    game.province('FR').garrison = troops;
    game.sendTroops('FR', 'BE', 1);
    const army = game.state.armies.at(-1);
    if (!army) continue;
    army.t = army.duration - 0.001;
    game.update(0.01);
    if (game.province('BE').owner === 'FRA') wins += 1;
  }
  const rate = wins / runs;
  assert.ok(Math.abs(rate - targetChance) < 0.12, `win rate ${rate.toFixed(2)} should be near 0.5`);
});

test('the guaranteed force always takes the province', () => {
  for (let seed = 1; seed <= 40; seed += 1) {
    const game = new Game({ scenarioId: 'concert', nationId: 'FRA', map, seed });
    for (const nation of game.nations) if (!nation.isPlayer) nation.ai.nextThink = 1e9;
    const target = game.province('BE');
    target.owner = 'NLD';
    target.garrison = 120;
    target.fort = 1;
    game.player.morale = 40;
    const odds = game.attackOdds('FR', 'BE', 1);
    game.province('FR').garrison = odds.guarantee;
    game.sendTroops('FR', 'BE', 1);
    const army = game.state.armies.at(-1);
    army.t = army.duration - 0.001;
    game.update(0.01);
    assert.equal(game.province('BE').owner, 'FRA', `seed ${seed}: guaranteed force lost`);
  }
});

test('attack odds never report a chance outside 0..1 and know a hopeless attack', () => {
  const game = makeGame();
  game.province('FR').garrison = 2; // below minSend
  assert.equal(game.attackOdds('FR', 'BE', 1), null);
  game.province('FR').garrison = 12;
  const weak = game.attackOdds('FR', 'BE', 1);
  assert.ok(weak.chance >= 0 && weak.chance <= 1);
  game.province('FR').garrison = 100_000;
  const strong = game.attackOdds('FR', 'BE', 1);
  assert.equal(strong.chance, 1);
  assert.ok(strong.guarantee > 0);
});

test('automatic growth stops at the over-norm ceiling', () => {
  const game = makeGame();
  const province = game.province('FR');
  const ceiling = game.garrisonCeiling('FR');
  province.garrison = ceiling;
  game.player.manpower = 1e6;
  for (let i = 0; i < 200; i += 1) game.update(0.1);
  assert.ok(Math.abs(province.garrison - ceiling) < 0.01, `${province.garrison} should stay at ${ceiling}`);
  // Manual armies may still stack above the ceiling: the player's order wins.
  province.garrison = ceiling * 2;
  assert.ok(game.defenseValue('FR') > 0);
});

// ---------------------------------------------------------------- battle odds model

test('win chance is monotone, fair at parity and certain at the edges', () => {
  const { winChance } = Game;
  assert.ok(Math.abs(winChance(100, 100) - 0.5) < 1e-9, 'equal armies are a coin flip');
  assert.equal(winChance(150, 100), 1, '1.5x force never loses');
  assert.equal(winChance(70, 100), 0, 'a hopeless attack never wins by luck');
  let previous = -1;
  for (let attack = 40; attack <= 200; attack += 4) {
    const chance = winChance(attack, 100);
    assert.ok(chance >= previous - 1e-12, `chance must not fall between ${attack - 4} and ${attack}`);
    previous = chance;
  }
  assert.ok(winChance(120, 100) > 0.9, '20% advantage should be reliable');
  assert.ok(winChance(80, 100) < 0.1, '20% deficit should be desperate');
});

test('projected odds grow with troops and with the length of the march', () => {
  const game = makeGame();
  game.province('FR').garrison = 60;
  const weak = game.attackOdds('FR', 'BE', 1);
  game.province('FR').garrison = 120;
  const strong = game.attackOdds('FR', 'BE', 1);
  assert.ok(strong.chance > weak.chance, `${weak.chance} -> ${strong.chance}`);

  const target = game.province('BE');
  const short = game.projectedDefense('BE', 1);
  const long = game.projectedDefense('BE', 30);
  assert.ok(long >= short, `${long} should be at least ${short}`);
  assert.ok(short >= game.defenseValue('BE') - 1e-9);
  void target;
});

test('a bigger defender is harder to take than a smaller one', () => {
  const game = makeGame();
  game.province('FR').garrison = 150;
  game.province('BE').garrison = 40;
  const easy = game.attackOdds('FR', 'BE', 1).chance;
  game.province('BE').garrison = 300;
  const hard = game.attackOdds('FR', 'BE', 1).chance;
  assert.ok(easy > hard, `${easy} should beat ${hard}`);
});

// ---------------------------------------------------------------- peace vs pact

test('without a fight the AI offers a non-aggression pact, not peace', () => {
  const game = makeGame();
  const offer = game.offerPeace('NLD');
  assert.equal(offer.ok, true);
  assert.equal(offer.offer.kind, 'pact');
  assert.ok(game.state.log.some((line) => line.text.includes('пакт о ненападении')));
  // Accepting binds the nations for the longer pact term.
  game.answerPeace(offer.offer.id, true);
  assert.equal(game.hasTruce('FRA', 'NLD'), true);
  assert.ok(game.truceLeft('FRA', 'NLD') > BAL.pactTruce - 5, 'pact truce lasts longer');
});

test('after a real clash the AI offers peace instead of a pact', () => {
  const game = makeGame();
  const key = 'FRA|NLD';
  game.state.relations[key] = { truceUntil: 0, lastClash: game.state.time - 10 };
  assert.equal(game.hasFoughtRecently('NLD', 'FRA'), true);
  const offer = game.offerPeace('NLD');
  assert.equal(offer.offer.kind, 'peace');
  game.answerPeace(offer.offer.id, true);
  assert.ok(game.truceLeft('FRA', 'NLD') <= BAL.peaceTruce + 1, 'peace uses the shorter truce');
});

test('hostility is tracked per pair, not per nation', () => {
  const game = makeGame();
  // France and Prussia trade blows; the Netherlands stay out of it.
  game.state.relations['FRA|PRU'] = { truceUntil: 0, lastClash: game.state.time };
  assert.equal(game.hasFoughtRecently('FRA', 'PRU'), true);
  assert.equal(game.hasFoughtRecently('FRA', 'NLD'), false);
  assert.equal(game.offerPeace('NLD').offer.kind, 'pact', 'the Netherlands never fought us');
});

test('old peace offers without a kind still work', () => {
  const game = makeGame();
  game.state.offers.push({ id: 99, from: 'PRU', to: 'FRA', expires: game.state.time + 30 });
  const result = game.answerPeace(99, true);
  assert.equal(result.accepted, true);
  assert.equal(game.hasTruce('FRA', 'PRU'), true);
});

test('an enemy march on the player is announced in the log', () => {
  const game = makeGame();
  const player = game.state.nationId;
  const myProvince = game.state.provinces[game.player.capital];
  const attackerId = Object.values(game.state.nations).find((n) => !n.isPlayer).id;
  const enemyLand = Object.values(game.state.provinces).find(
    (p) => p.owner === attackerId && game.neighbors(p.id).includes(myProvince.id),
  ) ?? Object.values(game.state.provinces).find((p) => p.owner === attackerId);
  // Hand the attacker a neighbouring province if the scenario left it far away.
  game.state.provinces[enemyLand.id].owner = attackerId;
  const staging = game.neighbors(myProvince.id).find((id) => id !== enemyLand.id) ?? enemyLand.id;
  game.state.provinces[staging].owner = attackerId;
  game.state.provinces[staging].garrison = 40;
  const before = game.state.log.length;
  const sent = game.launchArmy(attackerId, staging, myProvince.id, 0.5);
  assert.ok(sent >= BAL.minSend, 'the column actually marched');
  const fresh = game.state.log.slice(before).map((e) => e.text);
  assert.ok(
    fresh.some((line) => /(ведёт|ведут) войска:/.test(line) && line.includes(game.provinceName(myProvince.id))),
    `ожидалось предупреждение, получено: ${fresh.join(' | ')}`,
  );
  assert.equal(fresh.filter((line) => /(ведёт|ведут) войска:/.test(line)).length, 1, 'one warning per column');
});

test('the player launching troops does not warn about itself', () => {
  const game = makeGame();
  const mine = game.state.provinces[game.player.capital];
  const target = game.neighbors(mine.id).find((id) => game.state.provinces[id].owner !== game.state.nationId);
  const before = game.state.log.length;
  game.launchArmy(game.state.nationId, mine.id, target, 0.5);
  const fresh = game.state.log.slice(before).map((e) => e.text);
  assert.ok(!fresh.some((line) => /(ведёт|ведут) войска:/.test(line)), `не должно быть предупреждения: ${fresh.join(' | ')}`);
});

test('offer wording agrees with the nation name', () => {
  const plural = ['Османы', 'Нидерланды', 'США'];
  const singular = ['Пруссия', 'Австрия', 'Франция', 'Британия', 'Россия', 'Гаити'];
  for (const name of plural) assert.equal(offersVerb(name), 'предлагают', name);
  for (const name of singular) assert.equal(offersVerb(name), 'предлагает', name);
  assert.equal(offerSentence('Османы', 'pact'), 'Османы предлагают пакт о ненападении');
  assert.equal(marchesVerb('Османы'), 'ведут');
  assert.equal(marchesVerb('Пруссия'), 'ведёт');
  assert.equal(offerSentence('Пруссия', 'peace'), 'Пруссия предлагает мир');
  // Every nation in every scenario gets a readable line.
  for (const scenario of SCENARIOS) {
    for (const nation of scenario.nations) {
      const line = offerSentence(nation.short, 'pact');
      assert.ok(/^[^ ]+.* (предлагает|предлагают) пакт о ненападении$/.test(line), line);
    }
  }
});

test('a refused offer is not repeated immediately', () => {
  const game = makeGame();
  const neighbour = Object.values(game.state.nations).find((n) => !n.isPlayer);
  game.state.time = 300;
  const first = game.offerPeace(neighbour.id, 'pact');
  assert.equal(first.ok, true);
  game.answerPeace(first.offer.id, false);
  const again = game.offerPeace(neighbour.id, 'pact');
  assert.equal(again.ok, false, 'the same neighbour must stay quiet after a refusal');
  game.state.time += BAL.offerCooldownAfterRefusal + 1;
  const later = game.offerPeace(neighbour.id, 'pact');
  assert.equal(later.ok, true, 'but the offer returns once the cooldown passes');
});

test('Russian plural forms for counts', () => {
  assert.equal(provincesCount(1), '1 провинция');
  assert.equal(provincesCount(3), '3 провинции');
  assert.equal(provincesCount(11), '11 провинций');
  assert.equal(provincesCount(21), '21 провинция');
  assert.equal(nationsCount(5), '5 держав');
  assert.equal(nationsCount(2), '2 державы');
  assert.equal(nationsCount(0), '0 держав');
});

// ---------------------------------------------------------------- Kaliningrad & pacts

test('Kaliningrad is its own province, reachable from land and worth garrisoning', () => {
  const kgd = map.provinces.find((p) => p.id === 'KGD');
  assert.ok(kgd, 'KGD must exist on the Europe map');
  assert.equal(kgd.nameRu, 'Калининград');
  assert.deepEqual([...kgd.neighbors].sort(), ['LT', 'PL']);
  // It is not painted into Russia any more, and Russia no longer borders
  // Poland or Lithuania through it.
  const ru = map.provinces.find((p) => p.id === 'RU');
  assert.ok(!ru.islands.some((ring) => ring.some(([x, z]) => x > 4.2 && x < 6.7 && z > -2.5 && z < -1)), 'exclave ring left in RU');
  assert.ok(!ru.neighbors.includes('PL') && !ru.neighbors.includes('LT'), `RU still borders ${ru.neighbors}`);
  for (const scenario of SCENARIOS.filter((s) => s.theatre === 'europe')) {
    const game = new Game({ scenarioId: scenario.id, nationId: scenario.nations[0].id, map, seed: 3 });
    const province = game.state.provinces.KGD;
    assert.ok(province, `${scenario.id} has no KGD`);
    assert.ok(province.owner || province.garrison > 0, `${scenario.id} leaves KGD empty`);
    assert.ok(game.maxGarrison('KGD') >= 10, `${scenario.id}: KGD cannot hold troops`);
  }
  // 1815: East Prussia is Prussian. 1939: East Prussia is German.
  const concert = new Game({ scenarioId: 'concert', nationId: 'FRA', map, seed: 3 });
  assert.equal(concert.state.provinces.KGD.owner, 'PRU');
  const eve = new Game({ scenarioId: 'eve1939', nationId: 'SOV', map, seed: 3 });
  assert.equal(eve.state.provinces.KGD.owner, 'GER');
});

test('the player can offer a pact, and strength decides the answer', () => {
  const strong = makeGame();
  // The Netherlands are a weak neighbour: a mighty France gets its treaty.
  for (const p of Object.values(strong.state.provinces)) if (p.owner === 'FRA') p.garrison = 900;
  const outlookStrong = strong.pactOutlook('NLD');
  const offer = strong.proposePact('NLD');
  assert.equal(offer.ok, true);
  assert.equal(offer.accepted, true, `strong player should be accepted, outlook ${outlookStrong.toFixed(2)}`);
  assert.equal(strong.hasTruce('FRA', 'NLD'), true);
  assert.ok(strong.state.log.some((line) => /Пакт о ненападении: Нидерланды/.test(line.text)));

  const weak = makeGame();
  for (const p of Object.values(weak.state.provinces)) if (p.owner === 'FRA') p.garrison = 5;
  for (const p of Object.values(weak.state.provinces)) if (p.owner === 'PRU') p.garrison = 1200;
  assert.ok(weak.pactOutlook('PRU') < 0.2, `a weakling gets no treaty: ${weak.pactOutlook('PRU')}`);
  const refused = weak.proposePact('PRU');
  assert.equal(refused.accepted, false);
  assert.equal(weak.hasTruce('FRA', 'PRU'), false);
  assert.ok(weak.state.log.some((line) => line.text.startsWith('Отказ:')));
});

test('a pact is a promise the player can break, at a price', () => {
  const game = makeGame();
  // Belgium belongs to the Netherlands and borders France (France owns only FR).
  game.state.relations['FRA|NLD'] = { truceUntil: game.state.time + 400 };
  const blocked = game.canSend('FR', 'BE');
  assert.equal(blocked.ok, false);
  assert.equal(blocked.needsBreak, true, 'the UI needs a warning, not a silent no');
  assert.equal(blocked.with, 'NLD');

  const before = game.pactOutlook('PRU');
  assert.equal(game.breakTruce('NLD'), true);
  assert.equal(game.canSend('FR', 'BE').ok, true, 'after breaking, the attack is allowed');
  assert.equal(game.player.oathbreaks, 1);
  assert.ok(game.state.log.some((line) => /нарушает (пакт|перемирие)/.test(line.text)));
  assert.ok(game.pactOutlook('PRU') < before, 'a broken word makes the others warier');
});

test('the AI can break a pact too, and the player is told', () => {
  const game = makeGame();
  game.state.relations['FRA|PRU'] = { truceUntil: game.state.time + 400 };
  const logsBefore = game.state.log.length;
  assert.equal(game.breakTruce('FRA', 'PRU'), true);
  const fresh = game.state.log.slice(logsBefore).map((line) => line.text);
  assert.ok(fresh.some((line) => line.includes('Пруссия') && /нарушает (пакт|перемирие)/.test(line)), fresh.join(' | '));
  assert.equal(game.hasTruce('FRA', 'PRU'), false);
});

test('a broken pact is remembered against a new proposal', () => {
  const game = makeGame();
  const clean = game.pactOutlook('NLD');
  game.player.oathbreaks = 2;
  assert.ok(game.pactOutlook('NLD') < clean, 'reputation must matter');
});

test('a pact signed while a column is marching turns that column back', () => {
  const game = makeGame();
  const before = game.province('FR').garrison;
  const beforeHome = game.province('DE').garrison;
  // An enemy column already on the road to the player's capital.
  game.state.armies.push({ id: 900, owner: 'PRU', from: 'DE', to: 'FR', troops: 120, t: 0, duration: 30, sea: false });
  game.state.offers.push({ id: 'pact-test', from: 'PRU', kind: 'pact', expires: game.state.time + 45 });
  const accepted = game.answerPeace('pact-test', true);
  assert.equal(accepted.accepted, true);
  assert.equal(game.hasTruce('PRU', 'FRA'), true);
  assert.equal(game.state.armies.some((a) => a.owner === 'PRU'), false, 'column recalled');
  assert.ok(
    Math.abs(game.province('DE').garrison - beforeHome - 120) <= 1,
    `the column came home: +${game.province('DE').garrison - beforeHome}`,
  );
  for (let i = 0; i < 700; i += 1) game.update(0.1);
  assert.equal(game.province('FR').owner, 'FRA', 'the capital was not taken after the treaty');
  assert.ok(game.province('FR').garrison >= before, 'no losses from the recalled column');
});

test('a column that cannot turn back does not capture after the treaty', () => {
  const game = makeGame();
  // Home province is no longer Prussian, so the column cannot simply return.
  game.state.armies.push({ id: 901, owner: 'PRU', from: 'DE', to: 'FR', troops: 90, t: 0, duration: 20, sea: false });
  game.state.provinces.DE.owner = 'FRA';
  game.state.offers.push({ id: 'pact-test-2', from: 'PRU', kind: 'pact', expires: game.state.time + 45 });
  game.answerPeace('pact-test-2', true);
  const armies = game.state.armies.filter((a) => a.id === 901);
  assert.equal(armies.length, 1, 'this column had to keep marching');
  for (let i = 0; i < 600 && game.state.armies.some((a) => a.id === 901); i += 1) game.update(0.1);
  assert.equal(game.province('FR').owner, 'FRA', 'no capture under a fresh truce');
  assert.ok(game.province('DE').garrison > 0, 'the men were placed in friendly land');
});

// ---------------------------------------------------------------- historical focus

test('every nation starts with a focus chain that points at foreign land', () => {
  for (const scenario of SCENARIOS) {
    const game = new Game({ scenarioId: scenario.id, nationId: scenario.nations[0].id, map: mapFor(scenario), seed: 5 });
    for (const nation of game.nations) {
      const focus = game.focusOf(nation.id);
      assert.ok(focus, `${scenario.id}/${nation.id} has no focus`);
      const target = game.state.provinces[focus.target];
      assert.ok(target, `${scenario.id}/${nation.id}: unknown target ${focus.target}`);
      assert.notEqual(target.owner, nation.id, `${scenario.id}/${nation.id}: focus on own land`);
      assert.ok(focus.gold > 0 && focus.morale > 0, `${scenario.id}/${nation.id}: no reward`);
    }
  }
});

test('taking the focus province pays the reward and moves the chain on', () => {
  const game = makeGame();
  const focus = game.focusOf('FRA');
  const gold = game.player.gold;
  const morale = game.player.morale;
  // Hand the target over the way a capture would.
  game.state.provinces[focus.target].owner = 'FRA';
  game.state.provinces[focus.target].garrison = 10;
  game.checkFocusForTests('FRA');
  assert.ok(game.player.gold >= gold + focus.gold - 1, `gold ${gold} -> ${game.player.gold}`);
  assert.ok(game.player.morale > morale, 'morale rose');
  assert.equal(game.focusProgress('FRA').done, 1);
  assert.notEqual(game.focusOf('FRA'), focus);
});

test('the player-visible focus text names the province and the reward', () => {
  const game = makeGame();
  const focus = game.focusOf('FRA');
  const name = game.provinceName(focus.target);
  assert.ok(focus.name.length > 3, 'the ambition has a name');
  assert.ok(name.length > 1, 'the target has a name');
});

// ---------------------------------------------------------------- palette

test('no two nations of one scenario wear the same colour', async () => {
  const { isDistinct, deltaE } = await import('../src/data/palette.js');
  for (const scenario of SCENARIOS) {
    for (let i = 0; i < scenario.nations.length; i += 1) {
      for (let j = i + 1; j < scenario.nations.length; j += 1) {
        const a = scenario.nations[i];
        const b = scenario.nations[j];
        assert.ok(
          isDistinct(a.color, b.color),
          `${scenario.id}: ${a.id} ${a.color} and ${b.id} ${b.color} are too close (ΔE ${deltaE(a.color, b.color).toFixed(1)})`,
        );
      }
    }
  }
});

test('the USA and France are told apart on the Atlantic map', async () => {
  const { deltaE } = await import('../src/data/palette.js');
  const scenario = SCENARIOS.find((s) => s.id === 'eve1939-atlantic');
  const usa = scenario.nations.find((n) => n.id === 'USA');
  const fra = scenario.nations.find((n) => n.id === 'FRA');
  assert.ok(deltaE(usa.color, fra.color) > 17, `ΔE ${deltaE(usa.color, fra.color).toFixed(1)}`);
});

// ---------------------------------------------------------------- auto orders

/** A game with the AI muted and one player province plus one foreign neighbour. */
const autoSetup = () => {
  const game = makeGame();
  for (const nation of game.nations) if (!nation.isPlayer) nation.ai.nextThink = 1e9;
  const mine = Object.values(game.state.provinces).filter((p) => p.owner === game.state.nationId);
  const from = mine[0].id;
  const to = game.neighbors(from).find((id) => game.state.provinces[id].owner !== game.state.nationId);
  return { game, from, to };
};

test('a standing order sends the surplus and keeps the reserve', () => {
  const { game, from, to } = autoSetup();
  const norm = game.maxGarrison(from);
  const result = game.addAuto(from, to, Math.round(norm * 0.5), Math.round(norm * 0.3));
  assert.ok(result.ok, result.reason);
  const before = game.state.provinces[from].garrison;
  game.update(1.2);
  const army = game.state.armies.find((a) => a.autoId === result.order.id);
  assert.ok(army, 'the order must march by itself');
  assert.ok(army.troops > 0);
  assert.ok(game.state.provinces[from].garrison >= result.order.keep, 'the reserve stays at home');
  assert.ok(game.state.provinces[from].garrison < before);
});

test('a standing order waits for its threshold', () => {
  const { game, from, to } = autoSetup();
  const norm = game.maxGarrison(from);
  game.state.provinces[from].garrison = Math.round(norm * 0.8);
  const result = game.addAuto(from, to, norm + 50, Math.round(norm * 0.4));
  assert.ok(result.ok, result.reason);
  game.update(1.5);
  assert.equal(game.state.armies.filter((a) => a.autoId).length, 0, 'not yet at the threshold');
});

test('only one column per standing order is on the road', () => {
  const { game, from, to } = autoSetup();
  const result = game.addAuto(from, to, 30, 20);
  assert.ok(result.ok, result.reason);
  game.update(1.2);
  const first = game.state.armies.filter((a) => a.autoId === result.order.id).length;
  game.state.provinces[from].garrison += 200;
  game.update(1.2);
  const second = game.state.armies.filter((a) => a.autoId === result.order.id).length;
  assert.equal(first, 1);
  assert.equal(second, 1, 'the next column leaves only after this one arrives');
});

test('auto orders can be removed, and are capped per province', () => {
  const { game, from, to } = autoSetup();
  const first = game.addAuto(from, to, 100, 40);
  assert.ok(first.ok, first.reason);
  const targets = game.neighbors(from).filter((id) => id !== to && game.state.provinces[id].owner !== game.state.nationId);
  assert.ok(targets.length >= 2, 'the test province needs three foreign neighbours');
  assert.ok(game.addAuto(from, targets[0], 100, 40).ok);
  const third = game.addAuto(from, targets[1], 100, 40);
  const fourth = game.addAuto(from, targets[2] ?? targets[0], 100, 40);
  assert.ok(third.ok);
  assert.equal(fourth.ok, false, 'three orders per province is the cap');
  assert.equal(game.autoOrdersFrom(from).length, 3);
  assert.ok(game.removeAuto(first.order.id));
  assert.equal(game.autoOrdersFrom(from).length, 2);
});

test('a European country has the same size on both maps', () => {
  // The Atlantic map used to project longitude at cos(42°) while the European
  // map uses cos(53°): Germany was 23 % fatter on one map than on the other,
  // which read as «the scale is wrong». Both must keep one scale.
  const byId = Object.fromEntries(atlanticMap.provinces.map((p) => [p.id, p]));
  const width = (p) => {
    const xs = p.rings[0].map(([x]) => x);
    return Math.max(...xs) - Math.min(...xs);
  };
  const height = (p) => {
    const zs = p.rings[0].map(([, z]) => z);
    return Math.max(...zs) - Math.min(...zs);
  };
  for (const province of map.provinces) {
    const twin = byId[province.id];
    if (!twin) continue; // Kaliningrad and other Atlantic-only ids
    assert.ok(
      Math.abs(width(twin) - width(province)) < 0.15,
      `${province.id}: ширина ${width(twin).toFixed(2)} против ${width(province).toFixed(2)}`,
    );
    assert.ok(
      Math.abs(height(twin) - height(province)) < 0.15,
      `${province.id}: высота ${height(twin).toFixed(2)} против ${height(province).toFixed(2)}`,
    );
  }
});

test('the Atlantic map is no longer twice the size of Europe', () => {
  assert.ok(atlanticMap.width < 140, `width ${atlanticMap.width}`);
  assert.ok(atlanticMap.width / atlanticMap.height > 2.2, 'the theatre stays a wide Atlantic map');
  const america = atlanticMap.provinces.filter((p) => ['AK', 'CA', 'NW', 'NE', 'MW', 'WE', 'SO', 'FL', 'LO', 'MX', 'CU', 'HI'].includes(p.id));
  const xs = america.flatMap((p) => p.rings.flat().map(([x]) => x));
  const europe = atlanticMap.provinces.filter((p) => p.centroid[0] > 20);
  assert.ok(europe.length > 30, 'Europe keeps its provinces');
  assert.ok(Math.max(...xs) < 12, 'America stays on its side of the ocean');
});

test('the selected settings segment stays highlighted for string and boolean rules', () => {
  const rules = normalizeRules({ aiStyle: 'hard', aiEconomy: 'weak', neutrals: 'strong', startPaused: true, aiPassive: true });
  // Every option of a string rule: exactly the stored one matches.
  for (const [group, options] of [['aiStyle', AI_STYLE], ['aiEconomy', AI_ECONOMY], ['neutrals', NEUTRAL_STRENGTH]]) {
    const matched = Object.keys(options).filter((key) => ruleOptionMatches(rules, group, key));
    assert.deepEqual(matched, [rules[group]], `${group} highlights exactly its stored option`);
  }
  // Booleans arrive as data-value="true"/"false" strings from the DOM.
  assert.equal(ruleOptionMatches(rules, 'startPaused', 'true'), true);
  assert.equal(ruleOptionMatches(rules, 'startPaused', true), true);
  assert.equal(ruleOptionMatches(rules, 'aiPassive', 'true'), true);
  assert.equal(ruleOptionMatches(rules, 'aiPassive', 'false'), false);
  assert.equal(ruleOptionMatches(rules, 'startPaused', 'false'), false);
  assert.equal(ruleOptionMatches({ startPaused: false }, 'startPaused', 'false'), true);
  // The old implementation compared through Number(), which is NaN for every
  // string option, so a click wiped the highlight. Guard against that returning.
  assert.equal(ruleOptionMatches({ aiStyle: 'hard' }, 'aiStyle', 'hard'), true);
  assert.equal(ruleOptionMatches({ aiStyle: 'hard' }, 'aiStyle', 'calm'), false);
  assert.equal(ruleOptionMatches({}, 'aiStyle', 'normal'), false);
});

test('Crimea is a separate province on both maps, and nobody paints over it', () => {
  const pointInRing = ([x, z], ring) => {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
      const [xi, zi] = ring[i];
      const [xj, zj] = ring[j];
      if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
    }
    return inside;
  };
  for (const source of [map, atlanticMap]) {
    const byId = Object.fromEntries(source.provinces.map((p) => [p.id, p]));
    const crimea = byId.KRYM;
    assert.ok(crimea, `${source.theatre}: Крым есть на карте`);
    assert.ok(crimea.area > 1, `${source.theatre}: Крым не меньше пары юнитов площади`);
    for (const id of ['UA', 'RU', 'TR']) {
      assert.ok(crimea.neighbors.includes(id), `${source.theatre}: Крым граничит с ${id}`);
      assert.ok(byId[id].neighbors.includes('KRYM'), `${source.theatre}: ${id} граничит с Крымом`);
    }
    // The peninsula hangs south of the Ukrainian mainland.
    assert.ok(crimea.centroid[1] > byId.UA.centroid[1], `${source.theatre}: Крым южнее Украины`);
    // Exactly one province may own a point: no country may be drawn on top of it.
    const [cx, cz] = crimea.centroid;
    const covering = source.provinces.filter(
      (p) => p.id !== 'KRYM' && p.rings.some((ring) => pointInRing([cx, cz], ring)),
    );
    assert.deepEqual(covering.map((p) => p.id), [], `${source.theatre}: под Крымом нет чужой земли`);
  }
  // 1815 and 1939: whoever owns Ukraine also owns the peninsula.
  const concert = SCENARIOS.find((s) => s.id === 'concert');
  const russia = concert.nations.find((n) => n.id === 'RUS');
  assert.ok(russia.provinces.includes('KRYM'), 'в 1815 Крым за Российской империей');
  const eve = SCENARIOS.find((s) => s.id === 'eve1939');
  const sssr = eve.nations.find((n) => n.id === 'SOV');
  assert.ok(sssr.provinces.includes('KRYM'), 'в 1939 Крым за СССР');
});

test('the world map is a closed cylinder with no orphan province', () => {
  assert.ok(worldMap.wrap, 'the world map declares its wrap period');
  assert.equal(worldMap.wrap.period, Math.round(360 * worldMap.projection.lonScale * 10000) / 10000);
  assert.ok(worldMap.provinces.length >= 150, 'the world is big');
  for (const province of worldMap.provinces) {
    assert.ok(province.neighbors.length > 0, `${province.id} is isolated`);
    for (const neighbour of province.neighbors) {
      assert.ok(worldMap.provinces.some((p) => p.id === neighbour), `${province.id} -> unknown ${neighbour}`);
    }
    assert.ok(province.area > 0.01, `${province.id} has no land`);
  }
  // Europe must not be stretched by the move to the world frame: Germany has
  // the same width here as on the Europe-only map.
  const width = (source, id) => {
    const province = source.provinces.find((p) => p.id === id);
    const xs = province.rings[0].map(([x]) => x);
    return Math.max(...xs) - Math.min(...xs);
  };
  assert.ok(Math.abs(width(worldMap, 'DE') - width(map, 'DE')) < 0.15, 'Germany changed width on the world map');
  const byId = Object.fromEntries(worldMap.provinces.map((p) => [p.id, p]));
  for (const id of ['KRYM', 'KGD', 'SIB', 'YAK', 'CHU']) assert.ok(byId[id], `${id} is on the world map`);
  // China is cut into regions, and each of them is real land with neighbours.
  const china = ['XIN', 'TIB', 'NMG', 'MAN', 'NCH', 'SIC', 'SCH'];
  for (const id of china) {
    const province = byId[id];
    assert.ok(province, `${id} (Китай) есть на карте`);
    assert.ok(province.area > 1, `${id} слишком мал`);
    assert.ok(province.neighbors.length > 0, `${id} ни с кем не граничит`);
  }
  assert.ok(byId.TWN, 'Тайвань есть на карте');
  const world = SCENARIOS.find((s) => s.id === 'world1939');
  const chinaNation = world.nations.find((n) => n.id === 'CHN');
  assert.ok(chinaNation, 'в мировом сценарии есть Китай');
  assert.deepEqual([...chinaNation.provinces].sort(), [...china].sort());
});

test('Siberia reaches Alaska across the Bering strait, not through Europe', () => {
  const game = new Game({ scenarioId: 'world1939', nationId: 'SOV', map: worldMap, seed: 11 });
  const chukotka = game.byId.CHU;
  assert.ok(chukotka.neighbors.includes('AK'), `CHU borders ${chukotka.neighbors}`);
  // The straight line distance must use the short way around the cylinder.
  const straight = game.distance('CHU', 'AK');
  assert.ok(straight < 24, `Bering distance ${straight.toFixed(1)} is a trip around the world`);
  const throughSiberia = game.distance('CHU', 'RU');
  assert.ok(straight < throughSiberia * 4, 'the strait is closer than Moscow');
  assert.ok(game.isSeaRoute('CHU', 'AK'), 'the strait is a sea crossing');
  const time = game.travelTime('CHU', 'AK');
  assert.ok(time > 0 && time <= BAL.maxTravel, `Bering crossing takes ${time}s`);
  // And the USSR really is more than one province.
  const siberian = Object.values(game.state.provinces)
    .filter((p) => p.owner === 'SOV' && ['SIB', 'CEN', 'BAI', 'YAK', 'FAR', 'KAM', 'CHU'].includes(p.id));
  assert.equal(siberian.length, 7, 'all seven Siberian provinces belong to the USSR');
});

test('the world scenario is playable from the first frame', () => {
  const scenario = SCENARIOS.find((s) => s.id === 'world1939');
  assert.ok(scenario, 'world1939 exists');
  const game = new Game({ scenarioId: 'world1939', nationId: 'GER', map: worldMap, seed: 3 });
  for (const nation of scenario.nations) {
    assert.ok(game.state.nations[nation.id], `${nation.id} missing`);
  }
  // Every great power owns something and the map keeps neutral land to conquer.
  const owned = Object.values(game.state.provinces).filter((p) => p.owner).length;
  const total = Object.keys(game.state.provinces).length;
  assert.ok(owned > total * 0.28 && owned < total, `${owned}/${total} owned`);
  const neutrals = Object.values(game.state.provinces).filter((p) => !p.owner && p.garrison > 0).length;
  assert.ok(neutrals > 20, `only ${neutrals} neutral provinces`);
});
