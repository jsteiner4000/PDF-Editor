/**
 * Setzt ein Projekt in Seiten: Deckblatt, Inhaltsverzeichnis, Anschlusspläne – jede Seite als
 * eigenständiges SVG (A4, Maße in pt). Vorschau und PDF verwenden dieselben Seiten.
 *
 * Ergebnis von `renderDocument`: { pages: [{ svg, section, kind, hits, layout? }] }. `hits` sind die
 * anklickbaren Bereiche einer Seite (Rechtecke in pt) für die Auswahl in der Vorschau.
 */
import { C, PAGE, esc, isLandscape, line, n, rect, setOrientation, text, typesetter } from './svg.js';
import { DIAGRAM, layoutWiring, legendSvg, terminalPages, wiringDiagramSvg } from './wiring.js';
import { accessPages } from './access.js';
import { sitePages } from './site.js';
import { photoPages } from './photos.js';
import { chapterPages } from './chapters.js';
import { overlaySvg, overlaysOf } from './overlays.js';
import { BODY, manualCover, manualFrame, manualPages, manualToc } from './manual.js';
import { isEmptySection, sectionTitle } from './model.js';

const LOGO = { y: 42, w: 175, h: 44.144 };
/** Logo oben rechts, bündig mit dem rechten Rand der Seite (Hoch- oder Querformat). */
const logoBox = () => ({ ...LOGO, x: PAGE.right - LOGO.w });

/** Datum (JJJJ-MM-TT) in der Schreibweise der Sprache. */
export function formatDate(iso, lang) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || '');
  if (!m) return iso || '';
  if (lang === 'en') {
    const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
    return `${+m[3]} ${months[+m[2] - 1]} ${m[1]}`;
  }
  return `${m[3]}.${m[2]}.${m[1]}`;
}

/** Firmenlogo oben rechts (eingepasst, rechtsbündig) – ohne Logo der Firmenname als Schriftzug. */
function logoSvg(project, ts) {
  const img = project.company.logo && project.images[project.company.logo];
  const LOGO_BOX = logoBox();
  if (img && img.data && img.w && img.h) {
    const s = Math.min(LOGO_BOX.w / img.w, LOGO_BOX.h / img.h);
    const w = img.w * s;
    const h = img.h * s;
    return `<image href="${esc(img.data)}" x="${n(LOGO_BOX.x + LOGO_BOX.w - w)}" y="${n(LOGO_BOX.y + (LOGO_BOX.h - h) / 2)}" width="${n(w)}" height="${n(h)}" preserveAspectRatio="none"/>`;
  }
  const name = project.company.name || '';
  if (!name) return '';
  return (
    text(PAGE.right, 68, name, { size: 18, weight: 700, anchor: 'end' }) +
    text(PAGE.right, 80, ts.inline(project.company.tagline), { size: 7, fill: C.muted, anchor: 'end' })
  );
}

/** Kopf einer Inhaltsseite: Titel, Untertitel, Logo, Linie. */
function headerSvg(project, ts, title, subtitle) {
  // Titel und Untertitel enden vor dem Logo (zu lang: kleiner, notfalls gekürzt)
  const room = logoBox().x - 12 - PAGE.left;
  return (
    logoSvg(project, ts) +
    text(PAGE.left, 72, ...fit(ts, title, 20, 14, room, 700)) +
    text(PAGE.left, 89, ...fit(ts, subtitle, 10.5, 8, room, 400, C.muted)) +
    line(PAGE.left, 102, PAGE.right, 102, C.navy, 2.5)
  );
}

/** Text auf `room` pt Breite bringen: Schriftgrad bis `min` verkleinern, danach mit „…“ kürzen. */
function fit(ts, value, size, min, room, weight = 400, fill = C.navy) {
  let s = size;
  let v = value || '';
  const w = ts.width(v, size, weight);
  if (w > room) s = Math.max(min, Math.floor(((size * room) / w) * 10) / 10);
  while (v.length > 1 && ts.width(v, s, weight) > room) v = v.slice(0, -2).trimEnd() + '…';
  return [v, { size: s, weight, fill }];
}

/** Fußzeile: Firma links, Dokument und Seitenzahl rechts. */
function footerSvg(project, ts, label, num, total, cover = false) {
  const company = [project.company.name, ts.inline(project.company.tagline)].filter(Boolean).join('  -  ');
  const pageText = num ? ts.label('pageOf', { n: num, total }) : '';
  const room = PAGE.right - PAGE.left - 16;
  const w = (v) => ts.width(v, 7.5);
  // zu lang für eine Zeile: erst den Firmenzusatz, dann den Dokumenttitel weglassen
  let left = company;
  let right = [label, pageText].filter(Boolean).join('   -   ');
  if (w(left) + w(right) > room) left = project.company.name || '';
  if (w(left) + w(right) > room) right = pageText;
  const f = PAGE.foot;
  if (cover) return line(COVER_LEFT, f, PAGE.right, f, C.rule, 0.8) + text(COVER_LEFT, f + 14, left, { size: 9, fill: C.body });
  return (
    line(PAGE.left, f, PAGE.right, f, C.rule, 0.7) +
    text(PAGE.left, f + 12, left, { size: 7.5, fill: C.muted }) +
    text(PAGE.right, f + 12, right, { size: 7.5, fill: C.muted, anchor: 'end' })
  );
}

function svgPage(ts, body, family = esc(ts.font.css), kerning = 'none') {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${PAGE.w} ${PAGE.h}" width="${PAGE.w}pt" height="${PAGE.h}pt" style="font-family:${family};font-kerning:${kerning};text-rendering:geometricPrecision">${rect(0, 0, PAGE.w, PAGE.h, { fill: '#fff' })}${body}</svg>`;
}

/** Titel für Fußzeile und Dateiname: bei einem einzelnen Plan dessen Titel, sonst Projekttitel + Anlage. */
export function documentLabel(project, ts = typesetter(project)) {
  const content = project.sections.filter((s) => s.type !== 'cover' && s.type !== 'toc');
  if (content.length === 1 && !project.sections.some((s) => s.type === 'cover'))
    return ts.langs.map((l) => sectionTitle(content[0], l)).filter((v, i, a) => a.indexOf(v) === i).join(' / ');
  const site = project.meta.site || project.meta.customer;
  return [ts.inline(project.title), site].filter(Boolean).join(' ');
}

/* ---------- Deckblatt ---------- */

/** Deckblatt: links 25 mm Heftrand (Lochung im Ordner), Schrift auch ausgedruckt gut lesbar. */
export const COVER_LEFT = 70.87;

function coverBody(project, ts) {
  const L = COVER_LEFT;
  const R = PAGE.right;
  let s = logoSvg(project, ts);
  const hits = [];
  let y = 318;
  const titles = ts.runs(project.title);
  titles.forEach((r) => {
    for (const l of ts.wrap(r.text, r.sec ? 15 : 32, R - L, r.sec ? 400 : 700)) {
      s += text(L, y, l, r.sec ? { size: 15, italic: true, fill: C.body } : { size: 32, weight: 700 });
      y += r.sec ? 22 : 36;
    }
    if (!r.sec) y -= 6;
  });
  const sub = [project.meta.site, project.meta.customer].find(Boolean);
  if (sub) {
    s += text(L, y + 2, sub, { size: 16, fill: C.body });
    y += 10;
  }
  hits.push({ kind: 'project', rect: [L, 280, R - L, y - 270] });
  y += 16;
  s += line(L, y, R, y, C.navy, 2.5);
  y += 36;
  const m = project.meta;
  const rows = [
    ['customer', m.customer],
    ['address', m.address],
    ['site', m.site],
    ['date', formatDate(m.date, ts.lang)],
    ['technician', m.technician],
    ['docNo', m.docNo],
    ['version', m.version],
  ].filter(([, v]) => v);
  const top = y - 22;
  const vx = L + 118;
  for (const [key, value] of rows) {
    const lines = ts.wrap(value, 12.5, R - vx);
    s += text(L, y, ts.label(key), { size: 10, weight: 700, fill: C.body });
    lines.forEach((l, i) => (s += text(vx, y + 15.5 * i, l, { size: 12.5 })));
    y += 15.5 * (lines.length - 1) + 11;
    s += line(L, y, R, y, C.rule, 0.8);
    y += 22;
  }
  if (rows.length) hits.push({ kind: 'project', rect: [L, top, R - L, y - top] });
  return { svg: s, hits };
}

/* ---------- Inhaltsverzeichnis ---------- */

const TOC_TOP = 150;
const TOC_BOTTOM = 770;

/** Verzeichnis auf Seiten verteilt: [[eintrag, …], …] (Unterpunkte bleiben beim Hauptpunkt). */
function tocChunks(entries) {
  const pages = [[]];
  let y = TOC_TOP;
  for (const e of entries) {
    const h = e.sub ? 18 : 24;
    if (y + h > TOC_BOTTOM && pages[pages.length - 1].length) {
      pages.push([]);
      y = TOC_TOP;
    }
    pages[pages.length - 1].push(e);
    y += h;
  }
  return pages;
}

function tocBody(ts, entries) {
  let s = '';
  const hits = [];
  let y = TOC_TOP;
  for (const e of entries) {
    const size = e.sub ? 9.5 : 10.5;
    const x = e.sub ? 60 : PAGE.left;
    const fill = e.sub ? C.body : C.navy;
    const weight = e.sub ? 400 : 700;
    const num = String(e.page);
    const titleW = ts.width(e.title, size, weight);
    const numW = ts.width(num, size, weight);
    s += text(x, y, e.title, { size, weight, fill });
    const from = x + titleW + 6;
    const to = PAGE.right - numW - 6;
    if (to > from) s += `<line x1="${n(from)}" y1="${n(y)}" x2="${n(to)}" y2="${n(y)}" stroke="${C.rule}" stroke-width="1" stroke-dasharray="0.1 3" stroke-linecap="round"/>`;
    s += text(PAGE.right, y, num, { size, weight, fill, anchor: 'end' });
    if (!e.sub) hits.push({ kind: 'section', id: e.id, rect: [PAGE.left, y - 14, PAGE.right - PAGE.left, 20] });
    y += e.sub ? 18 : 24;
  }
  return { svg: s, hits };
}

/* ---------- Dokument ---------- */

/**
 * Seiten eines Projekts. Zwei Durchgänge: erst die Seiten je Abschnitt (für die Seitenzahlen im
 * Inhaltsverzeichnis und im Hinweis „siehe Seite …“), dann Kopf- und Fußzeilen.
 */
export function renderDocument(project, { skipEmpty = false, forPdf = false } = {}) {
  const ts = typesetter(project);
  const label = documentLabel(project, ts);
  const pages = [];
  const tocAt = [];
  const skipped = [];
  // Bedienungsanleitung im Stil des Vorbilds: eigenes Deckblatt, Kapitel mit Kopf- und Fußzeile
  const manual = project.design === 'manual';
  const manualState = { h1: 0, fig: 0 };

  // fertige PDF: Fotodokumentation nur, wenn eingestellt; Sprünge zwischen Foto und Lageplan
  const inPdf = (s) => !(forPdf && s.type === 'photos' && s.inPdf === false) && !(skipEmpty && isEmptySection(s));
  let pdf = null;
  if (forPdf) {
    const photoOf = new Map();
    const symbols = new Set(); // in der PDF sichtbare Symbole (Sprungziele der Fotos)
    const photosShown = project.sections.some((s) => s.type === 'photos' && inPdf(s));
    for (const s of project.sections) {
      if (!inPdf(s)) continue;
      if (s.type === 'photos') for (const p of s.items) if (p.link && !photoOf.has(p.link)) photoOf.set(p.link, p.id);
      if (s.type === 'site')
        for (const y of s.symbols) {
          const hidden = (s.thin || {})[y.kind] === 'hidden' || (y.kind === 'photo' && (!s.photoSpotsInPdf || !photosShown));
          if (!hidden) symbols.add(y.id);
        }
    }
    pdf = { photoOf, symbols, photosShown };
  }

  try {
    for (const section of project.sections) {
      if (forPdf && section.type === 'photos' && section.inPdf === false) continue;
      // für die fertige PDF: leere Abschnitte (nur Kopfzeile) weglassen
      if (skipEmpty && isEmptySection(section)) {
        skipped.push(sectionTitleInline(section, ts));
        continue;
      }
      // Querformat je Abschnitt (nicht für Kapitel im Stil der Bedienungsanleitung)
      const land = isLandscape(section) && !(manual && section.type === 'chapters');
      setOrientation(land);
      const from = pages.length;
      addSection(section);
      for (let k = from; k < pages.length; k++) pages[k].land = land;
    }
  } finally {
    setOrientation(false);
  }

  /** Seiten eines Abschnitts anfügen (im eingestellten Seitenformat). */
  function addSection(section) {
    if (section.type === 'cover') {
      pages.push({ section: section.id, kind: 'cover', make: () => (manual ? manualCover(project) : coverBody(project, ts)), plain: true, manual });
    } else if (section.type === 'chapters' && manual) {
      const title = ts.inline(section.title) || ts.label('chapters');
      manualPages(section, project, manualState).forEach((p, i) =>
        pages.push({
          section: section.id,
          kind: 'chapters',
          make: () => p,
          heads: p.heads,
          chapter: p.chapter,
          manual: true,
          toc: i === 0 && !p.heads.length ? { title, id: section.id, plain: true } : null,
        }),
      );
    } else if (section.type === 'toc') {
      tocAt.push(pages.length);
      pages.push({ section: section.id, kind: 'toc', title: ts.label('toc'), subtitle: label, make: null, manual });
    } else if (section.type === 'wiring') {
      const system = ts.inline(section.system);
      const sub = (key) => [system, ts.label(key)].filter(Boolean).join('  -  ');
      const L = layoutWiring(section, ts);
      const rest = terminalPages(section, ts).filter((p) => p.svg);
      const first = pages.length;
      pages.push({
        section: section.id,
        kind: 'diagram',
        layout: L,
        title: ts.label('wiring'),
        subtitle: sub('wiringOverview'),
        make: () => ({
          svg: wiringDiagramSvg(L, section, ts) + legendSvg(section, ts, L, rest.length ? first + 2 : null),
          hits: diagramHits(L),
        }),
        toc: { title: sectionTitleInline(section, ts), id: section.id },
      });
      rest.forEach((p, i) =>
        pages.push({
          section: section.id,
          kind: 'terminals',
          title: ts.label('wiring'),
          subtitle: sub('wiringTerminals'),
          make: () => p,
          tocSub: i === 0 ? ts.label('wiringTerminals') : null,
        }),
      );
    } else if (section.type === 'site') {
      const title = ts.inline(section.title) || ts.label('sitePlan');
      const subtitle = [project.meta.site, project.meta.customer].find(Boolean) || '';
      sitePages(section, ts, project.images, project, pdf && { ...pdf, noPhotoSpots: !section.photoSpotsInPdf || !pdf.photosShown }).forEach((p, i) =>
        pages.push({
          section: section.id,
          kind: p.kind === 'plan' ? 'site' : 'sitelist',
          title,
          subtitle: p.kind === 'list' ? ts.label('deviceList') : subtitle,
          site: p.site || null,
          make: () => p,
          toc: i === 0 ? { title, id: section.id, plain: true } : null,
          tocSub: i === 1 ? ts.label('deviceList') : null,
        }),
      );
    } else if (section.type === 'chapters') {
      const title = ts.inline(section.title) || ts.label('chapters');
      const subtitle = [project.meta.site, project.meta.customer].find(Boolean) || '';
      chapterPages(section, ts, project).forEach((p, i) =>
        pages.push({
          section: section.id,
          kind: 'chapters',
          title,
          subtitle,
          make: () => p,
          heads: p.heads,
          toc: i === 0 ? { title, id: section.id, plain: true } : null,
        }),
      );
    } else if (section.type === 'photos') {
      const title = ts.inline(section.title) || ts.label('photos');
      const subtitle = [project.meta.site, project.meta.customer].find(Boolean) || '';
      photoPages(section, ts, project, pdf).forEach((p, i) =>
        pages.push({
          section: section.id,
          kind: 'photos',
          title,
          subtitle,
          make: () => p,
          toc: i === 0 ? { title, id: section.id, plain: true } : null,
        }),
      );
    } else if (section.type === 'access') {
      const title = ts.inline(section.title) || ts.label('access');
      const subtitle = [project.meta.site, project.meta.customer].find(Boolean) || '';
      accessPages(section, ts).forEach((p, i) =>
        pages.push({
          section: section.id,
          kind: 'access',
          title,
          subtitle,
          make: () => p,
          toc: i === 0 ? { title, id: section.id, plain: true } : null,
        }),
      );
    }
  }

  // Inhaltsverzeichnis: alle Abschnitte; braucht es mehrere Seiten, verschieben sich die
  // Seitenzahlen danach – deshalb so lange neu zählen, bis die Zahl der Verzeichnisseiten passt
  const collect = () => {
    const out = [];
    pages.forEach((p, i) => {
      if (p.toc) {
        out.push({ ...p.toc, page: i + 1 });
        if (!p.toc.plain) out.push({ title: ts.label('wiringOverview'), page: i + 1, sub: true });
      } else if (p.tocSub) out.push({ title: p.tocSub, page: i + 1, sub: true });
      if (p.heads) for (const h of p.heads) out.push({ title: h.title, page: i + 1, sub: true });
    });
    return out;
  };
  for (let round = 0; round < 4 && tocAt.length; round++) {
    const needed = tocChunks(collect()).length;
    const have = pages.filter((p) => p.kind === 'toc' && p.section === pages[tocAt[0]].section).length;
    if (needed === have) break;
    const first = tocAt[0];
    if (needed > have) pages.splice(first + have, 0, ...Array.from({ length: needed - have }, () => ({ ...pages[first], make: null })));
    else pages.splice(first + needed, have - needed);
  }
  if (tocAt.length) {
    const chunks = tocChunks(collect());
    let k = 0;
    pages.forEach((p) => {
      if (p.kind === 'toc') {
        const chunk = chunks[Math.min(k++, chunks.length - 1)] || [];
        p.make = () => (p.manual ? manualToc(project, chunk) : tocBody(ts, chunk));
      }
    });
  }

  // Seite im Abschnitt (für freie Bilder und QR-Codes; erst jetzt, das Verzeichnis kann mehrseitig sein)
  pages.forEach((p, i) => {
    const prev = pages[i - 1];
    p.secPage = prev && prev.section === p.section ? prev.secPage + 1 : 0;
    p.secLast = !(pages[i + 1] && pages[i + 1].section === p.section);
  });
  const total = pages.length;
  return {
    label,
    skipped,
    pages: pages.map((p, i) => {
      setOrientation(!!p.land);
      try {
        return finishPage(p, i);
      } finally {
        setOrientation(false);
      }
    }),
  };

  /** Fertige Seite: Inhalt mit Kopf- und Fußzeile, im Format des Abschnitts. */
  function finishPage(p, i) {
    const body = p.make();
    // freie Bilder und QR-Codes über dem Inhalt (anklickbar vor allem anderen)
    const free = overlaysOf(project, p.section, p.secPage, p.secLast);
    const extra = free.map((o) => overlaySvg(project, o)).join('');
    const hits = [...(body.hits || []), ...free.map((o) => ({ kind: 'overlay', id: o.id, rect: [o.x, o.y, o.w, o.h] }))];
    if (p.manual)
      return {
        section: p.section,
        kind: p.kind,
        manual: true,
        layout: null,
        site: null,
        hits,
        links: body.links || [],
        anchors: body.anchors || [],
        secPage: p.secPage,
        w: PAGE.w,
        h: PAGE.h,
        svg: svgPage(ts, body.svg + (p.plain ? '' : manualFrame(project, p.chapter || null, i + 1, total)) + extra, esc(BODY), 'normal'),
      };
    const head = p.plain ? '' : headerSvg(project, ts, p.title, p.subtitle);
    const foot = footerSvg(project, ts, p.plain ? '' : label, p.plain ? 0 : i + 1, total, p.kind === 'cover');
    return {
      section: p.section,
      kind: p.kind,
      layout: p.layout || null,
      site: p.site || null,
      hits,
      links: body.links || [],
      anchors: body.anchors || [],
      secPage: p.secPage,
      land: !!p.land,
      w: PAGE.w,
      h: PAGE.h,
      svg: svgPage(ts, head + body.svg + foot + extra),
    };
  }
}

function sectionTitleInline(section, ts) {
  return ts.langs.map((l) => sectionTitle(section, l)).filter((v, i, a) => a.indexOf(v) === i).join(' / ');
}

/** Anklickbare Bereiche des Schaltbilds (mit der Verkleinerung, falls es nicht auf die Seite passt). */
function diagramHits(L) {
  const [ox, oy] = L.origin;
  const s = L.scale;
  const r = (x, y, w, h) => [ox + (x - ox) * s, oy + (y - oy) * s, w * s, h * s];
  const hits = [{ kind: 'hub', rect: r(L.hub.x, L.hub.y, L.hub.w, L.hub.h) }];
  for (const c of L.conns) {
    const x = Math.min(c.x1, c.x2);
    hits.push({ kind: 'conn', id: c.pins[0], box: c.box, rect: r(x, c.y - 5, Math.abs(c.x2 - c.x1), 10) });
  }
  for (const b of L.boxes) hits.push({ kind: 'box', id: b.id, rect: r(b.x, b.y, b.w, b.h) });
  hits.push({ kind: 'legend', rect: [PAGE.left, DIAGRAM.bottom + 12, PAGE.right - PAGE.left, 64] });
  return hits;
}
