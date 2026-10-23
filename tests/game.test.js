import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Game } from '../src/game/game.js';
import { SCENARIOS } from '../src/data/scenarios.js';

const map = JSON.parse(readFileSync(new URL('../src/data/map.json', import.meta.url), 'utf8'));
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
  const ids = new Set(map.provinces.map((p) => p.id));
  for (const scenario of SCENARIOS) {
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
