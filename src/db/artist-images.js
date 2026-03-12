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

function normalizeArtistName(name) {
  // Comma-article inversion: "Beatles, The" → "The Beatles"
  name = name.replace(/^(.+),\s*(the|a|an)$/i, '$2 $1');
  // NFD decompose + strip combining marks (diacritics → ASCII base letter)
  name = name.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  return name
    .toLowerCase()
    .replace(/\s*&\s*/g, ' and ')  // & → and
    .replace(/^(the|a|an)\s+/, '') // strip leading articles
    .replace(/[^\w\s]/g, '')       // remove remaining punctuation
    .replace(/\s+/g, ' ')
    .trim();
}

// Jaro-Winkler similarity (0.0–1.0)
function jaroWinkler(a, b) {
  if (a === b) return 1;
  const la = a.length, lb = b.length;
  if (la === 0 || lb === 0) return 0;
  const matchDist = Math.max(Math.floor(Math.max(la, lb) / 2) - 1, 0);
  const aMatched = new Array(la).fill(false);
  const bMatched = new Array(lb).fill(false);
  let matches = 0, transpositions = 0;
  for (let i = 0; i < la; i++) {
    const start = Math.max(0, i - matchDist);
    const end = Math.min(i + matchDist + 1, lb);
    for (let j = start; j < end; j++) {
      if (bMatched[j] || a[i] !== b[j]) continue;
      aMatched[i] = bMatched[j] = true;
      matches++;
      break;
    }
  }
  if (matches === 0) return 0;
  let k = 0;
  for (let i = 0; i < la; i++) {
    if (!aMatched[i]) continue;
    while (!bMatched[k]) k++;
    if (a[i] !== b[k]) transpositions++;
    k++;
  }
  const jaro = (matches / la + matches / lb + (matches - transpositions / 2) / matches) / 3;
  let prefix = 0;
  for (let i = 0; i < Math.min(4, la, lb); i++) {
    if (a[i] !== b[i]) break;
    prefix++;
  }
  return jaro + prefix * 0.1 * (1 - jaro);
}

const MATCH_THRESHOLD = 0.85;

function bestCandidate(artistName, candidates) {
  const normalizedQuery = normalizeArtistName(artistName);
  let best = null, bestScore = 0;
  for (const hit of candidates) {
    if (!hit?.name) continue;
    const score = jaroWinkler(normalizedQuery, normalizeArtistName(hit.name));
    if (score > bestScore) { bestScore = score; best = hit; }
  }
  return bestScore >= MATCH_THRESHOLD ? best : null;
}

function deezerSearch(query, limit) {
  return new Promise((resolve) => {
    const options = {
      hostname: 'api.deezer.com',
      path: `/search/artist?q=${encodeURIComponent(query)}&limit=${limit}`,
      headers: { 'User-Agent': 'mStream/1.0' },
      timeout: 8000
    };
    const req = https.get(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data).data || []); } catch { resolve([]); }
      });
    });
    req.on('error', () => resolve([]));
    req.on('timeout', () => { req.destroy(); resolve([]); });
  });
}

async function getDeezerImageUrl(artistName) {
  // Primary search: full artist name, top 5 candidates
  let candidates = await deezerSearch(artistName, 5);
  let hit = bestCandidate(artistName, candidates);

  // Fallback: first 2 significant words if full-name search found nothing
  if (!hit) {
    const words = normalizeArtistName(artistName).split(' ').filter(Boolean);
    if (words.length > 2) {
      candidates = await deezerSearch(words.slice(0, 2).join(' '), 5);
      hit = bestCandidate(artistName, candidates);
    }
  }

  return hit?.picture_xl || null;
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
