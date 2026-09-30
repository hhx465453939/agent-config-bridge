/**
 * Tests for the model-metadata layer: the family table, the official-data
 * reader, and the two checks that compare a machine's copies against them.
 *
 * The bug these exist for is specific and repeatable: a 1M-context model
 * declared as 128K. pi reads `contextWindow` to decide when to compact, so an
 * understated value throws away context the model actually has — silently, with
 * no error anywhere. Two hand-maintained copies of those numbers live on the
 * machine (the custom-provider extension, and pi-smart-router's sticky catalog)
 * and neither is ever refreshed from the other.
 *
 * So the tests come in three layers, and all three matter:
 *
 *   1. the table matches pi's OWN shipped provider data — checked against the
 *      real files when they are present, so this table cannot quietly rot;
 *   2. the checks catch a wrong entry — driven by fixtures, so they run
 *      everywhere;
 *   3. doctor actually reports it, end-to-end, through the sandbox harness.
 *
 * Layer 1 is the one that would have caught the original defect, and it is the
 * one that most obviously cannot be replaced by a checked-in snapshot of the
 * numbers: a snapshot agrees with itself forever.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import * as api from '../lib/api.js';
import { withSandbox, write } from './sandbox.js';
import {
  FAMILY_META,
  FAMILY_PROBES,
  checkCatalog,
  checkFamilyAgainstOfficial,
  familyFor,
  guessModel,
  piAiDataDir,
  readCatalog,
  readOfficialModels,
} from '../lib/pi-models.js';

const quiet = { say() {}, info() {}, warn() {}, payload() {} };

// Where pi's own provider data lives on this machine, if pi is installed.
const HOME = process.env.HOME ?? '';
const OFFICIAL_DIR = piAiDataDir(HOME);
const OFFICIAL = readOfficialModels(OFFICIAL_DIR);
// Probed rather than assumed: a skip here is visible in the test output, and a
// green run on a machine without pi is not evidence the table is right.
const HAS_OFFICIAL = OFFICIAL !== null;

// ---------------------------------------------------------------------------
// the family table
// ---------------------------------------------------------------------------

test('models: every family rule carries a citable source', () => {
  assert.ok(FAMILY_META.length > 0);
  for (const family of FAMILY_META) {
    assert.equal(typeof family.id, 'string', `${family.id}: id`);
    assert.ok(family.re instanceof RegExp, `${family.id}: regex`);
    assert.ok(Number.isInteger(family.contextWindow) && family.contextWindow > 0, `${family.id}: contextWindow`);
    // null is a legitimate value — "sources disagree, so we assert nothing" —
    // and is the whole reason the opus rule can be honest about its maxTokens.
    assert.ok(
      family.maxTokens === null || (Number.isInteger(family.maxTokens) && family.maxTokens > 0),
      `${family.id}: maxTokens must be a positive integer or null`,
    );
    // A number without a citation is a guess wearing a table's clothes. This
    // assertion is the reason they all have one.
    assert.match(family.source, /pi-ai\/dist\/providers\/data\//, `${family.id}: source must cite pi's data`);
  }
  const ids = FAMILY_META.map((f) => f.id);
  assert.equal(new Set(ids).size, ids.length, 'family ids must be unique');
});

test('models: rules are ordered so the first match is the most specific', () => {
  // First-match-wins is the contract. If a broad rule is placed before a narrow
  // one it shadows it, and nothing else would notice. Assert the ordering
  // property that actually matters: no rule earlier in the list also matches a
  // later rule's own probe id.
  for (let i = 0; i < FAMILY_META.length; i += 1) {
    for (let j = i + 1; j < FAMILY_META.length; j += 1) {
      const probe = FAMILY_PROBES.find((p) => p.family === FAMILY_META[j].id);
      if (!probe) continue;
      for (const id of probe.ids) {
        const matched = FAMILY_META.find((f) => f.re.test(id.toLowerCase()));
        assert.equal(
          matched.id,
          FAMILY_META[j].id,
          `"${id}" belongs to ${FAMILY_META[j].id} but is shadowed by the earlier rule ${matched.id}`,
        );
      }
    }
  }
});

test('models: the near misses stay out of their family', () => {
  // Each of these is one character away from a rule that would overstate it.
  // They are the exact ids a sloppy prefix would swallow.
  const expected = [
    ['deepseek-v4-flash', 'deepseek-v4'],
    ['deepseek-v4.1-flash', 'deepseek-v4'],
    ['deepseek-v4-flash-0731', 'deepseek-v4'],
    ['deepseek-v4-flash-vision-exp', 'deepseek-v4'],
    ['DeepSeek-V4-Pro', 'deepseek-v4'],
    ['glm-5.2', 'glm-5.2+'],
    ['glm-5.3-flash', 'glm-5.2+'],
    ['glm-5.3-highspeed', 'glm-5.2+'],
    ['kimi-k3', 'kimi-k3'],
    ['claude-opus-4-7', 'claude-opus-4.6+'],
    ['claude-opus-4.7', 'claude-opus-4.6+'],
    ['claude-opus-5-5', 'claude-opus-4.6+'],
  ];
  for (const [id, familyId] of expected) {
    assert.equal(familyFor(id)?.id, familyId, `${id} should be in ${familyId}`);
  }

  // ...and the ones that must NOT match.
  const notIn = [
    ['glm-5.1', 'glm-5.2+'],        // 200K, not 1M — the jump is at 5.2
    ['glm-5-turbo', 'glm-5.2+'],    // 200K
    ['kimi-k3-256k', 'kimi-k3'],    // same model, deliberately sold at 256K
    ['claude-opus-4-5', 'claude-opus-4.6+'], // 200K
    ['claude-opus-4.5', 'claude-opus-4.6+'],
    ['claude-sonnet-5', 'claude-opus-4.6+'], // different line entirely
    ['deepseek-v3.2', 'deepseek-v4'],
  ];
  for (const [id, familyId] of notIn) {
    assert.notEqual(
      familyFor(id)?.id,
      familyId,
      `${id} must not match ${familyId} (it would overstate its context window)`,
    );
  }
});

test('models: kimi-k3-256k is a narrower window than kimi-k3', () => {
  // The negative lookahead exists for this one pair. Assert the intent, not the
  // regex: the 256K variant must be the smaller of the two.
  const full = familyFor('kimi-k3');
  const narrow = familyFor('kimi-k3-256k');
  assert.ok(full && narrow);
  assert.ok(
    narrow.contextWindow < full.contextWindow,
    `k3-256k (${narrow.contextWindow}) must be smaller than k3 (${full.contextWindow})`,
  );
});

// ---------------------------------------------------------------------------
// the table against pi's own data — the check that cannot be faked
// ---------------------------------------------------------------------------

test(
  'models: the family table agrees with the provider data pi actually ships',
  { skip: HAS_OFFICIAL ? false : `no pi provider data at ${OFFICIAL_DIR}` },
  () => {
    const findings = checkFamilyAgainstOfficial(OFFICIAL);
    assert.deepEqual(
      findings,
      [],
      `family table drifted from pi's shipped data:\n${findings.map((f) => `  ${f.file}: ${f.message}`).join('\n')}`,
    );
  },
);

test('models: a disagreement with pi data is reported with both numbers', () => {
  // Build a deliberately wrong index and prove the check fires. Without this,
  // the test above could pass because the check never runs at all.
  const index = new Map([
    ['deepseek-v4-flash', { id: 'deepseek-v4-flash', contextWindows: new Set([131_072]), maxTokens: new Set([384_000]), sources: new Set(['deepseek']) }],
  ]);
  const findings = checkFamilyAgainstOfficial(index, [
    { family: 'deepseek-v4', file: 'deepseek.json', ids: ['deepseek-v4-flash'] },
  ]);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].code, 'FAMILY_TABLE_STALE');
  assert.match(findings[0].message, /1000000/);
  assert.match(findings[0].message, /131072/);
});

test('models: a probed id pi no longer ships is reported', () => {
  const findings = checkFamilyAgainstOfficial(new Map(), [
    { family: 'deepseek-v4', file: 'deepseek.json', ids: ['deepseek-v4-flash'] },
  ]);
  assert.equal(findings.length, 1);
  assert.match(findings[0].message, /does not list it/);
});

test('models: a probe naming a family that was renamed is reported', () => {
  const findings = checkFamilyAgainstOfficial(new Map(), [
    { family: 'no-such-family', file: 'x.json', ids: ['y'] },
  ]);
  assert.equal(findings.length, 1);
  assert.match(findings[0].message, /no longer exists/);
});

test('models: missing pi data is "unknown", never "no problems"', () => {
  // The distinction matters: returning [] would render the check above
  // vacuously green on a machine where it provably did not run.
  const findings = checkFamilyAgainstOfficial(null);
  assert.equal(findings.length, 1);
  assert.match(findings[0].message, /could NOT be verified/);
});

test('models: a null maxTokens means "sources disagree", and asserts nothing', () => {
  // pi's shipped anthropic.json says claude-opus-5 caps output at 64,000 while
  // the local models-store says 128,000. Inventing a winner would be exactly
  // the kind of unearned authority this table exists to avoid, so the rule
  // states only the window and stays silent on output.
  const opus = familyFor('claude-opus-5');
  assert.equal(opus.maxTokens, null);
  assert.equal(opus.contextWindow, 1_000_000);
  // An unasserted rule must fall through to the caller's own default rather
  // than inject a null into a numeric field.
  const g = guessModel('claude-opus-5');
  assert.equal(g.maxTokens, 65_536);
  assert.equal(g.contextWindow, 1_000_000);
});

test('models: the official reader indexes every transport of every provider file', () => {
  const index = readOfficialModels(OFFICIAL_DIR);
  if (!index) return; // covered by the skip above
  const k3 = index.get('kimi-k3');
  assert.ok(k3, 'kimi-k3 should be indexed');
  assert.ok(k3.contextWindows.has(1_048_576));
  // Seen in more than one provider file, and that provenance is kept: a model
  // two sources describe differently is a fact worth surfacing.
  assert.ok(k3.sources.size >= 1);
  // Keys are lowercased so `.has()` answers the same question for either
  // spelling. The original casing must NOT be a key, or lookups would be
  // case-sensitive and half of them would silently miss.
  assert.equal(index.has('deepseek-v4-pro'), true);
  assert.equal(index.has('DeepSeek-V4-Pro'), false);
});

test('models: the reader tolerates a missing directory and unparsable files', () => {
  assert.equal(readOfficialModels(join(HOME, '.pi', 'agent', 'no-such-dir-xyz')), null);
});

// ---------------------------------------------------------------------------
// guessModel precedence
// ---------------------------------------------------------------------------

test('models: an explicit declaration outranks the family rule', () => {
  // The point of `declared` is that a human wrote a value for this exact id.
  const g = guessModel('deepseek-v4-flash', { contextWindow: 999_999, maxTokens: 1_234 });
  assert.equal(g.contextWindow, 999_999);
  assert.equal(g.maxTokens, 1_234);
});

test('models: the family rule outranks a bare heuristic', () => {
  const g = guessModel('deepseek-v4-flash');
  assert.equal(g.contextWindow, 1_000_000);
  assert.equal(g.maxTokens, 384_000);
  assert.equal(g.family, 'deepseek-v4');
});

test('models: an unknown id falls back to a conservative, flagged default', () => {
  const g = guessModel('mystery-model-3');
  assert.equal(g.contextWindow, 128_000);
  assert.equal(g.family, null, 'a guessed model must not claim a family it did not match');
});

test('models: the heuristic branches are preserved for unlisted ids', () => {
  assert.equal(guessModel('something[1m]').contextWindow, 1_000_000);
  assert.equal(guessModel('gpt-5.6-luna-unknown').contextWindow, 272_000);
  assert.equal(guessModel('kimi-something-new').contextWindow, 262_144);
  // maxTokens follows the window when nothing cites it.
  assert.equal(guessModel('something[1m]').maxTokens, 65_536);
  assert.equal(guessModel('kimi-something-new').maxTokens, 32_768);
});

test('models: vision ids are not flagged as reasoning models', () => {
  assert.equal(guessModel('deepseek-v4-flash').reasoning, true);
  assert.equal(guessModel('deepseek-v4-flash-vision-exp').reasoning, false);
  assert.deepEqual(guessModel('deepseek-v4-flash-vision-exp').input, ['text', 'image']);
});

// ---------------------------------------------------------------------------
// the catalog check
// ---------------------------------------------------------------------------

const entry = (selector, contextWindow) => ({
  selector,
  provider: selector.split('/')[0],
  contextWindow,
  cost: { input: 0, output: 0, cacheRead: 0 },
  input: ['text'],
  scenarios: [],
  learnScore: {},
  samples: {},
  lastSeen: 1,
});

test('catalog: a stale context window is reported with the expected value', () => {
  const findings = checkCatalog([entry('shudie/deepseek-v4-flash-0731', 128_000)]);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].code, 'CATALOG_CONTEXT_STALE');
  assert.equal(findings[0].level, 'warn');
  assert.equal(findings[0].actual, 128_000);
  assert.equal(findings[0].expected, 1_000_000);
  assert.match(findings[0].message, /family "deepseek-v4"/);
});

test('catalog: a correct entry is silent', () => {
  assert.deepEqual(checkCatalog([entry('shudie/deepseek-v4-flash', 1_000_000)]), []);
  assert.deepEqual(checkCatalog([entry('shudie/glm-5.3', 1_000_000)]), []);
});

test('catalog: an id with no family is only judged against pi data', () => {
  // No family rule and no official entry: we have no opinion, so we say
  // nothing. Warning here would flag every reseller model on the machine.
  assert.deepEqual(checkCatalog([entry('shudie/qwen3.7-flash', 128_000)]), []);

  const official = new Map([
    ['qwen3.7-flash', { id: 'qwen3.7-flash', contextWindows: new Set([1_000_000]), maxTokens: new Set([65_536]), sources: new Set(['qwen-token-plan-cn']) }],
  ]);
  const findings = checkCatalog([entry('shudie/qwen3.7-flash', 128_000)], { official });
  assert.equal(findings.length, 1);
  assert.deepEqual(findings[0].expected, [1_000_000]);
  assert.match(findings[0].message, /qwen-token-plan-cn/);
});

test('catalog: the family rule wins over official data (one finding, not two)', () => {
  // pi ships several providers' numbers for the same id. When our table has a
  // cited rule it is the stronger statement, and reporting the same entry twice
  // would just be noise.
  const official = new Map([
    ['glm-5.3', { id: 'glm-5.3', contextWindows: new Set([999]), maxTokens: new Set([1]), sources: new Set(['zai-coding-cn']) }],
  ]);
  const findings = checkCatalog([entry('shudie/glm-5.3', 128_000)], { official });
  assert.equal(findings.length, 1);
  assert.match(findings[0].message, /family "glm-5.2\+"/);
});

test('catalog: a case-duplicate selector is reported', () => {
  // pi-smart-router builds its index by lowercasing the selector, so the second
  // entry silently replaces the first. Real machines have this: two spellings
  // of the same model, one of them unreachable.
  const findings = checkCatalog([
    entry('shudie/DeepSeek-V4-Pro', 1_000_000),
    entry('shudie/deepseek-v4-pro', 1_000_000),
  ]);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].code, 'CATALOG_DUPLICATE_SELECTOR');
  assert.match(findings[0].message, /lowercase selector/);
});

test('catalog: an invalid or absent context window is reported', () => {
  const bad = checkCatalog([entry('shudie/mystery', 0)]);
  assert.equal(bad.length, 1);
  assert.equal(bad[0].code, 'CATALOG_CONTEXT_INVALID');
  const missing = checkCatalog([{ selector: 'shudie/mystery' }]);
  assert.equal(missing.length, 1);
  assert.equal(missing[0].code, 'CATALOG_CONTEXT_INVALID');
});

test('catalog: a malformed selector is reported rather than thrown on', () => {
  const findings = checkCatalog([{ selector: 'no-slash', contextWindow: 1 }, {}]);
  assert.equal(findings.length, 2);
  assert.ok(findings.every((f) => f.code === 'CATALOG_SELECTOR'));
});

test('catalog: a non-array catalog is an error, not a crash', () => {
  const findings = checkCatalog({ not: 'an array' });
  assert.equal(findings.length, 1);
  assert.equal(findings[0].level, 'error');
  assert.equal(findings[0].code, 'CATALOG_UNREADABLE');
});

test('catalog: a case-differing id still resolves its family rule', () => {
  const findings = checkCatalog([
    entry('shudie/deepseek-v4-flash-0731', 128_000),
    entry('shudie/DeepSeek-V4-Flash-Vision-Exp', 128_000),
    entry('shudie/GLM-5.3-Flash', 128_000),
  ]);
  assert.equal(findings.length, 3);
  assert.ok(findings.every((f) => f.code === 'CATALOG_CONTEXT_STALE'));
});

// ---------------------------------------------------------------------------
// file reading
// ---------------------------------------------------------------------------

test('catalog: readCatalog distinguishes absent from unreadable', async () => {
  await withSandbox({}, (sb) => {
    const absent = join(sb.home, 'nope.json');
    assert.equal(readCatalog(absent), null);

    const broken = join(sb.home, 'broken.json');
    write(broken, '{ not json');
    assert.equal(readCatalog(broken), undefined, 'present-but-broken is not the same as absent');

    const good = join(sb.home, 'good.json');
    write(good, `${JSON.stringify([entry('shudie/glm-5.3', 1_000_000)])}\n`);
    assert.equal(readCatalog(good).length, 1);
  });
});

// ---------------------------------------------------------------------------
// end to end through doctor
// ---------------------------------------------------------------------------

const catalogFile = (sb) => join(sb.home, '.pi', 'agent', 'pi-router-catalog.json');

test('doctor: reports stale context windows in a bridged target’s catalog', async () => {
  await withSandbox({}, (sb) => {
    api.adopt({ repo: sb.repo, home: sb.home, names: ['pi'], log: quiet });

    write(
      catalogFile(sb),
      `${JSON.stringify(
        [
          entry('shudie/deepseek-v4-flash', 1_000_000), // correct — must stay silent
          entry('shudie/deepseek-v4-flash-0731', 128_000), // stale
          entry('shudie/glm-5.3', 128_000), // stale
        ],
        null,
        2,
      )}\n`,
    );

    const report = api.doctor({ repo: sb.repo, home: sb.home });
    const stale = report.findings.filter((f) => f.code === 'PI_CATALOG_CONTEXT_STALE');
    assert.equal(stale.length, 2, `expected 2 stale findings, got ${JSON.stringify(report.findings)}`);
    assert.ok(stale.every((f) => f.level === 'warn'));
    assert.deepEqual(
      stale.map((f) => f.selector).sort(),
      ['shudie/deepseek-v4-flash-0731', 'shudie/glm-5.3'],
    );
    // The correct entry must not be reported.
    assert.equal(stale.some((f) => f.selector === 'shudie/deepseek-v4-flash'), false);
    // A warning, so plain doctor still exits 0; --strict is the CI gate.
    assert.equal(report.ok, true);
    assert.equal(api.doctor({ repo: sb.repo, home: sb.home, strict: true }).ok, false);
    // And the hint must say why it will not heal by itself.
    assert.match(stale[0].hint, /sticky/);
  });
});

test('doctor: stays quiet when there is no catalog at all', async () => {
  await withSandbox({}, (sb) => {
    api.adopt({ repo: sb.repo, home: sb.home, names: ['pi'], log: quiet });
    const report = api.doctor({ repo: sb.repo, home: sb.home });
    assert.equal(report.findings.some((f) => f.code.startsWith('PI_CATALOG')), false);
  });
});

test('doctor: an unparsable catalog is reported, not ignored', async () => {
  await withSandbox({}, (sb) => {
    api.adopt({ repo: sb.repo, home: sb.home, names: ['pi'], log: quiet });
    write(catalogFile(sb), '{ this is not json');
    const report = api.doctor({ repo: sb.repo, home: sb.home });
    assert.ok(report.findings.some((f) => f.code === 'PI_CATALOG_UNREADABLE'));
  });
});

test('doctor: the context-window check writes nothing', async () => {
  await withSandbox({}, (sb) => {
    api.adopt({ repo: sb.repo, home: sb.home, names: ['pi'], log: quiet });
    const body = `${JSON.stringify([entry('shudie/glm-5.3', 128_000)], null, 2)}\n`;
    write(catalogFile(sb), body);

    const before = readCatalog(catalogFile(sb));
    api.doctor({ repo: sb.repo, home: sb.home });
    const after = readCatalog(catalogFile(sb));

    // The bridge does not own these files and must not rewrite them to match a
    // table shipped in a public repository — it reports, the user decides.
    assert.deepEqual(after, before);
    assert.equal(existsSync(catalogFile(sb)), true);
  });
});
