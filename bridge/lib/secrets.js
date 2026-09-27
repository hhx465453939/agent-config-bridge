/**
 * Secrets: real values live OUTSIDE the repository.
 *
 *   <home>/.config/agent-config-bridge/secrets.env   (mode 600)
 *
 * The repository only ever contains `${VAR}` placeholders, so a published copy
 * can never leak a key. When a placeholder has no value we fail closed: the run
 * aborts instead of writing an empty string into a config file (which surfaces
 * later as a baffling "unauthorized" error).
 */

import { existsSync, chmodSync, readFileSync } from 'node:fs';
import { businessError, envError } from './errors.js';
import { secretsFile } from './paths.js';

const PLACEHOLDER = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

export const parseEnvFile = (text) => {
  const out = {};
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let value = m[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[m[1]] = value;
  }
  return out;
};

/**
 * Load secrets with `process.env` taking precedence over the file, so a user can
 * override one value for a single run without editing anything on disk.
 */
export const loadSecrets = (home, env = process.env) => {
  const file = secretsFile(home);
  let fromFile = {};
  if (existsSync(file)) {
    fromFile = parseEnvFile(readFileSync(file, 'utf8'));
    try {
      chmodSync(file, 0o600);
    } catch {
      /* best effort: a readonly mount must not break the run */
    }
  }
  return { file: existsSync(file) ? file : null, values: { ...fromFile, ...env } };
};

export const placeholdersIn = (value) => {
  if (typeof value !== 'string') return [];
  return [...value.matchAll(PLACEHOLDER)].map((m) => m[1]);
};

/**
 * Expand `${VAR}` in a string.
 * @param {string} value
 * @param {Record<string,string>} secrets
 * @param {{context?: string, missing?: Set<string>}} [opts]
 */
export const expand = (value, secrets, opts = {}) => {
  const missing = opts.missing ?? new Set();
  const out = value.replace(PLACEHOLDER, (_, name) => {
    const found = secrets[name];
    if (found === undefined || found === '') {
      missing.add(name);
      return '';
    }
    return found;
  });
  return out;
};

/** Expand a whole record, collecting every missing variable along the way. */
export const expandRecord = (record, secrets) => {
  const missing = new Set();
  const out = {};
  for (const [key, value] of Object.entries(record ?? {})) {
    out[key] = expand(String(value), secrets, { missing });
  }
  return { value: out, missing };
};

/**
 * Fail-closed gate. Call this before writing anything that contains expanded
 * placeholders. A single missing variable aborts the entire run.
 */
export const assertNoMissing = (missing, context) => {
  if (missing.size === 0) return;
  const names = [...missing].sort().join(', ');
  throw businessError(
    'SECRETS_MISSING',
    `${context}: referenced but not provided: ${names}\n` +
      `  put them in ~/.config/agent-config-bridge/secrets.env (mode 600), or export them.\n` +
      `  nothing was written.`,
  );
};

export const requireSecretsFileHint = (home) => {
  const file = secretsFile(home);
  return existsSync(file)
    ? null
    : envError(
        'SECRETS_FILE_MISSING',
        `no secrets file at ${file}\n` +
          `  create it with:\n` +
          `    mkdir -p ~/.config/agent-config-bridge\n` +
          `    cp templates/secrets.env.example ~/.config/agent-config-bridge/secrets.env\n` +
          `    chmod 600 ~/.config/agent-config-bridge/secrets.env`,
      );
};

export { PLACEHOLDER };
