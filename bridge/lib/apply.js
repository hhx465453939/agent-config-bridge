/**
 * Executor: turns a reviewed plan into filesystem changes.
 *
 * Order of operations for every target is fixed and non-negotiable:
 *
 *   1. snapshot the current state of every path the plan will touch
 *   2. copy the same paths into a timestamped backup
 *   3. only then write
 *
 * so a crash at any point leaves a recoverable picture on disk. Nothing here
 * decides *what* to do — that decision lives in plan.js, which `plan` and
 * `apply` share so the preview cannot drift from the execution.
 */

import { existsSync } from 'node:fs';
import { businessError } from './errors.js';
import { backupFiles, copyFile, ensureDir, removePath, writeFile } from './fs-ops.js';
import { backupsDir } from './paths.js';
import { createSnapshot, recordFromPlan } from './snapshot.js';
import { OP } from './plan.js';

export const newBackupId = (date = new Date()) =>
  date.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');

/**
 * @param {object} args
 * @param {string} args.home
 * @param {string} args.repo
 * @param {object} args.plan      a single target's plan (from planTarget)
 * @param {string} args.reason    'adopt' | 'apply' | 'revoke'
 */
export const executeTargetPlan = ({ home, repo, plan, reason }) => {
  const writes = plan.actions.filter((a) => a.op === OP.ADD || a.op === OP.UPDATE || a.op === OP.REMOVE);

  const snapshot = createSnapshot(repo, plan.name, {
    sourceLabel: `${reason} @ ${home}`,
    plan,
  });
  recordFromPlan(snapshot, { home, plan });

  const backupRoot = `${backupsDir(repo)}/${newBackupId()}-${plan.name}-${reason}`;
  // backupFiles writes the manifest.json that `rollback` reads. Building this by
  // hand (as an earlier revision did) silently produces an unrestorable backup:
  // the bytes are there but nothing records what they belong to.
  backupFiles(
    writes.map((action) => action.to),
    home,
    backupRoot,
    { agent: plan.name, reason, snapshot_id: snapshot.id },
  );

  const applied = { added: 0, updated: 0, removed: 0, kept: 0 };
  for (const action of plan.actions) {
    switch (action.op) {
      case OP.KEEP:
        applied.kept += 1;
        break;
      case OP.ADD:
      case OP.UPDATE:
        try {
          if (action.content !== undefined) {
            writeFile(action.to, action.content, action.mode ?? 0o600);
          } else {
            copyFile(action.from, action.to);
          }
          if (action.op === OP.ADD) applied.added += 1;
          else applied.updated += 1;
        } catch (err) {
          throw businessError(
            'WRITE_FAILED',
            `${plan.name}: failed to write ${action.to}: ${err.message}\n` +
              `  backups are in ${backupRoot}; snapshot ${snapshot.id} is intact.`,
          );
        }
        break;
      case OP.REMOVE:
        try {
          removePath(action.to);
          applied.removed += 1;
        } catch (err) {
          throw businessError('REMOVE_FAILED', `${plan.name}: failed to remove ${action.to}: ${err.message}`);
        }
        break;
      default:
        throw businessError('PLAN_INVALID', `unknown operation ${action.op}`);
    }
  }

  const manifest = snapshot.finalize();
  return { snapshotId: manifest.snapshot_id, backupRoot, applied };
};

/** Paths the plan will create or change; used by doctor and the CLI preview. */
export const touchedPaths = (plan) =>
  plan.actions.filter((a) => a.op !== OP.KEEP).map((a) => a.to);

export const trackedPaths = (plan) => plan.actions.map((a) => a.to);
