/**
 * Small filesystem primitives used by the bridge.
 *
 * Everything that writes goes through here so that the three safety rules are
 * enforced in exactly one place:
 *   1. every overwrite is preceded by a copy into a snapshot or backup;
 *   2. a failure aborts the run instead of skipping ahead (fail-fast);
 *   3. generated files that may contain expanded secrets get mode 600.
 */

import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, relative, sep } from 'node:path';

export const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex');

/**
 * Classify a from→to copy without performing it.
 * Shared by the file planner and the gate installer so both agree on what
 * "already identical" means — otherwise `plan` and `apply` could disagree.
 */
export const planFileOp = (from, to) => {
  if (!existsSync(to)) return 'add';
  return hashFile(from) === hashFile(to) ? 'keep' : 'update';
};

export const hashFile = (file) => sha256(readFileSync(file));

export const readText = (file) => readFileSync(file, 'utf8');

export const ensureDir = (dir, mode = 0o700) => {
  mkdirSync(dir, { recursive: true, mode });
  return dir;
};

/** Recursively list files under `root`, returned as POSIX-style relative paths. */
export const listFiles = (root) => {
  if (!existsSync(root)) return [];
  const out = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) walk(abs);
      else if (entry.isFile()) out.push(relative(root, abs).split(sep).join('/'));
      else if (entry.isSymbolicLink()) out.push(relative(root, abs).split(sep).join('/'));
    }
  };
  walk(root);
  return out.sort();
};

export const writeFile = (file, content, mode = 0o600) => {
  ensureDir(dirname(file));
  writeFileSync(file, content);
  chmodSync(file, mode);
};

export const copyFile = (from, to, mode) => {
  ensureDir(dirname(to));
  copyFileSync(from, to);
  const resolved = mode ?? (statSync(from).mode & 0o777);
  chmodSync(to, resolved);
};

/** Copy a whole directory tree, preserving relative layout. */
export const copyTree = (from, to) => {
  ensureDir(to);
  for (const rel of listFiles(from)) copyFile(join(from, rel), join(to, rel));
};

export const removePath = (target) => {
  if (existsSync(target)) rmSync(target, { recursive: true, force: true });
};

export const exists = (target) => existsSync(target);

/**
 * Back up `files` (absolute paths) into `backupRoot` preserving their position
 * under `base`, and return a manifest describing what was saved.
 */
export const backupFiles = (files, base, backupRoot, meta = {}) => {
  const entries = [];
  for (const abs of files) {
    if (!existsSync(abs)) continue;
    const rel = relative(base, abs);
    const dest = join(backupRoot, 'files', rel);
    copyFile(abs, dest);
    entries.push({ path: rel.split(sep).join('/'), sha256: hashFile(abs) });
  }
  ensureDir(backupRoot);
  const manifest = { ...meta, created_at: new Date().toISOString(), base, files: entries };
  writeFile(join(backupRoot, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 0o600);
  return manifest;
};
