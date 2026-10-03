# secret-guard

PreToolUse hook (`scripts/secret-guard.js`) that denies tool calls which would send a secret off
the machine. It never prints the secret: messages print only the kind of secret and its length.

## What it blocks

1. Non-local tools (`WebFetch`, `WebSearch`, MCP tools, ...) whose input contains a URL with a
   key/token-looking value in the path or query string. For `WebFetch` and `WebSearch` the whole
   input is also scanned for high-confidence token formats.
2. `Bash` / `PowerShell` network commands (`curl`, `wget`, `Invoke-WebRequest`/`iwr`,
   `Invoke-RestMethod`/`irm`, `nc`/`ncat`/`netcat`) that carry such a value in a header, `-d`/`--data`,
   URL or `-u user:password`, or that read a secret file: `@.env`, `--data-binary @key.pem`,
   `-F f=@file`, `-T file`, `< file`, `cat file |`, `base64 file |`, `$(cat file)`, `-InFile`,
   `Get-Content file`. A pipeline counts as one unit, so `cat .env | curl -d @- ...` is caught.
3. `git add` / `git stage` / `git commit` naming a secret file (including `git add -f .env`), and
   `git commit` carrying a high-confidence token.

Secret patterns: `sk-ant-`, `sk-`, `ghp_`/`gho_`/..., `github_pat_`, `xox[abp]-`,
`AKIA` + 16 characters, `AIza` + 35 characters, `-----BEGIN ... PRIVATE KEY-----`, JWTs
(`eyJ...<dot>...<dot>...`), `Bearer`/`Token` credentials in network commands, and the generic
`api_key|token|secret|password|passwd|pwd|access_key = <value of 16+ characters>`. Invisible
format characters (zero-width space etc.) are removed before matching, which can only add matches.
Values that merely reference a secret (`$TOKEN`, `${KEY}`, `%KEY%`, `os.environ...`,
`process.env...`, `<placeholder>`) do not match.

Secret files: `.env`, `.env.*` (except `.example`, `.sample`, `.template`, `.dist`), `*.pem`, `*.key`,
`id_rsa*`/`id_dsa*`/`id_ecdsa*`/`id_ed25519*` (not `.pub`), `*credentials*`.

## Allowed on purpose

Local-only use (`export X=...`, `echo token > local.txt`, writing `.env`), the `Read`, `Write`,
`Edit`, `Grep`, `Glob` tools, `git add .env.example`, URLs that end in `.key` or `.pem`,
download targets (`curl -o x.key URL`), and any network command aimed only at `localhost`,
`127.x.x.x` or `::1`.

## Environment variables and escape hatch

`GUARDRAIL_AUDIT_LOG` (log path) and `GUARDRAIL_FAIL_CLOSED=1` work as in the other hooks. Add
`guardrail:confirmed reason="<at least 8 characters>"` to the call to bypass a false positive. A
marker without a reason is ignored. The bypass is honoured only if its audit record was written.
The log records the tool, the class and the reason, never the secret value.

## Known false positives

- A secret-file name inside text that is not executed, such as `git commit -m "stop tracking .env"`.
  Quotes are never stripped to avoid a match; use the escape hatch.
- Long values after `token:`, `secret=` and similar words that are not secrets (for example a
  public identifier named `token`).
- `*.key` and `*credentials*` file names that are not secret.

## Known bypasses

- Shell indirection and variables: `F=.en; curl -d @${F}v ...`, `eval`, `$(...)` that builds the
  value, a secret held in an environment variable and sent as `$TOKEN` (the value is not visible
  to the hook; only literal values are).
- Encoding and splitting: base64 or hex of a token, a token split across several arguments or
  variables, compression, a token inside an uploaded archive.
- Other transports and languages: `python -c "requests.post(...)"`, `scp`, `rsync`, `ssh`,
  `telnet`, browsers, a script file the model wrote earlier, DNS exfiltration.
- `git add .` / `git add -A` pick up a secret file without naming it.
- A secret file reached through a symlink or an alias with an innocuous name.
- Other token formats not in the list (the generic pattern covers only `keyword=value` shapes).

Treat this hook as a seat belt for honest mistakes, not as a data-loss-prevention system.
