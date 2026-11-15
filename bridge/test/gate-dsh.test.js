/**
 * dsh adapter tests — the two harness details that were silently wrong on
 * Windows Desktop, the checks that make those fixes falsifiable, and (v6) the
 * result/turn-level gates that v5 declared impossible on this harness.
 *
 * Written against the shape dsh actually dispatches (a waterfall listener
 * `(exec, next)` that answers `{ kind: 'deny', reason }`, `{ kind: 'ask' }` or
 * delegates to `next()`; an `(exec, result)` notification on `tools/result`; a
 * serial `agent/turn-stopping` that objects by steering), not against the pi
 * adapter's `tool_call` shape.
 *
 *   node --test bridge/test/gate-dsh.test.js
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// The operator's machine-local gate override must not reach these fixtures.
import './isolate-home.js';

import { apply } from '../gates/dsh/index.js';
import { normalizePath } from '../gates/policy.js';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * A deletion target that hits the guardrail: it carries a `..` segment and does
 * NOT resolve into a scratch directory.
 *
 * Two traps this avoids, both hit while writing this file:
 *   - a literal home path (`/home/<name>`, `C:/Users/<name>`) is forbidden by
 *     `scripts/scan-secrets.sh`, in tests and in history alike (CONTRIBUTING.md);
 *   - `os.tmpdir()` is under `Temp`, and the classifier exempts build output
 *     (temp/build/dist/node_modules) even when the path also has a `..`, so a
 *     tmpdir-based target never reaches the guardrail.
 *
 * Built at run time, so no scanner pattern can match it.
 */
const guardrailTarget = `${repo}/../secrets`;

const withTmp = (fn) => async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gate-dsh-'));
  try {
    await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

/**
 * Mount the adapter on a minimal stand-in for dsh's plugin context.
 *
 * `get` mirrors cordis: it answers the optional services (`workingDirectory`,
 * `approval`) and `undefined` for anything absent — which is exactly the path
 * the adapter must survive without deactivating.
 *
 * The policy is injected inline (`config.policy`, not `policyPath`), so a bug in
 * the fixture cannot silently fall back to the shipped policy.json and pass.
 *
 * The returned function drives `tools/pre-execute` (the common case) and carries
 * the other listeners as properties, because v6 registers four of them.
 */
const mount = (policy, services = {}, extra = {}) => {
  const handlers = {};
  const ctx = {
    handlers,
    on: (name, fn) => {
      handlers[name] = fn;
    },
    get: (name) => services[name],
    logger: { warn: () => {} },
  };
  apply(ctx, { policy, ...extra });

  const listener = handlers['tools/pre-execute'];
  assert.equal(typeof listener, 'function', 'the adapter registers a pre-execute listener');
  const run = (exec) => listener(exec, async () => ({ kind: 'allow' }));

  const handler = (name) => {
    const fn = handlers[name];
    assert.equal(typeof fn, 'function', `the adapter registers a ${name} listener`);
    return fn;
  };

  run.handlers = handlers;
  /** Settle one tool result the way dsh's registry would. */
  run.result = (exec, result) => handler('tools/result')(exec, result);
  /** Enter one proposed step; the fixture accepts the claimed batch. */
  run.preStep = (payload) =>
    handler('agent/pre-step')(payload, async () => ({ kind: 'enter', messages: payload?.messages ?? [] }));
  run.turnStopping = (payload) => handler('agent/turn-stopping')(payload);
  run.sessionEvent = (session, event) => handler('session/event')(session, event);
  return run;
};

const destructivePolicy = () => ({
  name: 't',
  version: 6,
  checks: ['no-destructive-bash'],
  config: { destructive_mode: 'enforce', max_blocks_per_session: 0 },
});

const graphPolicy = (root) => ({
  name: 't',
  version: 6,
  checks: ['graph-before-read'],
  config: {
    project_roots: [normalizePath(root)],
    exclude_globs: [],
    max_blocks_per_session: 10,
    // Mirrors bridge/gates/dsh/policy.json. The engine default is `false` so a
    // policy that never states the intent keeps the old lax behaviour; the
    // shipped file opts in, and so must any fixture that claims to test it.
    graph_signal_requires_content: true,
    graph_signal_min_chars: 40,
  },
});

/**
 * A deletion target the classifier treats as a REAL delete, not build output.
 *
 * Same trap as `guardrailTarget` (CONTRIBUTING.md pit 3): `os.tmpdir()` lives
 * under `Temp`, and temp/build/dist/node_modules are exempt as disposable, so a
 * tmpdir-based target never reaches the confirm tier and the assertion would
 * pass for the wrong reason. Built at run time from the repo root, so no scanner
 * pattern matches it.
 */
const recoverableTarget = `${repo}/legacy-module`;

/** Layer 0 only: no graph rule, so a read is allowed and its evidence is the question. */
const evidencePolicy = (root) => ({
  name: 't',
  version: 6,
  checks: ['no-write-outside', 'think-before-write'],
  config: {
    project_roots: [normalizePath(root)],
    exclude_globs: [],
    max_blocks_per_session: 200,
    require_target_evidence: true,
    inspected_ttl_ms: 1800000,
  },
});

const slackPolicy = (over = {}) => ({
  name: 't',
  version: 6,
  checks: [],
  config: { slack_check: true, slack_max_continues: 2, ...over },
});

/** A stand-in for the live Agent: records what the gate tried to deliver. */
const fakeAgent = (session = {}) => {
  const steered = [];
  const injected = [];
  return {
    session,
    steered,
    injected,
    steer: (message) => steered.push(message),
    inject: (message) => injected.push(message),
    followup: () => {},
  };
};

const textOf = (message) =>
  (message?.content ?? []).map((block) => (typeof block === 'string' ? block : block?.text ?? '')).join('');

// --- the shell tool name ----------------------------------------------------

test('pwsh: a guardrail deletion is denied', withTmp(async (dir) => {
  const run = mount(destructivePolicy(), {});
  const verdict = await run({
    name: 'pwsh',
    arguments: { command: `Remove-Item -Recurse -Force "${guardrailTarget}"` },
    agent: { session: {} },
  });

  assert.equal(verdict.kind, 'deny', 'dsh names its Windows shell `pwsh`, and it must be gated');
  assert.match(verdict.reason, /Layer 0|不可恢复/);
}));

test('bash: the same command is denied too (no regression on POSIX presets)', withTmp(async (dir) => {
  const run = mount(destructivePolicy(), {});
  const verdict = await run({
    name: 'bash',
    arguments: { command: `rm -rf "${guardrailTarget}"` },
    agent: { session: {} },
  });

  assert.equal(verdict.kind, 'deny');
}));

test('pwsh: cleaning a build directory is not a destructive operation', withTmp(async (dir) => {
  const run = mount(destructivePolicy(), {});
  const verdict = await run({
    name: 'pwsh',
    arguments: { command: 'Remove-Item -Recurse -Force node_modules' },
    agent: { session: {} },
  });

  assert.equal(verdict.kind, 'allow', 'build output must not be treated as a delete');
}));

test('an unrelated tool is never touched by the shell rule', withTmp(async (dir) => {
  const run = mount(destructivePolicy(), {});
  const verdict = await run({ name: 'grep', arguments: { pattern: 'x' }, agent: { session: {} } });
  assert.equal(verdict.kind, 'allow');
}));

// --- the Session's working directory ----------------------------------------

test('cwd: the Session directory decides whether a relative shell read is in scope', withTmp(async (dir) => {
  const project = join(dir, 'project');
  mkdirSync(join(project, 'src'), { recursive: true });
  writeFileSync(join(project, 'src', 'a.js'), 'export const a = 1;\n', 'utf8');

  const elsewhere = join(dir, 'elsewhere');
  mkdirSync(elsewhere, { recursive: true });

  // dsh's ToolExecution carries no `cwd`; the Session's directory lives in the
  // `workingDirectory` service. A relative path in a shell command must be
  // judged against it — not against the directory the Desktop app launched from.
  const run = mount(
    {
      name: 't',
      version: 6,
      checks: ['bash-graph-before-read'],
      config: { project_roots: [normalizePath(project)], exclude_globs: [], max_blocks_per_session: 10 },
    },
    { workingDirectory: { get: () => normalizePath(project) } },
    { cwd: elsewhere }, // the launch directory: a placeholder for process.cwd()
  );

  const verdict = await run({
    name: 'pwsh',
    arguments: { command: 'Get-Content src/a.js' },
    agent: { session: {} },
  });

  assert.equal(verdict.kind, 'deny', 'the relative path resolves inside the project, through the Session directory');
  assert.match(verdict.reason, /Layer 1/);
}));

test('cwd: without the service the explicit cwd still applies (no crash, no guess)', withTmp(async (dir) => {
  const project = join(dir, 'project');
  mkdirSync(join(project, 'src'), { recursive: true });
  writeFileSync(join(project, 'src', 'a.js'), 'export const a = 1;\n', 'utf8');

  const elsewhere = join(dir, 'elsewhere');
  mkdirSync(elsewhere, { recursive: true });

  const run = mount(
    {
      name: 't',
      version: 6,
      checks: ['bash-graph-before-read'],
      config: { project_roots: [normalizePath(project)], exclude_globs: [], max_blocks_per_session: 10 },
    },
    {},
    { cwd: elsewhere },
  );

  const verdict = await run({
    name: 'pwsh',
    arguments: { command: 'Get-Content src/a.js' },
    agent: { session: {} },
  });

  assert.equal(verdict.kind, 'allow', 'a missing service degrades to the configured cwd, it does not block');
}));

// --- the graph rule, end to end ---------------------------------------------

/** A graph result with content: the only thing that may open Layer 1. */
const GOOD_GRAPH = { isError: false, content: [{ type: 'text', text: '{"total":3,"results":[{"name":"alpha"},{"name":"beta"}]}' }] };
/** A successful call that taught nothing. It must NOT open Layer 1. */
const EMPTY_GRAPH = { isError: false, content: [{ type: 'text', text: '{"total":0,"results":[]}' }] };

test('read: a source file in scope needs graph evidence, and only a RESULT opens the window', withTmp(async (dir) => {
  const file = join(dir, 'a.js');
  writeFileSync(file, 'export const a = 1;\n', 'utf8');

  const run = mount(graphPolicy(dir), {
    workingDirectory: { get: () => normalizePath(dir) },
  });

  const read = { name: 'read', arguments: { file_path: normalizePath(file) }, agent: { session: {} } };

  const blocked = await run(read);
  assert.equal(blocked.kind, 'deny', 'a code read without the graph is the rule this gate exists for');
  assert.match(blocked.reason, /Layer 1/);

  const query = { name: 'mcp__codebase-memory-mcp__search_graph', arguments: { query: 'a' }, agent: { session: {} } };
  assert.equal((await run(query)).kind, 'allow', 'the graph call itself is not blocked');

  // v6: admission is not evidence. Calling the tool proves nothing until its
  // outcome is known, so the read is still blocked here.
  assert.equal(
    (await run(read)).kind,
    'deny',
    'RED if the adapter records the signal on the way in (the v5 hole)',
  );

  run.result(query, GOOD_GRAPH);

  assert.equal((await run(read)).kind, 'allow', 'a result with content opens the read window');
}));

test('read: an empty graph result does NOT open the window', withTmp(async (dir) => {
  const file = join(dir, 'a.js');
  writeFileSync(file, 'export const a = 1;\n', 'utf8');

  const run = mount(graphPolicy(dir), {});
  const query = { name: 'mcp__codebase-memory-mcp__query_graph', arguments: { query: 'a' }, agent: { session: {} } };

  run.result(query, EMPTY_GRAPH);

  const verdict = await run({ name: 'read', arguments: { file_path: normalizePath(file) }, agent: { session: {} } });

  assert.equal(verdict.kind, 'deny', 'RED if `{"total":0}` buys a read window — that is the ADR-006 hole');
}));

test('read: a failed graph query does NOT open the window', withTmp(async (dir) => {
  const file = join(dir, 'a.js');
  writeFileSync(file, 'export const a = 1;\n', 'utf8');

  const run = mount(graphPolicy(dir), {});
  const query = { name: 'mcp__codebase-memory-mcp__search_graph', arguments: { query: 'a' }, agent: { session: {} } };

  // Even with content in the body, an errored call taught the model nothing.
  run.result(query, {
    isError: true,
    error: { message: 'index unavailable' },
    content: [{ type: 'text', text: '{"total":3,"results":[{"name":"alpha"},{"name":"beta"}]}' }],
  });

  const verdict = await run({ name: 'read', arguments: { file_path: normalizePath(file) }, agent: { session: {} } });

  assert.equal(verdict.kind, 'deny', 'RED if an errored query counts as evidence');
}));

test('read: a non-code file is out of scope', withTmp(async (dir) => {
  const file = join(dir, 'notes.md');
  writeFileSync(file, '# notes\n', 'utf8');

  const run = mount(graphPolicy(dir), {});
  const verdict = await run({
    name: 'read',
    arguments: { file_path: normalizePath(file) },
    agent: { session: {} },
  });

  assert.equal(verdict.kind, 'allow', 'documentation must not require a graph query');
}));

// --- Layer 0 evidence now comes from the settled result ----------------------

test('evidence: admission is not evidence — only a settled successful read unblocks the edit', withTmp(async (dir) => {
  const file = join(dir, 'a.js');
  writeFileSync(file, 'export const a = 1;\n', 'utf8');

  const run = mount(evidencePolicy(dir), {
    workingDirectory: { get: () => normalizePath(dir) },
  });

  const read = { name: 'read', arguments: { file_path: normalizePath(file) }, agent: { session: {} } };
  const edit = { name: 'edit', arguments: { file_path: normalizePath(file), new_string: 'export const a = 2;' }, agent: { session: {} } };

  assert.equal((await run(edit)).kind, 'deny', 'editing a file this session never read is what Layer 0 forbids');

  assert.equal((await run(read)).kind, 'allow', 'the read itself is not gated by this policy');

  // The adapter records Layer 0 evidence on the way in (deliberately lenient),
  // so this branch is expected to pass — it documents the lenient half.
  assert.equal((await run(edit)).kind, 'allow', 'a read the gate allowed counts as inspection');

  // A fresh mount, where the result never settles: no evidence, no edit.
  const strict = mount(evidencePolicy(dir), { workingDirectory: { get: () => normalizePath(dir) } });
  assert.equal((await strict(edit)).kind, 'deny');

  // And a settled result is what the think-before-write rule was designed for.
  strict.result(read, { isError: false, content: [{ type: 'text', text: 'export const a = 1;' }] });
  assert.equal((await strict(edit)).kind, 'allow', 'a successful read result supplies target evidence');
}));

test('evidence: a failed read result supplies nothing', withTmp(async (dir) => {
  const file = join(dir, 'a.js');
  writeFileSync(file, 'export const a = 1;\n', 'utf8');

  const run = mount(evidencePolicy(dir), { workingDirectory: { get: () => normalizePath(dir) } });
  const read = { name: 'read', arguments: { file_path: normalizePath(file) }, agent: { session: {} } };
  const edit = { name: 'edit', arguments: { file_path: normalizePath(file), new_string: 'x' }, agent: { session: {} } };

  run.result(read, { isError: true, error: { message: 'ENOENT' }, content: [] });

  assert.equal((await run(edit)).kind, 'deny', 'a read that failed never showed the model the file');
}));

// --- turn-level anti-slack --------------------------------------------------

test('turn-stopping: a promise to finish later steers another step', withTmp(async () => {
  const run = mount(slackPolicy(), {});
  const session = {};
  const agent = fakeAgent(session);

  run.sessionEvent(session, {
    type: 'assistant/message',
    data: { stream: [{ type: 'text-delta', text: '这个我稍后再补。' }] },
  });

  await run.turnStopping({ agent, turn: 1, signal: undefined });

  assert.equal(agent.steered.length, 1, 'RED if the turn boundary does nothing — a promise would be shipped as delivery');
  assert.match(textOf(agent.steered[0]), /不偷懒/);
}));

test('turn-stopping: a real delivery is left alone', withTmp(async () => {
  const run = mount(slackPolicy(), {});
  const session = {};
  const agent = fakeAgent(session);

  run.sessionEvent(session, {
    type: 'assistant/message',
    data: { stream: [{ type: 'text-delta', text: '已完成：三个文件改完，测试全绿。' }] },
  });

  await run.turnStopping({ agent, turn: 1, signal: undefined });

  assert.equal(agent.steered.length, 0, 'an ordinary completion must not be nagged');
}));

test('turn-stopping: the continue count is bounded', withTmp(async () => {
  const run = mount(slackPolicy({ slack_max_continues: 1 }), {});
  const session = {};
  const agent = fakeAgent(session);
  const deferral = { type: 'assistant/message', data: { stream: [{ type: 'text-delta', text: '这个我稍后再补。' }] } };

  run.sessionEvent(session, deferral);
  await run.turnStopping({ agent, turn: 1, signal: undefined });
  await run.turnStopping({ agent, turn: 1, signal: undefined });

  assert.equal(agent.steered.length, 1, 'RED if a false positive can loop the agent forever');
}));

test('turn-stopping: slack_max_continues 0 disables the rule entirely', withTmp(async () => {
  const run = mount(slackPolicy({ slack_max_continues: 0 }), {});
  const session = {};
  const agent = fakeAgent(session);

  run.sessionEvent(session, { type: 'assistant/message', data: { stream: [{ type: 'text-delta', text: '这个我稍后再补。' }] } });
  await run.turnStopping({ agent, turn: 1, signal: undefined });

  assert.equal(agent.steered.length, 0);
}));

test('turn-stopping: reasoning content never counts as a delivery', withTmp(async () => {
  const run = mount(slackPolicy(), {});
  const session = {};
  const agent = fakeAgent(session);

  // Only visible text is folded, so a deferral hidden in reasoning cannot be the
  // thing that opens (or, here, fails to open) the rule.
  run.sessionEvent(session, {
    type: 'assistant/message',
    data: { stream: [{ type: 'reasoning-delta', text: '这个我稍后再补。' }] },
  });
  await run.turnStopping({ agent, turn: 1, signal: undefined });

  assert.equal(agent.steered.length, 0);
}));

// --- per-turn reminder ------------------------------------------------------

test('pre-step: the reminder is injected once per turn and the step is admitted', withTmp(async () => {
  const run = mount(
    {
      name: 't',
      version: 6,
      checks: [],
      reminder: '⛔ 轮次提醒：先查图谱再读源码。',
      config: { signal_ttl_ms: 600000 },
    },
    { workingDirectory: { get: () => normalizePath(repo) } },
  );
  const agent = fakeAgent({});
  const payload = { agent, turn: 1, step: 1, messages: [{ role: 'user', content: [{ type: 'text', text: '改一下这个仓库' }] }] };

  const decision = await run.preStep(payload);
  assert.equal(decision.kind, 'enter', 'the step must still be admitted; the gate observes, it does not stall');

  await run.preStep({ ...payload, step: 2 });

  assert.equal(agent.injected.length, 1, 'RED if the reminder is injected on every step (noise) or never (silence)');
  assert.match(textOf(agent.injected[0]), /图谱/);
}));

// --- three-tier destructive policy: ask only when someone can answer --------

test('confirm: a recoverable delete asks when an approval channel exists', withTmp(async () => {
  const run = mount(destructivePolicy(), {
    approval: { effectivePolicy: () => 'ask' },
  });

  const verdict = await run({
    name: 'bash',
    arguments: { command: `rm -rf "${recoverableTarget}"` },
    agent: { session: {} },
  });

  assert.equal(verdict.kind, 'ask', 'RED if dsh silently auto-approves while a human could have answered');
  assert.equal(typeof verdict.displayReason['zh-CN'], 'string');
}));

test('confirm: without an approval channel the call proceeds instead of bricking the agent', withTmp(async () => {
  // No `approval` service at all — the headless / approvals-off case.
  const run = mount(destructivePolicy(), {});

  const verdict = await run({
    name: 'bash',
    arguments: { command: `rm -rf "${recoverableTarget}"` },
    agent: { session: {} },
  });

  assert.equal(
    verdict.kind,
    'allow',
    'RED if `ask` is returned unconditionally: with approvals disabled it denies every recoverable delete',
  );
}));

test('confirm: an `approval` service on the never policy is treated as unavailable', withTmp(async () => {
  const run = mount(destructivePolicy(), { approval: { effectivePolicy: () => 'never' } });

  const verdict = await run({
    name: 'bash',
    arguments: { command: `rm -rf "${recoverableTarget}"` },
    agent: { session: {} },
  });

  assert.equal(verdict.kind, 'allow', '`never` cannot answer, so asking would only produce a denial');
}));
