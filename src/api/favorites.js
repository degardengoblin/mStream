import Joi from 'joi';
import * as dbManager from '../db/manager.js';

const MY_FAVORITES = 'My Favorites';

export function setup(mstream) {

  // GET /api/v1/favorites/songs
  // Returns all filepaths in the "My Favorites" playlist for the current user.
  mstream.get('/api/v1/favorites/songs', (req, res) => {
    const username = req.user.username;
    const playlist = dbManager.getPlaylistCollection();
    const entries = playlist.find({ user: username, name: MY_FAVORITES, filepath: { $ne: null } });
    res.json(entries.map(e => e.filepath));
  });

  // POST /api/v1/favorites/songs/toggle
  // Body: { filepath }
  // Idempotently adds or removes a song from "My Favorites". Returns { isFavorited }.
  mstream.post('/api/v1/favorites/songs/toggle', (req, res) => {
    const schema = Joi.object({ filepath: Joi.string().required() });
    const { error, value } = schema.validate(req.body);
    if (error) return res.status(403).json({ error: error.message });

    const { filepath } = value;
    const username = req.user.username;
    const playlist = dbManager.getPlaylistCollection();

    // Ensure the sentinel entry (the playlist itself) exists
    const sentinel = playlist.findOne({ user: username, name: MY_FAVORITES, filepath: null });
    if (!sentinel) {
      playlist.insert({ user: username, name: MY_FAVORITES, filepath: null });
    }

    const existing = playlist.findOne({ user: username, name: MY_FAVORITES, filepath });
    if (existing) {
      playlist.remove(existing);
      dbManager.saveUserDB();
      return res.json({ isFavorited: false });
    } else {
      playlist.insert({ user: username, name: MY_FAVORITES, filepath });
      dbManager.saveUserDB();
      return res.json({ isFavorited: true });
    }
  });

  // GET /api/v1/favorites/albums
  // Returns [{ album, artist }] for the current user.
  mstream.get('/api/v1/favorites/albums', (req, res) => {
    const username = req.user.username;
    const favorites = dbManager.getFavoritesCollection();
    const entries = favorites.find({ user: username, type: 'album' });
    res.json(entries.map(e => ({ album: e.album, artist: e.artist })));
  });

  // POST /api/v1/favorites/albums/toggle
  // Body: { album, artist }
  // Adds or removes an album favorite. Returns { isFavorited }.
  mstream.post('/api/v1/favorites/albums/toggle', (req, res) => {
    const schema = Joi.object({
      album: Joi.string().required(),
      artist: Joi.string().required()
    });
    const { error, value } = schema.validate(req.body);
    if (error) return res.status(403).json({ error: error.message });

    const { album, artist } = value;
    const username = req.user.username;
    const favorites = dbManager.getFavoritesCollection();

    const existing = favorites.findOne({ user: username, type: 'album', album, artist });
    if (existing) {
      favorites.remove(existing);
      dbManager.saveUserDB();
      return res.json({ isFavorited: false });
    } else {
      favorites.insert({ user: username, type: 'album', album, artist });
      dbManager.saveUserDB();
      return res.json({ isFavorited: true });
    }
  });

  // GET /api/v1/favorites/artists
  // Returns [{ artist }] for the current user.
  mstream.get('/api/v1/favorites/artists', (req, res) => {
    const username = req.user.username;
    const favorites = dbManager.getFavoritesCollection();
    const entries = favorites.find({ user: username, type: 'artist' });
    res.json(entries.map(e => ({ artist: e.artist })));
  });

  // POST /api/v1/favorites/artists/toggle
  // Body: { artist }
  // Adds or removes an artist favorite. Returns { isFavorited }.
  mstream.post('/api/v1/favorites/artists/toggle', (req, res) => {
    const schema = Joi.object({ artist: Joi.string().required() });
    const { error, value } = schema.validate(req.body);
    if (error) return res.status(403).json({ error: error.message });

    const { artist } = value;
    const username = req.user.username;
    const favorites = dbManager.getFavoritesCollection();

    const existing = favorites.findOne({ user: username, type: 'artist', artist });
    if (existing) {
      favorites.remove(existing);
      dbManager.saveUserDB();
      return res.json({ isFavorited: false });
    } else {
      favorites.insert({ user: username, type: 'artist', artist });
      dbManager.saveUserDB();
      return res.json({ isFavorited: true });
    }
  });
}
