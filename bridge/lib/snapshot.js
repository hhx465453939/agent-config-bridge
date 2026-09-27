/**
 * Snapshots — how `revoke` can honestly promise "put it back the way it was".
 *
 * A snapshot records, for one agent, everything the bridge is about to change,
 * relative to the HOME directory:
 *
 *   created     the file did not exist; rollback deletes it
 *   overwritten the previous bytes are copied into files/; rollback restores them
 *   removed     the file was deleted by --prune; the bytes are copied; rollback puts it back
 *
 * Snapshots live inside the repository checkout (`.bridge/snapshots/`), which is
 * deliberately NOT a backup location for the repository itself — it is the
 * "before" picture of the machine's agent configuration.
 *
 * `revoke` refuses to run on an incomplete snapshot. A half-restored config that
 * reports success is worse than an error.
 */

import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { businessError } from './errors.js';
import { copyFile, ensureDir, hashFile, sha256, writeFile } from './fs-ops.js';
import { snapshotsDir } from './paths.js';

export const SNAPSHOT_ACTIONS = { CREATED: 'created', OVERWRITTEN: 'overwritten', REMOVED: 'removed' };

/**
 * Snapshot ids must be unique. This is a correctness requirement, not cosmetics.
 *
 * They used to be second-resolution timestamps, so an `adopt` immediately
 * followed by an `apply` computed the same id, wrote into the *same* directory,
 * and the second `finalize()` overwrote the first manifest — silently erasing
 * the record of everything the adopt had created. `revoke` then had nothing to
 * undo and reported success anyway. Reproduced in the test suite with two
 * operations in the same second.
 *
 * Millisecond resolution plus a uniqueness check in createSnapshot makes the
 * collision impossible rather than merely unlikely. The format stays
 * lexicographically sortable, which listSnapshots relies on.
 */
export const newSnapshotId = (date = new Date()) =>
  date.toISOString().replace(/[-:]/g, '').replace('.', '');

const uniqueId = (repo, agent, base) => {
  if (!existsSync(snapshotDir(repo, agent, base))) return base;
  for (let n = 2; n < 1000; n += 1) {
    const candidate = `${base}-${n}`;
    if (!existsSync(snapshotDir(repo, agent, candidate))) return candidate;
  }
  throw businessError('SNAPSHOT_ID', `cannot allocate a snapshot id for ${agent} at ${base}`);
};

export const snapshotDir = (repo, agent, id) => join(snapshotsDir(repo), agent, id);

export const createSnapshot = (repo, agent, { sourceLabel, plan }) => {
  const id = uniqueId(repo, agent, newSnapshotId());
  const dir = snapshotDir(repo, agent, id);
  ensureDir(dir);
  const entries = [];
  return {
    id,
    dir,
    entries,
    sourceLabel,
    add: (entry) => entries.push(entry),
    finalize: () => finalize(dir, agent, id, sourceLabel, entries),
  };
};

const finalize = (dir, agent, id, sourceLabel, entries) => {
  const manifest = {
    agent,
    snapshot_id: id,
    created_at: new Date().toISOString(),
    source: sourceLabel,
    entries: entries.slice().sort((a, b) => a.path.localeCompare(b.path)),
  };
  writeFile(join(dir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 0o600);
  // Deliberately no pruning here. Revoke replays every surviving snapshot, so
  // dropping old ones mid-adoption would silently shrink what revoke can undo.
  // Pruning happens once, on a successful revoke (see revoke.js).
  return manifest;
};

/**
 * Keep the newest `keep` snapshots for one agent; delete the rest.
 *
 * Only safe to call when the snapshots are no longer needed to undo an
 * adoption — i.e. after revoke has finished, where one historical record is
 * kept for the audit trail.
 */
export const pruneSnapshots = (repo, agent, keep) => {
  const dir = join(snapshotsDir(repo), agent);
  if (!existsSync(dir)) return [];
  const ids = readdirSync(dir).sort();
  const excess = ids.slice(0, Math.max(0, ids.length - keep));
  for (const old of excess) rmSync(join(dir, old), { recursive: true, force: true });
  return excess;
};

/** Every snapshot for an agent, oldest first, each with its parsed manifest. */
export const agentSnapshots = (repo, agent) => {
  return listSnapshots(repo, agent)
    .slice()
    .reverse() // listSnapshots is newest-first
    .map((id) => ({ id, ...readSnapshot(repo, agent, id) }));
};

/**
 * Build the plan that undoes an entire adoption.
 *
 * Why this replays *every* snapshot instead of just the newest one:
 *
 * `adopt` records which paths it created, then each later `apply` takes its own
 * snapshot and updates `state.snapshot_id`. If revoke trusted only the latest
 * pointer it would know about the handful of files the last apply happened to
 * touch — and would happily report success while leaving everything else, the
 * installed gate included, sitting on disk. That is the failure this function
 * exists to prevent.
 *
 * Replaying oldest-first and keeping the FIRST mention of each path yields the
 * pre-adopt state: a path first seen as `created` gets deleted, a path first
 * seen as `overwritten` gets its earliest stored bytes back.
 *
 * @returns {{snapshots: string[], entries: Array<object>}|null} null when the
 *          agent has no snapshots at all
 */
export const planRevoke = (repo, agent, home) => {
  const snapshots = agentSnapshots(repo, agent);
  if (snapshots.length === 0) return null;

  const seen = new Map();
  for (const snap of snapshots) {
    for (const entry of snap.manifest.entries) {
      if (seen.has(entry.path)) continue; // oldest wins: that is the pre-adopt state
      seen.set(entry.path, { ...entry, snapshotId: snap.id, snapshotDir: snap.dir });
    }
  }

  return { snapshots: snapshots.map((s) => s.id), entries: [...seen.values()] };
};

/**
 * Verify a full revoke plan can actually be applied.
 * @returns {{ok: boolean, problems: string[]}}
 */
export const verifyRevokePlan = (plan) => {
  const problems = [];
  for (const entry of plan.entries) {
    if (entry.action === SNAPSHOT_ACTIONS.CREATED) continue;
    const stored = join(entry.snapshotDir, 'files', entry.path);
    if (!existsSync(stored)) {
      problems.push(`missing stored copy of ${entry.path} (snapshot ${entry.snapshotId})`);
      continue;
    }
    if (entry.sha256 && hashFile(stored) !== entry.sha256) {
      problems.push(
        `stored copy of ${entry.path} does not match its recorded checksum (snapshot ${entry.snapshotId})`,
      );
    }
  }
  return { ok: problems.length === 0, problems };
};

export const readSnapshot = (repo, agent, id) => {
  const dir = snapshotDir(repo, agent, id);
  const file = join(dir, 'manifest.json');
  if (!existsSync(file)) {
    throw businessError('SNAPSHOT_MISSING', `no snapshot ${id} for ${agent} (looked for ${file})`);
  }
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    throw businessError('SNAPSHOT_CORRUPT', `${file}: not valid JSON (${err.message})`);
  }
  if (!Array.isArray(parsed.entries)) {
    throw businessError('SNAPSHOT_CORRUPT', `${file}: missing "entries" array`);
  }
  return { dir, manifest: parsed };
};

export const listSnapshots = (repo, agent) => {
  const dir = join(snapshotsDir(repo), agent);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => existsSync(join(dir, name, 'manifest.json')))
    .sort()
    .reverse();
};

export const latestSnapshot = (repo, agent) => listSnapshots(repo, agent)[0] ?? null;

/**
 * Verify a snapshot can actually be applied back.
 * @returns {{ok: boolean, problems: string[]}}
 */
export const verifySnapshot = (repo, agent, id, home) => {
  const { dir, manifest } = readSnapshot(repo, agent, id);
  const problems = [];
  for (const entry of manifest.entries) {
    if (entry.action === SNAPSHOT_ACTIONS.CREATED) continue;
    const stored = join(dir, 'files', entry.path);
    if (!existsSync(stored)) {
      problems.push(`missing stored copy of ${entry.path}`);
      continue;
    }
    if (entry.sha256 && hashFile(stored) !== entry.sha256) {
      problems.push(`stored copy of ${entry.path} does not match its recorded checksum`);
    }
  }
  return { ok: problems.length === 0, problems, manifest, dir, home };
};

/** Record the side effects produced by applying a plan. */
export const recordFromPlan = (snapshot, { home, plan }) => {
  const seen = new Set();
  for (const action of plan.actions) {
    if (action.op === 'keep') continue;
    const rel = action.to.slice(home.length + 1);
    if (seen.has(rel)) continue;
    seen.add(rel);

    if (action.op === 'remove') {
      const stored = join(snapshot.dir, 'files', rel);
      copyFile(action.to, stored);
      snapshot.add({ path: rel, action: SNAPSHOT_ACTIONS.REMOVED, sha256: hashFile(action.to) });
      continue;
    }

    if (existsSync(action.to)) {
      const stored = join(snapshot.dir, 'files', rel);
      copyFile(action.to, stored);
      snapshot.add({
        path: rel,
        action: SNAPSHOT_ACTIONS.OVERWRITTEN,
        sha256: hashFile(action.to),
      });
    } else {
      snapshot.add({ path: rel, action: SNAPSHOT_ACTIONS.CREATED });
    }
  }
  return snapshot;
};
