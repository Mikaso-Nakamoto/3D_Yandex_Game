// Single place for tunable numbers. Values are in "game seconds" at speed x1.
export const BAL = {
  victoryShare: 1, // full conquest: every province of the theatre

  // Province economy
  incomeBase: 0.025,
  incomePop: 0.005,
  factoryIncome: 0.5,
  // Recruits per second, per province. Tuned against reinforceShare so that a
  // ruined garrison refills at roughly the rate recruits arrive: with the old
  // 0.035 + 0.0011·pop the demand was ~10× the supply, the pool sat at zero and
  // a beaten army could never be rebuilt ("я копил силы, а уже проиграл").
  manpowerBase: 0.12,
  manpowerPop: 0.0114,
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
  // A sea crossing is not free: storms and transport losses eat a few men on
  // every leg over water. Small enough not to punish an invasion, big enough
  // that a sea route is a decision and not a shortcut.
  seaAttrition: 0.04,
  // Several columns sent at one province fight as one force. The first column
  // to arrive waits for the others that are already on the road, but not
  // forever: a stalled march must not freeze the battle.
  assaultWait: 10,
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
  // Homeland defence. A capital and the last two provinces of a dying realm
  // are defended harder: without this, one lost border province snowballed into
  // half of Europe disappearing before the player's first five minutes.
  capitalDefense: 0.2,
  lastStandDefense: 0.18,
  // A tired nation does not open new fronts: above this exhaustion it only
  // attacks when it is clearly stronger than the defender.
  warWearyAt: 45,
  warWearyMargin: 2.1,
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
  peaceTalksWindow: 150,
  // A refused or ignored offer is not repeated at once: the same neighbour
  // offering the same pact every few seconds turned the offer card into spam.
  offerCooldown: 150,
  offerCooldownAfterRefusal: 240, // after a refusal the same nation stays quiet longer
  peaceTruce: 150, // seconds of truce after a peace deal
  peaceRelief: 28, // exhaustion removed by a peace deal
  pactTruce: 240, // a non-aggression pact lasts longer than a peace deal
  pactRelief: 10, // ...but calms the rivals down less

  // Right of passage: a signed permission to march through someone else's
  // land. It is shorter than a pact (it is given for a single campaign, not
  // for a friendship) and costs time on the road: foreign soil is not a road
  // works project of yours.
  passageTruce: 180,
  passageTravelMul: 1.15,
  passageAskCooldown: 120,
  passageAskCooldownAfterRefusal: 200,

  // Orders
  orderCooldown: 55,
  orderGold: { mobilize: 45, tax: 15, march: 20 },
  buffDuration: { tax: 40, march: 24 },
  mobilizeShare: 0.35,

  // Economy multipliers for AI
  aiSpendReserve: 45,
  aiThinkBase: 4.2,
  // The AI starts cautious and winds up: at t=0 it acts on ~45 % of its usual
  // aggression, reaching the full tempo after this many seconds. Without the
  // ramp a 3-province neighbour swallowed five neutral provinces inside a
  // minute while the player was still reading the tutorial.
  aiOpeningRamp: 300,
  aiOpeningTempo: 0.45,

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
