/**
 * pi adapter tests (v4) — the parts that only exist at the harness boundary:
 * turn-level continuation, MCP unwrapping, PowerShell routing, index-refresh
 * evidence, and the degraded (fail-closed) policy.
 *
 *   node --test bridge/test/gate-adapter.test.js
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import enforceRules from '../gates/pi/index.js';
import { normalizePath } from '../gates/policy.js';

const PRIVATE_KEY = '-----BEGIN RSA ' + 'PRIVATE KEY-----';

const makePi = () => {
  const handlers = {};
  return {
    handlers,
    on: (name, fn) => {
      handlers[name] = fn;
    },
  };
};

const withTmp = (fn) => async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gate-v4-'));
  try {
    await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

test('turn_end: a deferral reply asks for another turn', withTmp(async (dir) => {
  const pi = makePi();
  enforceRules(pi, {
    policy: { name: 't', checks: [], config: { slack_check: true, slack_max_continues: 2 } },
  });
  await pi.handlers.session_start({}, { cwd: dir, hasUI: false });

  const result = await pi.handlers.turn_end(
    {
      message: { role: 'assistant', content: [{ type: 'text', text: '这个我稍后再补完。' }] },
      entries: [],
    },
    { hasUI: false },
  );

  assert.equal(result?.continue, true);
  assert.equal(result.entries.at(-1).customType, 'enforce-rules-no-slack');
}));

test('turn_end: the continuation is bounded by slack_max_continues', withTmp(async (dir) => {
  const pi = makePi();
  enforceRules(pi, {
    policy: { name: 't', checks: [], config: { slack_check: true, slack_max_continues: 1 } },
  });
  await pi.handlers.session_start({}, { cwd: dir, hasUI: false });

  const event = {
    message: { role: 'assistant', content: [{ type: 'text', text: '这个我稍后再补完。' }] },
    entries: [],
  };
  assert.equal((await pi.handlers.turn_end(event, { hasUI: false }))?.continue, true);
  assert.equal(await pi.handlers.turn_end(event, { hasUI: false }), undefined);
}));

test('tool_call: MCP gateway arguments are not exempt', withTmp(async (dir) => {
  const pi = makePi();
  enforceRules(pi, {
    policy: { name: 't', checks: ['no-secret-write'], config: { max_blocks_per_session: 0 } },
  });
  await pi.handlers.session_start({}, { cwd: dir, hasUI: false });

  const verdict = await pi.handlers.tool_call(
    {
      toolName: 'mcp',
      input: { tool: 'write_file', args: { path: join(dir, 'a.js'), content: PRIVATE_KEY } },
    },
    { cwd: dir, hasUI: false },
  );

  assert.equal(verdict.block, true);
  assert.match(verdict.reason, /credential/i);
}));

test('tool_call: PowerShell reads go through the graph rule', withTmp(async (dir) => {
  const file = join(dir, 'a.js');
  writeFileSync(file, 'export const a = 1;\n', 'utf8');

  const pi = makePi();
  enforceRules(pi, {
    policy: {
      name: 't',
      checks: ['bash-graph-before-read'],
      config: { project_roots: [normalizePath(dir)], exclude_globs: [] },
    },
  });
  await pi.handlers.session_start({}, { cwd: dir, hasUI: false });

  const verdict = await pi.handlers.tool_call(
    { toolName: 'powershell', input: { command: `Get-Content "${file}"` } },
    { cwd: dir, hasUI: false },
  );

  assert.equal(verdict.block, true);
  assert.match(verdict.reason, /Layer 1/);
}));

test('tool_result: a successful index refresh makes a later read fresh', withTmp(async (dir) => {
  const file = join(dir, 'a.js');
  writeFileSync(file, 'export const a = 1;\n', 'utf8');

  const pi = makePi();
  enforceRules(pi, {
    policy: {
      name: 't',
      checks: ['index-freshness-before-read'],
      config: {
        project_roots: [normalizePath(dir)],
        exclude_globs: [],
        index_marker: '.codebase-memory',
        index_mtime_epsilon_ms: 0,
        index_mtime_ttl_ms: 0,
        max_blocks_per_session: 10,
      },
    },
  });
  await pi.handlers.session_start({}, { cwd: dir, hasUI: false });

  await pi.handlers.tool_result(
    {
      toolName: 'codebase-memory-mcp_index_repository',
      input: { repo_path: dir },
      isError: false,
      content: [{ type: 'text', text: 'indexed' }],
    },
    { cwd: dir, hasUI: false },
  );

  await new Promise((resolve) => setTimeout(resolve, 20));
  writeFileSync(file, 'export const a = 2;\n', 'utf8');

  const stale = await pi.handlers.tool_call({ toolName: 'read', input: { path: file } }, { cwd: dir, hasUI: false });
  assert.equal(stale.block, true);
  assert.match(stale.reason, /Layer 2/);

  await new Promise((resolve) => setTimeout(resolve, 20));
  await pi.handlers.tool_result(
    {
      toolName: 'codebase-memory-mcp_index_repository',
      input: { repo_path: dir },
      isError: false,
      content: [{ type: 'text', text: 'reindexed' }],
    },
    { cwd: dir, hasUI: false },
  );

  const fresh = await pi.handlers.tool_call({ toolName: 'read', input: { path: file } }, { cwd: dir, hasUI: false });
  assert.equal(fresh, undefined, 'a refresh after the edit makes the read allowed');
}));

test('fallback: an unreadable policy still enforces safety rules', withTmp(async (dir) => {
  const bad = join(dir, 'broken-policy.json');
  writeFileSync(bad, '{ not valid json', 'utf8');

  const pi = makePi();
  enforceRules(pi, { policyPath: bad });
  await pi.handlers.session_start({}, { cwd: dir, hasUI: false });

  const verdict = await pi.handlers.tool_call(
    { toolName: 'write', input: { path: join(dir, 'x.js'), content: PRIVATE_KEY } },
    { cwd: dir, hasUI: false },
  );

  assert.equal(verdict.block, true, 'degraded must not mean disabled');
  assert.match(verdict.reason, /credential/i);
}));
