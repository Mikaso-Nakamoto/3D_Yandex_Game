// Inline SVG icons: no font or image assets, identical rendering on every platform.
const PATHS = {
  crown: '<path d="M3 17h18l-1.6-9-4.4 4L12 5l-3 7-4.4-4L3 17Z"/><path d="M5 20h14"/>',
  sword:
    '<path d="M14.5 3.5 20 9l-9.5 9.5-3-3L17 5.5"/><path d="m4 20 3.5-3.5"/><path d="m9.5 12.5 2 2"/>',
  coin: '<circle cx="12" cy="12" r="8"/><path d="M12 7v10M9 9.5h4.5a2 2 0 0 1 0 4H9h5a2 2 0 0 1 0 4"/>',
  wall: '<path d="M3 21V9l3-3 3 3 3-3 3 3 3-3 3 3v12Z"/><path d="M3 13h18"/><path d="M8 21v-4M16 21v-4"/>',
  factory:
    '<path d="M3 21h18V10l-6 4V10l-6 4V6H6v15Z"/><path d="M3 21h18"/><path d="M8 17h2M14 17h2"/>',
  fort: '<path d="M4 21V8l3-2 2 2 3-3 3 3 2-2 3 2v13Z"/><path d="M10 21v-6h4v6"/><path d="M4 12h16"/>',
  barracks: '<path d="M3 21 12 4l9 17"/><path d="M8 21v-6h8v6"/><path d="M12 4v6"/>',
  mobilize: '<path d="M4 19 19 4l1 6-4-1L8 17l3 1-6 2 1-1Z"/><path d="M4 19l1-1"/>',
  tax: '<path d="M5 20 19 4"/><circle cx="7.5" cy="7.5" r="2.5"/><circle cx="16.5" cy="16.5" r="2.5"/>',
  march: '<path d="M4 18 20 6"/><path d="m14 6h6v6"/><path d="M4 12h8"/>',
  gold: '<path d="m12 3 8 5v8l-8 5-8-5V8Z"/><path d="m12 8 4 2.5v4L12 17l-4-2.5v-4Z"/>',
  manpower: '<circle cx="12" cy="7" r="3"/><path d="M5 21v-2a4 4 0 0 1 4-4h6a4 4 0 0 1 4 4v2"/>',
  close: '<path d="m6 6 12 12M18 6 6 18"/>',
  pause: '<path d="M8 5v14M16 5v14"/>',
  menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
  arrowLeft: '<path d="M19 12H5"/><path d="m11 6-6 6 6 6"/>',
  list: '<path d="M8 6h12M8 12h12M8 18h12"/><path d="M4 6h.01M4 12h.01M4 18h.01"/>',
  shield: '<path d="M12 3 4 6v6c0 5 8 9 8 9s8-4 8-9V6Z"/>',
  flag: '<path d="M5 21V4"/><path d="M5 4h11l-2 4 2 4H5"/>',
  swing: '<path d="M4 20 20 4"/><path d="m14 4 6 0 0 6"/>',
  arrowUp: '<path d="M12 19V5"/><path d="m6 11 6-6 6 6"/>',
  arrowDown: '<path d="M12 5v14"/><path d="m6 13 6 6 6-6"/>',
};

export function icon(name, size = 16, className = 'ico') {
  const path = PATHS[name] ?? PATHS.crown;
  return `<svg class="${className}" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none"
    stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"
    aria-hidden="true">${path}</svg>`;
}
