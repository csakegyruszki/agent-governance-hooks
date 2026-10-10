"""Tests for tools/project_init.py. Run: python -m unittest tests/test_project_init.py

Synthetic cases (labelled): every project folder is created under a temp directory; the shipped
templates/project-skeleton/ files are the real templates. Detection rules come from a config file
the test writes, with patterns anchored on the temp directory.
"""
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from datetime import date
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
SCRIPT = REPO / "tools" / "project_init.py"
sys.path.insert(0, str(REPO / "tools"))
import project_init as pi  # noqa: E402


def cli(*args, env=None):
    e = dict(os.environ)
    e.pop("GUARDRAIL_DOC_MEMORY_FILE", None)
    e.pop("GUARDRAIL_DOC_LOG_FILE", None)
    e.pop("GUARDRAIL_PROJECT_TYPES_FILE", None)
    e.update(env or {})
    r = subprocess.run([sys.executable, str(SCRIPT), *args], capture_output=True, text=True, encoding="utf-8", env=e)
    return r.returncode, (json.loads(r.stdout) if r.stdout.strip() else None)


class T(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="project-init-test-"))
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.work = self.tmp / "work"
        self.cfg = self.tmp / "types.json"
        w = str(self.work).replace("\\", "/")
        self.cfg.write_text(json.dumps({
            "types": {"paper": {"files": {"outline.md": "README.code.md"}, "dirs": ["sources", "figures"]}},
            "detect": [
                {"type": "case", "glob": w + "/cases/*/*"},
                {"type": "research", "glob": w + "/research/*"},
                {"type": "project", "glob": w + "/projects/*"},
                {"type": "code", "glob": w + "/code/*"},
                {"type": "paper", "glob": w + "/papers/*"},
            ],
        }), encoding="utf-8")
        self.shapes = {
            "case": self.work / "cases/group-1/case-9",
            "research": self.work / "research/alpha",
            "project": self.work / "projects/beta",
            "code": self.work / "code/gamma",
        }

    def run_cli(self, *args, **kw):
        return cli(*args, "--config", str(self.cfg), **kw)

    def layout(self, p):
        return sorted(str(x.relative_to(p)).replace("\\", "/") for x in p.rglob("*"))

    def test_detect_type(self):
        config = pi.load_config(str(self.cfg))
        for t, p in self.shapes.items():
            self.assertEqual(pi.detect_type(str(p), config), t)
            self.assertEqual(pi.detect_type(str(p).replace("/", "\\").upper(), config), t)
        self.assertIsNone(pi.detect_type(str(self.work / "archive/foo"), config))
        self.assertIsNone(pi.detect_type(str(self.work / "cases/group-1"), config))  # only <a>, not <a>/<b>
        self.assertIsNone(pi.detect_type(str(self.work / "research/.cache/x"), config))  # '.'-folders are not projects

    def test_layouts_per_type(self):
        expect = {
            "case": [".claude", ".claude/settings.json", "EVIDENCE_MANIFEST.jsonl", "PROJECT_MEMORY.md", "_LOG.md", "sources"],
            "code": [".claude", ".claude/settings.json", "PROJECT_MEMORY.md", "README.md", "_LOG.md"],
            "research": [".claude", ".claude/settings.json", "PROJECT_MEMORY.md", "_LOG.md", "sources"],
            "project": [".claude", ".claude/settings.json", "PROJECT_MEMORY.md", "_LOG.md"],
        }
        for t, p in self.shapes.items():
            rc, res = self.run_cli(str(p))  # type detected from the path
            self.assertEqual(rc, 0)
            self.assertEqual((res["type"], res["type_source"]), (t, "path"))
            self.assertEqual(self.layout(p), sorted(expect[t]), t)
            self.assertFalse((p / "archive").exists(), "archive/ is created on first use only")
            if t == "case":
                self.assertEqual((p / "EVIDENCE_MANIFEST.jsonl").stat().st_size, 0)

    def test_content(self):
        p = self.shapes["code"]
        self.run_cli(str(p))
        pm = (p / "PROJECT_MEMORY.md").read_text(encoding="utf-8")
        today = date.today().isoformat()
        self.assertIn("last_reviewed: " + today, pm)
        self.assertIn("status: active", pm)
        self.assertNotIn("{{", pm)
        heads = [l for l in pm.splitlines() if l.startswith("## ")]
        self.assertEqual(heads, ["## Goal", "## Current state", "## Next step", "## Decisions", "## Open items",
                                 "## Where the evidence is", "## Superseded/archived"])
        self.assertIn("# gamma", pm)
        self.assertIn(today, (p / "_LOG.md").read_text(encoding="utf-8"))
        json.loads((p / ".claude/settings.json").read_text(encoding="utf-8"))
        readme = (p / "README.md").read_text(encoding="utf-8")
        for h in ("# gamma", "## How to run", "## How to test"):
            self.assertIn(h, readme)

    def test_custom_type_from_config(self):
        p = self.work / "papers/p1"
        rc, res = self.run_cli(str(p))
        self.assertEqual((rc, res["type"]), (0, "paper"))
        self.assertEqual(self.layout(p), sorted([".claude", ".claude/settings.json", "PROJECT_MEMORY.md", "_LOG.md",
                                                 "figures", "outline.md", "sources"]))
        self.assertIn("# p1", (p / "outline.md").read_text(encoding="utf-8"))

    def test_configured_memory_and_log_file_names(self):
        p = self.shapes["project"]
        rc, res = self.run_cli(str(p), env={"GUARDRAIL_DOC_MEMORY_FILE": "STATE.md", "GUARDRAIL_DOC_LOG_FILE": "CHANGES.md"})
        self.assertEqual(rc, 0)
        self.assertEqual(self.layout(p), sorted([".claude", ".claude/settings.json", "CHANGES.md", "STATE.md"]))
        self.assertIn("last_reviewed", (p / "STATE.md").read_text(encoding="utf-8"))

    def test_idempotent_never_overwrites(self):
        p = self.shapes["case"]
        p.mkdir(parents=True)
        (p / "PROJECT_MEMORY.md").write_text("HAND WRITTEN", encoding="utf-8")
        (p / "sources").mkdir()
        rc, res = self.run_cli(str(p))
        # existing folder (has sources/): typed add-ons are NOT created - an empty ledger would look valid
        self.assertEqual(sorted(x.split(" ")[0] for x in res["skipped"]), ["EVIDENCE_MANIFEST.jsonl", "PROJECT_MEMORY.md", "sources"])
        self.assertEqual((p / "PROJECT_MEMORY.md").read_text(encoding="utf-8"), "HAND WRITTEN")
        self.assertEqual(sorted(res["created"]), [".claude/settings.json", "_LOG.md"])
        self.assertFalse((p / "EVIDENCE_MANIFEST.jsonl").exists())
        snap = {x: x.read_bytes() for x in p.rglob("*") if x.is_file()}
        rc, res2 = self.run_cli(str(p))
        self.assertEqual(res2["created"], [])
        self.assertEqual(len(res2["skipped"]), 5)
        self.assertEqual(snap, {x: x.read_bytes() for x in p.rglob("*") if x.is_file()})

    def test_dry_run_writes_nothing(self):
        p = self.work / "cases/x/y"
        rc, res = self.run_cli(str(p), "--dry-run")
        self.assertEqual((rc, res["dry_run"], res["type"]), (0, True, "case"))
        self.assertIn("EVIDENCE_MANIFEST.jsonl", res["created"])
        self.assertIn("sources/", res["created"])
        self.assertFalse(self.work.exists())

    def test_undetectable_and_unknown_type(self):
        p = self.tmp / "elsewhere"
        rc, res = self.run_cli(str(p))
        self.assertEqual(rc, 2)
        self.assertIn("error", res)
        self.assertFalse(p.exists())
        rc, res = self.run_cli(str(p), "--type", "nonsense")
        self.assertEqual(rc, 2)
        self.assertFalse(p.exists())
        rc, res = self.run_cli(str(p), "--type", "research")
        self.assertEqual((rc, res["type"], res["type_source"]), (0, "research", "arg"))
        self.assertTrue((p / "sources").is_dir())

    def test_no_config_needs_explicit_type(self):
        p = self.tmp / "plain"
        rc, res = cli(str(p))
        self.assertEqual(rc, 2)
        rc, res = cli(str(p), "--type", "code")
        self.assertEqual((rc, res["type"]), (0, "code"))

    def test_bad_config_is_an_error_not_a_guess(self):
        bad = self.tmp / "bad.json"
        bad.write_text(json.dumps({"detect": [{"type": "ghost", "glob": "x/*"}]}), encoding="utf-8")
        rc, res = cli(str(self.tmp / "q"), "--config", str(bad))
        self.assertEqual(rc, 2)
        self.assertIn("ghost", res["error"])
        self.assertFalse((self.tmp / "q").exists())

    def test_existing_dir_with_foreign_files_kept(self):
        p = self.shapes["project"]
        p.mkdir(parents=True)
        (p / "notes.md").write_text("keep", encoding="utf-8")
        self.run_cli(str(p))
        self.assertEqual((p / "notes.md").read_text(encoding="utf-8"), "keep")


if __name__ == "__main__":
    unittest.main(verbosity=1)
