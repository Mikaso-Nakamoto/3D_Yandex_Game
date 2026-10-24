// Historical focus chains: a short list of ambitions for every nation, in the
// spirit of a HOI-style focus tree but trimmed to what a browser map game can
// explain in one line.
//
// A focus names a province to take and a reward for taking it. Chains are keyed
// by the base scenario id (the Atlantic variants reuse them), then by nation,
// and fall back to a chain generated from the map when a nation has none. All
// names and rewards are original content; only the *idea* of national focuses is
// borrowed, which is not copyrightable.
//
// `targets` are province ids. If a target is already owned by the nation in that
// scenario, it is skipped when the chain is built.

export const FOCUS_CHAINS = {
  concert: {
    RUS: [
      { name: 'Выход к Балтике', target: 'LV', gold: 70, morale: 3 },
      { name: 'Польское наследство', target: 'PL', gold: 90, morale: 3 },
      { name: 'Ключ к Босфору', target: 'TR', gold: 130, morale: 4 },
    ],
    AUS: [
      { name: 'Германский союз', target: 'DE', gold: 80, morale: 3 },
      { name: 'Итальянские земли', target: 'IT', gold: 110, morale: 3 },
      { name: 'Балканский вопрос', target: 'RS', gold: 120, morale: 4 },
    ],
    PRU: [
      { name: 'Северогерманский союз', target: 'DK', gold: 70, morale: 3 },
      { name: 'Рейнская граница', target: 'NL', gold: 100, morale: 3 },
      { name: 'Германское единство', target: 'AT', gold: 140, morale: 4 },
    ],
    FRA: [
      { name: 'Естественные границы', target: 'BE', gold: 80, morale: 3 },
      { name: 'Королевство Италия', target: 'IT', gold: 110, morale: 3 },
      { name: 'Континентальный мир', target: 'ES', gold: 120, morale: 4 },
    ],
    GBR: [
      { name: 'Контроль над Ла-Маншем', target: 'NL', gold: 80, morale: 3 },
      { name: 'Средиземноморский путь', target: 'PT', gold: 100, morale: 3 },
      { name: 'Баланс сил', target: 'FR', gold: 150, morale: 4 },
    ],
    OTT: [
      { name: 'Реванш на Балканах', target: 'RS', gold: 70, morale: 3 },
      { name: 'Врата Кавказа', target: 'UA', gold: 110, morale: 3 },
      { name: 'Египетский поход', target: 'CY', gold: 100, morale: 4 },
    ],
    NLD: [
      { name: 'Южные провинции', target: 'BE', gold: 70, morale: 3 },
      { name: 'Рейнское устье', target: 'DE', gold: 100, morale: 3 },
    ],
    ESP: [
      { name: 'Пиренейское единство', target: 'PT', gold: 80, morale: 3 },
      { name: 'Заокеанские колонии', target: 'MX', gold: 130, morale: 4 },
    ],
    SWE: [
      { name: 'Балтийское господство', target: 'DK', gold: 70, morale: 3 },
      { name: 'Финские земли', target: 'FI', gold: 100, morale: 3 },
    ],
    DNK: [
      { name: 'Датская Индия', target: 'IS', gold: 50, morale: 3 },
      { name: 'Зундский сбор', target: 'SE', gold: 90, morale: 3 },
    ],
    POR: [
      { name: 'Бразильский путь', target: 'ES', gold: 90, morale: 3 },
      { name: 'Атлантические порты', target: 'FR', gold: 120, morale: 4 },
    ],
    USA: [
      { name: 'Доктрина Монро', target: 'FL', gold: 80, morale: 3 },
      { name: 'Западное расширение', target: 'WE', gold: 110, morale: 3 },
      { name: 'Северная граница', target: 'CA', gold: 140, morale: 4 },
    ],
  },
  eve1939: {
    GER: [
      { name: 'Первый удар', target: 'PL', gold: 100, morale: 4 },
      { name: 'Париж', target: 'FR', gold: 140, morale: 5 },
      { name: 'Восточное пространство', target: 'RU', gold: 220, morale: 6 },
    ],
    SOV: [
      { name: 'Финская граница', target: 'FI', gold: 90, morale: 3 },
      { name: 'Балтийские республики', target: 'LT', gold: 90, morale: 3 },
      { name: 'Берлин', target: 'DE', gold: 200, morale: 6 },
    ],
    ITA: [
      { name: 'Mare Nostrum', target: 'GR', gold: 90, morale: 3 },
      { name: 'Северная Африка', target: 'CY', gold: 90, morale: 3 },
      { name: 'Римская империя', target: 'FR', gold: 150, morale: 5 },
    ],
    FRA: [
      { name: 'Мажино и Рейн', target: 'DE', gold: 120, morale: 4 },
      { name: 'Западный союз', target: 'BE', gold: 90, morale: 3 },
    ],
    GBR: [
      { name: 'Морская блокада', target: 'NOR', gold: 90, morale: 3 },
      { name: 'Средиземноморье', target: 'IT', gold: 130, morale: 4 },
      { name: 'Континентальный фронт', target: 'FR', gold: 120, morale: 4 },
    ],
    POL: [
      { name: 'Оборона Вислы', target: 'DE', gold: 90, morale: 4 },
      { name: 'Западные земли', target: 'CZ', gold: 100, morale: 4 },
    ],
    USA: [
      { name: 'Американский щит', target: 'CA', gold: 100, morale: 3 },
      { name: 'Тихоокеанский фронт', target: 'AK', gold: 90, morale: 3 },
      { name: 'Освобождение Европы', target: 'FR', gold: 180, morale: 5 },
    ],
  },
  mosaic: {
    HRE: [
      { name: 'Имперская корона', target: 'CZ', gold: 70, morale: 3 },
      { name: 'Итальянский поход', target: 'IT', gold: 100, morale: 4 },
      { name: 'Римское наследство', target: 'CA', gold: 120, morale: 4 },
    ],
    FRA: [
      { name: 'Бургундское наследство', target: 'BE', gold: 70, morale: 3 },
      { name: 'Фландрские города', target: 'NL', gold: 90, morale: 3 },
    ],
    OTT: [
      { name: 'Взятие Константинополя', target: 'GR', gold: 90, morale: 4 },
      { name: 'Балканский поход', target: 'RS', gold: 90, morale: 4 },
      { name: 'Восточное владычество', target: 'HU', gold: 120, morale: 5 },
    ],
    POL: [
      { name: 'Грюнвальдская слава', target: 'KGD', gold: 80, morale: 4 },
      { name: 'Балтийский порт', target: 'EE', gold: 80, morale: 3 },
      { name: 'Королевство земель', target: 'BY', gold: 100, morale: 4 },
    ],
    HUN: [
      { name: 'Хорватская корона', target: 'HR', gold: 60, morale: 3 },
      { name: 'Венский двор', target: 'AT', gold: 110, morale: 4 },
    ],
    KAL: [
      { name: 'Кальмарская корона', target: 'NO', gold: 70, morale: 3 },
      { name: 'Балтийский перевес', target: 'EE', gold: 80, morale: 3 },
      { name: 'Северная империя', target: 'IS', gold: 70, morale: 4 },
    ],
    MOS: [
      { name: 'Собирание земель', target: 'BY', gold: 80, morale: 3 },
      { name: 'Новгородское наследство', target: 'EE', gold: 80, morale: 3 },
      { name: 'Третий Рим', target: 'KGD', gold: 120, morale: 5 },
    ],
    ENG: [
      { name: 'Французская корона', target: 'FR', gold: 100, morale: 4 },
      { name: 'Западные острова', target: 'IE', gold: 60, morale: 3 },
    ],
    CAS: [
      { name: 'Реконкиста', target: 'PT', gold: 70, morale: 4 },
      { name: 'Итальянские владения', target: 'IT', gold: 100, morale: 3 },
    ],
    POR: [
      { name: 'Африканский берег', target: 'ES', gold: 80, morale: 3 },
      { name: 'Индийский путь', target: 'PT', gold: 50, morale: 3 },
    ],
    LIV: [
      { name: 'Ливонская твердыня', target: 'LT', gold: 60, morale: 3 },
      { name: 'Ганзейская торговля', target: 'EE', gold: 80, morale: 3 },
    ],
  },
  civil1861: {
    USA: [
      { name: 'Сохранить Союз', target: 'SO', gold: 100, morale: 4 },
      { name: 'Мексиканская граница', target: 'MX', gold: 120, morale: 4 },
      { name: 'Северная Америка', target: 'CA', gold: 160, morale: 5 },
    ],
    CSA: [
      { name: 'Независимость', target: 'NE', gold: 110, morale: 4 },
      { name: 'Западная граница', target: 'WE', gold: 110, morale: 4 },
      { name: 'Тринадцать колоний', target: 'CA', gold: 150, morale: 5 },
    ],
    MEX: [
      { name: 'Техас и Калифорния', target: 'LO', gold: 110, morale: 4 },
      { name: 'Центральная Америка', target: 'CU', gold: 90, morale: 3 },
    ],
    HAI: [
      { name: 'Антильский союз', target: 'CU', gold: 80, morale: 4 },
      { name: 'Островная свобода', target: 'FL', gold: 110, morale: 4 },
    ],
    RUS: [
      { name: 'Аляска и форт', target: 'AK', gold: 80, morale: 3 },
      { name: 'Тихоокеанская база', target: 'CA', gold: 130, morale: 4 },
    ],
    GBR: [
      { name: 'Канадский коридор', target: 'NW', gold: 90, morale: 3 },
      { name: 'Континентальный перевес', target: 'NE', gold: 140, morale: 4 },
    ],
  },
  // The world theatre: ambitions of the great powers, each one naming a region
  // that exists on the cylinder. China gets its own chain so a Chinese campaign
  // opens with a plan that makes sense from Nanjing instead of a random border.
  world1939: {
    CHN: [
      { name: 'Воссоединение Монголии', target: 'MNG', gold: 90, morale: 3 },
      { name: 'Возвращение Кореи', target: 'KOR', gold: 130, morale: 4 },
      { name: 'Южные ворота', target: 'VNM', gold: 120, morale: 3 },
    ],
    GER: [
      { name: 'Польский коридор', target: 'PL', gold: 110, morale: 3 },
      { name: 'Ключ к Ла-Маншу', target: 'BE', gold: 130, morale: 4 },
      { name: 'Хлеб Украины', target: 'UA', gold: 170, morale: 4 },
    ],
    SOV: [
      { name: 'Балтийский щит', target: 'LV', gold: 100, morale: 3 },
      { name: 'Южный рубеж', target: 'IRN', gold: 130, morale: 3 },
      { name: 'Проливы', target: 'TR', gold: 160, morale: 4 },
    ],
    USA: [
      { name: 'Карибский щит', target: 'CU', gold: 100, morale: 3 },
      { name: 'Южная граница', target: 'MX', gold: 120, morale: 3 },
      { name: 'Тихоокеанские рубежи', target: 'PHL', gold: 160, morale: 4 },
    ],
    GBR: [
      { name: 'Средиземноморские ворота', target: 'GR', gold: 110, morale: 3 },
      { name: 'Нефтяной путь', target: 'IRN', gold: 140, morale: 3 },
      { name: 'Ближневосточный плацдарм', target: 'SAU', gold: 150, morale: 4 },
    ],
    FRA: [
      { name: 'Рейнская граница', target: 'BE', gold: 110, morale: 3 },
      { name: 'Иберийский сосед', target: 'ES', gold: 130, morale: 3 },
      { name: 'Восточное Средиземноморье', target: 'TR', gold: 150, morale: 4 },
    ],
    ITA: [
      { name: 'Адриатический берег', target: 'AL', gold: 90, morale: 3 },
      { name: 'Эгейские острова', target: 'GR', gold: 120, morale: 4 },
      { name: 'Суэцкий путь', target: 'EGY', gold: 160, morale: 4 },
    ],
    JPN: [
      { name: 'Маньчжурский плацдарм', target: 'MAN', gold: 120, morale: 4 },
      { name: 'Филиппины', target: 'PHL', gold: 140, morale: 4 },
      { name: 'Южные моря', target: 'IDN', gold: 170, morale: 5 },
    ],
    POL: [
      { name: 'Силезский рубеж', target: 'CZ', gold: 90, morale: 3 },
      { name: 'Балтийское побережье', target: 'LT', gold: 110, morale: 3 },
      { name: 'Восточные земли', target: 'UA', gold: 140, morale: 4 },
    ],
    TUR: [
      { name: 'Балканский рубеж', target: 'BG', gold: 100, morale: 3 },
      { name: 'Кавказский сосед', target: 'ARM', gold: 130, morale: 3 },
      { name: 'Сирийская граница', target: 'SYR', gold: 140, morale: 4 },
    ],
    BNA: [
      { name: 'Лаврентийский щит', target: 'GL', gold: 90, morale: 3 },
      { name: 'Западные прерии', target: 'WE', gold: 120, morale: 3 },
      { name: 'Северный путь', target: 'AK', gold: 140, morale: 4 },
    ],
  },
};

// Fallback: three nearest foreign provinces around the capital. This keeps the
// mechanic working for every minor nation and for any future scenario.
export function fallbackChain(game, nation, state = game.state) {
  const capital = state.provinces[nation.capital];
  if (!capital) return [];
  const distance = new Map([[nation.capital, 0]]);
  const queue = [nation.capital];
  const order = [];
  while (queue.length) {
    const id = queue.shift();
    for (const nid of game.neighbors(id)) {
      if (distance.has(nid)) continue;
      distance.set(nid, distance.get(id) + 1);
      queue.push(nid);
      if (state.provinces[nid].owner !== nation.id) order.push(nid);
      if (order.length >= 3) break;
    }
    if (order.length >= 3) break;
  }
  return order.map((target, index) => ({
    name: `Расширение: ${game.provinceName(target)}`,
    target,
    gold: 60 + index * 25,
    morale: 2 + index,
  }));
}

/**
 * The other road out of the capital: a province on the opposite side of the
 * country from the historical ambition. Each step is therefore a choice —
 * «на запад» or «на восток» — and the map decides what that means.
 */
export function oppositeTarget(game, nation, step, taken, state = game.state) {
  // Geography lives on the static map (`byId`), ownership on the live state.
  const capital = game.byId[nation.capital]?.centroid;
  const goal = game.byId[step.target]?.centroid;
  if (!capital || !goal) return null;
  const period = game.map?.wrap?.period;
  // Signed shortest way round the cylinder: on the world map Kamchatka is just
  // east of Moscow, not a whole planet west of it.
  const delta = (a, b) => {
    let d = a - b;
    if (period) d = (((d + period / 2) % period) + period) % period - period / 2;
    return d;
  };
  const side = Math.sign(delta(goal[0], capital[0])) || 1;
  const goalOwner = state.provinces[step.target]?.owner ?? null;
  const owned = Object.entries(state.provinces).filter(([, p]) => p.owner === nation.id);
  const seen = new Set(taken);
  seen.add(step.target);
  let best = null;
  for (const [id] of owned) {
    for (const nid of game.neighbors(id)) {
      const p = state.provinces[nid];
      const geo = game.byId[nid];
      if (!geo?.centroid || !p || p.owner === nation.id || seen.has(nid)) continue;
      const dx = delta(geo.centroid[0], capital[0]);
      const dy = geo.centroid[1] - capital[1];
      const dist = game.distance(nation.capital, nid);
      // Farther side of the country first, then a different neighbour: the
      // worst answer would be «the same war you already planned, one province
      // to the left».
      const opposite = Math.sign(dx) === -side && Math.abs(dx) >= 0.5;
      const otherWar = goalOwner == null || p.owner !== goalOwner;
      const score = (opposite ? 0 : 2) + (otherWar ? 0 : 1);
      const candidate = { id: nid, dist, dx, dy, score };
      if (!best || candidate.score < best.score || (candidate.score === best.score && dist < best.dist)) {
        best = candidate;
      }
    }
  }
  if (!best) return null;
  const word =
    Math.abs(best.dx) >= Math.abs(best.dy)
      ? best.dx < 0
        ? 'запад'
        : 'восток'
      : best.dy < 0
        ? 'север'
        : 'юг';
  return {
    name: `Поход на ${word}`,
    target: best.id,
    gold: step.gold,
    morale: step.morale,
    done: false,
  };
}

/**
 * Builds the chain a nation starts with: hand-written ambitions first, then a
 * generated tail, and any target that is already its own is dropped. A chain is
 * never empty: if every ambition is already fulfilled, the generated one is used.
 * Every step also carries an `alt` — the same reward for a push the other way.
 */
export function buildFocusChain(game, nation, scenarioId, state = game.state) {
  const baseId = scenarioId.split('-')[0];
  const authored = FOCUS_CHAINS[baseId]?.[nation.id] ?? [];
  const clean = authored.filter((step) => {
    const province = state.provinces[step.target];
    return province && province.owner !== nation.id;
  });
  if (!clean.length) clean.push(...fallbackChain(game, nation, state));
  const chain = clean.slice(0, 3).map((step) => ({
    name: step.name,
    target: step.target,
    gold: step.gold,
    morale: step.morale,
    done: false,
  }));
  const taken = [];
  for (const step of chain) {
    step.alt = oppositeTarget(game, nation, step, taken, state);
    if (step.alt) taken.push(step.alt.target);
  }
  return chain;
}
