/**
 * `rollback [timestamp]` — the sync-level undo.
 *
 * Distinct from `revoke`:
 *   rollback  undoes one `apply` (put the target files back as they were before
 *             that specific run)
 *   revoke    undoes an `adopt` entirely (return the whole agent to native)
 *
 * Both read manifests written at operation time; neither guesses.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { businessError } from './errors.js';
import { copyFile, hashFile, writeFile } from './fs-ops.js';
import { backupsDir } from './paths.js';

export const listBackups = (repo) => {
  const dir = backupsDir(repo);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => existsSync(join(dir, name, 'manifest.json')))
    .sort()
    .reverse()
    .map((name) => ({ id: name, dir: join(dir, name) }));
};

export const readBackupManifest = (dir) => {
  const file = join(dir, 'manifest.json');
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    throw businessError('BACKUP_CORRUPT', `${file}: not valid JSON (${err.message})`);
  }
  if (!Array.isArray(parsed.files)) {
    throw businessError('BACKUP_CORRUPT', `${file}: missing "files" array`);
  }
  return parsed;
};

/**
 * @param {object} args
 * @param {string} args.repo
 * @param {string} args.home
 * @param {string} [args.timestamp] full or prefix match on the backup id
 * @param {boolean} [args.dryRun]
 */
export const rollback = ({ repo, home, timestamp = null, dryRun = false, log }) => {
  const backups = listBackups(repo);
  if (backups.length === 0) {
    throw businessError('NO_BACKUPS', `no backups recorded under ${backupsDir(repo)}`);
  }

  let chosen;
  if (timestamp) {
    const matches = backups.filter((b) => b.id.includes(timestamp));
    if (matches.length === 0) {
      throw businessError('BACKUP_NOT_FOUND', `no backup matching "${timestamp}"`, {
        available: backups.slice(0, 10).map((b) => b.id),
      });
    }
    if (matches.length > 1) {
      throw businessError('BACKUP_AMBIGUOUS', `"${timestamp}" matches ${matches.length} backups`, {
        available: matches.map((b) => b.id),
      });
    }
    chosen = matches[0];
  } else {
    chosen = backups[0];
  }

  const manifest = readBackupManifest(chosen.dir);
  const actions = manifest.files.map((entry) => ({
    path: entry.path,
    absolute: join(home, ...entry.path.split('/')),
    from: join(chosen.dir, 'files', entry.path),
    sha256: entry.sha256 ?? null,
  }));

  for (const action of actions) {
    if (!existsSync(action.from)) {
      throw businessError(
        'BACKUP_INCOMPLETE',
        `${chosen.id}: stored copy missing for ${action.path}; refusing to restore a partial state`,
      );
    }
    if (action.sha256 && hashFile(action.from) !== action.sha256) {
      throw businessError('BACKUP_TAMPERED', `${chosen.id}: stored copy of ${action.path} does not match its checksum`);
    }
  }

  if (dryRun) return { backup: chosen.id, dryRun: true, actions };

  // Back up the present state so the rollback itself can be undone.
  const guardDir = join(backupsDir(repo), `${newStamp()}-rollback-guard`);
  const present = actions.filter((a) => existsSync(a.absolute));
  for (const action of present) {
    copyFile(action.absolute, join(guardDir, 'files', action.path));
  }
  writeFile(
    join(guardDir, 'manifest.json'),
    `${JSON.stringify(
      {
        reason: `undo of rollback ${chosen.id}`,
        created_at: new Date().toISOString(),
        base: home,
        files: present.map((a) => ({ path: a.path, sha256: hashFile(a.absolute) })),
      },
      null,
      2,
    )}\n`,
  );

  let restored = 0;
  let deleted = 0;
  for (const action of actions) {
    if (existsSync(action.from)) {
      copyFile(action.from, action.absolute);
      restored += 1;
    } else if (existsSync(action.absolute)) {
      // Not in the backup and not restorable: leave it, report it.
      log?.warn(`rollback: left in place (no stored copy): ${action.path}`);
    }
  }
  for (const action of actions) {
    if (!existsSync(action.from) && !existsSync(action.absolute)) deleted += 1;
  }

  return { backup: chosen.id, restored, deleted, guard: guardDir, actions };
};

const newStamp = () => new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
