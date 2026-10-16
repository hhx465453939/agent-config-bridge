/**
 * Gate policy tests — the strengthened Layer-1 rules (v2, 2026-10-16).
 *
 * Why these tests exist
 * ---------------------
 * The original gate looked enforced but was not: a single successful graph
 * query unlocked an hour of free reading, bash reads (`cat`, `grep`,
 * `sed -n`, `python -c "open(...)"`) were not gated at all, and three blocks
 * ended enforcement for the rest of the session. Everything here pins one of
 * those holes shut, in the same spirit as the repo's other gate tests: pure
 * engine, injected filesystem probes, nothing touches disk.
 *
 *   node --test bridge/test/gate-policy.test.js
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';

import {
  DEFAULT_CONFIG,
  bashReadTargets,
  hasUnlock,
  loadPolicy,
  newSessionState,
  normalizePath,
  policyFromObject,
  recordSignal,
  recordUnlocks,
  shouldBlock,
  unlockTokensFromText,
} from '../gates/policy.js';

const WIN32 = process.platform === 'win32';
const ROOT = WIN32 ? 'C:\\repo' : '/repo';
const FILE = join(ROOT, 'packages', 'xyb', 'client.js');
const OTHER = join(ROOT, 'packages', 'other', 'index.js');
const NOTE = join(ROOT, 'notes.txt');

const TTL = 600_000; // signal window
const UNLOCK_TTL = 1_800_000; // scoped unlock window

const policy = (overrides = {}) =>
  policyFromObject({
    name: 'test-gate',
    checks: ['graph-before-read', 'bash-graph-before-read'],
    config: {
      max_blocks_per_session: 5,
      signal_ttl_ms: TTL,
      unlock_ttl_ms: UNLOCK_TTL,
      ...overrides,
    },
  }).policy;

const fs = {
  exists: (p) => p === join(ROOT, '.git') || p === FILE || p === OTHER,
  isFile: (p) => p === FILE || p === OTHER,
  statMtime: () => 0,
  listDir: () => [],
};

const readVerdict = (path, state = newSessionState(), now = Date.now(), p = policy()) =>
  shouldBlock({ policy: p, state, input: { action: 'read', path, tool: 'read' }, fs, now });

const bashVerdict = (command, state = newSessionState(), now = Date.now(), p = policy()) =>
  shouldBlock({
    policy: p,
    state,
    input: { action: 'bash', command, cwd: ROOT, tool: 'bash' },
    fs,
    now,
  });

// ---------------------------------------------------------------------------
// read: the short session window + scoped unlocks
// ---------------------------------------------------------------------------

test('read: blocked before any graph query', () => {
  const verdict = readVerdict(FILE);
  assert.equal(verdict.block, true);
  assert.equal(verdict.code, 'GRAPH_FIRST');
  assert.match(verdict.reason, /Layer 1/);
});

test('read: allowed right after a successful graph query', () => {
  const state = newSessionState();
  const t0 = 1_000_000;
  recordSignal(state, t0);
  assert.equal(readVerdict(FILE, state, t0 + 1000).block, false);
});

test('read: blocked again once the session window expires', () => {
  const state = newSessionState();
  const t0 = 1_000_000;
  recordSignal(state, t0);
  // one ms past the window: the old design allowed a full hour here
  const verdict = readVerdict(FILE, state, t0 + TTL + 1);
  assert.equal(verdict.block, true);
  assert.equal(verdict.code, 'GRAPH_FIRST');
});

test('read: a scoped unlock survives the session window, but only for what it named', () => {
  const state = newSessionState();
  const t0 = 1_000_000;
  // A query that mentioned packages/xyb/client.js — recorded as unlocks, no
  // session-wide signal at all.
  recordUnlocks(state, unlockTokensFromText('packages/xyb/client.js'), t0);

  const afterWindow = t0 + TTL + 1;
  assert.equal(readVerdict(FILE, state, afterWindow).block, false, 'named file stays readable');
  assert.equal(readVerdict(OTHER, state, afterWindow).block, true, 'unrelated file still needs a query');

  const afterUnlockWindow = t0 + UNLOCK_TTL + 1;
  assert.equal(readVerdict(FILE, state, afterUnlockWindow).block, true, 'unlock itself expires');
});

test('unlockTokensFromText: keeps path suffixes, drops generic directories', () => {
  const tokens = unlockTokensFromText('found E:/Development/app/packages/dsh-xyb-workbench/client.js');
  assert.ok(tokens.includes('client.js'), 'basename is kept');
  assert.ok(tokens.includes('packages/dsh-xyb-workbench/client.js'), 'the tail suffix is kept');
  assert.ok(tokens.includes('dsh-xyb-workbench'), 'the specific parent is kept');
  assert.ok(!tokens.includes('packages'), 'a generic directory is not an unlock');
  assert.ok(!tokens.includes('development'), 'a generic parent is not an unlock');
});

test('hasUnlock: false for short tokens and stale entries', () => {
  const state = newSessionState();
  recordUnlocks(state, ['a', 'js'], 1);
  assert.equal(state.unlocks.size, 0, 'tokens under the minimum length are dropped');
  recordUnlocks(state, ['packages/xyb/client.js'], 1);
  assert.equal(hasUnlock(state, FILE, policy().config, UNLOCK_TTL + 2), false, 'stale unlock is not fresh');
});

// ---------------------------------------------------------------------------
// bash: reading source through the shell is the same act
// ---------------------------------------------------------------------------

test('bash: cat on a code file is blocked exactly like a read', () => {
  const verdict = bashVerdict(`cat "${FILE}"`);
  assert.equal(verdict.block, true);
  assert.equal(verdict.code, 'GRAPH_FIRST_BASH');
  assert.match(verdict.reason, /cat/);
});

test('bash: grep and sed -n are blocked too', () => {
  assert.equal(bashVerdict(`grep -n "foo" "${FILE}"`).block, true);
  assert.equal(bashVerdict(`sed -n '1,20p' "${FILE}"`).block, true);
});

test('bash: non-reading commands pass untouched', () => {
  assert.equal(bashVerdict('git status --short').block, false);
  assert.equal(bashVerdict('ls -la packages').block, false);
  assert.equal(bashVerdict('node scripts/build.mjs').block, false, 'executing a script is not reading it');
});

test('bash: non-code files pass', () => {
  assert.equal(bashVerdict(`cat "${NOTE}"`).block, false);
});

test('bash: a file this session wrote is readable back', () => {
  const state = newSessionState();
  state.written.add(normalizePath(FILE));
  assert.equal(bashVerdict(`cat "${FILE}"`, state).block, false);
});

test('bash: allowed after the graph named the file', () => {
  const state = newSessionState();
  const t0 = 1_000_000;
  recordUnlocks(state, unlockTokensFromText('packages/xyb/client.js'), t0);
  assert.equal(bashVerdict(`cat "${FILE}"`, state, t0 + 1000).block, false);
});

test('bashReadTargets: quotes, options, chains; globs are skipped', () => {
  const targets = bashReadTargets(`head -n 20 "packages/xyb/client.js" && grep -c x packages/xyb/*.js`, {
    config: DEFAULT_CONFIG,
    cwd: ROOT,
    isFile: fs.isFile,
    exists: fs.exists,
  }).map((t) => normalizePath(t));
  assert.deepEqual(targets, [normalizePath(FILE)]);
});

test('bashReadTargets: a read call inside a one-liner counts', () => {
  const targets = bashReadTargets(`python -c "print(open('packages/xyb/client.js').read())"`, {
    config: DEFAULT_CONFIG,
    cwd: ROOT,
    isFile: fs.isFile,
    exists: fs.exists,
  }).map((t) => normalizePath(t));
  assert.deepEqual(targets, [normalizePath(FILE)]);
});

// ---------------------------------------------------------------------------
// the block cap: raise it, but keep a bound
// ---------------------------------------------------------------------------

test('cap: blocks up to the policy cap, then reports capReached instead of blocking', () => {
  const p = policy({ max_blocks_per_session: 1 });
  const state = newSessionState();
  const first = readVerdict(FILE, state, Date.now(), p);
  assert.equal(first.block, true);
  const second = readVerdict(FILE, state, Date.now(), p);
  assert.equal(second.block, false);
  assert.equal(second.capReached, true);
});

test('shipped policies: the strengthened values are actually in the JSON', () => {
  const pi = loadPolicy(new URL('../gates/pi/policy.json', import.meta.url)).policy;
  const dsh = loadPolicy(new URL('../gates/dsh/policy.json', import.meta.url)).policy;
  for (const p of [pi, dsh]) {
    assert.ok(p.config.max_blocks_per_session >= 10, `${p.name}: block cap must not give up early`);
    assert.ok(
      p.config.signal_ttl_ms <= 15 * 60 * 1000,
      `${p.name}: the session window must stay short (one query must not buy an hour)`,
    );
    assert.ok(
      p.config.unlock_ttl_ms >= p.config.signal_ttl_ms,
      `${p.name}: a named-target unlock is stronger evidence than a session signal`,
    );
    assert.equal(p.config.bash_read_check, true, `${p.name}: bash reads must be gated`);
    assert.ok(p.checks.includes('bash-graph-before-read'), `${p.name}: bash check must be enabled`);
  }
  assert.ok(pi.checks.includes('index-freshness-before-read'), 'pi keeps the Layer-2 checks');
});
