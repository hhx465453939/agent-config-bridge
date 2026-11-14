/**
 * dsh adapter tests — the two harness details that were silently wrong on
 * Windows Desktop, plus the checks that make those fixes falsifiable.
 *
 * Written against the shape dsh actually dispatches (a waterfall listener
 * `(exec, next)` that answers `{ kind: 'deny', reason }` or delegates to
 * `next()`), not against the pi adapter's `tool_call` shape.
 *
 *   node --test bridge/test/gate-dsh.test.js
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// The operator's machine-local gate override must not reach these fixtures.
import './isolate-home.js';

import { apply } from '../gates/dsh/index.js';
import { normalizePath } from '../gates/policy.js';

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
 * `get` mirrors cordis: it answers the optional `workingDirectory` service, and
 * `undefined` for anything absent — which is exactly the path the adapter must
 * survive without deactivating.
 *
 * The policy is injected inline (`config.policy`, not `policyPath`), so a bug in
 * the fixture cannot silently fall back to the shipped policy.json and pass.
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
  return (exec) => listener(exec, async () => ({ kind: 'allow' }));
};

const destructivePolicy = () => ({
  name: 't',
  version: 5,
  checks: ['no-destructive-bash'],
  config: { destructive_mode: 'enforce', max_blocks_per_session: 0 },
});

const graphPolicy = (root) => ({
  name: 't',
  version: 5,
  checks: ['graph-before-read'],
  config: {
    project_roots: [normalizePath(root)],
    exclude_globs: [],
    max_blocks_per_session: 10,
  },
});

// --- the shell tool name ----------------------------------------------------

test('pwsh: a guardrail deletion is denied', withTmp(async (dir) => {
  const run = mount(destructivePolicy(), {});
  const verdict = await run({
    name: 'pwsh',
    arguments: { command: 'Remove-Item -Recurse -Force "C:/Users/someone/../secrets"' },
    agent: { session: {} },
  });

  assert.equal(verdict.kind, 'deny', 'dsh names its Windows shell `pwsh`, and it must be gated');
  assert.match(verdict.reason, /Layer 0|不可恢复/);
}));

test('bash: the same command is denied too (no regression on POSIX presets)', withTmp(async (dir) => {
  const run = mount(destructivePolicy(), {});
  const verdict = await run({
    name: 'bash',
    arguments: { command: 'rm -rf /home/someone/../secrets' },
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
      version: 5,
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
      version: 5,
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

test('read: a source file in scope needs graph evidence, and one query opens the window', withTmp(async (dir) => {
  const file = join(dir, 'a.js');
  writeFileSync(file, 'export const a = 1;\n', 'utf8');

  const run = mount(graphPolicy(dir), {
    workingDirectory: { get: () => normalizePath(dir) },
  });

  const blocked = await run({
    name: 'read',
    arguments: { file_path: normalizePath(file) },
    agent: { session: {} },
  });
  assert.equal(blocked.kind, 'deny', 'a code read without the graph is the rule this gate exists for');
  assert.match(blocked.reason, /Layer 1/);

  const signal = await run({
    name: 'mcp__codebase-memory-mcp__search_graph',
    arguments: { query: 'a' },
    agent: { session: {} },
  });
  assert.equal(signal.kind, 'allow', 'the graph call itself is not blocked');

  const allowed = await run({
    name: 'read',
    arguments: { file_path: normalizePath(file) },
    agent: { session: {} },
  });
  assert.equal(allowed.kind, 'allow', 'the recorded signal opens the read window');
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
