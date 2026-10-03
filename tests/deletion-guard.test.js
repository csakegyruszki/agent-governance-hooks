'use strict';
// Regression cases for scripts/deletion-guard.js. These are regression cases (inputs that pin
// intended behaviour or a known gap), not captured production data.

const { test } = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const GUARD = path.join(__dirname, '..', 'scripts', 'deletion-guard.js');
const fwd = (p) => p.split('\\').join('/');
const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'gr-del-'));
const PROT = fwd(path.join(SANDBOX, 'protected'));
const HOME = path.join(SANDBOX, 'home');
const LOG = path.join(SANDBOX, 'audit.jsonl');
fs.mkdirSync(PROT, { recursive: true });
fs.mkdirSync(path.join(HOME, 'protected2'), { recursive: true });
test.after(() => fs.rmSync(SANDBOX, { recursive: true, force: true }));

function call(command, { tool = 'Bash', env = {}, cwd, raw } = {}) {
  const input = raw !== undefined ? raw : JSON.stringify({ tool_name: tool, tool_input: { command }, cwd });
  const res = spawnSync(process.execPath, [GUARD], {
    input,
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME, USERPROFILE: HOME,
      GUARDRAIL_AUDIT_LOG: LOG,
      GUARDRAIL_PROTECTED_DIRS: [PROT, '~/protected2'].join(path.delimiter),
      ...env,
    },
  });
  assert.strictEqual(res.status, 0, res.stderr);
  const out = JSON.parse(res.stdout || '{}');
  const h = out.hookSpecificOutput || {};
  return { decision: h.permissionDecision || 'allow', reason: h.permissionDecisionReason || '' };
}
const decision = (c, o) => call(c, o).decision;

const VB = '[Microsoft.VisualBasic.FileIO.FileSystem]::';
const DENY = [
  'rm -rf build', 'rm -fr build', 'rm -r build', 'rm -R build', 'rm -f a.txt', 'rm -rfv build',
  'rm --recursive build', 'rm --force a.txt', 'rm build -rf', 'sudo rm -rf /var/x',
  'Remove-Item -Path x -Recurse', 'Remove-Item x -Force', 'Remove-Item x -r', 'ri x -Recurse',
  'rd /s /q build', 'rmdir /s build', 'del /s *.tmp', 'del /q a.txt', 'rm -Recurse x',
  'find . -name "*.o" -delete', 'find target -exec rm -rf {} +', 'find . -exec rm {} \\;',
  'ls | xargs rm', 'git clean -fd', 'git clean -fdx', 'git clean -x', 'git clean -d',
  'python -c "import shutil; shutil.rmtree(\'x\')"',
  'python -c "import os\nfor f in os.listdir(\'.\'): os.remove(f)"',
  'node -e "require(\'fs\').rmSync(\'x\',{recursive:true})"',
  'pwsh -c "[System.IO.Directory]::Delete(\'x\', $true)"',
  `${VB}DeleteFile('a.txt')`,
  `${VB}DeleteFile('a.txt','OnlyErrorDialogs','DeletePermanently')`,
  'cd build && rm -rf .', 'echo ok; rm -rf x',
];
for (const c of DENY) test(`regression: deny  ${c.split('\n')[0]}`, () => assert.strictEqual(decision(c), 'deny'));

const ALLOW = [
  'rm file.txt', 'rm a.txt b.txt', 'del a.txt', 'Remove-Item a.txt', 'unlink a.txt', 'rmdir emptydir',
  'git clean -n', 'git clean -nd', 'git clean -ndx', 'git clean --dry-run -f', 'git status',
  'docker run --rm image', 'ls -rf', 'echo $HOME', 'trash old.txt', 'gio trash old.txt',
  `${VB}DeleteFile('a.txt','OnlyErrorDialogs','SendToRecycleBin')`,
  `${VB}DeleteDirectory('d','OnlyErrorDialogs','SendToRecycleBin')`,
  'git rm --cached a.txt', 'echo "k\u00e9rd\u00e9s"', 'find . -name "*.o"',
  'python -c "print(1)"', 'trash-put x',
];
for (const c of ALLOW) test(`regression: allow ${c}`, () => assert.strictEqual(decision(c), 'allow'));

test('protected dirs: single-file delete inside is denied, outside is allowed', () => {
  assert.strictEqual(decision(`rm ${PROT}/a.txt`), 'deny');
  assert.strictEqual(decision(`rm "${PROT}/sub dir/a.txt"`), 'deny');
  assert.strictEqual(decision(`del ${PROT.split('/').join('\\')}\\a.txt`), 'deny');
  assert.strictEqual(decision(`Remove-Item -Path ${PROT}/a.txt`), 'deny');
  assert.strictEqual(decision(`unlink ${PROT}/a.txt`), 'deny');
  assert.strictEqual(decision(`rm ${fwd(SANDBOX)}/other/a.txt`), 'allow');
});
test('protected dirs: tilde and env-var expansion', () => {
  assert.strictEqual(decision('rm ~/protected2/a.txt'), 'deny');
  assert.strictEqual(decision('rm $HOME/protected2/a.txt'), 'deny');
  assert.strictEqual(decision('rm ${HOME}/protected2/a.txt'), 'deny');
  assert.strictEqual(decision('rm ~/elsewhere/a.txt'), 'allow');
});
test('protected dirs: path traversal is resolved', () => {
  assert.strictEqual(decision(`rm ${PROT}/sub/../a.txt`), 'deny');
  assert.strictEqual(decision(`rm ${PROT}/../protected/a.txt`), 'deny');
  assert.strictEqual(decision(`rm x/../${path.basename(PROT)}/a.txt`, { cwd: SANDBOX }), 'deny');
  assert.strictEqual(decision(`rm ${PROT}/../safe.txt`), 'allow');
});
test('protected dirs: relative target resolved against cwd and against cd', () => {
  assert.strictEqual(decision('rm a.txt', { cwd: PROT }), 'deny');
  assert.strictEqual(decision(`cd ${PROT} && rm a.txt`), 'deny');
  assert.strictEqual(decision('rm a.txt', { cwd: SANDBOX }), 'allow');
});
test('protected dirs: case-insensitive on Windows only', { skip: process.platform !== 'win32' }, () => {
  assert.strictEqual(decision(`rm ${PROT.toUpperCase()}/a.txt`), 'deny');
});
test('protected dirs: symlinked path is resolved', (t) => {
  const link = path.join(SANDBOX, 'link');
  try { fs.symlinkSync(PROT, link, 'junction'); } catch (_) { return t.skip('cannot create link'); }
  assert.strictEqual(decision(`rm ${fwd(link)}/a.txt`), 'deny');
});
test('no protected dirs configured: plain delete allowed', () => {
  assert.strictEqual(decision(`rm ${PROT}/a.txt`, { env: { GUARDRAIL_PROTECTED_DIRS: '' } }), 'allow');
});

test('tool filter: PowerShell is covered, other tools are ignored', () => {
  assert.strictEqual(decision('Remove-Item x -Recurse', { tool: 'PowerShell' }), 'deny');
  assert.strictEqual(decision('rm -rf x', { tool: 'Read' }), 'allow');
});

test('deny message suggests trash and names the escape hatch', () => {
  const { reason } = call('rm -rf x');
  assert.match(reason, /trash/i);
  assert.match(reason, /guardrail:confirmed/);
});

test('escape hatch: marker with reason bypasses and is audited; without reason it does not', () => {
  fs.rmSync(LOG, { force: true });
  assert.strictEqual(decision('rm -rf x # guardrail:confirmed reason="scratch build output"'), 'allow');
  const lines = fs.readFileSync(LOG, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.ok(lines.some((l) => l.event === 'bypass' && l.hook === 'deletion-guard' && /scratch/.test(l.reason)));
  assert.strictEqual(decision('rm -rf x # guardrail:confirmed'), 'deny');
  assert.strictEqual(decision('rm -rf x # guardrail:confirmed reason="short"'), 'deny');
  assert.ok(fs.readFileSync(LOG, 'utf8').includes('"event":"deny"'));
});
test('escape hatch: unwritable audit log means no bypass', () => {
  fs.writeFileSync(path.join(SANDBOX, 'file-not-dir'), 'x');
  const bad = path.join(SANDBOX, 'file-not-dir', 'x.jsonl');
  const r = call('rm -rf x # guardrail:confirmed reason="scratch build output"', { env: { GUARDRAIL_AUDIT_LOG: bad } });
  assert.strictEqual(r.decision, 'deny');
  assert.match(r.reason, /could not be logged/);
});

test('known false positive (documented): pattern inside an unexecuted string is blocked', () => {
  assert.strictEqual(decision('echo "rm -rf /"'), 'deny');
  assert.strictEqual(decision('git commit -m "drop rm -rf from docs"'), 'deny');
});
test('known limit (documented): variable flags and indirection are not seen', () => {
  assert.strictEqual(decision('F=-rf; rm $F target'), 'allow');
  assert.strictEqual(decision('rm -$flags target'), 'allow');
});

test('error handling: malformed input fails open, fail-closed mode denies', () => {
  assert.strictEqual(decision('', { raw: 'not json' }), 'allow');
  assert.strictEqual(decision('', { raw: 'not json', env: { GUARDRAIL_FAIL_CLOSED: '1' } }), 'deny');
});
