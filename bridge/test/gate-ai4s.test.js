/**
 * AI4S domain gates (v5) — classification, the three domain checks, and the
 * "both adapters take their check list from the active profile" contract.
 *
 *   node --test bridge/test/gate-ai4s.test.js
 *
 * What these tests are for
 * ------------------------
 * v5 adds a second axis to the gate: WHICH rules apply depends on the kind of
 * work the session is doing. Every interesting failure of that idea is silent —
 * a classifier that never fires leaves the research rules off (looks installed,
 * enforces nothing), and one that fires too eagerly applies a Worklog demand to
 * an ordinary question. So each assertion below is written to be breakable:
 * remove the level it names and it must go red.
 *
 * The three policy checks are driven through `shouldBlock` with the real
 * filesystem probes and a throwaway directory, because W1/W4 are entirely about
 * file mtimes and pretending otherwise would test the mock.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import enforceRules, { realFs } from '../gates/pi/index.js';
import * as dsh from '../gates/dsh/index.js';
import { classify } from '../gates/classifier.js';
import {
  activeChecks,
  loadPolicy,
  newSessionState,
  normalizePolicy,
  outputArtifactFindings,
  profilePolicy,
  recordScriptRun,
  recordSignal,
  reminderFor,
  resetMtimeCache,
  shouldBlock,
} from '../gates/policy.js';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const MINUTE = 60_000;

const withTmp = (fn) => async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gate-ai4s-'));
  try {
    resetMtimeCache();
    await fn(dir);
  } finally {
    resetMtimeCache();
    rmSync(dir, { recursive: true, force: true });
  }
};

/** An `exists`-only probe for the classifier: fingerprints are `stat`, not read. */
const memoryFs = (paths = []) => {
  const known = new Set(paths.map((p) => String(p).replace(/\\/g, '/')));
  return { exists: (p) => known.has(String(p).replace(/\\/g, '/')) };
};

const write = (file, content) => {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
  return file;
};

const ageFile = (file, ageMs) => {
  const at = new Date(Date.now() - ageMs);
  utimesSync(file, at, at);
};

/** A profile-shaped policy, inline, so no fixture files are needed. */
const ai4sPolicy = (dir, overrides = {}) => ({
  name: 'test-gate',
  version: 5,
  checks: ['no-secret-write'],
  reminder: 'BASE-RULES',
  default_profile: 'general-dev',
  profiles: {
    'ai4s-dry-lab': {
      name: 'ai4s-dry-lab',
      reminder: 'AI4S-RULES',
      fingerprints: [['docs/STATE.md', 'docs/WORKLOG.md']],
      keywords: { min_hits: 2, strong: ['单细胞', 'seurat'], weak: ['细胞', '聚类'] },
      checks: ['ai4s-worklog-before-run', 'ai4s-script-log-source'],
      config: {
        worklog_path: 'docs/WORKLOG.md',
        worklog_ttl_ms: 30 * MINUTE,
        result_dirs: ['results'],
        readme_prefix: 'README_',
        script_extensions: ['.R', '.py', '.ipynb'],
        log_required_extensions: ['.R', '.py'],
      },
    },
  },
  classifier: { enabled: true, model_judge: false },
  config: {
    project_roots: [dir],
    exclude_globs: [],
    require_target_evidence: false,
    require_chg_contract: false,
    require_conventions: false,
    ...overrides,
  },
});

/** A repository-shaped fixture with a fresh-or-stale Worklog and one R script. */
const ai4sRepo = (dir, { worklogAgeMs = 40 * MINUTE, scriptBody = 'sink("run.log")\n' } = {}) => {
  write(join(dir, 'docs', 'STATE.md'), '# state\n');
  const worklog = write(join(dir, 'docs', 'WORKLOG.md'), '# worklog\n');
  ageFile(worklog, worklogAgeMs);
  const script = write(join(dir, 'scripts', 'annotate.R'), scriptBody);
  return { worklog, script };
};

const bashRun = (script, cwd) => ({
  action: 'bash',
  path: null,
  tool: 'bash',
  command: `Rscript ${script}`,
  cwd,
});

// ---------------------------------------------------------------------------
// AC-1 / AC-2 / AC-7 — the classifier itself
// ---------------------------------------------------------------------------

test('AC-1: structural fingerprints decide the domain without asking a model', async () => {
  const root = join(REPO, '.fixture-ai4s');
  let modelCalls = 0;
  const result = await classify({
    cwd: root,
    prompt: '随便看看',
    fs: memoryFs([join(root, 'docs', 'STATE.md'), join(root, 'docs', 'WORKLOG.md')]),
    policy: {
      ...normalizePolicy(ai4sPolicy(root)),
      classifier: { enabled: true, model_judge: true, timeout_ms: 5000 },
    },
    modelHint: () => {
      modelCalls += 1;
      return 'ai4s-quant';
    },
  });

  assert.equal(result.profile, 'ai4s-dry-lab');
  assert.equal(result.source, 'fingerprint');
  assert.equal(modelCalls, 0, 'T0 must short-circuit before the model is asked');
});

test('AC-2: one weak keyword is a question, not a research session', async () => {
  const root = join(REPO, '.fixture-ai4s-empty');
  const result = await classify({
    cwd: root,
    // Exactly one strong term plus two weak ones: this is someone asking what a
    // technique is, and switching on Worklog rules here is the false positive
    // that gets a gate uninstalled.
    prompt: '什么是单细胞？细胞聚类一般看什么？',
    fs: memoryFs(),
    policy: normalizePolicy(ai4sPolicy(root)),
  });

  assert.equal(result.profile, 'general-dev');
  assert.equal(result.source, 'fallback');
});

test('AC-2b: two distinct strong keywords do decide the domain', async () => {
  const root = join(REPO, '.fixture-ai4s-two');
  const result = await classify({
    cwd: root,
    prompt: '用 Seurat 做单细胞注释，跑一下流程',
    fs: memoryFs(),
    policy: normalizePolicy(ai4sPolicy(root)),
  });

  assert.equal(result.profile, 'ai4s-dry-lab');
  assert.equal(result.source, 'keyword');
});

test('AC-7: a throwing judge degrades to general-dev instead of blocking', async () => {
  const root = join(REPO, '.fixture-ai4s-throw');
  const result = await classify({
    cwd: root,
    prompt: '做点分析',
    fs: memoryFs(),
    policy: {
      ...normalizePolicy(ai4sPolicy(root)),
      classifier: { enabled: true, model_judge: true, timeout_ms: 5000 },
    },
    modelHint: () => {
      throw new Error('provider exploded');
    },
  });

  assert.equal(result.profile, 'general-dev');
  assert.equal(result.source, 'fallback');
  assert.match(result.reason, /模型判定失败|降级/);
});

test('AC-7b: a hung judge times out into general-dev', async () => {
  const root = join(REPO, '.fixture-ai4s-hang');
  const result = await classify({
    cwd: root,
    prompt: '做点分析',
    fs: memoryFs(),
    policy: {
      ...normalizePolicy(ai4sPolicy(root)),
      classifier: { enabled: true, model_judge: true, timeout_ms: 20 },
    },
    modelHint: () => new Promise(() => {}), // never settles
  });

  assert.equal(result.profile, 'general-dev');
  assert.equal(result.source, 'fallback');
});

test('AC-7c: a judge naming a profile that does not exist is not trusted', async () => {
  const root = join(REPO, '.fixture-ai4s-bogus');
  const result = await classify({
    cwd: root,
    prompt: '做点分析',
    fs: memoryFs(),
    policy: {
      ...normalizePolicy(ai4sPolicy(root)),
      classifier: { enabled: true, model_judge: true, timeout_ms: 5000 },
    },
    modelHint: () => 'ai4s-imaginary',
  });

  assert.equal(result.profile, 'general-dev');
  assert.equal(result.source, 'fallback');
});

// ---------------------------------------------------------------------------
// AC-3 / AC-4 / AC-5 — the run-side checks
// ---------------------------------------------------------------------------

test('AC-3: a stale Worklog blocks the first analysis run, with guidance', withTmp(async (dir) => {
  const { script } = ai4sRepo(dir);
  const policy = profilePolicy(normalizePolicy(ai4sPolicy(dir)), 'ai4s-dry-lab');
  const state = newSessionState();

  const verdict = shouldBlock({ policy, input: bashRun(script, dir), state, fs: realFs });

  assert.equal(verdict.block, true);
  assert.equal(verdict.code, 'AI4S_WORKLOG');
  assert.match(verdict.reason, /WORKLOG|Worklog/);
  assert.match(verdict.reason, /先把这一轮要做的事写进 Worklog/);
}));

test('AC-4: a fresh Worklog lets the same run through', withTmp(async (dir) => {
  const { script } = ai4sRepo(dir, { worklogAgeMs: 1 * MINUTE });
  const policy = profilePolicy(normalizePolicy(ai4sPolicy(dir)), 'ai4s-dry-lab');

  const verdict = shouldBlock({
    policy,
    input: bashRun(script, dir),
    state: newSessionState(),
    fs: realFs,
  });

  assert.equal(verdict.block, false);
}));

test('AC-4b: only the first run of a script is judged', withTmp(async (dir) => {
  const { script } = ai4sRepo(dir);
  const policy = profilePolicy(normalizePolicy(ai4sPolicy(dir)), 'ai4s-dry-lab');
  const state = newSessionState();
  // Pretend this script already ran: a stepwise pipeline must not be interrupted
  // by a Worklog edit before every single step.
  //
  // Through `recordScriptRun`, not a raw map write: it normalizes the path, and
  // on Windows that folds case. A temp directory has mixed case, so a raw key
  // never matches the normalized lookup inside the check and the script is judged
  // as a first run — exactly how this test failed on windows-latest.
  recordScriptRun(state, script);

  const verdict = shouldBlock({ policy, input: bashRun(script, dir), state, fs: realFs });

  assert.equal(verdict.block, false);
}));

test('AC-5: a script with no log sink is blocked before it runs', withTmp(async (dir) => {
  const { script } = ai4sRepo(dir, {
    worklogAgeMs: 1 * MINUTE,
    scriptBody: 'counts <- read.csv("counts.csv")\nprint(head(counts))\n',
  });
  const policy = profilePolicy(normalizePolicy(ai4sPolicy(dir)), 'ai4s-dry-lab');

  const verdict = shouldBlock({
    policy,
    input: bashRun(script, dir),
    state: newSessionState(),
    fs: realFs,
  });

  assert.equal(verdict.block, true);
  assert.equal(verdict.code, 'AI4S_SCRIPT_LOG');
}));

test('AC-5b: reading a script is not running it', withTmp(async (dir) => {
  const { script } = ai4sRepo(dir, { scriptBody: 'print(1)\n' });
  const policy = profilePolicy(normalizePolicy(ai4sPolicy(dir)), 'ai4s-dry-lab');

  const verdict = shouldBlock({
    policy,
    input: { action: 'bash', path: null, tool: 'bash', command: `cat ${script}`, cwd: dir },
    state: newSessionState(),
    fs: realFs,
  });

  assert.equal(verdict.block, false, 'debugging the script must stay possible');
}));

test('AC-5c: a notebook is held to W1 but not to an external .log', withTmp(async (dir) => {
  write(join(dir, 'docs', 'STATE.md'), '# state\n');
  const worklog = write(join(dir, 'docs', 'WORKLOG.md'), '# worklog\n');
  ageFile(worklog, 40 * MINUTE);
  const notebook = write(join(dir, 'scripts', 'analyze.ipynb'), '{"cells":[]}');
  const policy = profilePolicy(normalizePolicy(ai4sPolicy(dir)), 'ai4s-dry-lab');

  const stale = shouldBlock({
    policy,
    input: bashRun(notebook, dir),
    state: newSessionState(),
    fs: realFs,
  });
  assert.equal(stale.code, 'AI4S_WORKLOG', 'a notebook still needs a fresh Worklog before it runs');

  ageFile(worklog, 1 * MINUTE);
  const fresh = shouldBlock({
    policy,
    input: bashRun(notebook, dir),
    state: newSessionState(),
    fs: realFs,
  });
  assert.equal(
    fresh.block,
    false,
    'an executed notebook keeps its own output; demanding a separate .log would misfire every run',
  );
}));

test('reminder: the domain text rides along with the base text, and only in that domain', () => {
  const root = join(REPO, '.fixture-reminder');
  const policy = normalizePolicy(ai4sPolicy(root));
  const state = newSessionState();
  const now = Date.now();

  const general = reminderFor(policy, state, now);
  assert.match(String(general), /BASE-RULES/);
  assert.doesNotMatch(
    String(general),
    /AI4S-RULES/,
    'a general-dev turn must not be told about Worklogs',
  );

  state.profile = 'ai4s-dry-lab';
  assert.match(reminderFor(policy, state, now), /AI4S-RULES/);

  // The domain text has to survive a graph query: "I already asked the graph" says
  // nothing about whether this run will leave a Worklog and a log file behind.
  recordSignal(state, now);
  const afterSignal = reminderFor(policy, state, now);
  assert.doesNotMatch(String(afterSignal), /BASE-RULES/, 'the base text is silenced by a fresh signal');
  assert.match(String(afterSignal), /AI4S-RULES/, 'the domain text is not');
});

// ---------------------------------------------------------------------------
// AC-6 — turn-end output findings
// ---------------------------------------------------------------------------

test('AC-6: a touched result directory without a note file is a finding', withTmp(async (dir) => {
  const { script } = ai4sRepo(dir, { worklogAgeMs: 1 * MINUTE });
  const run = join(dir, 'results', '20261104-run');
  write(join(run, 'umap.png'), 'png');

  const state = newSessionState();
  state.turnStart = Date.now() - 5 * MINUTE;
  recordScriptRun(state, script, Date.now() - 2 * MINUTE);
  write(`${script}.log`, 'ok\n');

  const policy = profilePolicy(normalizePolicy(ai4sPolicy(dir)), 'ai4s-dry-lab');
  const findings = outputArtifactFindings({ policy, state, fs: realFs, cwd: dir });

  assert.deepEqual(findings.map((f) => f.code), ['AI4S_RESULT_README']);
  assert.match(findings[0].reason, /README_/);
}));

test('AC-6b: the note file silences it, and an untouched directory is ignored', withTmp(async (dir) => {
  const { script } = ai4sRepo(dir, { worklogAgeMs: 1 * MINUTE });
  write(`${script}.log`, 'ok\n');
  write(join(dir, 'results', 'done-run', 'README_文件说明.md'), '# 说明\n');
  write(join(dir, 'results', 'done-run', 'plot.png'), 'png');
  write(join(dir, 'results', 'old-run', 'plot.png'), 'png');
  ageFile(join(dir, 'results', 'old-run', 'plot.png'), 3 * 60 * MINUTE);

  const state = newSessionState();
  state.turnStart = Date.now() - 5 * MINUTE;
  recordScriptRun(state, script, Date.now() - 2 * MINUTE);

  const policy = profilePolicy(normalizePolicy(ai4sPolicy(dir)), 'ai4s-dry-lab');
  assert.deepEqual(outputArtifactFindings({ policy, state, fs: realFs, cwd: dir }), []);
}));

test('AC-6c: a run without a log file is reported', withTmp(async (dir) => {
  const { script } = ai4sRepo(dir, { worklogAgeMs: 1 * MINUTE });
  const state = newSessionState();
  state.turnStart = Date.now() - 5 * MINUTE;
  recordScriptRun(state, script, Date.now() - 2 * MINUTE);

  const policy = profilePolicy(normalizePolicy(ai4sPolicy(dir)), 'ai4s-dry-lab');
  const findings = outputArtifactFindings({ policy, state, fs: realFs, cwd: dir });

  assert.deepEqual(findings.map((f) => f.code), ['AI4S_SCRIPT_LOG_MISSING']);
}));

test('AC-6d: no turn boundary means no judgement at all', withTmp(async (dir) => {
  ai4sRepo(dir);
  write(join(dir, 'results', 'anything', 'plot.png'), 'png');
  const state = newSessionState(); // turnStart stays 0
  const policy = profilePolicy(normalizePolicy(ai4sPolicy(dir)), 'ai4s-dry-lab');

  assert.deepEqual(outputArtifactFindings({ policy, state, fs: realFs, cwd: dir }), []);
}));

// ---------------------------------------------------------------------------
// AC-8 — general-dev is exactly the old behaviour
// ---------------------------------------------------------------------------

test('AC-8: the shipped policy keeps its base checks and adds the profile on top', () => {
  const loaded = loadPolicy(join(REPO, 'bridge', 'gates', 'pi', 'policy.json'));
  assert.equal(loaded.ok, true, `shipped policy must load: ${loaded.error}`);
  const policy = loaded.policy;

  // The base list is the v4 list, unchanged and in order.
  assert.deepEqual(activeChecks(policy, 'general-dev'), policy.checks);
  assert.deepEqual(activeChecks(policy, undefined), policy.checks);
  assert.deepEqual(activeChecks(policy, 'no-such-profile'), policy.checks);

  // profiles/ must load from disk (repo layout puts it one level up).
  assert.equal(policy.pendingProfiles.length, 0, 'profiles named in policy.json must resolve');
  assert.equal(policy.profiles.has('ai4s-dry-lab'), true);

  const withProfile = activeChecks(policy, 'ai4s-dry-lab');
  assert.deepEqual(withProfile.slice(0, policy.checks.length), policy.checks);
  assert.ok(withProfile.includes('ai4s-worklog-before-run'));
  assert.ok(withProfile.includes('ai4s-script-log-source'));
});

test('AC-8b: the dsh policy is the same shape and also resolves its profiles', () => {
  const loaded = loadPolicy(join(REPO, 'bridge', 'gates', 'dsh', 'policy.json'));
  assert.equal(loaded.ok, true, `shipped policy must load: ${loaded.error}`);
  assert.equal(loaded.policy.pendingProfiles.length, 0);
  assert.deepEqual(activeChecks(loaded.policy, 'general-dev'), loaded.policy.checks);
});

// ---------------------------------------------------------------------------
// AC-9 — both adapters honour the active profile
// ---------------------------------------------------------------------------

const makePi = () => {
  const handlers = {};
  return { handlers, on: (name, fn) => { handlers[name] = fn; } };
};

test('AC-9: the pi adapter classifies once per turn and applies the profile', withTmp(async (dir) => {
  const { script } = ai4sRepo(dir);
  const pi = makePi();
  enforceRules(pi, { policy: ai4sPolicy(dir) });
  await pi.handlers.session_start({}, { cwd: dir, hasUI: false });

  await pi.handlers.before_agent_start(
    { messageType: 'user', prompt: '帮我跑一下单细胞注释' },
    { cwd: dir, hasUI: false },
  );

  const denied = await pi.handlers.tool_call(
    { toolName: 'bash', input: { command: `Rscript ${script}` } },
    { cwd: dir, hasUI: false },
  );

  assert.equal(denied?.block, true);
  assert.match(denied.reason, /W1/);
}));

test('AC-9b: pi stays on general-dev when nothing identifies the domain', withTmp(async (dir) => {
  // Script only: no `docs/STATE.md` + `docs/WORKLOG.md`, and a prompt with no
  // strong keywords. This is the case where adding research rules would be pure
  // false-positive noise, so the same bash call must sail through.
  const script = write(join(dir, 'scripts', 'annotate.R'), 'sink("run.log")\n');
  const pi = makePi();
  enforceRules(pi, { policy: ai4sPolicy(dir) });
  await pi.handlers.session_start({}, { cwd: dir, hasUI: false });

  await pi.handlers.before_agent_start(
    { messageType: 'user', prompt: '看下这个仓库的测试怎么跑' },
    { cwd: dir, hasUI: false },
  );

  const allowed = await pi.handlers.tool_call(
    { toolName: 'bash', input: { command: `Rscript ${script}` } },
    { cwd: dir, hasUI: false },
  );

  assert.equal(allowed, undefined, 'general-dev must not gain research rules');
}));

test('AC-9c: pi asks for one more turn when a result directory has no note', withTmp(async (dir) => {
  const { script } = ai4sRepo(dir, { worklogAgeMs: 1 * MINUTE });

  const pi = makePi();
  enforceRules(pi, {
    policy: ai4sPolicy(dir, { slack_max_continues: 1 }),
  });
  await pi.handlers.session_start({}, { cwd: dir, hasUI: false });
  // The turn boundary: everything below is "this turn's work".
  await pi.handlers.before_agent_start(
    { messageType: 'user', prompt: '单细胞注释跑完了' },
    { cwd: dir, hasUI: false },
  );
  // Register the run through the adapter so `startedAt` lands after turnStart...
  await pi.handlers.tool_call(
    { toolName: 'bash', input: { command: `Rscript ${script}` } },
    { cwd: dir, hasUI: false },
  );
  // ...then let the run "produce" its output, in the order real life does. The
  // plot is written now (not before the turn) because an untouched directory is
  // deliberately not judged: only what this turn touched is this turn's problem.
  write(`${script}.log`, 'ok\n');
  write(join(dir, 'results', 'run-a', 'plot.png'), 'png');

  const event = {
    message: { role: 'assistant', content: [{ type: 'text', text: '跑完了，结果在 results/run-a。' }] },
    entries: [],
  };
  const first = await pi.handlers.turn_end(event, { cwd: dir, hasUI: false });
  assert.equal(first?.continue, true);
  assert.equal(first.entries.at(-1).customType, 'enforce-rules-ai4s-output');
  assert.match(first.entries.at(-1).content, /README_/);

  const second = await pi.handlers.turn_end(event, { cwd: dir, hasUI: false });
  assert.equal(second, undefined, 'bounded by slack_max_continues');
}));

test('AC-9d: the dsh adapter classifies lazily and applies the same profile', withTmp(async (dir) => {
  const { script } = ai4sRepo(dir);
  const handlers = {};
  const ctx = { logger: {}, on: (name, fn) => { handlers[name] = fn; } };
  dsh.apply(ctx, { policy: ai4sPolicy(dir) });

  const preExecute = handlers['tools/pre-execute'];
  const denied = await preExecute(
    { name: 'bash', arguments: { command: `Rscript ${script}` }, cwd: dir },
    () => 'next',
  );

  assert.equal(denied?.kind, 'deny');
  assert.match(denied.reason, /W1/);
}));

test('AC-9e: dsh stays on general-dev when the fingerprints are absent', withTmp(async (dir) => {
  // Same script, same command as AC-9d, but no `docs/STATE.md` + `docs/WORKLOG.md`
  // and no prompt for T1/T2 to read. This is the contrast case that proves the
  // denial above came from the classification and not from the bash path.
  const script = write(join(dir, 'scripts', 'annotate.R'), 'sink("run.log")\n');
  const handlers = {};
  const ctx = { logger: {}, on: (name, fn) => { handlers[name] = fn; } };
  dsh.apply(ctx, { policy: ai4sPolicy(dir) });

  const allowed = await handlers['tools/pre-execute'](
    { name: 'bash', arguments: { command: `Rscript ${script}` }, cwd: dir },
    () => 'next',
  );

  assert.equal(allowed, 'next', 'general-dev must not gain research rules');
}));
