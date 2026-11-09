"""Offline tests for the parsing and validation logic. Run: python3 tests/test_server.py"""
import io
import json
import sys
import unittest
import zipfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import server  # noqa: E402


def sb3(blocks, **target):
    return json.dumps({"targets": [dict(name="Cat", isStage=False, blocks=blocks, costumes=[], sounds=[], **target)], "meta": {"semver": "3.0.0"}}).encode()


class Formats(unittest.TestCase):
    def test_scratch1_binary_is_flagged_not_parsed(self):
        out = server.compact_project(b"ScratchV02\x00\x00binary")
        self.assertEqual(out["format"], "sb1")
        self.assertEqual(out["blockCount"], 0)

    def test_sb3_renders_a_readable_script_with_nesting(self):
        blocks = {
            "a": {"opcode": "event_whenflagclicked", "next": "b", "parent": None, "inputs": {}, "fields": {}, "topLevel": True},
            "b": {"opcode": "control_repeat", "next": None, "parent": "a", "inputs": {"TIMES": [1, [6, "10"]], "SUBSTACK": [2, "c"]}, "fields": {}, "topLevel": False},
            "c": {"opcode": "motion_movesteps", "next": None, "parent": "b", "inputs": {"STEPS": [3, "d", [4, "1"]]}, "fields": {}, "topLevel": False},
            "d": {"opcode": "operator_add", "next": None, "parent": "c", "inputs": {"NUM1": [1, [4, "2"]], "NUM2": [3, [12, "score", "id"], [4, "0"]]}, "fields": {}, "topLevel": False},
        }
        out = server.compact_project(sb3(blocks))
        rows = out["sprites"][0]["scripts"][0]["rows"]
        self.assertEqual([r["t"] for r in rows], ["when green flag clicked", "repeat (10)", "move ((2) + (score)) steps"])
        self.assertEqual([r["d"] for r in rows], [0, 0, 1])
        self.assertEqual(rows[0]["k"], "hat")
        self.assertEqual(out["blockTotals"]["operator"], 1)
        self.assertEqual(out["blockCount"], 4)

    def test_sb3_custom_blocks_and_menus(self):
        blocks = {
            "a": {"opcode": "procedures_definition", "next": "m", "inputs": {"custom_block": [1, "p"]}, "fields": {}, "topLevel": True},
            "p": {"opcode": "procedures_prototype", "shadow": True, "inputs": {}, "fields": {}, "mutation": {"proccode": "jump %s high"}, "topLevel": False},
            "m": {"opcode": "motion_goto", "next": "q", "inputs": {"TO": [1, "menu"]}, "fields": {}, "topLevel": False},
            "menu": {"opcode": "motion_goto_menu", "shadow": True, "inputs": {}, "fields": {"TO": ["_mouse_", None]}, "topLevel": False},
            "q": {"opcode": "procedures_call", "next": None, "inputs": {"id1": [1, [10, "9"]]}, "fields": {}, "mutation": {"proccode": "jump %s high", "argumentids": '["id1"]'}, "topLevel": False},
        }
        rows = server.compact_project(sb3(blocks))["sprites"][0]["scripts"][0]["rows"]
        self.assertEqual([r["t"] for r in rows], ["define jump %s high".replace("%s", "( )"), "go to [_mouse_]", "jump (9) high"])

    def test_cycles_cannot_hang_the_parser(self):
        blocks = {"a": {"opcode": "event_whenflagclicked", "next": "b", "inputs": {}, "fields": {}, "topLevel": True},
                  "b": {"opcode": "looks_show", "next": "a", "inputs": {}, "fields": {}, "topLevel": False}}
        rows = server.compact_project(sb3(blocks))["sprites"][0]["scripts"][0]["rows"]
        self.assertEqual(len(rows), 2)

    def test_sb2_uses_friendly_wording_nesting_and_else(self):
        data = {"objName": "Stage", "children": [{"objName": "Cat", "costumes": [{"baseLayerMD5": "abc.png", "costumeName": "c"}],
                "sounds": [{"md5": "s.wav", "soundName": "m", "format": "adpcm", "sampleCount": 22050, "rate": 22050}],
                "scripts": [[0, 0, [["whenGreenFlag"], ["doIfElse", [">", ["readVariable", "x"], 3], [["say:", "hi"]], [["hide"]]], ["wait:elapsed:from:", 1]]]]}]}
        out = server.compact_project(json.dumps(data).encode())
        self.assertEqual(out["format"], "sb2")
        cat = out["sprites"][1]
        rows = cat["scripts"][0]["rows"]
        self.assertEqual([r["t"] for r in rows], ["when green flag clicked", "if (((x)) > (3)) then", "say (hi)", "else", "hide", "wait (1) seconds"])
        self.assertEqual([r["d"] for r in rows], [0, 0, 1, 0, 1, 0])
        self.assertTrue(cat["sounds"][0]["adpcm"])
        self.assertEqual(cat["costumes"][0]["md5"], "abc.png")

    def test_zipped_project_is_unpacked(self):
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w") as z:
            z.writestr("project.json", sb3({"a": {"opcode": "looks_hide", "next": None, "inputs": {}, "fields": {}, "topLevel": True}}))
        self.assertEqual(server.compact_project(buf.getvalue())["format"], "sb3")

    def test_output_is_capped(self):
        blocks = {}
        for s in range(100):
            blocks["t%d" % s] = {"opcode": "event_whenflagclicked", "next": None, "inputs": {}, "fields": {}, "topLevel": True}
        out = server.compact_project(sb3(blocks))
        self.assertEqual(out["scriptCount"], 100)
        self.assertEqual(len(out["sprites"][0]["scripts"]), server.MAX_SCRIPTS)


class Validation(unittest.TestCase):
    def test_usernames(self):
        for ok in ("jay", "griff_patch-2"):
            self.assertTrue(server.USERNAME_RE.match(ok))
        for bad in ("", "a/b", "../etc", "a b", "x" * 41, "a?b=1", "a\nb"):
            self.assertIsNone(server.USERNAME_RE.fullmatch(bad), bad)

    def test_ids(self):
        self.assertTrue(server.ID_RE.match("118"))
        for bad in ("abc", "1/2", "-1", "1" * 13):
            self.assertIsNone(server.ID_RE.fullmatch(bad), bad)

    def test_user_payload_leaves_out_personal_text(self):
        original = server.fetch_json
        def fake(path):
            if path == "/users/kid":
                return {"id": 1, "username": "kid", "history": {"joined": "2020"}, "profile": {"bio": "SECRET-BIO", "status": "SECRET-STATUS", "country": "SECRET-COUNTRY"}}
            return []
        server.fetch_json = fake
        try:
            body = server.load_user("kid").decode()
        finally:
            server.fetch_json = original
        self.assertNotIn("SECRET", body)


class Limits(unittest.TestCase):
    def test_rate_limiter(self):
        r = server.RateLimiter(per_minute=2)
        self.assertTrue(r.allow("a")); self.assertTrue(r.allow("a")); self.assertFalse(r.allow("a"))
        self.assertTrue(r.allow("b"))


if __name__ == "__main__":
    unittest.main()
