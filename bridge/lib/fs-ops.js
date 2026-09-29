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
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
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

/**
 * Create a directory link, in the strongest form the platform allows.
 *
 * Windows: a junction first. An unprivileged process can create one without
 * Developer Mode or elevation, and Node reports it as a symbolic link
 * (`lstat().isSymbolicLink()` is true, `readlinkSync` returns the target), so
 * every link-aware path in this codebase treats the two the same. A real
 * symlink (type 'dir') is the fallback when junctions are unavailable.
 * POSIX: a symbolic link; `type` is ignored there.
 *
 * The type is passed as a bare string on purpose: Node silently ignores an
 * unknown type passed as `{ type: 'junction' }` AND falls back to the
 * privileged form, so the object form never creates a working junction when
 * the process is not elevated.
 */
export const makeDirLink = (target, path) => {
  ensureDir(dirname(path));
  const types = process.platform === 'win32' ? ['junction', 'dir'] : [undefined];
  let lastError = null;
  for (const type of types) {
    try {
      symlinkSync(target, path, type);
      return;
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError;
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
  let stat;
  try {
    stat = lstatSync(target);
  } catch {
    return; // already gone
  }
  if (stat.isSymbolicLink()) {
    // Remove the link itself, never what it points at. Node reports a Windows
    // junction as a symbolic link; unlink deletes the reparse point without
    // following it (verified on Node 22 / Windows 11), and on POSIX it is the
    // ordinary way to delete a symlink. Removing a link with rmSync(recursive)
    // is what an earlier revision did — safe on current Node, but one
    // regression away from deleting the source through the link, and the whole
    // design treats the source as read-only.
    unlinkSync(target);
    return;
  }
  rmSync(target, { recursive: true, force: true });
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
    let st;
    try {
      st = lstatSync(abs);
    } catch {
      continue;
    }
    // A link is not backed up. `copyFile` follows it and copies the target's
    // bytes (and on a Windows junction it fails with EPERM outright), while
    // restoring that copy would silently replace a link with a directory tree.
    // The one link this bridge creates — the skills link — is recreated by
    // `apply` and removed by `revoke`; neither path needs its bytes here.
    if (st.isSymbolicLink()) continue;
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
