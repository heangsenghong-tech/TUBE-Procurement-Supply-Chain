// Loads the real Item & Supplier Master (exported from the live prototype) into an empty database.
// Transaction collections (PRs, POs, comparisons, contracts, samples) deliberately start empty.
'use strict';

const fs = require('node:fs');
const path = require('node:path');

function seedIfEmpty(store, seedDir) {
  const loaded = [];
  for (const collection of ['suppliers', 'items']) {
    const file = path.join(seedDir, collection + '.json');
    if (store.count(collection) > 0 || !fs.existsSync(file)) continue;
    const docs = JSON.parse(fs.readFileSync(file, 'utf8'));
    for (const id of Object.keys(docs)) store.set(collection, id, docs[id], null);
    loaded.push(collection + ': ' + Object.keys(docs).length);
  }
  if (loaded.length) console.log('Loaded master data — ' + loaded.join(', '));
  return loaded;
}

module.exports = { seedIfEmpty };
