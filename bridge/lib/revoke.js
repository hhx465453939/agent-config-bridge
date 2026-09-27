/**
 * `revoke <agent>` — put the agent back the way it was.
 *
 * Reads the snapshot recorded at adopt time and reverses it:
 *   created     → delete the file this bridge added
 *   overwritten → restore the bytes we replaced
 *   removed     → restore the file we pruned away
 *
 * Refuses to run when the snapshot is incomplete. A partial restore that reports
 * success would leave the user believing their configuration is intact when it
 * is not — the single worst outcome this tool could produce.
 */

import { existsSync, readdirSync, rmdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { businessError } from './errors.js';
import { backupFiles, copyFile, ensureDir, removePath } from './fs-ops.js';
import { backupsDir } from './paths.js';
import { SNAPSHOT_ACTIONS, latestSnapshot, readSnapshot, verifySnapshot } from './snapshot.js';
import { readState, setAgent, STATUS, writeState } from './state.js';
import { newBackupId } from './apply.js';

export const revokeTargets = ({ repo, home, names, dryRun = false, log }) => {
  const state = readState(repo);
  const outcomes = [];

  for (const name of names) {
    const entry = state.agents[name];
    if (!entry || entry.status !== STATUS.BRIDGED) {
      outcomes.push({ name, skipped: `not bridged` });
      continue;
    }
    const id = entry.snapshot_id ?? latestSnapshot(repo, name);
    if (!id) {
      throw businessError(
        'SNAPSHOT_MISSING',
        `${name}: state says bridged but no snapshot exists.\n` +
          `  refusing to guess — inspect ${entry.tracked?.length ?? 0} tracked path(s) manually, ` +
          `then set status to native in .bridge/state.json.`,
      );
    }

    const check = verifySnapshot(repo, name, id, home);
    if (!check.ok) {
      throw businessError(
        'SNAPSHOT_INCOMPLETE',
        `${name}: snapshot ${id} is incomplete, refusing to revoke:\n` +
          check.problems.map((p) => `  - ${p}`).join('\n') +
          `\n  restore the missing copies (or the whole snapshot) and retry.`,
      );
    }

    const { dir, manifest } = readSnapshot(repo, name, id);
    const plan = planRestore({ dir, manifest, home });

    if (dryRun) {
      outcomes.push({ name, snapshotId: id, dryRun: true, actions: plan });
      continue;
    }

    // Back up the current state first, so a revoke can itself be undone.
    const backupRoot = ensureDir(`${backupsDir(repo)}/${newBackupId()}-${name}-revoke`);
    backupFiles(
      plan.filter((a) => existsSync(a.absolute)).map((a) => a.absolute),
      home,
      backupRoot,
      { agent: name, reason: 'pre-revoke' },
    );

    const applied = { restored: 0, deleted: 0 };
    for (const action of plan) {
      if (action.kind === 'delete') {
        if (existsSync(action.absolute)) {
          removePath(action.absolute);
          applied.deleted += 1;
        }
      } else {
        copyFile(action.from, action.absolute);
        applied.restored += 1;
      }
    }
    pruneEmptyDirs(plan.map((a) => a.absolute), home);

    outcomes.push({ name, snapshotId: id, backupRoot, applied });
    log?.info(`revoke ${name}: restored=${applied.restored} deleted=${applied.deleted}`);
  }

  if (dryRun) return { mode: 'revoke', dryRun: true, targets: outcomes };

  let next = state;
  for (const outcome of outcomes) {
    if (outcome.skipped || outcome.dryRun) continue;
    next = setAgent(next, outcome.name, {
      status: STATUS.REVOKED,
      revoked_at: new Date().toISOString(),
      revoked_snapshot_id: outcome.snapshotId,
      snapshot_id: null,
      tracked: [],
      derivedMcp: [],
      last_apply: null,
      managed_files: 0,
    });
  }
  writeState(repo, next);

  return { mode: 'revoke', targets: outcomes, state: next };
};

const planRestore = ({ dir, manifest, home }) => {
  const actions = [];
  for (const entry of manifest.entries) {
    const absolute = join(home, ...entry.path.split('/'));
    if (entry.action === SNAPSHOT_ACTIONS.CREATED) {
      actions.push({ kind: 'delete', absolute, path: entry.path });
    } else {
      actions.push({
        kind: 'restore',
        absolute,
        path: entry.path,
        from: join(dir, 'files', entry.path),
      });
    }
  }
  return actions;
};

/**
 * Remove directories that became empty because we deleted files from them.
 * Stops at `home` and never touches a directory that still has content, so an
 * agent's own files keep their directory alive.
 */
export const pruneEmptyDirs = (absolutePaths, home) => {
  const dirs = [...new Set(absolutePaths.map((p) => dirname(p)))].sort((a, b) => b.length - a.length);
  const removed = [];
  for (const dir of dirs) {
    let current = dir;
    while (current.startsWith(home) && current !== home) {
      if (!existsSync(current)) {
        current = dirname(current);
        continue;
      }
      let empty = true;
      try {
        empty = readdirSync(current).length === 0;
      } catch {
        empty = false;
      }
      if (!empty) break;
      try {
        rmdirSync(current);
        removed.push(current);
      } catch {
        break;
      }
      current = dirname(current);
    }
  }
  return removed;
};
