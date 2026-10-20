/**
 * DeepSeek Harness (dsh) adapter for the hard-gate policy.
 *
 * dsh is "everything is a plugin": a plugin is a module exporting `apply(ctx)`,
 * and the reorderable policy layer is the `tools/pre-execute` waterfall. A
 * listener returns `{ kind: 'deny', reason }` to stop a call, or delegates with
 * `return next()`.
 *
 * So this file is the same shape as the pi adapter: translate the harness event
 * into the normalized question, ask ../policy.js, translate the answer back.
 *
 * Configure through the cordis plugin row, e.g.
 *
 *   - name: '/absolute/path/to/agent-config-bridge/bridge/gates/dsh/index.js'
 *     config:
 *       policyPath: '/absolute/path/to/agent-config-bridge/bridge/gates/dsh/policy.json'
 *
 * Differences from the pi adapter (both are deliberate, both are documented
 * rather than hidden):
 *
 *   - The "I consulted the graph" signal is recorded when a graph query is
 *     allowed through, not when it returns successfully. dsh's result-shape is
 *     more involved and a wrong assumption there would silently disable the
 *     gate; erring toward opening the gate is the safe direction.
 *   - There is no per-turn reminder injection here. Enforcement and the
 *     explanation carried by a denial are the whole mechanism on this harness.
 *     The batch is published as a reusable cordis package, which already has a
 *     documented way to contribute prompt text.
 */

import { existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  loadPolicy,
  newSessionState,
  normalizePath,
  policyFromObject,
  recordInspection,
  recordInvestigation,
  recordSignal,
  recordUnlocks,
  recordWrite,
  shouldBlock,
  unlockTokensFromText,
} from '../policy.js';

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * Where the policy JSON can live. Same two layouts the pi adapter supports, and
 * the same silent failure if it is got wrong: a missing file means the gate
 * falls back to fail-open, i.e. it looks installed and enforces nothing.
 *
 *   repo checkout : bridge/gates/dsh/policy.json
 *   installed     : <gate dir>/dsh/index.js  +  <gate dir>/policy.json
 */
export const policyCandidates = (here, explicit) =>
  [explicit, join(here, 'policy.json'), join(here, '..', 'policy.json')].filter(Boolean);

export const firstExistingPolicy = (here, explicit, exists = existsSync) => {
  for (const candidate of policyCandidates(here, explicit)) {
    if (exists(candidate)) return candidate;
  }
  return null;
};

export const name = 'enforce-rules';

/** The full probe set the policy expects, not just `exists`. */
const realFs = {
  exists: (p) => existsSync(p),
  isFile: (p) => {
    try {
      return statSync(p).isFile();
    } catch {
      return false;
    }
  },
  statMtime: (p) => {
    try {
      return statSync(p).mtimeMs;
    } catch {
      return 0;
    }
  },
  listDir: (dir) => {
    try {
      return readdirSync(dir);
    } catch {
      return [];
    }
  },
};

/** Graph-query tool names that satisfy the "ask the graph first" rule. */
const SIGNAL_TOOLS = [
  'search_graph',
  'trace_path',
  'get_code_snippet',
  'query_graph',
  'get_architecture',
  'search_code',
];

const WRITE_TOOLS = new Set(['write', 'edit', 'apply_patch', 'str_replace_editor', 'create_file', 'multi_edit']);
const READ_TOOLS = new Set(['read', 'read_file', 'view', 'open_file']);

const isSignalTool = (toolName) =>
  SIGNAL_TOOLS.some((s) => toolName === s || toolName.endsWith(`_${s}`));

/** Read one field out of an `unknown` args object without trusting its shape. */
const str = (args, key) => {
  if (args && typeof args === 'object' && typeof args[key] === 'string') return args[key];
  return null;
};

const argPath = (args) => str(args, 'file_path') ?? str(args, 'path');
const argContent = (args) =>
  ['content', 'new_string', 'newText', 'patch', 'text']
    .map((key) => str(args, key))
    .find((value) => value !== null) ?? null;

export function apply(ctx, config = {}) {
  // An inline `policy` object lets a host inject configuration; `policyPath`
  // keeps the file-based route for real deployments.
  const resolved =
    typeof config.policyPath === 'string'
      ? config.policyPath
      : firstExistingPolicy(HERE, null);
  const loaded = config.policy
    ? policyFromObject(config.policy)
    : resolved
      ? loadPolicy(resolved)
      : {
          ok: false,
          error:
            'no policy file found; looked in:\n' +
            policyCandidates(HERE, null)
              .map((c) => `    ${c}`)
              .join('\n'),
        };
  const policy = loaded.ok
    ? loaded.policy
    : {
        name: 'enforce-rules',
        version: 1,
        description: 'fallback: policy unreadable, gate inactive',
        reminded: '',
        checks: [],
        config: { max_blocks_per_session: 0, signal_ttl_ms: 0 },
      };

  if (!loaded.ok) {
    // Fail open, loudly. A gate that bricks the agent because of a typo in a
    // JSON file is worse than an unenforced rule — but a gate that is silently
    // off is worse still, because everyone assumes it is working.
    const message = `enforce-rules: DISABLED (${loaded.error})`;
    ctx.logger?.warn?.(message);
    process.stderr.write(`${message}\n`);
  }

  const state = newSessionState();

  ctx.on('tools/pre-execute', async (exec, next) => {
    const toolName = String(exec?.name ?? '');
    const args = exec?.arguments;
    const cwd = typeof exec?.cwd === 'string' && exec.cwd
      ? exec.cwd
      : typeof config.cwd === 'string' && config.cwd
        ? config.cwd
        : process.cwd();

    if (WRITE_TOOLS.has(toolName)) {
      const path = normalizePath(argPath(args), cwd);
      const verdict = shouldBlock({
        policy,
        input: { action: 'write', path, tool: toolName, content: argContent(args) },
        state,
        fs: realFs,
      });
      if (verdict.block) return { kind: 'deny', reason: verdict.reason };
      // Record only after the gate allows: a blocked write is not a file this
      // session may later read back freely.
      recordWrite(state, path);
      recordInvestigation(state);
      return next();
    }

    if (READ_TOOLS.has(toolName)) {
      const path = normalizePath(argPath(args), cwd);
      const verdict = shouldBlock({
        policy,
        input: { action: 'read', path, tool: toolName },
        state,
        fs: realFs,
      });
      if (verdict.block) return { kind: 'deny', reason: verdict.reason };
      // dsh's pre-execute cannot see the result. Recording the inspection here
      // errs toward opening Layer 0; the denial path above is still exact.
      recordInspection(state, path);
      return next();
    }

    if (toolName === 'bash') {
      const command = str(args, 'command') ?? '';
      const verdict = shouldBlock({
        policy,
        input: { action: 'bash', path: null, tool: toolName, command, cwd },
        state,
        fs: realFs,
      });
      if (verdict.block) return { kind: 'deny', reason: verdict.reason };
      return next();
    }

    if (isSignalTool(toolName)) {
      // Recorded on the way in; see the file header for why success is not
      // awaited on this harness. Arguments still become scoped unlocks, which
      // is the best evidence available without a result hook.
      const now = Date.now();
      recordSignal(state, now);
      recordUnlocks(state, unlockTokensFromText(JSON.stringify(args ?? {})), now);
    }

    return next();
  });
}

export const inject = ['tools'];
