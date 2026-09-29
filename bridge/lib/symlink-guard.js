/**
 * Refuse to touch a managed path that is actually a symbolic link.
 *
 * Why this is a hard stop rather than a warning
 * ---------------------------------------------
 * On a real machine we found this:
 *
 *   ~/.agents/skills  ->  ~/.claude/skills        (the authoritative source itself)
 *
 * Writing "into" that path does not create files under the target agent — it
 * writes straight back into the source. The result is self-inflicted damage:
 * the target ends up containing a copy of the source nested inside the source,
 * and the snapshot taken before the write becomes wrong too (it captured the
 * link target, not the linked path). Recovery stops being "run revoke" and
 * starts being "work out by hand what happened".
 *
 * So the planner refuses. The message names the link and its target, and offers
 * the two honest options: remove the link (and let the bridge own the path), or
 * leave it alone (and let the link keep doing its job, unmanaged).
 *
 * A plain directory in the same place is fine — that is the normal case after a
 * user removes the link, and it is what the sandbox tests exercise.
 */

import { existsSync, lstatSync, readlinkSync, realpathSync } from 'node:fs';
import { relative, resolve, sep } from 'node:path';
import { businessError } from './errors.js';
import { claudeDir, claudeJson, claudeRulesDoc, claudeSkillDir } from './paths.js';
import { ruleDest } from './manifest.js';

/** `link` rules are *supposed* to point at the source; every other mode is not. */
const isLinkRule = (rule) => rule.mode === 'link';

/** Directories a managed rule writes into (single-file rules return null). */
const ruleDestRoots = (rule, home) =>
  rule.mode === 'copy-tree' || rule.mode === 'copy-flat' ? [ruleDest(rule, home)] : [];

const readLinkTarget = (path) => {
  try {
    return readlinkSync(path);
  } catch {
    // Cannot resolve it: say so rather than guess. The point of this module is
    // to avoid acting on assumptions about links.
    return '<unresolvable>';
  }
};

/**
 * @returns {Array<{path: string, target: string, rule: object}>} offending links
 */
export const findSymlinkedDestinations = ({ home, manifest }) => {
  const out = [];
  const seen = new Set();
  for (const rule of manifest.managed) {
    if (isLinkRule(rule)) continue; // expected to be a symlink
    for (const candidate of [...ruleDestRoots(rule, home), ruleDest(rule, home)]) {
      if (seen.has(candidate) || !existsSync(candidate)) continue;
      seen.add(candidate);
      let stat;
      try {
        stat = lstatSync(candidate);
      } catch {
        continue;
      }
      if (!stat.isSymbolicLink()) continue;
      out.push({ path: candidate, target: readLinkTarget(candidate), rule });
    }
  }
  return out;
};

/**
 * The paths that make up the authoritative source. A managed destination must
 * never resolve into any of them.
 */
export const sourcePaths = (home) => [
  claudeDir(home),
  claudeSkillDir(home),
  claudeJson(home),
  claudeRulesDoc(home),
];

const realpathOfNearestExisting = (p) => {
  let probe = p;
  // Walk up until something exists, then resolve that. A destination that does
  // not exist yet still has a real location once its nearest parent is resolved.
  for (let i = 0; i < 64; i += 1) {
    if (existsSync(probe)) {
      const real = realpathSync(probe);
      return probe === p ? real : resolve(real, relative(probe, p));
    }
    const parent = resolve(probe, '..');
    if (parent === probe) return resolve(p);
    probe = parent;
  }
  return resolve(p);
};

const isWithin = (parent, child) => {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !rel.startsWith(`..${sep}`));
};

/**
 * Refuse when a managed destination lives inside the authoritative source.
 *
 * This catches the failure the symlink check cannot see: a link whose *target*
 * is the source, and any manifest that simply points at the wrong place. The
 * latter looks like a typo, but the consequence is that the bridge would copy
 * the source onto itself forever — a silent, growing mess in the one directory
 * the whole design treats as read-only.
 */
export const assertDestOutsideSource = ({ home, manifest }) => {
  const sources = sourcePaths(home).map((p) => ({ path: p, real: realpathOfNearestExisting(p) }));
  for (const rule of manifest.managed) {
    if (isLinkRule(rule)) continue; // a link rule exists precisely to point at the source
    const dest = ruleDest(rule, home);
    const realDest = realpathOfNearestExisting(dest);
    for (const source of sources) {
      if (isWithin(source.real, realDest)) {
        throw businessError(
          'TARGET_INSIDE_SOURCE',
          `${manifest.name}: refusing to write into the authoritative source.\n` +
            `  destination : ${dest}\n` +
            `  resolves to : ${realDest}\n` +
            `  inside      : ${source.path} (${source.real})\n\n` +
            `  The source is read-only by design — writing there would copy it onto\n` +
            `  itself. Fix the "${rule.kind}" rule's "to" in bridge/targets/${manifest.name}.json.`,
        );
      }
    }
  }
};

/** Resolve a path to its real location, tolerating a not-yet-existing leaf. */
export const realpathOf = (p) => realpathOfNearestExisting(p);

/**
 * Verify a `link` rule: the destination must exist, be a symlink, and resolve to
 * exactly the source directory the rule names.
 *
 * This exists so a hand-made symlink can be *declared* instead of ignored. If we
 * simply refused every symlinked destination, a user whose skills are already
 * shared by a link could not adopt that agent at all; if we simply ignored it,
 * a link pointing at the wrong place would go unnoticed. Declaring it makes the
 * relationship checkable — `doctor` reports it, and drift is a real finding.
 *
 * @returns {{ok: true, dest: string, source: string, target: string} | {ok: false, reason: string, dest: string, source: string, target: string|null}}
 */
export const verifyLinkRule = ({ home, rule }) => {
  const dest = ruleDest(rule, home);
  const source = resolve(claudeDir(home), rule.from);
  const sourceReal = realpathOfNearestExisting(source);

  if (!existsSync(dest)) {
    return { ok: false, reason: 'the destination does not exist', dest, source, target: null };
  }
  let stat;
  try {
    stat = lstatSync(dest);
  } catch (err) {
    return { ok: false, reason: `cannot stat it (${err.message})`, dest, source, target: null };
  }
  if (!stat.isSymbolicLink()) {
    return {
      ok: false,
      reason: 'it is a real directory/file, not a symlink — switch the rule to mode "copy-tree" if the bridge should own it',
      dest,
      source,
      target: null,
    };
  }
  const target = readLinkTarget(dest);
  const destReal = realpathOfNearestExisting(dest);
  if (destReal !== sourceReal) {
    return {
      ok: false,
      reason: `it points at ${destReal}, but the rule says it should point at ${sourceReal}`,
      dest,
      source,
      target,
    };
  }
  return { ok: true, dest, source, target };
};

/**
 * Throw when a `link` rule does not describe reality.
 *
 * An ABSENT destination is allowed: the planner emits a create-link action for
 * it (a junction on Windows, a symlink elsewhere). Every other mismatch — a
 * real directory in the link's place, or a link pointing somewhere else — is a
 * mis-declaration and stops the run before anything is snapshotted.
 */
export const assertLinkRulesHold = ({ home, manifest }) => {
  for (const rule of manifest.managed) {
    if (!isLinkRule(rule)) continue;
    const check = verifyLinkRule({ home, rule });
    if (check.ok) continue;
    if (!existsSync(check.dest)) continue; // planned: the bridge will create it
    throw businessError(
      'TARGET_LINK_WRONG',
      `${manifest.name}: the "${rule.kind}" rule is declared as a link but ${check.reason}.\n` +
        `  path   : ${check.dest}\n` +
        `  expected -> ${check.source}\n` +
        (check.target ? `  actual   -> ${check.target}\n` : '') +
        `\n  Fix one of the two:\n` +
        `    a) make it a link again:  ${linkCommand(check.dest, check.source)}\n` +
        `       (remove whatever sits at the path first — or simply delete it and\n` +
        `        let the bridge create the link on the next adopt/apply)\n` +
        `    b) change bridge/targets/${manifest.name}.json to a copying mode if the\n` +
        `       bridge should own that directory instead.`,
    );
  }
};

/** The platform's own way to make a directory link, for the fix-it hint above. */
const linkCommand = (dest, source) =>
  process.platform === 'win32'
    ? `cmd /c mklink /J "${dest}" "${source}"`
    : `ln -s "${source}" "${dest}"`;

/**
 * Throw when any managed destination is a symlink.
 * Called from the planner, so `plan` fails too — the user sees the problem
 * before anything is written, not after.
 */
export const assertNoSymlinkedDestinations = ({ home, manifest, context }) => {
  const links = findSymlinkedDestinations({ home, manifest });
  if (links.length === 0) return;

  const detail = links
    .map(
      (l) =>
        `  ${l.path}\n` +
        `    -> ${l.target}\n` +
        `    managed by: ${l.rule.kind} -> ${l.rule.to}`,
    )
    .join('\n');

  throw businessError(
    'TARGET_SYMLINK',
    `${manifest.name}: refusing to write through a symbolic link.\n${detail}\n\n` +
      `  Writing through the link would edit whatever it points at — possibly the\n` +
      `  authoritative source itself — so nothing was written.\n\n` +
      `  Choose one:\n` +
      `    a) remove the link and let the bridge own the path:\n` +
      `         rm "${links[0].path}"\n` +
      `       then re-run ${context ?? 'plan'};\n` +
      `    b) keep the link and stop managing that path: drop the matching rule from\n` +
      `       bridge/targets/${manifest.name}.json.\n\n` +
      `  \`doctor\` reports this condition too, so you can see it without running plan.`,
  );
};
