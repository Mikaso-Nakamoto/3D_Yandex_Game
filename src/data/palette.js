// Distinct colours for the political map.
//
// A conquest map is read by colour, so two nations of nearly the same hue are a
// real usability problem: on the Atlantic map the USA (#3f6fb5) and the French
// Third Republic (#3c6ea5) looked like one country, and British North America
// shared Britain's exact red. Every scenario therefore runs its palette through
// `distinctColors`, which keeps each nation's authored colour when it is far
// enough from the previous ones and otherwise walks its hue around the wheel
// until it is.

const clamp = (v, min, max) => Math.min(max, Math.max(min, v));

export function hexToRgb(hex) {
  const value = hex.replace('#', '');
  return [
    parseInt(value.slice(0, 2), 16) / 255,
    parseInt(value.slice(2, 4), 16) / 255,
    parseInt(value.slice(4, 6), 16) / 255,
  ];
}

export function rgbToHex([r, g, b]) {
  const part = (v) => Math.round(clamp(v, 0, 1) * 255).toString(16).padStart(2, '0');
  return `#${part(r)}${part(g)}${part(b)}`;
}

const toLinear = (v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);

/** CIE L*a*b*, so «these two look alike» is a number and not a guess. */
export function rgbToLab([r, g, b]) {
  const R = toLinear(r);
  const G = toLinear(g);
  const B = toLinear(b);
  // sRGB -> XYZ (D65), scaled to the usual 0..100 reference white.
  const x = (R * 0.4124 + G * 0.3576 + B * 0.1805) / 0.95047;
  const y = R * 0.2126 + G * 0.7152 + B * 0.0722;
  const z = (R * 0.0193 + G * 0.1192 + B * 0.9505) / 1.08883;
  const f = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  const fx = f(x);
  const fy = f(y);
  const fz = f(z);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

export function deltaE(a, b) {
  const A = rgbToLab(hexToRgb(a));
  const B = rgbToLab(hexToRgb(b));
  return Math.hypot(A[0] - B[0], A[1] - B[1], A[2] - B[2]);
}

export function rgbToHsl([r, g, b]) {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l };
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h;
  if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
  else if (max === g) h = ((b - r) / d + 2) / 6;
  else h = ((r - g) / d + 4) / 6;
  return { h: h * 360, s, l };
}

export function hslToHex(h, s, l) {
  const hue = ((h % 360) + 360) % 360;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((hue / 60) % 2) - 1));
  const m = l - c / 2;
  const [r, g, b] =
    hue < 60
      ? [c, x, 0]
      : hue < 120
        ? [x, c, 0]
        : hue < 180
          ? [0, c, x]
          : hue < 240
            ? [0, x, c]
            : hue < 300
              ? [x, 0, c]
              : [c, 0, x];
  return rgbToHex([r + m, g + m, b + m]);
}

/** Perceptual distance below which two nations read as «the same colour». */
export const MIN_SEPARATION = 17;

/**
 * Two colours read as «different country» when they are far enough apart in
 * CIE L*a*b*. The number was tuned on the real palettes of this game: the pairs
 * the player complained about (USA and France, Canada and Britain) sat around
 * 9–10, while gold-versus-orange at 26 reads fine on the map.
 */
export function isDistinct(a, b, min = MIN_SEPARATION) {
  return deltaE(a, b) >= min;
}

/** Finds the closest variation of `color` that is far from every `taken`. */
export function nearestFree(color, taken, min = MIN_SEPARATION) {
  if (taken.every((used) => isDistinct(used, color, min))) return color;
  const { h, s, l } = rgbToHsl(hexToRgb(color));
  for (let step = 1; step <= 40; step += 1) {
    for (const dir of [1, -1]) {
      for (const dl of [0, 0.08, -0.1, 0.15, -0.16]) {
        // Map colours live in a narrow band: bright enough to separate
        // neighbours, dark enough to keep the white labels readable.
        const candidate = hslToHex(h + dir * step * 9, clamp(s, 0.34, 0.62), clamp(l + dl, 0.32, 0.68));
        if (taken.every((used) => isDistinct(used, candidate, min))) return candidate;
      }
    }
  }
  // A full turn of the wheel without a free slot means the palette is too
  // crowded for that many nations; the authored colour beats an arbitrary one.
  return color;
}

/**
 * Keeps the authored colours in order, moving only the ones that collide with a
 * colour already taken.
 */
export function distinctColors(colors, min = MIN_SEPARATION) {
  const out = [];
  for (const color of colors) out.push(nearestFree(color, out, min));
  return out;
}

// Unowned land. Darker than every nation in the palette on purpose: the old
// grey was so close to Germany's field grey that half of Europe read as one
// country. A dark neutral makes owned land pop.
export const NEUTRAL_COLOR = '#3c434b';

// A curated political palette, one colour per nation.
//
// The colours are hand-picked and checked against each other: on a map of
// twenty-odd nations, two countries of the same hue read as one country, which
// is exactly what happened when the USA and the French Third Republic were both
// blue and Canada wore Britain's exact red. `tests/game.test.js` fails if any
// two nations that share a scenario come closer than MIN_SEPARATION.
export const NATION_COLORS = {
  RUS: '#4f8a5b', AUS: '#d9b45a', PRU: '#4c5548', FRA: '#5a4fa8', GBR: '#b04a4a',
  OTT: '#7a5b3a', NLD: '#e08a3c', ESP: '#9a6a20', SWE: '#6c86a8', DNK: '#d98fa0',
  POR: '#429cae', GER: '#4c5548', SOV: '#7b2b33', ITA: '#4f8b63', POL: '#ae4266',
  YUG: '#7a6aa0', ROM: '#aeae42', HUN: '#a88f5a', SVK: '#8f9e6a', BUL: '#5f7632',
  GRE: '#327676', TUR: '#a8552f', NOR: '#a0b8d8', FIN: '#7fb3a8', BEL: '#c8a24a',
  SUI: '#b9b9b9', HRE: '#d9b45a', KAL: '#4f8fbf', MOS: '#4f8a5b', ENG: '#b04a4a',
  CAS: '#aeae42', LIV: '#8f9e6a', USA: '#3f6fb5', CSA: '#8f8f7a', BNA: '#a0b8d8',
  MEX: '#6f9e4a', HAI: '#bb81b1', JPN: '#2f7f7a', CHN: '#c9a227',
};
