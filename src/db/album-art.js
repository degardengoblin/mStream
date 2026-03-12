import https from 'https';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import * as db from './manager.js';

let imageDir;
let cacheFile;
let cache = {};
let initialized = false;

export function init(albumArtDirectory) {
  imageDir = albumArtDirectory;
  cacheFile = path.join(albumArtDirectory, 'album-art.json');

  if (!fs.existsSync(imageDir)) fs.mkdirSync(imageDir, { recursive: true });

  if (fs.existsSync(cacheFile)) {
    try { cache = JSON.parse(fs.readFileSync(cacheFile, 'utf8')); } catch (e) { cache = {}; }
  }

  initialized = true;
}

export async function retryMissingAlbumArt() {
  if (!initialized) return 0;
  const missing = Object.keys(cache).filter(key => cache[key] === null);
  for (const key of missing) delete cache[key];
  saveCache();
  return fetchMissingAlbumArt();
}

export async function fetchMissingAlbumArt() {
  if (!initialized || !db.getFileCollection()) return;

  // Find all records with no album art and both artist + album set
  const records = db.getFileCollection().find({
    '$and': [
      { 'aaFile': { '$eq': null } },
      { 'artist': { '$ne': null } },
      { 'album': { '$ne': null } }
    ]
  });

  // Group by artist|album to avoid duplicate API calls
  const groups = new Map();
  for (const rec of records) {
    const key = `${rec.artist}|${rec.album}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(rec);
  }

  let anyUpdated = false;
  for (const [key, recs] of groups) {
    if (cache[key] !== undefined) continue; // already tried (success or null)

    const [artistName, albumName] = key.split('|');
    try {
      const result = await getDeezerAlbumData(artistName, albumName);
      if (result) {
        const filename = await downloadImage(result.coverUrl, key);
        cache[key] = filename;
        for (const rec of recs) {
          rec.aaFile = filename;
          if (result.year && !rec.year) rec.year = result.year;
          db.getFileCollection().update(rec);
        }
        anyUpdated = true;
      } else {
        cache[key] = null;
      }
    } catch (e) {
      cache[key] = null;
    }

    saveCache();
    await sleep(250);
  }

  if (anyUpdated) db.saveFilesDB();
}

function normalizeName(name) {
  // Comma-article inversion: "Beatles, The" → "The Beatles"
  name = name.replace(/^(.+),\s*(the|a|an)$/i, '$2 $1');
  // NFD decompose + strip combining marks (diacritics → ASCII base letter)
  name = name.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  return name
    .toLowerCase()
    .replace(/\s*&\s*/g, ' and ')  // & → and
    .replace(/^(the|a|an)\s+/, '') // strip leading articles
    .replace(/[^\w\s]/g, '')       // remove punctuation
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

const MATCH_THRESHOLD = 0.82;

function bestAlbumCandidate(artistName, albumName, candidates) {
  const normArtist = normalizeName(artistName);
  const normAlbum = normalizeName(albumName);
  let best = null, bestScore = 0;
  for (const hit of candidates) {
    if (!hit?.title || !hit?.artist?.name) continue;
    const artistScore = jaroWinkler(normArtist, normalizeName(hit.artist.name));
    const albumScore = jaroWinkler(normAlbum, normalizeName(hit.title));
    // Both fields must meet the threshold
    if (artistScore < MATCH_THRESHOLD || albumScore < MATCH_THRESHOLD) continue;
    const combined = (artistScore + albumScore) / 2;
    if (combined > bestScore) { bestScore = combined; best = hit; }
  }
  return best;
}

function deezerAlbumSearch(query, limit) {
  return new Promise((resolve) => {
    const options = {
      hostname: 'api.deezer.com',
      path: `/search/album?q=${encodeURIComponent(query)}&limit=${limit}`,
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

async function getDeezerAlbumData(artistName, albumName) {
  const query = `${artistName} ${albumName}`;

  // Primary search: artist + album name, top 5 candidates
  let candidates = await deezerAlbumSearch(query, 5);
  let hit = bestAlbumCandidate(artistName, albumName, candidates);

  // Fallback: artist + first 2 words of album name
  if (!hit) {
    const albumWords = normalizeName(albumName).split(' ').filter(Boolean);
    if (albumWords.length > 2) {
      candidates = await deezerAlbumSearch(`${artistName} ${albumWords.slice(0, 2).join(' ')}`, 5);
      hit = bestAlbumCandidate(artistName, albumName, candidates);
    }
  }

  if (!hit) return null;

  const coverUrl = hit.cover_xl || hit.cover_big || null;
  if (!coverUrl) return null;

  const year = hit.release_date ? parseInt(hit.release_date.slice(0, 4), 10) || null : null;
  return { coverUrl, year };
}

function downloadImage(url, cacheKey) {
  const hash = crypto.createHash('md5').update(cacheKey.toLowerCase()).digest('hex');
  const filename = `album-${hash}.jpg`;
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
