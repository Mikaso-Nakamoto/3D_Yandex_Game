// К5: what the player has earned, what is still locked and what today asks for.
//
// Everything here is a pure function of (scenario list, saved stars, today's
// date). The menu, the nation screen, the end screen, the cloud save and the
// tests all read the same rules — a second implementation in the UI is how a
// «locked» card used to be clickable and an earned star used to vanish.
import { PLAYABLE_SCENARIOS, SCENARIOS, getScenario } from '../data/scenarios.js';

export const STARS_MAX = 3;

/** Scenarios of one theatre, in the order they are meant to be played. */
export function theatreOrder(theatre) {
  return PLAYABLE_SCENARIOS.filter((s) => (s.theatre ?? 'europe') === theatre);
}

/** How many stars open this scenario: the first card of a theatre is free. */
export function unlockStars(scenarioId) {
  const scenario = SCENARIOS.find((s) => s.id === scenarioId);
  if (!scenario) return 0;
  const list = theatreOrder(scenario.theatre ?? 'europe');
  const index = list.findIndex((s) => s.id === scenarioId);
  if (index <= 0) return 0;
  // One star in the previous scenario, the plan's rule: a single finished match
  // opens the next one, and a finished story opens it for good.
  return 1;
}

/** The scenario whose stars open `scenarioId`, for «за 1 звезду в …». */
export function unlockSource(scenarioId) {
  const scenario = SCENARIOS.find((s) => s.id === scenarioId);
  if (!scenario) return null;
  const list = theatreOrder(scenario.theatre ?? 'europe');
  const index = list.findIndex((s) => s.id === scenarioId);
  return index > 0 ? list[index - 1] : null;
}

export function isUnlocked(scenarioId, stars = {}) {
  const need = unlockStars(scenarioId);
  if (!need) return true;
  const source = unlockSource(scenarioId);
  if (!source) return true;
  return (Number(stars?.[source.id]) || 0) >= need;
}

/** Star table from anything a save may hold: only known scenarios, 0…3. */
export function normalizeStars(raw = {}) {
  const out = {};
  for (const scenario of PLAYABLE_SCENARIOS) {
    const value = Number(raw?.[scenario.id]);
    if (Number.isFinite(value) && value > 0) out[scenario.id] = Math.max(0, Math.min(STARS_MAX, Math.round(value)));
  }
  return out;
}

/** «7 из 24» — the one number that says how far the player has come. */
export function starTotals(stars = {}) {
  const table = normalizeStars(stars);
  const earned = Object.values(table).reduce((sum, n) => sum + n, 0);
  return { earned, max: PLAYABLE_SCENARIOS.length * STARS_MAX };
}

/** The first scenario of the theatre that is still locked, if any. */
export function nextLocked(theatre, stars = {}) {
  return theatreOrder(theatre).find((s) => !isUnlocked(s.id, stars)) ?? null;
}

// ---------------------------------------------------------------- задача дня

const DAY_MS = 24 * 60 * 60 * 1000;

/** Local calendar day as `2026-10-25`; the task changes at local midnight. */
export function dayKey(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** Whole days since the epoch for a `YYYY-MM-DD` key (UTC, key is already local). */
export function dayNumber(key) {
  const [y, m, d] = String(key).split('-').map(Number);
  if (!y || !m || !d) return 0;
  return Math.floor(Date.UTC(y, m - 1, d) / DAY_MS);
}

// Short aims, each one finishable inside the eight-minute shape of a match. The
// text is written with the number inside it: the HUD counts «N из M» itself.
const DAILY_TASKS = [
  { kind: 'capture', add: 2, limit: 240 },
  { kind: 'capture', add: 3, limit: 300 },
  { kind: 'capture', add: 4, limit: 360 },
  { kind: 'capture', add: 3, limit: 240 },
  { kind: 'hold', add: 3, seconds: 120, limit: 300 },
];

/** Small deterministic hash: the same day gives the same task everywhere. */
function hash(seed, salt = 0) {
  let h = 2166136261 ^ salt;
  for (let i = 0; i < seed.length; i += 1) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  h ^= h >>> 13;
  return (h >>> 0) / 4294967296;
}

const pick = (seed, list, salt = 0) => list[Math.floor(hash(seed, salt) * list.length) % list.length];

/** Human sentence for a daily task; `text` is what the HUD shows as the aim. */
export function describeDaily(challenge) {
  if (!challenge) return '';
  const minutes = Math.round(challenge.goal.limit / 60);
  if (challenge.goal.kind === 'hold') {
    return `Удержите ${challenge.goal.add + challenge.owned} провинций ${Math.round(challenge.goal.seconds / 60)} мин · ${minutes} минут на всё`;
  }
  return `Возьмите ${challenge.goal.add} ${challenge.goal.add === 1 ? 'провинцию' : 'провинции'} за ${minutes} мин`;
}

/**
 * Today's challenge. Chosen from the scenarios the player can already open, so
 * the task is never a locked door; `stars` is the saved table.
 *
 * @param {object} options
 * @param {string} [options.today]  `YYYY-MM-DD`, defaults to the local day
 * @param {object} [options.stars]  saved stars
 * @param {string} [options.scenarioId]  a pinned scenario (the resolved card)
 * @param {string} [options.nationId]    a pinned nation
 */
export function dailyChallenge({ today = dayKey(), stars = {}, theatre = null, scenarioId = null, nationId = null } = {}) {
  // The task is offered on the map the player is looking at: a daily that
  // silently switches the whole theatre under the «Играть» button reads as a
  // bug. Unlocked scenarios only — a task behind a lock is not a task.
  const open = PLAYABLE_SCENARIOS.filter((s) => isUnlocked(s.id, stars) && (!theatre || (s.theatre ?? 'europe') === theatre));
  const pool = open.length ? open : PLAYABLE_SCENARIOS.filter((s) => isUnlocked(s.id, stars));
  const list = pool.length ? pool : [PLAYABLE_SCENARIOS[0]];
  const scenario = (scenarioId && getScenario(scenarioId)) || pick(today, list, 1);
  // The strongest nation of the scenario, like the one-tap «Играть»: a daily
  // task must not drop a casual player into a one-province minor for the day.
  const strongest = [...scenario.nations].sort((a, b) => (b.army ?? 1) - (a.army ?? 1))[0];
  const nation = nationId ? scenario.nations.find((n) => n.id === nationId) ?? strongest : strongest;
  const task = pick(today, DAILY_TASKS, 3);
  const owned = nation.provinces.length;
  const add = task.add;
  const goal = {
    kind: task.kind,
    add,
    limit: task.limit,
    seconds: task.seconds ?? 0,
    // The HUD counts «N из M» next to the sentence: a task is a number, not a
    // story, and the number has to move while the player plays.
    count: true,
    // A hand-written aim: the HUD prints it as is and the bar counts «N из M».
    text:
      task.kind === 'hold'
        ? `Удержать ${owned + add} провинций ${Math.round((task.seconds ?? 120) / 60)} мин`
        : `Взять ещё ${add} ${add === 1 ? 'провинцию' : 'провинции'}`,
  };
  return {
    date: today,
    owned,
    theatre: scenario.theatre ?? 'europe',
    scenarioId: scenario.id,
    nationId: nation.id,
    nationName: nation.short,
    scenarioTitle: scenario.title,
    era: scenario.era,
    goal,
  };
}

/** Is the resolved card still today's? */
export function isDailyFresh(card, today = dayKey()) {
  return Boolean(card && card.date === today);
}

/** «через 6 ч 12 мин» — when the next task appears. */
export function untilNextDay(date = new Date()) {
  const next = new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1, 0, 0, 0, 0);
  const left = Math.max(0, next - date);
  const hours = Math.floor(left / 3600000);
  const minutes = Math.floor((left % 3600000) / 60000);
  return hours > 0 ? `через ${hours} ч ${minutes} мин` : `через ${minutes} мин`;
}

// ---------------------------------------------------------------- достижения

/**
 * The three achievements of the plan, in the order they are likely to be
 * earned. `test` reads a finished match; the ids are the ones the Yandex
 * console must know (docs/YANDEX.md lists them).
 */
export const ACHIEVEMENTS = [
  { id: 'first_win', title: 'Первая победа', note: 'Довести партию до цели' },
  { id: 'three_stars', title: 'Три звезды', note: 'Цель, земля и слово — всё сразу' },
  { id: 'no_losses', title: 'Без потерь', note: 'Победить, не отдав ни одной провинции' },
  { id: 'daily', title: 'Задача дня', note: 'Выполнить задание дня' },
];

/** Which achievements this finished match earns, ignoring the ones already had. */
export function earnedAchievements({ status, stats = {}, starCount = 0, daily = false }, owned = {}) {
  const got = [];
  const won = status === 'victory' || status === 'goal';
  if (won && !owned.first_win) got.push('first_win');
  if (won && starCount >= STARS_MAX && !owned.three_stars) got.push('three_stars');
  if (won && (stats.lostProvinces ?? 0) === 0 && !owned.no_losses) got.push('no_losses');
  if (won && daily && !owned.daily) got.push('daily');
  return got;
}

export function achievementById(id) {
  return ACHIEVEMENTS.find((a) => a.id === id) ?? null;
}

// ---------------------------------------------------------------- реклама (К6)

/**
 * К6.3/6.4: when the automatic (interstitial) ad may be shown.
 *
 * - the first three finished matches are ad-free: a newcomer is still learning
 *   what the game is, and an ad in the minute after the first tap is how they
 *   stop learning it;
 * - then no more than one ad per two matches.
 *
 * `matches` is how many matches the player has finished, `lastAd` the number at
 * which the previous ad was shown (−1 = never).
 */
export function interstitialAllowed({ matches = 0, lastAd = -1, adsEnabled = true } = {}) {
  if (!adsEnabled) return false;
  if (matches < 3) return false;
  return matches - lastAd >= 2;
}

/** Rewarded video follows the same «no ads for a newcomer» rule (К6.4). */
export function rewardedAllowed({ matches = 0, adsEnabled = true } = {}) {
  return Boolean(adsEnabled) && matches >= 3;
}
