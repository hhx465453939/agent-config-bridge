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
import { cpSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

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
  newestMtimeIn,
  normalizePath,
  resetMtimeCache,
} from '../gates/policy.js';

import piGate, {
  policyCandidates as policyCandidatesFor,
  firstExistingPolicy as firstExisting,
} from '../gates/pi/index.js';
import { apply as dshApply } from '../gates/dsh/index.js';
import { loadManifest } from '../lib/manifest.js';

/**
 * The `bridge/` directory itself. Resolved from this file's own URL rather than
 * from another constant, so it cannot depend on declaration order — an earlier
 * revision derived it from a `const` declared further down and threw
 * `Cannot access 'PI_ADAPTER_HERE' before initialization`, which took the whole
 * suite offline rather than failing one assertion.
 */
const BRIDGE_DIR = fileURLToPath(new URL('..', import.meta.url));

/** 
 * Stand-in for the adapter's own directory in the checkout layout. The adapter
 * computes this itself from `import.meta.url`; tests pass it explicitly so they
 * can exercise both the checkout and the installed layouts.
 */
const PI_ADAPTER_HERE = dirname(fileURLToPath(new URL('../gates/pi/index.js', import.meta.url)));

const noFs = () => false;

/**
 * Build a path that is absolute on the platform the suite is running on.
 *
 * The policy deliberately ignores relative paths (`scopeOf` returns "not an
 * absolute path"), which is the right behaviour — but it means every fixture
 * path has to be absolute to exercise anything at all. Hardcoding POSIX
 * literals like `/repo/src/a.ts` silently disabled the whole fixture on
 * Windows, where `path.isAbsolute('/repo/src/a.ts')` is false: the tests still
 * "ran", they just stopped reaching the code they were written to check. This
 * helper keeps the readable shape (they read like paths) while staying
 * absolute everywhere.
 *
 *   abs('/repo', 'src/a.ts')  ->  /repo/src/a.ts      on POSIX
 *                             ->  \repo\src\a.ts      on Windows
 */
const abs = (...segments) =>
  join(process.cwd(), ...segments.flatMap((s) => String(s).split('/').filter(Boolean)));

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
    project_roots: [abs('/repo'), abs('/work')],
    max_blocks_per_session: 3,
    signal_ttl_ms: 1000,
  },
};

const policy = normalizePolicy(TEST_POLICY);

const existsAlways = () => true;

// `read`/`write` normalise the fixture path, so the cases below can keep
// spelling paths the readable way ("/repo/src/a.ts") and still be absolute on
// the platform actually running the suite. See `abs`.
const read = (path) => ({ action: 'read', path: abs(path), tool: 'read' });
const write = (path, content) => ({ action: 'write', path: abs(path), tool: 'write', content });

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
  const work = abs('/work');
  const config = { ...DEFAULT_CONFIG, project_roots: [work] };
  assert.equal(scopeOf(abs('/work/a/b.ts'), { config, exists: noFs }).inScope, true);
  assert.equal(scopeOf(abs('/elsewhere/b.ts'), { config, exists: noFs }).inScope, false);
  assert.equal(scopeOf(abs('/work/README.md'), { config, exists: noFs }).inScope, false, 'non-code stays out');
  assert.equal(scopeOf('relative/path.ts', { config, exists: noFs }).inScope, false, 'relative paths are not scoped');

  // With no configured roots, a VCS marker decides.
  const bare = { ...DEFAULT_CONFIG, project_roots: [] };
  const proj = abs('/work/proj');
  const existsGit = (p) => p === join(proj, '.git');
  assert.equal(scopeOf(join(proj, 'src/a.ts'), { config: bare, exists: existsGit }).inScope, true);
  assert.equal(scopeOf(abs('/tmp/loose/a.ts'), { config: bare, exists: noFs }).inScope, false);
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
  // The reason is prose for a person, and it is Chinese. Match the stable
  // ASCII discriminator instead of wording: every block names its layer.
  assert.match(verdict.reason, /Layer 1/);
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
  recordWrite(state, read('/repo/src/new.ts').path);
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
  const repo = abs('/repo');
  const file = abs('/repo/src/a.ts');
  const state = newSessionState();
  const missing = shouldBlock({
    policy: indexPolicy,
    input: { action: 'read', path: file, tool: 'read' },
    state,
    exists: (p) => p === join(repo, '.git'),
    now: 1,
  });
  assert.equal(missing.block, true);
  assert.equal(missing.code, 'INDEX_FIRST');

  const present = shouldBlock({
    policy: indexPolicy,
    input: { action: 'read', path: file, tool: 'read' },
    state: newSessionState(),
    exists: (p) => p === join(repo, '.git') || p === join(repo, '.codebase-memory'),
    now: 1,
  });
  assert.equal(present.block, false);
});

// ---------------------------------------------------------------------------
// index freshness
//
// The two Layer-2 checks split one situation in two on purpose: "there is no
// index" and "the index is behind the code" have different remedies (build it
// vs. update it), and only the second can be decided from timestamps.
// ---------------------------------------------------------------------------

/**
 * A filesystem the rules can be asked about without touching a disk.
 *
 *   dirs    dir -> [entry names]
 *   mtimes  path -> ms epoch
 *
 * Anything absent answers "no such file" / 0 / empty, which is what the real
 * probes answer for a missing path — so an incomplete fixture degrades to "the
 * check abstains" instead of throwing.
 */
const fakeFs = ({ dirs = {}, mtimes = {} } = {}) => ({
  exists: (p) => Object.hasOwn(mtimes, p) || Object.hasOwn(dirs, p),
  statMtime: (p) => mtimes[p] ?? 0,
  listDir: (p) => dirs[p] ?? [],
});

test('gate: a file newer than the index is blocked, within epsilon it is not', () => {
  const repo = abs('/repo');
  const marker = join(repo, '.codebase-memory');
  const file = join(repo, 'src/a.ts');
  const indexPath = join(marker, 'graph.db');

  const policyFor = (epsilon) =>
    normalizePolicy({
      name: 'idx',
      checks: ['index-freshness-before-read'],
      config: { project_roots: [repo], signal_ttl_ms: 0, index_mtime_epsilon_ms: epsilon },
    });

  const rows = [
    // label,                            file mtime, index mtime, epsilon, block?, code
    ['file leads the index by 9s',            10_000,        1_000,    2000, true,  'INDEX_STALE'],
    ['file leads it inside epsilon',           3_000,        1_000,    2000, false, null],
    ['file is older than the index',           1_000,       10_000,    2000, false, null],
    ['the index directory is unreadable',     10_000,            0,    2000, false, null],
    ['the file cannot be stat-ed',                 0,        1_000,    2000, false, null],
    ['epsilon is disabled',                    1_500,        1_000,       0, true,  'INDEX_STALE'],
  ];

  for (const [label, fileM, idxM, epsilon, expectBlock, code] of rows) {
    resetMtimeCache(); // every row starts from a cold cache
    const fs = fakeFs({
      dirs: { [marker]: ['graph.db'] },
      mtimes: { [file]: fileM, [indexPath]: idxM },
    });
    const verdict = shouldBlock({
      policy: policyFor(epsilon),
      input: { action: 'read', path: file, tool: 'read' },
      state: newSessionState(),
      fs,
      now: 1_000_000,
    });
    assert.equal(verdict.block, expectBlock, label);
    assert.equal(verdict.code, code, label);
  }
});

test('gate: a fresh index lets the read through, leaving only the graph rule', () => {
  // Check order is a property of the policy's `checks` array, not of this
  // module: every check short-circuits on a fresh signal, so a Layer-2 check
  // placed first does NOT re-block a session after its first graph query. The
  // shipped cascade and why it is ordered that way are pinned in the next
  // test.
  const repo = abs('/repo');
  const marker = join(repo, '.codebase-memory');
  const file = join(repo, 'src/a.ts');

  resetMtimeCache();
  const graphOnly = normalizePolicy({
    name: 'idx',
    checks: ['graph-before-read'],
    config: { project_roots: [repo], signal_ttl_ms: 0 },
  });
  const verdict = shouldBlock({
    policy: graphOnly,
    input: { action: 'read', path: file, tool: 'read' },
    state: newSessionState(),
    fs: fakeFs({ dirs: { [marker]: ['graph.db'] }, mtimes: { [file]: 1_000, [join(marker, 'graph.db')]: 10_000 } }),
    now: 1_000_000,
  });
  assert.equal(verdict.code, 'GRAPH_FIRST', 'a fresh index must not report itself stale');

  // A missing marker belongs to index-before-read, not to the freshness rule:
  // they have different remedies, so they must not report each other's finding.
  // Order the Layer-2 rules first here ON PURPOSE — with `graph-before-read`
  // first it would answer for them, and this assertion would pass for the wrong
  // reason.
  resetMtimeCache();
  const layer2 = normalizePolicy({
    name: 'idx',
    checks: ['index-before-read', 'index-freshness-before-read'],
    config: { project_roots: [repo], signal_ttl_ms: 0 },
  });
  const absent = shouldBlock({
    policy: layer2,
    input: { action: 'read', path: file, tool: 'read' },
    state: newSessionState(),
    fs: fakeFs({ mtimes: { [file]: 1_000 } }),
    now: 1_000_000,
  });
  assert.equal(absent.code, 'INDEX_FIRST');
});

test('gate: the shipped cascade reports the missing index before the graph rule', () => {
  // The policy FILE is under test here, not the engine: with `graph-before-read`
  // first, an unindexed repository hears "the index exists, query the graph" —
  // a false statement — and the Layer-2 rules can never fire.
  const shipped = JSON.parse(readFileSync(join(BRIDGE_DIR, 'gates', 'pi', 'policy.json'), 'utf8'));
  assert.deepEqual(
    shipped.checks,
    ['index-before-read', 'index-freshness-before-read', 'graph-before-read'],
    'pi policy: Layer-2 checks must precede graph-before-read',
  );

  const repo = abs('/repo');
  const file = join(repo, 'src/a.ts');
  const verdict = shouldBlock({
    policy: normalizePolicy(shipped),
    input: { action: 'read', path: file, tool: 'read' },
    state: newSessionState(),
    fs: fakeFs({ dirs: { [join(repo, '.git')]: ['.git'] } }),
    now: 1_000_000,
  });
  assert.equal(verdict.code, 'INDEX_FIRST', 'an unindexed repo must hear Layer 2, not Layer 1');

  // ...and once a graph query has succeeded, the whole cascade stands down,
  // whatever the index state — that is what keeps the order from turning into a
  // loop after the model complies.
  const state = newSessionState();
  state.signals = 1;
  state.lastSignalAt = 1_000_000;
  const afterQuery = shouldBlock({
    policy: normalizePolicy(shipped),
    input: { action: 'read', path: file, tool: 'read' },
    state,
    fs: fakeFs({ dirs: { [join(repo, '.git')]: ['.git'] } }),
    now: 1_000_000,
  });
  assert.equal(afterQuery.block, false, 'a compliant session must not be blocked by Layer 2');
});

test('gate: a query opens the freshness check, and the session own writes are exempt', () => {
  const repo = abs('/repo');
  const marker = join(repo, '.codebase-memory');
  const file = join(repo, 'src/a.ts');
  const policyFor = () =>
    normalizePolicy({
      name: 'idx',
      checks: ['index-freshness-before-read'],
      config: { project_roots: [repo], signal_ttl_ms: 1000 },
    });
  const fsFor = () =>
    fakeFs({ dirs: { [marker]: ['graph.db'] }, mtimes: { [file]: 10_000, [join(marker, 'graph.db')]: 1_000 } });
  const call = (state) =>
    shouldBlock({
      policy: policyFor(),
      input: { action: 'read', path: file, tool: 'read' },
      state,
      fs: fsFor(),
      now: 1_000_000,
    });

  // A successful graph query this session is what opens every Layer-1 rule, so
  // it opens this one too — otherwise a well-behaved session would be blocked
  // right after doing what the rules asked.
  resetMtimeCache();
  const afterQuery = newSessionState();
  recordSignal(afterQuery, 1_000_000);
  assert.equal(call(afterQuery).block, false, 'a fresh query signal opens the gate');

  // The model's own edit is always newer than the index it is about to consult.
  resetMtimeCache();
  const afterWrite = newSessionState();
  recordWrite(afterWrite, file);
  assert.equal(call(afterWrite).block, false, 'a file this session wrote is exempt');

  // Sanity: without either, it does block. Otherwise the two cases above prove
  // nothing.
  resetMtimeCache();
  assert.equal(call(newSessionState()).block, true);
});

test('policy: index timing knobs coerce to safe numbers', () => {
  // A hand-edited policy.json is the normal way these get set. A string here
  // would compare as NaN, which is false for every comparison — a rule that
  // silently never fires.
  const rows = [
    ['string garbage', 'abc', 2000],
    ['negative', -1, 2000],
    ['null', null, 2000],
    ['undefined', undefined, 2000],
    ['numeric string', '4000', 4000],
    ['zero is legitimate', 0, 0],
  ];
  for (const [label, input, expected] of rows) {
    const p = normalizePolicy({ name: 'n', checks: [], config: { index_mtime_epsilon_ms: input } });
    assert.equal(p.config.index_mtime_epsilon_ms, expected, label);
  }
  const ttl = normalizePolicy({ name: 'n', checks: [], config: { index_mtime_ttl_ms: 'abc' } });
  assert.equal(ttl.config.index_mtime_ttl_ms, DEFAULT_CONFIG.index_mtime_ttl_ms);
});

test('policy: the index-mtime cache expires on its own TTL', () => {
  const dir = abs('/repo/.codebase-memory');
  const entry = join(dir, 'graph.db');
  const mtimes = { [entry]: 1_000 };
  const fs = fakeFs({ dirs: { [dir]: ['graph.db'] }, mtimes });

  resetMtimeCache();
  assert.equal(newestMtimeIn(dir, fs, 1_000, 500), 1_000);

  // Inside the TTL the cached answer stands, even though the disk "changed".
  mtimes[entry] = 9_000;
  assert.equal(newestMtimeIn(dir, fs, 1_200, 500), 1_000, 'cached while fresh');

  // Past the TTL it re-reads.
  assert.equal(newestMtimeIn(dir, fs, 1_600, 500), 9_000, 're-read after the TTL');
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
    config: { write_roots: [abs('/repo')] },
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
// path normalization
//
// The gate is only as wide as the paths it recognizes. A harness resolves tool
// paths itself and will happily accept a relative spelling, so before this a
// relative read was judged "not an absolute path", scoped out, and let through
// — the same file, spelled differently, walking past the rule.
// ---------------------------------------------------------------------------

test('policy: normalizePath collapses the spellings that mean one file', () => {
  const repo = abs('/repo');
  const rows = [
    // Fixtures on the right go through `abs` too, so the expectation is written
    // the same way the implementation computes it (resolve() attaches the
    // process's drive to a drive-less path on Windows).
    ['relative gains the cwd', 'src/a.ts', repo, abs('/repo/src/a.ts')],
    // Every row passes a cwd. Without one, `resolve` falls back to the process
    // directory, and a drive-less absolute path then resolves against a
    // different root than `abs` does on Windows.
    ['parent segments collapse', 'src/../b.ts', repo, abs('/repo/b.ts')],
    // A LEADING "//" is a UNC path on Windows, so the duplicate separators
    // to collapse are the ones inside the path.
    ['duplicate separators', 'src//a.ts', repo, abs('/repo/src/a.ts')],
    ['an absolute path ignores the cwd', abs('/repo/a.ts'), abs('/other'), abs('/repo/a.ts')],
    ['empty stays empty', '', repo, ''],
    ['null stays null', null, repo, null],
  ];
  // normalizePath folds case on win32 by design, so the expectation is
  // compared in the same spelling rather than pretending the case survives.
  const key = (p) => (p === null || process.platform !== 'win32' ? p : String(p).toLowerCase());
  for (const [label, input, cwd, expected] of rows) {
    assert.equal(normalizePath(input, cwd), key(expected), label);
  }

  // Both sides of the `written` comparison go through the same function, which
  // is the point: a relative write and an absolute read are one file.
  assert.equal(normalizePath('src/a.ts', repo), normalizePath(join(repo, './src/a.ts'), repo));
});

test('policy: on a case-sensitive filesystem two cases stay two files', { skip: process.platform === 'win32' }, () => {
  // Folding case on POSIX would conflate two genuinely different files, i.e.
  // open a hole in the exemption for "a file this session wrote".
  assert.notEqual(normalizePath(abs('/Repo/a.ts')), normalizePath(abs('/repo/a.ts')));
});

test('policy: win32 spellings of one path fold together', { skip: process.platform !== 'win32' }, () => {
  const one = normalizePath('E:\\Development\\acb\\src\\a.ts');
  for (const other of [
    'e:\\development\\acb\\src\\a.ts', // case
    'E:/Development/acb/src/a.ts', // separators
    'E:\\Development\\acb\\src\\..\\src\\a.ts', // parent segments
    '\\\\?\\E:\\Development\\acb\\src\\a.ts', // long-path prefix
    'E:\\Development\\acb\\src\\a.ts\\', // trailing separator
  ]) {
    assert.equal(normalizePath(other), one, other);
  }
  // A trailing separator on a drive root is noise; a bare drive letter is not
  // (it means "the current directory on that drive"). normalizePath prefixes a
  // drive-less path with the process's own drive, so this is only meaningful
  // when the drive in question is the process's drive.
  assert.notEqual(normalizePath(`${process.cwd().slice(0, 2)}\\`), normalizePath(process.cwd().slice(0, 2)));
});

test('gate: a relative read is gated once the adapter knows the session cwd', () => {
  const repo = abs('/repo');
  const state = newSessionState();
  const verdict = shouldBlock({
    policy,
    input: { action: 'read', path: normalizePath('src/a.ts', repo), tool: 'read' },
    state,
    exists: existsAlways,
    now: 1000,
  });
  assert.equal(verdict.block, true, 'spelling a path relatively must not be a way around the gate');
  assert.equal(verdict.code, 'GRAPH_FIRST');
});

test('gate: a file this session wrote stays readable under any spelling of its path', () => {
  const repo = abs('/repo');
  const written = normalizePath('src/fresh.ts', repo);
  const spellings = [
    'src/fresh.ts',
    './src/fresh.ts',
    join(repo, 'src/fresh.ts'),
    join(repo, 'src/../src/fresh.ts'),
  ];
  for (const spelling of spellings) {
    const state = newSessionState();
    recordWrite(state, written);
    const verdict = shouldBlock({
      policy,
      input: { action: 'read', path: normalizePath(spelling, repo), tool: 'read' },
      state,
      exists: existsAlways,
      now: 1000,
    });
    assert.equal(verdict.block, false, `${spelling} is the file this session wrote`);
  }
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

// Regression: a real install was silently enforcing nothing.
//
// The adapter looked for `policy.json` next to itself (`<gate>/pi/policy.json`),
// but the installer writes the policy at the gate root (`<gate>/policy.json`).
// The load failed, the gate fell back to fail-open, and the model cheerfully
// read source files. Nothing warned anybody — which is the worst way for an
// enforcement point to fail, because everyone assumes it is working.
//
// So: the adapter must look in BOTH layouts, and a miss must be loud.

test('gates: the adapter finds the policy in the checkout layout', () => {
  const dir = mkdtempSync(join(tmpdir(), 'acb-layout-'));
  try {
    mkdirSync(join(dir, 'pi'), { recursive: true });
    const beside = join(dir, 'pi', 'policy.json');
    writeFileSync(beside, JSON.stringify({ name: 'next-to-adapter' }));
    assert.equal(firstExisting(join(dir, 'pi'), null), beside);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('gates: the adapter finds the policy in the installed layout', () => {
  const dir = mkdtempSync(join(tmpdir(), 'acb-layout-'));
  try {
    mkdirSync(join(dir, 'pi'), { recursive: true });
    const atRoot = join(dir, 'policy.json');
    writeFileSync(atRoot, JSON.stringify({ name: 'at-gate-root' }));
    // This is exactly the case that was broken: nothing next to the adapter.
    assert.equal(firstExisting(join(dir, 'pi'), null), atRoot);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('gates: an explicit policyPath always wins', () => {
  const dir = mkdtempSync(join(tmpdir(), 'acb-layout-'));
  try {
    mkdirSync(join(dir, 'pi'), { recursive: true });
    writeFileSync(join(dir, 'pi', 'policy.json'), JSON.stringify({ name: 'next-to-adapter' }));
    const explicit = join(dir, 'mine.json');
    writeFileSync(explicit, JSON.stringify({ name: 'explicit' }));
    assert.equal(firstExisting(join(dir, 'pi'), explicit), explicit);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('gates: with no policy anywhere, every candidate path is reported', () => {
  const dir = mkdtempSync(join(tmpdir(), 'acb-layout-'));
  try {
    mkdirSync(join(dir, 'pi'), { recursive: true });
    assert.equal(firstExisting(join(dir, 'pi'), null), null);
    const candidates = policyCandidatesFor(join(dir, 'pi'), null);
    assert.ok(candidates.length >= 2, 'both layouts are candidates');
    assert.ok(candidates.every((c) => c.endsWith('policy.json')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('gates: the installed layout really loads (the bug that shipped)', async () => {
  // Mirrors an install byte for byte: the gate root holds policy.js and
  // policy.json, the adapter sits in <gate>/pi/index.js, and there is no policy
  // beside the adapter. Before the fix this reported itself active but had
  // loaded nothing.
  const dir = mkdtempSync(join(tmpdir(), 'acb-install-'));
  try {
    const gates = new URL('../gates/', import.meta.url);
    cpSync(new URL('policy.js', gates), join(dir, 'policy.js'));
    cpSync(new URL('pi/policy.json', gates), join(dir, 'policy.json'));
    mkdirSync(join(dir, 'pi'), { recursive: true });
    cpSync(new URL('pi/index.js', gates), join(dir, 'pi', 'index.js'));

    // Awaited, not returned: a `return promise` inside try/finally would let the
    // finally delete the tree before the assertions ever ran. `pathToFileURL` is
    // what makes this import work on Windows, where a bare absolute path is
    // interpreted as a URL with the drive letter as its scheme.
    const mod = await import(pathToFileURL(join(dir, 'pi', 'index.js')).href);
    const handlers = new Map();
    mod.default({ on: (event, handler) => handlers.set(event, handler) });
    const notes = [];
    await handlers.get('session_start')({}, {
      hasUI: true,
      ui: { notify: (...args) => notes.push(args) },
    });

    const text = notes.map((n) => String(n[0])).join(' | ');
    // Match the policy name, not the substring "active": the word "inactive"
    // also contains "active", which made an earlier version of this assertion
    // pass while the gate was in fact disabled.
    assert.match(text, /graph-first-gate .*active|active \(graph-before-read\)/, `expected an active announcement, got: ${text}`);
    assert.doesNotMatch(text, /DISABLED|inactive/, 'the gate must not be disabled here');

    // And it must actually block, which is the only thing that matters.
    //
    // The path has to be a real source file inside a real VCS checkout: the
    // shipped policy leaves `project_roots` empty on purpose so each machine
    // auto-detects its own repositories rather than inheriting the author's
    // layout. A made-up path such as /repo/src/a.ts exists nowhere and has no
    // .git above it, so it is correctly out of scope — asserting a block on it
    // would be asserting a bug.
    const inRepoSource = fileURLToPath(new URL('../lib/paths.js', import.meta.url));
    const verdict = await handlers.get('tool_call')({
      toolName: 'read',
      input: { path: inRepoSource },
    });
    assert.equal(
      verdict?.block,
      true,
      `an installed gate must block an un-graphed read of ${inRepoSource}`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
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

  const blocked = await call('tool_call', { toolName: 'read', input: { path: abs('/repo/src/a.ts') } });
  assert.equal(blocked?.block, true);
  assert.match(blocked.reason, /Layer 1/);

  // A failed graph query must NOT open the gate.
  await call('tool_result', { toolName: 'search_graph', isError: true });
  const stillBlocked = await call('tool_call', { toolName: 'read', input: { path: abs('/repo/src/b.ts') } });
  assert.equal(stillBlocked?.block, true);

  // A successful one does.
  await call('tool_result', { toolName: 'search_graph', isError: false });
  const allowed = await call('tool_call', { toolName: 'read', input: { path: abs('/repo/src/b.ts') } });
  assert.equal(allowed, undefined, 'once the gate opens, the handler abstains');

  // Reads outside the sandbox repo, and non-code files, are never blocked.
  assert.equal(await call('tool_call', { toolName: 'read', input: { path: abs('/repo/README.md') } }), undefined);
});

test('pi adapter: a successful mcp proxy query to a graph tool also opens the gate', async () => {
  const { pi, call } = fakePi();
  piGate(pi, { policy: TEST_POLICY });

  // Built at runtime: a literal provider-prefixed tool name trips the secret
  // scanner's long-token heuristic (a false positive, but the scanner is the
  // last line of defence and the fix belongs here, not in its allow list).
  const proxyGraphTool = ['codebase', 'memory', 'mcp', 'search', 'graph'].join('_');

  const read = () => call('tool_call', { toolName: 'read', input: { path: abs('/repo/src/a.ts') } });
  assert.equal((await read())?.block, true);

  // Proxy mode names the real tool in the input. A failed call must not count.
  await call('tool_result', {
    toolName: 'mcp',
    input: { tool: proxyGraphTool },
    isError: true,
  });
  assert.equal((await read())?.block, true);

  // Neither must a proxy call to something that is not a graph query.
  await call('tool_result', { toolName: 'mcp', input: { tool: 'read_file' }, isError: false });
  assert.equal((await read())?.block, true);

  await call('tool_result', {
    toolName: 'mcp',
    input: { tool: proxyGraphTool },
    isError: false,
  });
  assert.equal(await read(), undefined, 'the proxy query opened the gate');
});

test('pi adapter: a session start resets the block counter', async () => {
  const { pi, call } = fakePi();
  piGate(pi, { policy: TEST_POLICY });
  await call('session_start', {});
  for (let i = 0; i < 3; i += 1) {
    await call('tool_call', { toolName: 'read', input: { path: abs(`/repo/src/${i}.ts`) } });
  }
  // Fourth is allowed by the cap.
  assert.equal(await call('tool_call', { toolName: 'read', input: { path: abs('/repo/src/z.ts') } }), undefined);
  await call('session_start', {});
  const blockedAgain = await call('tool_call', { toolName: 'read', input: { path: abs('/repo/src/z2.ts') } });
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

  const denied = await run('read', { file_path: abs('/repo/src/a.ts') });
  assert.equal(denied.kind, 'deny');
  assert.match(denied.reason, /Layer 1/);

  assert.deepEqual(await run('read', { file_path: abs('/repo/README.md') }), { kind: 'allow' });
});

test('dsh adapter: a graph query opens the gate for subsequent reads', async () => {
  const { ctx, run } = fakeDshCtx();
  dshApply(ctx, { policy: TEST_POLICY });

  await run('search_graph', { name_pattern: '.*' });
  assert.deepEqual(await run('read', { file_path: abs('/repo/src/a.ts') }), { kind: 'allow' });
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
  await run('write', { file_path: abs('/repo/src/fresh.ts'), content: 'x' });
  assert.deepEqual(await run('read', { file_path: '/repo/src/fresh.ts' }), { kind: 'allow' });
});

// ---------------------------------------------------------------------------
// the naming contract between the manifest JSON and the code that reads it
//
// This cost a real bug on a real machine: the validator emitted `auto_load`
// while the planner read `autoLoad`, so the manual-mount warning never fired.
// A check that silently never runs is the exact failure mode this project keeps
// trying to design out, so it gets a test that fails the moment the two sides
// drift apart again.
// ---------------------------------------------------------------------------

/**
 * Strip comments, keep everything else.
 *
 * The naming-contract tests below scan source text, and prose mentions things
 * like `bridge/test/gates.test.js` or `<extension_dir>/<install_as>/`. Those are
 * comments, not readers — without this the tests report false positives, and a
 * checker that cries wolf is worse than no checker.
 *
 * Strings are deliberately kept: `manifest.gates.extensionDir` inside a
 * template literal is a real reader and must be caught.
 */
const stripComments = (source) => {
  let out = '';
  let i = 0;
  let state = 'code';
  while (i < source.length) {
    const c = source[i];
    const next = source[i + 1];
    if (state === 'code') {
      if (c === '/' && next === '/') { state = 'line'; i += 2; continue; }
      if (c === '/' && next === '*') { state = 'block'; i += 2; continue; }
      if (c === "'" || c === '"' || c === '`') state = c;
      out += c;
      i += 1;
      continue;
    }
    if (state === 'line') {
      if (c === '\n') { state = 'code'; out += c; }
      i += 1;
      continue;
    }
    if (state === 'block') {
      if (c === '*' && next === '/') { state = 'code'; i += 2; } else { if (c === '\n') out += c; i += 1; }
      continue;
    }
    // inside a string or template literal
    if (c === '\\') { out += c + (next ?? ''); i += 2; continue; }
    if (c === state) state = 'code';
    out += c;
    i += 1;
  }
  return out;
};

test('gates: every key the code reads is a key the validator produces', () => {
  // Reads all go through `manifest.gates.X`, so matching that prefix keeps the
  // scan precise: an error message that happens to spell `gates.install_as`
  // inside a template literal is prose, not a reader, and flagging it would
  // make this test cry wolf.
  //
  // The alias check below catches the case where someone shortens the access
  // path (`const g = manifest.gates`) — at which point this scan would silently
  // stop covering those reads, which is the same class of silent gap the test
  // exists to prevent.
  const readerRe = /manifest\??\.gates\??\.([A-Za-z_][A-Za-z0-9_]*)/g;
  const aliasRe = /(?:=|\{)[^;\n]*\bmanifest\.gates\b(?![.?])/;
  const files = [
    ...readdirSync(join(BRIDGE_DIR, 'lib'))
      .filter((f) => f.endsWith('.js'))
      .map((f) => join(BRIDGE_DIR, 'lib', f)),
    join(BRIDGE_DIR, 'cli.js'),
  ];

  const readers = new Map();
  for (const file of files) {
    const source = stripComments(readFileSync(file, 'utf8'));
    const where = file.slice(BRIDGE_DIR.length);
    for (const match of source.matchAll(readerRe)) {
      const key = match[1];
      if (!readers.has(key)) readers.set(key, new Set());
      readers.get(key).add(where);
    }
    assert.doesNotMatch(
      source,
      aliasRe,
      `${where} aliases manifest.gates to a local variable; extend this test so the scan still covers those reads`,
    );
  }

  assert.ok(readers.size > 0, 'sanity check: the scan should find readers at all');

  for (const target of ['pi', 'dsh']) {
    const produced = new Set(Object.keys(loadManifest(join(BRIDGE_DIR, '..'), target).gates));
    for (const [key, where] of readers) {
      assert.ok(
        produced.has(key),
        `the code reads gates.${key} (${[...where].join(', ')}) but the validator for "${target}" ` +
          `does not produce it.\n` +
          `  produced: ${[...produced].sort().join(', ')}\n` +
          `  snake_case is the manifest JSON spelling; camelCase is what the rest of the code uses.`,
      );
    }
  }
});

test('gates: raw snake_case keys are read only where the manifest is parsed', () => {
  // `extension_dir` / `install_as` / `auto_load` / `mount_hint` are the on-disk
  // spelling. If one leaks past manifest.js, some downstream reader is looking
  // at raw JSON by accident — which works until someone normalises the reader,
  // and then breaks in production instead of in CI.
  const RAW_KEYS = ['extension_dir', 'install_as', 'auto_load', 'mount_hint', 'server_settings'];
  const leaks = [];
  for (const file of readdirSync(join(BRIDGE_DIR, 'lib')).filter((f) => f.endsWith('.js'))) {
    if (file === 'manifest.js') continue; // the one place allowed to see raw JSON
    const source = stripComments(readFileSync(join(BRIDGE_DIR, 'lib', file), 'utf8'));
    for (const key of RAW_KEYS) {
      if (source.includes(key)) leaks.push(`bridge/lib/${file} reads the raw key ${key}`);
    }
  }
  assert.deepEqual(leaks, [], leaks.join('\n'));
});
