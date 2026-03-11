import https from 'https';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

let imageDir;
let cacheFile;
let cache = {};
let initialized = false;

export function init(albumArtDirectory) {
  imageDir = path.join(albumArtDirectory, 'artists');
  cacheFile = path.join(albumArtDirectory, 'artist-images.json');

  if (!fs.existsSync(imageDir)) fs.mkdirSync(imageDir, { recursive: true });

  if (fs.existsSync(cacheFile)) {
    try { cache = JSON.parse(fs.readFileSync(cacheFile, 'utf8')); } catch (e) { cache = {}; }
  }

  initialized = true;
}

export function getArtistImageFilename(artistName) {
  return cache[artistName] || null;
}

export async function retryMissingArtistImages() {
  if (!initialized) return 0;
  const missing = Object.keys(cache).filter(name => cache[name] === null);
  for (const name of missing) delete cache[name];
  saveCache();
  fetchArtistImages(missing).catch(() => {});
  return missing.length;
}

export async function fetchArtistImages(artists) {
  if (!initialized) return;

  for (const artist of artists) {
    if (!artist || cache[artist] !== undefined) continue;
    try {
      const url = await getDeezerImageUrl(artist);
      if (url) {
        const filename = await downloadImage(url, artist);
        cache[artist] = filename;
      } else {
        cache[artist] = null;
      }
    } catch (e) {
      cache[artist] = null;
    }
    saveCache();
    await sleep(250);
  }
}

function normalizeName(name) {
  return name
    .toLowerCase()
    .replace(/^the\s+/, '')
    .replace(/[^\w\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function artistNamesMatch(query, result) {
  const a = normalizeName(query);
  const b = normalizeName(result);
  return a === b || a.includes(b) || b.includes(a);
}

function getDeezerImageUrl(artistName) {
  return new Promise((resolve) => {
    const query = encodeURIComponent(artistName);
    const options = {
      hostname: 'api.deezer.com',
      path: `/search/artist?q=${query}&limit=1`,
      headers: { 'User-Agent': 'mStream/1.0' },
      timeout: 8000
    };
    const req = https.get(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          const hit = parsed.data?.[0];
          if (!hit || !artistNamesMatch(artistName, hit.name)) return resolve(null);
          resolve(hit.picture_xl || null);
        } catch { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

function downloadImage(url, artistName) {
  const hash = crypto.createHash('md5').update(artistName.toLowerCase()).digest('hex');
  const filename = `artist-${hash}.jpg`;
  const filepath = path.join(imageDir, filename);

  if (fs.existsSync(filepath)) return Promise.resolve(filename);

  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(filepath);
    https.get(url, { timeout: 10000 }, (res) => {
      res.pipe(file);
      file.on('finish', () => { file.close(); resolve(filename); });
      file.on('error', (e) => { fs.unlink(filepath, () => {}); reject(e); });
    }).on('error', (e) => { fs.unlink(filepath, () => {}); reject(e); });
  });
}

function saveCache() {
  try { fs.writeFileSync(cacheFile, JSON.stringify(cache, null, 2)); } catch (e) {}
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
