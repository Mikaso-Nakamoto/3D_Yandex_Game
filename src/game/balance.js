// Single place for tunable numbers. Values are in "game seconds" at speed x1.
export const BAL = {
  victoryShare: 0.5,

  // Province economy
  incomeBase: 0.02,
  incomePop: 0.0042,
  factoryIncome: 0.4,
  manpowerBase: 0.035,
  manpowerPop: 0.0011,
  factoryManpower: 0.25,
  manpowerCapBase: 150,
  manpowerCapPop: 4,
  startManpower: 320,
  startGoldBase: 60,
  startGoldPerProvince: 12,

  // Garrisons
  garrisonBase: 20,
  garrisonPop: 1.9,
  barracksGarrison: 0.18,
  reinforceShare: 0.006, // share of max garrison per second

  // Combat
  fortDefense: 0.3,
  seaTravelMul: 1.7,
  armySpeed: 1.35, // map units per second
  minTravel: 2.2,
  maxTravel: 16,
  minSend: 4,
  seaMinTravel: 1.6,
  combatSwing: 0.08,
  loserSurvivorBase: 0.6,

  // Upgrades
  maxLevel: 3,
  upgradeCosts: {
    factory: [45, 85, 140],
    fort: [40, 75, 120],
    barracks: [35, 65, 105],
  },

  // Orders
  orderCooldown: 55,
  orderGold: { mobilize: 45, tax: 30, march: 25 },
  buffDuration: { tax: 18, march: 22 },
  mobilizeShare: 0.35,

  // Economy multipliers for AI
  aiSpendReserve: 100,
  aiThinkBase: 4.2,

  // Log
  logLimit: 50,
};

export const UPGRADES = {
  factory: {
    id: 'factory',
    name: 'Мануфактура',
    icon: 'factory',
    description: '+40% дохода, +25% рекрутов',
    short: '+40% дохода провинции',
  },
  fort: {
    id: 'fort',
    name: 'Крепость',
    icon: 'fort',
    description: '+30% к обороне за уровень',
    short: '+30% к обороне провинции',
  },
  barracks: {
    id: 'barracks',
    name: 'Казармы',
    icon: 'barracks',
    description: '+18% к гарнизону за уровень',
    short: '+18% к гарнизону и пополнению',
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
    description: 'Двойной доход на 18 секунд',
  },
  march: {
    id: 'march',
    name: 'Форсированный марш',
    icon: 'march',
    description: '+60% к скорости армий на 22 секунды',
  },
};

export function doctrineMod(doctrine, key) {
  if (doctrine === 'sword' && key === 'attack') return 0.2;
  if (doctrine === 'coin' && key === 'income') return 0.3;
  if (doctrine === 'wall' && key === 'defense') return 0.4;
  if (doctrine === 'wall' && key === 'garrison') return 0.15;
  return 0;
}
