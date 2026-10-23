// Province master list for the North American theatre.
//
// Natural Earth 110m only ships country-level geometry, so large countries are
// cut into named regions. Each region has a seed point; a country's land is
// split between its seeds with straight bisectors (nearest-seed rule), which
// gives organic-looking borders instead of rectangular cuts. `ringBox` says
// which source polygons a province may claim: Alaska and the contiguous US are
// separate polygons of one country, and Hawaii is not on this map at all.
//
// Numbers are approximate and only used as economy weights, like the European ones.
export const AMERICA = {
  // A little tighter than the full continent: keeps the theatre readable on a
  // landscape phone screen without turning Canada into a wall of ice.
  bounds: { lonMin: -170, lonMax: -52, latMin: 15, latMax: 70 },
  provinces: [
    // --- United States -------------------------------------------------------
    {
      id: 'NE', source: 'United States of America', name: 'New England', nameRu: 'Новая Англия',
      pop: 85, seed: [-72, 42.5], neighbors: ['CA', 'MW', 'SO'], ringBox: [-130, -60, 24, 50],
    },
    {
      id: 'MW', source: 'United States of America', name: 'Midwest', nameRu: 'Средний Запад',
      pop: 45, seed: [-91, 42], neighbors: ['NE', 'SO', 'PL', 'WE', 'CA', 'NW'], ringBox: [-130, -60, 24, 50],
    },
    {
      id: 'SO', source: 'United States of America', name: 'The South', nameRu: 'Юг',
      pop: 70, seed: [-85, 34.5], neighbors: ['NE', 'MW', 'PL', 'WE', 'FL'], ringBox: [-130, -60, 24, 50],
    },
    {
      id: 'FL', source: 'United States of America', name: 'Florida', nameRu: 'Флорида',
      pop: 22, seed: [-81.4, 27.5], neighbors: ['SO', 'CU'], ringBox: [-130, -60, 24, 50],
    },
    {
      id: 'PL', source: 'United States of America', name: 'Louisiana', nameRu: 'Луизиана',
      pop: 33, seed: [-97, 34], neighbors: ['MW', 'SO', 'WE', 'MX'], ringBox: [-130, -60, 24, 50],
    },
    {
      id: 'WE', source: 'United States of America', name: 'The West', nameRu: 'Запад',
      pop: 55, seed: [-116, 40], neighbors: ['PL', 'MW', 'SO', 'MX', 'NW', 'CA'], ringBox: [-130, -60, 24, 50],
    },
    {
      id: 'AK', source: 'United States of America', name: 'Alaska', nameRu: 'Аляска',
      pop: 0.7, seed: [-152, 62], neighbors: ['NW'], ringBox: [-170, -130, 50, 72],
    },
    // --- Canada --------------------------------------------------------------
    {
      id: 'CA', source: 'Canada', name: 'Canada', nameRu: 'Канада',
      pop: 20, seed: [-75, 48], neighbors: ['NE', 'MW', 'NW', 'GL', 'WE'],
    },
    {
      id: 'NW', source: 'Canada', name: 'Northwest Lands', nameRu: 'Северо-Западные земли',
      pop: 18, seed: [-112, 60], neighbors: ['CA', 'WE', 'AK', 'MW'],
    },
    // --- The rest ------------------------------------------------------------
    {
      id: 'GL', source: 'Greenland', name: 'Greenland', nameRu: 'Гренландия',
      pop: 0.06, seed: [-42, 62], neighbors: ['CA'],
    },
    {
      id: 'MX', source: 'Mexico', name: 'Mexico', nameRu: 'Мексика',
      pop: 128, seed: [-101, 24], neighbors: ['PL', 'WE', 'CU'],
    },
    {
      id: 'CU', source: 'Cuba', name: 'Cuba', nameRu: 'Куба',
      pop: 11, seed: [-79, 21.5], neighbors: ['FL', 'MX', 'HI'],
    },
    {
      id: 'HI', source: ['Haiti', 'Dominican Rep.'], name: 'Hispaniola', nameRu: 'Эспаньола',
      pop: 22, seed: [-71, 19], neighbors: ['CU'],
    },
  ],
  // Strait crossings and open-sea routes (land borders come from `neighbors`).
  seaLinks: [
    ['FL', 'CU'],
    ['CU', 'HI'],
    ['CU', 'MX'],
    ['CA', 'GL'],
  ],
};
