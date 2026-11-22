// Run: node --test
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const KS2 = require('../keystep2.js');

const original = new Uint8Array(fs.readFileSync(path.join(__dirname, '..', 'export.keystep2')));
const load = () => KS2.parse(original.slice());
const filled = (file) => [...file.patterns.values()].filter((p) => !KS2.isEmpty(p.blob));

test('finds 64 slots, 16 with data', () => {
  const file = load();
  assert.equal(file.device, 'KeyStep mk2');
  assert.equal(file.patterns.size, 64);
  assert.equal(filled(file).length, 16);
});

test('unedited file serializes byte-identical', () => {
  assert.deepEqual(KS2.serialize(load()), original);
});

test('checksum formula holds for every pattern', () => {
  for (const p of filled(load())) {
    assert.equal(KS2.storedChecksum(p.blob), KS2.xorSum(p.blob) ^ 0x3fff, `pattern ${p.bank}-${p.number}`);
    assert.equal(p.checksumOk, true);
  }
});

test('header words equal the normalised JSON parameters', () => {
  for (const p of filled(load())) {
    for (const def of KS2.PARAMS) {
      const raw = p.params[def.id];
      assert.equal(KS2.word(p.blob, def.offset), KS2.normWord(def, raw), `${p.bank}-${p.number} ${def.key}`);
    }
  }
});

test('parameters decode to real-world values', () => {
  const file = load();
  const p = file.patterns.get('1_16');
  assert.equal(KS2.getParam(p, 'tempo'), 120);
  assert.equal(KS2.getParam(p, 'length'), 64);
  assert.equal(KS2.getParam(p, 'gate'), 50);
  assert.equal(KS2.getParam(p, 'swing'), 50);
  assert.equal(KS2.formatParam(p, 'division'), '1/16');
  assert.equal(KS2.getParam(file.patterns.get('1_1'), 'length'), 15);
  assert.equal(KS2.getParam(file.patterns.get('1_15'), 'gate'), 10);
});

test('steps decode as 64 records of 36 bytes', () => {
  const steps = KS2.readSteps(load().patterns.get('1_9').blob);
  assert.equal(steps.length, 64);
  assert.deepEqual(steps[0].map((n) => KS2.noteName(n.n)), ['A2', 'A3', 'C4']);
  assert.deepEqual(steps[0].map((n) => n.v), [113, 104, 119]);
  assert.equal(steps[1].length, 0);
  assert.deepEqual(steps[63 - 1].map((n) => KS2.noteName(n.n)), ['C2', 'A3', 'E4']);
});

test('rewriting every step leaves the blob unchanged', () => {
  for (const p of filled(load())) {
    const before = p.blob.slice();
    KS2.readSteps(p.blob).forEach((notes, i) => KS2.writeStep(p.blob, i, notes));
    KS2.updateChecksum(p);
    assert.deepEqual(p.blob, before, `pattern ${p.bank}-${p.number}`);
  }
});

test('initBlob reproduces a factory header', () => {
  for (const p of filled(load())) {
    const fresh = KS2.initBlob(p.params);
    assert.deepEqual(fresh.subarray(0, KS2.STEPS_OFFSET), p.blob.subarray(0, KS2.STEPS_OFFSET), `pattern ${p.bank}-${p.number}`);
    assert.deepEqual(fresh.subarray(KS2.STEPS_END), p.blob.subarray(KS2.STEPS_END).map((b, i) => (i >= KS2.CHECKSUM_OFFSET - KS2.STEPS_END && i < KS2.CHECKSUM_OFFSET - KS2.STEPS_END + 2 ? fresh[KS2.STEPS_END + i] : b)));
  }
});

test('edits survive a save and reload', () => {
  const file = load();
  const p = file.patterns.get('1_2');
  const steps = KS2.readSteps(p.blob);
  steps[0].push({ n: 34, v: 34, l: 6, x: 0 }); // 0x22 bytes: must not break blob extraction
  KS2.writeStep(p.blob, 0, steps[0]);
  KS2.updateChecksum(p);
  KS2.setParam(p, 'tempo', 97.5);
  KS2.setParam(p, 'length', 7);

  const empty = file.patterns.get('3_4');
  empty.blob = KS2.initBlob(empty.params);
  KS2.writeStep(empty.blob, 5, [{ n: 60, v: 90, l: 2, x: 0 }]);
  KS2.updateChecksum(empty);

  const again = KS2.parse(KS2.serialize(file));
  const q = again.patterns.get('1_2');
  assert.equal(KS2.getParam(q, 'tempo'), 97.5);
  assert.equal(KS2.getParam(q, 'length'), 7);
  assert.equal(q.params[24580], 675);
  assert.equal(q.checksumOk, true);
  assert.deepEqual(KS2.readSteps(q.blob)[0], [{ n: 34, v: 34, l: 6, x: 0 }, { n: 60, v: 43, l: 2, x: 0 }]);
  const r = again.patterns.get('3_4');
  assert.equal(r.checksumOk, true);
  assert.deepEqual(KS2.readSteps(r.blob)[5], [{ n: 60, v: 90, l: 2, x: 0 }]);
  assert.equal(filled(again).length, 17);
  // Untouched patterns are untouched.
  assert.deepEqual(again.patterns.get('1_16').blob, load().patterns.get('1_16').blob);
});

test('createProject reproduces the exported file byte for byte', () => {
  const file = load();
  const blobs = new Map([...file.patterns].map(([key, p]) => [key, p.blob]));
  const params = new Map([...file.patterns].map(([key, p]) => [key, p.params]));
  assert.deepEqual(KS2.serialize(KS2.createProject(blobs, params)), original);
});

test('paramsFromBlob recovers the text parameters', () => {
  for (const p of filled(load())) assert.deepEqual(KS2.paramsFromBlob(p.blob), p.params, `pattern ${p.bank}-${p.number}`);
});
