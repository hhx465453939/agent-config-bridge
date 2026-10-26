/**
 * Gate policy: environment-agnostic rules for "hard gates" that a coding agent
 * cannot talk its way past.
 *
 * Why this file exists at all
 * ---------------------------
 * A rules document (AGENTS.md / CLAUDE.md) is advice: the model reads it and
 * usually complies. Some rules are not advice — "do not read source before
 * asking the code graph", "never print a credential", "do not write outside the
 * repo". Those need to be enforced by the harness, not by the model's goodwill.
 *
 * But every harness enforces things differently:
 *
 *   pi     pi.on('tool_call')        -> { block: true, reason }
 *   dsh    ctx.on('tools/pre-execute') -> { kind: 'deny', reason } | next()
 *
 * So the rules live here, in plain JavaScript that has no idea which harness is
 * running, and each adapter in bridge/gates/<harness>/ is a thin translator:
 * native event in, normalized question out, native decision back.
 *
 * Consequence: the rule logic is unit-testable off-harness (see
 * bridge/test/gates.test.js) and the adapters stay small enough to read in one
 * sitting — which matters, because an adapter bug silently disables enforcement.
 *
 * Language
 * --------
 * Identifiers, comments and internal reason strings are English (this is a
 * published repository). Everything a user READS — the denial text and the
 * per-turn reminder — is Simplified Chinese, because the person being blocked
 * is the person who wrote the rules. Keep new checks consistent with that
 * split, and note that the block text always carries its layer as ASCII
 * ("Layer 1/2/3"), which is what the tests assert on instead of wording.
 *
 * Failure policy
 * --------------
 * If the policy cannot be read or parsed, the gate FAILS OPEN (allows the call)
 * and warns. A gate that fails closed on a missing file would brick the agent,
 * and a bricked agent is worse than an unenforced rule. The reverse choice
 * (fail closed) is right for *secrets* and *writes*, and that is why those
 * rules are expressed as explicit checks rather than as "policy failed to load".
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, normalize, posix, relative, resolve, sep } from 'node:path';

const WIN32 = process.platform === 'win32';

/** Cached "newest mtime inside the index marker directory", keyed by directory. */
const mtimeCache = new Map();

export const DEFAULT_CONFIG = {
  /** Absolute paths whose files are in scope. Empty = auto-detect a VCS root. */
  project_roots: [],
  /** Path fragments that take a file out of scope regardless of the above. */
  exclude_globs: [
    '**/node_modules/**',
    '**/vendor/**',
    '**/dist/**',
    '**/build/**',
    '**/.git/**',
    '**/site-packages/**',
    '**/.venv/**',
  ],
  /** File extensions treated as source code. */
  code_extensions: [
    'ts', 'tsx', 'mts', 'cts', 'js', 'jsx', 'mjs', 'cjs',
    'py', 'pyi', 'rs', 'go', 'java', 'c', 'h', 'cc', 'cpp', 'hpp', 'hh',
    'rb', 'php', 'sql', 'sh', 'bash', 'zsh', 'scala', 'kt', 'kts',
    'swift', 'lua', 'vue', 'svelte', 'r', 'jl', 'cs', 'fs', 'ex', 'exs',
    'toml', 'proto', 'gradle', 'tf',
  ],
  /** Extensionless files that are still source code. */
  code_filenames: ['Dockerfile', 'Containerfile', 'Makefile', 'Rakefile', 'Gemfile', 'Procfile'],
  /** How many times one session may be blocked before the gate gives up. */
  max_blocks_per_session: 30,
  /**
   * A graph query newer than this many ms counts as fresh, session-wide.
   *
   * Keep this SHORT. The first version let a single query unlock an hour of
   * reading: the model asked the graph once, then read the tree freely — which
   * is exactly the failure the gate exists to prevent. Ten minutes covers a
   * burst of reads and forces the next burst to consult the graph again.
   */
  signal_ttl_ms: 10 * 60 * 1000,
  /**
   * An *unlock* is stronger evidence than a session signal: the graph query
   * actually mentioned this file / package / directory, so it stays valid for
   * longer than the blanket signal.
   */
  unlock_ttl_ms: 30 * 60 * 1000,
  /**
   * Gate read-like bash commands (`cat`, `grep`, `sed -n`, …) as reads.
   * Reading source through the shell is the same act as reading it with the
   * `read` tool, and used to be the one hole that made the gate cosmetic.
   */
  bash_read_check: true,
  /** Where an index marker directory is expected, for advisory reasons. */
  index_marker: '.codebase-memory',
  /**
   * A file counts as newer than the index only if it leads by more than this.
   * Same-second writes and coarse (FAT, network share) timestamps otherwise
   * make a freshly built index look stale, and a rule that cries wolf gets
   * switched off instead of fixed.
   */
  index_mtime_epsilon_ms: 2000,
  /**
   * How long a computed "newest file inside the marker directory" is trusted.
   * The scan is a readdir plus a stat per entry; a read-heavy turn would
   * otherwise repeat it for every read.
   */
  index_mtime_ttl_ms: 30000,

  // -------------------------------------------------------------------------
  // v3: evidence, Layer 0 ("think before acting"), and shell-write coverage
  // -------------------------------------------------------------------------
  /**
   * A graph call only counts as evidence when it actually returned something.
   *
   * v2 recorded a signal for any non-error tool result, including an empty
   * `search_graph` (`{"total":0,"results":[]}`). That let an unindexed or
   * stale index buy a full read window with no information at all — the exact
   * "searched, found nothing, read the tree anyway" failure the rules forbid.
   * The pi adapter verifies the result text with `graphResultIsEvidence` before
   * recording a signal. dsh cannot see results, so its policy leaves this off
   * and the asymmetry is documented in ADR-003.
   */
  graph_signal_requires_content: false,
  /** Below this many characters a graph result is treated as empty noise. */
  graph_signal_min_chars: 40,

  /**
   * Layer 0: require evidence that the model looked at the *specific* target
   * before overwriting it. `hasScopedUnlock` (graph named the file) or a
   * successful read of that exact file (`state.inspected`) both qualify.
   * New files are exempt: there is nothing to inspect yet, and requiring a
   * graph hit would brick greenfield work in an empty repository.
   */
  require_target_evidence: true,
  /**
   * Layer 0: require a successful read of a project convention document before
   * the first code write in that repository. Only enforced when such a file
   * exists; a repository without conventions is not punished for it.
   */
  require_conventions: false,
  convention_files: ['AGENTS.md', 'CLAUDE.md', 'CONTRIBUTING.md', '.cursorrules'],

  /**
   * ai-spec 层：改代码前必须确认本次改动对应哪个立项 CHG，且本会话读过它的契约。
   *
   * 为什么必须做成硬门控：AGENTS.md 说「按 CHG 推进」只是建议。实测教训
   * （2026-10-29，40 个 CHG 批量开发）：31 个缺 PRD、28 个缺 TRACEABILITY，
   * 先合并的 CHG 用「全局状态断言」把后合并的合法改动判红——全部源于
   * 「没先核对契约就动手」。
   *
   * 判定只看一件事：`state.docReads` 里是否有一条落在 `chg_contract_globs`。
   * 只约束代码文件（isCodeFile），文档与数据文件不拦。
   */
  require_chg_contract: true,
  // ⚠️ glob 必须**全小写**：normalizePath 会把路径小写化（Windows 下还转反斜杠，
  // 而 matchesAnyGlob 前会 toPosix）。写成 `CHG-*/SPEC.md` 会永不匹配——门控静默失效。
  chg_contract_globs: [
    '**/tasks/chg-*/spec.md',
    '**/tasks/chg-*/prd.md',
    '**/tasks/chg-*/change.md',
    '**/tasks/chg-*/traceability.md',
  ],

  /**
   * Layer 0: retrying an identical failing command is the mechanical loop the
   * thinking rule exists to stop. Two failures are tolerated (a flaky test, a
   * transient tool); the third needs investigation (read or graph) first.
   */
  max_identical_failures: 2,
  retry_window_ms: 10 * 60 * 1000,

  /**
   * Layer 0: destructive shell operations never run automatically. Paths that
   * contain one of these segments are considered disposable build output and
   * are allowed for `rm -rf` (removing `node_modules` is routine, removing
   * `src` is not). `destructive_allow_patterns` is a list of regex sources for
   * legitimate exceptions on a given machine.
   */
  destructive_disposable_segments: [
    'node_modules', 'dist', 'build', 'out', 'coverage', '.next', '.nuxt',
    '.cache', '.venv', 'venv', 'target', '__pycache__', '.pytest_cache',
    '.turbo', '.parcel-cache', 'tmp', 'temp',
  ],
  destructive_allow_patterns: [],
};

export const POLICY_FILENAME = 'policy.json';

/**
 * Load a policy next to the adapter that uses it.
 * @param {string} adapterUrl  pass `import.meta.url` from the adapter
 * @returns {{ok: boolean, policy: object|null, error: string|null}}
 */
export const loadPolicyNear = (adapterUrl) => {
  const file = new URL(`./${POLICY_FILENAME}`, adapterUrl);
  return loadPolicy(file);
};

export const loadPolicy = (fileOrUrl) => {
  try {
    const text = readFileSync(fileOrUrl, 'utf8');
    const parsed = JSON.parse(text);
    return { ok: true, policy: normalizePolicy(parsed), error: null };
  } catch (err) {
    return { ok: false, policy: null, error: `${fileOrUrl}: ${err?.message ?? err}` };
  }
};

/** The signature the config accepts in place of a file path. */
export const policyFromObject = (raw) => ({ ok: true, policy: normalizePolicy(raw), error: null });

export const normalizePolicy = (raw) => {
  const config = { ...DEFAULT_CONFIG, ...(raw?.config ?? {}) };
  config.code_extensions = config.code_extensions.map((e) => String(e).replace(/^\./, '').toLowerCase());
  config.max_blocks_per_session = Number.isFinite(config.max_blocks_per_session)
    ? config.max_blocks_per_session
    : DEFAULT_CONFIG.max_blocks_per_session;
  // Non-negative finite numbers only. A hand-edited policy.json is the normal
  // way these get set, and a string here would compare as NaN — which is false
  // for every comparison, i.e. a rule that silently never fires.
  //
  // `null` and `undefined` mean "not set", NOT zero: `Number(null)` is 0, and
  // silently turning an absent value into a disabled epsilon is the class of
  // bug this coercion exists to prevent. An explicit 0 still means 0.
  for (const key of ['index_mtime_epsilon_ms', 'index_mtime_ttl_ms']) {
    const raw = config[key];
    const n = raw === null || raw === undefined || raw === '' ? NaN : Number(raw);
    config[key] = Number.isFinite(n) && n >= 0 ? n : DEFAULT_CONFIG[key];
  }
  return {
    name: typeof raw?.name === 'string' ? raw.name : 'unnamed-gate',
    version: raw?.version ?? 1,
    description: raw?.description ?? '',
    reminded: typeof raw?.reminder === 'string' ? raw.reminder : '',
    checks: Array.isArray(raw?.checks) ? raw.checks : [],
    config,
  };
};

// ---------------------------------------------------------------------------
// Path predicates
// ---------------------------------------------------------------------------

const toPosix = (p) => p.split(sep).join('/');

// Minimal glob matcher. `**` spans separators and the slash after it is
// optional, so the pattern "**/node_modules/**" also matches "node_modules/x".
// A single `*` stops at a separator, `?` is one non-separator character.
// (Written as line comments on purpose: a block comment would be terminated
// early by the "*/" inside the pattern example above.)
export const globToRegExp = (glob) => {
  let out = '';
  let i = 0;
  while (i < glob.length) {
    const ch = glob[i];
    if (ch === '*') {
      if (glob[i + 1] === '*') {
        i += 2;
        if (glob[i] === '/') {
          i += 1;
          out += '(?:.*/)?'; // zero or more leading path segments
        } else {
          out += '.*';
        }
      } else {
        i += 1;
        out += '[^/]*';
      }
      continue;
    }
    if (ch === '?') {
      i += 1;
      out += '[^/]';
      continue;
    }
    out += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    i += 1;
  }
  return new RegExp(`^${out}$`);
};

export const matchesAnyGlob = (path, globs) => {
  const p = toPosix(path);
  return (globs ?? []).some((g) => globToRegExp(g).test(p));
};

export const isCodeFile = (path, config = DEFAULT_CONFIG) => {
  const name = toPosix(path).split('/').pop() ?? '';
  const commonNames = config.code_filenames ?? DEFAULT_CONFIG.code_filenames;
  if (commonNames.some((n) => n.toLowerCase() === name.toLowerCase())) return true;
  const dot = name.lastIndexOf('.');
  if (dot === -1) return false;
  return config.code_extensions.includes(name.slice(dot + 1).toLowerCase());
};

export const isExcluded = (path, config = DEFAULT_CONFIG) =>
  matchesAnyGlob(path, config.exclude_globs);

/**
 * Walk up from `filePath` looking for a VCS root. This replaces the old
 * hard-coded "my projects live in /home/<someone>/Development" constant: a rule
 * that only works on one person's machine is not a rule.
 *
 * @param {string} filePath
 * @param {(dir: string) => boolean} exists  injected so tests need no filesystem
 * @param {{markers?: string[], maxDepth?: number}} [opts]
 * @returns {string|null} the repository root, or null
 */
export const findRepoRoot = (filePath, exists, opts = {}) => {
  const markers = opts.markers ?? ['.git'];
  const maxDepth = opts.maxDepth ?? 40;
  let dir = dirname(filePath);
  for (let i = 0; i < maxDepth; i += 1) {
    for (const marker of markers) {
      if (exists(join(dir, marker))) return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
};

/**
 * Is `child` the same as `parent`, or inside it?
 *
 * Compared with `path.relative` rather than a string prefix. The prefix form
 * ("does the path start with `<root>/`") only works when the separator is a
 * literal forward slash, which is a POSIX assumption: on Windows every path
 * uses `\`, so a configured project root never matched anything and the gate
 * silently stopped applying to the projects it was configured for. The string
 * form also gets `<root>-sibling` wrong, which the tests pin separately.
 */
const withinRoot = (parent, child) => {
  if (child === parent) return true;
  const rel = relative(parent, child);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
};

/**
 * Is this path in scope for the gate?
 * @returns {{inScope: boolean, reason: string, root: string|null}}
 */
export const scopeOf = (filePath, { config = DEFAULT_CONFIG, exists }) => {
  if (!filePath) return { inScope: false, reason: '没有路径', root: null };
  if (!isAbsolute(filePath)) return { inScope: false, reason: '不是绝对路径', root: null };
  if (!isCodeFile(filePath, config)) return { inScope: false, reason: '不是代码文件', root: null };
  if (isExcluded(filePath, config)) return { inScope: false, reason: '在排除清单内（vendor/依赖/构建产物）', root: null };

  if (Array.isArray(config.project_roots) && config.project_roots.length > 0) {
    const root = config.project_roots.find((r) => withinRoot(r, filePath));
    return root
      ? { inScope: true, reason: '在配置的项目根之下', root }
      : { inScope: false, reason: '不在任何配置的项目根之下', root: null };
  }

  const root = findRepoRoot(filePath, exists, config.repo_markers ? { markers: config.repo_markers } : {});
  return root
    ? { inScope: true, reason: '在某个代码仓库内', root }
    : { inScope: false, reason: '不在任何代码仓库内', root: null };
};

// ---------------------------------------------------------------------------
// Session state
// ---------------------------------------------------------------------------

/**
 * Per-session bookkeeping every adapter needs. Kept as a plain object (not a
 * class) so an adapter can hand it to `shouldBlock` without ceremony and tests
 * can build one literal.
 */
export const newSessionState = () => ({
  /** Count of successful "I consulted the code graph" signals. */
  signals: 0,
  /** Timestamp of the most recent signal (ms). */
  lastSignalAt: 0,
  /**
   * Files this session actually read (normalized). A read is stronger evidence
   * than a scoped unlock for the same file: it proves the model looked at the
   * exact target it is about to overwrite.
   */
  inspected: new Set(),
  /** Project convention documents this session read (normalized). */
  docReads: new Set(),
  /**
   * Failed shell commands, keyed by normalized command, with a streak count.
   * `no-blind-retry` uses this; the adapter feeds it from tool results.
   */
  failedCommands: new Map(),
  /** Timestamp of the most recent signal/read/write, used by the retry rule. */
  lastInvestigationAt: 0,
  /**
   * Scoped unlocks: path tokens that a successful graph query actually named
   * (file, package dir, module). A read is allowed when its normalized path
   * contains a fresh unlock — "the graph was asked about this, specifically".
   */
  unlocks: new Map(),
  /** Files this session itself wrote; reading them back is always fine. */
  written: new Set(),
  /** How many times the gate has blocked, to bound the damage of a false rule. */
  blocks: 0,
  /** Reasons already surfaced, so the user is not shouted at every turn. */
  announced: new Set(),
});

/**
 * One spelling for a path, so "the file I am reading" and "the file I wrote a
 * turn ago" can be compared at all.
 *
 * Why this exists
 * ---------------
 * A harness resolves tool paths itself: pi's `read` schema says "relative or
 * absolute" and resolves the relative form against the session directory. The
 * rules below refuse relative paths on purpose (an absolute path is the only
 * thing they can scope), so before this the model could dodge the gate by
 * spelling a path relatively — `scopeOf` answered "not an absolute path",
 * `inScope` was false, and the read sailed through. The same mismatch made the
 * gate fight the model over its own work: `write` recorded one spelling,
 * `read` came back with another, `written.has(...)` missed, and a file the
 * session had just created was blocked.
 *
 * So both sides of the `written` comparison go through here, and the harness is
 * responsible for handing `recordWrite` the spelling it will later report.
 *
 * What it does, and deliberately does not do
 * ------------------------------------------
 *   resolve    a relative path against the directory the harness resolves it
 *              against (`cwd`), passed in — never read from `process.cwd()`,
 *              because for a session-shaped harness the process directory is
 *              not the session directory.
 *   normalize  collapse `..`, `.` and duplicate separators.
 *   win32      fold case and the `\\?\` long-path prefix, because Windows
 *              treats `C:\repo` and `c:\repo` as one file and the model will
 *              spell them both in consecutive turns.
 *   NOT        resolving links (needs I/O; this stays a pure function) and NOT
 *              expanding 8.3 short names.
 *
 * Case is folded only on win32: on a case-sensitive filesystem `/Repo/a.ts` and
 * `/repo/a.ts` really are two files, and conflating them would open a hole.
 */
export const normalizePath = (p, cwd = null) => {
  if (typeof p !== 'string' || p === '') return p ?? null;
  const resolved = cwd ? resolve(cwd, p) : resolve(p);
  if (!WIN32) return normalize(resolved);
  let out = resolved.startsWith('\\\\?\\') ? resolved.slice(4) : resolved;
  out = out.split('/').join('\\');
  // Keep the root separator ("C:\") because "C:" alone means "the current
  // directory on drive C", which is a different thing.
  if (out.length > 3 && out.endsWith('\\')) out = out.slice(0, -1);
  return out.toLowerCase();
};

export const recordSignal = (state, now = Date.now()) => {
  state.signals += 1;
  state.lastSignalAt = now;
  state.lastInvestigationAt = now;
};

/** Record that this session read a file, whatever tool performed the read. */
export const recordInspection = (state, path, now = Date.now()) => {
  if (!path || !state?.inspected) return;
  state.inspected.add(path);
  state.lastInvestigationAt = now;
};

/** Record a convention-document read. */
export const recordDocRead = (state, path, now = Date.now()) => {
  if (!path || !state?.docReads) return;
  state.docReads.add(path);
  state.lastInvestigationAt = now;
};

/** Any substantive action (query/read/write) resets the blind-retry clock. */
export const recordInvestigation = (state, now = Date.now()) => {
  if (!state) return;
  state.lastInvestigationAt = now;
};

/** One spelling for a shell command, so "the same retry" is comparable. */
export const normalizeCommand = (command) =>
  typeof command === 'string' ? command.trim().replace(/\s+/g, ' ') : '';

/**
 * Record the outcome of a shell command.
 *
 * A success forgets the command's failure streak (the retry worked). A failure
 * increments it. Streaks are bounded by `retry_window_ms` at read time and the
 * map is capped so a long session cannot grow it without bound.
 */
export const recordCommandResult = (state, command, failed, now = Date.now()) => {
  const key = normalizeCommand(command);
  if (!key || !state?.failedCommands) return;
  if (!failed) {
    state.failedCommands.delete(key);
    return;
  }
  const prev = state.failedCommands.get(key);
  state.failedCommands.set(key, {
    count: (prev?.count ?? 0) + 1,
    lastAt: now,
  });
  // Keep the map small. Oldest insertion order is the least interesting.
  while (state.failedCommands.size > 50) {
    state.failedCommands.delete(state.failedCommands.keys().next().value);
  }
};

/** Does this path name a project convention document? */
export const isConventionDoc = (path, config = DEFAULT_CONFIG) => {
  if (typeof path !== 'string' || path === '') return false;
  const name = toPosix(path).split('/').pop() ?? '';
  return (config.convention_files ?? []).some((n) => n.toLowerCase() === name.toLowerCase());
};

/**
 * Does this path name a CHG contract document (`tasks/CHG-<id>/SPEC|PRD|CHANGE|TRACEABILITY`)?
 *
 * 与 `isConventionDoc` 分开是故意的：约定文档是「怎么做事」，CHG 契约是
 * 「这次做什么、做到什么算完」。缺少前者只能提醒，缺少后者**不允许改代码**。
 *
 * 注意：normalizePath 会小写化路径，所以 `chg_contract_globs` 必须全小写。
 */
export const isChgContract = (path, config = DEFAULT_CONFIG) => {
  if (typeof path !== 'string' || path === '') return false;
  return matchesAnyGlob(toPosix(path).toLowerCase(), config.chg_contract_globs ?? []);
};

/** Record a file the session wrote. The caller passes the normalized spelling. */
export const recordWrite = (state, path) => {
  if (path) state.written.add(path);
};

export const hasFreshSignal = (state, ttlMs, now = Date.now()) =>
  state.signals > 0 && now - state.lastSignalAt <= ttlMs;

// ---------------------------------------------------------------------------
// Scoped unlocks: "the graph query actually talked about this file"
// ---------------------------------------------------------------------------

/** Shortest token kept; below this the substring match starts lying ("a", "js"). */
const UNLOCK_MIN_LEN = 4;
/** Hard cap so a huge query result cannot grow the map without bound. */
const MAX_UNLOCKS = 4000;
/** Directory names too common to mean anything on their own. */
const GENERIC_DIR_SEGMENTS = new Set([
  'packages', 'package', 'src', 'source', 'lib', 'libs', 'test', 'tests', 'spec',
  'app', 'apps', 'docs', 'doc', 'bridge', 'scripts', 'script', 'bin', 'dist',
  'build', 'out', 'output', 'node_modules', 'vendor', 'python', 'site-packages',
  'development', 'projects', 'repos', 'workspace', 'workspaces',
]);

/** One spelling for unlock entries: forward slashes, no drive prefix, lowercase. */
export const normalizeUnlockToken = (token) => {
  if (typeof token !== 'string') return null;
  const cleaned = token
    .replace(/\\/g, '/')
    .replace(/^[a-z]:/i, '')
    .replace(/^\/+/, '')
    .trim()
    .toLowerCase();
  return cleaned.length >= UNLOCK_MIN_LEN ? cleaned : null;
};

/**
 * Turn free text (usually a graph query's arguments or its result) into
 * unlock tokens.
 *
 * The tokens are *path suffixes* — the basename, the last few segments, and
 * the whole drive-stripped path — never bare generic directories. A query that
 * mentioned `packages/xyb/client.js` must unlock that file (and its suffix
 * spellings), not every file under `packages/`: an unlock is evidence about a
 * named target, and evidence that broad is not evidence.
 */
export const unlockTokensFromText = (text, { limit = 400, maxSuffixSegments = 4 } = {}) => {
  if (typeof text !== 'string' || text === '') return [];
  const tokens = new Set();
  const pathish = /[A-Za-z0-9_@.$-]+(?:[\\/][A-Za-z0-9_@.$-]+)+/g;
  for (const match of text.match(pathish) ?? []) {
    const key = normalizeUnlockToken(match);
    if (!key) continue;
    const segments = key.split('/').filter(Boolean);
    // Suffixes of the path: basename, last two, last three … up to maxSuffixSegments.
    // `c:\repo\packages\xyb\client.js` contains `packages/xyb/client.js`, so the
    // suffix form matches absolute paths on any machine.
    const max = Math.min(segments.length, maxSuffixSegments);
    for (let take = 1; take <= max; take += 1) {
      const suffix = segments.slice(-take).join('/');
      if (suffix.length >= UNLOCK_MIN_LEN) tokens.add(suffix);
    }
    // The immediate parent is useful when the file itself is renamed, but only
    // when it is specific enough to mean something (see the doc above).
    const parent = segments[segments.length - 2];
    if (parent && parent.length >= UNLOCK_MIN_LEN && !GENERIC_DIR_SEGMENTS.has(parent)) tokens.add(parent);
    if (tokens.size >= limit) break;
  }
  return [...tokens].slice(0, limit);
};

/** Record tokens as unlocks; returns how many were stored. */
export const recordUnlocks = (state, tokens, now = Date.now()) => {
  if (!state?.unlocks || !tokens) return 0;
  let added = 0;
  for (const raw of tokens) {
    const key = normalizeUnlockToken(raw);
    if (!key) continue;
    state.unlocks.set(key, now);
    added += 1;
    if (state.unlocks.size > MAX_UNLOCKS) state.unlocks.delete(state.unlocks.keys().next().value);
  }
  return added;
};

/**
 * May this path be read right now?
 *
 * True when either the whole session has a fresh signal (short TTL — see
 * DEFAULT_CONFIG) or the path itself was named by a fresh unlock.
 */
/**
 * Like `hasUnlock`, but ignores the session-wide window.
 *
 * Layer 0 needs *evidence*, not a blanket pass: a query about some other file
 * must not authorise overwriting this one. `hasUnlock` stays as "may I read
 * this at all" (session window OR named target); `hasScopedUnlock` is "did the
 * graph actually name this target".
 */
export const hasScopedUnlock = (state, path, config = DEFAULT_CONFIG, now = Date.now()) => {
  if (!path || !state?.unlocks || state.unlocks.size === 0) return false;
  const norm = String(path).replace(/\\/g, '/').toLowerCase();
  for (const [key, at] of state.unlocks) {
    if (now - at > config.unlock_ttl_ms) continue;
    if (norm.includes(key)) return true;
  }
  return false;
};

/** May this path be read right now? Session window OR a named-target unlock. */
export const hasUnlock = (state, path, config = DEFAULT_CONFIG, now = Date.now()) => {
  if (hasFreshSignal(state, config.signal_ttl_ms, now)) return true;
  return hasScopedUnlock(state, path, config, now);
};

/**
 * Unlock tokens from a dotted qualified name (`pkg.sub.module.symbol`).
 *
 * Graph results already carry `file_path` fields, which the text extractor
 * picks up. `get_code_snippet` is the exception: its input is a qualified name
 * and its result is source text, so a scoped write check would otherwise say
 * "you never looked at this file" right after the model did exactly that.
 * Suffixes joined with slashes match the repository path (`bridge/lib/gates`
 * is a substring of `.../bridge/lib/gates.js`).
 */
export const unlockTokensFromQualifiedName = (qualifiedName, { limit = 60 } = {}) => {
  if (typeof qualifiedName !== 'string') return [];
  const parts = qualifiedName.split(/[.::]+/).filter(Boolean);
  if (parts.length < 2) return [];
  const tokens = new Set();
  for (let start = 0; start < parts.length; start += 1) {
    const tail = parts.slice(start).join('/');
    if (tail.length >= UNLOCK_MIN_LEN) tokens.add(tail.toLowerCase());
    // Also keep the parent directory form: .../bridge/lib/gates (no symbol).
    if (start < parts.length - 1) {
      const parent = parts.slice(start, -1).join('/');
      if (parent.length >= UNLOCK_MIN_LEN) tokens.add(parent.toLowerCase());
    }
    if (tokens.size >= limit) break;
  }
  return [...tokens].slice(0, limit);
};

/** Patterns that make a graph result an empty answer rather than evidence. */
const EMPTY_GRAPH_RESULT = [
  /"total"\s*:\s*0\b/,
  /"total_nodes"\s*:\s*0\b/,
  /"results"\s*:\s*\[\s*\]/,
  /"nodes"\s*:\s*\[\s*\]/,
  /"edges"\s*:\s*\[\s*\]/,
  /\bno (?:results?|matches?|symbols?|nodes?|projects?)\b/i,
  /(?:未找到|没有找到|无匹配|空结果|查无)/,
];

/**
 * Is a graph tool result strong enough to count as "the graph was consulted"?
 *
 * Empty is not evidence. A model that searched, found nothing, and immediately
 * read the tree has learned nothing from the graph — the rules require fixing
 * the query or refreshing the index and querying again first.
 */
export const graphResultIsEvidence = (text, config = DEFAULT_CONFIG) => {
  if (config.graph_signal_requires_content === false) return true;
  if (typeof text !== 'string') return false;
  const trimmed = text.trim();
  if (trimmed.length < (config.graph_signal_min_chars ?? 0)) return false;
  return !EMPTY_GRAPH_RESULT.some((re) => re.test(trimmed));
};

// ---------------------------------------------------------------------------
// bash reads: cat / grep / sed -n / python -c "open(...)" are reads too
// ---------------------------------------------------------------------------

/** Commands whose arguments are files opened for reading. */
const BASH_READ_VERBS = new Set([
  'cat', 'tac', 'head', 'tail', 'sed', 'awk', 'grep', 'egrep', 'fgrep', 'rg',
  'less', 'more', 'view', 'strings', 'xxd', 'od', 'wc', 'cut', 'sort', 'uniq',
  'diff', 'cmp', 'comm', 'file', 'bat', 'nl', 'fold', 'paste', 'join', 'tr',
  'split', 'csplit', 'base64', 'zcat', 'bzcat', 'xzcat', 'iconv',
  // Copying a source tree is reading it: `cp src/a.js /tmp/x` used to take the
  // file out of scope, after which the read gate could not see it at all.
  'cp', 'install', 'rsync',
]);

/** Commands whose operands are files created or modified. */
const BASH_WRITE_VERBS = new Set([
  'tee', 'cp', 'mv', 'install', 'rsync', 'rm', 'rmdir', 'unlink',
  'truncate', 'touch', 'dd',
]);

/** Prefixes that wrap the real command; the parser strips them. */
const BASH_WRAPPERS = new Set([
  'sudo', 'doas', 'command', 'builtin', 'exec', 'env', 'time', 'nice',
  'nohup', 'ionice', 'stdbuf', 'xargs',
]);

/** Shell operators that start a new command. `||` must precede `|`. */
const SHELL_SEGMENT = /\s*(?:&&|\|\||;|\n|\|)\s*/;

/**
 * Split a command on `&&`, `||`, `;`, newlines and pipes, but never inside a
 * quoted string. A regex split would tear `grep "a|b" file` in half and lose
 * the file operand — which is how a parser starts missing exactly the commands
 * it was written to catch.
 */
const splitShellSegments = (command) => {
  const out = [];
  let buf = '';
  let quote = null;
  for (let i = 0; i < command.length; i += 1) {
    const c = command[i];
    const next = command[i + 1];
    if (quote) {
      buf += c;
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      buf += c;
      continue;
    }
    if ((c === '&' && next === '&') || (c === '|' && next === '|')) {
      out.push(buf);
      buf = '';
      i += 1;
      continue;
    }
    if (c === ';' || c === '\n' || c === '|') {
      out.push(buf);
      buf = '';
      continue;
    }
    buf += c;
  }
  out.push(buf);
  return out;
};

/**
 * Tokenize one shell segment. Quotes are kept so a path with spaces stays one
 * token; the `quoted` flag is what tells `echo "rm -rf /"` apart from an actual
 * `rm -rf /`.
 */
const shellTokens = (segment) => {
  const raw = segment.match(/"[^"]*"|'[^']*'|[^\s]+/g) ?? [];
  return raw.map((t) => ({
    raw: t,
    value: t.replace(/^["']|["']$/g, ''),
    quoted: t.length >= 2 && (t[0] === '"' || t[0] === "'"),
  }));
};

const commandBase = (value) => String(value).replace(/^.*[\\/]/, '').toLowerCase();

/**
 * Strip env assignments and wrappers, then return the real verb and its args.
 *
 * Handles the spellings that used to hide a read: `FOO=1 cat x`, `sudo -u me
 * cat x`, `xargs -0 cat`, `command cat`. It intentionally does not try to be a
 * shell parser; see the note above `bashReadTargets`.
 */
const parseCommandHead = (tokens) => {
  let i = 0;
  while (i < tokens.length) {
    const entry = tokens[i];
    if (!entry.quoted && /^[A-Za-z_][A-Za-z0-9_]*=/.test(entry.value)) {
      i += 1;
      continue;
    }
    const base = commandBase(entry.value);
    if (!BASH_WRAPPERS.has(base)) return { verb: base, args: tokens.slice(i + 1) };
    i += 1;
    // Wrapper options. A few take a scalar operand, which would otherwise be
    // mistaken for the command name (`sudo -u root cat`).
    while (i < tokens.length && !tokens[i].quoted && tokens[i].value.startsWith('-')) {
      const opt = tokens[i].value;
      i += 1;
      if (
        ['-u', '-g', '-p', '-C', '-h', '-r', '-t', '-n', '-I', '-P', '-d', '-L', '-s', '-E', '-a'].includes(opt) &&
        i < tokens.length
      ) {
        i += 1;
      }
    }
    if (base === 'env') {
      while (i < tokens.length && !tokens[i].quoted && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i].value)) i += 1;
    }
  }
  return { verb: '', args: [] };
};

/** Default file probe; injected in tests so the rule layer stays disk-free. */
const defaultIsFile = (p) => {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
};

/** Resolve a shell path token, or null when it is not knowable statically. */
const resolveShellPath = (raw, cwd) => {
  const cleaned = String(raw).replace(/^["']|["']$/g, '');
  if (!cleaned || cleaned.startsWith('-')) return null;
  if (/^[a-z]+:\/\//i.test(cleaned)) return null; // URL
  if (cleaned === '{' || cleaned === '}' || cleaned === '{}' || cleaned === '\\;') return null;
  if (/^\$/.test(cleaned)) return null; // $VAR / ${VAR}: unknowable here
  if (cleaned === '~') return process.env.HOME ?? process.env.USERPROFILE ?? null;
  if (/^~[\\/]/.test(cleaned)) {
    const home = process.env.HOME ?? process.env.USERPROFILE;
    return home ? normalize(join(home, cleaned.slice(2))) : null;
  }
  return normalize(isAbsolute(cleaned) ? cleaned : join(cwd ?? process.cwd(), cleaned));
};

/** Extract quoted path literals from an interpreter one-liner. */
const quotedPaths = (script) =>
  [...String(script).matchAll(/'([^']+)'|"([^"]+)"/g)].map((m) => m[1] ?? m[2]).filter(Boolean);

/** Read-call patterns that hide a path inside a one-liner script. */
const BASH_READ_CALL = /\b(?:open|read_text|read_text_sync|readFileSync|readFile|readFileSync|read_text)\s*\(/;
/** Write-call patterns; `open(..., 'w')` is a write, not a read. */
const BASH_WRITE_CALL =
  /\b(?:writeFileSync|appendFileSync|write_text|write_bytes|writeFile|File\.write|open\s*\([^)]*,\s*['"][wax+])/;

/**
 * Extract what a bash command would read, write, or recursively scan.
 *
 * This is deliberately a *conservative* static parser, not a shell. It handles
 * the shapes that hid real bypasses on a real machine:
 *
 *   - `cd repo && cat src/a.ts` (cwd tracking between segments)
 *   - `git show HEAD:src/a.ts`, `git diff`, `git grep`, `git log -p`
 *   - `find ... -exec cat {} +`, `xargs cat`
 *   - `sh -c 'cat ...'`, `python -c "open(...)"`, `node -e "readFileSync(...)"`
 *   - `cat < src/a.ts`, globs and recursive directory scans
 *   - `sed -i`, `tee`, `cp/mv/rm`, redirections (write targets)
 *
 * Anything the parser cannot resolve (a variable path, an unsupported
 * interpreter) is skipped: over-blocking is handled by the block cap, but a
 * parser that invents paths would block work that has nothing to do with source.
 */
const parseBashCommand = (command, { config = DEFAULT_CONFIG, cwd = null, isFile = defaultIsFile, exists = () => false } = {}, depth = 0) => {
  const files = [];
  const dirs = [];
  const writes = [];
  if (typeof command !== 'string' || command === '' || depth > 2) return { files, dirs, writes };
  let activeCwd = cwd;

  const pushFile = (raw, { allowGlob = true } = {}) => {
    const candidate = resolveShellPath(raw, activeCwd);
    if (!candidate) return;
    if (!isCodeFile(candidate, config)) return;
    if (isExcluded(candidate, config)) return;
    if (isFile(candidate)) {
      files.push(candidate);
      return;
    }
    // A glob (`cat src/*.js`) is a read of everything it expands to. We cannot
    // enumerate it without a real glob walk, so the pattern itself becomes the
    // target: after a graph query it is allowed, before one it is not.
    if (allowGlob && /[*?[\]{}]/.test(candidate)) {
      const wildcard = candidate.search(/[*?[\]{}]/);
      const prefix = candidate.slice(0, wildcard);
      const dir = prefix.endsWith(sep) ? prefix : dirname(prefix);
      if (dir && exists(dir)) files.push(candidate);
    }
  };

  const pushDir = (raw) => {
    const candidate = resolveShellPath(raw, activeCwd);
    if (!candidate || !exists(candidate)) return;
    // Scope a directory through a synthetic code child: the same project-root,
    // exclusion and code-extension logic then applies without a second copy.
    const scope = scopeOf(join(candidate, '.gate-probe.ts'), { config, exists });
    if (!scope.inScope) return;
    dirs.push(candidate);
  };

  const pushWrite = (raw) => {
    const candidate = resolveShellPath(raw, activeCwd);
    if (!candidate) return;
    const base = candidate.replace(/\\/g, '/').split('/').pop()?.toLowerCase();
    if (['/dev/null', 'nul', '/dev/stdout', '/dev/stderr'].includes(base) || candidate.endsWith('/dev/null')) return;
    writes.push(candidate);
  };

  for (const segment of splitShellSegments(command)) {
    if (!segment.trim()) continue;
    const tokens = shellTokens(segment);
    if (tokens.length === 0) continue;
    const { verb, args } = parseCommandHead(tokens);
    if (!verb) continue;
    const values = args.map((a) => a.value);

    if (verb === 'cd' || verb === 'pushd') {
      const target = args.find((a) => a.quoted || !a.value.startsWith('-'));
      const resolved = target ? resolveShellPath(target.value, activeCwd) : null;
      if (resolved) activeCwd = resolved;
      continue;
    }

    // Input redirection is a read; `<<` is a heredoc, not a file read.
    for (const match of segment.matchAll(/(?:^|[^0-9])<\s*("(?:[^"]*)"|'(?:[^']*)'|[^\s;&|]+)/g)) {
      if (match[1].startsWith('<<')) continue;
      pushFile(match[1]);
    }

    // Output redirection is a write. `2>&1` and `>/dev/null` are noise.
    for (const match of segment.matchAll(/(?:^|[^<])(?:\d?>>?)\s*("(?:[^"]*)"|'(?:[^']*)'|[^\s;&|]+)/g)) {
      const target = match[1];
      if (target.startsWith('&') || target === '>&1' || target === '>&2') continue;
      pushWrite(target);
    }

    if (BASH_READ_VERBS.has(verb)) {
      if (verb === 'sed' && values.some((v) => /^-[a-z]*i/.test(v) || v.startsWith('--in-place'))) {
        // In-place sed reads *and* writes; the write side gets the path below,
        // and treating the same path as a read too would double-report it.
      } else {
        for (const value of values) {
          if (value.startsWith('-')) continue;
          pushFile(value);
          // `cp -r src dest`, `rsync -a src/ dest/`: the source may be a tree.
          if ((verb === 'cp' || verb === 'install' || verb === 'rsync') && !isFile(resolveShellPath(value, activeCwd) ?? '')) {
            pushDir(value);
          }
        }
      }
    }

    if (verb === 'git') {
      const sub = commandBase(values[0] ?? '');
      const rest = values.slice(1);
      const dash = rest.indexOf('--');
      const pathValues = dash >= 0 ? rest.slice(dash + 1) : rest;
      const readsGit =
        sub === 'show' || sub === 'diff' || sub === 'grep' || sub === 'blame' || sub === 'cat-file' ||
        (sub === 'log' && rest.some((v) => v === '-p' || v === '--patch' || v === '-u'));
      if (readsGit) {
        const hasPath = pathValues.some((v) => !v.startsWith('-'));
        for (const value of pathValues) {
          if (value.startsWith('-')) continue;
          // `HEAD:src/a.ts` / `HEAD~1:path`
          const colon = value.lastIndexOf(':');
          if (colon > 0 && !/^[A-Za-z]:[\\/]/.test(value)) pushFile(value.slice(colon + 1));
          else pushFile(value);
        }
        // No explicit path means the whole worktree is the target.
        if (!hasPath) pushDir(activeCwd ?? '.');
      }
    }

    if (verb === 'find') {
      const execAt = values.findIndex((v) => ['-exec', '-execdir', '-ok', '-okdir'].includes(v));
      if (execAt >= 0) {
        const root = values[0] && !values[0].startsWith('-') ? values[0] : '.';
        pushDir(root);
        const end = values.findIndex((v, i) => i > execAt && (v === ';' || v === '+'));
        const inner = values.slice(execAt + 1, end < 0 ? values.length : end).join(' ');
        const nested = parseBashCommand(inner, { config, cwd: resolveShellPath(root, activeCwd) ?? activeCwd, isFile, exists }, depth + 1);
        files.push(...nested.files);
        dirs.push(...nested.dirs);
        writes.push(...nested.writes);
      }
      if (values.includes('-delete')) {
        const root = values[0] && !values[0].startsWith('-') ? values[0] : '.';
        pushDir(root);
      }
    }

    if (['sh', 'bash', 'zsh', 'dash', 'ksh', 'cmd', 'powershell', 'pwsh'].includes(verb)) {
      const flagAt = values.findIndex((v) => ['-c', '/c', '/C', '-Command', '-command'].includes(v));
      if (flagAt >= 0 && values[flagAt + 1]) {
        const nested = parseBashCommand(values.slice(flagAt + 1).join(' '), { config, cwd: activeCwd, isFile, exists }, depth + 1);
        files.push(...nested.files);
        dirs.push(...nested.dirs);
        writes.push(...nested.writes);
      }
    }

    if (['python', 'python3', 'node', 'nodejs', 'perl', 'ruby'].includes(verb)) {
      const flagAt = values.findIndex((v) => ['-c', '-e', '--eval', '-Command', '-command'].includes(v));
      const script = flagAt >= 0 ? values.slice(flagAt + 1).join(' ') : '';
      if (script) {
        const paths = quotedPaths(script);
        const reads = BASH_READ_CALL.test(script);
        const writesCall = BASH_WRITE_CALL.test(script);
        for (const p of paths) {
          if (writesCall) pushWrite(p);
          else if (reads) pushFile(p);
        }
      }
    }

    if (BASH_WRITE_VERBS.has(verb) && verb !== 'dd') {
      // cp/mv/rsync/install: the last non-option operand is the destination.
      if (['cp', 'mv', 'install', 'rsync'].includes(verb)) {
        const operands = values.filter((v) => !v.startsWith('-'));
        const tIndex = values.indexOf('-t');
        if (tIndex >= 0 && values[tIndex + 1]) pushWrite(values[tIndex + 1]);
        else if (operands.length >= 2) pushWrite(operands[operands.length - 1]);
      } else if (verb === 'tee') {
        for (const value of values) if (!value.startsWith('-')) pushWrite(value);
      } else if (verb === 'sed' || verb === 'perl') {
        // Handled above for read suppression; in-place operands are files.
      } else {
        for (const value of values) if (!value.startsWith('-')) pushWrite(value);
      }
    }
    if (verb === 'dd') {
      for (const value of values) if (value.startsWith('of=')) pushWrite(value.slice(3));
    }
    if (verb === 'sed' && values.some((v) => /^-[a-z]*i/.test(v) || v.startsWith('--in-place'))) {
      const operands = values.filter((v) => !v.startsWith('-'));
      // First operand is the script; the rest are files.
      for (const value of operands.slice(1)) pushWrite(value);
    }
    if (verb === 'perl' && values.some((v) => /^-[a-z]*i/.test(v) || v.startsWith('--in-place'))) {
      const operands = values.filter((v) => !v.startsWith('-'));
      for (const value of operands.slice(1)) pushWrite(value);
    }

    // Recursive content scans: `grep -r pat src`, `rg pat src`, `git grep pat`.
    const recursive =
      (['grep', 'egrep', 'fgrep'].includes(verb) && values.some((v) => /^-[a-zA-Z]*[rR]/.test(v) || v === '--recursive')) ||
      (verb === 'rg' && !values.includes('--files')) ||
      (verb === 'git' && values[0] === 'grep');
    if (recursive) {
      const candidates = values.filter((v, i) => i > 0 && !v.startsWith('-'));
      const pathArgs = candidates.filter((v) => exists(resolveShellPath(v, activeCwd) ?? ''));
      if (pathArgs.length > 0) for (const p of pathArgs) pushDir(p);
      else pushDir(activeCwd ?? '.');
    }
  }

  const unique = (list) => [...new Set(list)];
  return { files: unique(files), dirs: unique(dirs), writes: unique(writes) };
};

/** Files a bash command would open for reading (the v2 contract). */
export const bashReadTargets = (command, opts = {}) => parseBashCommand(command, opts).files;

/** Directories a bash command would scan recursively (grep -r, find -exec, …). */
export const bashReadDirs = (command, opts = {}) => parseBashCommand(command, opts).dirs;

/** Paths a bash command would create, overwrite or delete. */
export const bashWriteTargets = (command, opts = {}) => parseBashCommand(command, opts).writes;

/** Is this path disposable build output rather than user data? */
const isDisposablePath = (raw, cwd, config) => {
  const resolved = resolveShellPath(raw, cwd);
  if (!resolved) return false;
  const segments = resolved.replace(/\\/g, '/').toLowerCase().split('/').filter(Boolean);
  if (segments.length <= 1) return false; // drive root / "/"
  if (segments.some((s) => s === '..')) return false;
  const home = (process.env.HOME ?? process.env.USERPROFILE ?? '').replace(/\\/g, '/').toLowerCase();
  if (home && (resolved.replace(/\\/g, '/').toLowerCase() === home || home.startsWith(`${resolved.replace(/\\/g, '/').toLowerCase()}/`))) {
    return false;
  }
  const cwdNorm = cwd ? normalize(cwd).replace(/\\/g, '/').toLowerCase() : null;
  const resolvedNorm = resolved.replace(/\\/g, '/').toLowerCase();
  if (cwdNorm && (resolvedNorm === cwdNorm || cwdNorm.startsWith(`${resolvedNorm}/`))) return false;
  const disposable = new Set((config.destructive_disposable_segments ?? []).map((s) => s.toLowerCase()));
  return segments.some((s) => disposable.has(s));
};

/**
 * Detect a destructive shell operation that must not run unattended.
 *
 * This is Layer 0 in mechanical form: the thinking rule says "know the root
 * cause and the impact before you act", and a recursive delete / hard reset /
 * force push is the class of action where acting first is unrecoverable. The
 * rule is intentionally narrow: build directories (`node_modules`, `dist`, …)
 * and temp directories remain disposable, so routine cleanup is not blocked.
 *
 * @returns {{why: string, segment: string}|null}
 */
export const bashDestructiveFinding = (command, { config = DEFAULT_CONFIG, cwd = null } = {}, depth = 0) => {
  if (typeof command !== 'string' || command === '' || depth > 2) return null;
  const allow = (config.destructive_allow_patterns ?? []).some((src) => {
    try {
      return new RegExp(src).test(command);
    } catch {
      return false;
    }
  });
  if (allow) return null;

  let activeCwd = cwd;
  for (const segment of command.split(SHELL_SEGMENT)) {
    if (!segment.trim()) continue;
    const tokens = shellTokens(segment);
    if (tokens.length === 0) continue;
    const { verb, args } = parseCommandHead(tokens);
    if (!verb) continue;
    const values = args.map((a) => a.value);
    const finding = (why) => ({ why, segment: segment.trim().slice(0, 200) });

    if (verb === 'cd' || verb === 'pushd') {
      const target = args.find((a) => a.quoted || !a.value.startsWith('-'));
      const resolved = target ? resolveShellPath(target.value, activeCwd) : null;
      if (resolved) activeCwd = resolved;
      continue;
    }

    // Recursively inspect a nested shell: `bash -c 'git reset --hard'`.
    if (['sh', 'bash', 'zsh', 'dash', 'ksh', 'cmd', 'powershell', 'pwsh'].includes(verb)) {
      const flagAt = values.findIndex((v) => ['-c', '/c', '/C', '-Command', '-command'].includes(v));
      if (flagAt >= 0 && values[flagAt + 1]) {
        const nested = bashDestructiveFinding(values.slice(flagAt + 1).join(' '), { config, cwd: activeCwd }, depth + 1);
        if (nested) return nested;
      }
      continue;
    }

    if (verb === 'rm' || verb === 'rmdir' || verb === 'unlink') {
      const recursive = values.some((v) => /^-[a-z]*[rR]/.test(v) || v === '--recursive');
      const force = values.some((v) => /^-[a-z]*f/.test(v) || v === '--force');
      const targets = values.filter((v) => !v.startsWith('-'));
      const dangerous = targets.filter((t) => !isDisposablePath(t, activeCwd, config));
      if (dangerous.length > 0 && (recursive || force || targets.length > 1)) {
        return finding(`${verb} ${recursive ? 'recursive ' : ''}${force ? 'forced ' : ''}on ${dangerous[0]}`);
      }
    }

    if (verb === 'git') {
      const sub = commandBase(values[0] ?? '');
      const rest = values.slice(1);
      if (sub === 'reset' && rest.includes('--hard')) return finding('git reset --hard discards uncommitted work');
      if (sub === 'clean' && rest.some((v) => /^-[a-z]*f/.test(v) || v === '--force')) {
        return finding('git clean --force deletes untracked files');
      }
      if (sub === 'checkout' && (rest.includes('--') || rest.includes('.'))) {
        return finding('git checkout -- . discards uncommitted work');
      }
      if (sub === 'restore' && !rest.includes('--staged')) {
        return finding('git restore discards uncommitted work');
      }
      if (sub === 'push' && rest.some((v) => v === '--force' || v === '--force-with-lease' || /^-f$/.test(v))) {
        return finding('git push --force rewrites shared history');
      }
      if (sub === 'branch' && rest.some((v) => /^-[a-zA-Z]*D/.test(v) || v === '--delete')) {
        return finding('git branch --delete removes a branch');
      }
      if (['filter-branch', 'filter-repo'].includes(sub)) return finding(`git ${sub} rewrites history`);
      if (sub === 'stash' && ['drop', 'clear'].includes(rest[0])) return finding(`git stash ${rest[0]}`);
    }

    if (verb === 'find' && values.includes('-delete')) {
      const root = values.find((v) => !v.startsWith('-')) ?? '.';
      if (!isDisposablePath(root, activeCwd, config)) return finding(`find ${root} -delete`);
    }

    if (verb === 'dd' && values.some((v) => v.startsWith('of='))) {
      const target = values.find((v) => v.startsWith('of=')).slice(3);
      if (!['/dev/null', 'nul'].includes(target.toLowerCase()) && !isDisposablePath(target, activeCwd, config)) {
        return finding(`dd of=${target}`);
      }
    }

    if (/^(?:mkfs|fdisk|parted|diskpart|format)/.test(verb) || ['shutdown', 'reboot', 'poweroff', 'halt'].includes(verb)) {
      return finding(`${verb} is a host-level destructive command`);
    }
    if (verb === 'init' && ['0', '6'].includes(values[0])) return finding('init 0/6 shuts the machine down');
    if (verb === 'taskkill' && values.some((v) => v.toLowerCase() === '/f')) return finding('taskkill /F forcibly terminates processes');

    if (['del', 'erase'].includes(verb) && values.some((v) => ['/s', '/q', '/f'].includes(v.toLowerCase()))) {
      return finding(`${verb} deletes files recursively`);
    }
    if (['rd', 'rmdir'].includes(verb) && values.some((v) => v.toLowerCase() === '/s')) {
      return finding(`${verb} /s deletes a tree`);
    }
    if (verb === 'remove-item' && values.some((v) => v.toLowerCase().startsWith('-recurse'))) {
      const target = values.find((v) => !v.startsWith('-'));
      if (!target || !isDisposablePath(target, activeCwd, config)) return finding('Remove-Item -Recurse');
    }
    if (verb === 'stop-computer') return finding('Stop-Computer shuts the machine down');

    if (['chmod', 'chown', 'chgrp'].includes(verb) && values.some((v) => /^-[a-z]*R/.test(v))) {
      const target = values.filter((v) => !v.startsWith('-')).pop();
      if (target && !isDisposablePath(target, activeCwd, config)) return finding(`${verb} -R on ${target}`);
    }

    const sql = `${verb} ${values.join(' ')}`.toLowerCase();
    if (/^(?:drop\s+(?:table|database|schema)|truncate\s+table)\b/.test(sql)) return finding('destructive SQL');
  }
  return null;
};


// ---------------------------------------------------------------------------
// Index freshness
// ---------------------------------------------------------------------------

/**
 * The filesystem facts a check may consult, injected so the rule layer stays
 * unit-testable off-harness (a harness with a virtual or remote filesystem can
 * still be policed, and the test suite needs no disk).
 *
 * Each probe is TOTAL: it answers, it never throws. A probe that can throw
 * turns a filesystem hiccup into a dead gate, and a gate that stops existing is
 * the one failure this whole design is built to avoid.
 */
const NO_FS = {
  exists: () => false,
  isFile: () => false,
  statMtime: () => 0,
  listDir: () => [],
};

/** Newest mtime inside a directory, or 0 when it cannot be read. */
export const newestMtimeIn = (dir, fs, now = Date.now(), ttlMs = 0) => {
  const hit = mtimeCache.get(dir);
  // `now >= hit.at` rather than trusting the clock: a backwards clock must not
  // make a stale answer look fresh. Keeping the comparison on the arguments
  // (instead of calling Date.now() in here) is what makes the TTL testable
  // without fake timers.
  if (hit && now >= hit.at && now - hit.at <= ttlMs) return hit.mtime;

  let newest = 0;
  for (const name of fs.listDir(dir)) {
    const m = fs.statMtime(join(dir, name));
    if (m > newest) newest = m;
  }
  mtimeCache.set(dir, { at: now, mtime: newest });
  return newest;
};

/**
 * Module-level on purpose: this caches a fact about the disk, not about a
 * session's permissions, so a per-session reset must not clear it. Exported for
 * tests; not part of the policy contract.
 */
export const resetMtimeCache = () => mtimeCache.clear();

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

/**
 * A check answers one question about one tool call and returns either null
 * (abstain) or a `{ code, reason }` denial.
 *
 * `input` is the normalized shape every adapter produces:
 *   { action: 'read'|'write'|'bash'|'other', path: string|null, tool: string }
 *
 * `deps` carries what a check may need from the running harness:
 *   { exists(dir): boolean, state, now: number }
 *
 * CASCADE ORDER
 * -------------
 * `shouldBlock` stops at the FIRST check that returns a verdict, so the order
 * of the policy's `checks` array decides which layer speaks. The shipped
 * policies list the two Layer-2 checks BEFORE `graph-before-read`, because:
 *
 *   - an unindexed repository must hear "build the index first", not
 *     "the index exists, query the graph" — with the reverse order Layer 2 is
 *     unreachable and the Layer-1 wording is simply false;
 *   - the reverse order was tried once, on the theory that Layer 2 would
 *     re-block a session right after its first graph query. It would not: both
 *     Layer-2 checks short-circuit on a fresh signal, exactly like
 *     `graph-before-read`. The theory was wrong and the order it produced hid
 *     the index rules on every unindexed repository.
 *
 * A policy that lists only `graph-before-read` remains valid and means "always
 * ask the graph first"; the cascade is a property of the array, not the code.
 */
const CHECKS = {
  /**
   * Layer 0: do not overwrite a file you have never looked at.
   *
   * The v2 gate only policed reads. A model could query the graph about one
   * file, then edit any other file in the repository without ever opening it —
   * mechanical action, which is exactly what the first rule forbids. This check
   * demands evidence about the *specific* target: a successful read of that
   * file or a scoped graph unlock that named it. A fresh session-wide signal is
   * deliberately NOT enough (that is the "I queried once" hole in a new coat).
   *
   * New files are exempt from target evidence: there is nothing to inspect yet,
   * and requiring a graph hit would brick the first file in an empty repo. The
   * convention check still applies to them.
   */
  /**
   * ai-spec Layer 0.5：改代码前必须核对该改动对应的立项 CHG 契约。
   *
   * 与 `think-before-write` 的分工：
   *   - `think-before-write` 管「你看过这个文件吗」（图层/证据）
   *   - 本检查管「这个改动属于哪个 CHG、那个 CHG 契约齐全吗」（契约/范围）
   *
   * 两者都过，才允许改代码。缺前者 = 篡改；缺后者 = 跑偏。
   */
  'chg-contract-before-edit': (policy, input, deps) => {
    if (input.action !== 'write') return null;
    const config = policy.config;
    if (config.require_chg_contract === false) return null;

    const norm = normalizePath(input.path);
    const scope = scopeOf(norm, { config, exists: deps.exists });
    if (!scope.inScope || !scope.root) return null;
    // 只约束代码：改文档 / 数据 / 台账不要求 CHG 契约。
    if (!isCodeFile(norm, config)) return null;

    const read = [...deps.state.docReads].some((p) =>
      isChgContract(normalizePath(p), config),
    );
    if (read) return null;

    return {
      code: 'CHG_CONTRACT',
      reason: [
        '⛔ ai-spec 门控：改代码前没有核对立项 CHG 的契约。',
        `  目标：${norm}`,
        '  缺口：本会话没有读过任何 tasks/CHG-*/ 下的 SPEC / PRD / CHANGE / TRACEABILITY。',
        '',
        '先做（按序，缺一不可）：',
        '  1) 定位本次开发属于哪个 CHG：ls tasks/CHG-*/（按 date-slug 判定）',
        '  2) 读它的四件套（至少 SPEC）：',
        '     read tasks/CHG-<id>/SPEC.md          # 目标 / 独占文件 / 验收断言 / 绝不做什么',
        '     read tasks/CHG-<id>/PRD.md           # 承诺什么、不承诺什么',
        '     read tasks/CHG-<id>/TRACEABILITY.md  # 每条 AC 的证据在哪',
        '  3) 五问自检再动手：',
        '     · 这个改动属于哪个 CHG？（答不出 = 不许改）',
        '     · 该 CHG 四件套齐全吗？（缺哪件就先补，缺料不许开工）',
        '     · 目标文件在该 CHG 的「独占文件」清单里吗？（不在 = 可能越界）',
        '     · 改完哪条 AC 会从红变绿？（答不出 = 没有验收目标）',
        '     · 是先用第一性原理判了根因，还是照症状打补丁？',
        '',
        '开发中发现的问题必须当场修，不许留给「后续」；',
        '收尾必须让该 CHG 的预定功能目标达成，而不是「大部分做完」。',
        '',
        '这条不是建议：未核对契约的代码改动一律拒绝。',
      ].join('\n'),
    };
  },

  'think-before-write': (policy, input, deps) => {
    if (input.action !== 'write' && input.action !== 'bash') return null;
    const config = policy.config;
    if (config.require_target_evidence === false && config.require_conventions === false) return null;

    const targets = input.action === 'write'
      ? [input.path]
      : bashWriteTargets(input.command, {
          config,
          cwd: input.cwd ?? null,
          isFile: deps.isFile,
          exists: deps.exists,
        });
    if (targets.length === 0) return null;

    const roots = new Set();
    for (const target of targets) {
      if (!target) continue;
      const norm = normalizePath(target);
      const scope = scopeOf(norm, { config, exists: deps.exists });
      if (!scope.inScope || !scope.root) continue;
      roots.add(scope.root);
      if (config.require_target_evidence !== false) {
        if (deps.state.written.has(norm)) continue;
        // A directory or a path that does not exist yet: nothing to inspect.
        if (!deps.isFile(norm)) continue;
        if (deps.state.inspected.has(norm)) continue;
        if (hasScopedUnlock(deps.state, norm, config, deps.now)) continue;
        return {
          code: 'THINK_TARGET',
          reason: [
            '⛔ 动脑子铁律 · Layer 0 拦截：动手前没有看过这个文件。',
            `  目标：${norm}`,
            `  工具：${input.tool ?? input.action}`,
            '  证据缺口：本会话既没有成功读取过它，也没有一次图谱查询点名过它。',
            '',
            '先做（任一即可）：',
            '  a) read 这个文件（read 本身通过 Layer 1 后即可）；',
            '  b) search_graph / get_code_snippet / trace_path / query_graph 查询并命中它',
            '     （命中后 30 分钟内该目标可改）。',
            '然后重试。不要在没看代码、没判根因的情况下直接改。',
            '',
            '顺手过一遍五问：项目约定？环境现状？字面背后的真实需求？任务目的？产出价值？',
          ].join('\n'),
        };
      }
    }

    if (config.require_conventions) {
      for (const root of roots) {
        const docs = (config.convention_files ?? []).filter((name) => deps.exists(join(root, name)));
        if (docs.length === 0) continue;
        const read = [...deps.state.docReads].some(
          (p) => withinRoot(root, p) && isConventionDoc(p, config),
        );
        if (read) continue;
        return {
          code: 'THINK_CONVENTIONS',
          reason: [
            '⛔ 动脑子铁律 · Layer 0 拦截：还没读项目约定就要改代码。',
            `  仓库：${root}`,
            `  存在的约定文件：${docs.join(', ')}`,
            '',
            '先 read 其中一个（AGENTS.md / CLAUDE.md / CONTRIBUTING.md / .cursorrules），',
            '确认架构、约定和当前状态后再动手。没有约定文件的仓库不触发这条。',
          ].join('\n'),
        };
      }
    }
    return null;
  },

  /**
   * Layer 0: a failing command repeated verbatim is not debugging, it is
   * flailing. After `max_identical_failures` failures the model must do
   * something investigative (read, graph query, or a real edit) before running
   * the same command again. The evidence timestamp, not a timer, is what opens
   * it — "wait a bit and retry" is still mechanical.
   */
  'no-blind-retry': (policy, input, deps) => {
    if (input.action !== 'bash') return null;
    const config = policy.config;
    const key = normalizeCommand(input.command);
    if (!key) return null;
    const rec = deps.state.failedCommands.get(key);
    if (!rec || rec.count < config.max_identical_failures) return null;
    if (deps.now - rec.lastAt > config.retry_window_ms) return null;
    if (deps.state.lastInvestigationAt >= rec.lastAt) return null;
    return {
      code: 'BLIND_RETRY',
      reason: [
        '⛔ 动脑子铁律 · Layer 0 拦截：同一条命令已经失败 ' + rec.count + ' 次，仍要原样重试。',
        `  命令：${String(input.command).slice(0, 200)}`,
        '',
        '先判根因，再重试。做下面任一动作即可解除：',
        '  - 读失败输出对应的代码（read / get_code_snippet）；',
        '  - 查图谱（search_graph / trace_path / query_graph）；',
        '  - 做出真正的修改（write / edit）。',
        '不要靠“再跑一次看看”推进。',
      ].join('\n'),
    };
  },

  /**
   * Layer 0: destructive shell operations never run unattended.
   *
   * This is hard (not subject to the block cap). Deleting a source tree, hard
   * resetting a worktree, force-pushing history or dropping a database is the
   * class of action where "act first, understand later" is unrecoverable. Build
   * output directories and temporary paths stay disposable so routine cleanup
   * is not blocked.
   */
  'no-destructive-bash': (policy, input, deps) => {
    if (input.action !== 'bash') return null;
    const finding = bashDestructiveFinding(input.command, {
      config: policy.config,
      cwd: input.cwd ?? null,
    });
    if (!finding) return null;
    return {
      code: 'DESTRUCTIVE_BASH',
      reason: [
        '⛔ 动脑子铁律 · Layer 0 拦截：破坏性命令不允许自动执行。',
        `  原因：${finding.why}`,
        `  命令：${finding.segment}`,
        '',
        '先确认根因和影响范围；确实要做，请主人手动执行，或把该模式加入',
        'policy.json 的 config.destructive_allow_patterns。',
        'node_modules / dist / build / .venv 等构建产物的清理不受此限制。',
      ].join('\n'),
    };
  },

  /** Don't read source before consulting the code graph. */
  'graph-before-read': (policy, input, deps) => {
    if (input.action !== 'read') return null;
    const scope = scopeOf(input.path, { config: policy.config, exists: deps.exists });
    if (!scope.inScope) return null;
    if (deps.state.written.has(input.path)) return null;
    if (hasUnlock(deps.state, input.path, policy.config, deps.now)) return null;
    return {
      code: 'GRAPH_FIRST',
      reason: [
        '⛔ 三层铁律 · Layer 1 拦截：本次读取没有图谱依据。',
        `  文件：${input.path}`,
        `  依据：${scope.reason}（项目根：${scope.root ?? '未知'}）`,
        '',
        '解除方式（二选一，都需要**成功且有内容**的图谱调用）：',
        '  a) 针对本文件/本包查一次：search_graph / trace_path / get_code_snippet /',
        '     query_graph / get_architecture / search_code（查询里提到文件名或包名，',
        '     命中后 30 分钟内该目标的读取都放行）；',
        '  b) 任何一次有结果的图谱调用会给本会话一个 10 分钟的窗口。',
        '如果查询返回空结果，不算合规：先查 index_status / 重新索引，回到图谱重查；',
        '不允许“搜不到就直接 read”。',
        '本会话内你自己刚改过的文件不受此限制。',
      ].join('\n'),
    };
  },

  /** The same rule for reads that arrive as bash commands (cat/grep/sed -n/…). */
  'bash-graph-before-read': (policy, input, deps) => {
    if (input.action !== 'bash') return null;
    if (policy.config.bash_read_check === false) return null;
    const opts = {
      config: policy.config,
      cwd: input.cwd ?? null,
      isFile: deps.isFile,
      exists: deps.exists,
    };
    const targets = bashReadTargets(input.command, opts);
    const dirs = bashReadDirs(input.command, opts);
    if (targets.length === 0 && dirs.length === 0) return null;

    const blockedFile = targets.find((target) => {
      const scope = scopeOf(target, { config: policy.config, exists: deps.exists });
      if (!scope.inScope) return false;
      if (deps.state.written.has(normalizePath(target))) return false;
      return !hasUnlock(deps.state, target, policy.config, deps.now);
    });
    const blockedDir = dirs.find((dir) => {
      if (deps.state.written.has(normalizePath(dir))) return false;
      return !hasUnlock(deps.state, dir, policy.config, deps.now);
    });
    if (!blockedFile && !blockedDir) return null;

    return {
      code: 'GRAPH_FIRST_BASH',
      reason: [
        '⛔ 三层铁律 · Layer 1 拦截：用 bash 读源码和用 read 工具读源码是同一件事。',
        `  命令：${String(input.command).slice(0, 200)}`,
        blockedFile ? `  目标文件：${blockedFile}` : `  目标目录：${blockedDir}`,
        targets.length > 1 || dirs.length > 1
          ? `  （共识别到 ${targets.length} 个文件、${dirs.length} 个目录，只列了第一个）`
          : '',
        '',
        '先查图谱（search_graph / trace_path / get_code_snippet / query_graph /',
        'get_architecture / search_code），查询里提到该文件/包/目录，然后重试。',
        'cat / grep -r / sed -n / git show / git diff / find -exec / xargs 都在范围内；',
        'git status / ls / find 只列名字不受影响。',
      ]
        .filter(Boolean)
        .join('\n'),
    };
  },

  /**
   * A read that the rule wants gated on an index existing at all.
   *
   * Opt-in, not default. codebase-memory's live index normally lives in the
   * tool's own data directory, not in `<repo>/.codebase-memory` (that marker
   * only exists when persistence was requested). Enabling this check on a
   * global index therefore blocks every read until the cap, and the v3 answer
   * is evidence instead: an empty graph result no longer counts as a signal, so
   * an unindexed project cannot buy a read window at all. Keep this check for
   * teams that do commit the persisted artifact.
   */
  'index-before-read': (policy, input, deps) => {
    if (input.action !== 'read') return null;
    const scope = scopeOf(input.path, { config: policy.config, exists: deps.exists });
    if (!scope.inScope || !scope.root) return null;
    if (deps.state.written.has(input.path)) return null;
    const marker = join(scope.root, policy.config.index_marker);
    if (deps.exists(marker)) return null;
    return {
      code: 'INDEX_FIRST',
      reason: [
        '⛔ 三层铁律 · Layer 2 拦截：该项目尚未建立 codebase-memory 索引。',
        `  仓库：${scope.root}`,
        `  缺少：${marker}`,
        '',
        `正确动作：先调用 index_repository（repo_path 取 ${scope.root}；模式按规模选 full/moderate/fast）`,
        '建立索引与 embedding；索引完成后回到 Layer 1 查图谱（search_graph / trace_path /',
        'get_code_snippet 等），最后才可直读。',
        '若你的索引是全局存储（没有 .codebase-memory 持久化产物），请从 policy.json 的',
        'checks 里去掉本项：它无法验证全局索引，会误拦。',
      ].join('\n'),
    };
  },

  /**
   * The index exists but the file is newer than anything inside it.
   *
   * v3 removes the "fresh graph signal" shortcut. A query against a stale index
   * is precisely the failure this check exists to catch: letting that query
   * stand the rule down made the check unreachable in practice. The session's
   * own writes remain exempt (they are always newer than the index they are
   * about to update), and the check still abstains when the marker or its
   * mtimes are unreadable.
   */
  'index-freshness-before-read': (policy, input, deps) => {
    if (input.action !== 'read') return null;
    const scope = scopeOf(input.path, { config: policy.config, exists: deps.exists });
    if (!scope.inScope || !scope.root) return null;
    if (deps.state.written.has(input.path)) return null;

    const marker = join(scope.root, policy.config.index_marker);
    if (!deps.exists(marker)) return null; // index-before-read owns that case

    const mtime = deps.statMtime(input.path);
    if (!(mtime > 0)) return null; // vanished, unreadable, or a directory: abstain
    const indexMtime = newestMtimeIn(marker, deps, deps.now, policy.config.index_mtime_ttl_ms);
    if (!(indexMtime > 0)) return null; // index directory unreadable or empty: abstain
    if (mtime <= indexMtime + policy.config.index_mtime_epsilon_ms) return null;

    return {
      code: 'INDEX_STALE',
      reason: [
        '⛔ 三层铁律 · Layer 2 拦截：索引疑似过期——目标文件比索引新（embedding 落后于代码变更）。',
        `  目标：${input.path}`,
        `  所属已索引项目：${scope.root}`,
        '',
        '正确动作：先 detect_changes 检查影响范围，或 index_repository 重新索引；完成后回到',
        'Layer 1 查图谱，最后才可直读。',
        '这次查询成功也不能代替索引更新：查的是旧图，读的是新代码。',
        '本会话内你自己刚改过的文件不受此拦截。',
      ].join('\n'),
    };
  },

  /** Never write outside the paths the user declared writable. */
  'no-write-outside': (policy, input, deps) => {
    if (input.action !== 'write' && input.action !== 'bash') return null;
    const allowed = policy.config.write_roots ?? [];
    if (allowed.length === 0) return null;
    const targets = input.action === 'write'
      ? [input.path].filter(Boolean)
      : bashWriteTargets(input.command, {
          config: policy.config,
          cwd: input.cwd ?? null,
          isFile: deps.isFile,
          exists: deps.exists,
        });
    if (targets.length === 0) return null;
    const outside = targets.filter((p) => !allowed.some((r) => withinRoot(r, p)));
    if (outside.length === 0) return null;
    return {
      code: 'WRITE_OUTSIDE',
      reason: [
        'Blocked: writing outside the allowed roots.',
        `  path    : ${outside[0]}`,
        outside.length > 1 ? `  (and ${outside.length - 1} more)` : '',
        `  allowed : ${allowed.join(', ')}`,
        '',
        'Add the root to config.write_roots in the gate policy if this write is intended.',
        'This also covers shell writes (redirection, tee, cp/mv, rm).',
      ]
        .filter(Boolean)
        .join('\n'),
    };
  },

  /** Never let a credential-shaped string be written into a tracked file. */
  'no-secret-write': (policy, input, deps) => {
    if (input.action !== 'write' && input.action !== 'bash') return null;
    const isBash = input.action === 'bash';
    if (isBash) {
      // Only scan when the command actually writes; `git commit -m "..."` is
      // not a file write and must not be judged as one.
      const writes = bashWriteTargets(input.command, {
        config: policy.config,
        cwd: input.cwd ?? null,
        isFile: deps.isFile,
        exists: deps.exists,
      });
      if (writes.length === 0) return null;
    }
    const text = input.content ?? (isBash ? input.command : '');
    if (typeof text !== 'string' || text === '') return null;
    const hits = scanForSecrets(text, policy.config);
    if (hits.length === 0) return null;
    return {
      code: 'SECRET_WRITE',
      reason: [
        'Blocked: the content being written looks like it contains a real credential.',
        ...hits.slice(0, 5).map((h) => `  ${h}`),
        '',
        'Replace it with a placeholder and keep the real value outside the repository.',
        isBash ? 'Shell writes (redirection, tee, sed -i) are covered by this rule too.' : '',
      ]
        .filter(Boolean)
        .join('\n'),
    };
  },
};

/** Patterns that should never be committed. Deliberately the same families the
 * repository scanner uses, so the two cannot disagree about "what is a secret". */
const SECRET_PATTERNS = [
  ['private key block', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['api key assignment', /(api[_-]?key|apikey|token|secret|password|passwd)["'`]?\s*[:=]\s*["'`]?[A-Za-z0-9_\-]{16,}/i],
  ['long opaque token', /(^|[^A-Za-z0-9_+=])[A-Za-z0-9_+=]{40,}([^A-Za-z0-9_+=]|$)/],
  ['email address', /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/],
];

export const scanForSecrets = (text, config = DEFAULT_CONFIG) => {
  const allowed = config.secret_allow_patterns ?? [
    'example\\.com',
    '127\\.0\\.0\\.1',
    '\\$\\{[A-Za-z_][A-Za-z0-9_]*\\}',
    '<[^<>\\s]+>',
  ];
  const allow = new RegExp(allowed.join('|'));
  const hits = [];
  for (const [label, re] of SECRET_PATTERNS) {
    const m = re.exec(text);
    if (m && !allow.test(m[0])) {
      const sample = m[0].length > 40 ? `${m[0].slice(0, 20)}…` : m[0];
      hits.push(`${label}: ${sample.replace(/\s+/g, ' ')}`);
    }
  }
  return hits;
};

export const CHECK_NAMES = Object.keys(CHECKS);

/**
 * Checks that stay on after the per-session block cap.
 *
 * The cap exists so a mis-written research rule cannot brick an agent. It must
 * not also switch off safety: before v3, `shouldBlock` returned early once the
 * cap was reached, which turned 30 graph blocks into a free pass to write a
 * credential anywhere. Layer-0/1/2 checks are capped; the security checks are
 * not.
 */
export const HARD_CHECKS = new Set([
  'no-write-outside',
  'no-secret-write',
  'no-destructive-bash',
  // ai-spec 契约门控：不得因拦截上限而失效——它守的是「不跑偏」，与安全同级。
  'chg-contract-before-edit',
]);

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

/**
 * Decide whether to block a normalized tool call.
 *
 * @param {object} args
 * @param {object} args.policy
 * @param {{action:string, path:string|null, tool:string, content?:string}} args.input
 * @param {object} args.state   from newSessionState()
 * @param {(p:string)=>boolean} [args.exists]  filesystem probe, injected
 * @param {object} [args.fs]    full probe: {exists, isFile, statMtime, listDir}. Supersedes `exists`.
 * @param {number} [args.now]
 * @returns {{block: boolean, code: string|null, reason: string|null, capReached: boolean}}
 */
export const shouldBlock = ({ policy, input, state, exists, fs, now = Date.now() }) => {
  const cap = policy.config.max_blocks_per_session;
  const overCap = cap >= 0 && state.blocks >= cap;

  // One probe object, so a check that needs more than `exists` can get it
  // without each check inventing its own seam. The flat `exists` shape stays
  // supported because it is what the unit tests and simpler harnesses pass.
  const probes = fs ?? { ...NO_FS, exists: typeof exists === 'function' ? exists : NO_FS.exists };

  const enabled = new Set(policy.checks.length > 0 ? policy.checks : ['graph-before-read']);
  for (const name of enabled) {
    // After the cap, only the safety checks keep running. The research rules
    // stand down so a false positive cannot brick the session; hiding a secret
    // or deleting a tree has no such excuse.
    if (overCap && !HARD_CHECKS.has(name)) continue;
    const check = CHECKS[name];
    if (!check) continue; // unknown check names are ignored, not fatal
    const verdict = check(policy, input, { state, exists: probes.exists, fs: probes, ...probes, now });
    if (verdict) {
      state.blocks += 1;
      return { block: true, code: verdict.code, reason: verdict.reason, capReached: false };
    }
  }
  return { block: false, code: null, reason: null, capReached: overCap };
};

/**
 * The per-turn nudge appended to the model's context.
 *
 * A gate that only says "no" teaches nothing; the reminder is what makes the
 * rule learnable. Returns null when the session is already compliant, so a
 * well-behaved session is not nagged.
 */
export const reminderFor = (policy, state, now = Date.now()) => {
  if (!policy.reminded) return null;
  // A session-wide signal silences the reminder, except while Layer 0 still
  // has a specific gap: the model has queried the graph but has not read the
  // project's conventions yet. Silence there would teach "query once, then act",
  // which is the habit the thinking rule exists to break.
  const conventionsPending =
    policy.checks.includes('think-before-write') &&
    policy.config.require_conventions &&
    state.docReads.size === 0;
  if (hasFreshSignal(state, policy.config.signal_ttl_ms, now) && !conventionsPending) return null;
  return policy.reminded;
};

export const globHelpers = { toPosix, posix };
