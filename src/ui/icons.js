/**
 * SVG-Symbole und Logos der Oberfläche.
 */

const ICON_PATHS = {
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
  eye: '<path d="M2.5 10s2.8-5 7.5-5 7.5 5 7.5 5-2.8 5-7.5 5-7.5-5-7.5-5z"/><circle cx="10" cy="10" r="2.2"/>',
};

export const icon = (name, cls = '') =>
  `<svg class="i ${cls}" viewBox="0 0 20 20" aria-hidden="true">${ICON_PATHS[name] || ''}</svg>`;

export const LOGO_SMALL =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" width="30" height="30"><defs><linearGradient id="lsbg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#3159E6"/><stop offset="1" stop-color="#1A2F9E"/></linearGradient><linearGradient id="lsshine" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff" stop-opacity=".14"/><stop offset=".45" stop-color="#fff" stop-opacity="0"/></linearGradient><linearGradient id="lspen" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#FFC95E"/><stop offset=".5" stop-color="#FFB53D"/><stop offset="1" stop-color="#E9951B"/></linearGradient><linearGradient id="lsband" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#E8EDFF"/><stop offset="1" stop-color="#AEBBEB"/></linearGradient><filter id="lssh" x="-20%" y="-20%" width="140%" height="150%"><feDropShadow dx="0" dy="20" stdDeviation="24" flood-color="#08164F" flood-opacity=".38"/></filter><filter id="lssh2" x="-30%" y="-30%" width="160%" height="160%"><feDropShadow dx="0" dy="12" stdDeviation="14" flood-color="#08164F" flood-opacity=".4"/></filter></defs><rect x="16" y="16" width="992" height="992" rx="190" fill="url(#lsbg)"/><rect x="16" y="16" width="992" height="992" rx="190" fill="url(#lsshine)"/><g filter="url(#lssh)"><path d="M266 176h320l178 178v486a44 44 0 0 1-44 44H266a44 44 0 0 1-44-44V220a44 44 0 0 1 44-44z" fill="#fff"/></g><path d="M586 176v134a44 44 0 0 0 44 44h134z" fill="#C7D2FF"/><g stroke-linecap="round" stroke-width="70"><path d="M330 430h230" stroke="#213FBF"/><path d="M330 570h250" stroke="#213FBF" opacity=".4"/></g><g filter="url(#lssh2)" transform="rotate(-45 700 700)"><path d="M600 648h320a38 38 0 0 1 38 38v28a38 38 0 0 1-38 38H600z" fill="url(#lspen)"/><path d="M600 700h358" stroke="#fff" stroke-opacity=".28" stroke-width="10"/><rect x="850" y="648" width="46" height="104" fill="url(#lsband)"/><path d="M896 648h24a38 38 0 0 1 38 38v28a38 38 0 0 1-38 38h-24z" fill="#1E2A5C"/><path d="M600 648l-118 52 118 52z" fill="#FBE4B8"/><path d="M530 679l-48 21 48 21z" fill="#1E2A5C"/></g></svg>';

export const LOGO_LARGE =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" width="72" height="72"><defs><linearGradient id="lbbg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#3159E6"/><stop offset="1" stop-color="#1A2F9E"/></linearGradient><linearGradient id="lbshine" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff" stop-opacity=".14"/><stop offset=".45" stop-color="#fff" stop-opacity="0"/></linearGradient><linearGradient id="lbpen" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#FFC95E"/><stop offset=".5" stop-color="#FFB53D"/><stop offset="1" stop-color="#E9951B"/></linearGradient><linearGradient id="lbband" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#E8EDFF"/><stop offset="1" stop-color="#AEBBEB"/></linearGradient><filter id="lbsh" x="-20%" y="-20%" width="140%" height="150%"><feDropShadow dx="0" dy="20" stdDeviation="24" flood-color="#08164F" flood-opacity=".38"/></filter><filter id="lbsh2" x="-30%" y="-30%" width="160%" height="160%"><feDropShadow dx="0" dy="12" stdDeviation="14" flood-color="#08164F" flood-opacity=".4"/></filter></defs><rect x="32" y="32" width="960" height="960" rx="216" fill="url(#lbbg)"/><rect x="32" y="32" width="960" height="960" rx="216" fill="url(#lbshine)"/><g filter="url(#lbsh)"><path d="M266 176h320l178 178v486a44 44 0 0 1-44 44H266a44 44 0 0 1-44-44V220a44 44 0 0 1 44-44z" fill="#fff"/></g><path d="M586 176v134a44 44 0 0 0 44 44h134z" fill="#C7D2FF"/><g stroke-linecap="round" stroke-width="40"><path d="M322 420h250" stroke="#213FBF"/><path d="M322 510h300" stroke="#213FBF" opacity=".35"/><path d="M322 600h200" stroke="#213FBF" opacity=".35"/></g><rect x="302" y="690" width="176" height="84" rx="20" fill="#213FBF"/><text x="390" y="749" text-anchor="middle" font-family="Segoe UI, Arial, Helvetica, sans-serif" font-weight="800" font-size="54" letter-spacing="3" fill="#fff">PDF</text><g filter="url(#lbsh2)" transform="rotate(-45 700 700)"><path d="M600 648h320a38 38 0 0 1 38 38v28a38 38 0 0 1-38 38H600z" fill="url(#lbpen)"/><path d="M600 700h358" stroke="#fff" stroke-opacity=".28" stroke-width="10"/><rect x="850" y="648" width="46" height="104" fill="url(#lbband)"/><path d="M896 648h24a38 38 0 0 1 38 38v28a38 38 0 0 1-38 38h-24z" fill="#1E2A5C"/><path d="M600 648l-118 52 118 52z" fill="#FBE4B8"/><path d="M530 679l-48 21 48 21z" fill="#1E2A5C"/></g></svg>';
