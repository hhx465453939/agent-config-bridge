/**
 * Programmatic facade.
 *
 * The CLI is a thin shell over these functions, and the test suite drives them
 * directly, so behaviour verified by tests is exactly the behaviour the CLI
 * exposes. Nothing here prints; it returns data and lets the caller render it.
 */

import { existsSync } from 'node:fs';
import { buildPlan, summarizePlan } from './plan.js';
import { executeTargetPlan } from './apply.js';
import { adoptTargets, assertAdoptable, assertRevocable } from './adopt.js';
import { revokeTargets } from './revoke.js';
import { runStatus } from './status.js';
import { runDoctor } from './doctor.js';
import { rollback } from './rollback.js';
import { detectTarget, loadAllManifests, loadManifest } from './manifest.js';
import { readState, setAgent, STATUS, writeState, mergeTracked } from './state.js';
import { writeFile } from './fs-ops.js';
import { lastApplyFile } from './paths.js';
import { OP } from './plan.js';

/** Every target declared by a manifest, whether or not it is installed. */
export const knownTargets = (repo) => loadAllManifests(repo).map((m) => m.name);

/** Targets that are both installed and currently bridged. */
export const activeTargets = (repo, home, requested = null) => {
  const state = readState(repo);
  const all = requested ?? knownTargets(repo);
  return all.filter((name) => {
    if ((state.agents[name]?.status ?? STATUS.NATIVE) !== STATUS.BRIDGED) return false;
    return detectTarget(loadManifest(repo, name), home);
  });
};

export const status = (repo, home) => runStatus({ repo, home });

/**
 * `plan` / `diff` — both read-only. `diff` is the same data with the "no change"
 * rows filtered out, so the two can never disagree.
 */
export const plan = ({ repo, home, targets = null, prune = false, onlyChanges = false }) => {
  const state = readState(repo);
  const names = (targets ?? knownTargets(repo)).filter((n) => {
    // Unknown names should surface as an error rather than being silently dropped.
    loadManifest(repo, n);
    return true;
  });
  const built = buildPlan({ repo, home, targetNames: names, state, prune });
  if (!onlyChanges) return built;
  return {
    ...built,
    targets: built.targets.map((t) => ({
      ...t,
      actions: t.actions.filter((a) => a.op !== OP.KEEP),
    })),
  };
};

export const diff = ({ repo, home, targets = null }) => plan({ repo, home, targets, onlyChanges: true });

/**
 * `apply` — refresh every bridged target. Targets that are not bridged are
 * reported as skipped; this command can never promote a native agent.
 */
export const apply = ({ repo, home, targets = null, prune = false, dryRun = false, log }) => {
  const state = readState(repo);
  const names = targets ?? activeTargets(repo, home);
  if (names.length === 0) {
    return { mode: 'apply', targets: [], note: 'no bridged agent — nothing to do (this is the default state)' };
  }

  const built = buildPlan({ repo, home, targetNames: names, state, prune });
  const outcomes = [];
  for (const target of built.targets) {
    if (target.skipped) {
      outcomes.push({ name: target.name, skipped: target.skipped });
      continue;
    }
    if (dryRun) {
      outcomes.push({ name: target.name, dryRun: true, summary: summarizePlan({ targets: [target] }) });
      continue;
    }
    const result = executeTargetPlan({ home, repo, plan: target, reason: 'apply' });
    outcomes.push({
      name: target.name,
      snapshotId: result.snapshotId,
      backupRoot: result.backupRoot,
      applied: result.applied,
      warnings: target.warnings,
    });
    log?.info(`apply ${target.name}: +${result.applied.added} ~${result.applied.updated} -${result.applied.removed}`);
  }

  if (!dryRun) {
    let next = state;
    const now = new Date().toISOString();
    for (const target of built.targets) {
      if (target.skipped) continue;
      const outcome = outcomes.find((o) => o.name === target.name);
      const previous = next.agents[target.name] ?? {};
      next = setAgent(next, target.name, {
        last_apply: now,
        snapshot_id: outcome?.snapshotId ?? previous.snapshot_id ?? null,
        // Union, not replacement: `--prune` may only delete what the bridge
        // created, so the record of past creations must survive refreshes.
        tracked: mergeTracked(
          previous.tracked,
          target.actions.filter((a) => a.op !== OP.KEEP).map((a) => a.to),
        ),
        derivedMcp: [...new Set([...(previous.derivedMcp ?? []), ...(target.info?.derivedMcp ?? [])])].sort(),
        managed_files: target.actions.length,
      });
    }
    writeState(repo, next);
    writeFile(
      lastApplyFile(repo),
      `${JSON.stringify({ at: now, home, targets: outcomes.map((o) => o.name), outcomes }, null, 2)}\n`,
    );
  }

  return { mode: 'apply', targets: outcomes };
};

export const adopt = ({ repo, home, names, prune = false, dryRun = false, log }) => {
  if (!dryRun) assertAdoptable(repo, home, names);
  const result = adoptTargets({ repo, home, names, prune, dryRun, log });
  if (!dryRun) {
    writeFile(
      lastApplyFile(repo),
      `${JSON.stringify({ at: new Date().toISOString(), home, mode: 'adopt', targets: names }, null, 2)}\n`,
    );
  }
  return result;
};

export const revoke = ({ repo, home, names, dryRun = false, log }) => {
  if (!dryRun) assertRevocable(repo, names);
  return revokeTargets({ repo, home, names, dryRun, log });
};

export const doctor = ({ repo, home, strict = false }) => runDoctor({ repo, home, strict });

export const undo = ({ repo, home, timestamp = null, dryRun = false, log }) =>
  rollback({ repo, home, timestamp, dryRun, log });

export { STATUS, OP, existsSync };
