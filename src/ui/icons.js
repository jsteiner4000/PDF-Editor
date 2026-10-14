/**
 * SVG-Symbole und Logos der Oberfläche.
 */

import LOGOS from 'virtual:logos';

const ICON_PATHS = {
  gear: '<path d="M8.6 3h2.8l.4 2 1.5.9 1.9-.7 1.4 2.4-1.5 1.3v1.8l1.5 1.3-1.4 2.4-1.9-.7-1.5.9-.4 2H8.6l-.4-2-1.5-.9-1.9.7-1.4-2.4 1.5-1.3V9.1L3.4 7.8l1.4-2.4 1.9.7 1.5-.9z"/><circle cx="10" cy="10" r="2.3"/>',
  open: '<path d="M3 6.5A1.5 1.5 0 0 1 4.5 5h3.2l1.6 1.6h6.2A1.5 1.5 0 0 1 17 8.1V14.5A1.5 1.5 0 0 1 15.5 16h-11A1.5 1.5 0 0 1 3 14.5z"/>',
  save: '<path d="M4 4.5A.5.5 0 0 1 4.5 4h9l2.5 2.5v9a.5.5 0 0 1-.5.5h-11a.5.5 0 0 1-.5-.5z"/><path d="M7 4v3.5h5V4M6.5 16v-4.5h7V16"/>',
  saveas:
    '<path d="M4 4.5A.5.5 0 0 1 4.5 4h9l2.5 2.5V10M9.5 16h-5a.5.5 0 0 1-.5-.5v-11"/><path d="M7 4v3.5h5V4"/><path d="M12.5 17.5l.6-2.3 3.9-3.9 1.7 1.7-3.9 3.9z"/>',
  undo: '<path d="M7.5 5.5 4 9l3.5 3.5"/><path d="M4.5 9h7a4 4 0 0 1 0 8H9"/>',
  redo: '<path d="M12.5 5.5 16 9l-3.5 3.5"/><path d="M15.5 9h-7a4 4 0 0 0 0 8H11"/>',
  zin: '<circle cx="9" cy="9" r="5.5"/><path d="M13 13l4 4M9 6.5v5M6.5 9h5"/>',
  zout: '<circle cx="9" cy="9" r="5.5"/><path d="M13 13l4 4M6.5 9h5"/>',
  fitw: '<path d="M3 5v10M17 5v10M6 10h8M8 7.5 5.5 10 8 12.5M12 7.5l2.5 2.5-2.5 2.5"/>',
  fitp: '<rect x="5" y="3" width="10" height="14" rx="1"/><path d="M8 7h4M8 10h4M8 13h2"/>',
  up: '<path d="M5.5 12.5 10 8l4.5 4.5"/>',
  down: '<path d="M5.5 8 10 12.5 14.5 8"/>',
  left: '<path d="M12.5 5.5 8 10l4.5 4.5"/>',
  right: '<path d="M8 5.5 12.5 10 8 14.5"/>',
  back: '<path d="M11.5 5 6.5 10l5 5"/>',
  chev: '<path d="M6 8l4 4 4-4"/>',
  close: '<path d="M5.5 5.5l9 9M14.5 5.5l-9 9"/>',
  edit: '<path d="M5 3.5h6.5L15 7v3.2M5 3.5v13h5"/><path d="M11.5 3.5V7H15"/><path d="M12 17.5l.6-2.4 4.1-4.1 1.8 1.8-4.1 4.1z"/>',
  pages:
    '<rect x="3" y="3" width="6" height="6" rx="1"/><rect x="11" y="3" width="6" height="6" rx="1"/><rect x="3" y="11" width="6" height="6" rx="1"/><rect x="11" y="11" width="6" height="6" rx="1"/>',
  text: '<path d="M5 5.5V4h10v1.5M10 4v12M7.5 16h5"/>',
  field: '<rect x="2.5" y="6" width="15" height="8" rx="1.5"/><path d="M6 8.5v3"/>',
  checkbox: '<rect x="3.5" y="3.5" width="13" height="13" rx="2.5"/><path d="M6.8 10.2l2.2 2.3 4.3-5"/>',
  textbox:
    '<rect x="3" y="4" width="14" height="12" rx="1.5" stroke-dasharray="2.2 2"/><path d="M7 7.5h6M10 7.5v6"/>',
  image:
    '<rect x="3" y="4" width="14" height="12" rx="1.5"/><circle cx="7.5" cy="8" r="1.4"/><path d="M3.5 14l4-3.5 3 2.5 2.5-2 3.5 3"/>',
  fonts:
    '<path d="M3 16l4-11 4 11M4.5 12h5"/><path d="M13.2 11.2a2.2 2.2 0 1 1 0 4.4 2.2 2.2 0 0 1 0-4.4zM15.4 10.5V16"/>',
  trash: '<path d="M4 6h12M8 6V4.5h4V6M5.5 6l.8 10h7.4l.8-10M8.5 9v4.5M11.5 9v4.5"/>',
  rotl: '<path d="M4.5 4.5v4h4"/><path d="M5 8.5A6 6 0 1 1 6.2 14"/>',
  rotr: '<path d="M15.5 4.5v4h-4"/><path d="M15 8.5A6 6 0 1 0 13.8 14"/>',
  dup: '<rect x="6.5" y="6.5" width="10" height="10" rx="1.5"/><path d="M13.5 6.5V4.5a1 1 0 0 0-1-1h-8a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h2"/>',
  pageadd: '<path d="M5 3.5h6.5L15 7v9.5H5z"/><path d="M11.5 3.5V7H15M10 9.5v5M7.5 12h5"/>',
  filein: '<path d="M5 3.5h6.5L15 7v9.5H5z"/><path d="M11.5 3.5V7H15M10 14.5v-5M7.8 11.7 10 9.5l2.2 2.2"/>',
  more: '<circle cx="5" cy="10" r=".6"/><circle cx="10" cy="10" r=".6"/><circle cx="15" cy="10" r=".6"/>',
  thumbs: '<rect x="3.5" y="3" width="13" height="14" rx="1.5"/><path d="M12 3v14"/>',
  panel: '<rect x="3" y="3.5" width="14" height="13" rx="1.5"/><path d="M8 3.5v13"/>',
  check: '<path d="M4.5 10.5l3.5 3.5 7.5-8"/>',
  warn: '<path d="M10 3.5l7 12.5H3z"/><path d="M10 8.5v3.5M10 14.2v.1"/>',
  info: '<circle cx="10" cy="10" r="7"/><path d="M10 9v4.5M10 6.6v.1"/>',
  print:
    '<path d="M6 7V3.5h8V7M6 13.5H4.5a1 1 0 0 1-1-1V8a1 1 0 0 1 1-1h11a1 1 0 0 1 1 1v4.5a1 1 0 0 1-1 1H14"/><rect x="6" y="11" width="8" height="5.5" rx=".5"/>',
  bold: '<path d="M6.5 4h4.2a3 3 0 0 1 0 6H6.5zM6.5 10h5a3 3 0 0 1 0 6h-5z"/>',
  al: '<path d="M4 5h12M4 8.5h8M4 12h12M4 15.5h8"/>',
  ac: '<path d="M4 5h12M6 8.5h8M4 12h12M6 15.5h8"/>',
  ar: '<path d="M4 5h12M8 8.5h8M4 12h12M8 15.5h8"/>',
  aj: '<path d="M4 5h12M4 8.5h12M4 12h12M4 15.5h7"/>',
  move: '<path d="M10 3v14M3 10h14M7.8 5.2 10 3l2.2 2.2M7.8 14.8 10 17l2.2-2.2M5.2 7.8 3 10l2.2 2.2M14.8 7.8 17 10l-2.2 2.2"/>',
  replace:
    '<path d="M4 7.5a6 6 0 0 1 10.6-2.2M16 12.5a6 6 0 0 1-10.6 2.2"/><path d="M15 2.8v3h-3M5 17.2v-3h3"/>',
  cursor: '<path d="M5 3l10 6.5-4.3 1.1L13 15.5l-1.8.9-2.4-4.9L5.5 14z"/>',
  hand: '<path d="M7 10V5a1.2 1.2 0 0 1 2.4 0v4M9.4 9V4a1.2 1.2 0 0 1 2.4 0v5M11.8 9V5.2a1.2 1.2 0 0 1 2.4 0V11c0 3.3-2 5.5-5 5.5-2.3 0-3.4-1.2-4.6-3.3l-1.5-2.7a1.2 1.2 0 0 1 2-1.2L7 11"/>',
  file: '<path d="M5 3.5h6.5L15 7v9.5H5z"/><path d="M11.5 3.5V7H15"/>',
  plus: '<path d="M10 5v10M5 10h10"/>',
  download: '<path d="M10 3.5v9M6.5 9 10 12.5 13.5 9M4 13.5v2a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1v-2"/>',
  x: '<path d="M6 6l8 8M14 6l-8 8"/>',
  menu: '<path d="M4 6h12M4 10h12M4 14h12"/>',
  pnum: '<path d="M5 3.5h10v13H5z"/><path d="M8.5 13.5h3M10 12.5v-5l-1.2.8"/>',
  tofront:
    '<rect x="3" y="3" width="9.5" height="9.5" rx="1.2" stroke-dasharray="2 1.7"/><rect x="7.5" y="7.5" width="9.5" height="9.5" rx="1.2" fill="currentColor" fill-opacity=".22"/>',
  toback:
    '<rect x="3" y="3" width="9.5" height="9.5" rx="1.2" fill="currentColor" fill-opacity=".22"/><rect x="7.5" y="7.5" width="9.5" height="9.5" rx="1.2" fill="var(--panel, #fff)"/>',
  layers: '<path d="M10 3.5 17 7l-7 3.5L3 7z"/><path d="M3 10.5 10 14l7-3.5M3 14l7 3.5 7-3.5"/>',
  signature:
    '<path d="M3 16.5h14"/><path d="M3.5 13.2c1.6-3.2 3.1-8.1 4.6-7.7 1.6.4-.9 7.5.6 7.7 1.1.1 2.1-3 3.2-2.8 1 .2.3 2.4 1.3 2.5.8.1 1.6-.9 2.8-1.6"/>',
  sigcapture:
    '<rect x="2.5" y="4" width="15" height="12" rx="1.5" stroke-dasharray="2.2 2"/><path d="M5.5 12.6c1.2-2 2-4.6 3-4.3 1 .3-.6 4 .4 4.2.8.1 1.4-1.8 2.2-1.7.7.1.3 1.4 1 1.5.6.1 1.2-.5 2-1"/>',
  pen: '<path d="M4 16l.8-3.2L13 4.6a1.6 1.6 0 0 1 2.3 0l.1.1a1.6 1.6 0 0 1 0 2.3l-8.2 8.2z"/><path d="M11.6 6l2.4 2.4"/>',
  list: '<path d="M8 6h8M8 10h8M8 14h8"/><circle cx="4.5" cy="6" r=".6"/><circle cx="4.5" cy="10" r=".6"/><circle cx="4.5" cy="14" r=".6"/>',
  eye: '<path d="M2.5 10s2.8-5 7.5-5 7.5 5 7.5 5-2.8 5-7.5 5-7.5-5-7.5-5z"/><circle cx="10" cy="10" r="2.2"/>',
  home: '<path d="M3.5 9.5 10 4l6.5 5.5"/><path d="M5.5 8.2V16h9V8.2M8.5 16v-4.5h3V16"/>',
  wiring: '<rect x="7.5" y="3.5" width="5" height="13" rx="1"/><path d="M3 6.5h4.5M3 10h4.5M12.5 7.5H17M12.5 12.5H17"/>',
  binder: '<rect x="4" y="3" width="12" height="14" rx="1.5"/><path d="M7 3v14M9.5 7h4M9.5 10h4"/>',
  module: '<rect x="3.5" y="5" width="13" height="10" rx="1.5"/><path d="M3.5 8.5h13"/>',
  plug: '<path d="M7.5 3.5v3.5M12.5 3.5v3.5M5.5 7h9v2.5a4.5 4.5 0 0 1-9 0z"/><path d="M10 14v3"/>',
  bulb: '<path d="M7.5 13.2a5 5 0 1 1 5 0V15h-5z"/><path d="M8 17.3h4"/>',
  globe: '<circle cx="10" cy="10" r="7"/><path d="M3 10h14M10 3c1.9 2.1 2.8 4.4 2.8 7s-.9 4.9-2.8 7c-1.9-2.1-2.8-4.4-2.8-7S8.1 5.1 10 3z"/>',
  export: '<path d="M10.5 16.5H5v-13h6.5L15 7v3"/><path d="M11.5 3.5V7H15M12.5 14.5h5M15.5 12l2.5 2.5-2.5 2.5"/>',
  grip: '<circle cx="8" cy="6" r=".7"/><circle cx="12" cy="6" r=".7"/><circle cx="8" cy="10" r=".7"/><circle cx="12" cy="10" r=".7"/><circle cx="8" cy="14" r=".7"/><circle cx="12" cy="14" r=".7"/>',
  palette: '<path d="M10 3a7 7 0 0 0 0 14c1 0 1.5-.6 1.5-1.4 0-1.2-1-1.4-1-2.4 0-.8.6-1.4 1.5-1.4h1.8A3.2 3.2 0 0 0 17 8.6C17 5.5 13.9 3 10 3z"/><circle cx="6.8" cy="9" r=".8"/><circle cx="9.5" cy="6.3" r=".8"/><circle cx="13" cy="7" r=".8"/>',
  key: '<circle cx="7" cy="12.5" r="3.5"/><path d="M9.5 10 16 3.5M13.5 6l2 2M11.8 7.7l1.6 1.6"/>',
  wifi: '<path d="M3 8a10 10 0 0 1 14 0M5.5 10.8a6.5 6.5 0 0 1 9 0M8 13.5a3 3 0 0 1 4 0"/><circle cx="10" cy="16" r=".7"/>',
  remote: '<circle cx="10" cy="10" r="7"/><path d="M3 10h14M10 3c1.9 2.1 2.8 4.4 2.8 7s-.9 4.9-2.8 7"/><path d="M13.5 13.5l3 3"/>',
  device: '<rect x="3" y="5" width="14" height="8" rx="1.5"/><path d="M7 16h6M10 13v3M6 9h.1M8.5 9h.1"/>',
  map: '<path d="M3.5 5.5 7.5 4l5 1.5 4-1.5v10.5l-4 1.5-5-1.5-4 1.5z"/><path d="M7.5 4v10.5M12.5 5.5V16"/>',
  camera: '<path d="M3.5 7.5h2.6l1.2-2h5.4l1.2 2h2.6v8h-13z"/><circle cx="10" cy="11.3" r="2.6"/>',
  sparkle: '<path d="M10 3.5c.6 3.2 2.3 4.9 5.5 5.5-3.2.6-4.9 2.3-5.5 5.5-.6-3.2-2.3-4.9-5.5-5.5 3.2-.6 4.9-2.3 5.5-5.5z"/><path d="M15.5 13.5c.2 1.1.8 1.7 2 2-1.2.2-1.8.8-2 2-.2-1.2-.8-1.8-2-2 1.2-.3 1.8-.9 2-2z"/>',
};

export const icon = (name, cls = '') =>
  `<svg class="i ${cls}" viewBox="0 0 20 20" aria-hidden="true">${ICON_PATHS[name] || ''}</svg>`;

// App-Symbol: wird beim Build aus assets/icon/png eingebettet (virtual:logos).
export const LOGO_SMALL = `<img src="${LOGOS.small}" width="28" height="28" alt="" draggable="false">`;
export const LOGO_LARGE = `<img src="${LOGOS.large}" width="76" height="76" alt="" draggable="false">`;
