// Rules that shape how a match plays. They are stored in the save, so a reloaded
// game keeps the same temperament of the AI.
export const DEFAULT_RULES = {
  aiStyle: 'normal', // calm | normal | hard
  peaceUntilFirstWar: true, // AI leaves the player alone until the player attacks
  aiPassive: false, // AI never launches attacks at all (sandbox)
  aiEconomy: 'normal', // weak | normal | strong
  neutrals: 'normal', // weak | normal | strong
  victoryShare: 1, // kept for save compatibility; victory always needs the whole map
  // A new match waits for the player: a browser game is opened in the middle of
  // a day, not at a desk, and «the world moved while I read the rules» is the
  // fastest way to lose a casual player.
  startPaused: true,
  // The match also stops itself when something needs an answer: an enemy
  // column aimed at your land, a treaty offer, a fork in the focus chain.
  autoPause: true,
  // К2: «goal» — короткая партия с целью и лимитом в восемь минут, «conquest» —
  // прежняя победа по всей карте, без часов. Режим выбирается до партии.
  mode: 'goal',
};

// `label` is the word next to the selector («Спокойная»), `short` the same word
// in the masculine, because the summary reads «… ИИ» — «обычная ИИ» was wrong.
export const AI_STYLE = {
  calm: { aggression: 0.5, label: 'Спокойная', short: 'Спокойный' },
  normal: { aggression: 1, label: 'Обычная', short: 'Обычный' },
  hard: { aggression: 1.45, label: 'Жёсткая', short: 'Жёсткий' },
};

export const AI_ECONOMY = {
  weak: { eco: 0.8, label: 'Слабая' },
  normal: { eco: 1, label: 'Обычная' },
  strong: { eco: 1.25, label: 'Сильная' },
};

export const NEUTRAL_STRENGTH = {
  weak: { strength: 0.7, label: 'Слабые' },
  normal: { strength: 1, label: 'Обычные' },
  strong: { strength: 1.3, label: 'Сильные' },
};

/** Merges partial rules with defaults and clamps unknown values. */
export function normalizeRules(rules = {}) {
  const merged = { ...DEFAULT_RULES, ...(rules ?? {}) };
  if (!AI_STYLE[merged.aiStyle]) merged.aiStyle = DEFAULT_RULES.aiStyle;
  if (!AI_ECONOMY[merged.aiEconomy]) merged.aiEconomy = DEFAULT_RULES.aiEconomy;
  if (!NEUTRAL_STRENGTH[merged.neutrals]) merged.neutrals = DEFAULT_RULES.neutrals;
  // Old saves could ask for 40/50/65 %: the rule is gone, so normalise them all
  // to full conquest instead of silently letting a half-map win through.
  merged.victoryShare = 1;
  merged.peaceUntilFirstWar = Boolean(merged.peaceUntilFirstWar);
  merged.aiPassive = Boolean(merged.aiPassive);
  merged.startPaused = Boolean(merged.startPaused);
  merged.autoPause = Boolean(merged.autoPause);
  merged.mode = merged.mode === 'conquest' ? 'conquest' : 'goal';
  return merged;
}

/**
 * Does a `<button data-value="...">` match the stored value of a rule?
 *
 * Rule values are a mix of strings («normal»), booleans and numbers, while every
 * `data-value` attribute is a string. Comparing them with `===` after a `Number()`
 * cast made string rules (`aiStyle`, `aiEconomy`, `neutrals`) compare against NaN,
 * so the highlighted segment of the settings control vanished on the first click.
 * One helper for both the initial paint and the in-place update keeps them equal.
 */
export function ruleOptionMatches(rules, key, rawOption) {
  const value = rules?.[key];
  if (value === undefined) return false;
  return String(value) === String(rawOption);
}

/** Short human summary used on the nation screen and in the pause menu. */
export function describeRules(rules = {}) {
  const r = normalizeRules(rules);
  const parts = [AI_STYLE[r.aiStyle].short + ' ИИ'];
  if (r.aiPassive) parts.push('без войн');
  else if (r.peaceUntilFirstWar) parts.push('мир до вашей войны');
  parts.push(r.mode === 'conquest' ? 'победа — вся карта' : 'цель за 8 минут');
  return parts.join(' · ');
}
