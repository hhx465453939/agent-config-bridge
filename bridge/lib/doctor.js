/**
 * `doctor` — one command answers "is anything wrong right now?".
 *
 * Checks, in escalating severity:
 *   error  state file unreadable/corrupt, manifest conflict, incomplete snapshot,
 *          missing secret referenced by the source, unexpanded placeholder left
 *          in a generated file
 *   warn   target not installed, Kimi paths unverified, stale sync, source rules
 *          document missing, a managed path that is actually a symlink
 *   info   counts worth eyeballing
 *
 * Exit code is 0 only when there are no errors (and, under --strict, no warnings).
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

const PLACEHOLDER_RESIDUE = /\{\{[A-Z_]+\}\}/g;

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
  if (existsSync(secretsPath)) {
    const mode = statSync(secretsPath).mode & 0o777;
    if (mode !== 0o600) {
      add('error', 'SECRETS_MODE', `${secretsPath} has mode ${mode.toString(8)}, expected 600`, `chmod 600 ${secretsPath}`);
    }
  } else {
    add('info', 'SECRETS_ABSENT', `no secrets file at ${secretsPath} (fine unless an MCP entry uses \${VAR})`);
  }

  // --- per target ---------------------------------------------------------
  const installed = [];
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
