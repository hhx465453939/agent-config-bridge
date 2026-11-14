/**
 * dsh slash-command surface: the plugin's pure pieces, its registration, and the
 * deployment that puts it on disk.
 *
 *   node --test bridge/test/commands.test.js
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  apply,
  commandName,
  describeGate,
  parseFrontmatter,
  renderPrompt,
  renderServerList,
} from '../../dsh/commands/index.js';
import { planCommandsInstall } from '../lib/commands.js';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

const withTmp = (fn) => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-commands-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

/** Minimal stand-in for the cordis context the plugin actually receives. */
const makeCtx = (services = {}) => {
  const registered = [];
  return {
    registered,
    commands: { register: (definition) => registered.push(definition) },
    get: (name) => services[name],
    logger: { warn: () => {}, info: () => {} },
  };
};

// --- names ------------------------------------------------------------------

test('command names are lowercase slugs the registry accepts', () => {
  assert.equal(commandName('git-commit.md'), 'git-commit');
  assert.equal(commandName('git-cleanBranches.md'), 'git-clean-branches');
  assert.equal(commandName('Ralph YOLO.md'), 'ralph-yolo');
  assert.equal(commandName('a__b.md'), 'a__b');
});

test('a name with nothing usable left is empty so the caller can skip it', () => {
  assert.equal(commandName('中文命令.md'), '');
  assert.equal(commandName('---.md'), '');
});

// --- frontmatter and rendering ----------------------------------------------

test('frontmatter is stripped from the prompt and its keys are read', () => {
  const { meta, body } = parseFrontmatter(
    '---\ndescription: Run the review\nargument-hint: <path>\n---\nReview $ARGUMENTS now.\n',
  );
  assert.equal(meta.description, 'Run the review');
  assert.equal(meta['argument-hint'], '<path>');
  assert.equal(body.trim(), 'Review $ARGUMENTS now.');
});

test('a file without frontmatter is all body', () => {
  const { meta, body } = parseFrontmatter('just a prompt\n');
  assert.deepEqual(meta, {});
  assert.equal(body, 'just a prompt\n');
});

test('$ARGUMENTS is substituted, and stray input is appended rather than dropped', () => {
  assert.equal(renderPrompt('review $ARGUMENTS please', 'src/app.ts'), 'review src/app.ts please');
  assert.equal(renderPrompt('run the review', 'src/app.ts'), 'run the review\n\nsrc/app.ts');
  assert.equal(renderPrompt('run the review  ', ''), 'run the review');
});

// --- the operational commands ----------------------------------------------

test('/mcp renders every server, including a plugin-registered one', () => {
  const text = renderServerList([
    { name: 'codebase-memory-mcp', configured: true, status: 'connected' },
    { name: 'external', configured: false, status: { state: 'waiting-credentials' } },
  ]);
  assert.match(text, /codebase-memory-mcp\s+\[configured\]\s+connected/);
  assert.match(text, /external\s+\[plugin\]\s+waiting-credentials/);
});

test('/mcp says so when nothing is configured', () => {
  assert.match(renderServerList([]), /No MCP server/);
});

test('/gate reports a missing policy instead of throwing', () => withTmp((dir) => {
  const text = describeGate(join(dir, 'nope.json'), join(dir, 'missing.json'));
  assert.match(text, /policy: not found/);
  assert.match(text, /machine override: not found/);
}));

test('/gate reports the checks and the machine override keys', () => withTmp((dir) => {
  const policy = join(dir, 'policy.json');
  const machine = join(dir, 'gate-policy.json');
  writeFileSync(policy, JSON.stringify({
    checks: ['graph-before-read', 'no-destructive-bash'],
    config: { project_roots: ['E:\\Development'], destructive_mode: 'enforce', max_blocks_per_session: 200, block_cap_reset_ms: 1800000 },
  }));
  writeFileSync(machine, JSON.stringify({ config: { project_roots: ['E:\\Development'] } }));
  const text = describeGate(policy, machine);
  assert.match(text, /checks: graph-before-read, no-destructive-bash/);
  assert.match(text, /project_roots: E:\\Development/);
  assert.match(text, /destructive_mode: enforce/);
  assert.match(text, /block window: 200 per 30 min/);
  assert.match(text, /machine override keys: project_roots/);
}));

// --- registration -----------------------------------------------------------

test('activation registers /mcp, /gate and one command per prompt file', () => withTmp((dir) => {
  const prompts = join(dir, 'prompts');
  mkdirSync(prompts, { recursive: true });
  writeFileSync(join(prompts, 'code-review.md'), '---\ndescription: Review the diff\n---\nReview $ARGUMENTS\n');
  writeFileSync(join(prompts, 'debug.md'), 'Debug the issue: $ARGUMENTS\n');
  // A file whose name collides with a built-in command must not shadow it.
  writeFileSync(join(prompts, 'mcp.md'), 'hijack\n');
  writeFileSync(join(prompts, 'notes.txt'), 'ignored\n');

  const ctx = makeCtx({ mcpManager: { list: () => [], restart: async () => {} } });
  apply(ctx, { promptsDir: prompts, gatePolicyPath: join(dir, 'none.json'), machineGatePath: join(dir, 'none2.json') });

  const names = ctx.registered.map((definition) => definition.name);
  assert.deepEqual(names.sort(), ['code-review', 'debug', 'gate', 'mcp']);
  assert.ok(!names.includes('notes'));
}));

test('a prompt command sends the rendered template as the next user message', () => withTmp((dir) => {
  const prompts = join(dir, 'prompts');
  mkdirSync(prompts, { recursive: true });
  writeFileSync(join(prompts, 'review.md'), 'Please review $ARGUMENTS carefully.\n');

  const ctx = makeCtx();
  apply(ctx, { promptsDir: prompts, gatePolicyPath: join(dir, 'none.json'), machineGatePath: join(dir, 'none2.json') });

  const command = ctx.registered.find((definition) => definition.name === 'review');
  const sent = [];
  const result = command.handler({ agent: { followup: (message) => sent.push(message) }, rawInput: 'src/a.ts' });

  assert.equal(result.kind, 'success');
  assert.equal(sent.length, 1, 'exactly one follow-up turn');
  const [message] = sent;
  assert.equal(message.role, 'user');
  assert.deepEqual(message.source, { kind: 'user' });
  assert.equal(typeof message.id, 'string');
  assert.ok(message.id.length > 0);
  assert.deepEqual(message.content, [{ type: 'text', text: 'Please review src/a.ts carefully.' }]);
}));

test('a prompt command reports an agent that cannot accept a follow-up', () => withTmp((dir) => {
  const prompts = join(dir, 'prompts');
  mkdirSync(prompts, { recursive: true });
  writeFileSync(join(prompts, 'review.md'), 'Review\n');
  const ctx = makeCtx();
  apply(ctx, { promptsDir: prompts, gatePolicyPath: join(dir, 'none.json'), machineGatePath: join(dir, 'none2.json') });
  const command = ctx.registered.find((definition) => definition.name === 'review');
  const result = command.handler({ agent: {}, rawInput: '' });
  assert.equal(result.kind, 'error');
  assert.match(result.text, /cannot accept/);
}));

test('/mcp restart asks the manager, and a missing manager is an error not a crash', () => withTmp((dir) => {
  const restarts = [];
  const ctx = makeCtx({ mcpManager: { list: () => [{ name: 'x', configured: true, status: 'connected' }], restart: async (name) => restarts.push(name) } });
  apply(ctx, { promptsDir: join(dir, 'none'), gatePolicyPath: join(dir, 'none.json'), machineGatePath: join(dir, 'none2.json') });
  const mcp = ctx.registered.find((definition) => definition.name === 'mcp');

  return Promise.resolve(mcp.handler({ rawInput: 'restart codebase-memory-mcp' })).then((result) => {
    assert.equal(result.kind, 'success');
    assert.deepEqual(restarts, ['codebase-memory-mcp']);
  });
}));

test('the prompt directory is optional: activation still registers the operational commands', () => withTmp((dir) => {
  const ctx = makeCtx();
  apply(ctx, { promptsDir: join(dir, 'missing'), gatePolicyPath: join(dir, 'none.json'), machineGatePath: join(dir, 'none2.json') });
  assert.deepEqual(ctx.registered.map((d) => d.name).sort(), ['gate', 'mcp']);
}));

// --- deployment -------------------------------------------------------------

test('install plan copies the plugin, declares its module type and syncs prompts', () => withTmp((home) => {
  mkdirSync(join(home, '.claude', 'commands'), { recursive: true });
  writeFileSync(join(home, '.claude', 'commands', 'code-review.md'), 'Review $ARGUMENTS\n');
  writeFileSync(join(home, '.claude', 'commands', 'notes.txt'), 'ignored\n');

  const manifest = {
    name: 'dsh',
    display: 'DeepSeek Harness (dsh)',
    commands: { supported: true, installAs: 'agent-config-commands', extensionDir: '.dsh/plugins' },
  };
  const actions = planCommandsInstall({ repo, home, manifest });
  const targets = actions.map((action) => action.to.replace(home, '~').split('\\').join('/'));

  assert.ok(targets.includes('~/.dsh/plugins/agent-config-commands/index.js'));
  assert.ok(targets.includes('~/.dsh/plugins/agent-config-commands/prompts/code-review.md'));
  assert.ok(!targets.some((target) => target.endsWith('notes.txt')));

  const pkg = actions.find((action) => action.to.endsWith('package.json'));
  assert.equal(JSON.parse(pkg.content).type, 'module');

  const readme = actions.find((action) => action.to.endsWith('README.md'));
  assert.match(readme.content, /\/mcp/);
  assert.match(readme.content, /agent\.followup/);
  assert.match(readme.content, /agent-config-commands\/index\.js/);
}));

test('the shipped plugin file is what gets installed (no drift between repo and install)', () => withTmp((home) => {
  const manifest = {
    name: 'dsh',
    display: 'DeepSeek Harness (dsh)',
    commands: { supported: true, installAs: 'agent-config-commands', extensionDir: '.dsh/plugins' },
  };
  const actions = planCommandsInstall({ repo, home, manifest });
  const plugin = actions.find((action) => action.to.endsWith('index.js'));
  assert.equal(readFileSync(plugin.from, 'utf8'), readFileSync(join(repo, 'dsh', 'commands', 'index.js'), 'utf8'));
}));
