#!/usr/bin/env python3
"""Tickets with an evidence-gated "done".

One ticket = one Markdown file with YAML-like frontmatter:  tickets/T-0001-some-slug.md
Lifecycle: candidate -> open -> done | dropped.

Commands (default: --list):
  --list            grouped view: overdue, due soon, open, candidates, closed
  --due [N]         open tickets due within N days (default 3)
  --check           frontmatter integrity; exit 1 if a BLOCKER is found (warnings do not fail)
  --reserve         atomically reserve the next free ID (use before writing a ticket by hand)
  --verify T-XXXX   run the ticket's `checks` commands and write tickets/evidence/T-XXXX.json
  --gate-verdict T  machine verdict as one JSON line (used by scripts/completion-gate.js);
                    never runs anything

SECURITY: `--verify` executes shell commands taken from the ticket file. Tickets are TRUSTED
INPUT, exactly like a Makefile. Never run --verify on a ticket from an untrusted source.

Where things live:
  tickets dir   --tickets-dir, else env GUARDRAIL_TICKETS_DIR, else <root>/tickets
  root          --root, else the parent of the tickets dir (when one was given), else the cwd.
                Check commands run with the root as their working directory.
  workspaces    env GUARDRAIL_TICKET_WORKSPACES="a,b,c" restricts the `workspace` field
                (unset = any non-empty value is accepted).

Standard library only, Python 3.9+. Exit codes: 0 ok, 1 problem found / check failed.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import subprocess
import sys
import uuid
from datetime import date, datetime, timezone
from pathlib import Path
from typing import Optional

DUE_SOON_DAYS = 3
STALE_CANDIDATE_DAYS = 14
EVIDENCE_MAX_AGE_H = 24
NO_CHECKS_PREFIX = "none"      # `checks: none - <reason>` = a conscious, visible exemption
VERIFY_TIMEOUT_S = 600

STATUSES = ("candidate", "open", "done", "dropped")
CLOSED_STATUSES = ("done", "dropped")

ID_RE = re.compile(r"^T-\d{4}$")
DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
FM_RE = re.compile(r"^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$")


def allowed_workspaces() -> Optional[tuple]:
    raw = os.environ.get("GUARDRAIL_TICKET_WORKSPACES", "").strip()
    if not raw:
        return None
    return tuple(x.strip() for x in raw.split(",") if x.strip())


class Ticket:
    def __init__(self, path: Path, fm: dict, body: str):
        self.path = path
        self.fm = fm
        self.body = body

    @property
    def due_date(self) -> Optional[date]:
        raw = self.fm.get("due")
        if not raw or not DATE_RE.match(str(raw)):
            return None
        try:
            return datetime.strptime(str(raw), "%Y-%m-%d").date()
        except ValueError:
            return None

    def days_left(self, today: date) -> Optional[int]:
        d = self.due_date
        return None if d is None else (d - today).days


def parse_frontmatter(text: str):
    """(dict, body), or (None, '') when the frontmatter is missing or broken.

    Supports `key: value` lines and YAML block scalars (`checks: |` followed by indented lines,
    one command per line). A block scalar must not be swallowed as a bare `|`: that would make
    the gate "run" the character `|` and verify nothing.
    """
    m = FM_RE.match(text)
    if not m:
        return None, ""
    fm: dict = {}
    lines = m.group(1).split("\n")
    i = 0
    while i < len(lines):
        line = lines[i].rstrip()
        i += 1
        if not line or line.lstrip().startswith("#") or ":" not in line:
            continue
        k, _, v = line.partition(":")
        k, v = k.strip(), v.strip()
        if v in ("|", ">", "|-", ">-", "|+", ">+"):
            base = len(line) - len(line.lstrip())
            block = []
            while i < len(lines):
                nxt = lines[i]
                if nxt.strip() and (len(nxt) - len(nxt.lstrip())) <= base:
                    break
                block.append(nxt.strip())
                i += 1
            while block and not block[-1]:
                block.pop()
            fm[k] = "\n".join(block) or None
            continue
        if v in ("null", "~", ""):
            v = None
        fm[k] = v
    return fm, m.group(2)


def load_tickets(tdir: Path) -> list:
    if not tdir.is_dir():
        return []
    out = []
    for f in sorted(tdir.glob("T-*.md")):
        try:
            fm, body = parse_frontmatter(f.read_text(encoding="utf-8", errors="ignore"))
        except OSError:
            continue
        if fm is None:
            continue  # --check reports it; one bad file does not hide the others
        out.append(Ticket(f, fm, body))
    return out


# ---- ID reservation --------------------------------------------------------

def _id_nums(tdir: Path) -> set:
    """Taken numbers: existing tickets AND reservation markers (a reserved-but-unwritten ID
    is still taken; the marker protects exactly the window before the file is written)."""
    nums = {int(t.fm["id"][2:]) for t in load_tickets(tdir)
            if t.fm.get("id") and ID_RE.match(str(t.fm["id"]))}
    for m in (tdir / ".ids").glob("T-*.id"):
        try:
            nums.add(int(m.stem[2:]))
        except ValueError:
            pass
    return nums


def reserve_id(tdir: Path, max_tries: int = 64):
    """Atomic ID reservation -> (ticket_id, reservation_id).

    `max(ids)+1` alone is read-then-decide: two processes see the same maximum and both win.
    The reservation is an exclusive-create (O_CREAT|O_EXCL) of `.ids/T-NNNN.id`, whose name
    depends only on the number (the ticket file name contains a title slug, so two writers with
    different titles would never collide on it). Exactly one caller creates the marker.
    """
    resdir = tdir / ".ids"
    resdir.mkdir(parents=True, exist_ok=True)
    for _ in range(max_tries):
        nums = _id_nums(tdir)
        tid = f"T-{(max(nums) + 1 if nums else 1):04d}"
        try:
            fd = os.open(str(resdir / f"{tid}.id"), os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o644)
        except FileExistsError:
            continue  # someone else won; rescan
        rid = str(uuid.uuid4())
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump({"ticket_id": tid, "reservation_id": rid,
                       "reserved_at": datetime.now().isoformat(), "pid": os.getpid()}, f)
        return tid, rid
    raise RuntimeError(f"could not reserve an ID after {max_tries} attempts")


def read_marker(tdir: Path, tid: str) -> Optional[dict]:
    p = tdir / ".ids" / f"{tid}.id"
    if not p.exists():
        return None
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except Exception:
        return {"ticket_id": tid, "reservation_id": None, "unparseable": True}


# ---- views -----------------------------------------------------------------

def _fmt(t: Ticket, today: date) -> str:
    dl = t.days_left(today)
    if dl is None:
        when = "     -    "
    elif dl < 0:
        when = f"-{-dl:3d} days "
    else:
        when = f" {dl:3d} days "
    return (f"  {str(t.fm.get('id', '?????')):7} {when} {(t.fm.get('workspace') or '?'):10} "
            f"{(t.fm.get('title') or '')[:44]:44} {t.fm.get('session') or 'manual'}")


def _ev_flag(tdir: Path, root: Path, t: Ticket, now: datetime) -> str:
    if t.fm.get("status") != "open":
        return " "
    ok, _ = evidence_verdict(tdir, root, t.fm.get("id") or "?", t.fm.get("checks"), now,
                             t.fm.get("changed_files"))
    return "+" if ok else "!"


def cmd_list(tdir: Path, root: Path, today: date) -> int:
    ts = load_tickets(tdir)
    if not ts:
        print("No tickets.")
        return 0

    def sel(pred):
        return sorted([t for t in ts if pred(t)],
                      key=lambda t: (t.due_date or date.max, t.fm.get("id") or ""))

    is_open = lambda t: t.fm.get("status") == "open"  # noqa: E731
    overdue = sel(lambda t: is_open(t) and t.days_left(today) is not None and t.days_left(today) < 0)
    soon = sel(lambda t: is_open(t) and t.days_left(today) is not None
               and 0 <= t.days_left(today) <= DUE_SOON_DAYS)
    rest = sel(lambda t: is_open(t) and t not in overdue and t not in soon)
    cands = sel(lambda t: t.fm.get("status") == "candidate")
    closed = sel(lambda t: t.fm.get("status") in CLOSED_STATUSES)
    now = datetime.now(timezone.utc)
    for title, group in (("OVERDUE", overdue), (f"DUE SOON (within {DUE_SOON_DAYS} days)", soon),
                         ("OPEN", rest), ("CANDIDATES - awaiting approval", cands)):
        if group:
            print(f"\n{title}  ({len(group)})")
            for t in group:
                print(f" {_ev_flag(tdir, root, t, now)}{_fmt(t, today)}")
    if closed:
        print(f"\nCLOSED: {len(closed)} "
              f"(done={sum(1 for t in closed if t.fm.get('status') == 'done')}, "
              f"dropped={sum(1 for t in closed if t.fm.get('status') == 'dropped')})")
    print(f"\n{len(ts)} tickets, {sum(1 for t in ts if t.fm.get('status') in ('open', 'candidate'))} active")
    print("  + = proven, can be closed   ! = no / stale / failing evidence (the gate would block)")
    return 0


def cmd_due(tdir: Path, today: date, days: int) -> int:
    hits = sorted([t for t in load_tickets(tdir) if t.fm.get("status") == "open"
                   and t.days_left(today) is not None and t.days_left(today) <= days],
                  key=lambda t: t.due_date or date.max)
    if not hits:
        print(f"Nothing due within {days} days.")
        return 0
    for t in hits:
        print(_fmt(t, today))
    return 0


# ---- evidence --------------------------------------------------------------

def _open_quote(s: str) -> bool:
    """Unclosed double quote? Only `"` counts, with no escape: that is how cmd.exe sees it, and
    POSIX shells agree for the simple cases checks use. Apostrophes are NOT quotes (cmd.exe)."""
    return s.count('"') % 2 == 1


def parse_checks(raw) -> list:
    """The `checks` field -> list of commands. ONE implementation, shared by --verify and the gate.

    Two separators, both deliberate: `;;` inside one line (a single `;` can be part of a command,
    e.g. python -c "import sys; sys.exit(3)"), and a newline for YAML block scalars (`checks: |`).
    A newline inside an open double quote continues the same command.
    """
    raw = (raw or "").strip()
    if not raw or raw.lower().startswith(NO_CHECKS_PREFIX):
        return []
    parts = []
    buf = ""
    for line in raw.split("\n"):
        buf = line if not buf else buf + "\n" + line
        if _open_quote(buf):
            continue
        for c in buf.split(";;"):
            c = c.strip()
            if c and c not in ("|", ">", "|-", ">-"):
                parts.append(c)
        buf = ""
    if buf.strip():
        parts.append(buf.strip())
    return parts


def newest_mtime(root: Path, spec):
    """Newest mtime among the globs listed in `changed_files` (comma separated, relative to root)."""
    newest = None
    for pat in [x.strip() for x in str(spec or "").split(",") if x.strip()]:
        try:
            matches = list(root.glob(pat))
        except (ValueError, NotImplementedError):
            continue  # absolute or malformed pattern: ignore rather than crash the gate
        for f in matches:
            if f.is_file():
                m = f.stat().st_mtime
                if newest is None or m > newest[0]:
                    newest = (m, f.relative_to(root).as_posix())
    return newest


def evidence_path(tdir: Path, tid: str) -> Path:
    return tdir / "evidence" / f"{tid}.json"


def read_evidence(tdir: Path, tid: str):
    p = evidence_path(tdir, tid)
    if not p.is_file():
        return None
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return None


def evidence_verdict(tdir: Path, root: Path, tid: str, checks_field, now: datetime,
                     changed_files=None):
    """(ok, reason). The single decision point: the gate hook and --list both call it."""
    raw = (checks_field or "").strip()
    if not raw:
        return False, (f"{tid}: no `checks:` field, so nothing can be proven. List commands, or "
                       f"write `checks: none - <reason>` if there is truly nothing to run")
    if raw.lower().startswith(NO_CHECKS_PREFIX):
        rest = raw[len(NO_CHECKS_PREFIX):].strip(" -:—–")
        if not rest:
            return False, f"{tid}: `checks: none` without a reason - the exemption must be conscious"
        return True, f"{tid}: checks=none ({rest})"

    ev = read_evidence(tdir, tid)
    if ev is None:
        return False, f"{tid}: no evidence - run: python tools/tickets.py --verify {tid}"
    if not isinstance(ev, dict) or ev.get("ticket") != tid:
        return False, (f"{tid}: evidence belongs to ticket {ev.get('ticket') if isinstance(ev, dict) else None!r}, "
                       f"not {tid} - run: --verify {tid}")
    try:
        ts = datetime.fromisoformat(str(ev.get("verified_at", "")).replace("Z", "+00:00"))
    except ValueError:
        return False, f"{tid}: evidence `verified_at` is unreadable"
    if ts.tzinfo is None:
        ts = ts.replace(tzinfo=timezone.utc)
    age_h = (now - ts).total_seconds() / 3600
    if age_h > EVIDENCE_MAX_AGE_H:
        return False, (f"{tid}: evidence is {age_h:.0f} h old (> {EVIDENCE_MAX_AGE_H} h), stale - "
                       f"re-run: --verify {tid}")
    failed = [c for c in ev.get("checks", []) if c.get("exit_code") != 0]
    if failed:
        names = ", ".join(f"{str(c.get('command'))[:40]!r} (exit {c.get('exit_code')})" for c in failed)
        return False, f"{tid}: {len(failed)} check(s) FAILED: {names}"
    if not ev.get("checks"):
        return False, f"{tid}: evidence is empty (0 checks ran)"

    # The evidence must cover the CURRENT `checks:` - adding a check after a green run is not proven.
    want = set(parse_checks(checks_field))
    ran = {c.get("command") for c in ev.get("checks", [])}
    missing = want - ran
    if missing:
        return False, (f"{tid}: {len(missing)} check(s) in `checks:` did NOT run: "
                       f"{', '.join(repr(m[:40]) for m in sorted(missing))} -> run: --verify {tid}")

    # Evidence older than the files it claims to prove is not evidence of the current state.
    if changed_files:
        newest = newest_mtime(root, changed_files)
        if newest and newest[0] > ts.timestamp():
            drift_min = (newest[0] - ts.timestamp()) / 60
            return False, (f"{tid}: evidence is {drift_min:.0f} min OLDER than `{newest[1]}` - the "
                           f"checks did not run on the current state. Re-run: --verify {tid}")
    return True, f"{tid}: {len(ev['checks'])} check(s) green, {age_h:.1f} h ago"


OUTPUT_TAIL_LINES = 20
OUTPUT_TAIL_CHARS = 2000
_SECRET_RES = [re.compile(x) for x in (
    r"(?i)\b(password|passwd|secret|token|api[_-]?key)\b(\s*[=:]\s*)[^\s\"']+",
    r"\bsk-[A-Za-z0-9_-]{8,}", r"\bghp_[A-Za-z0-9]{8,}", r"\bgithub_pat_[A-Za-z0-9_]{8,}",
    r"\b(?:AKIA|ASIA)[A-Z0-9]{12,}", r"\bxox[a-z]-[A-Za-z0-9-]{8,}",
    r"\b[0-9a-fA-F]{32,}\b", r"[A-Za-z0-9+/_-]{32,}={0,2}",
)]


def redact_tail(out: str) -> str:
    """Bounded, secret-masked excerpt of a check's output for the evidence file: last 20 lines /
    2000 chars, with token-looking values replaced by [redacted]. Best effort, not a guarantee."""
    tail = "\n".join(out.strip().splitlines()[-OUTPUT_TAIL_LINES:])[-OUTPUT_TAIL_CHARS:]
    for i, rx in enumerate(_SECRET_RES):
        tail = rx.sub((lambda m: m.group(1) + m.group(2) + "[redacted]") if i == 0 else "[redacted]", tail)
    return tail


def run_once(cmd: str, cwd: Path, timeout: int):
    """Run one shell command; on timeout kill the whole process tree. -> (exit_code, output, seconds)."""
    import time
    t0 = time.monotonic()
    kw = {}
    if os.name == "nt":
        kw["creationflags"] = subprocess.CREATE_NEW_PROCESS_GROUP
    else:
        kw["start_new_session"] = True
    p = subprocess.Popen(cmd, shell=True, cwd=str(cwd), stdout=subprocess.PIPE,
                         stderr=subprocess.STDOUT, **kw)
    try:
        out, _ = p.communicate(timeout=timeout)
        code = p.returncode
    except subprocess.TimeoutExpired:
        if os.name == "nt":
            subprocess.run(["taskkill", "/F", "/T", "/PID", str(p.pid)],
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        else:
            import signal
            try:
                os.killpg(p.pid, signal.SIGKILL)
            except OSError:
                p.kill()
        out, _ = p.communicate()
        code = 124
        out = (out or b"") + f"\n[timeout after {timeout}s]".encode()
    return code, (out or b"").decode("utf-8", "replace"), round(time.monotonic() - t0, 2)


def cmd_verify(tdir: Path, root: Path, tid: str) -> int:
    t = next((x for x in load_tickets(tdir) if x.fm.get("id") == tid), None)
    if t is None:
        print(f"No such ticket: {tid}")
        return 1
    raw = (t.fm.get("checks") or "").strip()
    if not raw:
        print(f"{tid}: no `checks:` field - nothing to run.")
        return 1
    if raw.lower().startswith(NO_CHECKS_PREFIX):
        print(f"{tid}: checks=none - nothing to run (the gate accepts it if a reason is given).")
        return 0

    cmds = parse_checks(raw)
    results = []
    print(f"{tid}: running {len(cmds)} check(s) in {root}\n")
    for c in cmds:
        code, out, dur = run_once(c, root, VERIFY_TIMEOUT_S)
        tail = redact_tail(out)
        results.append({"command": c, "exit_code": code, "duration_s": dur,
                        "output_sha256": hashlib.sha256(out.encode("utf-8", "replace")).hexdigest(),
                        "output_tail": tail})
        print(f"  {'OK    ' if code == 0 else 'FAILED'} exit={code:<3} {dur:>6.1f}s  {c[:64]}")
        if code != 0:
            print(f"        -> {(tail.splitlines() or [''])[-1][:100]}")
    ev = {"ticket": tid,
          "verified_at": datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z"),
          "all_passed": all(r["exit_code"] == 0 for r in results),
          "checks": results}
    p = evidence_path(tdir, tid)
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(ev, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"\nEvidence: {p}")
    if ev["all_passed"]:
        print(f"All {len(results)} check(s) green -> `status: done` can now pass the gate "
              f"(evidence valid for {EVIDENCE_MAX_AGE_H} h).")
        return 0
    print("At least one check FAILED -> the gate will not allow `status: done`.")
    return 1


# ---- integrity -------------------------------------------------------------

def check_tickets(tdir: Path, today: date) -> list:
    """[(severity, message)]. Separate function so other tooling can import it."""
    out: list = []
    if not tdir.is_dir():
        return out
    seen: dict = {}
    wss = allowed_workspaces()
    for f in sorted(tdir.glob("T-*.md")):
        try:
            text = f.read_text(encoding="utf-8", errors="ignore")
        except OSError:
            continue
        fm, body = parse_frontmatter(text)
        if fm is None:
            out.append(("BLOCKER", f"{f.name}: missing or broken frontmatter"))
            continue
        tid = fm.get("id")
        if not tid or not ID_RE.match(str(tid)):
            out.append(("BLOCKER", f"{f.name}: bad or missing id: {tid!r}"))
        elif tid in seen:
            out.append(("BLOCKER", f"{f.name}: DUPLICATE_ID {tid} (already: {seen[tid]})"))
        else:
            seen[tid] = f.name
            mk = read_marker(tdir, str(tid))
            rid = (fm.get("reservation_id") or "").strip() or None
            if mk is None:
                out.append(("WARNING", f"{f.name}: no reservation marker (.ids/{tid}.id) - written by "
                                       f"hand? Use `tickets.py --reserve` first"))
            elif mk.get("unparseable"):
                out.append(("BLOCKER", f"{f.name}: RESERVATION_MISMATCH - the marker is unreadable"))
            elif rid is not None and rid != mk.get("reservation_id"):
                out.append(("BLOCKER", f"{f.name}: RESERVATION_MISMATCH - reservation_id differs from the marker"))
        if not (fm.get("title") or "").strip():
            out.append(("WARNING", f"{f.name}: empty title"))
        st = fm.get("status")
        if st not in STATUSES:
            out.append(("BLOCKER", f"{f.name}: unknown status {st!r} (allowed: {', '.join(STATUSES)})"))
        ws = fm.get("workspace")
        if wss is not None and ws not in wss:
            out.append(("WARNING", f"{f.name}: unknown workspace {ws!r} (allowed: {', '.join(wss)})"))
        for key in ("due", "date"):
            v = fm.get(key)
            if v and not DATE_RE.match(str(v)):
                out.append(("WARNING", f"{f.name}: {key} is not YYYY-MM-DD: {v!r}"))
        if not fm.get("date"):
            out.append(("WARNING", f"{f.name}: missing date"))
        if st == "open":
            raw = (fm.get("checks") or "").strip()
            if not raw:
                out.append(("WARNING", f"{f.name}: open ticket without `checks:` - the gate cannot verify it"))
            elif raw.lower().startswith(NO_CHECKS_PREFIX) and \
                    not raw[len(NO_CHECKS_PREFIX):].strip(" -:—–"):
                out.append(("WARNING", f"{f.name}: `checks: none` without a reason"))
        try:
            idle = (today - date.fromtimestamp(f.stat().st_mtime)).days
        except OSError:
            continue
        if st == "candidate" and idle > STALE_CANDIDATE_DAYS:
            out.append(("WARNING", f"{f.name}: candidate untouched for {idle} days (> {STALE_CANDIDATE_DAYS})"))

    for m in sorted((tdir / ".ids").glob("T-*.id")):
        if m.stem not in seen:
            out.append(("INFO", f"{m.name}: RESERVED_UNUSED - reserved but no ticket yet; the ID stays taken"))
    return out


def cmd_check(tdir: Path, today: date) -> int:
    problems = check_tickets(tdir, today)
    for sev, msg in problems:
        print(f"  {sev} {msg}")
    bad = sum(1 for s, _ in problems if s == "BLOCKER")
    print(f"tickets --check: {bad} blocker(s), {len(problems) - bad} other finding(s)")
    return 1 if bad else 0


# ---- entry point -----------------------------------------------------------

def _configure_stdio():
    for s in (sys.stdout, sys.stderr):
        try:
            s.reconfigure(encoding="utf-8", errors="replace")
        except (AttributeError, ValueError, OSError):
            pass


def resolve_dirs(tickets_dir_arg, root_arg):
    env = os.environ.get("GUARDRAIL_TICKETS_DIR", "").strip()
    given = tickets_dir_arg or (Path(env) if env else None)
    root = Path(root_arg) if root_arg else (Path(given).resolve().parent if given else Path.cwd())
    tdir = Path(given) if given else root / "tickets"
    return tdir, root


def main(argv=None) -> int:
    _configure_stdio()
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--root", type=Path, help="project root (cwd for check commands)")
    p.add_argument("--tickets-dir", type=Path, help="override env GUARDRAIL_TICKETS_DIR / <root>/tickets")
    g = p.add_mutually_exclusive_group()
    g.add_argument("--list", action="store_true", help="grouped view (default)")
    g.add_argument("--due", type=int, metavar="N", nargs="?", const=DUE_SOON_DAYS)
    g.add_argument("--check", action="store_true", help="frontmatter integrity; exit 1 on a BLOCKER")
    g.add_argument("--reserve", action="store_true", help="atomically reserve an ID and print it as JSON")
    g.add_argument("--verify", metavar="T-XXXX", help="run the ticket's checks, write evidence")
    g.add_argument("--gate-verdict", metavar="T-XXXX", help="JSON verdict for the completion gate (runs nothing)")
    p.add_argument("--from-stdin", action="store_true",
                   help="--gate-verdict: take `checks`/`changed_files` from the ticket text on stdin "
                        "instead of the file on disk (used for Write, where the new content is not on disk yet)")
    p.add_argument("--today", type=str, help="testing: YYYY-MM-DD")
    args = p.parse_args(argv)

    tdir, root = resolve_dirs(args.tickets_dir, args.root)
    today = datetime.strptime(args.today, "%Y-%m-%d").date() if args.today else date.today()

    if args.gate_verdict:
        tid = args.gate_verdict
        if args.from_stdin:
            fm, _ = parse_frontmatter(sys.stdin.read())
            fm = fm or {}
            checks, changed = fm.get("checks"), fm.get("changed_files")
        else:
            t = next((x for x in load_tickets(tdir) if x.fm.get("id") == tid), None)
            checks = t.fm.get("checks") if t else None
            changed = t.fm.get("changed_files") if t else None
        okv, reason = evidence_verdict(tdir, root, tid, checks, datetime.now(timezone.utc), changed)
        sys.stdout.write(json.dumps({"ok": okv, "reason": reason}, ensure_ascii=False))
        return 0
    if args.verify:
        return cmd_verify(tdir, root, args.verify)
    if args.check:
        return cmd_check(tdir, today)
    if args.reserve:
        tid, rid = reserve_id(tdir)
        print(json.dumps({"ticket_id": tid, "reservation_id": rid}))
        return 0
    if args.due is not None:
        return cmd_due(tdir, today, args.due)
    return cmd_list(tdir, root, today)


if __name__ == "__main__":
    sys.exit(main())
