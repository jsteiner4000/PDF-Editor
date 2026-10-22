/**
 * Update-Prüfung ohne Electron (testbar): wertet die Antwort der GitHub-API „neuestes Release“
 * aus. Ein Update gibt es nur mit Setup-Datei, passender Versionsnummer und SHA-256-Prüfsumme
 * (GitHub `digest`) – ohne Prüfsumme wird nichts automatisch installiert.
 */
export const REPO = 'jsteiner4000/PlantPDF';
export const LATEST_URL = `https://api.github.com/repos/${REPO}/releases/latest`;
const ASSET = /^PlantPDF-Setup-(\d+\.\d+\.\d+)\.exe$/;
const DOWNLOAD_HOSTS = ['github.com', 'objects.githubusercontent.com', 'release-assets.githubusercontent.com'];

/** a > b für „x.y.z“ (Zusätze wie „-beta“ zählen nicht). */
export function isNewer(a, b) {
  const p = (v) => String(v).replace(/^v/, '').split(/[.-]/).slice(0, 3).map((x) => parseInt(x, 10) || 0);
  const [x, y] = [p(a), p(b)];
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
  return false;
}

/** Erlaubte Download-Adresse (https, GitHub)? */
export function allowedUrl(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && DOWNLOAD_HOSTS.includes(u.hostname);
  } catch {
    return false;
  }
}

/**
 * Update aus der API-Antwort: { version, url, size, sha256, page } oder null (kein neueres,
 * unvollständiges oder unbrauchbares Release).
 */
export function pickUpdate(release, current) {
  if (!release || typeof release !== 'object' || release.draft || release.prerelease) return null;
  const tag = String(release.tag_name || '').replace(/^v/i, '');
  const asset = (Array.isArray(release.assets) ? release.assets : []).find((a) => a && ASSET.test(String(a.name)));
  if (!asset) return null;
  const version = ASSET.exec(asset.name)[1];
  if (version !== tag || !isNewer(version, current)) return null;
  const sha = /^sha256:([0-9a-f]{64})$/i.exec(String(asset.digest || ''));
  const size = Number(asset.size);
  if (!allowedUrl(asset.browser_download_url) || !(size > 0)) return null;
  return {
    version,
    url: asset.browser_download_url,
    size,
    sha256: sha ? sha[1].toLowerCase() : null,
    page: allowedUrl(release.html_url) ? release.html_url : `https://github.com/${REPO}/releases/latest`,
  };
}
