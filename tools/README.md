# Command-line decoder

`decoder.py` inspects `.keystep2` project files from the terminal. It is read-only and separate from
the editor: `index.html` does not use it. It is a second implementation of the format described in
[`../README.md`](../README.md), useful for dumps, scripting and cross-checking `keystep2.js`.

Standard library only, Python 3.10+. Run commands from this directory.

## Commands

```bash
uv run python decoder.py <command> <file> [options]
```

| Command | Output |
|---------|--------|
| `list` | One line per pattern: length, note count, tempo, division, gate, swing, scale |
| `show` | Each step's notes with velocity and length in steps |
| `json` | Decoded patterns as JSON |
| `verify` | Checksum and header-word check per pattern |

Options shared by every command:

| Option | Effect |
|--------|--------|
| `-b`, `--bank 1-4` | Only this bank |
| `-p`, `--pattern 1-16` | Only this pattern |

Per-command options:

| Command | Option | Effect |
|---------|--------|--------|
| `list`, `json` | `-a`, `--all` | Include empty slots |
| `show` | `-a`, `--all` | Include rests and steps past the pattern length (marked `*`) |
| `json` | `-o`, `--output PATH` | Write to a file instead of stdout |
| `json` | `--compact` | No indentation |

## Examples

```bash
uv run python decoder.py list ../export.keystep2
uv run python decoder.py show ../export.keystep2 -b 1 -p 9
uv run python decoder.py json ../export.keystep2 -b 1 -o bank1.json
uv run python decoder.py verify ../export.keystep2
```

## Exit status

| Status | Meaning |
|--------|---------|
| 0 | Success |
| 1 | `verify` found a mismatch, or `show` matched no pattern with data |
| 2 | The file could not be read or is not a KeyStep mk2 project |

## Development

```bash
uv run python -m unittest discover tests
uv run ruff check . && uv run ruff format .
```
