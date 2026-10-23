// Single place for tunable numbers. Values are in "game seconds" at speed x1.
export const BAL = {
  victoryShare: 0.5,

  // Province economy
  incomeBase: 0.025,
  incomePop: 0.005,
  factoryIncome: 0.5,
  manpowerBase: 0.035,
  manpowerPop: 0.0011,
  factoryManpower: 0.3,
  manpowerCapBase: 150,
  manpowerCapPop: 4,
  startManpower: 320,
  startGoldBase: 60,
  startGoldPerProvince: 12,

  // Garrisons
  garrisonBase: 20,
  garrisonPop: 1.9,
  barracksGarrison: 0.3,
  barracksReinforce: 0.15, // extra reinforce speed per level
  reinforceShare: 0.006, // share of max garrison per second
  overfillShare: 0.25, // share of that rate that keeps flowing once the norm is full
  overfillCeiling: 3, // surplus stops at this multiple of the norm (supply limit)
  overstackDefense: 0.5, // troops above the norm defend at half strength (supply limits)

  // Combat
  fortDefense: 0.3,
  seaTravelMul: 1.7,
  armySpeed: 1.35, // map units per second
  minTravel: 2.2,
  maxTravel: 16,
  minSend: 4,
  seaMinTravel: 1.6,
  // Battle outcome follows a monotone curve of attack/defence power, so the
  // chance shown in the UI is exactly the chance used by the resolver.
  combatSteepness: 12,
  combatCertain: 1.33, // this much stronger than the defence: always wins
  combatHopeless: 0.75, // weaker than this: always loses
  combatSwing: 0.08, // legacy noise for survivor counts
  loserSurvivorBase: 0.6,
  counterAttack: 0.05, // odds of the defender counter-attacking the attacker's home province
  counterAttackMargin: 0.35, // share of the defender's surviving garrison that marches
  desertionBelow: 25, // morale level at which soldiers start slipping away
  desertionRate: 0.004, // share of the garrison lost per second at zero morale

  // Upgrades
  maxLevel: 3,
  // Priced against a match of roughly 10-15 minutes at speed x1: a level-1
  // improvement in a mid-size province pays for itself in about a third of
  // that, so building is a real alternative to hoarding gold for mobilisation.
  upgradeCosts: {
    factory: [20, 36, 58],
    fort: [30, 52, 82],
    barracks: [24, 42, 66],
  },

  // Morale and war weariness
  moraleStart: 55,
  moraleDrift: 0.55, // per second toward the neutral value
  moraleNeutral: 55,
  moraleRange: 0.18, // attack/defence multiplier spread at morale 0 and 100
  moraleWin: 5.5,
  moraleLose: 7,
  exhaustionWin: 1.5,
  exhaustionLose: 3.5,
  exhaustionCapture: 4,
  exhaustionDecay: 0.5, // per second while not fighting
  exhaustionCalmAfter: 35, // seconds without battles before decay starts
  exhaustionIncome: 0.3, // income penalty at 100 % weariness
  peaceOfferAt: 55, // exhaustion level that makes an AI sue for peace
  peaceTruce: 150, // seconds of truce after a peace deal
  peaceRelief: 28, // exhaustion removed by a peace deal

  // Orders
  orderCooldown: 55,
  orderGold: { mobilize: 45, tax: 15, march: 20 },
  buffDuration: { tax: 40, march: 24 },
  mobilizeShare: 0.35,

  // Economy multipliers for AI
  aiSpendReserve: 45,
  aiThinkBase: 4.2,

  // Log
  logLimit: 50,
};

const pct = (v) => `${Math.round(v * 100)}%`;

export const UPGRADES = {
  factory: {
    id: 'factory',
    name: 'Мануфактура',
    icon: 'factory',
    description: `+${pct(BAL.factoryIncome)} дохода, +${pct(BAL.factoryManpower)} рекрутов за уровень`,
    short: `+${pct(BAL.factoryIncome)} дохода провинции`,
  },
  fort: {
    id: 'fort',
    name: 'Крепость',
    icon: 'fort',
    description: `+${pct(BAL.fortDefense)} к обороне за уровень`,
    short: `+${pct(BAL.fortDefense)} к обороне провинции`,
  },
  barracks: {
    id: 'barracks',
    name: 'Казармы',
    icon: 'barracks',
    description: `+${pct(BAL.barracksGarrison)} к гарнизону и +${pct(BAL.barracksReinforce)} к пополнению за уровень`,
    short: `+${pct(BAL.barracksGarrison)} к гарнизону провинции`,
  },
};

export const ORDERS = {
  mobilize: {
    id: 'mobilize',
    name: 'Всеобщая мобилизация',
    icon: 'mobilize',
    description: 'Сразу добавить войска во все провинции за рекрутов',
  },
  tax: {
    id: 'tax',
    name: 'Военный налог',
    icon: 'tax',
    description: `Двойной доход на ${BAL.buffDuration.tax} секунд`,
  },
  march: {
    id: 'march',
    name: 'Форсированный марш',
    icon: 'march',
    description: `+60% к скорости армий на ${BAL.buffDuration.march} секунд`,
  },
};

export function doctrineMod(doctrine, key) {
  if (doctrine === 'sword' && key === 'attack') return 0.2;
  if (doctrine === 'coin' && key === 'income') return 0.3;
  if (doctrine === 'wall' && key === 'defense') return 0.4;
  if (doctrine === 'wall' && key === 'garrison') return 0.15;
  return 0;
}
