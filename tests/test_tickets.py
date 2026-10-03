"""Tests for tools/tickets.py. Run: python -m unittest tests/test_tickets.py

Synthetic cases (labelled) use temp directories; the shipped examples/tickets files are used
where a realistic ticket is wanted. Check commands run with sys.executable so the tests do not
depend on anything but Python itself.
"""
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO / "tools"))
import tickets as T  # noqa: E402

EXAMPLES = REPO / "examples" / "tickets"
PY = f'"{sys.executable}"'


def write_ticket(tdir, tid, status="open", checks="", extra="", body="**Where we left off:** x\n"):
    tdir.mkdir(parents=True, exist_ok=True)
    c = f"checks: {checks}\n" if checks else ""
    (tdir / f"{tid}-t.md").write_text(
        f"---\nid: {tid}\ntitle: t\nworkspace: w\nstatus: {status}\ndate: 2026-10-01\n{c}{extra}---\n\n{body}",
        encoding="utf-8")


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="tickets-test-"))
        self.tdir = self.tmp / "tickets"
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self._env = dict(os.environ)
        os.environ.pop("GUARDRAIL_TICKETS_DIR", None)
        os.environ.pop("GUARDRAIL_TICKET_WORKSPACES", None)
        self.addCleanup(lambda: (os.environ.clear(), os.environ.update(self._env)))

    def cli(self, *args):
        return subprocess.run([sys.executable, str(REPO / "tools" / "tickets.py"), "--tickets-dir",
                               str(self.tdir), *args], capture_output=True, text=True, encoding="utf-8")

    def verdict(self, tid, checks, changed=None):
        return T.evidence_verdict(self.tdir, self.tmp, tid, checks, datetime.now(timezone.utc), changed)


class ParseTests(Base):
    def test_example_tickets_parse(self):
        for f in sorted(EXAMPLES.glob("T-*.md")):
            fm, body = T.parse_frontmatter(f.read_text(encoding="utf-8"))
            self.assertIsNotNone(fm, f.name)
            self.assertRegex(fm["id"], T.ID_RE)
            self.assertIn(fm["status"], T.STATUSES)
            self.assertIn("left off", body)

    def test_block_scalar_not_swallowed(self):  # synthetic
        fm, _ = T.parse_frontmatter("---\nid: T-0001\nchecks: |\n  echo a\n  echo b\nstatus: open\n---\nx")
        self.assertEqual(fm["checks"], "echo a\necho b")
        self.assertEqual(fm["status"], "open")
        self.assertEqual(T.parse_checks(fm["checks"]), ["echo a", "echo b"])

    def test_double_semicolon_separator(self):  # synthetic
        self.assertEqual(T.parse_checks('python -c "import sys; sys.exit(3)" ;; echo ok'),
                         ['python -c "import sys; sys.exit(3)"', "echo ok"])

    def test_multiline_command_in_open_quote_stays_one(self):  # synthetic
        self.assertEqual(T.parse_checks('echo "a\nb"'), ['echo "a\nb"'])

    def test_none_has_no_commands(self):
        self.assertEqual(T.parse_checks("none - reason"), [])


class CheckTests(Base):
    def test_examples_pass_check(self):
        shutil.copytree(EXAMPLES, self.tdir)
        r = self.cli("--check")
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)

    def test_bad_status_and_duplicate_id(self):  # synthetic
        write_ticket(self.tdir, "T-0001", status="bogus")
        (self.tdir / "T-0001-dup.md").write_text(
            "---\nid: T-0001\ntitle: d\nstatus: open\ndate: 2026-10-01\n---\n", encoding="utf-8")
        r = self.cli("--check")
        self.assertEqual(r.returncode, 1)
        self.assertIn("unknown status", r.stdout)
        self.assertIn("DUPLICATE_ID", r.stdout)

    def test_workspace_list_is_configurable(self):  # synthetic
        write_ticket(self.tdir, "T-0001", checks="none - fine, nothing to run")
        self.assertNotIn("unknown workspace", self.cli("--check").stdout)
        os.environ["GUARDRAIL_TICKET_WORKSPACES"] = "alpha,beta"
        self.assertIn("unknown workspace", "\n".join(m for _, m in T.check_tickets(self.tdir, date.today())))

    def test_none_without_reason_warns(self):  # synthetic
        write_ticket(self.tdir, "T-0001", checks="none")
        self.assertIn("without a reason", self.cli("--check").stdout)

    def test_broken_frontmatter_blocks(self):  # synthetic
        self.tdir.mkdir(parents=True)
        (self.tdir / "T-0001-x.md").write_text("no frontmatter", encoding="utf-8")
        self.assertEqual(self.cli("--check").returncode, 1)


class ReserveTests(Base):
    def test_sequential_ids_and_marker_counts(self):  # synthetic
        write_ticket(self.tdir, "T-0003")
        a, ra = T.reserve_id(self.tdir)
        b, _ = T.reserve_id(self.tdir)
        self.assertEqual((a, b), ("T-0004", "T-0005"))
        self.assertEqual(T.read_marker(self.tdir, a)["reservation_id"], ra)

    def test_parallel_reservations_are_unique(self):  # synthetic
        procs = [subprocess.Popen([sys.executable, str(REPO / "tools" / "tickets.py"), "--tickets-dir",
                                   str(self.tdir), "--reserve"], stdout=subprocess.PIPE, text=True)
                 for _ in range(8)]
        ids = [json.loads(p.communicate()[0])["ticket_id"] for p in procs]
        self.assertEqual(len(set(ids)), 8, ids)

    def test_reservation_mismatch_blocks(self):  # synthetic
        tid, _ = T.reserve_id(self.tdir)
        write_ticket(self.tdir, tid, checks="none - ok ok", extra="reservation_id: not-the-real-one\n")
        self.assertEqual(self.cli("--check").returncode, 1)


class VerdictTests(Base):
    def verify_green(self, tid="T-0001"):
        write_ticket(self.tdir, tid, checks=f'{PY} -c "print(1)"')
        r = self.cli("--verify", tid)
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        return f'{PY} -c "print(1)"'

    def test_no_checks_field_denied(self):
        ok, why = self.verdict("T-0001", None)
        self.assertFalse(ok)
        self.assertIn("no `checks:`", why)

    def test_none_with_and_without_reason(self):
        self.assertTrue(self.verdict("T-0001", "none - docs only")[0])
        self.assertFalse(self.verdict("T-0001", "none")[0])

    def test_no_evidence_denied(self):  # synthetic
        self.assertFalse(self.verdict("T-0001", "echo hi")[0])

    def test_verify_writes_evidence_and_passes(self):  # synthetic
        checks = self.verify_green()
        ev = json.loads((self.tdir / "evidence" / "T-0001.json").read_text(encoding="utf-8"))
        self.assertTrue(ev["all_passed"])
        c = ev["checks"][0]
        self.assertEqual(c["exit_code"], 0)
        self.assertEqual(len(c["output_sha256"]), 64)
        self.assertIn("duration_s", c)
        self.assertTrue(self.verdict("T-0001", checks)[0])

    def test_failing_check_recorded_and_denied(self):  # synthetic
        bad = f'{PY} -c "import sys; sys.exit(3)"'
        write_ticket(self.tdir, "T-0001", checks=bad)
        r = self.cli("--verify", "T-0001")
        self.assertEqual(r.returncode, 1)
        ok, why = self.verdict("T-0001", bad)
        self.assertFalse(ok)
        self.assertIn("FAILED", why)

    def test_stale_evidence_denied(self):  # synthetic
        checks = self.verify_green()
        p = self.tdir / "evidence" / "T-0001.json"
        ev = json.loads(p.read_text(encoding="utf-8"))
        ev["verified_at"] = (datetime.now(timezone.utc) - timedelta(hours=25)).isoformat()
        p.write_text(json.dumps(ev), encoding="utf-8")
        ok, why = self.verdict("T-0001", checks)
        self.assertFalse(ok)
        self.assertIn("stale", why)

    def test_added_check_after_green_run_denied(self):  # synthetic
        checks = self.verify_green()
        ok, why = self.verdict("T-0001", checks + " ;; echo new")
        self.assertFalse(ok)
        self.assertIn("did NOT run", why)

    def test_evidence_older_than_changed_file_denied(self):  # synthetic
        checks = self.verify_green()
        f = self.tmp / "code.txt"
        f.write_text("x", encoding="utf-8")
        future = datetime.now().timestamp() + 600
        os.utime(f, (future, future))
        ok, why = self.verdict("T-0001", checks, "code.txt")
        self.assertFalse(ok)
        self.assertIn("OLDER", why)

    def test_evidence_of_another_ticket_rejected(self):  # synthetic
        checks = self.verify_green("T-0001")
        shutil.copy(self.tdir / "evidence" / "T-0001.json", self.tdir / "evidence" / "T-0002.json")
        ok, why = self.verdict("T-0002", checks)
        self.assertFalse(ok)
        self.assertIn("belongs to ticket", why)
        self.assertTrue(self.verdict("T-0001", checks)[0])

    def test_output_tail_is_bounded_and_redacted(self):  # synthetic
        cmd = (PY + " -c \"print('password=hunter' + '2'); print('ghp_' + 'a' * 20); "
               "print('f' * 40); [print('line', i) for i in range(30)]\"")
        write_ticket(self.tdir, "T-0001", checks=cmd)
        self.assertEqual(self.cli("--verify", "T-0001").returncode, 0)
        ev = json.loads((self.tdir / "evidence" / "T-0001.json").read_text(encoding="utf-8"))
        tail = ev["checks"][0]["output_tail"]
        self.assertEqual(len(tail.splitlines()), 20)
        self.assertIn("line 29", tail)
        self.assertNotIn("line 0\n", tail)
        # the secret-looking lines are older than the last 20 lines; test the redactor directly too
        red = T.redact_tail("password=hunter2 token: abc123 ghp_" + "a" * 20 + " AKIA" + "B" * 16 + " " + "f" * 40 +
                            " sk-" + "c" * 20 + " xoxb-" + "1" * 12 + " github_pat_" + "d" * 20)
        for leaked in ("hunter2", "abc123", "ghp_a", "AKIAB", "ffff", "sk-c", "xoxb-1", "github_pat_d"):
            self.assertNotIn(leaked, red)
        self.assertIn("[redacted]", red)
        self.assertLessEqual(len(T.redact_tail("y " * 5000)), 2000)

    def test_redaction_applies_to_stored_evidence(self):  # synthetic
        cmd = PY + " -c \"print('password=hunter' + '2')\""
        write_ticket(self.tdir, "T-0001", checks=cmd)
        self.assertEqual(self.cli("--verify", "T-0001").returncode, 0)
        raw = (self.tdir / "evidence" / "T-0001.json").read_text(encoding="utf-8")
        self.assertNotIn("hunter2", raw)
        self.assertIn("password=[redacted]", raw)

    def test_gate_verdict_cli_json_and_from_stdin(self):  # synthetic
        r = self.cli("--gate-verdict", "T-0009")
        self.assertFalse(json.loads(r.stdout)["ok"])
        stdin_ticket = "---\nid: T-0009\nchecks: none - nothing to run\nstatus: done\n---\n"
        r = subprocess.run([sys.executable, str(REPO / "tools" / "tickets.py"), "--tickets-dir",
                            str(self.tdir), "--gate-verdict", "T-0009", "--from-stdin"],
                           input=stdin_ticket, capture_output=True, text=True)
        self.assertTrue(json.loads(r.stdout)["ok"], r.stdout)

    def test_example_ticket_verify_runs(self):
        shutil.copytree(EXAMPLES, self.tdir)
        self.assertEqual(self.cli("--verify", "T-0001").returncode, 0)  # needs `node` on PATH
        self.assertEqual(self.cli("--verify", "T-0002").returncode, 0)  # checks: none - <reason>


class ListTests(Base):
    def test_list_groups_examples(self):
        shutil.copytree(EXAMPLES, self.tdir)
        out = self.cli("--list").stdout
        self.assertIn("OPEN", out)
        self.assertIn("CANDIDATES", out)

    def test_due_and_overdue(self):  # synthetic
        write_ticket(self.tdir, "T-0001", extra="due: 2026-10-02\n")
        write_ticket(self.tdir, "T-0002", extra="due: 2026-09-01\n")
        out = self.cli("--list", "--today", "2026-10-01").stdout
        self.assertIn("OVERDUE", out)
        self.assertIn("DUE SOON", out)
        self.assertIn("T-0001", self.cli("--due", "3", "--today", "2026-10-01").stdout)


if __name__ == "__main__":
    unittest.main()
