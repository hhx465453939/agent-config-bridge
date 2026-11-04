/**
 * Domain classifier: which set of gate checks applies to this session?
 *
 * WHY THIS EXISTS
 *
 * The gate shipped with one rule set — consult the graph, think before acting,
 * do not defer work — and those rules are about writing code. A computational
 * research session (dry lab / quant) has additional hard constraints that no
 * existing check covers: write a Worklog before the first analysis run, make the
 * script log to a file, leave a README in every result directory. Applying those
 * to an ordinary repository would be pure false-positive noise, so the question
 * "which domain is this?" has to be answered before "which checks run?".
 *
 * WHAT IT DELIBERATELY DOES NOT DO
 *
 *   - It does not decide *whether* work may proceed. Only which check list
 *     applies. A wrong answer costs one extra (or one missing) rule set; it must
 *     never cost the session. Every failure path therefore degrades to
 *     `general-dev` — see `classify` below.
 *   - It does not read file CONTENT. Fingerprints are `stat` probes on file
 *     names only: research data can be unpublished sequence or patient material
 *     and must not end up in a log line, an `reason`, or a model prompt.
 *   - It does not call a model itself. T2 is injected as `modelHint`, so tests
 *     drive it with a fake and no deployment needs a provider key to be tested.
 *
 * THREE LEVELS, STRONGEST FIRST
 *
 *   T0 fingerprint  microseconds, `fs.exists` only      confidence 0.95
 *   T1 keyword      microseconds, regex over the prompt  confidence 0.70
 *   T2 model        one round trip, injected, optional   confidence 0.50
 *   fallback        free                                 confidence 0
 *
 * The ordering is by evidence strength per unit of cost, not by cleverness: a
 * directory that contains both `docs/STATE.md` and `docs/WORKLOG.md` is a
 * structural fact that no phrasing can fake, while "什么是单细胞" is an ordinary
 * question that merely mentions one keyword.
 */

import { join } from 'node:path';

/** The profile that adds no checks at all: base rules only. */
export const GENERAL_PROFILE = 'general-dev';

/** Names a classifier may return. Anything else is a profile-table bug. */
export const SOURCES = ['fingerprint', 'keyword', 'model', 'fallback'];

/**
 * How many DISTINCT strong keywords must appear before T1 is allowed to decide.
 *
 * One is not enough: "什么是单细胞测序" is a question, not a research session, and
 * answering it must not switch on Worklog requirements. Two independent domain
 * terms in the same opening request is a much better signal than one.
 */
const DEFAULT_MIN_HITS = 2;

/** Never let a caller pass a value that turns the threshold into "one word". */
const minHits = (keywords) => {
  const raw = keywords?.min_hits;
  return Number.isInteger(raw) && raw >= DEFAULT_MIN_HITS ? raw : DEFAULT_MIN_HITS;
};

const lower = (value) => (typeof value === 'string' ? value.toLowerCase() : '');

const asProfile = (policy) => policy?.profiles instanceof Map
  ? policy.profiles
  : new Map(Object.entries(policy?.profiles ?? {}));

/**
 * T0 — file-structure fingerprint.
 *
 * A fingerprint is a list of repository-relative paths that must ALL exist. The
 * strongest matching fingerprint wins; a tie is broken by the profile order in
 * `policy.profileOrder`, so the result is deterministic (a classifier that
 * answers differently on two identical repositories cannot be debugged).
 *
 * @returns {{profile: string, reason: string}|null}
 */
export const fingerprintHit = ({ cwd, fs, profiles, order = [] }) => {
  if (typeof cwd !== 'string' || cwd === '' || !fs?.exists) return null;
  const names = order.length > 0 ? order : [...profiles.keys()];
  let best = null;
  for (const name of names) {
    const profile = profiles.get(name);
    const fingerprints = Array.isArray(profile?.fingerprints) ? profile.fingerprints : [];
    for (const group of fingerprints) {
      const paths = Array.isArray(group) ? group : [group];
      if (paths.length === 0) continue;
      const missing = paths.filter((rel) => !fs.exists(joinPath(cwd, rel)));
      if (missing.length > 0) continue;
      const score = paths.length;
      if (!best || score > best.score) {
        best = { profile: name, score, reason: `${name} 指纹命中：${paths.join(' + ')} 均存在` };
      }
    }
  }
  return best ? { profile: best.profile, reason: best.reason } : null;
};

/**
 * T1 — strong-keyword evidence from the opening request.
 *
 * Weak keywords are reported but never decide: they exist so the `reason` can
 * say "saw 细胞 but only one domain term", which is what a human needs to
 * understand why a research-looking session stayed on `general-dev`.
 *
 * @returns {{profile: string, reason: string}|null}
 */
export const keywordHit = ({ prompt, profiles, order = [] }) => {
  const text = lower(prompt);
  if (text === '') return null;
  const names = order.length > 0 ? order : [...profiles.keys()];
  let best = null;
  for (const name of names) {
    const keywords = profiles.get(name)?.keywords;
    if (!keywords) continue;
    const strong = (keywords.strong ?? []).filter((w) => w && text.includes(lower(w)));
    const weak = (keywords.weak ?? []).filter((w) => w && text.includes(lower(w)));
    if (strong.length < minHits(keywords)) continue;
    if (!best || strong.length > best.score) {
      best = {
        profile: name,
        score: strong.length,
        reason:
          `${name} 关键词命中 ${strong.length} 个强词（${strong.slice(0, 4).join(' / ')}）` +
          (weak.length > 0 ? `；弱词 ${weak.slice(0, 3).join(' / ')} 仅供参考` : ''),
      };
    }
  }
  return best ? { profile: best.profile, reason: best.reason } : null;
};

/**
 * T2 — an injected model judge.
 *
 * `modelHint(prompt, { profiles })` may answer `{ profile, reason }` or return a
 * bare profile name. Its answer is VALIDATED against the profile table: a model
 * that hallucinates `ai4s-foo` must not be able to switch on a rule set that
 * does not exist. Any throw, rejection, non-answer or timeout degrades instead of
 * propagating — the gate's failure direction is "fewer rules", never "blocked".
 *
 * @returns {Promise<{profile: string, reason: string}|null>}
 */
export const modelVerdict = async ({ prompt, modelHint, profiles, timeoutMs = 8000 }) => {
  if (typeof modelHint !== 'function') return null;
  const answer = await withTimeout(
    Promise.resolve().then(() => modelHint(prompt, { profiles: [...profiles.keys()] })),
    timeoutMs,
  );
  const name = typeof answer === 'string' ? answer : answer?.profile;
  if (typeof name !== 'string' || name === '') return null;
  if (name !== GENERAL_PROFILE && !profiles.has(name)) {
    throw new Error(`model judge named an unknown profile: ${name}`);
  }
  const reason = typeof answer?.reason === 'string' && answer.reason !== ''
    ? answer.reason
    : '模型判定命中';
  return { profile: name, reason };
};

/** Reject after `ms`, so a hung provider cannot hold a turn open. */
const withTimeout = (promise, ms) => {
  if (!Number.isFinite(ms) || ms <= 0) return promise;
  let timer = null;
  const timeout = new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`model judge timed out after ${ms}ms`)), ms);
    // Deliberately NOT unref'd.
    //
    // A deadline timer is the ONLY thing that can settle this race when the
    // judge hangs. Unref'ing it lets the event loop drain while the race is
    // still pending, and Node then aborts the run with "Promise resolution is
    // still pending but the event loop has already resolved" — measured on
    // node 20/22, where it cancels every remaining test in the file. It is also
    // the correct production behaviour: our caller is awaiting us, so the
    // process has to stay alive until the deadline fires.
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
};

const joinPath = (cwd, rel) => join(cwd, String(rel));

/**
 * Classify the session.
 *
 * @param {object} args
 * @param {string} [args.cwd]   session working directory (primary repo root)
 * @param {string} [args.prompt] the user's opening request for this turn
 * @param {{exists:(p:string)=>boolean}} [args.fs] filesystem probe; `stat` only
 * @param {object} [args.policy] normalized policy (profiles / defaultProfile / classifier)
 * @param {Function} [args.modelHint] optional T2 judge, `(prompt, ctx) => profile|{profile,reason}`
 * @returns {Promise<{profile:string, source:string, reason:string, confidence:number}>}
 */
export const classify = async ({ cwd = '', prompt = '', fs = null, policy = {}, modelHint = null } = {}) => {
  const config = policy?.classifier ?? {};
  const profiles = asProfile(policy);
  const order = Array.isArray(policy?.profileOrder) ? policy.profileOrder : [...profiles.keys()];
  const fallbackProfile = typeof policy?.defaultProfile === 'string' && policy.defaultProfile !== ''
    ? policy.defaultProfile
    : GENERAL_PROFILE;
  const degraded = (reason) => ({
    profile: fallbackProfile,
    source: 'fallback',
    reason,
    confidence: 0,
  });

  if (config.enabled === false) return degraded('classifier 已禁用（classifier.enabled=false）');
  if (profiles.size === 0) return degraded('profile 表为空：只跑基础检查');

  // T0. Its own try/catch: a filesystem hiccup must skip one level, not the run.
  try {
    const hit = fingerprintHit({ cwd, fs, profiles, order });
    if (hit) return { ...hit, source: 'fingerprint', confidence: 0.95 };
  } catch (err) {
    // fall through to T1 — see §fail-open in the ADR
  }

  // T1.
  try {
    const hit = keywordHit({ prompt, profiles, order });
    if (hit) return { ...hit, source: 'keyword', confidence: 0.7 };
  } catch (err) {
    // fall through to T2
  }

  // T2. Everything about it is optional, so "no judge configured" is normal and
  // reports itself as a fallback rather than as an error.
  if (config.model_judge === true && typeof modelHint === 'function') {
    try {
      const hit = await modelVerdict({
        prompt,
        modelHint,
        profiles,
        timeoutMs: config.timeout_ms,
      });
      if (hit) return { ...hit, source: 'model', confidence: 0.5 };
      return degraded('模型判定未给出结论：降级为 general-dev');
    } catch (err) {
      return degraded(`模型判定失败（${err?.message ?? err}）：降级为 general-dev`);
    }
  }

  return degraded(
    `无指纹、强关键词不足（需 ≥${DEFAULT_MIN_HITS} 个）：降级为 ${fallbackProfile}`,
  );
};
