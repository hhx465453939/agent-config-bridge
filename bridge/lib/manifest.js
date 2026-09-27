/**
 * Target manifests — the only place that knows how any particular agent lays
 * out its global configuration.
 *
 * Rules enforced here (not by convention, by code):
 *   - a manifest must declare `managed` and `never_touch`;
 *   - the two sets must not overlap, otherwise the bridge would both promise to
 *     leave a path alone and overwrite it;
 *   - `to` paths are always relative to the home directory and never escape it;
 *   - `from` paths are always relative to the authoritative source root.
 *
 * Adding support for a new agent therefore means adding a JSON file, not
 * editing the engine.
 */

import { existsSync, readdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { businessError, envError } from './errors.js';
import { targetPath, targetsDir } from './paths.js';

const MODES = new Set(['copy', 'copy-tree', 'copy-flat', 'mcp-json', 'mcp-toml', 'link']);
const KINDS = new Set(['skill', 'command', 'agent', 'rules-doc', 'mcp']);

const normalize = (relPath) => relPath.replace(/\/+$/, '');

/** Home-relative gate directory, when the manifest declares one. */
const rawGatesDir = (manifest) => {
  const g = manifest?.gates;
  if (!g || g.supported === false) return null;
  if (typeof g.extension_dir !== 'string' || typeof g.install_as !== 'string') return null;
  return normalize(`${g.extension_dir}/${g.install_as}`);
};

const assertRelative = (value, field, target) => {
  if (typeof value !== 'string' || value.length === 0) {
    throw businessError('MANIFEST_INVALID', `${target}: "${field}" must be a non-empty string`);
  }
  if (value.startsWith('/') || /^[A-Za-z]:/.test(value)) {
    throw businessError('MANIFEST_INVALID', `${target}: "${field}" must be relative, got ${value}`);
  }
  if (value.split('/').includes('..')) {
    throw businessError('MANIFEST_INVALID', `${target}: "${field}" must not contain ".." (${value})`);
  }
  return value;
};

const validate = (manifest, file) => {
  const name = manifest.name;
  if (typeof name !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(name)) {
    throw businessError('MANIFEST_INVALID', `${file}: "name" must be a lowercase slug`);
  }
  if (!Array.isArray(manifest.managed)) {
    throw businessError('MANIFEST_INVALID', `${file}: "managed" must be an array`);
  }
  if (!Array.isArray(manifest.never_touch)) {
    throw businessError('MANIFEST_INVALID', `${file}: "never_touch" must be an array`);
  }

  const managed = manifest.managed.map((rule, i) => {
    const where = `${file}#managed[${i}]`;
    if (!KINDS.has(rule.kind)) {
      throw businessError('MANIFEST_INVALID', `${where}: unknown kind ${JSON.stringify(rule.kind)}`);
    }
    if (!MODES.has(rule.mode)) {
      throw businessError('MANIFEST_INVALID', `${where}: unknown mode ${JSON.stringify(rule.mode)}`);
    }
    return {
      kind: rule.kind,
      mode: rule.mode,
      from: assertRelative(rule.from, 'from', where),
      to: assertRelative(rule.to, 'to', where),
      note: rule.note ?? null,
    };
  });

  const neverTouch = manifest.never_touch.map((p, i) =>
    normalize(assertRelative(p, `never_touch[${i}]`, file)),
  );

  // Overlap check. A rule's destination directory covers every path beneath it,
  // so a never_touch entry nested inside a managed destination is a conflict.
  //
  // One documented exception: the gate install directory. Declaring ".pi/agent/extensions"
  // off-limits is the right promise (the bridge must never rewrite someone's
  // other extensions) while the gate still has to live inside it. The exception
  // is narrow — one exact subdirectory, named by the manifest itself — and it is
  // reported by `doctor` rather than being invisible.
  const gateDir = rawGatesDir(manifest);
  const overlaps = (dest, guard) => {
    if (guard === gateDir || guard.startsWith(`${gateDir}/`)) return false;
    return guard === dest || guard.startsWith(`${dest}/`) || dest.startsWith(`${guard}/`);
  };

  for (const rule of managed) {
    const dest = normalize(rule.to);
    for (const guard of neverTouch) {
      if (overlaps(dest, guard)) {
        throw businessError(
          'MANIFEST_CONFLICT',
          `${file}: managed destination "${rule.to}" overlaps never_touch "${guard}".\n` +
            `  A path cannot be both maintained and off-limits — fix the manifest.`,
        );
      }
    }
  }

  return {
    name,
    display: manifest.display ?? name,
    detect: Array.isArray(manifest.detect) ? manifest.detect : [],
    homeHint: manifest.home_hint ?? null,
    verified: manifest.verified !== false,
    notes: manifest.notes ?? null,
    managed,
    neverTouch,
    gates: validateGates(manifest.gates, file, name),
    file,
  };
};

/**
 * The gate block. Optional, but a harness only gets gates if it declares where
 * its extension mechanism looks; guessing that would install code into a
 * directory the harness never reads, which is the worst kind of silent failure.
 */
const validateGates = (raw, file, targetName) => {
  if (raw === undefined || raw === null || raw.supported === false) {
    return { supported: false, reason: raw?.reason ?? 'no extension mechanism declared' };
  }
  if (typeof raw !== 'object') {
    throw businessError('MANIFEST_INVALID', `${file}: "gates" must be an object or false`);
  }
  const adapter = raw.adapter;
  if (adapter !== 'pi' && adapter !== 'dsh') {
    throw businessError(
      'MANIFEST_INVALID',
      `${file}: gates.adapter must be "pi" or "dsh" (got ${JSON.stringify(adapter)})`,
    );
  }
  const installAs = raw.install_as;
  if (typeof installAs !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(installAs)) {
    throw businessError('MANIFEST_INVALID', `${file}: gates.install_as must be a lowercase slug`);
  }
  return {
    supported: true,
    adapter,
    install_as: installAs,
    extension_dir: assertRelative(raw.extension_dir, 'gates.extension_dir', file),
    policy: raw.policy ?? {},
    mount_hint: raw.mount_hint ?? null,
    auto_load: raw.auto_load !== false,
  };
};

export const loadManifest = (repo, name) => {
  const file = join(targetsDir(repo), `${name}.json`);
  if (!existsSync(file)) {
    throw envError('TARGET_UNKNOWN', `no manifest for target "${name}" (looked for ${file})`);
  }
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    throw businessError('MANIFEST_INVALID', `${file}: not valid JSON (${err.message})`);
  }
  return validate(parsed, file);
};

export const loadAllManifests = (repo) => {
  const dir = targetsDir(repo);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => loadManifest(repo, f.replace(/\.json$/, '')))
    .sort((a, b) => a.name.localeCompare(b.name));
};

/**
 * Is this target present on this machine?
 * `detect` entries are home-relative paths; any one of them existing is enough.
 */
export const detectTarget = (manifest, home) => {
  if (manifest.detect.length === 0) return false;
  return manifest.detect.some((rel) => existsSync(targetPath(home, rel)));
};

/** Absolute destination for one managed rule. */
export const ruleDest = (rule, home) => targetPath(home, rule.to);

export { MODES, KINDS };
