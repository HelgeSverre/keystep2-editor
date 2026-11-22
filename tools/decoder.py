#!/usr/bin/env python3
"""Decoder for .keystep2 project files exported by Arturia MIDI Control Center.

The format is documented in ../README.md. ../keystep2.js is the reference
implementation (it also writes); this module reads only.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from dataclasses import dataclass, field
from pathlib import Path

NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]

BLOB_SIZE = 4096
STEP_COUNT = 64
SLOT_COUNT = 8
RECORD_SIZE = 36
STEPS_OFFSET = 193
STEPS_END = STEPS_OFFSET + STEP_COUNT * RECORD_SIZE  # 2497
CHECKSUM_OFFSET = 3521
DATA_END = CHECKSUM_OFFSET + 4
EMPTY_NOTE = 0x80
CHECKSUM_BIAS = 0x3FFF

# Byte offset of the first header word of each parameter group (id & 0xF000).
GROUP_OFFSET = {0x6000: 1, 0x2000: 65, 0x4000: 129}


@dataclass(frozen=True)
class Param:
    """A pattern parameter. Files store `value - minimum`; lists store the index."""

    id: int
    key: str
    minimum: int = 0
    maximum: int = 0
    scale: float = 1
    values: tuple[str, ...] = ()

    @property
    def span(self) -> int:
        return len(self.values) - 1 if self.values else self.maximum - self.minimum

    @property
    def offset(self) -> int:
        return GROUP_OFFSET[self.id & 0xF000] + 2 * (self.id & 0xFFF)

    def decode(self, raw: int) -> int | float | str:
        if self.values:
            return self.values[raw] if 0 <= raw < len(self.values) else str(raw)
        value = raw + self.minimum
        return round(value * self.scale, 1) if self.scale != 1 else value

    def header_word(self, raw: int) -> int:
        """15-bit normalised form stored in the pattern header (half rounds down)."""
        return max(0, -((self.span - 2 * raw * 32767) // (2 * self.span)))


def _names(text: str) -> tuple[str, ...]:
    return tuple(text.split())


PARAMS = [
    Param(24580, "tempo", 300, 2400, scale=0.1),
    Param(24577, "length", 1, 64),
    Param(
        24576,
        "division",
        values=_names("1/2D 1/2 1/4D 1/2T 1/4 1/8D 1/4T 1/8 1/16D 1/8T 1/16 1/32D 1/16T 1/32 1/32T"),
    ),
    Param(24578, "gate", 10, 90),
    Param(24579, "swing", 50, 75),
    Param(24581, "spice", 0, 100),
    Param(
        16384,
        "scale",
        values=(
            "Off",
            "Global",
            "Major",
            "Minor",
            "Dorian",
            "Phrygian",
            "Lydian",
            "Mixolydian",
            "Locrian",
            "Harmonic Minor",
            "Blues",
            "Pentatonic Major",
            "Pentatonic Minor",
            "Japanese",
            "Gypsy",
            "Arabic",
            "Freygish",
            "User",
        ),
    ),
    Param(16385, "root", values=tuple(NOTE_NAMES)),
    Param(
        8192,
        "chord",
        values=_names("User Oct 5th Maj min sus2 sus4 Maj7 min7 Maj9 min9 Maj11 min11"),
    ),
    Param(
        8197,
        "spread",
        values=("No", "Velocity", "Aftertouch", *(str(i) for i in range(1, 17))),
    ),
    Param(8193, "strum_ms", 0, 500),
    Param(
        8194,
        "strum_sync",
        values=_names("Off 1/64 1/32T 1/64D 1/32 1/16T 1/32D 1/16 1/8T 1/16D 1/8 1/4T 1/8D 1/4"),
    ),
    Param(8195, "strum_type", values=("Up", "Alt Up", "Down", "Alt Down", "Random")),
    Param(8196, "voicing", values=("Off", "On", "Bass -1", "Bass -2", "Bass -3")),
    Param(24586, "bank_msb", 0, 128),
    Param(24587, "bank_lsb", 0, 128),
    Param(24588, "program_change", 0, 128),
]
# Raw values MCC writes for a fresh pattern.
DEFAULT_RAW = {24580: 900, 24577: 15, 24576: 10, 24578: 40, 16384: 1}


def note_name(note: int) -> str:
    return f"{NOTE_NAMES[note % 12]}{note // 12 - 1}"


@dataclass
class Note:
    pitch: int
    velocity: int
    length: int  # half-steps: 2 = one step, 4 = held over the next step
    unknown: int = 0

    def to_dict(self) -> dict:
        return {
            "midi": self.pitch,
            "name": note_name(self.pitch),
            "velocity": self.velocity,
            "length_steps": self.length / 2,
        }


@dataclass
class Pattern:
    bank: int
    number: int
    raw_params: dict[int, int] = field(default_factory=dict)
    blob: bytes = b"\xff" * BLOB_SIZE

    @property
    def is_empty(self) -> bool:
        return self.blob[:DATA_END] == b"\xff" * DATA_END

    @property
    def settings(self) -> dict:
        return {p.key: p.decode(self.raw_params.get(p.id, DEFAULT_RAW.get(p.id, 0))) for p in PARAMS}

    @property
    def steps(self) -> list[list[Note]]:
        """All 64 steps; steps at or beyond `length` hold data but do not play."""
        if self.is_empty:
            return [[] for _ in range(STEP_COUNT)]
        steps = []
        for index in range(STEP_COUNT):
            o = STEPS_OFFSET + index * RECORD_SIZE
            steps.append(
                [
                    Note(self.blob[o + i], self.blob[o + 8 + i], self.blob[o + 16 + i], self.blob[o + 24 + i])
                    for i in range(SLOT_COUNT)
                    if self.blob[o + i] < EMPTY_NOTE
                ]
            )
        return steps

    @property
    def stored_checksum(self) -> int:
        return int.from_bytes(self.blob[CHECKSUM_OFFSET : CHECKSUM_OFFSET + 2], "little")

    @property
    def computed_checksum(self) -> int:
        x = CHECKSUM_BIAS
        for o in range(1, STEPS_OFFSET, 2):
            x ^= self.blob[o] | self.blob[o + 1] << 8
        for o in range(STEPS_OFFSET, STEPS_END):
            x ^= self.blob[o]
        return x

    @property
    def checksum_ok(self) -> bool:
        return self.is_empty or self.stored_checksum == self.computed_checksum

    def to_dict(self) -> dict:
        return {
            "bank": self.bank,
            "pattern": self.number,
            "is_empty": self.is_empty,
            "checksum_ok": self.checksum_ok,
            "settings": self.settings,
            "steps": [[n.to_dict() for n in notes] for notes in self.steps],
        }


@dataclass
class Project:
    device: str = ""
    version: str = ""
    patterns: dict[tuple[int, int], Pattern] = field(default_factory=dict)

    def pattern(self, bank: int, number: int) -> Pattern:
        return self.patterns.setdefault((bank, number), Pattern(bank, number))

    @property
    def active_patterns(self) -> list[Pattern]:
        return [p for _, p in sorted(self.patterns.items()) if not p.is_empty]

    def to_dict(self) -> dict:
        return {
            "device": self.device,
            "version": self.version,
            "patterns": [p.to_dict() for _, p in sorted(self.patterns.items())],
        }


def decode(content: bytes) -> Project:
    head_end = content.find(b'"BINARY_FILE_SECTION"')
    if head_end == -1:
        raise ValueError("Not a KeyStep mk2 project: no BINARY_FILE_SECTION")
    head = content[:head_end].decode("latin-1")
    project = Project()
    if m := re.search(r'"device":\s*"([^"]*)"', head):
        project.device = m.group(1)
    if m := re.search(r'"version":\s*"([^"]*)"', head):
        project.version = m.group(1)
    for bank, number, param_id, value in re.findall(r'"(\d+)_(\d+)_(\d+)":\s*(-?\d+)', head):
        project.pattern(int(bank), int(number)).raw_params[int(param_id)] = int(value)

    # Blobs are raw, unescaped and exactly 4096 bytes: read by length, never to the next quote.
    key = re.compile(rb'"BINARY_FILE_(\d+)_(\d+)_49152":\s*"')
    pos = head_end
    while m := key.search(content, pos):
        start = m.end()
        if content[start + BLOB_SIZE : start + BLOB_SIZE + 1] != b'"':
            raise ValueError(f"Pattern {m.group(1).decode()}-{m.group(2).decode()}: blob is not {BLOB_SIZE} bytes")
        project.pattern(int(m.group(1)), int(m.group(2))).blob = content[start : start + BLOB_SIZE]
        pos = start + BLOB_SIZE
    return project


def decode_file(path: str | Path) -> Project:
    return decode(Path(path).read_bytes())


def select(project: Project, bank: int | None, number: int | None, include_empty: bool) -> list[Pattern]:
    """Patterns matching the --bank/--pattern filters, in bank and pattern order."""
    return [
        p
        for (b, n), p in sorted(project.patterns.items())
        if (bank is None or b == bank) and (number is None or n == number) and (include_empty or not p.is_empty)
    ]


def cmd_list(project: Project, args: argparse.Namespace) -> int:
    patterns = select(project, args.bank, args.pattern, args.all)
    in_use = len(project.active_patterns)
    print(f"{project.device} v{project.version}: {in_use} of {len(project.patterns)} pattern slots in use")
    print(f"{'bank':>4} {'pat':>3} {'steps':>5} {'notes':>5} {'tempo':>6} {'div':>6} {'gate':>4} {'swing':>5}  scale")
    for p in patterns:
        if p.is_empty:
            print(f"{p.bank:>4} {p.number:>3}  empty")
            continue
        s = p.settings
        notes = sum(len(step) for step in p.steps[: s["length"]])
        print(
            f"{p.bank:>4} {p.number:>3} {s['length']:>5} {notes:>5} {s['tempo']:>6} {s['division']:>6} "
            f"{s['gate']:>3}% {s['swing']:>4}%  {s['scale']} ({s['root']})"
        )
    return 0


def cmd_show(project: Project, args: argparse.Namespace) -> int:
    patterns = select(project, args.bank, args.pattern, include_empty=False)
    if not patterns:
        print("No matching patterns with data.")
        return 1
    for p in patterns:
        s = p.settings
        print(f"\nBank {p.bank}, pattern {p.number}")
        print(
            f"  {s['tempo']} BPM, {s['length']} steps of {s['division']}, gate {s['gate']}%, "
            f"swing {s['swing']}%, spice {s['spice']}%, scale {s['scale']} ({s['root']})"
        )
        for index, notes in enumerate(p.steps):
            beyond = index >= s["length"]
            if (beyond or not notes) and not args.all:
                continue
            cells = "  ".join(f"{note_name(n.pitch):<4} v{n.velocity:<3} len {n.length / 2:g}" for n in notes)
            print(f"  {index + 1:>2}{'*' if beyond else ' '} {cells or '-'}")
    return 0


def cmd_json(project: Project, args: argparse.Namespace) -> int:
    patterns = select(project, args.bank, args.pattern, args.all)
    data = {"device": project.device, "version": project.version, "patterns": [p.to_dict() for p in patterns]}
    text = json.dumps(data, indent=None if args.compact else 2)
    if args.output:
        Path(args.output).write_text(text + "\n")
        print(f"Wrote {len(patterns)} pattern(s) to {args.output}")
    else:
        print(text)
    return 0


def cmd_verify(project: Project, args: argparse.Namespace) -> int:
    """Checks every pattern against the inferred checksum and header rules."""
    problems = 0
    patterns = select(project, args.bank, args.pattern, include_empty=False)
    for p in patterns:
        issues = []
        if not p.checksum_ok:
            issues.append(f"checksum stored {p.stored_checksum:#06x}, computed {p.computed_checksum:#06x}")
        for param in PARAMS:
            raw = p.raw_params.get(param.id, DEFAULT_RAW.get(param.id, 0))
            word = int.from_bytes(p.blob[param.offset : param.offset + 2], "little")
            if word != param.header_word(raw):
                issues.append(f"{param.key}: header {word:#06x}, text parameter implies {param.header_word(raw):#06x}")
        problems += len(issues)
        print(f"bank {p.bank} pattern {p.number:>2}: {'ok' if not issues else '; '.join(issues)}")
    print(f"{len(patterns)} pattern(s) checked, {problems} problem(s)")
    return 1 if problems else 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="decoder.py",
        description="Inspect Arturia KeyStep mk2 project files (.keystep2). Read-only.",
    )
    sub = parser.add_subparsers(dest="command", required=True, metavar="command")

    def add(name: str, func, help_text: str) -> argparse.ArgumentParser:
        p = sub.add_parser(name, help=help_text, description=help_text)
        p.add_argument("file", type=Path, help="path to a .keystep2 file")
        p.add_argument("-b", "--bank", type=int, choices=range(1, 5), metavar="1-4", help="only this bank")
        p.add_argument("-p", "--pattern", type=int, choices=range(1, 17), metavar="1-16", help="only this pattern")
        p.set_defaults(func=func)
        return p

    p = add("list", cmd_list, "One line per pattern: length, note count and settings.")
    p.add_argument("-a", "--all", action="store_true", help="include empty slots")
    p = add("show", cmd_show, "Notes of each step, with velocity and length in steps.")
    p.add_argument("-a", "--all", action="store_true", help="include rests and steps past the pattern length (*)")
    p = add("json", cmd_json, "Decoded patterns as JSON.")
    p.add_argument("-a", "--all", action="store_true", help="include empty slots")
    p.add_argument("-o", "--output", metavar="PATH", help="write to a file instead of stdout")
    p.add_argument("--compact", action="store_true", help="no indentation")
    add("verify", cmd_verify, "Check checksums and header words. Exit status 1 on any mismatch.")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        project = decode_file(args.file)
    except (OSError, ValueError) as error:
        print(f"decoder.py: {error}", file=sys.stderr)
        return 2
    return args.func(project, args)


if __name__ == "__main__":
    sys.exit(main())
