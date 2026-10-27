/**
 * v4 policy tests — turn-level anti-slack, expiring evidence, working Layer 2,
 * sliding block cap, PowerShell coverage, and false-positive hardening.
 *
 *   node --test bridge/test/gate-v4.test.js
 *
 * Fixture credentials are built by concatenation on purpose: the gate scans the
 * literal text being written, and shipping a complete key/email/password
 * spelling in a source file is exactly what the secret rule exists to stop.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';

import {
  DEFAULT_CONFIG,
  isCodeFile,
  newSessionState,
  normalizePath,
  policyFromObject,
  powershellDestructiveFinding,
  powershellReadTargets,
  powershellWriteTargets,
  recordIndexRefresh,
  recordInspection,
  scanForSecrets,
  shouldBlock,
  slackFinding,
} from '../gates/policy.js';

const WIN32 = process.platform === 'win32';
const ROOT = normalizePath(WIN32 ? 'C:\\repo' : '/repo');
const FILE = join(ROOT, 'src', 'a.js');
const OTHER = join(ROOT, 'src', 'b.js');
const BRIDGE_FILE = join(ROOT, 'bridge', 'x.js');
const DOC_FILE = join(ROOT, 'docs', 'x.js');
const TASKS = join(ROOT, 'tasks');
const CHG = join(TASKS, 'CHG-001-demo');

// Split so the repository never contains a complete credential-shaped literal.
const MAIL = 'someone@' + 'corp.tld';
const PASSWORD_ASSIGNMENT = 'password=' + 'abcdefghijklmnop1234';
const PRIVATE_KEY = '-----BEGIN RSA ' + 'PRIVATE KEY-----';

const dirs = new Set([ROOT, join(ROOT, '.git'), join(ROOT, 'src'), join(ROOT, 'bridge'), join(ROOT, 'docs'), TASKS, CHG].map(normalizePath));
const files = new Set([FILE, OTHER, BRIDGE_FILE, DOC_FILE].map(normalizePath));

const fs = {
  exists: (p) => dirs.has(normalizePath(p)) || files.has(normalizePath(p)),
  isFile: (p) => files.has(normalizePath(p)),
  statMtime: () => 0,
  listDir: (p) => (normalizePath(p) === normalizePath(TASKS) ? ['CHG-001-demo'] : []),
};

const withMtime = (mtime) => ({ ...fs, statMtime: () => mtime });

const policy = (checks, config = {}) =>
  policyFromObject({
    name: 'v4-test',
    checks,
    config: {
      project_roots: [],
      exclude_globs: [],
      index_mtime_epsilon_ms: 0,
      index_mtime_ttl_ms: 0,
      ...config,
    },
  }).policy;

// ---------------------------------------------------------------------------
// P0-2: read evidence expires
// ---------------------------------------------------------------------------

test('think-before-write: a read expires after inspected_ttl_ms', () => {
  const p = policy(['think-before-write'], {
    require_target_evidence: true,
    require_conventions: false,
    inspected_ttl_ms: 1000,
  });
  const state = newSessionState();
  const t0 = 1_000_000;
  recordInspection(state, FILE, t0);

  const edit = (now) =>
    shouldBlock({ policy: p, state, input: { action: 'write', path: FILE, tool: 'edit', content: 'x' }, fs, now });

  assert.equal(edit(t0 + 500).block, false, 'inside the window the read still counts');
  const stale = edit(t0 + 1001);
  assert.equal(stale.block, true, 'after the window the edit needs new evidence');
  assert.equal(stale.code, 'THINK_TARGET');
});

test('think-before-write: -1 keeps the old never-expire behaviour', () => {
  const p = policy(['think-before-write'], {
    require_target_evidence: true,
    require_conventions: false,
    inspected_ttl_ms: -1,
  });
  const state = newSessionState();
  recordInspection(state, FILE, 1);
  const verdict = shouldBlock({
    policy: p,
    state,
    input: { action: 'write', path: FILE, tool: 'edit', content: 'x' },
    fs,
    now: 999_999_999,
  });
  assert.equal(verdict.block, false);
});

// ---------------------------------------------------------------------------
// P0-3: Layer 2 works without a repo-local marker
// ---------------------------------------------------------------------------

test('index-freshness: file newer than the session index refresh is stale', () => {
  const p = policy(['index-freshness-before-read'], { index_marker: '.codebase-memory' });
  const state = newSessionState();
  const t0 = 1_000_000;
  recordIndexRefresh(state, t0);

  const read = (mtime) =>
    shouldBlock({
      policy: p,
      state,
      input: { action: 'read', path: FILE, tool: 'read' },
      fs: withMtime(mtime),
      now: t0 + 10,
    });

  assert.equal(read(t0 - 1000).block, false, 'older than the refresh: fresh enough');
  const stale = read(t0 + 1000);
  assert.equal(stale.block, true, 'newer than the refresh: re-index first');
  assert.equal(stale.code, 'INDEX_STALE');
});

test('index-freshness: no marker and no refresh evidence abstains', () => {
  const p = policy(['index-freshness-before-read'], { index_marker: '.codebase-memory' });
  const verdict = shouldBlock({
    policy: p,
    state: newSessionState(),
    input: { action: 'read', path: FILE, tool: 'read' },
    fs: withMtime(2_000_000),
    now: 1_000_000,
  });
  assert.equal(verdict.block, false, 'cannot prove staleness, so do not guess');
});

// ---------------------------------------------------------------------------
// P0-4: the cap is a sliding window
// ---------------------------------------------------------------------------

test('block cap: research rules resume after block_cap_reset_ms', () => {
  const p = policy(['graph-before-read'], {
    max_blocks_per_session: 2,
    block_cap_reset_ms: 1000,
    signal_ttl_ms: 0,
  });
  const state = newSessionState();
  const t0 = 1_000_000;
  const read = (now) =>
    shouldBlock({ policy: p, state, input: { action: 'read', path: FILE, tool: 'read' }, fs, now });

  assert.equal(read(t0).block, true);
  assert.equal(read(t0 + 1).block, true);
  const over = read(t0 + 2);
  assert.equal(over.block, false, 'cap reached: research rule stands down');
  assert.equal(over.capReached, true);
  assert.equal(read(t0 + 1002).block, true, 'window elapsed: rule is back');
  assert.equal(state.blocks, 1);
});

test('block cap: safety checks ignore the cap', () => {
  const p = policy(['no-secret-write'], { max_blocks_per_session: 0 });
  const verdict = shouldBlock({
    policy: p,
    state: newSessionState(),
    input: { action: 'write', path: FILE, tool: 'edit', content: PRIVATE_KEY },
    fs,
  });
  assert.equal(verdict.block, true);
  assert.equal(verdict.code, 'SECRET_WRITE');
});

// ---------------------------------------------------------------------------
// P0-1: turn-level anti-slack
// ---------------------------------------------------------------------------

test('slackFinding: first-person deferral is caught', () => {
  const p = policy([]);
  assert.equal(slackFinding('这个我稍后再补完。', p)?.code, 'NO_SLACK');
  assert.equal(slackFinding('我暂时不做这个部分，先跳过。', p)?.code, 'NO_SLACK');
  assert.equal(slackFinding('后续再处理这个问题。', p)?.code, 'NO_SLACK');
});

test('slackFinding: ordinary advice and code are not deferrals', () => {
  const p = policy([]);
  assert.equal(slackFinding('下一步你可以运行 node --test 看结果。', p), null);
  assert.equal(slackFinding('```\nTODO: implement later\n```', p), null);
  assert.equal(slackFinding('> 稍后再做\n', p), null);
});

// ---------------------------------------------------------------------------
// P1: PowerShell
// ---------------------------------------------------------------------------

const psOpts = { config: { ...DEFAULT_CONFIG, project_roots: [], exclude_globs: [] }, cwd: ROOT, isFile: fs.isFile, exists: fs.exists };

test('powershell: Get-Content / Select-String are reads', () => {
  assert.deepEqual(powershellReadTargets(`Get-Content "${FILE}"`, psOpts), [FILE]);
  assert.deepEqual(powershellReadTargets(`Select-String -Pattern foo -Path "${FILE}"`, psOpts), [FILE]);
});

test('powershell: Set-Content / Out-File / Copy-Item are writes', () => {
  assert.deepEqual(powershellWriteTargets(`Set-Content -Path "${FILE}" -Value "x"`, psOpts), [FILE]);
  assert.deepEqual(powershellWriteTargets(`Out-File "${FILE}"`, psOpts), [FILE]);
  assert.deepEqual(powershellWriteTargets(`Copy-Item "${OTHER}" "${FILE}"`, psOpts), [FILE]);
});

test('powershell: Remove-Item -Recurse is destructive', () => {
  const finding = powershellDestructiveFinding(`Remove-Item -Recurse -Force "${join(ROOT, 'src')}"`, psOpts);
  assert.ok(finding, 'recursive removal of a source directory must be caught');
});

// ---------------------------------------------------------------------------
// P1: code extensions
// ---------------------------------------------------------------------------

test('code_extensions: config and notebook files are code', () => {
  assert.equal(isCodeFile(join(ROOT, 'ci.yml')), true);
  assert.equal(isCodeFile(join(ROOT, 'analysis.ipynb')), true);
  assert.equal(isCodeFile(join(ROOT, 'main.ps1')), true);
});

// ---------------------------------------------------------------------------
// P2: false positives and CHG scoping
// ---------------------------------------------------------------------------

test('secrets: a bare mailbox is prose, a credential-context mailbox is not', () => {
  const config = { ...DEFAULT_CONFIG, secret_allow_patterns: ['example\\.com', '<[^<>\\s]+>'] };
  assert.deepEqual(scanForSecrets(`contact me at ${MAIL}`, config), []);
  assert.ok(scanForSecrets(`password: ${MAIL}`, config).length > 0);
  assert.ok(scanForSecrets(PASSWORD_ASSIGNMENT, config).length > 0);
});

test('chg contract: scope globs narrow which paths need a contract', () => {
  const p = policy(['chg-contract-before-edit'], {
    require_chg_contract: true,
    chg_contract_scope_globs: ['**/bridge/**'],
  });
  const state = newSessionState();
  const edit = (path) =>
    shouldBlock({ policy: p, state, input: { action: 'write', path, tool: 'edit', content: 'x' }, fs });

  assert.equal(edit(DOC_FILE).block, false, 'outside the governed tree');
  const governed = edit(BRIDGE_FILE);
  assert.equal(governed.block, true, 'inside the governed tree');
  assert.equal(governed.code, 'CHG_CONTRACT');
});
