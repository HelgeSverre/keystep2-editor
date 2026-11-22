// Protocol vectors are messages recorded between MIDI Control Center and a KeyStep mk2 (firmware 1.0.2).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const KS2 = require('../keystep2.js');
const MIDI = require('../keystep2-midi.js');

const hex = (s) => Uint8Array.from(s.split(' ').map((h) => parseInt(h, 16)));
const original = new Uint8Array(fs.readFileSync(path.join(__dirname, '..', 'export.keystep2')));

test('requests match the recorded bytes', () => {
  const { OP, encodeRequest } = MIDI;
  assert.deepEqual(encodeRequest(0x3b, OP.READ_BLOCK, [9]), hex('f0 00 20 6b 3b 10 7c 4e 00 f7'));
  assert.deepEqual(encodeRequest(0x2f, OP.SELECT_PATTERN, [9]), hex('f0 00 20 6b 2f 7c 24 4b 00 f7'));
  assert.deepEqual(encodeRequest(0x54, OP.SELECT_PATTERN, [25]), hex('f0 00 20 6b 54 7c 24 43 11 03 f7'));
  assert.deepEqual(encodeRequest(0x48, OP.OPEN_WRITE, [9]), hex('f0 00 20 6b 48 5c 19 4c 00 f7'));
  assert.deepEqual(encodeRequest(0x30, OP.GET_PATTERN_PARAM, [0x4000]), hex('f0 00 20 6b 30 58 59 4e 01 08 00 f7'));
  assert.deepEqual(encodeRequest(0x00, OP.GET_GLOBAL_PARAM, [0x6000]), hex('f0 00 20 6b 00 54 24 4c 01 0c 00 f7'));
});

test('a block write carries 32 bytes as recorded', () => {
  const block = KS2.parse(original.slice()).patterns.get('1_10').blob.subarray(0, 32);
  const message = MIDI.encodeRequest(0x49, MIDI.OP.WRITE_BLOCK, [block]);
  assert.deepEqual(message.subarray(0, 18), hex('f0 00 20 6b 49 20 30 45 05 04 40 36 5b 7e 7f 7b 7f 07'));
  assert.equal(message.length, 48);
});

test('replies decode', () => {
  const value = MIDI.decodeMessage(hex('f0 00 20 6b 0a 33 00 0a 10 03 13 66 f7'));
  assert.equal(value.seq, 0x0a);
  assert.equal(value.value, true);
  assert.deepEqual(MIDI.decodeCbor(value.bytes), [0x4001, 0x4ccc]);
  const zero = MIDI.decodeMessage(hex('f0 00 20 6b 24 33 00 02 00 00 f7'));
  assert.deepEqual(MIDI.decodeCbor(zero.bytes), [0x4000, 0]);
  const block = MIDI.decodeMessage(hex('f0 00 20 6b 3b 31 01 01 50 6d 56 7f 7f 7e 7f 01 00 60 36 1b 00 00 00 00 00 00 00 00 00 7e 7f 03 00 00 00 00 00 00 7c 7f 7f 7f 7f 7f f7'));
  const [bytes] = MIDI.decodeCbor(block.bytes);
  assert.equal(bytes.length, 32);
  assert.deepEqual(bytes.subarray(0, 11), hex('00 6d 5b ff 7f ff 3f 00 00 db 36'));
  assert.equal(MIDI.decodeMessage(hex('f0 00 20 6b 54 00 00 60 00 f7')).value, false); // plain acknowledgement
});

test('7-bit packing round-trips', () => {
  const bytes = Uint8Array.from({ length: 77 }, (_, i) => (i * 73 + 5) & 0xff);
  assert.deepEqual(MIDI.unpack7(MIDI.pack7(bytes)).subarray(0, 77), bytes);
});

test('pattern index and value scaling', () => {
  assert.equal(MIDI.patternIndex(1, 1), 0);
  assert.equal(MIDI.patternIndex(2, 10), 25);
  assert.equal(MIDI.patternIndex(4, 16), 63);
  assert.equal(MIDI.normalise(40, 80), 0x4000); // gate 50 %
  assert.equal(MIDI.normalise(900, 2100), 0x36db); // 120 BPM
  assert.equal(MIDI.normalise(15, 63), 0x1e7a); // 16 steps
  assert.equal(MIDI.normalise(63, 63), 0x7fff);
});

test('a device talks through the transport', async () => {
  // A stand-in device with the reader behaviour seen on hardware.
  const blobs = new Map([[5, new Uint8Array(4096).fill(0xff)], [4, new Uint8Array(4096).fill(0xff)]]);
  blobs.get(5).set([0, 0x6d, 0x5b, 1, 2, 3], 0);
  let reader = { item: -1, at: 0, left: 0, done: -1 }, selected = 0, writing = null;
  const transport = {
    onmessage: null,
    send(data) {
      const m = MIDI.decodeMessage(data), op = (m.bytes[0] << 8) | m.bytes[1], items = MIDI.decodeCbor(m.bytes.subarray(2));
      const reply = (replyItems) => {
        const bytes = [0x80 | m.seq, ...replyItems.flatMap((i) => MIDI.cbor(i))];
        queueMicrotask(() => transport.onmessage(Uint8Array.from([0xf0, 0, 0x20, 0x6b, ...MIDI.pack7(bytes), 0xf7])));
      };
      if (op === MIDI.OP.SELECT_PATTERN) { selected = items[0]; if (reader.left) { reader.item = selected; reader.at = 0; } }
      else if (op === MIDI.OP.READ_BLOCK) {
        if (!reader.left && items[0] !== reader.done) reader = { item: items[0], at: 0, left: 128, done: -1 };
        if (!reader.left) return reply([new Uint8Array(0)]);
        const blob = blobs.get(reader.item) || new Uint8Array(4096).fill(0xff);
        reply([blob.slice(reader.at, reader.at + 32)]);
        reader.at += 32; reader.left--;
        if (!reader.left) reader.done = reader.item;
      } else if (op === MIDI.OP.OPEN_WRITE) writing = { item: items[0], parts: [] };
      else if (op === MIDI.OP.WRITE_BLOCK) writing.parts.push(items[0]);
      else if (op === MIDI.OP.COMMIT_PATTERN) blobs.set(writing.item, Uint8Array.from(writing.parts.flatMap((part) => [...part])));
      else if (op === MIDI.OP.GET_GLOBAL_PARAM) reply([items[0], 0]);
    },
  };
  const device = new MIDI.Device(transport);
  assert.equal(await device.probe(), true);
  const first = await device.readPattern(1, 6);
  assert.deepEqual(first, blobs.get(5));
  assert.deepEqual(await device.readPattern(1, 6), blobs.get(5), 'reading the same pattern twice');
  assert.deepEqual(await device.readPattern(1, 5), blobs.get(4), 'then its neighbour');
  const sent = KS2.parse(original.slice()).patterns.get('1_9');
  await device.writePattern(1, 6, sent.blob, MIDI.PARAM_ORDER.map((id) => ({ id, raw: sent.params[id], range: KS2.PARAM_BY_ID.get(id).range })));
  assert.deepEqual(await device.readPattern(1, 6), sent.blob);
});
