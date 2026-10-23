// Scenario data: who owns what in each era. All sets, names and balance values are original.
export const SCENARIOS = [
  {
    id: 'concert',
    title: 'Венский концерт',
    era: '1815',
    startYear: 1815,
    startMonth: 6,
    monthsPerSecond: 0.25,
    difficulty: 'Средне',
    blurb:
      'Европа после Наполеона. Пять великих держав делят континент, а Италия и Швейцария ещё ничьи. Дипломатия молчит — говорят пушки.',
    nations: [
      {
        id: 'RUS',
        army: 1.45,
        name: 'Российская империя', short: 'Россия', color: '#4f8a5b', capital: 'RU',
        provinces: ['RU', 'BY', 'UA', 'MD', 'LT', 'LV', 'EE', 'FI'], ai: { aggression: 0.9, eco: 1.05 },
      },
      {
        id: 'AUS',
        army: 1.1,
        name: 'Австрийская империя', short: 'Австрия', color: '#d9b45a', capital: 'AT',
        provinces: ['AT', 'CZ', 'SK', 'HU', 'SI', 'HR'], ai: { aggression: 0.85, eco: 1.0 },
      },
      {
        id: 'PRU',
        army: 1.2,
        name: 'Королевство Пруссия', short: 'Пруссия', color: '#59616e', capital: 'DE',
        provinces: ['DE', 'PL'], ai: { aggression: 1.0, eco: 1.0 },
      },
      {
        id: 'FRA',
        army: 1.25,
        name: 'Королевство Франция', short: 'Франция', color: '#3c6ea5', capital: 'FR',
        provinces: ['FR'], ai: { aggression: 1.0, eco: 1.05 },
      },
      {
        id: 'GBR',
        army: 1.1,
        name: 'Британская империя', short: 'Британия', color: '#b04a4a', capital: 'GB',
        provinces: ['GB', 'IE'], ai: { aggression: 0.8, eco: 1.15 },
      },
      {
        id: 'OTT',
        army: 0.6,
        name: 'Османская империя', short: 'Османы', color: '#7a5b3a', capital: 'TR',
        provinces: ['TR', 'GR', 'BG', 'BA', 'RS', 'ME', 'MK', 'AL', 'XK', 'CY', 'RO'], ai: { aggression: 0.75, eco: 0.95 },
      },
      {
        id: 'NLD',
        army: 0.85,
        name: 'Соединённое королевство', short: 'Нидерланды', color: '#e08a3c', capital: 'NL',
        provinces: ['NL', 'BE', 'LU'], ai: { aggression: 0.85, eco: 1.0 },
      },
      {
        id: 'ESP',
        army: 0.9,
        name: 'Испанская империя', short: 'Испания', color: '#b5651d', capital: 'ES',
        provinces: ['ES'], ai: { aggression: 0.8, eco: 1.0 },
      },
      {
        id: 'SWE',
        army: 0.9,
        name: 'Швеция и Норвегия', short: 'Швеция', color: '#4f8fbf', capital: 'SE',
        provinces: ['SE', 'NO'], ai: { aggression: 0.85, eco: 1.0 },
      },
      {
        id: 'DNK',
        army: 0.75,
        name: 'Королевство Дания', short: 'Дания', color: '#c96f8a', capital: 'DK',
        provinces: ['DK', 'IS'], ai: { aggression: 0.8, eco: 0.95 },
      },
      {
        id: 'POR',
        army: 0.8,
        name: 'Королевство Португалия', short: 'Португалия', color: '#4a8b88', capital: 'PT',
        provinces: ['PT'], ai: { aggression: 0.75, eco: 1.0 },
      },
    ],
    neutrals: [
      { province: 'IT', garrison: 0.95, fort: 1 },
      { province: 'CH', garrison: 0.9, fort: 1 },
    ],
    balance: { aiAggression: 0.85, aiEco: 1.0, neutralStrength: 0.9 },
  },
  {
    id: 'eve1939',
    title: 'Канун войны',
    era: '1939',
    startYear: 1939,
    startMonth: 1,
    monthsPerSecond: 0.3,
    difficulty: 'Высоко',
    blurb:
      'Мир замер перед большой войной. Танковые клинья, малые державы без шансов и нейтральная Прибалтика, которая вот-вот окажется между молотом и наковальней.',
    nations: [
      {
        id: 'GER',
        army: 1.35,
        name: 'Германский рейх', short: 'Германия', color: '#59616e', capital: 'DE',
        provinces: ['DE', 'AT', 'CZ'], ai: { aggression: 1.15, eco: 1.1 },
      },
      {
        id: 'SOV',
        army: 1.4,
        name: 'Советский Союз', short: 'СССР', color: '#9c3a3a', capital: 'RU',
        provinces: ['RU', 'UA', 'BY'], ai: { aggression: 1.1, eco: 1.0 },
      },
      {
        id: 'ITA',
        army: 0.9,
        name: 'Королевство Италия', short: 'Италия', color: '#4f8b63', capital: 'IT',
        provinces: ['IT', 'AL'], ai: { aggression: 1.05, eco: 0.95 },
      },
      {
        id: 'FRA',
        army: 1.05,
        name: 'Третья республика', short: 'Франция', color: '#3c6ea5', capital: 'FR',
        provinces: ['FR'], ai: { aggression: 0.85, eco: 1.0 },
      },
      {
        id: 'GBR',
        army: 1.0,
        name: 'Британская империя', short: 'Британия', color: '#c8a24a', capital: 'GB',
        provinces: ['GB', 'CY'], ai: { aggression: 0.8, eco: 1.15 },
      },
      {
        id: 'POL',
        army: 0.85,
        name: 'Вторая Речь Посполитая', short: 'Польша', color: '#c2536b', capital: 'PL',
        provinces: ['PL'], ai: { aggression: 0.9, eco: 1.0 },
      },
      {
        id: 'YUG',
        army: 0.72,
        name: 'Королевство Югославия', short: 'Югославия', color: '#7a6aa0', capital: 'RS',
        provinces: ['RS', 'HR', 'BA', 'SI', 'ME', 'MK', 'XK'], ai: { aggression: 0.85, eco: 0.95 },
      },
      {
        id: 'ROM',
        army: 0.75,
        name: 'Королевство Румыния', short: 'Румыния', color: '#a88f5a', capital: 'RO',
        provinces: ['RO', 'MD'], ai: { aggression: 0.85, eco: 0.95 },
      },
      {
        id: 'HUN',
        army: 0.72,
        name: 'Королевство Венгрия', short: 'Венгрия', color: '#8f6a4a', capital: 'HU',
        provinces: ['HU'], ai: { aggression: 0.9, eco: 0.95 },
      },
      {
        id: 'SVK',
        army: 0.6,
        name: 'Словацкая республика', short: 'Словакия', color: '#8f9e6a', capital: 'SK',
        provinces: ['SK'], ai: { aggression: 0.85, eco: 0.9 },
      },
      {
        id: 'BUL',
        army: 0.7,
        name: 'Царство Болгария', short: 'Болгария', color: '#7a8f5a', capital: 'BG',
        provinces: ['BG'], ai: { aggression: 0.85, eco: 0.95 },
      },
      {
        id: 'GRE',
        army: 0.7,
        name: 'Королевство Греция', short: 'Греция', color: '#5aa0c4', capital: 'GR',
        provinces: ['GR'], ai: { aggression: 0.8, eco: 0.95 },
      },
      {
        id: 'TUR',
        army: 0.75,
        name: 'Турецкая республика', short: 'Турция', color: '#a0603a', capital: 'TR',
        provinces: ['TR'], ai: { aggression: 0.8, eco: 0.95 },
      },
      {
        id: 'SWE',
        army: 0.85,
        name: 'Королевство Швеция', short: 'Швеция', color: '#3f7fb0', capital: 'SE',
        provinces: ['SE'], ai: { aggression: 0.7, eco: 1.05 },
      },
      {
        id: 'NOR',
        army: 0.65,
        name: 'Королевство Норвегия', short: 'Норвегия', color: '#a0b8d8', capital: 'NO',
        provinces: ['NO'], ai: { aggression: 0.7, eco: 1.0 },
      },
      {
        id: 'DNK',
        army: 0.6,
        name: 'Королевство Дания', short: 'Дания', color: '#c96f8a', capital: 'DK',
        provinces: ['DK'], ai: { aggression: 0.7, eco: 1.0 },
      },
      {
        id: 'FIN',
        army: 0.75,
        name: 'Республика Финляндия', short: 'Финляндия', color: '#7fb3a8', capital: 'FI',
        provinces: ['FI'], ai: { aggression: 0.75, eco: 1.0 },
      },
      {
        id: 'NLD',
        army: 0.7,
        name: 'Королевство Нидерланды', short: 'Нидерланды', color: '#e08a3c', capital: 'NL',
        provinces: ['NL'], ai: { aggression: 0.7, eco: 1.05 },
      },
      {
        id: 'BEL',
        army: 0.7,
        name: 'Королевство Бельгия', short: 'Бельгия', color: '#d9b45a', capital: 'BE',
        provinces: ['BE'], ai: { aggression: 0.7, eco: 1.05 },
      },
      {
        id: 'SUI',
        army: 0.7,
        name: 'Швейцарская конфедерация', short: 'Швейцария', color: '#b9b9b9', capital: 'CH',
        provinces: ['CH'], ai: { aggression: 0.5, eco: 1.1 },
      },
      {
        id: 'ESP',
        army: 0.8,
        name: 'Испанское государство', short: 'Испания', color: '#b5651d', capital: 'ES',
        provinces: ['ES'], ai: { aggression: 0.7, eco: 0.95 },
      },
      {
        id: 'POR',
        army: 0.7,
        name: 'Португальская республика', short: 'Португалия', color: '#4a8b88', capital: 'PT',
        provinces: ['PT'], ai: { aggression: 0.65, eco: 0.95 },
      },
    ],
    neutrals: [
      { province: 'EE', garrison: 0.55, fort: 0 },
      { province: 'LV', garrison: 0.55, fort: 0 },
      { province: 'LT', garrison: 0.6, fort: 0 },
      { province: 'IE', garrison: 0.7, fort: 0 },
      { province: 'IS', garrison: 0.3, fort: 0 },
      { province: 'LU', garrison: 0.5, fort: 1 },
    ],
    balance: { aiAggression: 0.95, aiEco: 1.0, neutralStrength: 0.85 },
  },
  {
    id: 'mosaic',
    title: 'Мозаика',
    era: '1444',
    startYear: 1444,
    startMonth: 11,
    monthsPerSecond: 0.35,
    difficulty: 'Средне',
    blurb:
      'Позднее Средневековье. Империя трещит по швам, унии держатся на династиях, а на востоке поднимается новая сила. Каждый сосед — соперник.',
    nations: [
      {
        id: 'HRE',
        army: 1.0,
        name: 'Священная Римская империя', short: 'Империя', color: '#d9b45a', capital: 'AT',
        provinces: ['DE', 'AT', 'CZ', 'LU', 'NL', 'BE', 'SI'], ai: { aggression: 0.85, eco: 1.1 },
      },
      {
        id: 'FRA',
        army: 1.05,
        name: 'Королевство Франция', short: 'Франция', color: '#3c6ea5', capital: 'FR',
        provinces: ['FR'], ai: { aggression: 1.0, eco: 1.05 },
      },
      {
        id: 'OTT',
        army: 1.3,
        name: 'Османская держава', short: 'Османы', color: '#7a5b3a', capital: 'TR',
        provinces: ['TR', 'GR', 'BG', 'BA', 'RS', 'ME', 'MK', 'AL', 'XK', 'MD'], ai: { aggression: 1.2, eco: 1.0 },
      },
      {
        id: 'POL',
        army: 1.15,
        name: 'Польско-Литовское государство', short: 'Польша-Литва', color: '#b4484f', capital: 'PL',
        provinces: ['PL', 'LT', 'BY', 'UA'], ai: { aggression: 0.95, eco: 1.0 },
      },
      {
        id: 'HUN',
        army: 0.95,
        name: 'Королевство Венгрия', short: 'Венгрия', color: '#8f6a4a', capital: 'HU',
        provinces: ['HU', 'SK', 'HR'], ai: { aggression: 0.95, eco: 0.95 },
      },
      {
        id: 'KAL',
        army: 0.9,
        name: 'Кальмарская уния', short: 'Уния', color: '#4f8fbf', capital: 'DK',
        provinces: ['DK', 'SE', 'NO', 'FI', 'IS'], ai: { aggression: 0.8, eco: 1.05 },
      },
      {
        id: 'MOS',
        army: 1.2,
        name: 'Великое княжество Московское', short: 'Московия', color: '#4f8a5b', capital: 'RU',
        provinces: ['RU'], ai: { aggression: 1.1, eco: 0.95 },
      },
      {
        id: 'ENG',
        army: 0.9,
        name: 'Королевство Англия', short: 'Англия', color: '#b04a4a', capital: 'GB',
        provinces: ['GB'], ai: { aggression: 0.9, eco: 1.05 },
      },
      {
        id: 'CAS',
        army: 0.9,
        name: 'Королевство Кастилия', short: 'Кастилия', color: '#c9a227', capital: 'ES',
        provinces: ['ES'], ai: { aggression: 0.9, eco: 1.0 },
      },
      {
        id: 'POR',
        army: 0.85,
        name: 'Королевство Португалия', short: 'Португалия', color: '#4a8b88', capital: 'PT',
        provinces: ['PT'], ai: { aggression: 0.8, eco: 1.05 },
      },
      {
        id: 'LIV',
        army: 0.8,
        name: 'Ливонский орден', short: 'Ливония', color: '#8f9e6a', capital: 'LV',
        provinces: ['EE', 'LV'], ai: { aggression: 0.85, eco: 0.9 },
      },
    ],
    neutrals: [
      { province: 'IT', garrison: 0.95, fort: 2 },
      { province: 'CH', garrison: 0.9, fort: 2 },
      { province: 'IE', garrison: 0.6, fort: 0 },
      { province: 'CY', garrison: 0.6, fort: 1 },
      { province: 'RO', garrison: 0.65, fort: 1 },
    ],
    balance: { aiAggression: 1.0, aiEco: 1.0, neutralStrength: 0.9 },
  },
];

export const SCENARIO_BY_ID = Object.fromEntries(SCENARIOS.map((s) => [s.id, s]));

export function getScenario(id) {
  return SCENARIO_BY_ID[id] ?? SCENARIOS[0];
}

export const DOCTRINES = [
  {
    id: 'sword',
    name: 'Оружие',
    icon: 'sword',
    description: '+20% к силе атаки. Война кормит войну.',
    effectLabel: '+20% атака',
    effects: { attack: 0.2 },
  },
  {
    id: 'coin',
    name: 'Казна',
    icon: 'coin',
    description: '+30% к доходу. Золото покупает армии.',
    effectLabel: '+30% доход',
    effects: { income: 0.3 },
  },
  {
    id: 'wall',
    name: 'Стены',
    icon: 'wall',
    description: '+40% к обороне и +15% к гарнизону. Держать своё.',
    effectLabel: '+40% оборона',
    effects: { defense: 0.4, garrison: 0.15 },
  },
];

export const DOCTRINE_BY_ID = Object.fromEntries(DOCTRINES.map((d) => [d.id, d]));
