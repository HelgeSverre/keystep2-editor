/*
 * KeyStep mk2 pattern transfer over MIDI SysEx.
 * Loads as a classic script (global `KS2MIDI`) or a CommonJS module. The protocol is documented in
 * README.md; it was worked out from MIDI Control Center's traffic with firmware 1.0.2.
 *
 * A transport is { send(Uint8Array), onmessage } where onmessage receives each complete SysEx
 * message (F0 … F7) from the device.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.KS2MIDI = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const HEADER = [0xf0, 0x00, 0x20, 0x6b]; // SysEx start, Arturia manufacturer id
  // Text parameters in the order MIDI Control Center sends them when storing a pattern.
  const PARAM_ORDER = [16384, 16385, 24576, 24577, 24578, 24579, 24580, 24581, 24586, 24587, 24588, 8192, 8193, 8194, 8195, 8196, 8197];
  const BLOCK = 32, BLOCKS = 128;

  // Two-byte operation codes that follow the sequence byte in a request.
  const OP = {
    SELECT_PATTERN: 0x3e69,   // (pattern index)
    GET_PATTERN_PARAM: 0x6cd6, // (param id)            -> (param id, value)
    SET_PATTERN_PARAM: 0x7848, // (param id, value)
    READ_BLOCK: 0x08df,        // (pattern index)        -> (32 bytes), sequential from the last select
    OPEN_WRITE: 0x6e86,        // (pattern index)
    WRITE_BLOCK: 0x10ac,       // (32 bytes), sequential from the last open
    COMMIT_PATTERN: 0x1b5d,    // (pattern index)
    GET_GLOBAL_PARAM: 0x2a89,  // (param id)            -> (param id, value)
    SET_GLOBAL_PARAM: 0x36fb,  // (param id, value)
  };

  // ---- 7-bit packing: the byte stream is cut into 7-bit groups, least significant bit first ----

  function pack7(bytes) {
    const out = [];
    let acc = 0, n = 0;
    for (const b of bytes) {
      acc |= b << n; n += 8;
      while (n >= 7) { out.push(acc & 0x7f); acc >>>= 7; n -= 7; }
    }
    if (n) out.push(acc & 0x7f);
    return out;
  }

  function unpack7(groups) {
    const out = [];
    let acc = 0, n = 0;
    for (const g of groups) {
      acc |= (g & 0x7f) << n; n += 7;
      if (n >= 8) { out.push(acc & 0xff); acc >>>= 8; n -= 8; }
    }
    return Uint8Array.from(out); // leftover bits are padding
  }

  // ---- CBOR subset: unsigned integers and byte strings, shortest form ----

  function cbor(item) {
    if (typeof item === 'number') {
      if (item < 24) return [item];
      if (item < 0x100) return [0x18, item];
      return [0x19, item >> 8, item & 0xff];
    }
    const len = item.length;
    return [...(len < 24 ? [0x40 | len] : [0x58, len]), ...item];
  }

  function decodeCbor(bytes, pos = 0) {
    const items = [];
    while (pos < bytes.length) {
      const major = bytes[pos] >> 5, info = bytes[pos] & 0x1f;
      pos++;
      let value = info;
      if (info === 24) value = bytes[pos++];
      else if (info === 25) { value = (bytes[pos] << 8) | bytes[pos + 1]; pos += 2; }
      else if (info > 25) break;
      if (major === 0) items.push(value);
      else if (major === 2) { items.push(bytes.slice(pos, pos + value)); pos += value; }
      else break;
    }
    return items;
  }

  // ---- messages ----

  function encodeRequest(seq, op, items) {
    const bytes = [seq & 0x7f, op >> 8, op & 0xff];
    for (const item of items) bytes.push(...cbor(item));
    return Uint8Array.from([...HEADER, ...pack7(bytes), 0xf7]);
  }

  /** { seq, value: bool, bytes } for a message from the device, or null if it is not one. */
  function decodeMessage(data) {
    if (data.length < 6 || HEADER.some((b, i) => data[i] !== b) || data[data.length - 1] !== 0xf7) return null;
    const bytes = unpack7(data.subarray(4, data.length - 1));
    if (!bytes.length) return null;
    return { seq: bytes[0] & 0x7f, value: (bytes[0] & 0x80) !== 0, bytes: bytes.subarray(1) };
  }

  /** Pattern index on the wire: 0 for bank 1 pattern 1, up to 63 for bank 4 pattern 16. */
  const patternIndex = (bank, number) => (bank - 1) * 16 + (number - 1);

  /** 15-bit parameter value as MIDI Control Center sends it: value ÷ range × 32767, half rounds up. */
  const normalise = (raw, range) => Math.min(0x7fff, Math.floor(raw * 32767 / range + 0.5));

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  class Device {
    constructor(transport) {
      this.transport = transport;
      this.verify = null; // optional (blob) => boolean; a read that fails it is repeated once
      this.seq = 0;
      this.waiting = new Map();
      transport.onmessage = (data) => this.receive(data);
    }

    receive(data) {
      const m = decodeMessage(data);
      if (!m || !m.value) return; // plain acknowledgements carry nothing we need
      const pending = this.waiting.get(m.seq);
      if (!pending) return;
      this.waiting.delete(m.seq);
      clearTimeout(pending.timer);
      pending.resolve(decodeCbor(m.bytes));
    }

    send(op, items = []) {
      const seq = this.seq;
      this.seq = (this.seq + 1) & 0x7f;
      this.transport.send(encodeRequest(seq, op, items));
      return seq;
    }

    request(op, items, timeoutMs = 1000) {
      return new Promise((resolve, reject) => {
        const seq = this.send(op, items);
        const timer = setTimeout(() => {
          this.waiting.delete(seq);
          reject(new Error('The KeyStep did not answer. Check the connection and that no other app is transferring.'));
        }, timeoutMs);
        this.waiting.set(seq, { resolve, timer });
      });
    }

    /** True when a KeyStep mk2 answers a harmless parameter read. */
    async probe() {
      try {
        const reply = await this.request(OP.GET_GLOBAL_PARAM, [0x6000], 500);
        return reply[0] === 0x6000;
      } catch (e) {
        return false;
      }
    }

    async readBlock(index) {
      const [block] = await this.request(OP.READ_BLOCK, [index]);
      if (!(block instanceof Uint8Array) || (block.length !== BLOCK && block.length !== 0)) throw new Error('Unexpected reply to a block read.');
      return block;
    }

    /**
     * Reads one pattern's 4096-byte blob. `progress(blocksDone, blocksTotal, partialBlob)` is optional and
     * runs after every block; if it throws, the read stops with that error.
     *
     * The device has a single file reader. It hands out 128 blocks, then answers with empty blocks
     * until a different pattern is asked for; a select rewinds it to the selected pattern's start
     * without resetting the count. So: run the reader dry, wake it with one block of a neighbouring
     * pattern, select ours and read. That costs the last block, which is always 0xFF padding (pattern
     * data ends at byte 3525), so it is filled in.
     */
    async readPattern(bank, number, progress) {
      const index = patternIndex(bank, number), last = this.lastRead;
      this.lastRead = undefined; // unknown again until this read completes
      const good = (blob) => blob && (!this.verify || this.verify(blob));
      // Straight after a complete read of another pattern the reader is fresh and plain block reads
      // start this pattern from its beginning. No select: sent just before reading, its delayed
      // effect on the device made the reader skip every other block.
      let blob = last !== undefined && last !== index ? await this.readBlocks(index, progress) : null;
      for (let attempt = 0; !good(blob) && attempt < 2; attempt++) blob = await this.readCarefully(index, progress);
      if (!blob) throw new Error('The device sent an incomplete pattern.');
      if (!good(blob)) throw new Error('The pattern arrived damaged twice. Nothing was changed.');
      this.lastRead = index;
      return blob;
    }

    /** Works from any reader state: run it dry, wake it on a neighbour, rewind to ours with a select. */
    async readCarefully(index, progress) {
      for (let i = 0; (await this.readBlock(index)).length; i++) if (i > 2 * BLOCKS) throw new Error('The device keeps sending data.');
      await this.readBlock(index ^ 1);
      this.send(OP.SELECT_PATTERN, [index]);
      await sleep(250); // let the select settle before reading
      return this.readBlocks(index, progress);
    }

    /** Reads to the end of the reader's run. Null unless at least 127 of the 128 blocks arrive. */
    async readBlocks(index, progress) {
      const blob = new Uint8Array(BLOCK * BLOCKS).fill(0xff);
      let count = 0;
      for (; count < BLOCKS; count++) {
        const block = await this.readBlock(index);
        if (!block.length) break;
        blob.set(block, count * BLOCK);
        if (progress) progress(count + 1, BLOCKS, blob);
      }
      return count >= BLOCKS - 1 ? blob : null;
    }

    /**
     * Writes one pattern the way MIDI Control Center does: the blob, then every text parameter,
     * then a commit. `params` is [{ id, raw, range }].
     */
    async writePattern(bank, number, blob, params, progress) {
      if (blob.length !== BLOCK * BLOCKS) throw new Error('A pattern blob is 4096 bytes.');
      const index = patternIndex(bank, number);
      this.send(OP.OPEN_WRITE, [index]);
      await sleep(4);
      for (let i = 0; i < BLOCKS; i++) {
        this.send(OP.WRITE_BLOCK, [blob.subarray(i * BLOCK, (i + 1) * BLOCK)]);
        await sleep(5);
        if (progress) progress(i + 1, BLOCKS);
      }
      await sleep(20);
      this.send(OP.SELECT_PATTERN, [index]);
      await sleep(60);
      for (const p of params) {
        this.send(OP.SET_PATTERN_PARAM, [p.id, normalise(p.raw, p.range)]);
        await sleep(6);
      }
      this.send(OP.COMMIT_PATTERN, [index]);
      await sleep(80);
      this.lastRead = undefined;
    }
  }

  /** Splits a raw MIDI byte stream into complete SysEx messages; returns a feed(bytes) function. */
  function sysexAssembler(onmessage) {
    let buffer = null;
    return (bytes) => {
      for (const b of bytes) {
        if (b === 0xf0) buffer = [b];
        else if (buffer) {
          if (b === 0xf7) { buffer.push(b); onmessage(Uint8Array.from(buffer)); buffer = null; }
          else if (b < 0x80) buffer.push(b);
          else if (b < 0xf8) buffer = null; // a status byte ends an unfinished message; realtime bytes pass through
        }
      }
    };
  }

  /** Finds the KeyStep mk2 ports in a Web MIDI access object and wraps them as a transport. */
  function webMidiTransport(access) {
    const match = (port) => /keystep/i.test(port.name || '');
    const input = [...access.inputs.values()].find(match);
    const output = [...access.outputs.values()].find(match);
    if (!input || !output) return null;
    const transport = { name: output.name, send: (data) => output.send(data), onmessage: null };
    const feed = sysexAssembler((message) => transport.onmessage && transport.onmessage(message));
    input.onmidimessage = (e) => feed(e.data);
    return transport;
  }

  return { OP, PARAM_ORDER, BLOCK, BLOCKS, pack7, unpack7, cbor, decodeCbor, encodeRequest, decodeMessage, patternIndex, normalise, Device, sysexAssembler, webMidiTransport };
});
