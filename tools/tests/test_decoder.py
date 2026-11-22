"""Run from tools/: uv run python -m unittest discover tests"""

import contextlib
import io
import json
import sys
import unittest
from pathlib import Path

TOOLS = Path(__file__).resolve().parent.parent
EXPORT = TOOLS.parent / "export.keystep2"
sys.path.insert(0, str(TOOLS))

import decoder as ks


class DecoderTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.project = ks.decode_file(EXPORT)

    def test_slots(self):
        self.assertEqual(len(self.project.patterns), 64)
        self.assertEqual(len(self.project.active_patterns), 16)

    def test_settings_are_real_world_values(self):
        s = self.project.pattern(1, 16).settings
        self.assertEqual((s["tempo"], s["length"], s["gate"], s["swing"], s["division"]), (120.0, 64, 50, 50, "1/16"))
        self.assertEqual(self.project.pattern(1, 1).settings["length"], 15)
        self.assertEqual(self.project.pattern(1, 15).settings["gate"], 10)

    def test_steps(self):
        steps = self.project.pattern(1, 9).steps
        self.assertEqual(len(steps), 64)
        self.assertEqual([ks.note_name(n.pitch) for n in steps[0]], ["A2", "A3", "C4"])
        self.assertEqual([n.velocity for n in steps[0]], [113, 104, 119])
        self.assertEqual(steps[1], [])
        self.assertEqual([n.length for n in self.project.pattern(1, 12).steps[0]], [24] * 5)

    def test_checksum_and_header(self):
        for p in self.project.active_patterns:
            self.assertTrue(p.checksum_ok, (p.bank, p.number))
            for param in ks.PARAMS:
                word = int.from_bytes(p.blob[param.offset : param.offset + 2], "little")
                self.assertEqual(word, param.header_word(p.raw_params[param.id]), (p.bank, p.number, param.key))


class CliTest(unittest.TestCase):
    def run_cli(self, argv):
        out = io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(io.StringIO()):
            status = ks.main(argv)
        return status, out.getvalue()

    def test_text_commands(self):
        for argv, expected in (
            (["list", str(EXPORT)], "16 of 64"),
            (["show", str(EXPORT), "-b", "1", "-p", "9"], "A2"),
            (["verify", str(EXPORT)], "0 problem(s)"),
        ):
            status, text = self.run_cli(argv)
            self.assertEqual(status, 0, argv)
            self.assertIn(expected, text)

    def test_json_filter(self):
        _, text = self.run_cli(["json", str(EXPORT), "-b", "1", "-p", "2", "--compact"])
        data = json.loads(text)
        self.assertEqual(len(data["patterns"]), 1)
        self.assertEqual(data["patterns"][0]["settings"]["length"], 32)

    def test_bad_file(self):
        self.assertEqual(self.run_cli(["list", str(TOOLS / "pyproject.toml")])[0], 2)


if __name__ == "__main__":
    unittest.main()
