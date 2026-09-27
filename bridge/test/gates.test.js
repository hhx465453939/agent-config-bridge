/**
 * Gate tests.
 *
 * Two layers, tested separately on purpose:
 *
 *   1. the policy — pure logic, no harness. This is where the rules live, so
 *      this is where the rules are proven.
 *   2. the adapters — thin translators. Tested with a fake harness object, so
 *      "does pi's block shape come out right?" is answered without running pi.
 *
 *   node --test
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  DEFAULT_CONFIG,
  globToRegExp,
  hasFreshSignal,
  isCodeFile,
  isExcluded,
  loadPolicy,
  matchesAnyGlob,
  newSessionState,
  normalizePolicy,
  recordSignal,
  recordWrite,
  reminderFor,
  scanForSecrets,
  scopeOf,
  shouldBlock,
  findRepoRoot,
} from '../gates/policy.js';

import piGate from '../gates/pi/index.js';
import { apply as dshApply } from '../gates/dsh/index.js';

const noFs = () => false;

/**
 * The policy the adapter tests run with. `project_roots` is pinned to the fake
 * layout the tests use, so scoping is exercised for real rather than inherited
 * from whatever the shipped policy happens to say.
 */
const TEST_POLICY = {
  name: 'test-gate',
  reminder: 'ASK THE GRAPH FIRST',
  checks: ['graph-before-read'],
  config: {
    project_roots: ['/repo', '/work'],
    max_blocks_per_session: 3,
    signal_ttl_ms: 1000,
  },
};

const policy = normalizePolicy(TEST_POLICY);

const existsAlways = () => true;

const read = (path) => ({ action: 'read', path, tool: 'read' });
const write = (path, content) => ({ action: 'write', path, tool: 'write', content });

// ---------------------------------------------------------------------------
// path predicates
// ---------------------------------------------------------------------------

test('policy: glob translation handles ** and *', () => {
  assert.ok(globToRegExp('**/node_modules/**').test('/a/b/node_modules/c/d.js'));
  assert.ok(globToRegExp('**/node_modules/**').test('node_modules/x'));
  assert.ok(!globToRegExp('**/node_modules/**').test('/a/b/node_modules'));
  assert.ok(globToRegExp('/a/*/c.js').test('/a/b/c.js'));
  assert.ok(!globToRegExp('/a/*/c.js').test('/a/b/x/c.js'), '* must not cross separators');
});

test('policy: code files are recognised by extension, not by guesswork', () => {
  assert.ok(isCodeFile('/x/a.ts'));
  assert.ok(isCodeFile('/x/a.py'));
  assert.ok(!isCodeFile('/x/README.md'));
  assert.ok(!isCodeFile('/x/data.json'));
  assert.ok(isCodeFile('/x/Dockerfile'), 'extensionless names in the list are matched exactly');
  assert.ok(!isCodeFile('/x/Makefile.bak'));
});

test('policy: vendor trees stay out of scope', () => {
  assert.ok(isExcluded('/proj/node_modules/pkg/index.js'));
  assert.ok(isExcluded('/proj/vendor/x/y.py'));
  assert.ok(!isExcluded('/proj/src/index.js'));
});

test('policy: scoping prefers configured roots, and falls back to repo detection', () => {
  const config = { ...DEFAULT_CONFIG, project_roots: ['/work'] };
  assert.equal(scopeOf('/work/a/b.ts', { config, exists: noFs }).inScope, true);
  assert.equal(scopeOf('/elsewhere/b.ts', { config, exists: noFs }).inScope, false);
  assert.equal(scopeOf('/work/README.md', { config, exists: noFs }).inScope, false, 'non-code stays out');
  assert.equal(scopeOf('relative/path.ts', { config, exists: noFs }).inScope, false, 'relative paths are not scoped');

  // With no configured roots, a VCS marker decides.
  const bare = { ...DEFAULT_CONFIG, project_roots: [] };
  const existsGit = (p) => p === '/work/proj/.git';
  assert.equal(scopeOf('/work/proj/src/a.ts', { config: bare, exists: existsGit }).inScope, true);
  assert.equal(scopeOf('/tmp/loose/a.ts', { config: bare, exists: noFs }).inScope, false);
});

// ---------------------------------------------------------------------------
// the gate rule
// ---------------------------------------------------------------------------

test('gate: blocks a source read before any graph query', () => {
  const state = newSessionState();
  const verdict = shouldBlock({
    policy,
    input: read('/repo/src/a.ts'),
    state,
    exists: existsAlways,
    now: 1000,
  });
  assert.equal(verdict.block, true);
  assert.equal(verdict.code, 'GRAPH_FIRST');
  assert.match(verdict.reason, /may not be read before the code graph/);
});

test('gate: opens after a successful graph query', () => {
  const state = newSessionState();
  recordSignal(state, 1000);
  const verdict = shouldBlock({
    policy,
    input: read('/repo/src/a.ts'),
    state,
    exists: existsAlways,
    now: 1500,
  });
  assert.equal(verdict.block, false);
});

test('gate: a stale signal no longer counts', () => {
  const state = newSessionState();
  recordSignal(state, 1000);
  assert.equal(hasFreshSignal(state, 1000, 1500), true);
  assert.equal(hasFreshSignal(state, 1000, 5000), false);
  const verdict = shouldBlock({
    policy,
    input: read('/repo/src/a.ts'),
    state,
    exists: existsAlways,
    now: 9999,
  });
  assert.equal(verdict.block, true);
});

test('gate: reading a file this session wrote is always allowed', () => {
  const state = newSessionState();
  recordWrite(state, '/repo/src/new.ts');
  const verdict = shouldBlock({
    policy,
    input: read('/repo/src/new.ts'),
    state,
    exists: existsAlways,
    now: 1000,
  });
  assert.equal(verdict.block, false);
});

test('gate: non-code files and out-of-scope paths are never blocked', () => {
  const state = newSessionState();
  for (const input of [read('/repo/README.md'), read('/etc/hosts'), read('/repo/data.json')]) {
    const verdict = shouldBlock({ policy, input, state, exists: noFs, now: 1000 });
    assert.equal(verdict.block, false, `${input.path} should not be gated`);
  }
});

test('gate: stops blocking after the cap so a wrong rule cannot brick the agent', () => {
  const state = newSessionState();
  const args = { policy, state, exists: existsAlways, now: 1000 };
  assert.equal(shouldBlock({ ...args, input: read('/repo/a.ts') }).block, true);
  assert.equal(shouldBlock({ ...args, input: read('/repo/b.ts') }).block, true);
  assert.equal(shouldBlock({ ...args, input: read('/repo/c.ts') }).block, true);
  const fourth = shouldBlock({ ...args, input: read('/repo/d.ts') });
  assert.equal(fourth.block, false);
  assert.equal(fourth.capReached, true);
});

test('gate: an unknown check name is ignored rather than fatal', () => {
  const odd = normalizePolicy({ name: 'x', checks: ['no-such-check'], config: {} });
  const verdict = shouldBlock({
    policy: odd,
    input: read('/repo/a.ts'),
    state: newSessionState(),
    exists: noFs,
    now: 1,
  });
  assert.equal(verdict.block, false);
});

test('gate: index-marker check blocks only when the index is genuinely absent', () => {
  const indexPolicy = normalizePolicy({
    name: 'idx',
    checks: ['index-before-read'],
    config: { project_roots: [], signal_ttl_ms: 0 },
  });
  const state = newSessionState();
  const missing = shouldBlock({
    policy: indexPolicy,
    input: read('/repo/src/a.ts'),
    state,
    exists: (p) => p === '/repo/.git',
    now: 1,
  });
  assert.equal(missing.block, true);
  assert.equal(missing.code, 'INDEX_FIRST');

  const present = shouldBlock({
    policy: indexPolicy,
    input: read('/repo/src/a.ts'),
    state: newSessionState(),
    exists: (p) => p === '/repo/.git' || p === '/repo/.codebase-memory',
    now: 1,
  });
  assert.equal(present.block, false);
});

test('gate: write protection only fires when write_roots are configured', () => {
  const off = normalizePolicy({ name: 'w', checks: ['no-write-outside'], config: {} });
  assert.equal(
    shouldBlock({ policy: off, input: write('/etc/passwd', 'x'), state: newSessionState(), exists: noFs, now: 1 }).block,
    false,
  );

  const on = normalizePolicy({
    name: 'w',
    checks: ['no-write-outside'],
    config: { write_roots: ['/repo'] },
  });
  assert.equal(
    shouldBlock({ policy: on, input: write('/etc/passwd', 'x'), state: newSessionState(), exists: noFs, now: 1 }).block,
    true,
  );
  assert.equal(
    shouldBlock({ policy: on, input: write('/repo/a.ts', 'x'), state: newSessionState(), exists: noFs, now: 1 }).block,
    false,
  );
});

// ---------------------------------------------------------------------------
// secrets
// ---------------------------------------------------------------------------

test('gate: secret scanner catches the families the repo scanner catches', () => {
  // The fixture strings are assembled at runtime on purpose: a literal PEM
  // header or a 40-char token sitting in a source file is indistinguishable
  // from a real leak to any scanner, including this repository's own
  // scripts/scan-secrets.sh. Building them keeps the assertion honest and the
  // repository clean at the same time.
  const fakePem = ['-----BEGIN RSA', 'PRIVATE KEY-----'].join(' ');
  const fakeToken = 'a'.repeat(40);
  const fakeApiKey = `API_KEY = "${'b'.repeat(24)}"`;

  assert.ok(scanForSecrets(fakeApiKey).length > 0);
  assert.ok(scanForSecrets(fakePem).length > 0);
  assert.ok(scanForSecrets(fakeToken).length > 0);
  assert.equal(scanForSecrets('API_KEY = "${SOME_VAR}"').length, 0, 'placeholders are not secrets');
  assert.equal(scanForSecrets('contact: nobody@example.com').length, 0, 'example domains are allowed');
});

test('gate: writing a credential is blocked', () => {
  const strict = normalizePolicy({ name: 's', checks: ['no-secret-write'], config: {} });
  const verdict = shouldBlock({
    policy: strict,
    input: write('/repo/config.json', JSON.stringify({ token: 'a'.repeat(40) })),
    state: newSessionState(),
    exists: noFs,
    now: 1,
  });
  assert.equal(verdict.block, true);
  assert.equal(verdict.code, 'SECRET_WRITE');
});

// ---------------------------------------------------------------------------
// reminder
// ---------------------------------------------------------------------------

test('reminder: shown until the session complies, then silent', () => {
  const state = newSessionState();
  assert.equal(reminderFor(policy, state, 1000), 'ASK THE GRAPH FIRST');
  recordSignal(state, 1000);
  assert.equal(reminderFor(policy, state, 1000), null);
});

// ---------------------------------------------------------------------------
// policy loading
// ---------------------------------------------------------------------------

test('policy: a broken file fails open with a readable reason', () => {
  const dir = mkdtempSync(join(tmpdir(), 'acb-policy-'));
  try {
    const bad = join(dir, 'policy.json');
    writeFileSync(bad, '{ not json');
    const result = loadPolicy(bad);
    assert.equal(result.ok, false);
    assert.match(result.error, /not valid JSON|Unexpected|JSON/);

    const missing = loadPolicy(join(dir, 'nope.json'));
    assert.equal(missing.ok, false);

    mkdirSync(join(dir, 'sub'));
    const good = join(dir, 'sub', 'policy.json');
    writeFileSync(good, JSON.stringify({ name: 'ok', checks: ['graph-before-read'], config: {} }));
    const loaded = loadPolicy(good);
    assert.equal(loaded.ok, true);
    assert.equal(loaded.policy.name, 'ok');
    assert.deepEqual(loaded.policy.checks, ['graph-before-read']);
    assert.ok(loaded.policy.config.max_blocks_per_session >= 0, 'defaults are filled in');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('policy: both shipped policy files load and enable the graph rule', () => {
  for (const harness of ['pi', 'dsh']) {
    const file = new URL(`../gates/${harness}/policy.json`, import.meta.url);
    const loaded = loadPolicy(file);
    assert.equal(loaded.ok, true, `${harness} policy.json failed to load: ${loaded.error}`);
    assert.ok(
      loaded.policy.checks.includes('graph-before-read'),
      `${harness} policy must enable graph-before-read`,
    );
  }
});

// ---------------------------------------------------------------------------
// adapters
// ---------------------------------------------------------------------------

/** Minimal stand-in for pi's ExtensionAPI: record handlers, invoke them by name. */
const fakePi = () => {
  const handlers = new Map();
  const notifications = [];
  const pi = {
    on(event, handler) {
      handlers.set(event, handler);
      return () => handlers.delete(event);
    },
  };
  return {
    pi,
    notifications,
    call: (event, payload, ctx = { hasUI: true, ui: { notify: (...a) => notifications.push(a) } }) =>
      handlers.get(event)(payload, ctx),
    has: (event) => handlers.has(event),
  };
};

test('pi adapter: registers on tool_call, tool_result and context', () => {
  const { pi, has } = fakePi();
  piGate(pi, { policy: TEST_POLICY });
  assert.ok(has('tool_call'));
  assert.ok(has('tool_result'));
  assert.ok(has('context'));
});

test('pi adapter: blocks a source read, then allows it after a graph result', async () => {
  const { pi, call } = fakePi();
  piGate(pi, { policy: TEST_POLICY });

  const blocked = await call('tool_call', { toolName: 'read', input: { path: '/repo/src/a.ts' } });
  assert.equal(blocked?.block, true);
  assert.match(blocked.reason, /graph/i);

  // A failed graph query must NOT open the gate.
  await call('tool_result', { toolName: 'search_graph', isError: true });
  const stillBlocked = await call('tool_call', { toolName: 'read', input: { path: '/repo/src/b.ts' } });
  assert.equal(stillBlocked?.block, true);

  // A successful one does.
  await call('tool_result', { toolName: 'search_graph', isError: false });
  const allowed = await call('tool_call', { toolName: 'read', input: { path: '/repo/src/b.ts' } });
  assert.equal(allowed, undefined, 'once the gate opens, the handler abstains');

  // Reads outside the sandbox repo, and non-code files, are never blocked.
  assert.equal(await call('tool_call', { toolName: 'read', input: { path: '/repo/README.md' } }), undefined);
});

test('pi adapter: a session start resets the block counter', async () => {
  const { pi, call } = fakePi();
  piGate(pi, { policy: TEST_POLICY });
  await call('session_start', {});
  for (let i = 0; i < 3; i += 1) {
    await call('tool_call', { toolName: 'read', input: { path: `/repo/src/${i}.ts` } });
  }
  // Fourth is allowed by the cap.
  assert.equal(await call('tool_call', { toolName: 'read', input: { path: '/repo/src/z.ts' } }), undefined);
  await call('session_start', {});
  const blockedAgain = await call('tool_call', { toolName: 'read', input: { path: '/repo/src/z2.ts' } });
  assert.equal(blockedAgain?.block, true, 'a new session starts enforcing again');
});

test('pi adapter: injects the reminder into the last user message only while needed', async () => {
  const { pi, call } = fakePi();
  piGate(pi, { policy: TEST_POLICY });

  const messages = [{ role: 'user', content: 'please fix the bug' }];
  const injected = await call('context', { messages });
  assert.equal(injected.messages.length, 1);
  assert.match(String(injected.messages[0].content), /ASK THE GRAPH FIRST/);

  // After compliance the reminder disappears, so a compliant session is not nagged.
  await call('tool_result', { toolName: 'trace_path', isError: false });
  const quiet = await call('context', { messages: [{ role: 'user', content: 'more' }] });
  assert.equal(quiet, undefined);
});

/** Minimal stand-in for a dsh cordis context. */
const fakeDshCtx = () => {
  const handlers = new Map();
  const logger = { warn() {} };
  return {
    ctx: {
      logger,
      on(event, handler) {
        handlers.set(event, handler);
        return () => handlers.delete(event);
      },
    },
    run: (name, args, next = async () => ({ kind: 'allow' })) =>
      handlers.get('tools/pre-execute')({ name, arguments: args }, next),
  };
};

test('dsh adapter: denies with the dsh decision shape', async () => {
  const { ctx, run } = fakeDshCtx();
  dshApply(ctx, { policy: TEST_POLICY });

  const denied = await run('read', { file_path: '/repo/src/a.ts' });
  assert.equal(denied.kind, 'deny');
  assert.match(denied.reason, /graph/i);

  assert.deepEqual(await run('read', { file_path: '/repo/README.md' }), { kind: 'allow' });
});

test('dsh adapter: a graph query opens the gate for subsequent reads', async () => {
  const { ctx, run } = fakeDshCtx();
  dshApply(ctx, { policy: TEST_POLICY });

  await run('search_graph', { name_pattern: '.*' });
  assert.deepEqual(await run('read', { file_path: '/repo/src/a.ts' }), { kind: 'allow' });
});

test('dsh adapter: delegates to next() for tools it does not police', async () => {
  const { ctx, run } = fakeDshCtx();
  dshApply(ctx, { policy: TEST_POLICY });
  let delegated = false;
  const result = await run('bash', { command: 'ls' }, async () => {
    delegated = true;
    return { kind: 'allow' };
  });
  assert.equal(delegated, true, 'bash must reach the next listener untouched');
  assert.deepEqual(result, { kind: 'allow' });
});

test('dsh adapter: write tools are recorded so reading them back is allowed', async () => {
  const { ctx, run } = fakeDshCtx();
  dshApply(ctx, { policy: TEST_POLICY });
  await run('write', { file_path: '/repo/src/fresh.ts', content: 'x' });
  assert.deepEqual(await run('read', { file_path: '/repo/src/fresh.ts' }), { kind: 'allow' });
});
