/**
 * `adopt <agent>` — hand one agent's shared dimensions over to the source.
 *
 * This is the only command that can move an agent from native to bridged, and it
 * is never implicit. Sequence:
 *
 *   1. build the plan exactly as `plan` would show it
 *   2. snapshot + back up every path the plan touches
 *   3. write
 *   4. record the new state (bridged, snapshot id, tracked paths)
 *
 * Step 2 happening before step 3 in the same code path is what makes `revoke` a
 * promise rather than a hope.
 */

import { businessError } from './errors.js';
import { loadManifest, detectTarget } from './manifest.js';
import { buildPlan } from './plan.js';
import { executeTargetPlan } from './apply.js';
import { readState, setAgent, STATUS, writeState, mergeTracked } from './state.js';

export const adoptTargets = ({ repo, home, names, prune = false, dryRun = false, log }) => {
  const state = readState(repo);
  const plan = buildPlan({ repo, home, targetNames: names, state, prune, adoptNames: names });
  const outcomes = [];

  for (const target of plan.targets) {
    if (target.skipped) {
      outcomes.push({ name: target.name, skipped: target.skipped });
      continue;
    }
    if (dryRun) {
      outcomes.push({ name: target.name, dryRun: true, actions: target.actions, warnings: target.warnings });
      continue;
    }
    const result = executeTargetPlan({ home, repo, plan: target, reason: 'adopt' });
    outcomes.push({
      name: target.name,
      snapshotId: result.snapshotId,
      backupRoot: result.backupRoot,
      applied: result.applied,
      warnings: target.warnings,
    });
    log?.info(
      `adopt ${target.name}: +${result.applied.added} updated=${result.applied.updated} removed=${result.applied.removed}`,
    );
  }

  if (dryRun) return { mode: 'adopt', dryRun: true, targets: outcomes };

  let next = state;
  for (const outcome of outcomes) {
    if (outcome.skipped) continue;
    next = setAgent(next, outcome.name, {
      status: STATUS.BRIDGED,
      adopted_at: new Date().toISOString(),
      snapshot_id: outcome.snapshotId,
      tracked: trackedFromPlan(plan, outcome.name, home),
      derivedMcp: derivedMcpFromPlan(plan, outcome.name),      last_apply: new Date().toISOString(),
      managed_files: countManaged(plan, outcome.name),
    });
  }
  writeState(repo, next);

  return { mode: 'adopt', targets: outcomes, state: next };
};

export const assertAdoptable = (repo, home, names) => {
  const state = readState(repo);
  const problems = [];
  for (const name of names) {
    const manifest = loadManifest(repo, name);
    if (!detectTarget(manifest, home)) {
      problems.push(`${name}: not installed on this machine (looked for ${manifest.detect.join(', ')})`);
      continue;
    }
    if (state.agents[name]?.status === STATUS.BRIDGED) {
      problems.push(`${name}: already bridged (run \`apply\` to refresh it)`);
    }
  }
  if (problems.length > 0) {
    throw businessError('ADOPT_PRECONDITION', problems.join('\n'));
  }
};

export const assertRevocable = (repo, names) => {
  const state = readState(repo);
  const problems = [];
  for (const name of names) {
    const status = state.agents[name]?.status ?? STATUS.NATIVE;
    if (status !== STATUS.BRIDGED) {
      problems.push(`${name}: not bridged (status is ${status}); nothing to revoke`);
    }
  }
  if (problems.length > 0) throw businessError('REVOKE_PRECONDITION', problems.join('\n'));
};

const trackedFromPlan = (plan, name, home) => {
  const target = plan.targets.find((t) => t.name === name);
  if (!target) return [];
  return target.actions.filter((a) => a.op !== 'keep').map((a) => a.to).sort();
};

const derivedMcpFromPlan = (plan, name) => {
  const target = plan.targets.find((t) => t.name === name);
  return target?.info?.derivedMcp ?? [];
};

const countManaged = (plan, name) => {
  const target = plan.targets.find((t) => t.name === name);
  return target ? target.actions.length : 0;
};
