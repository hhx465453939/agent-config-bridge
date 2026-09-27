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
const KEEP = 5;

export const newSnapshotId = (date = new Date()) =>
  date.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z').replace('T', 'T');

export const snapshotDir = (repo, agent, id) => join(snapshotsDir(repo), agent, id);

export const createSnapshot = (repo, agent, { sourceLabel, plan }) => {
  const id = newSnapshotId();
  const dir = snapshotDir(repo, agent, id);
  ensureDir(dir);
  const entries = [];
  return { id, dir, entries, sourceLabel, add: (entry) => entries.push(entry), finalize: () => finalize(dir, agent, id, sourceLabel, entries) };
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
  pruneSnapshots(dir);
  return manifest;
};

/** Keep the newest KEEP snapshots for this agent; drop the rest. */
const pruneSnapshots = (dir) => {
  const agentRoot = join(dir, '..');
  const ids = readdirSync(agentRoot).sort();
  const excess = ids.slice(0, Math.max(0, ids.length - KEEP));
  for (const old of excess) rmSync(join(agentRoot, old), { recursive: true, force: true });
  return excess;
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
