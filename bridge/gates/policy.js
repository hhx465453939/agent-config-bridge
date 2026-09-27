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
 * Failure policy
 * --------------
 * If the policy cannot be read or parsed, the gate FAILS OPEN (allows the call)
 * and warns. A gate that fails closed on a missing file would brick the agent,
 * and a bricked agent is worse than an unenforced rule. The reverse choice
 * (fail closed) is right for *secrets* and *writes*, and that is why those
 * rules are expressed as explicit checks rather than as "policy failed to load".
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, posix, sep } from 'node:path';

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
  max_blocks_per_session: 3,
  /** A graph query newer than this many ms counts as fresh. */
  signal_ttl_ms: 60 * 60 * 1000,
  /** Where an index marker directory is expected, for advisory reasons. */
  index_marker: '.codebase-memory',
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
 * Is this path in scope for the gate?
 * @returns {{inScope: boolean, reason: string, root: string|null}}
 */
export const scopeOf = (filePath, { config = DEFAULT_CONFIG, exists }) => {
  if (!filePath) return { inScope: false, reason: 'no path', root: null };
  if (!isAbsolute(filePath)) return { inScope: false, reason: 'not an absolute path', root: null };
  if (!isCodeFile(filePath, config)) return { inScope: false, reason: 'not a code file', root: null };
  if (isExcluded(filePath, config)) return { inScope: false, reason: 'excluded path', root: null };

  if (Array.isArray(config.project_roots) && config.project_roots.length > 0) {
    const root = config.project_roots.find(
      (r) => filePath === r || filePath.startsWith(r.endsWith('/') ? r : `${r}/`),
    );
    return root
      ? { inScope: true, reason: 'under a configured project root', root }
      : { inScope: false, reason: 'outside every configured project root', root: null };
  }

  const root = findRepoRoot(filePath, exists, config.repo_markers ? { markers: config.repo_markers } : {});
  return root
    ? { inScope: true, reason: 'inside a repository', root }
    : { inScope: false, reason: 'not inside any repository', root: null };
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
  /** Files this session itself wrote; reading them back is always fine. */
  written: new Set(),
  /** How many times the gate has blocked, to bound the damage of a false rule. */
  blocks: 0,
  /** Reasons already surfaced, so the user is not shouted at every turn. */
  announced: new Set(),
});

export const recordSignal = (state, now = Date.now()) => {
  state.signals += 1;
  state.lastSignalAt = now;
};

export const recordWrite = (state, path) => {
  if (path) state.written.add(path);
};

export const hasFreshSignal = (state, ttlMs, now = Date.now()) =>
  state.signals > 0 && now - state.lastSignalAt <= ttlMs;

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
 */
const CHECKS = {
  /** Don't read source before consulting the code graph. */
  'graph-before-read': (policy, input, deps) => {
    if (input.action !== 'read') return null;
    const scope = scopeOf(input.path, { config: policy.config, exists: deps.exists });
    if (!scope.inScope) return null;
    if (deps.state.written.has(input.path)) return null;
    if (hasFreshSignal(deps.state, policy.config.signal_ttl_ms, deps.now)) return null;
    return {
      code: 'GRAPH_FIRST',
      reason: [
        'Blocked: source files may not be read before the code graph has been consulted.',
        `  file : ${input.path}`,
        `  why  : ${scope.reason} (root: ${scope.root ?? 'unknown'})`,
        '',
        'Ask the graph first, then read: search_graph / trace_path / get_code_snippet /',
        'query_graph / get_architecture / search_code. Once any one of those succeeds, this',
        'gate opens for the rest of the session and line-level reading is fine.',
        'Reading files this session already wrote is always allowed.',
      ].join('\n'),
    };
  },

  /** A read that the rule wants gated on a fresh index rather than a query. */
  'index-before-read': (policy, input, deps) => {
    if (input.action !== 'read') return null;
    const scope = scopeOf(input.path, { config: policy.config, exists: deps.exists });
    if (!scope.inScope || !scope.root) return null;
    if (deps.state.written.has(input.path)) return null;
    if (hasFreshSignal(deps.state, policy.config.signal_ttl_ms, deps.now)) return null;
    const marker = join(scope.root, policy.config.index_marker);
    if (deps.exists(marker)) return null;
    return {
      code: 'INDEX_FIRST',
      reason: [
        'Blocked: this repository has no code-graph index yet.',
        `  repository : ${scope.root}`,
        `  expected   : ${marker}`,
        '',
        'Build the index first (index_repository on that repository), then consult the graph.',
      ].join('\n'),
    };
  },

  /** Never write outside the paths the user declared writable. */
  'no-write-outside': (policy, input, deps) => {
    if (input.action !== 'write') return null;
    const allowed = policy.config.write_roots ?? [];
    if (allowed.length === 0) return null;
    const path = input.path ?? '';
    const inside = allowed.some(
      (r) => path === r || path.startsWith(r.endsWith('/') ? r : `${r}/`),
    );
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
 * @param {(p:string)=>boolean} args.exists  filesystem probe, injected
 * @param {number} [args.now]
 * @returns {{block: boolean, code: string|null, reason: string|null, capReached: boolean}}
 */
export const shouldBlock = ({ policy, input, state, exists, now = Date.now() }) => {
  const cap = policy.config.max_blocks_per_session;
  if (cap >= 0 && state.blocks >= cap) {
    return { block: false, code: null, reason: null, capReached: true };
  }

  const enabled = new Set(policy.checks.length > 0 ? policy.checks : ['graph-before-read']);
  for (const name of enabled) {
    const check = CHECKS[name];
    if (!check) continue; // unknown check names are ignored, not fatal
    const verdict = check(policy, input, { state, exists, now });
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
