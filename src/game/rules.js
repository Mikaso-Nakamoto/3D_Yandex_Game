// Rules that shape how a match plays. They are stored in the save, so a reloaded
// game keeps the same temperament of the AI.
export const DEFAULT_RULES = {
  aiStyle: 'normal', // calm | normal | hard
  peaceUntilFirstWar: true, // AI leaves the player alone until the player attacks
  aiPassive: false, // AI never launches attacks at all (sandbox)
  aiEconomy: 'normal', // weak | normal | strong
  neutrals: 'normal', // weak | normal | strong
  victoryShare: 0.5, // share of provinces needed to win
  startPaused: false,
};

export const AI_STYLE = {
  calm: { aggression: 0.5, label: 'Спокойная' },
  normal: { aggression: 1, label: 'Обычная' },
  hard: { aggression: 1.45, label: 'Жёсткая' },
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

export const VICTORY_SHARES = [
  { value: 0.4, label: '40%' },
  { value: 0.5, label: '50%' },
  { value: 0.65, label: '65%' },
];

/** Merges partial rules with defaults and clamps unknown values. */
export function normalizeRules(rules = {}) {
  const merged = { ...DEFAULT_RULES, ...(rules ?? {}) };
  if (!AI_STYLE[merged.aiStyle]) merged.aiStyle = DEFAULT_RULES.aiStyle;
  if (!AI_ECONOMY[merged.aiEconomy]) merged.aiEconomy = DEFAULT_RULES.aiEconomy;
  if (!NEUTRAL_STRENGTH[merged.neutrals]) merged.neutrals = DEFAULT_RULES.neutrals;
  const share = Number(merged.victoryShare);
  merged.victoryShare =
    Number.isFinite(share) && share >= 0.1 && share <= 0.95 ? share : DEFAULT_RULES.victoryShare;
  merged.peaceUntilFirstWar = Boolean(merged.peaceUntilFirstWar);
  merged.aiPassive = Boolean(merged.aiPassive);
  merged.startPaused = Boolean(merged.startPaused);
  return merged;
}

/** Short human summary used on the nation screen and in the pause menu. */
export function describeRules(rules = {}) {
  const r = normalizeRules(rules);
  const parts = [AI_STYLE[r.aiStyle].label.toLowerCase() + ' ИИ'];
  if (r.aiPassive) parts.push('без войн');
  else if (r.peaceUntilFirstWar) parts.push('мир до вашей войны');
  parts.push(`победа ${Math.round(r.victoryShare * 100)}%`);
  return parts.join(' · ');
}
