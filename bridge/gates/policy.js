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

/** One spelling for a token: forward slashes, no drive prefix, lowercase. */
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
export const hasUnlock = (state, path, config = DEFAULT_CONFIG, now = Date.now()) => {
  if (hasFreshSignal(state, config.signal_ttl_ms, now)) return true;
  if (!path || !state?.unlocks || state.unlocks.size === 0) return false;
  const norm = String(path).replace(/\\/g, '/').toLowerCase();
  for (const [key, at] of state.unlocks) {
    if (now - at > config.unlock_ttl_ms) continue;
    if (norm.includes(key)) return true;
  }
  return false;
};

// ---------------------------------------------------------------------------
// bash reads: cat / grep / sed -n / python -c "open(...)" are reads too
// ---------------------------------------------------------------------------

/** Commands whose arguments are files opened for reading. */
const BASH_READ_VERBS = new Set([
  'cat', 'tac', 'head', 'tail', 'sed', 'awk', 'grep', 'egrep', 'fgrep', 'rg',
  'less', 'more', 'view', 'strings', 'xxd', 'od', 'wc', 'cut', 'sort', 'uniq',
  'diff', 'cmp', 'comm', 'file', 'bat', 'nl', 'fold', 'paste', 'join', 'tr',
  'split', 'csplit',
]);

/** Read-call patterns that hide a path inside a one-liner script. */
const BASH_READ_CALL = /\b(?:open|read_text|read_text_sync|readFileSync|readFile)\s*\(/;

/** Default file probe; injected in tests so the rule layer stays disk-free. */
const defaultIsFile = (p) => {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
};

/**
 * Extract the files a bash command would open for reading.
 *
 * Conservative on purpose: only files that exist, look like source and are not
 * excluded count; globs and URLs are skipped because the rule cannot know what
 * they hit. Interpreters (`node script.mjs`) are execution, not reading, so
 * they are not verbs — but an explicit read call inside `-e`/`-c` still counts.
 */
export const bashReadTargets = (command, { config = DEFAULT_CONFIG, cwd = null, isFile = defaultIsFile, exists = () => false } = {}) => {
  if (typeof command !== 'string' || command === '') return [];
  const spool = [];
  const push = (token) => {
    if (!token || token.startsWith('-')) return;
    if (/^[a-z]+:\/\//i.test(token)) return; // URL
    if (/[*?[\]{}]/.test(token)) return; // glob: unknowable here
    const candidate = isAbsolute(token) ? token : join(cwd ?? process.cwd(), token);
    if (!isFile(candidate)) return;
    if (!isCodeFile(candidate, config)) return;
    if (isExcluded(candidate, config)) return;
    spool.push(normalize(candidate));
  };
  for (const segment of command.split(/\s*(?:&&|\|\||;|\n|\|)\s*/)) {
    const tokens = segment.match(/"[^"]*"|'[^']*'|[^\s]+/g);
    if (!tokens || tokens.length === 0) continue;
    const verb = tokens[0].replace(/^.*[\\/]/, '').toLowerCase();
    const bare = tokens.slice(1).map((t) => t.replace(/^["']|["']$/g, ''));
    if (BASH_READ_VERBS.has(verb)) {
      // `sed -n '1,20p' file` / `grep pattern file`: skip non-path operands
      for (const token of bare) push(token);
      continue;
    }
    if (BASH_READ_CALL.test(segment)) {
      for (const token of bare) {
        // The path hides inside a quoted expression: python -c "open('a/b.js')"
        const quoted = token.match(/'[^']+'|"[^"]+"/g) ?? [];
        const candidates = quoted.length > 0 ? quoted.map((q) => q.slice(1, -1)) : [token];
        for (const cand of candidates) {
          if (!/[\\/]|\.(?:js|mjs|cjs|ts|tsx|py|md|json|html|css|vue|svelte)$/i.test(cand)) continue;
          push(cand);
        }
      }
    }
  }
  // `exists` is accepted for symmetry with the other probes; `isFile` already ran.
  void exists;
  return [...new Set(spool)];
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
        '解除方式（二选一，都需要**成功**的图谱调用）：',
        '  a) 针对本文件/本包查一次：search_graph / trace_path / get_code_snippet /',
        '     query_graph / get_architecture / search_code（查询里提到文件名或包名，',
        '     命中后 30 分钟内该目标的读取都放行）；',
        '  b) 任何一次成功的图谱调用会给本会话一个 10 分钟的窗口（窗口很短，',
        '     过了就要重新查）。',
        '本会话内你自己刚改过的文件不受此限制。',
        '这是 AGENTS.md 的强制规则（先问图谱，再无细节，最后才读文件），不是可选项。',
      ].join('\n'),
    };
  },

  /** The same rule for reads that arrive as bash commands (cat/grep/sed -n/…). */
  'bash-graph-before-read': (policy, input, deps) => {
    if (input.action !== 'bash') return null;
    if (policy.config.bash_read_check === false) return null;
    const targets = bashReadTargets(input.command, {
      config: policy.config,
      cwd: input.cwd ?? null,
      isFile: deps.isFile,
      exists: deps.exists,
    });
    if (targets.length === 0) return null;
    const target = targets[0];
    const scope = scopeOf(target, { config: policy.config, exists: deps.exists });
    if (!scope.inScope) return null;
    if (deps.state.written.has(normalizePath(target))) return null;
    if (hasUnlock(deps.state, target, policy.config, deps.now)) return null;
    return {
      code: 'GRAPH_FIRST_BASH',
      reason: [
        '⛔ 三层铁律 · Layer 1 拦截：用 bash 读源码和用 read 工具读源码是同一件事。',
        `  命令：${String(input.command).slice(0, 200)}`,
        `  目标文件：${target}`,
        targets.length > 1 ? `  （共识别到 ${targets.length} 个目标，只列了第一个）` : '',
        '',
        '先查图谱（search_graph / trace_path / get_code_snippet / query_graph /',
        'get_architecture / search_code），查询里提到该文件或所在包，然后重试。',
        'git status / git log / ls 等不读内容的命令不受影响。',
      ]
        .filter(Boolean)
        .join('\n'),
    };
  },

  /** A read that the rule wants gated on an index existing at all. */
  'index-before-read': (policy, input, deps) => {
    if (input.action !== 'read') return null;
    const scope = scopeOf(input.path, { config: policy.config, exists: deps.exists });
    if (!scope.inScope || !scope.root) return null;
    if (deps.state.written.has(input.path)) return null;
    if (hasUnlock(deps.state, input.path, policy.config, deps.now)) return null;
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
        '若确属一次性临时片段不值得建索引，向主人说明理由后依赖拦截上限兜底。',
      ].join('\n'),
    };
  },

  /**
   * The index exists but the file is newer than anything inside it.
   *
   * Two independent guards keep a stale timestamp from becoming a stale *rule*:
   *
   *   epsilon — only lead by more than `index_mtime_epsilon_ms`. Same-second
   *             writes and coarse (FAT, network share) timestamps otherwise
   *             make a freshly built index look stale.
   *   unknown — an unreadable or empty marker directory yields 0, and 0
   *             abstains. Filing "I could not read the index" under "the index
   *             is stale" would block every read in a repository whose index
   *             lives somewhere the harness cannot stat.
   *
   * Note the order: `written` and the fresh-signal test come before any probe.
   * A check cannot rely on another check having run first, because the `checks`
   * array is user-editable and the model's own edit is always newer than the
   * index it is about to consult.
   */
  'index-freshness-before-read': (policy, input, deps) => {
    if (input.action !== 'read') return null;
    const scope = scopeOf(input.path, { config: policy.config, exists: deps.exists });
    if (!scope.inScope || !scope.root) return null;
    if (deps.state.written.has(input.path)) return null;
    if (hasUnlock(deps.state, input.path, policy.config, deps.now)) return null;

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
        '本会话内你自己刚改过的文件不受此拦截。',
      ].join('\n'),
    };
  },

  /** Never write outside the paths the user declared writable. */
  'no-write-outside': (policy, input, deps) => {
    if (input.action !== 'write') return null;
    const allowed = policy.config.write_roots ?? [];
    if (allowed.length === 0) return null;
    const path = input.path ?? '';
    const inside = allowed.some((r) => withinRoot(r, path));
    if (inside) return null;
    return {
      code: 'WRITE_OUTSIDE',
      reason: [
        'Blocked: writing outside the allowed roots.',
        `  path    : ${path}`,
        `  allowed : ${allowed.join(', ')}`,
        '',
        'Add the root to config.write_roots in the gate policy if this write is intended.',
      ].join('\n'),
    };
  },

  /** Never let a credential-shaped string be written into a tracked file. */
  'no-secret-write': (policy, input, deps) => {
    if (input.action !== 'write') return null;
    const text = input.content ?? '';
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
      ].join('\n'),
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
 * @param {object} [args.fs]    full probe: {exists, statMtime, listDir}. Supersedes `exists`.
 * @param {number} [args.now]
 * @returns {{block: boolean, code: string|null, reason: string|null, capReached: boolean}}
 */
export const shouldBlock = ({ policy, input, state, exists, fs, now = Date.now() }) => {
  const cap = policy.config.max_blocks_per_session;
  if (cap >= 0 && state.blocks >= cap) {
    return { block: false, code: null, reason: null, capReached: true };
  }

  // One probe object, so a check that needs more than `exists` can get it
  // without each check inventing its own seam. The flat `exists` shape stays
  // supported because it is what the unit tests and simpler harnesses pass.
  const probes = fs ?? { ...NO_FS, exists: typeof exists === 'function' ? exists : NO_FS.exists };

  const enabled = new Set(policy.checks.length > 0 ? policy.checks : ['graph-before-read']);
  for (const name of enabled) {
    const check = CHECKS[name];
    if (!check) continue; // unknown check names are ignored, not fatal
    const verdict = check(policy, input, { state, exists: probes.exists, fs: probes, ...probes, now });
    if (verdict) {
      state.blocks += 1;
      return { block: true, code: verdict.code, reason: verdict.reason, capReached: false };
    }
  }
  return { block: false, code: null, reason: null, capReached: false };
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
  if (hasFreshSignal(state, policy.config.signal_ttl_ms, now)) return null;
  return policy.reminded;
};

export const globHelpers = { toPosix, posix };
