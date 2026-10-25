// К2: the aim of a short match. Kept out of the simulation class so the nation
// screen can show the same sentence before the first move — a goal that only
// appears after «Начать правление» would be a surprise, not a promise.
//
// Two shapes cover every scenario: «взять ещё N провинций» and «удержать N
// провинций M минут». N counts from the starting size, so a one-province France
// and a twenty-province USSR get the same distance to the finish.
import { GOAL_LIMIT } from '../data/scenarios.js';
import { plural } from './text.js';

/**
 * @param {object} options
 * @param {object} options.scenario  scenario data (`goal` describes the aim)
 * @param {string} options.nationId  who plays
 * @param {Record<string,string|null>} options.owners  province → nation
 * @param {string} [options.mode]  'goal' | 'conquest'
 */
export function buildGoal({ scenario, nationId, owners, mode = 'goal', override = null }) {
  // К5: a daily task rewrites the aim of the match (`override`) while keeping
  // the scenario, the map and the balance.
  const def = { ...(scenario.goal ?? { kind: 'capture', add: 5 }), ...(override ?? {}) };
  const owned = Object.values(owners).filter((owner) => owner === nationId).length;
  const hold = def.kind === 'hold';
  const target = owned + (def.add ?? 5);
  return {
    kind: hold ? 'hold' : 'capture',
    target,
    seconds: hold ? (def.seconds ?? 180) : 0,
    holdSince: null,
    progress: owned,
    // A scenario may shorten the clock (the tutorial is three minutes) or name
    // the aim itself («Взять Бельгию»), because a lesson is about one province,
    // not about «ещё 1 провинция».
    limit: mode === 'conquest' ? 0 : (def.limit ?? GOAL_LIMIT),
    // A hand-written aim counts itself in words; the counted form gets «N из M».
    // A task may ask for the count explicitly («взять 3 провинции»).
    count: def.count ?? !def.text,
    text:
      def.text ??
      (hold
        ? `Удержать ${plural(target, 'провинцию', 'провинции', 'провинций')} ${Math.round((def.seconds ?? 180) / 60)} мин`
        : `Взять ещё ${plural(target - owned, 'провинцию', 'провинции', 'провинций')}`),
  };
}

/** «3 из 8» for the HUD. */
export function goalProgressText(goal) {
  if (!goal || goal.limit === 0) return '';
  return `${goal.progress} из ${goal.target}`;
}
