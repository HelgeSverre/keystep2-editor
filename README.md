# KeyStep mk2 project decoder and editor

Reads and edits `.keystep2` project files exported by Arturia MIDI Control Center (MCC).

| Path | Purpose |
|------|---------|
| `index.html` | The editor: piano roll, velocity lane, settings, raw-byte inspector |
| `keystep2.js` | Codec (parse, edit, serialize). Reference implementation of the format |
| `tests/` | Codec tests against `export.keystep2` |
| `tools/` | Optional read-only command-line decoder in Python. See [`tools/README.md`](tools/README.md) |

## Usage

Open `index.html` in a browser, then open or drop a `.keystep2` file. Nothing is installed and
nothing leaves the machine. Served over HTTP from this folder, it loads `export.keystep2` on start.

```bash
node --test        # codec tests
```

### Editor

| Action | How |
|--------|-----|
| Add a note | Click an empty cell |
| Move | Drag the note, or arrow keys (Shift+Up/Down = octave) |
| Change length | Drag the note's right edge, or Shift+Left/Right |
| Delete | Double-click, right-click, or Delete |
| Velocity | Drag in the lane under the grid (selected note, else the whole step) |
| Pattern length | Drag the marker in the ruler |
| Scroll pitch | Mouse wheel over the grid |
| Play / stop | Space |
| Undo / redo | Cmd/Ctrl+Z, Shift+Cmd/Ctrl+Z |
| Save | "Save a copy…" or Cmd/Ctrl+S. The opened file is never overwritten |

Clicking the grid of an empty slot creates a pattern there.

## Status

- Verified against one export (firmware file version 1.0.2, 16 factory patterns): an unedited file
  serializes byte-identical, and the checksum and header rules below hold for all 16 patterns.
- **Not verified:** importing an edited file into MCC or the device. Keep the original export.

## File format

### Container

A JSON-like text file with raw binary inside string values. It is not valid JSON or UTF-8.

- `"device"`, `"version"`.
- `"B_P_ID": value`: parameter `ID` of pattern `P` (1-16) in bank `B` (1-4).
- `"BINARY_FILE_SECTION"`: marker. Everything after it is binary.
- `"BINARY_FILE_B_P_49152": "<4096 raw bytes>"`: one blob per pattern.

Blobs are unescaped and always 4096 bytes (128 blocks of 32). A blob MUST be read by length: it can
contain `"` (0x22, for example velocity 34) and bytes above 0x7F.

### Parameters

Range parameters are stored as `value - minimum`. List parameters store the index.

| ID | Name | Real range | Stored |
|----|------|-----------|--------|
| 8192 | Chord preset | User, Oct, 5th, Maj, min, sus2, sus4, Maj7, min7, Maj9, min9, Maj11, min11 | index |
| 8193 | Strum (ms) | 0-500 | 0-500 |
| 8194 | Strum sync | Off, 1/64 … 1/4 | index |
| 8195 | Strum type | Up, Alt Up, Down, Alt Down, Random | index |
| 8196 | Voicing | Off, On, Bass -1, Bass -2, Bass -3 | index |
| 8197 | Spread | No, Velocity, Aftertouch, 1-16 | index |
| 16384 | Scale | Off, Global, Major … Freygish, User | index |
| 16385 | Root | C-B | index |
| 24576 | Time division | 1/2D … 1/32T | index |
| 24577 | Length | 1-64 steps | 0-63 |
| 24578 | Gate | 10-90 % | 0-80 |
| 24579 | Swing | 50-75 % | 0-25 |
| 24580 | Tempo | 30.0-240.0 BPM | 0-2100 (tenths above 30.0) |
| 24581 | Spice | 0-100 % | 0-100 |
| 24586-24588 | Bank MSB, Bank LSB, Program change | 0 = off, 1-128 | 0-128 |

### Pattern blob

An unused slot is 4096 bytes of 0xFF.

| Offset | Size | Content |
|--------|------|---------|
| 0 | 1 | 0x00 |
| 1 | 64 | Parameter group 0x6000 (IDs 24576+), 32 little-endian words |
| 65 | 64 | Parameter group 0x2000 (IDs 8192+) |
| 129 | 64 | Parameter group 0x4000 (IDs 16384+) |
| 193 | 2304 | 64 step records of 36 bytes |
| 2497 | 1024 | Zero in every sample. Purpose unknown |
| 3521 | 4 | Checksum, little-endian, upper two bytes zero |
| 3525 | 571 | 0xFF padding |

**Header words.** The word for parameter `ID` is at `group offset + 2 × (ID & 0xFFF)` and holds
`stored value ÷ (max − min) × 32767`, rounded to nearest with halves down (gate 40/80 → 0x3FFF).
The header repeats the text parameters; a writer MUST keep both in step. The groups also hold
hidden parameters (user chord, user scale) at fixed values in every sample.

**Step record (36 bytes).**

| Offset | Size | Content |
|--------|------|---------|
| 0 | 8 | Note slots: MIDI pitch, 0x80 = empty. Filled from slot 0, lowest pitch first |
| 8 | 8 | Velocity per slot, 100 when empty |
| 16 | 8 | Length per slot in half-steps: 1 = half a step, 2 = one step, 4 = two steps. 1 when empty |
| 24 | 8 | Zero in every sample. Purpose unknown |
| 32 | 4 | Byte 34 = 1 when the step has notes; the rest zero |

All 64 records are stored whatever the pattern length; steps past the length keep their notes.

**Checksum.** XOR of the 96 header words, XOR of every step byte (193-2496), XOR 0x3FFF. The
constant is inferred: it fits all 16 samples but its origin is unknown.

## Sources

- Parameter definitions: `/Library/Arturia/MIDI Control Center/Resources/KeyStep2.json`
- Binary layout: inferred from `export.keystep2`
