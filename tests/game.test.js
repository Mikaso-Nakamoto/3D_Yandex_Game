import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Game } from '../src/game/game.js';
import { SCENARIOS } from '../src/data/scenarios.js';
import { normalizeRules, DEFAULT_RULES } from '../src/game/rules.js';
import { BAL } from '../src/game/balance.js';

const map = JSON.parse(readFileSync(new URL('../src/data/map.json', import.meta.url), 'utf8'));
const americaMap = JSON.parse(readFileSync(new URL('../src/data/map-america.json', import.meta.url), 'utf8'));
const MAPS = { europe: map, america: americaMap };
const mapFor = (scenario) => MAPS[scenario.theatre ?? 'europe'];
const makeGame = (opts = {}) => {
  const { ai = false, ...rest } = opts;
  const game = new Game({ scenarioId: 'concert', nationId: 'FRA', doctrineId: 'coin', map, seed: 42, ...rest });
  // Combat/economy tests run without AI interference; AI has its own test below.
  if (!ai) for (const nation of game.nations) if (!nation.isPlayer) nation.ai.nextThink = 1e9;
  return game;
};

test('map has every province wired to at least one neighbour', () => {
  assert.equal(map.provinces.length, 41);
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

test('cannot move troops to a non-adjacent province', () => {
  const game = makeGame();
  const check = game.canSend('FR', 'RU');
  assert.equal(check.ok, false);
  assert.match(check.reason, /гранич/);
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

test('1815: Russia starts with the largest army, the Ottomans are not a top-2 power', () => {
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
  const ottomanRank = totals.findIndex((row) => row.id === 'OTT');
  assert.ok(ottomanRank >= 2, `Ottomans should not be top-2, rank ${ottomanRank + 1}`);
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
  const manpower = game.player.manpower;
  for (let i = 0; i < 200; i += 1) game.update(0.05);
  assert.ok(game.player.gold > gold);
  assert.ok(game.player.manpower >= manpower - 1);
});

test('victory triggers at the configured share of the map', () => {
  const game = makeGame();
  let owned = 0;
  for (const province of game.provinces) {
    if (owned >= Math.ceil(game.provinces.length * 0.5)) break;
    if (province.owner === 'FRA') continue;
    province.owner = 'FRA';
    owned += 1;
  }
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

test('rules: victory threshold is configurable at runtime', () => {
  const game = makeGame();
  game.setRules({ victoryShare: 0.3 });
  // Own 30% of the map, which is below the default 50% but above the configured 30%.
  const need = Math.ceil(game.provinces.length * 0.3);
  let owned = game.provinceCount('FRA');
  for (const province of game.provinces) {
    if (owned >= need) break;
    if (province.owner === 'FRA') continue;
    province.owner = 'FRA';
    owned += 1;
  }
  game.setRules({ victoryShare: 0.3 });
  game.update(0.05);
  assert.equal(game.state.status, 'victory');
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


// ---------------------------------------------------------------- america theatre

test('the american theatre is fully wired: lands, borders, sea routes', () => {
  const ids = new Set(americaMap.provinces.map((p) => p.id));
  assert.equal(americaMap.theatre, 'america');
  assert.equal(americaMap.provinces.length, 13);
  for (const province of americaMap.provinces) {
    assert.ok(province.rings.length > 0, `${province.id} has no shape`);
    assert.ok(province.pop > 0, `${province.id} has no population`);
    assert.ok(province.neighbors.length > 0, `${province.id} is isolated`);
    for (const neighbour of province.neighbors) {
      assert.ok(ids.has(neighbour), `${province.id} -> unknown ${neighbour}`);
    }
  }
});

test('american adjacency is symmetric and does not link a province to itself', () => {
  const byId = Object.fromEntries(americaMap.provinces.map((p) => [p.id, p]));
  for (const province of americaMap.provinces) {
    for (const neighbour of province.neighbors) {
      assert.notEqual(neighbour, province.id, `${province.id} neighbours itself`);
      assert.ok(byId[neighbour].neighbors.includes(province.id), `${province.id}/${neighbour} not symmetric`);
    }
  }
});

test('the new world scenario fills every province of its theatre', () => {
  const scenario = SCENARIOS.find((s) => s.id === 'neworld');
  assert.ok(scenario, 'scenario exists');
  const game = new Game({ scenarioId: 'neworld', nationId: 'USA', map: americaMap });
  for (const province of americaMap.provinces) {
    const owner = game.state.provinces[province.id].owner;
    assert.ok(owner, `${province.id} is unowned`);
  }
  assert.equal(game.state.nations.USA.isPlayer, true);
  assert.equal(game.provinceCount('USA'), 6);
});

test('a game refuses a map from the wrong theatre', () => {
  assert.throws(
    () => new Game({ scenarioId: 'neworld', nationId: 'USA', map }),
    /театр/i,
  );
  assert.throws(
    () => new Game({ scenarioId: 'concert', nationId: 'FRA', map: americaMap }),
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
