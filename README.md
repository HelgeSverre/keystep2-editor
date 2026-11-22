# KeyStep mk2 pattern editor

[![Open the editor](https://img.shields.io/badge/open%20the%20editor-keystep2--editor.vercel.app-0580b8?style=flat-square)](https://keystep2-editor.vercel.app)

[![The editor showing a factory pattern in the piano roll](docs/screenshot.png)](https://keystep2-editor.vercel.app)

A browser editor for the sequencer patterns of the Arturia KeyStep mk2. It opens the `.keystep2`
project files that Arturia MIDI Control Center (MCC) exports, shows every pattern in a piano roll,
and saves an edited copy you can import again.

It also documents the file format, worked out from an export: see [File format](#file-format).

Unofficial. Not affiliated with or endorsed by Arturia; KeyStep is their trademark.

## What it does

- **All 64 slots:** four banks of 16 patterns, each with a note preview and its length.
- **Piano roll:** add, move, resize, copy and duplicate notes, alone or as a selection; up to 8
  notes per step and 64 steps per pattern, the same limits as the device.
- **Velocity lane** under the grid.
- **Pattern settings** in real units: tempo, length, time division, gate, swing, spice, scale,
  root, chord and strum settings, bank and program change.
- **Preview playback** with a playhead and lit keys.
- **Pan and zoom** on both axes.
- **Raw-byte inspector:** the step record, header words and checksum behind what you see.
- **Skins** matching the white hardware, a dark variant, and a neutral one.
- **Local only:** the file is read and written in the browser. Nothing is uploaded.

## Getting started

1. In MIDI Control Center, export your KeyStep mk2 project. This gives a `.keystep2` file.
2. Open [keystep2-editor.vercel.app](https://keystep2-editor.vercel.app) and drop the file on the
   window, or press Open.
3. Edit, then press "Save a copy…". The file you opened is never overwritten.
4. Import the copy in MIDI Control Center.

Keep your original export. See [Status](#status) for what has and has not been verified.

### Running it locally

There is no build step and no dependency. Clone the repository and open `index.html`, or serve the
folder with any static server; served over HTTP it loads the bundled `export.keystep2` (the 16
factory patterns) on start.

```bash
node --test        # codec tests
```

| Path | Purpose |
|------|---------|
| `index.html` | The editor |
| `keystep2.js` | Codec: parse, edit, serialize. Reference implementation of the format |
| `export.keystep2` | A factory project, used by the tests and as the demo file |
| `fonts/` | Inter and Barlow Semi Condensed (SIL Open Font License), used by the KeyStep skins |
| `tests/` | Codec tests against `export.keystep2` |
| `tools/` | Optional read-only command-line decoder in Python. See [`tools/README.md`](tools/README.md) |

## Using the editor

| Action | How |
|--------|-----|
| Add a note | Click an empty cell |
| Select | Click a note. Shift+click adds or removes one. Shift+drag from an empty cell draws a selection box. Cmd/Ctrl+A selects all, Esc clears |
| Move | Drag a selected note (the whole selection moves), or arrow keys (Shift+Up/Down = octave) |
| Copy | Alt+drag: the originals stay and the copies travel |
| Duplicate | Cmd/Ctrl+D (also Cmd/Ctrl+B, or D): the selection repeats right after itself |
| Change length | Drag a note's right edge, or Shift+Left/Right. The grip reaches a few pixels past the end of short notes |
| Delete | Double-click, right-click, or Delete |
| Velocity | Drag in the lane under the grid (selected notes in that step, else the whole step) |
| Pattern length | Drag the marker in the ruler |
| Double pattern | Button under the pattern settings: repeats steps 1 to N as N+1 to 2N and doubles the length |
| Pan | Scroll (two fingers on a trackpad pan both ways; Shift+wheel pans time), or drag with the middle button |
| Zoom time | Cmd/Ctrl+scroll or pinch, about the pointer |
| Zoom keys | Alt+scroll, about the pointer |
| Fit | F, or the Fit button |
| Hear a key | Click or drag on the keyboard strip |
| Play / stop | Space |
| Undo / redo | Cmd/Ctrl+Z, Shift+Cmd/Ctrl+Z |
| Save | "Save a copy…" or Cmd/Ctrl+S. The opened file is never overwritten |

Clicking the grid of an empty slot creates a pattern there.

## Skins

The selector at the right of the toolbar switches skin; the choice is remembered in the browser.

| Skin | Look |
|------|------|
| KeyStep (default) | The white hardware: matte white panel, blue Shift-button accent, black keys, OLED-style file readout |
| KeyStep Dark | The same blue on a black body |
| Classic | The original neutral look; follows the system light or dark setting |

A skin is one block of CSS custom properties on `:root[data-skin="…"]` at the top of `index.html`;
the comment above the blocks lists every token. The piano roll reads the same tokens when it draws.
To add a skin, copy a block, change the values and add an `<option>` to `#skinSelect`.

The KeyStep colours are sampled from Arturia's product photos. This is an unofficial tool: no
Arturia logo or licensed typeface is used.

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
