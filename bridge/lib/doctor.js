/**
 * `doctor` — one command answers "is anything wrong right now?".
 *
 * Checks, in escalating severity:
 *   error  state file unreadable/corrupt, manifest conflict, incomplete snapshot,
 *          missing secret referenced by the source, unexpanded placeholder left
 *          in a generated file
 *   warn   target not installed, Kimi paths unverified, stale sync, source rules
 *          document missing, a managed path that is actually a symlink, a
 *          declared runtime companion that is not installed
 *   info   counts worth eyeballing
 *
 * Exit code is 0 only when there are no errors (and, under --strict, no warnings).
 *
 * `doctor` is the only place environment probing is allowed to happen. The
 * planner must stay a hermetic function of source + destination, or `apply`
 * stops being reproducible and every plan/diff snapshot test becomes a coin
 * flip. "Is this companion installed?" is a fact about the machine, so it is
 * a doctor finding, never a plan action.
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { backupsDir, claudeJson, claudeRulesDoc, secretsFile } from './paths.js';
import { loadAllManifests, detectTarget, ruleDest } from './manifest.js';
import { findSymlinkedDestinations } from './symlink-guard.js';
import { buildPlan, summarizePlan } from './plan.js';
import { readState, STATUS, listBridged } from './state.js';
import { latestSnapshot, verifySnapshot } from './snapshot.js';
import { loadSecrets, placeholdersIn } from './secrets.js';
import { readIfExists } from './mcp.js';
import { listFiles } from './fs-ops.js';
import {
  checkCatalog,
  checkFamilyAgainstOfficial,
  piAiDataDir,
  readCatalog,
  readOfficialModels,
} from './pi-models.js';

const PLACEHOLDER_RESIDUE = /\{\{[A-Z_]+\}\}/g;

/**
 * Does this platform have POSIX permission bits at all?
 *
 * Used to decide whether a "file mode must be 600" finding is a real problem or
 * an unanswerable question. Kept as a constant so the tests can reason about it
 * instead of hardcoding a platform check of their own.
 */
export const POSIX_PERMISSIONS = process.platform !== 'win32';

/**
 * Candidate locations for one `requires` probe, most specific first.
 *
 * A manifest declares ONE relative path (`probe`), but the same companion is
 * routinely installed in more than one place — a per-agent package directory,
 * a global prefix, the cwd. Rather than make every manifest enumerate those,
 * a probe containing a `node_modules/` segment is also tried as a global
 * install (`<home>/.npm-global/lib/node_modules/...`) and under the current
 * working directory. All of them express the same question — "is a copy of
 * this package reachable?" — and an empty result is the only thing that
 * becomes a finding, so a wrong guess costs nothing but a missed warning.
 *
 * A probe with no `node_modules/` in it is used verbatim: it is a direct path
 * question, not a package question.
 */
export const requirementCandidates = (home, probe) => {
  const direct = join(home, probe);
  const marker = 'node_modules/';
  const at = probe.indexOf(marker);
  if (at === -1) return [direct];
  const tail = probe.slice(at + marker.length);
  return [
    direct,
    join(home, '.npm-global', 'lib', 'node_modules', tail),
    join(process.cwd(), 'node_modules', tail),
  ];
};

/**
 * Is a declared runtime companion present?
 *
 * Returns the path that satisfied the probe, or null. `unless` is an accepted
 * alternative location — an "or it is installed here instead" clause — so a
 * requirement satisfied the unconventional way is not reported as missing.
 *
 * This is a pure fact. It deliberately does not consult the agent's own
 * `never_touch` settings file (for pi, `settings.json` `packages`) to decide
 * whether the companion is *wanted*: that file is the user's, and the bridge
 * reads nothing but the paths the manifest names.
 */
export const findRequirement = (home, req) => {
  for (const candidate of requirementCandidates(home, req.probe)) {
    if (existsSync(candidate)) return candidate;
  }
  if (req.unless && existsSync(join(home, req.unless))) return join(home, req.unless);
  return null;
};

export const runDoctor = ({ repo, home, strict = false, targets = null }) => {
  const findings = [];
  const add = (level, code, message, hint = null) => findings.push({ level, code, message, hint });

  // --- state -------------------------------------------------------------
  let state = { version: 1, agents: {} };
  try {
    state = readState(repo);
  } catch (err) {
    add('error', 'STATE', err.message, 'fix or delete .bridge/state.json (deleting returns every agent to native)');
    return finish(findings, strict);
  }

  // --- manifests ----------------------------------------------------------
  let manifests = [];
  try {
    manifests = loadAllManifests(repo);
  } catch (err) {
    add('error', 'MANIFEST', err.message);
    return finish(findings, strict);
  }
  if (manifests.length === 0) add('error', 'MANIFEST', `no target manifests found in ${repo}/bridge/targets`);

  // --- source -------------------------------------------------------------
  const rulesDoc = claudeRulesDoc(home);
  if (!existsSync(rulesDoc)) {
    add('warn', 'SOURCE_RULES', `source rules document not found: ${rulesDoc}`, 'rules-doc targets keep their own file');
  }
  const claudeConfig = claudeJson(home);
  if (!existsSync(claudeConfig)) {
    add('warn', 'SOURCE_MCP', `source MCP config not found: ${claudeConfig}`, 'mcp targets will be left alone');
  }

  // --- secrets ------------------------------------------------------------
  const secretsInfo = loadSecrets(home, process.env);
  const secretsPath = secretsFile(home);
  if (existsSync(secretsPath) && POSIX_PERMISSIONS) {
    // POSIX only. Windows has no mode bits: Node reports a fixed 0o666 for
    // every ordinary file, so comparing against 600 there reported a perfectly
    // private file as a failure — an error the user could not act on, since
    // `chmod` cannot produce 600 on that platform either. Saying "not checked"
    // is honest; reporting a fake violation is not.
    const mode = statSync(secretsPath).mode & 0o777;
    if (mode !== 0o600) {
      add('error', 'SECRETS_MODE', `${secretsPath} has mode ${mode.toString(8)}, expected 600`, `chmod 600 ${secretsPath}`);
    }
  } else if (existsSync(secretsPath)) {
    add(
      'info',
      'SECRETS_MODE_UNCHECKED',
      `${secretsPath} permissions are not checked on this platform`,
      'Windows protects files with ACLs, not POSIX mode bits',
    );
  } else {
    add('info', 'SECRETS_ABSENT', `no secrets file at ${secretsPath} (fine unless an MCP entry uses \${VAR})`);
  }

  // --- per target ---------------------------------------------------------
  const installed = [];
  const bridgedOnly = [];
  for (const manifest of manifests) {
    const isInstalled = detectTarget(manifest, home);
    const status = state.agents[manifest.name]?.status ?? STATUS.NATIVE;
    if (!isInstalled) {
      add('info', 'TARGET_ABSENT', `${manifest.name}: not installed on this machine`);
      continue;
    }
    installed.push(manifest.name);
    if (manifest.verified === false && status === STATUS.BRIDGED) {
      add('warn', 'TARGET_UNVERIFIED', `${manifest.name}: manifest paths are declared but unverified`, `run a real adopt, then confirm the agent discovers its skills`);
    }
    if (status === STATUS.BRIDGED) {
      bridgedOnly.push(manifest);
      const entry = state.agents[manifest.name];
      const snapId = entry.snapshot_id ?? latestSnapshot(repo, manifest.name);
      if (!snapId) {
        add('error', 'SNAPSHOT_MISSING', `${manifest.name}: bridged but has no snapshot`, 'revoke cannot restore it; inspect manually');
      } else {
        const check = verifySnapshot(repo, manifest.name, snapId, home);
        if (!check.ok) {
          add('error', 'SNAPSHOT_INCOMPLETE', `${manifest.name}: snapshot ${snapId} is incomplete`, check.problems.join('; '));
        }
      }
      // A managed destination that is a symlink is an ERROR, not a warning: the
      // planner refuses to act in that state, so the bridge is effectively
      // broken for this target until the user resolves it.
      for (const link of findSymlinkedDestinations({ home, manifest })) {
        add(
          'error',
          'SYMLINK',
          `${manifest.name}: managed path is a symlink: ${link.path} -> ${link.target}`,
          `writing through it would edit the link target (possibly the source itself); ` +
            `remove the link, or drop the "${link.rule.kind}" rule from bridge/targets/${manifest.name}.json`,
        );
      }
    }
  }

  // --- declared runtime requirements --------------------------------------
  //
  // A companion the target needs at runtime but that this project cannot
  // install (it would live in a `never_touch` file). Reported only when the
  // target is bridged AND the configuration that needs it actually exists —
  // otherwise the advice would be noise on a machine that never adopted this
  // target in the first place.
  //
  // Severity is `warn`, not `error`: a missing companion does not make the
  // bridge's own output wrong, and `apply` is still the correct response to a
  // real drift. It is a silent-hole finder, so it fires every run until the
  // user acts, and `doctor --strict` promotes it to a failure for CI use.
  for (const manifest of bridgedOnly) {
    for (const req of manifest.requires ?? []) {
      const declaredBy = ruleDest({ to: req.declaredBy }, home);
      if (!existsSync(declaredBy)) continue; // nothing generated yet; nothing to orphan
      if (findRequirement(home, req)) continue;
      add(
        'warn',
        'REQUIREMENT_MISSING',
        `${manifest.name}: ${req.id} is not installed, so ${declaredBy.replace(`${home}/`, '~/')} ` +
          `is generated but nothing loads it — ${req.why}`,
        req.install,
      );
    }
  }

  // --- pi context-window registry ------------------------------------------
  //
  // Two hand-maintained copies of the same facts, in files that never talk to
  // each other: the custom-provider extension pi actually reads at runtime, and
  // `pi-router-catalog.json`, whose merge is sticky so a stale value can never
  // be refreshed. Both can say a 1M model is 128K, and pi will believe it and
  // compact away context the model really has. Nothing else on the machine
  // compares them, so this does.
  //
  // Reported only when the catalog exists (pi + pi-smart-router installed) and
  // only for models a source of truth actually covers. Severity is `warn`: the
  // bridge did not write these files, does not own them, and must not rewrite
  // them — the finding is information plus a pointer, not an action.
  //
  // Pushed directly rather than through `add` because these findings carry
  // structured extras (`selector`, `expected`, `actual`, `source`) that the
  // generic shape has no room for, and a machine-readable `--json` report is
  // only useful if it names the entry that is wrong.
  for (const finding of checkPiContextWindows(home)) findings.push(finding);

  // --- drift --------------------------------------------------------------
  const bridged = listBridged(state).filter((n) => installed.includes(n));
  let drift = null;
  if (bridged.length > 0) {
    try {
      const plan = buildPlan({ repo, home, targetNames: bridged, state, prune: false });
      drift = summarizePlan(plan);
      for (const target of plan.targets) {
        const changed = target.actions.filter((a) => a.op === 'update' || a.op === 'add');
        if (changed.length > 0 && !strict) {
          add('info', 'DRIFT', `${target.name}: ${changed.length} file(s) differ from the source`, 'run `apply` to refresh');
        }
        for (const warning of target.warnings ?? []) add('warn', 'PLAN_WARNING', `${target.name}: ${warning}`);
        for (const unsupported of target.info?.unsupportedMcp ?? []) {
          add('warn', 'MCP_UNSUPPORTED', `${target.name}: ${unsupported}`);
        }
      }
      for (const name of bridged) {
        const entry = state.agents[name];
        const stale = staleness(entry?.last_apply);
        if (stale !== null && stale > 14) {
          add('warn', 'STALE', `${name}: last synced ${stale} day(s) ago`, 'run `apply` after editing the source');
        }
      }
    } catch (err) {
      // A symlinked destination makes the planner refuse by design; surface it
      // as its own finding rather than as an opaque PLAN_FAILED.
      if (err?.code === 'TARGET_SYMLINK') {
        add('error', 'SYMLINK', err.message.split('\n')[0], 'resolve the symlink before syncing this target');
      } else {
        add('error', 'PLAN_FAILED', err.message);
      }
    }
  } else {
    add('info', 'NO_BRIDGED', 'no agent is bridged — nothing to reconcile (this is the default state)');
  }

  // --- generated files: unexpanded template placeholders -------------------
  for (const manifest of manifests) {
    if ((state.agents[manifest.name]?.status ?? STATUS.NATIVE) !== STATUS.BRIDGED) continue;
    for (const rule of manifest.managed) {
      if (rule.kind !== 'rules-doc') continue;
      const dest = ruleDest(rule, home);
      const text = readIfExists(dest);
      if (text && PLACEHOLDER_RESIDUE.test(text)) {
        add('error', 'PLACEHOLDER_RESIDUE', `${dest} still contains {{...}} markers`, 're-render the source before bridging');
      }
      if (text) {
        const leftovers = placeholdersIn(text);
        if (leftovers.length > 0) {
          add('warn', 'PLACEHOLDER_UNEXPANDED', `${dest} contains unexpanded \${VAR}: ${leftovers.join(', ')}`);
        }
      }
    }
  }

  // --- backups ------------------------------------------------------------
  const bdir = backupsDir(repo);
  if (existsSync(bdir) && listFiles(bdir).length === 0) {
    add('info', 'BACKUPS_EMPTY', `backup directory exists but is empty: ${bdir}`);
  }

  return finish(findings, strict, { installed, bridged, drift });
};

const staleness = (iso) => {
  if (!iso) return null;
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return null;
  return Math.floor((Date.now() - then) / 86_400_000);
};

/**
 * The pi context-window check, kept in one place so `runDoctor` stays readable.
 *
 * Three independent questions, in decreasing authority:
 *
 *   1. does our own family table still match pi's shipped provider data? (a
 *      finding here is OUR bug, not the machine's)
 *   2. does the custom-provider extension declare windows our table disagrees
 *      with? (this is the file pi actually reads)
 *   3. does pi-router-catalog.json hold values neither source agrees with? (a
 *      cache with no invalidation)
 *
 * Everything is derived from `home`; no absolute path is embedded, and nothing
 * is written. A missing file is silence, never a finding — most machines have
 * no custom provider, no catalog, and no problem.
 */
const checkPiContextWindows = (home) => {
  const out = [];
  const add = (level, code, message, hint = null, extra = {}) =>
    out.push({ level, code, message, hint, ...extra });

  // pi's shipped provider data is used for two different jobs, and they must not
  // be coupled: the table-drift check is MEANINGLESS without it (there is
  // nothing to compare against), while the catalog check is perfectly able to
  // run from the family table alone — that table is the citation. Requiring
  // pi's data for both would mean a machine that cannot see pi-ai silently
  // stops checking catalogs it can still check.
  const official = readOfficialModels(piAiDataDir(home));

  if (official) {
    for (const f of checkFamilyAgainstOfficial(official)) {
      add(
        'warn',
        'PI_MODEL_TABLE_STALE',
        `bridge: family table disagrees with pi's shipped provider data — ${f.message}`,
        "fix FAMILY_META in bridge/lib/pi-models.js; the table is this repository's claim, not pi's",
        { file: f.file },
      );
    }
  }

  const catalogPath = join(home, '.pi', 'agent', 'pi-router-catalog.json');
  if (!existsSync(catalogPath)) return out;
  const catalog = readCatalog(catalogPath);
  if (catalog === undefined) {
    add(
      'warn',
      'PI_CATALOG_UNREADABLE',
      `${catalogPath} exists but is not valid JSON`,
      'fix or delete it; pi-smart-router falls back to its shipped seed',
    );
    return out;
  }
  if (catalog === null) return out;

  for (const f of checkCatalog(catalog, { official })) {
    // `selector`, `expected`, `actual` and `source` ride along: a report whose
    // finding says "something is stale" but not WHICH entry is a report the
    // user has to re-derive by hand.
    const { level, code, message, ...rest } = f;
    add(
      level,
      code.startsWith('CATALOG_') ? `PI_${code}` : code,
      `pi-router catalog: ${message}`,
      'the catalog merge is sticky (an existing value always wins), so this will not self-heal — edit pi-router-catalog.json',
      rest,
    );
  }
  return out;
};

const finish = (findings, strict, extra = {}) => {
  const errors = findings.filter((f) => f.level === 'error');
  const warnings = findings.filter((f) => f.level === 'warn');
  const failed = errors.length > 0 || (strict && warnings.length > 0);
  return {
    ok: !failed,
    strict,
    counts: { error: errors.length, warn: warnings.length, info: findings.length - errors.length - warnings.length },
    findings,
    ...extra,
  };
};

export const formatDoctorReport = (report) => {
  const lines = [];
  const { counts } = report;
  lines.push(`doctor: ${counts.error} error(s), ${counts.warn} warning(s), ${counts.info} note(s)`);
  for (const level of ['error', 'warn', 'info']) {
    const group = report.findings.filter((f) => f.level === level);
    if (group.length === 0) continue;
    lines.push('');
    lines.push(`${level.toUpperCase()}`);
    for (const f of group) {
      lines.push(`  [${f.code}] ${f.message}`);
      if (f.hint) lines.push(`      → ${f.hint}`);
    }
  }
  if (report.installed) {
    lines.push('');
    lines.push(`detected agents : ${report.installed.join(', ') || '(none)'}`);
    lines.push(`bridged agents  : ${report.bridged.join(', ') || '(none)'}`);
  }
  return lines.join('\n');
};
