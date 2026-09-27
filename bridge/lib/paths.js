/**
 * Every path the bridge touches, derived from two roots:
 *   - home   : the user's home directory (overridable, used by the sandbox harness)
 *   - repo   : this repository's checkout directory
 *
 * Nothing here may hard-code an absolute path. The repository is expected to be
 * cloned anywhere; `home` is expected to be overridable so tests can run against
 * a throwaway copy instead of the real machine.
 *
 * Layout:
 *   <home>/.claude/                  authoritative source directory
 *   <home>/.claude.json              authoritative source MCP declarations
 *   <home>/.config/agent-config-bridge/secrets.env   real values (NEVER in the repo)
 *   <repo>/.bridge/                  per-machine state, snapshots and backups (gitignored)
 */

import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

export const repoRoot = () => resolve(HERE, '..', '..');

export const claudeDir = (home) => join(home, '.claude');
export const claudeSkillDir = (home) => join(home, '.claude', 'skills');
export const claudeCommandDir = (home) => join(home, '.claude', 'commands');
export const claudeAgentDir = (home) => join(home, '.claude', 'agents');
export const claudeRulesDoc = (home) => join(home, '.claude', 'CLAUDE.md');
export const claudeJson = (home) => join(home, '.claude.json');

/** Where the user keeps real secret values. Outside the repo, by design. */
export const secretsFile = (home) => join(home, '.config', 'agent-config-bridge', 'secrets.env');

/** Per-machine state, snapshots and backups live inside the repo checkout. */
export const stateDir = (repo) => join(repo, '.bridge');
export const stateFile = (repo) => join(stateDir(repo), 'state.json');
export const snapshotsDir = (repo) => join(stateDir(repo), 'snapshots');
export const backupsDir = (repo) => join(stateDir(repo), 'backups');
export const lastApplyFile = (repo) => join(stateDir(repo), 'last-apply.json');
export const targetsDir = (repo) => join(repo, 'bridge', 'targets');

export const resolveHome = (override) => (override ? resolve(override) : homedir());

/**
 * Resolve a target-side path declared in a `bridge/targets/*.json` manifest.
 * Manifest paths are always relative to the home directory and written with
 * forward slashes, so they survive being authored on any platform.
 */
export const targetPath = (home, relPath) => join(home, ...relPath.split('/'));

/** Convert an absolute path under `home` back to the manifest's relative form. */
export const relFromHome = (home, absPath) => {
  const prefix = home.endsWith('/') ? home : `${home}/`;
  if (!absPath.startsWith(prefix)) return null;
  return absPath.slice(prefix.length);
};

export const isInside = (parent, child) => {
  const p = parent.endsWith('/') ? parent : `${parent}/`;
  return child === parent || child.startsWith(p);
};
