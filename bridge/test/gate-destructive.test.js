/**
 * Destructive-command permission model (CHG-20261105, v2).
 *
 *   node --test bridge/test/gate-destructive.test.js
 *
 * The gate used to answer a destructive command with a single bit: allow (build
 * output) or refuse (everything else). `rm -f` on a scratch file was refused,
 * `git push --force` was refused, and no amount of user authorization changed
 * either answer. This file pins the two-tier model that replaced it:
 *
 *   guardrail  - unrecoverable. NO grant can reach it.
 *                (delete $HOME / the cwd / a `..` path / a top-level dir,
 *                 format a disk, dd onto a raw device, shut the machine down)
 *
 *   permission - serious but survivable. A *category* decides allow/ask/deny,
 *                and only the user can change a category's tier.
 *                (delete, git-history, git-force-push, db-ddl,
 *                 perm-recursive, process-kill, raw-write)
 *
 * Two properties matter as much as the tiers themselves:
 *
 *   1. tightening beats loosening - a policy `deny` cannot be reopened by a
 *      session grant, or a single conversation could undo a permanent rule.
 *   2. the agent cannot grant itself - `no-self-grant` refuses a write that
 *      carries `destructive_grants`, so the permission table stays a user
 *      decision rather than something the gate's own subject can edit.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import enforceRules from '../gates/pi/index.js';
import { apply as applyDsh } from '../gates/dsh/index.js';
import {
  DEFAULT_CONFIG,
  DESTRUCTIVE_CATEGORIES,
  HARD_CHECKS,
  applyMachineOverride,
  bashDestructiveFinding,
  effectiveDestructiveTier,
  machineGateConfigPath,
  newSessionState,
  policyFromObject,
  shouldBlock,
} from '../gates/policy.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const GATES = join(HERE, '..', 'gates');

/** A cwd with no disposable segment, so the samples are not allow-tier. */
const CWD = '/srv/project';
const FILE = join(CWD, 'notes.txt');
const DATA_DIR = join(CWD, 'data', 'raw');

const config = (over = {}) => ({ ...DEFAULT_CONFIG, project_roots: [], exclude_globs: [], ...over });
const opts = (over = {}) => ({ config: config(over), cwd: CWD });

const policy = (checks = ['no-destructive-bash'], over = {}) =>
  policyFromObject({
    name: 'destructive-test',
    checks,
    config: config({ max_blocks_per_session: 10, ...over }),
  }).policy;

const noFs = {
  exists: () => false,
  isFile: () => false,
  isDirectory: () => false,
  statMtime: () => 0,
  listDir: () => [],
  readText: () => null,
};

const judge = (command, { checks, over = {}, state = newSessionState(), fs = noFs } = {}) =>
  shouldBlock({
    policy: policy(checks, over),
    state,
    input: { action: 'bash', path: null, tool: 'bash', shell: 'bash', command, cwd: CWD },
    fs,
  });

// ---------------------------------------------------------------------------
// Tier 1: guardrails - unrecoverable, and no grant can reach them
// ---------------------------------------------------------------------------

test('guardrail: $HOME and its ancestors stay unrecoverable under any grant', () => {
  const home = homedir();
  assert.equal(bashDestructiveFinding(`rm -rf ${home}`, opts())?.severity, 'high');
  assert.equal(bashDestructiveFinding(`rm -rf ${dirname(home)}`, opts())?.severity, 'high');

  // Even with every category granted, a guardrail is still a guardrail.
  const allGranted = Object.fromEntries(Object.keys(DESTRUCTIVE_CATEGORIES).map((c) => [c, 'allow']));
  const verdict = judge(`rm -rf ${home}`, { over: { destructive_grants: allGranted } });
  assert.equal(verdict.block, true);
  assert.equal(verdict.code, 'DESTRUCTIVE_BASH');
});

test('guardrail: the cwd and its ancestors stay unrecoverable', () => {
  assert.equal(bashDestructiveFinding('rm -rf .', opts())?.severity, 'high');
  assert.equal(bashDestructiveFinding(`rm -rf ${CWD}`, opts())?.severity, 'high');
  assert.equal(bashDestructiveFinding(`rm -rf ${dirname(CWD)}`, opts())?.severity, 'high');
  assert.equal(judge('rm -rf .').block, true);
});

test('guardrail: a `..` segment is high even when normalize() would collapse it', () => {
  // `normalize()` turns this into `<CWD>/notes.txt`, which looks harmless. The
  // escape is only visible on the raw token, so this is the test that proves
  // the raw-token check exists.
  assert.equal(bashDestructiveFinding('rm -f data/../notes.txt', opts())?.severity, 'high');
  assert.equal(judge('rm -f data/../notes.txt').block, true);
  assert.equal(bashDestructiveFinding('rm -rf data/../..', opts())?.severity, 'high');
});

test('guardrail: top-level directories are high; /tmp paths stay disposable', () => {
  for (const target of ['/tmp', '/usr', '/home', '/var']) {
    assert.equal(bashDestructiveFinding(`rm -rf ${target}`, opts())?.severity, 'high', target);
  }
  assert.equal(judge('rm -rf /tmp').block, true);
  // The pre-existing disposable-segment rule wins inside /tmp; unchanged on purpose.
  assert.equal(judge('rm -f /tmp/scratch.txt').block, false);
});

test('guardrail: disk, raw device and host destruction stay unrecoverable', () => {
  for (const command of [
    'mkfs.ext4 /dev/sdb1',
    'fdisk -l',
    'parted /dev/sdb mklabel gpt',
    'format D: /q',
    'Format-Volume -DriveLetter D',
    'dd if=/dev/zero of=/dev/sda',
    'dd if=/dev/zero of=/dev/nvme0n1',
    'shutdown -h now',
    'init 0',
    'Stop-Computer',
  ]) {
    assert.equal(bashDestructiveFinding(command, opts())?.severity, 'high', command);
    assert.equal(judge(command).block, true, command);
  }
});

test('guardrail: a nested shell cannot smuggle one past the gate', () => {
  assert.equal(bashDestructiveFinding("bash -c 'rm -rf /'", opts())?.severity, 'high');
  assert.equal(judge("bash -c 'git reset --hard'").confirm, true, 'git is a permission, not a guardrail');
  assert.equal(judge("bash -c 'rm -rf /'").block, true);
});

test('guardrail: an injected git-repo probe makes a non-ancestor repo root high', () => {
  const repo = join(CWD, 'vendor', 'lib');
  const isGitRepo = (dir) => dir === repo;
  assert.equal(bashDestructiveFinding(`rm -rf ${repo}`, { ...opts(), isGitRepo })?.severity, 'high');
  // Without the probe the same target is recoverable enough to ask about.
  assert.equal(bashDestructiveFinding(`rm -rf ${repo}`, opts())?.severity, 'confirm');
});

// ---------------------------------------------------------------------------
// Tier 2: permissions - a category decides allow / confirm / deny
// ---------------------------------------------------------------------------

test('permission: deleting a named file or data dir is a confirm, not a refusal', () => {
  for (const command of [`rm -f ${FILE}`, `rm -rf ${DATA_DIR}`, `find ${DATA_DIR} -delete`]) {
    const finding = bashDestructiveFinding(command, opts());
    assert.equal(finding?.severity, 'confirm', command);
    assert.equal(finding?.category, 'delete', command);

    const verdict = judge(command);
    assert.equal(verdict.block, false, command);
    assert.equal(verdict.confirm, true, command);
    assert.equal(verdict.confirmCategory, 'delete', command);
  }
});

test('permission: git history rewrites are a grantable category', () => {
  for (const command of [
    'git reset --hard',
    'git clean -fd',
    'git checkout -- .',
    'git restore .',
    'git branch -D feature',
    'git stash drop',
    'git filter-branch --tree-filter x',
  ]) {
    const finding = bashDestructiveFinding(command, opts());
    assert.equal(finding?.severity, 'confirm', command);
    assert.equal(finding?.category, 'git-history', command);
  }
});

test('permission: force push is its own category, so it can be granted separately', () => {
  for (const command of ['git push --force', 'git push -f origin main', 'git push --force-with-lease']) {
    const finding = bashDestructiveFinding(command, opts());
    assert.equal(finding?.category, 'git-force-push', command);
    assert.equal(finding?.severity, 'confirm', command);
  }
});

test('permission: a granted category runs without asking', () => {
  const granted = { destructive_grants: { 'git-force-push': 'allow' } };
  const verdict = judge('git push --force', { over: granted });
  assert.equal(verdict.block, false);
  assert.equal(verdict.confirm, false, 'a granted category must not prompt');

  // ...and the other categories are untouched by that grant.
  assert.equal(judge('rm -f ' + FILE, { over: granted }).confirm, true);
});

test('permission: a denied category refuses, with a way back', () => {
  const verdict = judge('git push --force', { over: { destructive_grants: { 'git-force-push': 'deny' } } });
  assert.equal(verdict.block, true);
  assert.equal(verdict.code, 'DESTRUCTIVE_DENIED');
  assert.match(verdict.reason, /gate ask git-force-push/);
});

test('permission: db-ddl starts at deny because a dropped schema outlives most backups', () => {
  assert.equal(DEFAULT_CONFIG.destructive_grants['db-ddl'], 'deny');
  assert.equal(bashDestructiveFinding('drop database prod', opts())?.category, 'db-ddl');

  const refused = judge('drop database prod');
  assert.equal(refused.block, true);
  assert.equal(refused.code, 'DESTRUCTIVE_DENIED');

  const granted = judge('drop database prod', { over: { destructive_grants: { 'db-ddl': 'allow' } } });
  assert.equal(granted.block, false);
  assert.equal(granted.confirm, false);
});

test('permission: recursive chmod / chown and forced process kill are categories', () => {
  assert.equal(bashDestructiveFinding(`chmod -R 777 ${CWD}`, opts())?.category, 'perm-recursive');
  assert.equal(bashDestructiveFinding('taskkill /F /IM node.exe', opts())?.category, 'process-kill');
});

test('permission: dd onto a plain file is grantable, dd onto a device is not', () => {
  const plain = bashDestructiveFinding(`dd if=/dev/zero of=${FILE}`, opts());
  assert.equal(plain?.severity, 'confirm');
  assert.equal(plain?.category, 'raw-write');

  assert.equal(bashDestructiveFinding('dd if=/dev/zero of=/dev/sda', opts())?.severity, 'high');
});

test('permission: tightening beats loosening', () => {
  // A session grant must not reopen a permanent deny.
  assert.equal(
    effectiveDestructiveTier('db-ddl', { destructive_grants: { 'db-ddl': 'deny' } }, {
      destructiveGrants: new Map([['db-ddl', 'allow']]),
    }),
    'deny',
  );
  // A session may always be stricter than its policy.
  assert.equal(
    effectiveDestructiveTier('delete', { destructive_grants: { delete: 'allow' } }, {
      destructiveGrants: new Map([['delete', 'deny']]),
    }),
    'deny',
  );
  // A session grant loosens a confirm.
  assert.equal(
    effectiveDestructiveTier('delete', { destructive_grants: { delete: 'confirm' } }, {
      destructiveGrants: new Map([['delete', 'allow']]),
    }),
    'allow',
  );
});

test('allow tier: build output still runs without asking (no regression)', () => {
  for (const command of ['rm -rf node_modules', 'rm -rf dist', 'rm -rf build', 'rm -rf .venv', 'rm -rf __pycache__']) {
    assert.equal(bashDestructiveFinding(command, opts()), null, command);
    const verdict = judge(command);
    assert.equal(verdict.block, false, command);
    assert.equal(verdict.confirm, false, `${command} is allow-tier, not confirm-tier`);
  }
});

test('rollback switch: destructive_confirm_mode:false blocks the ask tier again', () => {
  const verdict = judge(`rm -f ${FILE}`, { over: { destructive_confirm_mode: false } });
  assert.equal(verdict.block, true);
  assert.equal(verdict.code, 'DESTRUCTIVE_BASH');
  assert.match(verdict.reason, /destructive_confirm_mode 为 false/);
});

test('block cap: a confirm is not a block, and both security checks stay hard', () => {
  const state = newSessionState();
  judge(`rm -f ${FILE}`, { state });
  judge(`rm -f ${FILE}`, { state });
  assert.equal(state.blocks, 0, 'confirmations must not spend the session rule budget');

  judge('drop database prod', { state });
  assert.equal(state.blocks, 1, 'a real block still counts');

  assert.equal(HARD_CHECKS.has('no-destructive-bash'), true);
  assert.equal(HARD_CHECKS.has('no-self-grant'), true);
});

// ---------------------------------------------------------------------------
// The agent cannot grant itself
// ---------------------------------------------------------------------------

const GATE_FILE = join('/home', 'someone', '.config', 'agent-config-bridge', 'gate-policy.json');

test('self-grant: a write that carries destructive_grants is refused', () => {
  const verdict = shouldBlock({
    policy: policy(['no-self-grant']),
    state: newSessionState(),
    input: {
      action: 'write',
      path: GATE_FILE,
      tool: 'write',
      content: JSON.stringify({ config: { destructive_grants: { 'db-ddl': 'allow' } } }),
    },
    fs: noFs,
  });
  assert.equal(verdict.block, true);
  assert.equal(verdict.code, 'GATE_SELF_GRANT');
  assert.match(verdict.reason, /不能给自己提权/);
});

test('self-grant: an ordinary edit of the same file is still allowed', () => {
  const verdict = shouldBlock({
    policy: policy(['no-self-grant']),
    state: newSessionState(),
    input: { action: 'write', path: GATE_FILE, tool: 'write', content: '{"config":{"max_blocks_per_session":20}}' },
    fs: noFs,
  });
  assert.equal(verdict.block, false, 'only the permission table is protected');
});

test('self-grant: a shell redirect at the same file is refused', () => {
  const verdict = shouldBlock({
    policy: policy(['no-self-grant']),
    state: newSessionState(),
    input: {
      action: 'bash',
      path: null,
      tool: 'bash',
      shell: 'bash',
      command: `echo '{"config":{"destructive_grants":{"delete":"allow"}}}' > ${GATE_FILE}`,
      cwd: CWD,
    },
    fs: noFs,
  });
  assert.equal(verdict.block, true);
  assert.equal(verdict.code, 'GATE_SELF_GRANT');
});

// ---------------------------------------------------------------------------
// The machine-local override is the grant store
// ---------------------------------------------------------------------------

const withHome = (fn) => async () => {
  const home = mkdtempSync(join(tmpdir(), 'gate-grant-'));
  try {
    await fn(home);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
};

test('override: a grant written to the machine file takes effect', withHome(async (home) => {
  const file = machineGateConfigPath(home);
  assert.equal(file, join(home, '.config', 'agent-config-bridge', 'gate-policy.json'));

  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ config: { destructive_grants: { delete: 'allow' } } }), 'utf8');

  const merged = applyMachineOverride(policy(), home);
  assert.equal(merged.config.destructive_grants.delete, 'allow');
  assert.equal(merged.config.destructive_grants['git-history'], 'confirm', 'other keys keep their default');
}));

test('override: an unknown category or a bad tier is ignored, not applied', withHome(async (home) => {
  const file = machineGateConfigPath(home);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(
    file,
    JSON.stringify({ config: { destructive_grants: { 'not-a-category': 'allow', delete: 'yolo' } } }),
    'utf8',
  );

  const merged = applyMachineOverride(policy(), home);
  assert.equal(merged.config.destructive_grants.delete, 'confirm');
  assert.equal('not-a-category' in merged.config.destructive_grants, false);
}));

test('override: a broken file leaves the shipped policy standing', withHome(async (home) => {
  const file = machineGateConfigPath(home);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, '{ not json', 'utf8');

  const merged = applyMachineOverride(policy(), home);
  assert.equal(merged.config.destructive_grants.delete, 'confirm');
}));

// ---------------------------------------------------------------------------
// pi adapter: it asks, with three options
// ---------------------------------------------------------------------------

const makePi = () => {
  const handlers = {};
  const commands = {};
  return {
    handlers,
    commands,
    on: (name, fn) => {
      handlers[name] = fn;
    },
    registerCommand: (name, def) => {
      commands[name] = def;
    },
  };
};

const piWith = (over = {}) => {
  const pi = makePi();
  enforceRules(pi, {
    policy: {
      name: 'destructive-test',
      checks: ['no-destructive-bash'],
      config: config({ max_blocks_per_session: 10, ...over }),
    },
  });
  return pi;
};

const uiCtx = ({ choice, calls }) => ({
  cwd: CWD,
  hasUI: true,
  ui: {
    notify: () => {},
    select: async (message, options) => {
      calls.push({ message, options });
      return typeof choice === 'function' ? choice(options) : choice;
    },
  },
});

test('pi: allow-once proceeds and asks exactly once', async () => {
  const pi = piWith();
  await pi.handlers.session_start({}, { cwd: CWD, hasUI: false });

  const calls = [];
  const verdict = await pi.handlers.tool_call(
    { toolName: 'bash', input: { command: `rm -f ${FILE}` } },
    uiCtx({ choice: '允许这一次', calls }),
  );

  assert.equal(verdict, undefined);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.length, 3, 'allow once / allow this class / reject');
  assert.match(calls[0].message, /delete/);
});

test('pi: reject blocks the call', async () => {
  const pi = piWith();
  await pi.handlers.session_start({}, { cwd: CWD, hasUI: false });

  const calls = [];
  const verdict = await pi.handlers.tool_call(
    { toolName: 'bash', input: { command: `rm -f ${FILE}` } },
    uiCtx({ choice: '拒绝', calls }),
  );

  assert.equal(verdict.block, true);
  assert.match(verdict.reason, /用户拒绝/);
});

test('pi: dismissing the dialog is a refusal, not an approval', async () => {
  const pi = piWith();
  await pi.handlers.session_start({}, { cwd: CWD, hasUI: false });

  const verdict = await pi.handlers.tool_call(
    { toolName: 'bash', input: { command: `rm -f ${FILE}` } },
    uiCtx({ choice: null, calls: [] }),
  );

  assert.equal(verdict.block, true);
});

test('pi: "allow this class" suppresses the question for the rest of the session', async () => {
  const pi = piWith();
  await pi.handlers.session_start({}, { cwd: CWD, hasUI: false });

  const first = [];
  await pi.handlers.tool_call(
    { toolName: 'bash', input: { command: `rm -f ${FILE}` } },
    uiCtx({ choice: (options) => options[1], calls: first }),
  );
  assert.equal(first.length, 1);

  const second = [];
  const verdict = await pi.handlers.tool_call(
    { toolName: 'bash', input: { command: `rm -rf ${DATA_DIR}` } },
    uiCtx({ choice: '拒绝', calls: second }),
  );
  assert.equal(second.length, 0, 'the session grant answers for the whole class');
  assert.equal(verdict, undefined);
});

test('pi: a guardrail blocks without asking, even when everything is granted', async () => {
  const allGranted = Object.fromEntries(Object.keys(DESTRUCTIVE_CATEGORIES).map((c) => [c, 'allow']));
  const pi = piWith({ destructive_grants: allGranted });
  await pi.handlers.session_start({}, { cwd: CWD, hasUI: false });

  const calls = [];
  const verdict = await pi.handlers.tool_call(
    { toolName: 'bash', input: { command: `rm -rf ${homedir()}` } },
    uiCtx({ choice: '允许这一次', calls }),
  );

  assert.equal(verdict.block, true);
  assert.equal(calls.length, 0, 'an unrecoverable command is not a question');
});

test('pi: no UI runs the ask tier and records the decision', async () => {
  const pi = piWith();
  await pi.handlers.session_start({}, { cwd: CWD, hasUI: false });

  const written = [];
  const original = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk) => {
    written.push(String(chunk));
    return true;
  };
  let verdict;
  try {
    verdict = await pi.handlers.tool_call(
      { toolName: 'bash', input: { command: `rm -f ${FILE}` } },
      { cwd: CWD, hasUI: false },
    );
  } finally {
    process.stderr.write = original;
  }

  assert.equal(verdict, undefined, 'a headless run must not hang on a dialog');
  assert.ok(
    written.some((line) => line.includes('DESTRUCTIVE_CONFIRM auto-approved')),
    'the decision must be recorded, not silent',
  );
});

// ---------------------------------------------------------------------------
// pi: the /gate command
// ---------------------------------------------------------------------------

test('pi: /gate list reports every category and the red lines', async () => {
  const pi = piWith();
  const notes = [];
  const ctx = { hasUI: true, ui: { notify: (text) => notes.push(text) } };

  await pi.commands.gate.handler('list', ctx);

  const text = notes.join('\n');
  for (const category of Object.keys(DESTRUCTIVE_CATEGORIES)) {
    assert.ok(text.includes(category), `list must mention ${category}`);
  }
  assert.match(text, /红线/);
  assert.match(text, /db-ddl\s+deny/);
});

test('pi: /gate grant writes the machine file and rejects unknown categories', withHome(async (home) => {
  const previous = process.env.HOME;
  process.env.HOME = home;
  try {
    const pi = piWith();
    const notes = [];
    const ctx = { hasUI: true, ui: { notify: (text) => notes.push(text) } };

    await pi.commands.gate.handler('grant git-force-push', ctx);
    const file = machineGateConfigPath();
    const doc = JSON.parse(readFileSync(file, 'utf8'));
    assert.equal(doc.config.destructive_grants['git-force-push'], 'allow');

    await pi.commands.gate.handler('deny db-ddl', ctx);
    const after = JSON.parse(readFileSync(file, 'utf8'));
    assert.equal(after.config.destructive_grants['db-ddl'], 'deny');

    notes.length = 0;
    await pi.commands.gate.handler('grant not-a-category', ctx);
    assert.match(notes.join('\n'), /未知类别/);
  } finally {
    if (previous === undefined) delete process.env.HOME;
    else process.env.HOME = previous;
  }
}));

// ---------------------------------------------------------------------------
// dsh adapter: no UI channel, so ask degrades to "run it"
// ---------------------------------------------------------------------------

const dshPreExecute = (over = {}) => {
  const handlers = {};
  const ctx = { on: (name, fn) => { handlers[name] = fn; }, logger: { warn: () => {} } };
  applyDsh(ctx, {
    policy: {
      name: 'destructive-test',
      checks: ['no-destructive-bash'],
      config: config({ max_blocks_per_session: 10, ...over }),
    },
  });
  return handlers['tools/pre-execute'];
};

const nextMarker = () => {
  const marker = { kind: 'next' };
  return { next: () => marker, marker };
};

test('dsh: guardrails deny, permissions delegate, denies refuse', async () => {
  const pre = dshPreExecute();

  const guardrail = await pre(
    { name: 'bash', arguments: { command: `rm -rf ${homedir()}` }, cwd: CWD },
    nextMarker().next,
  );
  assert.equal(guardrail.kind, 'deny');
  assert.match(guardrail.reason, /不可恢复/);

  const { next, marker } = nextMarker();
  const permission = await pre({ name: 'bash', arguments: { command: `rm -f ${FILE}` }, cwd: CWD }, next);
  assert.equal(permission, marker, 'dsh has no dialog, so the call is delegated');

  const denied = await pre(
    { name: 'bash', arguments: { command: 'drop database prod' }, cwd: CWD },
    nextMarker().next,
  );
  assert.equal(denied.kind, 'deny');
  assert.match(denied.reason, /db-ddl/);
});

test('dsh: the rollback switch and category grants both hold', async () => {
  const strict = dshPreExecute({ destructive_confirm_mode: false });
  const blocked = await strict({ name: 'bash', arguments: { command: `rm -f ${FILE}` }, cwd: CWD }, nextMarker().next);
  assert.equal(blocked.kind, 'deny');

  const granted = dshPreExecute({ destructive_grants: { delete: 'allow' } });
  const { next, marker } = nextMarker();
  const allowed = await granted({ name: 'bash', arguments: { command: `rm -f ${FILE}` }, cwd: CWD }, next);
  assert.equal(allowed, marker);
});

// ---------------------------------------------------------------------------
// Shipped configuration: both harnesses carry the same table
// ---------------------------------------------------------------------------

test('config: both shipped policies declare the grants and the self-grant guard', () => {
  for (const adapter of ['pi', 'dsh']) {
    const parsed = JSON.parse(readFileSync(join(GATES, adapter, 'policy.json'), 'utf8'));
    assert.equal(parsed.config.destructive_confirm_mode, true, `${adapter}: confirm mode`);
    assert.equal(parsed.config.destructive_grants['db-ddl'], 'deny', `${adapter}: db-ddl default`);
    assert.equal(parsed.config.destructive_grants.delete, 'confirm', `${adapter}: delete default`);
    assert.ok(parsed.checks.includes('no-self-grant'), `${adapter}: self-grant guard enabled`);
  }
});
