#!/usr/bin/env python3
"""project_init.py - scaffold a minimal project skeleton (standard library only).

Usage: project_init.py <path> [--type NAME] [--config FILE] [--dry-run]

Creates, from templates/project-skeleton/ (override: env PROJECT_INIT_TEMPLATES):
  every type : <memory file> (default PROJECT_MEMORY.md), <log file> (default _LOG.md),
               .claude/settings.json (generic: allow python/ls/sha256sum, deny rm/rmdir/del/git push)
  Built-in types add:
    project   nothing
    code      README.md (title, description, how to run, how to test)
    research  sources/
    case      EVIDENCE_MANIFEST.jsonl (empty) and sources/
archive/ is NOT created up front; create it on first use, when a file is superseded.

The memory and log file names come from the same variables the doc-touch-gate hook reads:
GUARDRAIL_DOC_MEMORY_FILE and GUARDRAIL_DOC_LOG_FILE.

Custom types and type detection (optional JSON file: --config, else env GUARDRAIL_PROJECT_TYPES_FILE):
  {
    "types":  { "paper": { "files": {"outline.md": "README.code.md"}, "dirs": ["sources", "figures"] } },
    "detect": [ { "type": "code",  "glob": "work/code/*" },
                { "type": "paper", "glob": "work/papers/*" } ]
  }
  "files" maps a target path to a template file name inside the template directory. A config type
  with a built-in name replaces that built-in. "detect" is tried in order when --type is omitted;
  the glob grammar is the one of the doc-touch-gate hook (`*` = one path segment not starting with
  '.' or '_', case-insensitive, both slash styles, `~` = home; an entry starting with '/' or a drive
  letter is anchored at the path start, any other entry matches at a segment boundary). Without a
  matching rule and without --type the tool exits 2: it never guesses a type.

Idempotent: an existing file or directory is never touched (reported as skipped). In a folder that
already holds other files only the core files are added: a typed add-on such as an empty evidence
ledger would read as "ledgered, no evidence" while the evidence lives elsewhere (unknown must not
look valid).

Prints one JSON summary on stdout. Exit 0 ok, 2 usage or detection error.
"""
import argparse
import datetime
import json
import os
import re
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
TEMPLATES = Path(os.environ.get("PROJECT_INIT_TEMPLATES") or REPO / "templates" / "project-skeleton")
MEMORY_FILE = os.environ.get("GUARDRAIL_DOC_MEMORY_FILE") or "PROJECT_MEMORY.md"
LOG_FILE = os.environ.get("GUARDRAIL_DOC_LOG_FILE") or "_LOG.md"

BUILTIN_TYPES = {
    "project": {"files": {}, "dirs": []},
    "code": {"files": {"README.md": "README.code.md"}, "dirs": []},
    "research": {"files": {}, "dirs": ["sources"]},
    "case": {"files": {"EVIDENCE_MANIFEST.jsonl": "EVIDENCE_MANIFEST.jsonl"}, "dirs": ["sources"]},
}


def norm(p):
    return str(p).replace("\\", "/")


def compile_glob(entry):
    """Same grammar as scripts/doc-touch-gate.js; the match must be followed by '/' or the end."""
    g = norm(entry)
    if g == "~" or g.startswith("~/"):
        g = norm(Path.home()) + g[1:]
    g = g.rstrip("/")
    anchored = g.startswith("/") or re.match(r"^[a-z]:/", g, re.I) is not None
    body = "/".join("[^/._][^/]*" if seg == "*" else re.escape(seg) for seg in g.split("/"))
    return re.compile(("^" if anchored else "(?:^|/)") + body + "(?:/|$)", re.I)


def load_config(path):
    if not path:
        return {"types": dict(BUILTIN_TYPES), "detect": []}
    data = json.loads(Path(path).read_text(encoding="utf-8"))
    types = dict(BUILTIN_TYPES)
    for name, spec in (data.get("types") or {}).items():
        types[name] = {"files": dict(spec.get("files") or {}), "dirs": list(spec.get("dirs") or [])}
    detect = []
    for rule in data.get("detect") or []:
        if rule.get("type") not in types:
            raise ValueError("detect rule names unknown type: %r" % rule.get("type"))
        detect.append((rule["type"], compile_glob(rule["glob"])))
    return {"types": types, "detect": detect}


def detect_type(path, config):
    n = "/" + norm(path).lstrip("/") if not re.match(r"^[a-z]:/", norm(path), re.I) else norm(path)
    for t, rx in config["detect"]:
        if rx.search(n):
            return t
    return None


def render(text, name, today):
    return text.replace("{{NAME}}", name).replace("{{TODAY}}", today)


def plan(spec):
    """List of (relative target, kind, template source or None). kind: file | dir."""
    core = [
        (MEMORY_FILE, "file", "PROJECT_MEMORY.md"),
        (LOG_FILE, "file", "_LOG.md"),
        (".claude/settings.json", "file", "claude-settings.json"),
    ]
    typed = [(t, "file", s) for t, s in spec["files"].items()] + [(d, "dir", None) for d in spec["dirs"]]
    return core, typed


def init(path, ptype=None, dry_run=False, today=None, config=None):
    config = config or load_config(os.environ.get("GUARDRAIL_PROJECT_TYPES_FILE"))
    root = Path(path)
    today = today or datetime.date.today().isoformat()
    type_source = "arg" if ptype else "path"
    if ptype is None:
        # resolve() expands Windows 8.3 short names (RUNNER~1) that the configured globs may still use: try both forms
        ptype = (detect_type(root.resolve(), config) if root.exists() else None) or detect_type(root.absolute(), config)
    if ptype is None:
        raise ValueError("cannot detect type from path; pass --type (%s)" % "|".join(sorted(config["types"])))
    if ptype not in config["types"]:
        raise ValueError("unknown type %r; known: %s" % (ptype, "|".join(sorted(config["types"]))))
    name = root.absolute().name
    created, skipped = [], []
    skeleton = {MEMORY_FILE, LOG_FILE, ".claude"}
    existing = root.exists() and any(e.name not in skeleton for e in root.iterdir())
    if not root.exists():
        created.append(".")
        if not dry_run:
            root.mkdir(parents=True)
    core, typed = plan(config["types"][ptype])
    for rel, kind, src in core + typed:
        target = root / rel
        if existing and (rel, kind, src) in typed:
            skipped.append(rel + " (existing folder: typed add-ons only for new projects)")
            continue
        if os.path.lexists(target):
            skipped.append(rel)
            continue
        if not dry_run:
            if kind == "dir":
                target.mkdir(parents=True)
            else:
                target.parent.mkdir(parents=True, exist_ok=True)
                text = (TEMPLATES / src).read_text(encoding="utf-8")
                target.write_text(render(text, name, today), encoding="utf-8", newline="\n")
        created.append(rel + ("/" if kind == "dir" else ""))
    return {
        "path": str(root),
        "type": ptype,
        "type_source": type_source,
        "dry_run": dry_run,
        "created": created,
        "skipped": skipped,
        "archive": "not created (created on first use)",
        "today": today,
    }


def main(argv=None):
    ap = argparse.ArgumentParser(description="Scaffold a minimal project skeleton.")
    ap.add_argument("path")
    ap.add_argument("--type", help="project type (built-in: %s, or from --config)" % ", ".join(sorted(BUILTIN_TYPES)))
    ap.add_argument("--config", help="JSON file with custom types and detect rules")
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args(argv)
    try:
        config = load_config(a.config or os.environ.get("GUARDRAIL_PROJECT_TYPES_FILE"))
        res = init(a.path, a.type, a.dry_run, config=config)
    except (ValueError, OSError, KeyError) as e:
        print(json.dumps({"error": str(e), "path": a.path}))
        return 2
    print(json.dumps(res, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
