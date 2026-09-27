/**
 * pi adapter for the hard-gate policy.
 *
 * pi's extension API offers two points this gate needs:
 *   pi.on('tool_call', ...) -> { block: true, reason }   (enforce)
 *   pi.on('context',   ...) -> { messages }              (remind each turn)
 *
 * Everything that decides *whether* to block lives in ../policy.js. This file
 * only translates: pi event -> normalized input -> policy question -> pi result.
 *
 * Install: copy this directory to <pi agent dir>/extensions/enforce-rules/
 * See bridge/gates/install.js for a scripted, dry-run-first install.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  loadPolicy,
  newSessionState,
  policyFromObject,
  recordSignal,
  recordWrite,
  reminderFor,
  shouldBlock,
} from '../policy.js';

const HERE = dirname(fileURLToPath(import.meta.url));

/** Tool names that count as "the model consulted the code graph". */
const SIGNAL_TOOLS = [
  'search_graph',
  'trace_path',
  'get_code_snippet',
  'query_graph',
  'get_architecture',
  'search_code',
];

/** pi tool name -> normalized action the policy understands. */
const ACTION_BY_TOOL = {
  read: 'read',
  write: 'write',
  edit: 'write',
  bash: 'bash',
};

const isSignalTool = (name) =>
  SIGNAL_TOOLS.some((s) => name === s || name.endsWith(`_${s}`));

const fallback = (why) => ({
  policy: {
    name: 'enforce-rules',
    version: 1,
    description: 'built-in fallback because the policy could not be read',
    reminded: '',
    checks: [],
    config: { max_blocks_per_session: 0, signal_ttl_ms: 0 },
  },
  error: why,
});

/** Append text to a pi message content, which is either a string or blocks. */
const appendText = (content, text) => {
  if (typeof content === 'string') return `${content}\n\n${text}`;
  if (Array.isArray(content)) return [...content, { type: 'text', text }];
  return content; // unknown shape: leave it alone rather than corrupt it
};

export default function enforceRules(pi, options = {}) {
  const loaded = options.policy
    ? policyFromObject(options.policy)
    : loadPolicy(options.policyPath ?? join(HERE, 'policy.json'));
  const { policy, error } = loaded.ok
    ? loaded
    : fallback(`policy not loaded (${loaded.error})`);

  const state = newSessionState();
  /** Set once per session so the same advisory is not repeated. */
  let noticedPolicyProblem = false;

  pi.on('session_start', async (_event, ctx) => {
    state.blocks = 0;
    state.signals = 0;
    state.written.clear();
    if (error && ctx?.hasUI && !noticedPolicyProblem) {
      noticedPolicyProblem = true;
      ctx.ui.notify(`enforce-rules: policy not loaded (${error}); gate is inactive`, 'warn');
    } else if (ctx?.hasUI) {
      ctx.ui.notify(`enforce-rules: ${policy.name} active (${policy.checks.join(', ') || 'no checks'})`, 'info');
    }
  });

  pi.on('tool_call', async (event, ctx) => {
    const name = event.toolName;

    // Remember what this session wrote: reading your own output is never a
    // violation, and blocking it would make the gate fight normal development.
    if (name === 'write' || name === 'edit') {
      const path = event.input?.path;
      recordWrite(state, path);
      const content = typeof event.input?.content === 'string' ? event.input.content : null;
      const verdict = shouldBlock({
        policy,
        input: { action: 'write', path, tool: name, content },
        state,
        exists: existsSync,
      });
      if (verdict.block) {
        return { block: true, reason: verdict.reason };
      }
      return;
    }

    if (name !== 'read') return;

    const verdict = shouldBlock({
      policy,
      input: { action: 'read', path: event.input?.path ?? null, tool: name },
      state,
      exists: existsSync,
    });

    if (verdict.block) {
      if (ctx?.hasUI) {
        ctx.ui.notify(
          `enforce-rules [${verdict.code}] block ${state.blocks}/${policy.config.max_blocks_per_session}`,
          'warn',
        );
      }
      return { block: true, reason: verdict.reason };
    }

    if (verdict.capReached && ctx?.hasUI && !noticedPolicyProblem) {
      noticedPolicyProblem = true;
      ctx.ui.notify(
        'enforce-rules: block cap reached, the gate is now inactive for this session',
        'warn',
      );
    }
    return;
  });

  pi.on('tool_result', async (event) => {
    if (event.isError) return;
    // Only a *successful* graph query unlocks the session. A failed query means
    // the model has not actually learned anything yet.
    if (isSignalTool(event.toolName)) recordSignal(state);
  });

  pi.on('context', async (event) => {
    const reminder = reminderFor(policy, state);
    if (!reminder) return;
    const messages = event.messages;
    if (!Array.isArray(messages) || messages.length === 0) return;

    const last = messages[messages.length - 1];
    if (last?.role === 'user') {
      messages[messages.length - 1] = {
        ...last,
        content: appendText(last.content, reminder),
      };
    } else {
      messages.push({ role: 'user', content: reminder });
    }
    return { messages };
  });
}
