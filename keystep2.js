/*
 * KeyStep mk2 project file codec (.keystep2, exported by Arturia MIDI Control Center).
 * Loads as a classic script (global `KS2`) or a CommonJS module. The format is documented in README.md.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.KS2 = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

  const BLOB_SIZE = 4096;
  const STEP_COUNT = 64;
  const SLOT_COUNT = 8;
  const RECORD_SIZE = 36;
  const STEPS_OFFSET = 193;
  const STEPS_END = STEPS_OFFSET + STEP_COUNT * RECORD_SIZE; // 2497
  const CHECKSUM_OFFSET = 3521;
  const DATA_END = CHECKSUM_OFFSET + 4; // 3525, 0xFF padding after
  const EMPTY_NOTE = 0x80;
  const DEFAULT_VELOCITY = 100;
  const DEFAULT_LENGTH = 1;
  const CHECKSUM_BIAS = 0x3fff;
  const MAX_NOTE_LENGTH = 128; // half-steps

  // Header parameter groups: param id & 0xF000 -> byte offset of the group's first word.
  const GROUP_OFFSET = { 0x6000: 1, 0x2000: 65, 0x4000: 129 };

  const names = (s) => s.split(' ');
  const SPREAD = ['No', 'Velocity', 'Aftertouch'];
  for (let i = 1; i <= 16; i++) SPREAD.push(String(i));

  // min/max are the real-world range; the file stores (value - min).
  const PARAMS = [
    { id: 24580, key: 'tempo', label: 'Tempo', min: 300, max: 2400, scale: 0.1, unit: 'BPM' },
    { id: 24577, key: 'length', label: 'Length', min: 1, max: 64, unit: 'steps' },
    { id: 24576, key: 'division', label: 'Division', list: names('1/2D 1/2 1/4D 1/2T 1/4 1/8D 1/4T 1/8 1/16D 1/8T 1/16 1/32D 1/16T 1/32 1/32T') },
    { id: 24578, key: 'gate', label: 'Gate', min: 10, max: 90, unit: '%' },
    { id: 24579, key: 'swing', label: 'Swing', min: 50, max: 75, unit: '%' },
    { id: 24581, key: 'spice', label: 'Spice', min: 0, max: 100, unit: '%' },
    { id: 16384, key: 'scale', label: 'Scale', list: ['Off', 'Global', 'Major', 'Minor', 'Dorian', 'Phrygian', 'Lydian', 'Mixolydian', 'Locrian', 'Harmonic Minor', 'Blues', 'Pentatonic Major', 'Pentatonic Minor', 'Japanese', 'Gypsy', 'Arabic', 'Freygish', 'User'] },
    { id: 16385, key: 'root', label: 'Root', list: NOTE_NAMES },
    { id: 8192, key: 'chord', label: 'Chord', list: names('User Oct 5th Maj min sus2 sus4 Maj7 min7 Maj9 min9 Maj11 min11'), more: true },
    { id: 8197, key: 'spread', label: 'Spread', list: SPREAD, more: true },
    { id: 8193, key: 'strumMs', label: 'Strum', min: 0, max: 500, unit: 'ms', more: true },
    { id: 8194, key: 'strumSync', label: 'Strum sync', list: names('Off 1/64 1/32T 1/64D 1/32 1/16T 1/32D 1/16 1/8T 1/16D 1/8 1/4T 1/8D 1/4'), more: true },
    { id: 8195, key: 'strumType', label: 'Strum type', list: ['Up', 'Alt Up', 'Down', 'Alt Down', 'Random'], more: true },
    { id: 8196, key: 'voicing', label: 'Voicing', list: ['Off', 'On', 'Bass -1', 'Bass -2', 'Bass -3'], more: true },
    { id: 24586, key: 'bankMsb', label: 'Bank MSB', min: 0, max: 128, zeroOff: true, more: true },
    { id: 24587, key: 'bankLsb', label: 'Bank LSB', min: 0, max: 128, zeroOff: true, more: true },
    { id: 24588, key: 'program', label: 'Program', min: 0, max: 128, zeroOff: true, more: true },
  ];
  for (const d of PARAMS) {
    if (d.list) { d.min = 0; d.max = d.list.length - 1; }
    d.range = d.max - d.min;
    d.offset = GROUP_OFFSET[d.id & 0xf000] + 2 * (d.id & 0xfff);
  }
  const PARAM_BY_ID = new Map(PARAMS.map((d) => [d.id, d]));
  const PARAM_BY_KEY = Object.fromEntries(PARAMS.map((d) => [d.key, d]));
  // Raw values MCC writes for a fresh pattern.
  const DEFAULT_RAW = { 24580: 900, 24577: 15, 24576: 10, 24578: 40, 16384: 1 };

  // ---- small helpers -------------------------------------------------------

  function latin1(bytes, start = 0, end = bytes.length) {
    let s = '';
    for (let i = start; i < end; i += 0x8000) {
      s += String.fromCharCode.apply(null, bytes.subarray(i, Math.min(end, i + 0x8000)));
    }
    return s;
  }

  function bytesOf(str) {
    const out = new Uint8Array(str.length);
    for (let i = 0; i < str.length; i++) out[i] = str.charCodeAt(i) & 0xff;
    return out;
  }

  function noteName(n) {
    return NOTE_NAMES[n % 12] + (Math.floor(n / 12) - 1);
  }

  const word = (blob, off) => blob[off] | (blob[off + 1] << 8);
  function setWord(blob, off, v) {
    blob[off] = v & 0xff;
    blob[off + 1] = (v >> 8) & 0xff;
  }

  // ---- parameters ----------------------------------------------------------

  function rawOf(pattern, def) {
    const v = pattern.params[def.id];
    return v === undefined ? DEFAULT_RAW[def.id] || 0 : v;
  }

  /** Real-world value: number for ranges, list index for lists. */
  function getParam(pattern, key) {
    const def = PARAM_BY_KEY[key];
    const raw = rawOf(pattern, def);
    if (def.list) return raw;
    const v = raw + def.min;
    return def.scale ? Math.round(v * def.scale * 10) / 10 : v;
  }

  function formatParam(pattern, key) {
    const def = PARAM_BY_KEY[key];
    const v = getParam(pattern, key);
    if (def.list) return def.list[v] !== undefined ? def.list[v] : String(v);
    if (def.zeroOff && v === 0) return 'Off';
    return def.scale ? v.toFixed(1) : String(v);
  }

  /** 15-bit normalised header word for a raw value. Half rounds down (40/80 -> 0x3FFF). */
  function normWord(def, raw) {
    return Math.max(0, Math.ceil((2 * raw * 32767 - def.range) / (2 * def.range)));
  }

  function setParam(pattern, key, value) {
    const def = PARAM_BY_KEY[key];
    let raw = def.list ? value : Math.round(value / (def.scale || 1)) - def.min;
    raw = Math.max(0, Math.min(def.range, Math.round(raw)));
    pattern.params[def.id] = raw;
    if (!isEmpty(pattern.blob)) {
      setWord(pattern.blob, def.offset, normWord(def, raw));
      updateChecksum(pattern);
    }
    return raw;
  }

  // ---- pattern blob --------------------------------------------------------

  function isEmpty(blob) {
    for (let i = 0; i < DATA_END; i++) if (blob[i] !== 0xff) return false;
    return true;
  }

  /** XOR of the 96 header words and of every step byte. Stored checksum = this ^ 0x3FFF. */
  function xorSum(blob) {
    let x = 0;
    for (let o = 1; o < STEPS_OFFSET; o += 2) x ^= word(blob, o);
    for (let o = STEPS_OFFSET; o < STEPS_END; o++) x ^= blob[o];
    return x;
  }

  const storedChecksum = (blob) => word(blob, CHECKSUM_OFFSET);

  function updateChecksum(pattern) {
    const v = xorSum(pattern.blob) ^ pattern.bias;
    setWord(pattern.blob, CHECKSUM_OFFSET, v);
    pattern.blob[CHECKSUM_OFFSET + 2] = 0;
    pattern.blob[CHECKSUM_OFFSET + 3] = 0;
  }

  /** 64 steps, each an array of { n: pitch, v: velocity, l: length in half-steps, x: unknown byte }. */
  function readSteps(blob) {
    const steps = [];
    for (let s = 0; s < STEP_COUNT; s++) {
      const o = STEPS_OFFSET + s * RECORD_SIZE;
      const notes = [];
      for (let i = 0; i < SLOT_COUNT; i++) {
        const n = blob[o + i];
        if (n < 0x80) notes.push({ n, v: blob[o + 8 + i], l: blob[o + 16 + i], x: blob[o + 24 + i] });
      }
      steps.push(notes);
    }
    return steps;
  }

  /** Writes one step record. Notes are packed lowest pitch first, as the device does. */
  function writeStep(blob, index, notes) {
    const o = STEPS_OFFSET + index * RECORD_SIZE;
    const sorted = notes.slice(0, SLOT_COUNT).sort((a, b) => a.n - b.n);
    for (let i = 0; i < SLOT_COUNT; i++) {
      const note = sorted[i];
      blob[o + i] = note ? note.n & 0x7f : EMPTY_NOTE;
      blob[o + 8 + i] = note ? Math.max(1, Math.min(127, note.v)) : DEFAULT_VELOCITY;
      blob[o + 16 + i] = note ? Math.max(1, Math.min(MAX_NOTE_LENGTH, note.l)) : DEFAULT_LENGTH;
      blob[o + 24 + i] = note ? note.x || 0 : 0;
    }
    blob[o + 34] = sorted.length ? 1 : 0;
  }

  /** A blank pattern for an empty slot: header built from the slot's parameters, no notes. */
  function initBlob(params) {
    const blob = new Uint8Array(BLOB_SIZE).fill(0xff);
    blob.fill(0, 0, DATA_END);
    const fillWords = (from, count, v) => { for (let i = 0; i < count; i++) setWord(blob, from + 2 * i, v); };
    // Hidden parameters, as found in every factory pattern.
    setWord(blob, 19, 0x7fff);
    fillWords(27, 4, 0xffff);
    setWord(blob, 77, 0x17ff); // user chord length 3
    fillWords(79, 16, 0x3fff); // user chord offsets, 0
    setWord(blob, 81, 0x4203); // +4
    setWord(blob, 83, 0x4386); // +7
    fillWords(133, 12, 0x7fff);
    fillWords(157, 9, 0x3fff);
    const pattern = { blob, params, bias: CHECKSUM_BIAS };
    for (const def of PARAMS) setWord(blob, def.offset, normWord(def, rawOf(pattern, def)));
    for (let s = 0; s < STEP_COUNT; s++) writeStep(blob, s, []);
    updateChecksum(pattern);
    return blob;
  }

  // ---- file container ------------------------------------------------------

  const patternKey = (bank, number) => bank + '_' + number;

  function parse(input) {
    const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
    const text = latin1(bytes);
    const headEnd = text.indexOf('"BINARY_FILE_SECTION"');
    if (headEnd === -1) throw new Error('Not a KeyStep mk2 project: no BINARY_FILE_SECTION.');
    const head = text.slice(0, headEnd);
    const file = {
      bytes,
      headEnd,
      device: (head.match(/"device":\s*"([^"]*)"/) || [])[1] || '',
      version: (head.match(/"version":\s*"([^"]*)"/) || [])[1] || '',
      blobs: [],
      patterns: new Map(),
    };
    const slot = (bank, number) => {
      const key = patternKey(bank, number);
      if (!file.patterns.has(key)) {
        file.patterns.set(key, { bank, number, params: {}, blob: new Uint8Array(BLOB_SIZE).fill(0xff), bias: CHECKSUM_BIAS });
      }
      return file.patterns.get(key);
    };

    const paramRe = /"(\d+)_(\d+)_(\d+)":\s*(-?\d+)/g;
    for (let m; (m = paramRe.exec(head)); ) slot(+m[1], +m[2]).params[+m[3]] = +m[4];

    // Blobs are raw, unescaped and exactly 4096 bytes, so they are read by length, not to the next quote.
    const blobRe = /"BINARY_FILE_(\d+)_(\d+)_49152":\s*"/g;
    blobRe.lastIndex = headEnd;
    for (let m; (m = blobRe.exec(text)); ) {
      const start = m.index + m[0].length;
      if (bytes[start + BLOB_SIZE] !== 0x22) throw new Error(`Pattern ${m[1]}-${m[2]}: blob is not ${BLOB_SIZE} bytes.`);
      const pattern = slot(+m[1], +m[2]);
      pattern.blob = bytes.slice(start, start + BLOB_SIZE);
      pattern.checksumOk = true;
      if (!isEmpty(pattern.blob)) {
        pattern.bias = storedChecksum(pattern.blob) ^ xorSum(pattern.blob);
        pattern.checksumOk = pattern.bias === CHECKSUM_BIAS;
      }
      file.blobs.push({ key: patternKey(+m[1], +m[2]), start });
      blobRe.lastIndex = start + BLOB_SIZE;
    }
    if (!file.blobs.length) throw new Error('No pattern data found in file.');
    return file;
  }

  /** Byte-identical to the input when nothing was edited. */
  function serialize(file) {
    const head = latin1(file.bytes, 0, file.headEnd).replace(
      /"(\d+)_(\d+)_(\d+)":(\s*)(-?\d+)/g,
      (all, bank, number, id, space) => {
        const pattern = file.patterns.get(patternKey(bank, number));
        const v = pattern && pattern.params[id];
        return v === undefined ? all : `"${bank}_${number}_${id}":${space}${v}`;
      },
    );
    const shift = head.length - file.headEnd;
    const out = new Uint8Array(file.bytes.length + shift);
    out.set(bytesOf(head), 0);
    out.set(file.bytes.subarray(file.headEnd), head.length);
    for (const b of file.blobs) out.set(file.patterns.get(b.key).blob, b.start + shift);
    return out;
  }

  return {
    NOTE_NAMES, PARAMS, PARAM_BY_ID, PARAM_BY_KEY,
    BLOB_SIZE, STEP_COUNT, SLOT_COUNT, RECORD_SIZE, STEPS_OFFSET, STEPS_END, CHECKSUM_OFFSET, DATA_END,
    CHECKSUM_BIAS, MAX_NOTE_LENGTH,
    noteName, word, patternKey,
    getParam, setParam, formatParam, normWord,
    isEmpty, xorSum, storedChecksum, updateChecksum, readSteps, writeStep, initBlob,
    parse, serialize,
  };
});
