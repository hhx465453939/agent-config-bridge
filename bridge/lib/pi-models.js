/**
 * Authoritative context-window metadata for pi model families, plus the checks
 * that keep a machine's own pi configuration honest against it.
 *
 * WHY THIS FILE EXISTS
 *
 * `contextWindow` is not a cosmetic label in pi. pi reads it to budget the
 * conversation and to decide when to compact (`DEFAULT_COMPACTION_SETTINGS`),
 * so an understated value silently throws away context a model actually has,
 * and an overstated one turns an ordinary turn into a provider-side error.
 *
 * pi normally learns it from the provider: `pi-ai` ships one JSON file per
 * provider under `dist/providers/data/`. That mechanism has two holes, and both
 * of them are live on a machine that talks to a gateway:
 *
 *   1. A CUSTOM gateway is not one of pi's shipped providers, so there is no
 *      data file for it. Its `extension.ts` has to declare context windows by
 *      hand — and the gateway's own `/v1/models` returns only ids, no metadata,
 *      so there is nothing to read them from. Whatever the extension says is
 *      the only truth pi ever sees.
 *   2. `pi-router-catalog.json` (pi-smart-router) stores its own copy, and its
 *      merge is STICKY — `existing?.contextWindow ?? info.contextWindow` — so a
 *      value written once is never refreshed from anything. A stale number
 *      stays stale forever. The store is not in a source-of-truth chain; it is
 *      a cache with no invalidation.
 *
 * Both are copies of the same facts, maintained by hand, in files that never
 * talk to each other. That is the defect this module addresses: it holds ONE
 * table, derived from pi's own shipped data, and a `doctor` check that reports
 * every place a machine's copy disagrees with it.
 *
 * WHAT IT DELIBERATELY DOES NOT DO
 *
 * It does not rewrite those files. One of them (`extension.ts`) is a program,
 * and the other is pi-smart-router's private state. Rewriting a user's files to
 * match a table shipped in a public repository is exactly the kind of silent
 * authority this project refuses elsewhere. `doctor` reports; the user decides.
 *
 * It also carries NO gateway hostname. The rules below are keyed on MODEL ID
 * PREFIXES only, which is all the classification needs — a family is a family
 * regardless of who resells it.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const MB = 1000 * 1000;
const MiB = 1024 * 1024;

/**
 * Family metadata, keyed by model-id prefix.
 *
 * ORDER MATTERS: the first match wins, so keep the most specific rule first.
 *
 * `source` names where the numbers come from. Nothing here is guessed — a rule
 * without a citation does not belong in this table.
 *
 * `maxTokens: null` means "sources disagree, so this table asserts nothing".
 * That is a deliberate value, not a missing one: pi's shipped `anthropic.json`
 * says `claude-opus-5` caps output at 64,000 while the local `models-store.json`
 * says 128,000. Picking one would be inventing authority this table does not
 * have, so it declines to state a number and lets the caller fall back. A check
 * that asserts less than it can prove is worth more than one that asserts a
 * coin flip.
 *
 * Known, deliberate divergences from a naive reading of the official data, both
 * recorded so a future reader does not "fix" them:
 *
 *   · `claude-opus-4-5` is EXCLUDED even though the rule below starts at 4.6.
 *     Opus 4.5 really is 200K; only 4.6 onward jumped to 1M. A `^claude-opus-4`
 *     prefix (the obvious reading) would have overstated it fivefold.
 *   · `glm-5.1` is 202,752 (200K), not 1M. GLM 5.2 is where the jump happens,
 *     hence the literal dot in `glm-5.` rather than a bare `glm-5`.
 *   · `kimi-` is OPTIONAL in the k3 rules. pi's own provider file lists the
 *     model as `k3` / `k3-256k`, while every gateway resells it as `kimi-k3` /
 *     `kimi-k3-256k`. They are one model under two names, and a rule written
 *     for either spelling silently misses the other.
 */
export const FAMILY_META = [
  {
    id: 'deepseek-v4',
    re: /^deepseek-v4/,
    contextWindow: MB,
    maxTokens: 384_000,
    source: 'pi-ai/dist/providers/data/deepseek.json (deepseek-v4-flash, -flash-vision-exp, -pro)',
  },
  {
    id: 'glm-5.2+',
    re: /^glm-5\.[2-9]/,
    contextWindow: MB,
    maxTokens: 131_072,
    source: 'pi-ai/dist/providers/data/zai-coding-cn.json + qwen-token-plan-cn.json (glm-5.2, glm-5.3, …)',
  },
  {
    id: 'kimi-k3-256k',
    re: /^(?:kimi-)?k3-256k/,
    contextWindow: 262_144,
    maxTokens: 131_072,
    source: 'pi-ai/dist/providers/data/kimi-coding.json (k3-256k)',
  },
  {
    id: 'kimi-k3',
    re: /^(?:kimi-)?k3(?!-256k)/,
    contextWindow: MiB,
    maxTokens: 131_072,
    // The negative lookahead matters: `k3-256k` is the SAME model sold with a
    // 256K window and is a separately-listed id. Swallowing it would overstate
    // its window fourfold.
    source: 'pi-ai/dist/providers/data/moonshotai.json + kimi-coding.json (kimi-k3)',
  },
  {
    id: 'claude-opus-4.6+',
    re: /^claude-opus-(?:4[-.][6-9]|5)/,
    contextWindow: MB,
    maxTokens: null,
    // Dash or dot: gateways routinely spell an Anthropic id `claude-opus-4-7`
    // where the official name is `claude-opus-4.7`. Accepting only one form is
    // how this rule once silently missed every model it was written for.
    source: 'pi-ai/dist/providers/data/anthropic.json (claude-opus-4-6, -4-7, -4-8, -5) — window only',
  },
];

/** pi's own shipped provider data, derived from home (never hard-coded absolute). */
export const piAiDataDir = (home) =>
  join(
    home,
    '.npm-global',
    'lib',
    'node_modules',
    '@earendil-works',
    'pi-coding-agent',
    'node_modules',
    '@earendil-works',
    'pi-ai',
    'dist',
    'providers',
    'data',
  );

/**
 * Read pi's shipped provider data into `id -> {contextWindow, maxTokens, sources}`.
 *
 * The files are keyed by transport (`{"openai-completions": {"<id>": {...}}}`),
 * so the walk is two levels deep. The same model id can appear under several
 * transports with the same numbers; `sources` records every file it was seen in
 * so a finding can cite one.
 *
 * Values that disagree across files are kept as a set, not silently collapsed:
 * a model pi itself describes two ways is a fact worth surfacing, not resolving.
 *
 * Returns `null` when the directory is absent (pi not installed, or a different
 * layout) — the caller must treat that as "unknown", never as "no problems".
 */
export const readOfficialModels = (dir) => {
  if (!existsSync(dir)) return null;
  const index = new Map();
  for (const file of readdirSync(dir)) {
    if (!file.endsWith('.json')) continue;
    let parsed;
    try {
      parsed = JSON.parse(readFileSync(join(dir, file), 'utf8'));
    } catch {
      continue; // a provider file we cannot parse tells us nothing; skip it
    }
    if (!parsed || typeof parsed !== 'object') continue;
    for (const models of Object.values(parsed)) {
      if (!models || typeof models !== 'object') continue;
      for (const [id, def] of Object.entries(models)) {
        if (!def || typeof def !== 'object') continue;
        const contextWindow = def.contextWindow;
        const maxTokens = def.maxTokens ?? def.maxOutputTokens;
        if (typeof contextWindow !== 'number') continue;
        const key = id.toLowerCase();
        const seen = index.get(key) ?? { id, contextWindows: new Set(), maxTokens: new Set(), sources: new Set() };
        seen.contextWindows.add(contextWindow);
        if (typeof maxTokens === 'number') seen.maxTokens.add(maxTokens);
        seen.sources.add(file.replace(/\.json$/, ''));
        index.set(key, seen);
      }
    }
  }
  return index;
};

/** The family rule that matches this id, or null. */
export const familyFor = (id) => {
  if (typeof id !== 'string' || id.length === 0) return null;
  const lower = id.toLowerCase();
  return FAMILY_META.find((f) => f.re.test(lower)) ?? null;
};

/**
 * Best-effort metadata for an id that no static table covers.
 *
 * Precedence, strongest source first — and this ordering is the whole contract:
 *
 *   1. `declared` — a value someone wrote down for this exact id. An explicit
 *      statement always outranks a pattern; this function has no business
 *      second-guessing one.
 *   2. a cited FAMILY_META rule.
 *   3. a conservative heuristic, used ONLY for an id neither of the above
 *      covers. Every branch here is a number nobody can cite, which is why
 *      there are so few of them and why they never override 1 or 2.
 *
 * The return value carries `family` so a caller (and the tests) can tell a
 * cited answer from a guess — "which of these did we actually know?" is the
 * question that makes a registry auditable.
 */
export const guessModel = (id, declared = {}) => {
  const lower = typeof id === 'string' ? id.toLowerCase() : '';
  const family = familyFor(id);

  let contextWindow = declared.contextWindow ?? family?.contextWindow;
  if (contextWindow === undefined) {
    if (lower.includes('[1m]')) contextWindow = MB;
    else if (lower.includes('gpt-5.6')) contextWindow = 272_000;
    else if (lower.includes('kimi')) contextWindow = 262_144;
    else contextWindow = 128_000;
  }

  const maxTokens =
    declared.maxTokens ?? family?.maxTokens ?? (contextWindow >= 500_000 ? 65_536 : 32_768);
  const reasoning =
    /deepseek|kimi|gpt-5|glm|qwen3|minimax|grok/.test(lower) && !/vl|vision/.test(lower);
  const input = /gpt-5|gpt-4o|claude|gemini|vl|vision/.test(lower) ? ['text', 'image'] : ['text'];

  return {
    id,
    reasoning: declared.reasoning ?? reasoning,
    input: declared.input ?? input,
    contextWindow,
    maxTokens,
    family: family?.id ?? null,
  };
};

/**
 * Which `pi-ai` provider files must agree with each family rule.
 *
 * Used by the test suite to prove the table still tracks pi's shipped data
 * rather than a snapshot of it. Absent files are reported as missing, not
 * tolerated: a renamed provider file is exactly how this table would rot
 * unnoticed, and "the check silently stopped running" is the failure mode this
 * whole repository exists to prevent.
 */
export const FAMILY_PROBES = [
  { family: 'deepseek-v4', file: 'deepseek.json', ids: ['deepseek-v4-flash', 'deepseek-v4-pro'] },
  { family: 'glm-5.2+', file: 'zai-coding-cn.json', ids: ['glm-5.2', 'glm-5.3', 'glm-5.3-flash'] },
  // Both spellings are probed: pi ships `k3`/`k3-256k`, gateways say `kimi-k3`.
  // They are the same models, and a rule that only covers one name is a rule
  // that quietly stops applying to half the machine.
  { family: 'kimi-k3', file: 'moonshotai.json', ids: ['kimi-k3', 'k3'] },
  { family: 'kimi-k3-256k', file: 'kimi-coding.json', ids: ['k3-256k'] },
  { family: 'claude-opus-4.6+', file: 'anthropic.json', ids: ['claude-opus-4-7', 'claude-opus-4-8'] },
];

/**
 * Compare one family rule against the entries pi ships, in either direction for
 * a family's own ids — a shipped id whose family rule disagrees is a finding,
 * and so is an id the rule claims but pi does not list.
 *
 * Pure: takes the index, returns findings. No filesystem access, so the test
 * suite can drive it against both a fixture and the real machine.
 */
export const checkFamilyAgainstOfficial = (index, probes = FAMILY_PROBES) => {
  const findings = [];
  const add = (file, message) => findings.push({ code: 'FAMILY_TABLE_STALE', file, message });
  if (!index) {
    add('(pi-ai provider data)', 'provider data not found — family table could NOT be verified against pi');
    return findings;
  }

  for (const probe of probes) {
    const family = FAMILY_META.find((f) => f.id === probe.family);
    if (!family) {
      add(probe.file, `family rule "${probe.family}" no longer exists in FAMILY_META`);
      continue;
    }
    for (const id of probe.ids) {
      const official = index.get(id.toLowerCase());
      if (!official) {
        add(probe.file, `${id} is probed but pi's ${probe.file} does not list it`);
        continue;
      }
      for (const value of official.contextWindows) {
        if (value !== family.contextWindow) {
          add(
            probe.file,
            `${id}: family "${family.id}" says ${family.contextWindow}, pi ships ${value}`,
          );
        }
      }
      for (const value of official.maxTokens) {
        // A null rule asserts nothing. Comparing it would make every model whose
        // output cap two sources disagree on look like drift.
        if (family.maxTokens === null) continue;
        if (family.maxTokens !== value) {
          add(
            probe.file,
            `${id}: family "${family.id}" says maxTokens ${family.maxTokens}, pi ships ${value}`,
          );
        }
      }
    }
  }
  return findings;
};

/**
 * Check a `pi-router-catalog.json` against the family table and the official
 * data, and report every entry that disagrees.
 *
 * `official` is the index from `readOfficialModels`, or null. Both are worth
 * consulting because they answer different questions:
 *
 *   · the family table catches a stale value for a known family
 *   · the official index catches a stale value for a model the family table
 *     does not cover, and covers the case where pi ships numbers this table
 *     does not encode at all
 *
 * An entry is only reported when BOTH a source disagrees AND the entry is not
 * already equal to it — never on "we have no opinion", which would turn every
 * unlisted reseller model into a warning.
 */
export const checkCatalog = (entries, { official = null } = {}) => {
  const findings = [];
  if (!Array.isArray(entries)) {
    findings.push({ level: 'error', code: 'CATALOG_UNREADABLE', message: 'catalog is not a JSON array' });
    return findings;
  }

  const seen = new Set();
  for (const entry of entries) {
    const selector = entry?.selector;
    if (typeof selector !== 'string' || !selector.includes('/')) {
      findings.push({ level: 'warn', code: 'CATALOG_SELECTOR', message: `entry without a provider/model selector: ${JSON.stringify(selector)}` });
      continue;
    }
    const key = selector.toLowerCase();
    if (seen.has(key)) {
      findings.push({
        level: 'warn',
        code: 'CATALOG_DUPLICATE_SELECTOR',
        selector,
        message: `${selector} appears more than once; the loader keys by lowercase selector, so all but the last are silently unreachable`,
      });
    }
    seen.add(key);

    const actual = entry.contextWindow;
    const [, modelId] = [selector.slice(0, selector.indexOf('/')), selector.slice(selector.indexOf('/') + 1)];

    const family = familyFor(modelId);
    if (family && typeof actual === 'number' && actual !== family.contextWindow) {
      findings.push({
        level: 'warn',
        code: 'CATALOG_CONTEXT_STALE',
        selector,
        expected: family.contextWindow,
        actual,
        source: family.source,
        message: `${selector}: contextWindow ${actual} but family "${family.id}" is ${family.contextWindow} (${family.source})`,
      });
      continue; // one finding per entry; the family rule is the stronger statement
    }

    const off = official?.get(modelId.toLowerCase());
    if (off && typeof actual === 'number' && !off.contextWindows.has(actual)) {
      findings.push({
        level: 'warn',
        code: 'CATALOG_CONTEXT_STALE',
        selector,
        expected: [...off.contextWindows].sort((a, b) => a - b),
        actual,
        source: [...off.sources].join(', '),
        message: `${selector}: contextWindow ${actual} but pi ships ${[...off.contextWindows].join('/')} (${[...off.sources].join(', ')})`,
      });
    }

    if (typeof actual !== 'number' || actual <= 0) {
      findings.push({
        level: 'warn',
        code: 'CATALOG_CONTEXT_INVALID',
        selector,
        message: `${selector}: contextWindow is ${JSON.stringify(actual)}, expected a positive number`,
      });
    }
  }
  return findings;
};

/** Read + parse a catalog file. Returns null when absent, throws nothing. */
export const readCatalog = (path) => {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return undefined; // distinct from null: present but unreadable
  }
};
