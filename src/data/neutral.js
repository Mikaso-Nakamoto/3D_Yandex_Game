// Colours for land nobody has conquered yet.
//
// The map used to paint every unowned province in the same grey, so Africa and
// half of Asia read as one shapeless «neutral territory» instead of a hundred
// countries. Here each unowned province gets its own muted shade: quiet enough
// to stay in the background next to the saturated colours of the playing
// nations, but different from its neighbours, so the borders mean something.
//
// The shades are picked by a greedy graph colouring over the province
// adjacency, the same way a paper atlas does it — neighbouring countries never
// share a colour, and a repeat further away is invisible.

// Twelve quiet atlas tones, spread over the whole hue circle. They are darker
// and flatter than the colours of the playing nations, so owned land still
// reads as «the important part», while no two neighbours share a hue. Tuned
// with tests/game.test.js: every shade stays at least deltaE 15 from every
// nation colour and deltaE 14 from every other shade.
export const NEUTRAL_SHADES = [
  '#4a4a22', // olive
  '#6e416e', // plum
  '#415c6e', // steel blue
  '#6e4141', // brick
  '#2a2a48', // navy
  '#46372d', // brown
  '#5f3d53', // mauve
  '#6e6e41', // olive yellow
  '#394079', // indigo
  '#295729', // deep green
  '#8b418b', // orchid
  '#27373f', // charcoal teal
];

/**
 * @param {Array<{id: string, neighbors: string[]}>} provinces of the current map
 * @returns {Map<string, string>} province id -> colour
 */
export function assignNeutralColors(provinces) {
  const order = [...provinces].sort(
    (a, b) => (b.neighbors?.length ?? 0) - (a.neighbors?.length ?? 0) || a.id.localeCompare(b.id),
  );
  const colors = new Map();
  // How often every shade is already on the map: spreading the picks keeps the
  // whole palette in play instead of cycling through the first three.
  const usage = new Map(NEUTRAL_SHADES.map((color) => [color, 0]));

  for (const province of order) {
    const neighbourColors = new Set();
    for (const neighbour of province.neighbors ?? []) {
      const color = colors.get(neighbour);
      if (color) neighbourColors.add(color);
    }
    const free = NEUTRAL_SHADES.filter((color) => !neighbourColors.has(color));
    const pool = free.length ? free : NEUTRAL_SHADES;
    // Least used shade first, then the earliest in the list: deterministic and
    // spread out over the map.
    let pick = pool[0];
    for (const color of pool) if (usage.get(color) < usage.get(pick)) pick = color;
    colors.set(province.id, pick);
    usage.set(pick, usage.get(pick) + 1);
  }
  for (const province of provinces) if (!colors.has(province.id)) colors.set(province.id, NEUTRAL_SHADES[0]);
  return colors;
}
