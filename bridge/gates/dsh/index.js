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

import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  loadPolicy,
  newSessionState,
  policyFromObject,
  recordSignal,
  recordWrite,
  shouldBlock,
} from '../policy.js';

const HERE = dirname(fileURLToPath(import.meta.url));

export const name = 'enforce-rules';

/** Graph-query tool names that satisfy the "ask the graph first" rule. */
const SIGNAL_TOOLS = [
  'search_graph',
  'trace_path',
  'get_code_snippet',
  'query_graph',
  'get_architecture',
  'search_code',
];

const WRITE_TOOLS = new Set(['write', 'edit']);
const READ_TOOLS = new Set(['read']);

const isSignalTool = (toolName) =>
  SIGNAL_TOOLS.some((s) => toolName === s || toolName.endsWith(`_${s}`));

/** Read one field out of an `unknown` args object without trusting its shape. */
const str = (args, key) => {
  if (args && typeof args === 'object' && typeof args[key] === 'string') return args[key];
  return null;
};

export function apply(ctx, config = {}) {
  // An inline `policy` object lets a host inject configuration; `policyPath`
  // keeps the file-based route for real deployments.
  const loaded = config.policy
    ? policyFromObject(config.policy)
    : loadPolicy(typeof config.policyPath === 'string' ? config.policyPath : join(HERE, 'policy.json'));
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
    // JSON file is worse than an unenforced rule.
    ctx.logger?.warn?.(`enforce-rules: policy not loaded (${loaded.error}); gate is inactive`);
  }

  const state = newSessionState();

  ctx.on('tools/pre-execute', async (exec, next) => {
    const toolName = String(exec?.name ?? '');
    const args = exec?.arguments;

    if (WRITE_TOOLS.has(toolName)) {
      const path = str(args, 'file_path');
      recordWrite(state, path);
      const verdict = shouldBlock({
        policy,
        input: {
          action: 'write',
          path,
          tool: toolName,
          content: str(args, 'content'),
        },
        state,
        exists: existsSync,
      });
      if (verdict.block) return { kind: 'deny', reason: verdict.reason };
      return next();
    }

    if (READ_TOOLS.has(toolName)) {
      const verdict = shouldBlock({
        policy,
        input: { action: 'read', path: str(args, 'file_path'), tool: toolName },
        state,
        exists: existsSync,
      });
      if (verdict.block) return { kind: 'deny', reason: verdict.reason };
      return next();
    }

    if (isSignalTool(toolName)) {
      // Recorded on the way in; see the file header for why success is not
      // awaited on this harness.
      recordSignal(state);
    }

    return next();
  });
}

export const inject = ['tools'];
