/**
 * State file: the single source of truth for "which agent is bridged".
 *
 *   <repo>/.bridge/state.json
 *
 * Three-state model (ADR-002):
 *   native  — default. This project does not touch the agent at all.
 *   bridged — the user ran `adopt`. Shared dimensions follow the source.
 *   revoked — the user ran `revoke`. Original config restored, record kept.
 *
 * Failure policy:
 *   - missing file        → everything is native (safe default, not an error)
 *   - unreadable/corrupt  → refuse to act; never guess, never silently reset
 *
 * A corrupt state file is a hard stop because "guess what the user meant" in a
 * tool that overwrites other agents' configuration is how people lose data.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { businessError } from './errors.js';
import { stateDir, stateFile } from './paths.js';

export const STATUS = { NATIVE: 'native', BRIDGED: 'bridged', REVOKED: 'revoked' };
const VALID_STATUS = new Set(Object.values(STATUS));
const FORMAT = 1;

const emptyState = () => ({ version: FORMAT, agents: {} });

/**
 * @returns {{version:number, agents:Record<string,object>}}
 * @throws {BridgeError} when the file exists but cannot be trusted
 */
export const readState = (repo) => {
  const file = stateFile(repo);
  if (!existsSync(file)) return emptyState();

  let raw;
  try {
    raw = readFileSync(file, 'utf8');
  } catch (err) {
    throw businessError('STATE_UNREADABLE', `cannot read state file ${file}: ${err.message}`);
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw businessError(
      'STATE_CORRUPT',
      `state file is not valid JSON: ${file}\n` +
        `  fix it, or delete it to return every agent to native\n` +
        `  (${err.message})`,
    );
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw businessError('STATE_CORRUPT', `state file must contain a JSON object: ${file}`);
  }
  if (parsed.version !== FORMAT) {
    throw businessError(
      'STATE_VERSION',
      `unsupported state format ${JSON.stringify(parsed.version)} (expected ${FORMAT}): ${file}`,
    );
  }
  if (!parsed.agents || typeof parsed.agents !== 'object' || Array.isArray(parsed.agents)) {
    throw businessError('STATE_CORRUPT', `state file is missing an "agents" object: ${file}`);
  }

  const agents = {};
  for (const [name, entry] of Object.entries(parsed.agents)) {
    if (!entry || typeof entry !== 'object') {
      throw businessError('STATE_CORRUPT', `state entry for "${name}" must be an object`);
    }
    if (!VALID_STATUS.has(entry.status)) {
      throw businessError(
        'STATE_CORRUPT',
        `state entry for "${name}" has unknown status ${JSON.stringify(entry.status)}`,
      );
    }
    agents[name] = { ...entry };
  }

  return { version: FORMAT, agents };
};

export const writeState = (repo, state) => {
  const dir = stateDir(repo);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = stateFile(repo);
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  renameSync(tmp, file);
};

/** Status for one agent; unknown agents are native (never adopted). */
export const statusOf = (state, agent) => state.agents[agent]?.status ?? STATUS.NATIVE;

export const listBridged = (state) =>
  Object.entries(state.agents)
    .filter(([, entry]) => entry.status === STATUS.BRIDGED)
    .map(([name]) => name)
    .sort();

export const setAgent = (state, agent, patch) => {
  const next = { ...(state.agents[agent] ?? {}), ...patch };
  if (!VALID_STATUS.has(next.status)) {
    throw businessError('STATE_INVALID', `refusing to store invalid status for "${agent}"`);
  }
  return { ...state, agents: { ...state.agents, [agent]: next } };
};

/**
 * Tracked paths are CUMULATIVE, never replaced.
 *
 * `--prune` may only delete a file the bridge itself created, so the record of
 * "what have we ever created here" has to outlive the moment of creation. If a
 * refresh overwrote this set with the *current* derived files, then a file whose
 * source disappeared would immediately look user-made and become un-prunable.
 * A stale entry is harmless: pruning merely tries to delete a path that is
 * already gone.
 */
export const mergeTracked = (previous, current) =>
  [...new Set([...(previous ?? []), ...(current ?? [])])].sort();

/** Snapshot directory for one agent inside the repository checkout. */
export const agentSnapshotDir = (repo, agent, snapshotId) =>
  join(stateDir(repo), 'snapshots', agent, snapshotId);

export { FORMAT };
