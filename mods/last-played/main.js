'use strict';

// Last-played album history.
//
// There is no usable last-played data in Qobuz's local DB or client bundle, so
// this mod records album starts from the runtime player bridge. It is
// deliberately independent of favorites: albums that are not in the library
// still appear in the list.

const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const MAX_OUTPUT = 200;
const KEEP_DAYS = 365;

let ctx = null;
let file = null;
let data = null;
let saveTimer = null;
let pendingTrack = null;
let recordedForLoad = false;

function emptyData() {
  return {
    version: 1,
    updatedAt: null,
    albums: {},
  };
}

function load() {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return {
      version: 1,
      updatedAt: parsed.updatedAt || null,
      albums: parsed.albums && typeof parsed.albums === 'object' ? parsed.albums : {},
    };
  } catch (error) {
    if (error.code !== 'ENOENT') {
      ctx.log.warn('could not read last-played.json; starting fresh', error.message);
    }
    return emptyData();
  }
}

function flush() {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  if (!data || !file) return;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
    fs.renameSync(tmp, file);
  } catch (error) {
    ctx.log.error('could not save last-played.json', error);
  }
}

function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    flush();
  }, 750);
}

function artworkUrl(meta) {
  if (meta.artworkPath) {
    try {
      return pathToFileURL(meta.artworkPath).href;
    } catch {
      // Fall through.
    }
  }
  return meta.artworkUrl || '';
}

function keyFor(meta) {
  if (meta.albumId) return `album:${meta.albumId}`;
  return `title:${meta.album || ''}|${meta.artist || ''}`;
}

function record(meta) {
  if (!meta || (!meta.albumId && !meta.album)) return;
  const key = keyFor(meta);
  const now = Date.now();
  const existing = data.albums[key];

  const album = existing || {
    albumId: meta.albumId || '',
    albumTitle: meta.album || '',
    artist: meta.artist || '',
    artworkUrl: '',
    playCount: 0,
    lastPlayedAt: 0,
    lastTrackTitle: '',
  };

  if (meta.albumId) album.albumId = meta.albumId;
  if (meta.album) album.albumTitle = meta.album;
  if (meta.artist) album.artist = meta.artist;
  if (meta.title) album.lastTrackTitle = meta.title;
  const art = artworkUrl(meta);
  if (art) album.artworkUrl = art;
  album.playCount = Number(album.playCount || 0) + 1;
  album.lastPlayedAt = now;

  data.albums[key] = album;
  data.updatedAt = new Date(now).toISOString();
  scheduleSave();

  ctx.log.info('recorded play', {
    albumId: album.albumId,
    albumTitle: album.albumTitle,
    artist: album.artist,
    playCount: album.playCount,
  });
}

function markCurrent() {
  if (!pendingTrack || recordedForLoad) return;
  recordedForLoad = true;
  record(pendingTrack);
}

function list() {
  const cutoff = Date.now() - KEEP_DAYS * 24 * 60 * 60 * 1000;
  const albums = Object.values(data.albums)
    .filter((album) => Number(album.lastPlayedAt || 0) >= cutoff)
    .sort((a, b) => Number(b.lastPlayedAt || 0) - Number(a.lastPlayedAt || 0))
    .slice(0, MAX_OUTPUT)
    .map((album) => ({
      albumId: album.albumId || '',
      albumTitle: album.albumTitle || '',
      artist: album.artist || '',
      artworkUrl: album.artworkUrl || '',
      playCount: Number(album.playCount || 0),
      lastPlayedAt: Number(album.lastPlayedAt || 0),
      lastTrackTitle: album.lastTrackTitle || '',
    }));

  return {
    albums,
    total: Object.keys(data.albums).length,
    updatedAt: data.updatedAt,
  };
}

function clear() {
  data = emptyData();
  flush();
}

module.exports.activate = function activate(context) {
  ctx = context;
  file = path.join(ctx.paths.dataDir, 'last-played.json');
  data = load();

  ctx.ipc.handle('list', () => list());
  ctx.ipc.handle('clear', () => {
    clear();
    return list();
  });

  ctx.onPlayerEvent((event) => {
    try {
      switch (event.type) {
        case 'track':
          pendingTrack = event.track;
          recordedForLoad = false;
          if (event.playing) markCurrent();
          break;
        case 'progress':
          if (event.playing) markCurrent();
          break;
        case 'state':
          if (event.state === 'playing') markCurrent();
          break;
        case 'clear':
          pendingTrack = null;
          recordedForLoad = false;
          break;
        case 'quit':
          flush();
          break;
        default:
          break;
      }
    } catch (error) {
      ctx.log.error('event handling failed', error);
    }
  });

  ctx.log.info('last-played ready', {
    albums: Object.keys(data.albums).length,
    file,
  });
};

module.exports.deactivate = function deactivate() {
  flush();
  ctx = null;
  pendingTrack = null;
};
