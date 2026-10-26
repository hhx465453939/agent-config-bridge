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
  HARD_CHECKS,
  bashDestructiveFinding,
  bashReadDirs,
  bashReadTargets,
  bashWriteTargets,
  graphResultIsEvidence,
  hasUnlock,
  isConventionDoc,
  loadPolicy,
  newSessionState,
  normalizePath,
  policyFromObject,
  recordCommandResult,
  recordDocRead,
  recordInspection,
  recordSignal,
  recordUnlocks,
  recordWrite,
  shouldBlock,
  unlockTokensFromQualifiedName,
  unlockTokensFromText,
} from '../gates/policy.js';

const WIN32 = process.platform === 'win32';
// Normalise the fixture root the same way the policy normalises tool paths.
// Without this, a Windows `C:\repo` fixture and a lower-cased `c:\repo\…`
// target are two different strings to the fake filesystem, and the tests stop
// reaching the code they were written to check.
const ROOT = normalizePath(WIN32 ? 'C:\\repo' : '/repo');
const FILE = join(ROOT, 'packages', 'xyb', 'client.js');
const OTHER = join(ROOT, 'packages', 'other', 'index.js');
const NOTE = join(ROOT, 'notes.txt');
const AGENTS = join(ROOT, 'AGENTS.md');

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

const FS_DIRS = new Set(
  [ROOT, join(ROOT, '.git'), join(ROOT, 'packages'), join(ROOT, 'packages', 'xyb')].map((p) => normalizePath(p)),
);
const FS_FILES = new Set([FILE, OTHER].map((p) => normalizePath(p)));

const fs = {
  exists: (p) => FS_DIRS.has(normalizePath(p)) || FS_FILES.has(normalizePath(p)),
  isFile: (p) => FS_FILES.has(normalizePath(p)),
  statMtime: () => 0,
  listDir: () => [],
};

/** The same layout plus one convention document, for the Layer-0 checks. */
const conventionFs = {
  ...fs,
  exists: (p) => normalizePath(p) === normalizePath(AGENTS) || fs.exists(p),
  isFile: (p) => normalizePath(p) === normalizePath(AGENTS) || fs.isFile(p),
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

test('bashReadTargets: quotes, options, chains; globs are gated too', () => {
  const targets = bashReadTargets(`head -n 20 "packages/xyb/client.js" && grep -c x packages/xyb/*.js`, {
    config: DEFAULT_CONFIG,
    cwd: ROOT,
    isFile: fs.isFile,
    exists: fs.exists,
  }).map((t) => normalizePath(t));
  assert.deepEqual(targets, [normalizePath(FILE), normalizePath(join(ROOT, 'packages', 'xyb', '*.js'))]);
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
  assert.ok(pi.checks.includes('think-before-write'), 'pi enables the Layer-0 write rule');
  assert.ok(pi.checks.includes('no-destructive-bash'), 'pi enables the destructive-command rule');
  assert.ok(pi.checks.includes('no-blind-retry'), 'pi enables the blind-retry rule');
  assert.equal(pi.config.graph_signal_requires_content, true, 'pi verifies graph results have content');
  assert.equal(pi.config.require_conventions, true, 'pi asks for the project conventions');
  assert.ok(!pi.checks.includes('index-before-read'), 'a global index has no marker, so the check is opt-in');
  assert.equal(dsh.config.graph_signal_requires_content, false, 'dsh cannot see results; its asymmetry is documented');
  assert.ok(dsh.checks.includes('bash-graph-before-read'), 'dsh now actually wires bash reads to the policy');
  assert.ok(dsh.checks.includes('no-destructive-bash'), 'dsh keeps the safety rule');
});

// ---------------------------------------------------------------------------
// v3: Layer 0 (think before acting) and the safety cap
// ---------------------------------------------------------------------------

test('cap: safety checks keep running after the research cap', () => {
  const p = policyFromObject({
    name: 'safety',
    checks: ['no-secret-write', 'graph-before-read'],
    config: { max_blocks_per_session: 0 },
  }).policy;
  const state = newSessionState();
  const secret = `API_KEY = "${'b'.repeat(24)}"`;
  const write = shouldBlock({
    policy: p,
    state,
    input: { action: 'write', path: join(ROOT, 'config.js'), tool: 'write', content: secret },
    fs,
    now: 1,
  });
  assert.equal(write.block, true, 'a credential write must not be excused by the cap');
  assert.equal(write.code, 'SECRET_WRITE');
  const read = readVerdict(FILE, state, 1, p);
  assert.equal(read.block, false, 'the research rule is capped');
  assert.equal(read.capReached, true);
  assert.deepEqual(
    [...HARD_CHECKS].sort(),
    ['chg-contract-before-edit', 'no-destructive-bash', 'no-secret-write', 'no-write-outside'],
  );
});

test('ai-spec: 改代码前未读 CHG 契约则拦，读过 SPEC 才放行', () => {
  const p = policyFromObject({
    name: 'chg-gate',
    checks: ['chg-contract-before-edit'],
    config: {
      project_roots: [ROOT],
      require_chg_contract: true,
      require_target_evidence: false,
      require_conventions: false,
      max_blocks_per_session: 10,
      chg_contract_globs: ['**/tasks/chg-*/spec.md'],
    },
  }).policy;
  const w = (state, path = FILE) =>
    shouldBlock({
      policy: p,
      state,
      input: { action: 'write', path, tool: 'edit', content: 'x' },
      fs,
      now: 1_000_000,
    });

  const bare = w(newSessionState());
  assert.equal(bare.block, true, '未读 CHG 契约必须拦');
  assert.equal(bare.code, 'CHG_CONTRACT');

  // 读约定文档不算读 CHG 契约：两者是不同问题（怎么做事 vs 这次做什么）
  const docs = newSessionState();
  recordDocRead(docs, AGENTS, 1_000_000);
  assert.equal(w(docs).code, 'CHG_CONTRACT', '读 AGENTS.md ≠ 读 CHG 契约');

  // 读了该 CHG 的 SPEC 才放行
  const ok = newSessionState();
  recordDocRead(ok, join(ROOT, 'tasks', 'CHG-001-foo', 'SPEC.md'), 1_000_000);
  assert.equal(w(ok).block, false, '读过 SPEC 即放行');

  // 非代码文件不受约束：改 notes.txt 不要求 CHG 契约
  const note = w(newSessionState(), NOTE);
  assert.equal(note.block, false, '非代码文件不要求 CHG 契约');

  // 关闭开关时完全不拦
  const off = policyFromObject({
    name: 'chg-off',
    checks: ['chg-contract-before-edit'],
    config: { project_roots: [ROOT], require_chg_contract: false },
  }).policy;
  const offRes = shouldBlock({
    policy: off,
    state: newSessionState(),
    input: { action: 'write', path: FILE, tool: 'edit', content: 'x' },
    fs,
    now: 1_000_000,
  });
  assert.equal(offRes.block, false, 'require_chg_contract=false 时不拦');
});

test('think: an existing file needs a read or a scoped graph hit, not a session signal', () => {
  const p = policyFromObject({
    name: 'think',
    checks: ['think-before-write'],
    config: {
      project_roots: [ROOT],
      require_target_evidence: true,
      require_conventions: false,
      max_blocks_per_session: 10,
      signal_ttl_ms: TTL,
    },
  }).policy;
  const w = (state) =>
    shouldBlock({
      policy: p,
      state,
      input: { action: 'write', path: FILE, tool: 'edit', content: 'x' },
      fs,
      now: 1_000_000,
    });

  assert.equal(w(newSessionState()).code, 'THINK_TARGET', 'no evidence at all');

  const signalOnly = newSessionState();
  recordSignal(signalOnly, 1_000_000);
  assert.equal(w(signalOnly).code, 'THINK_TARGET', 'a query about something else is not evidence about this file');

  const inspected = newSessionState();
  recordInspection(inspected, FILE, 1_000_000);
  assert.equal(w(inspected).block, false, 'a read of the exact file is evidence');

  const graphed = newSessionState();
  recordUnlocks(graphed, unlockTokensFromText('packages/xyb/client.js'), 1_000_000);
  assert.equal(w(graphed).block, false, 'a graph hit naming the file is evidence');

  const own = newSessionState();
  recordWrite(own, FILE);
  assert.equal(w(own).block, false, 'the session own file stays editable');

  const freshFile = shouldBlock({
    policy: p,
    state: newSessionState(),
    input: { action: 'write', path: join(ROOT, 'packages', 'xyb', 'new.js'), tool: 'write', content: 'x' },
    fs,
    now: 1_000_000,
  });
  assert.equal(freshFile.block, false, 'a new file has nothing to inspect; do not brick greenfield work');
});

test('think: project conventions are required when they exist', () => {
  const p = policyFromObject({
    name: 'think',
    checks: ['think-before-write'],
    config: {
      project_roots: [ROOT],
      require_target_evidence: false,
      require_conventions: true,
      convention_files: ['AGENTS.md'],
      signal_ttl_ms: 0,
    },
  }).policy;
  const state = newSessionState();
  const call = (s) =>
    shouldBlock({
      policy: p,
      state: s,
      input: { action: 'write', path: FILE, tool: 'edit', content: 'x' },
      fs: conventionFs,
      now: 1,
    });
  assert.equal(call(state).code, 'THINK_CONVENTIONS');
  recordDocRead(state, AGENTS, 2);
  assert.equal(call(state).block, false, 'reading the convention document satisfies the rule');

  // A repository without conventions is not punished for it.
  const noDocs = policyFromObject({
    name: 'think',
    checks: ['think-before-write'],
    config: { project_roots: [ROOT], require_target_evidence: false, require_conventions: true },
  }).policy;
  assert.equal(
    shouldBlock({
      policy: noDocs,
      state: newSessionState(),
      input: { action: 'write', path: FILE, tool: 'edit', content: 'x' },
      fs,
      now: 1,
    }).block,
    false,
  );
});

test('bash writes: redirection secrets and outside roots are hard-blocked', () => {
  const secret = `API_KEY = "${'b'.repeat(24)}"`;
  const secretPolicy = policyFromObject({ name: 's', checks: ['no-secret-write'], config: {} }).policy;
  const secretVerdict = shouldBlock({
    policy: secretPolicy,
    state: newSessionState(),
    input: { action: 'bash', command: `echo '${secret}' > packages/xyb/new.js`, cwd: ROOT, tool: 'bash' },
    fs,
    now: 1,
  });
  assert.equal(secretVerdict.code, 'SECRET_WRITE', 'a shell redirection is a write');

  const writePolicy = policyFromObject({ name: 'w', checks: ['no-write-outside'], config: { write_roots: [ROOT] } }).policy;
  const outside = shouldBlock({
    policy: writePolicy,
    state: newSessionState(),
    input: { action: 'bash', command: 'echo hi > /outside/x', cwd: ROOT, tool: 'bash' },
    fs,
    now: 1,
  });
  assert.equal(outside.code, 'WRITE_OUTSIDE', 'shell writes must obey write_roots');
});

test('bashReadTargets: closes cd/git/find/xargs/recursive/glob bypasses', () => {
  const opts = { config: DEFAULT_CONFIG, cwd: ROOT, isFile: fs.isFile, exists: fs.exists };
  const norm = (list) => list.map((p) => normalizePath(p));

  assert.deepEqual(norm(bashReadTargets('cd packages && cat xyb/client.js', opts)), [normalizePath(FILE)]);
  assert.deepEqual(norm(bashReadTargets('git show HEAD:packages/xyb/client.js', opts)), [normalizePath(FILE)]);
  assert.deepEqual(norm(bashReadTargets('xargs -0 cat packages/xyb/client.js', opts)), [normalizePath(FILE)]);
  assert.deepEqual(norm(bashReadDirs('grep -rn foo packages', opts)), [normalizePath(join(ROOT, 'packages'))]);
  assert.deepEqual(norm(bashReadDirs('find packages -exec cat {} +', opts)), [normalizePath(join(ROOT, 'packages'))]);

  const glob = bashReadTargets('cat packages/xyb/*.js', opts);
  assert.equal(glob.length, 1);
  assert.match(glob[0], /\*\.js$/);

  assert.deepEqual(bashReadTargets('sed -i s/a/b/ packages/xyb/client.js', opts), []);
  assert.deepEqual(
    norm(bashWriteTargets('sed -i s/a/b/ packages/xyb/client.js', opts)),
    [normalizePath(FILE)],
    'in-place sed is a write, not a read',
  );
});

test('bashDestructiveFinding: build output allowed, source/history denied', () => {
  assert.equal(bashDestructiveFinding('rm -rf node_modules', { cwd: ROOT }), null);
  assert.ok(bashDestructiveFinding('rm -rf src', { cwd: ROOT }));
  assert.ok(bashDestructiveFinding('git reset --hard', { cwd: ROOT }));
  assert.ok(bashDestructiveFinding('git push --force origin main', { cwd: ROOT }));
  assert.ok(bashDestructiveFinding("bash -c 'git reset --hard'", { cwd: ROOT }));
  assert.equal(bashDestructiveFinding('echo "git reset --hard"', { cwd: ROOT }), null);
  assert.equal(bashDestructiveFinding('git restore --staged .', { cwd: ROOT }), null);
});

test('graphResultIsEvidence: an empty answer is not compliance', () => {
  const config = { ...DEFAULT_CONFIG, graph_signal_requires_content: true, graph_signal_min_chars: 10 };
  assert.equal(graphResultIsEvidence('{"total":0,"results":[]}', config), false);
  assert.equal(graphResultIsEvidence('{"total_nodes":0}', config), false);
  assert.equal(graphResultIsEvidence('not found', config), false);
  assert.equal(graphResultIsEvidence('{"total":1,"results":[{"file_path":"a/b.js"}]}', config), true);
  assert.equal(graphResultIsEvidence('short', { ...config, graph_signal_requires_content: false }), true);
});

test('unlockTokensFromQualifiedName: dotted symbol names unlock their file', () => {
  const tokens = unlockTokensFromQualifiedName('E-Development-agent-config-bridge.bridge.lib.gates.gateStatus');
  assert.ok(tokens.includes('bridge/lib/gates'), 'the module directory is a suffix token');
  assert.ok(tokens.includes('gates/gatestatus'), 'the tail is a suffix token (normalised to lower case)');
});

test('no-blind-retry: the third identical failure needs investigation first', () => {
  const p = policyFromObject({
    name: 'retry',
    checks: ['no-blind-retry'],
    config: { max_identical_failures: 2, retry_window_ms: 60_000, max_blocks_per_session: 10 },
  }).policy;
  const state = newSessionState();
  recordCommandResult(state, 'npm test', true, 1_000);
  recordCommandResult(state, 'npm test', true, 2_000);
  const blocked = shouldBlock({
    policy: p,
    state,
    input: { action: 'bash', command: 'npm   test', cwd: ROOT, tool: 'bash' },
    fs,
    now: 3_000,
  });
  assert.equal(blocked.code, 'BLIND_RETRY');
  recordInspection(state, FILE, 2_500);
  assert.equal(
    shouldBlock({
      policy: p,
      state,
      input: { action: 'bash', command: 'npm test', cwd: ROOT, tool: 'bash' },
      fs,
      now: 3_000,
    }).block,
    false,
  );
});
