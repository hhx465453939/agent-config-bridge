/**
 * Destructive-command mode: enforce / bypass (CHG-20261105-gate-bypass-mode, ADR-013).
 *
 *   node --test bridge/test/gate-bypass.test.js
 *
 * The tier model from ADR-012 answers "may the agent do this class of thing?".
 * It cannot answer "should I keep being asked about destructive commands right
 * now?", and that is the question a long unattended run needs answered: a
 * `confirm` dialog at 03:00 waits for a person who is asleep.
 *
 * What this file pins - and the SCOPE is as important as the behaviour:
 *
 *   1. bypass affects `no-destructive-bash` permission tiers, and NOTHING else.
 *      The graph / think / contract / secret / AI4S rules, the turn-end checks
 *      and the per-turn reminder keep running identically. Those are discipline,
 *      not "questions the user got tired of".
 *   2. The unrecoverable guardrail inside the same check still blocks, in every
 *      mode. A bypass that deletes $HOME is not a feature.
 *   3. The switch is user-only: a write carrying `destructive_mode` is refused,
 *      so the agent cannot turn its own destructive permission layer off.
 *   4. A bypass can expire (`/gate mode bypass 8h`), and a session override
 *      (`/gate mode … session`) wins in both directions and writes nothing.
 *   5. `enforce` remains the default, so nothing here weakens a shipped install.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import enforceRules, { formatDurationMs, parseGateDurationMs } from '../gates/pi/index.js';
import { apply as applyDsh } from '../gates/dsh/index.js';
import {
  DEFAULT_CONFIG,
  DESTRUCTIVE_CATEGORIES,
  DESTRUCTIVE_MODES,
  applyMachineOverride,
  destructiveModeRemainingMs,
  effectiveDestructiveMode,
  isDestructiveBypass,
  machineGateConfigPath,
  newSessionState,
  normalizeDestructiveMode,
  normalizeDestructiveModeUntil,
  policyFromObject,
  reminderFor,
  shouldBlock,
} from '../gates/policy.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const GATES = join(HERE, '..', 'gates');

/** A cwd with no disposable segment, so samples are not the allow tier. */
const CWD = '/srv/project';
const FILE = join(CWD, 'notes.txt');
const SRC = join(CWD, 'src', 'app.js');
const GATE_FILE = join(homedir(), '.config', 'agent-config-bridge', 'gate-policy.json');

const config = (over = {}) => ({
  ...DEFAULT_CONFIG,
  // In scope on purpose: the research rules must actually fire, otherwise
  // "bypass does not touch them" would assert nothing.
  project_roots: [CWD],
  exclude_globs: [],
  ...over,
});

const policy = (checks = ['no-destructive-bash'], over = {}) =>
  policyFromObject({
    name: 'bypass-test',
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

const readJudge = (path, { checks = ['graph-before-read'], over = {}, state = newSessionState() } = {}) =>
  shouldBlock({
    policy: policy(checks, over),
    state,
    input: { action: 'read', path, tool: 'read' },
    fs: noFs,
  });

const writeJudge = (content, over = {}) =>
  shouldBlock({
    policy: policy(['no-self-grant'], over),
    state: newSessionState(),
    input: { action: 'write', path: GATE_FILE, tool: 'write', content },
    fs: noFs,
  });

// ---------------------------------------------------------------------------
// The mode itself
// ---------------------------------------------------------------------------

test('mode: the shipped default is enforce, and bypass is the only alternative', () => {
  assert.equal(DEFAULT_CONFIG.destructive_mode, 'enforce');
  assert.equal(DEFAULT_CONFIG.destructive_mode_until, 0);
  assert.deepEqual(DESTRUCTIVE_MODES, ['enforce', 'bypass']);
  assert.equal(policy().config.destructive_mode, 'enforce');
});

test('mode: enforce still asks for a recoverable delete', () => {
  const verdict = judge(`rm -f ${FILE}`);
  assert.equal(verdict.block, false, 'an ask is not a refusal');
  assert.equal(verdict.confirm, true);
});

test('bypass: a recoverable delete runs without asking', () => {
  const verdict = judge(`rm -f ${FILE}`, { over: { destructive_mode: 'bypass' } });
  assert.equal(verdict.block, false);
  assert.equal(verdict.confirm, false, 'no dialog is the whole point');
});

test('bypass: the unrecoverable red lines still block', () => {
  const commands = [
    `rm -rf ${homedir()}`, // $HOME
    'rm -rf .', // the cwd itself
    'rm -rf /tmp', // a top-level directory
    'rm -f data/../notes.txt', // a `..` escape
    'mkfs.ext4 /dev/sdb1', // disk
    'shutdown -h now', // host
  ];
  for (const command of commands) {
    const verdict = judge(command, { over: { destructive_mode: 'bypass' } });
    assert.equal(verdict.block, true, command);
    assert.equal(verdict.code, 'DESTRUCTIVE_BASH', command);
  }

  // …and granting every category does not change that.
  const allGranted = Object.fromEntries(Object.keys(DESTRUCTIVE_CATEGORIES).map((c) => [c, 'allow']));
  const verdict = judge(`rm -rf ${homedir()}`, {
    over: { destructive_mode: 'bypass', destructive_grants: allGranted },
  });
  assert.equal(verdict.block, true);
});

test('bypass: a deny-tier category is open too', () => {
  const denied = judge('drop database prod');
  assert.equal(denied.block, true);
  assert.equal(denied.code, 'DESTRUCTIVE_DENIED');

  const bypassed = judge('drop database prod', { over: { destructive_mode: 'bypass' } });
  assert.equal(bypassed.block, false);
  assert.equal(bypassed.confirm, false);
});

// ---------------------------------------------------------------------------
// The scope: nothing outside the destructive gate is affected
// ---------------------------------------------------------------------------

test('bypass: the research rules still fire (scope is destructive only)', () => {
  const enforced = readJudge(SRC);
  assert.equal(enforced.block, true);
  assert.equal(enforced.code, 'GRAPH_FIRST');

  const bypassed = readJudge(SRC, { over: { destructive_mode: 'bypass' } });
  assert.equal(bypassed.block, true, 'a read gate is not a destructive permission');
  assert.equal(bypassed.code, 'GRAPH_FIRST');
});

test('bypass: the per-turn reminder is untouched', () => {
  const reminded = (over) =>
    policyFromObject({
      name: 'reminder-test',
      reminder: 'ASK THE GRAPH FIRST',
      checks: ['graph-before-read'],
      config: config({ ...over }),
    }).policy;

  assert.match(reminderFor(reminded({ destructive_mode: 'bypass' }), newSessionState()), /ASK THE GRAPH FIRST/);
  assert.match(reminderFor(reminded({}), newSessionState()), /ASK THE GRAPH FIRST/);
});

test('bypass: no-self-grant still refuses a write that carries destructive_mode', () => {
  const verdict = writeJudge('{"config":{"destructive_mode":"bypass"}}', { destructive_mode: 'bypass' });
  assert.equal(verdict.block, true);
  assert.equal(verdict.code, 'GATE_SELF_GRANT');
  assert.match(verdict.reason, /destructive_mode/);
});

test('bypass: an unrelated edit of the same file is still allowed', () => {
  const verdict = writeJudge('{"config":{"max_blocks_per_session":20}}', { destructive_mode: 'bypass' });
  assert.equal(verdict.block, false, 'only the grants table and the mode switch are protected');
});

// ---------------------------------------------------------------------------
// Expiry and session override
// ---------------------------------------------------------------------------

test('expiry: a past destructive_mode_until is enforce again', () => {
  const now = Date.now();
  const expired = { destructive_mode: 'bypass', destructive_mode_until: now - 1000 };
  assert.equal(effectiveDestructiveMode(expired, newSessionState(), now), 'enforce');
  assert.equal(isDestructiveBypass(expired, newSessionState(), now), false);
  assert.equal(destructiveModeRemainingMs(expired, now), 0);

  const verdict = judge(`rm -f ${FILE}`, { over: expired });
  assert.equal(verdict.confirm, true, 'the ask comes back once the bypass expires');
});

test('expiry: a future destructive_mode_until is still bypass', () => {
  const now = Date.now();
  const bounded = { destructive_mode: 'bypass', destructive_mode_until: now + 60_000 };
  assert.equal(effectiveDestructiveMode(bounded, newSessionState(), now), 'bypass');
  assert.equal(destructiveModeRemainingMs(bounded, now), 60_000);
  assert.equal(destructiveModeRemainingMs({ destructive_mode: 'bypass', destructive_mode_until: 0 }, now), null);
});

test('session override: wins in both directions', () => {
  const loosened = newSessionState();
  loosened.destructiveMode = 'bypass';
  assert.equal(effectiveDestructiveMode({ destructive_mode: 'enforce' }, loosened), 'bypass');
  const verdict = judge(`rm -f ${FILE}`, { state: loosened });
  assert.equal(verdict.confirm, false);

  const tightened = newSessionState();
  tightened.destructiveMode = 'enforce';
  assert.equal(effectiveDestructiveMode({ destructive_mode: 'bypass', destructive_mode_until: 0 }, tightened), 'enforce');
});

test('normalize: an unknown mode and a junk expiry fall back to enforce/0', () => {
  assert.equal(normalizeDestructiveMode('BOGUS'), 'enforce');
  assert.equal(normalizeDestructiveMode(' BYPASS '), 'bypass');
  assert.equal(normalizeDestructiveMode(undefined), 'enforce');
  assert.equal(normalizeDestructiveModeUntil('abc'), 0);
  assert.equal(normalizeDestructiveModeUntil(null), 0);
  assert.equal(normalizeDestructiveModeUntil(-5), 0);
  assert.equal(normalizeDestructiveModeUntil(1_700_000_000_000), 1_700_000_000_000);

  const sanitized = policy(['no-destructive-bash'], { destructive_mode: 'BOGUS', destructive_mode_until: 'abc' });
  assert.equal(sanitized.config.destructive_mode, 'enforce');
  assert.equal(sanitized.config.destructive_mode_until, 0);
});

test('duration: parses the documented forms and refuses the rest', () => {
  assert.equal(parseGateDurationMs('90s'), 90_000);
  assert.equal(parseGateDurationMs('30m'), 1_800_000);
  assert.equal(parseGateDurationMs('8h'), 28_800_000);
  assert.equal(parseGateDurationMs('2d'), 172_800_000);
  assert.equal(parseGateDurationMs('8'), 28_800_000, 'a bare number means hours');
  assert.equal(parseGateDurationMs('0h'), null);
  assert.equal(parseGateDurationMs('tomorrow'), null);
  assert.equal(formatDurationMs(28_800_000), '8h');
  assert.equal(formatDurationMs(1_800_000), '30m');
});

// ---------------------------------------------------------------------------
// /gate mode on pi
// ---------------------------------------------------------------------------

const withHome = (fn) => async () => {
  const home = mkdtempSync(join(tmpdir(), 'gate-mode-'));
  const previous = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  process.env.HOME = home;
  try {
    await fn(home);
  } finally {
    if (previous.HOME === undefined) delete process.env.HOME;
    else process.env.HOME = previous.HOME;
    if (previous.USERPROFILE === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = previous.USERPROFILE;
    rmSync(home, { recursive: true, force: true });
  }
};

const makePi = (over = {}) => {
  const handlers = {};
  const commands = {};
  enforceRules(
    { on: (name, fn) => (handlers[name] = fn), registerCommand: (name, def) => (commands[name] = def) },
    {
      policy: {
        name: 'bypass-test',
        checks: ['no-destructive-bash'],
        config: config({ max_blocks_per_session: 10, ...over }),
      },
    },
  );
  return { handlers, commands };
};

const notesOf = () => {
  const notes = [];
  return { notes, ctx: { hasUI: true, ui: { notify: (text) => notes.push(text) } } };
};

test('/gate mode bypass persists to the machine override', withHome(async (home) => {
  const { commands } = makePi();
  const { notes, ctx } = notesOf();

  await commands.gate.handler('mode bypass', ctx);

  const file = machineGateConfigPath();
  assert.equal(file, join(home, '.config', 'agent-config-bridge', 'gate-policy.json'));
  const doc = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(doc.config.destructive_mode, 'bypass');
  assert.equal(doc.config.destructive_mode_until, 0, 'no duration = does not expire');

  // The adapter's own view must agree immediately, not at the next `apply`.
  assert.equal(isDestructiveBypass(applyMachineOverride(policy(), home).config, newSessionState()), true);
  assert.match(notes.join('\n'), /BYPASS/);
}));

test('/gate mode bypass 30m writes an expiry, and enforce clears it', withHome(async () => {
  const { commands } = makePi();
  const { ctx } = notesOf();

  const before = Date.now();
  await commands.gate.handler('mode bypass 30m', ctx);
  const until = JSON.parse(readFileSync(machineGateConfigPath(), 'utf8')).config.destructive_mode_until;
  assert.ok(until >= before + 1_800_000 - 5_000, 'expiry is ~30m out');
  assert.ok(until <= Date.now() + 1_800_000 + 5_000);

  await commands.gate.handler('mode enforce', ctx);
  const after = JSON.parse(readFileSync(machineGateConfigPath(), 'utf8')).config;
  assert.equal(after.destructive_mode, 'enforce');
  assert.equal(after.destructive_mode_until, 0);
}));

test('/gate mode refuses a duration it cannot parse, without writing', withHome(async () => {
  const { commands } = makePi();
  const { notes, ctx } = notesOf();

  await commands.gate.handler('mode bypass tomorrow', ctx);
  assert.equal(existsSync(machineGateConfigPath()), false, 'a typo must not create the file');
  assert.match(notes.join('\n'), /看不懂/);
}));

test('/gate mode bypass session stays in memory and can be cleared', withHome(async () => {
  const { handlers, commands } = makePi();
  const { ctx } = notesOf();
  await handlers.session_start({}, { cwd: CWD, hasUI: false });

  await commands.gate.handler('mode bypass session', ctx);
  assert.equal(existsSync(machineGateConfigPath()), false, 'a session override writes nothing');

  let asked = 0;
  const uiCtx = {
    cwd: CWD,
    hasUI: true,
    ui: { notify: () => {}, select: async () => (asked += 1, '拒绝') },
  };
  const silent = await handlers.tool_call({ toolName: 'bash', input: { command: `rm -f ${FILE}` } }, uiCtx);
  assert.equal(silent, undefined);
  assert.equal(asked, 0, 'bypass does not open a dialog');

  // A global `enforce` clears the session override, so the ask returns.
  await commands.gate.handler('mode enforce', ctx);
  const blocked = await handlers.tool_call({ toolName: 'bash', input: { command: `rm -f ${FILE}` } }, uiCtx);
  assert.equal(asked, 1);
  assert.equal(blocked.block, true);
}));

test('/gate list states the active mode first', withHome(async () => {
  const { commands } = makePi({ destructive_mode: 'bypass' });
  const { notes, ctx } = notesOf();

  await commands.gate.handler('list', ctx);

  const text = notes.join('\n');
  assert.match(text.split('\n')[0], /BYPASS/, 'the mode is the first thing read');
  assert.match(text.split('\n')[0], /破坏性命令/, 'and it names its scope');
  for (const category of Object.keys(DESTRUCTIVE_CATEGORIES)) {
    assert.ok(text.includes(category), `list must mention ${category}`);
  }
  assert.match(text, /红线/);
}));

test('pi: session_start announces a bypass on stderr', withHome(async () => {
  const { handlers } = makePi({ destructive_mode: 'bypass' });
  const written = [];
  const original = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk) => (written.push(String(chunk)), true);
  try {
    await handlers.session_start({}, { cwd: CWD, hasUI: false });
  } finally {
    process.stderr.write = original;
  }
  assert.ok(
    written.some((line) => line.includes('BYPASS') && line.includes('红线')),
    'a silent bypass is the failure mode ADR-013 exists to prevent',
  );
}));

test('pi: turn_end still catches a deferral in bypass', withHome(async () => {
  // The turn-end checks are not destructive-command permissions, so the mode must
  // not silence them. This is the regression guard for "the switch stays narrow".
  const { handlers } = makePi({
    slack_check: true,
    slack_max_continues: 2,
    destructive_mode: 'bypass',
  });
  const verdict = await handlers.turn_end(
    { message: { role: 'assistant', content: [{ type: 'text', text: '我会稍后再补这个功能。' }] } },
    { cwd: CWD, hasUI: false },
  );
  assert.equal(verdict?.continue, true);
}));

// ---------------------------------------------------------------------------
// dsh: same config, no command channel
// ---------------------------------------------------------------------------

const nextMarker = () => {
  const marker = { kind: 'next' };
  return { next: () => marker, marker };
};

test('dsh: a bypass override is honoured and announced', withHome(async (home) => {
  const file = machineGateConfigPath(home);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ config: { destructive_mode: 'bypass' } }), 'utf8');

  const handlers = {};
  const warns = [];
  applyDsh(
    { on: (name, fn) => (handlers[name] = fn), logger: { warn: (text) => warns.push(text) } },
    {
      policy: {
        name: 'bypass-test',
        checks: ['no-destructive-bash'],
        config: config({ max_blocks_per_session: 10 }),
      },
    },
  );
  assert.match(warns.join('\n'), /BYPASS/);

  const pre = handlers['tools/pre-execute'];
  const { next, marker } = nextMarker();
  const permission = await pre(
    { name: 'bash', arguments: { command: `rm -f ${FILE}` }, cwd: CWD },
    next,
  );
  assert.equal(permission, marker, 'in bypass a permission finding is delegated');

  // The cwd is a guardrail on every harness, in every mode.
  const guardrail = await pre(
    { name: 'bash', arguments: { command: 'rm -rf .' }, cwd: CWD },
    nextMarker().next,
  );
  assert.equal(guardrail.kind, 'deny');
}));

// ---------------------------------------------------------------------------
// Shipped configuration
// ---------------------------------------------------------------------------

test('config: both shipped policies declare the mode keys', () => {
  for (const adapter of ['pi', 'dsh']) {
    const parsed = JSON.parse(readFileSync(join(GATES, adapter, 'policy.json'), 'utf8'));
    assert.equal(parsed.config.destructive_mode, 'enforce', `${adapter}: enforce by default`);
    assert.equal(parsed.config.destructive_mode_until, 0, `${adapter}: no expiry`);
  }
});
