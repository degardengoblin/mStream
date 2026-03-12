import * as db from '../db/manager.js';
import * as config from '../state/config.js';
import * as artistImages from '../db/artist-images.js';
import * as albumArt from '../db/album-art.js';

export function setup(mstream) {
  mstream.all('/api/v1/scanner/{*path}', (req, res, next) => {
    if (req.scanApproved !== true) { return res.status(403).json({ error: 'Access Denied' }); }
    next();
  });

  mstream.post('/api/v1/scanner/get-file', (req, res) => {
    const dbObj = { '$and': [
      { 'filepath': { '$eq': req.body.filepath } },
      { 'vpath': { '$eq': req.body.vpath } }
    ]};
    const dbFileInfo = db.getFileCollection().findOne(dbObj);

    // return empty response if nothing was found
    if (!dbFileInfo) {
      return res.json({});
    }
    // if the file was edited, remove it from the DB
    // TODO: we need a way to handle metadata (like ratings) for modified files
    else if (req.body.modTime !== dbFileInfo.modified) {
      db.getFileCollection().findAndRemove(dbObj);
      return res.json({});
    }
    // update the record with the new scan ID
    // This lets us clear out old files wit ha bulk delete at the end of the scan
    else {
      dbFileInfo.sID = req.body.scanId;
      db.getFileCollection().update(dbFileInfo);
    }

    res.json(dbFileInfo);
  });

  mstream.post('/api/v1/scanner/finish-scan', (req, res) => {
    db.getFileCollection().findAndRemove({ '$and': [
      { 'vpath': { '$eq': req.body.vpath } },
      { 'sID': { '$ne': req.body.scanId } }
    ]});

    db.saveFilesDB();
    res.json({});

    // Kick off artist image fetching in the background (non-blocking)
    const files = db.getFileCollection().find({ 'vpath': { '$eq': req.body.vpath } });
    const artists = [...new Set(files.map(f => f.artist).filter(Boolean))];
    artistImages.fetchArtistImages(artists)
      .catch(() => {})
      .then(() => artistImages.retryMissingArtistImages())
      .catch(() => {})
      .then(() => albumArt.fetchMissingAlbumArt())
      .catch(() => {})
      .then(() => albumArt.retryMissingAlbumArt())
      .catch(() => {});
  });

  let saveCounter = 0;
  mstream.post('/api/v1/scanner/add-file', (req, res) => {
    db.getFileCollection().insert(req.body);
    res.json({});

    saveCounter++;
    if(saveCounter > config.program.scanOptions.saveInterval) {
      saveCounter = 0;
      db.saveFilesDB();
    }
  });
}
