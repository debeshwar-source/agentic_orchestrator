'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const { KnowledgeFolderIngestor } = loadTs('src/main/knowledgeFolders.ts');

/** A stub standing in for KnowledgeManager (the real one needs a live
 *  Electron `app` for app.getPath, unavailable in a plain node --test
 *  run) -- faithful to its actual public surface: active(), root(),
 *  ingestText(), list(), remove(). Backed by an in-memory Map, so this
 *  test exercises KnowledgeFolderIngestor's REAL logic (walking a real
 *  temp folder on disk, hashing, deciding add/update/unchanged/removed)
 *  against a fake only at the KG-storage boundary. */
function makeStubKnowledgeManager(kgRoot) {
  const docs = new Map();
  let nextId = 1;
  return {
    active: () => true,
    root: () => kgRoot,
    ingestText(text, opts) {
      const id = `doc${nextId++}`;
      docs.set(id, { id, title: opts.title, caption: opts.caption ?? null, source: opts.title, modality: 'text', mime: null, origExt: 'txt', bytes: text.length, tags: [], chunkCount: 1, addedAt: new Date().toISOString(), extractor: 'test', truncated: false });
      return { docId: id, chunkCount: 1, meta: docs.get(id) };
    },
    list: () => [...docs.values()],
    remove(id) {
      return docs.delete(id);
    },
    _docs: docs
  };
}

function mkTempHive() {
  const hiveRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-'));
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-folder-'));
  return { hiveRoot, folder };
}

test('ingesting a fresh folder adds every eligible file and writes the condensed map', () => {
  const { hiveRoot, folder } = mkTempHive();
  fs.writeFileSync(path.join(folder, 'readme.md'), '# Readme\n\nThis project does X.');
  fs.writeFileSync(path.join(folder, 'notes.txt'), 'Some plain notes about Y.');
  fs.writeFileSync(path.join(folder, 'ignore.bin'), Buffer.from([0, 1, 2])); // not in the allow-list

  const km = makeStubKnowledgeManager(path.join(hiveRoot, 'kg'));
  const ingestor = new KnowledgeFolderIngestor(km, () => hiveRoot);
  const result = ingestor.ingestFolder(folder);

  assert.equal(result.added, 2); // .bin excluded
  assert.equal(km._docs.size, 2);
  const mapText = fs.readFileSync(path.join(hiveRoot, 'knowledge-map.md'), 'utf8');
  assert.match(mapText, /readme\.md/);
  assert.match(mapText, /notes\.txt/);
  assert.doesNotMatch(mapText, /ignore\.bin/);
});

test('re-ingesting an unchanged folder does nothing new', () => {
  const { hiveRoot, folder } = mkTempHive();
  fs.writeFileSync(path.join(folder, 'a.md'), 'Content A');
  const km = makeStubKnowledgeManager(path.join(hiveRoot, 'kg'));
  const ingestor = new KnowledgeFolderIngestor(km, () => hiveRoot);

  ingestor.ingestFolder(folder);
  const second = ingestor.ingestFolder(folder);

  assert.equal(second.added, 0);
  assert.equal(second.unchanged, 1);
  assert.equal(km._docs.size, 1); // no duplicate
});

test('a changed file is re-ingested WITHOUT leaving a duplicate stale entry', () => {
  const { hiveRoot, folder } = mkTempHive();
  const filePath = path.join(folder, 'a.md');
  fs.writeFileSync(filePath, 'Original content');
  const km = makeStubKnowledgeManager(path.join(hiveRoot, 'kg'));
  const ingestor = new KnowledgeFolderIngestor(km, () => hiveRoot);
  ingestor.ingestFolder(folder);

  fs.writeFileSync(filePath, 'Changed content, materially different');
  const result = ingestor.ingestFolder(folder);

  assert.equal(result.updated, 1);
  assert.equal(km._docs.size, 1); // the old doc was removed, not left behind
});

test('a deleted file is removed from the knowledge base on the next scan', () => {
  const { hiveRoot, folder } = mkTempHive();
  const filePath = path.join(folder, 'temp.md');
  fs.writeFileSync(filePath, 'Here today');
  const km = makeStubKnowledgeManager(path.join(hiveRoot, 'kg'));
  const ingestor = new KnowledgeFolderIngestor(km, () => hiveRoot);
  ingestor.ingestFolder(folder);
  assert.equal(km._docs.size, 1);

  fs.unlinkSync(filePath);
  const result = ingestor.ingestFolder(folder);

  assert.equal(result.removed, 1);
  assert.equal(km._docs.size, 0);
  const mapText = fs.readFileSync(path.join(hiveRoot, 'knowledge-map.md'), 'utf8');
  assert.doesNotMatch(mapText, /temp\.md/);
});

test('an inactive (disabled) knowledge graph is a safe no-op', () => {
  const { hiveRoot, folder } = mkTempHive();
  fs.writeFileSync(path.join(folder, 'a.md'), 'content');
  const km = makeStubKnowledgeManager(path.join(hiveRoot, 'kg'));
  km.active = () => false;
  const ingestor = new KnowledgeFolderIngestor(km, () => hiveRoot);
  const result = ingestor.ingestFolder(folder);

  assert.deepEqual(result, { added: 0, updated: 0, unchanged: 0, removed: 0 });
  assert.equal(fs.existsSync(path.join(hiveRoot, 'knowledge-map.md')), false);
});

test('registerFolder persists it, and unregisterFolder removes its docs and the map entry', () => {
  const { hiveRoot, folder } = mkTempHive();
  fs.writeFileSync(path.join(folder, 'a.md'), 'content');
  const km = makeStubKnowledgeManager(path.join(hiveRoot, 'kg'));
  const ingestor = new KnowledgeFolderIngestor(km, () => hiveRoot);

  ingestor.registerFolder(folder);
  assert.ok(ingestor.registeredFolders().includes(folder));
  assert.equal(km._docs.size, 1);

  ingestor.unregisterFolder(folder);
  assert.ok(!ingestor.registeredFolders().includes(folder));
  assert.equal(km._docs.size, 0);
  ingestor.dispose();
});
