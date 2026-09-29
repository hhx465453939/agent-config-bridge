/**
 * The planner: turns "what the source has" + "what the target has" into an
 * explicit, reviewable list of file operations.
 *
 * `plan` and `apply` run the exact same builder; `apply` simply performs the
 * operations `plan` listed. That keeps the dry run honest — a promise that the
 * preview matches reality is only credible when there is literally one code path.
 *
 * Operations are one of:
 *   add     target file does not exist
 *   update  target file exists with different content
 *   keep    target file exists with identical content (no write)
 *   remove  target file is a previously-derived artefact and --prune was given
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { businessError } from './errors.js';
import { hashFile, listFiles, sha256 } from './fs-ops.js';
import { detectTarget, loadManifest, ruleDest } from './manifest.js';
import { planGateInstall } from './gates.js';
import { assertNoSymlinkedDestinations, assertDestOutsideSource, assertLinkRulesHold } from './symlink-guard.js';
import { classifyMcpServer, scanSource } from './source.js';
import { emitMcpJson, emitMcpToml, readIfExists } from './mcp.js';
import { assertNoMissing, loadSecrets } from './secrets.js';
import { agentSnapshotDir, STATUS } from './state.js';
import { claudeDir, isInside, targetPath } from './paths.js';

const OP = { ADD: 'add', UPDATE: 'update', KEEP: 'keep', REMOVE: 'remove' };

/**
 * Build the plan for one target.
 *
 * @param {object} ctx
 * @param {string} ctx.home
 * @param {string} ctx.repo
 * @param {object} ctx.manifest
 * @param {object} ctx.source      result of scanSource(home)
 * @param {object} ctx.secrets
 * @param {object} ctx.stateEntry  previous state entry for this target (or undefined)
 * @param {boolean} ctx.prune
 */
export const planTarget = ({ home, repo, manifest, source, secrets, stateEntry, prune }) => {
  // Three refusals before anything is planned, all aimed at the same class of
  // mistake: a destination that is not really the target's own directory.
  //   1. a `link` rule must describe reality (right target, actually a link)
  //   2. the source is read-only by design — never write into it
  //   3. any other symlinked destination would send writes through the link
  assertLinkRulesHold({ home, manifest });
  assertDestOutsideSource({ home, manifest });
  assertNoSymlinkedDestinations({ home, manifest, context: 'plan' });

  const actions = [];
  const warnings = [];
  const info = { unsupportedMcp: [], flatDuplicates: 0, derivedMcp: [] };
  const trackedBefore = new Set(stateEntry?.tracked ?? []);

  const pushFile = ({ kind, from, to, note }) => {
    const exists = existsSync(to);
    let op = OP.ADD;
    if (exists) {
      try {
        op = hashFile(from) === hashFile(to) ? OP.KEEP : OP.UPDATE;
      } catch (err) {
        throw businessError('READ_FAILED', `cannot compare ${from} and ${to}: ${err.message}`);
      }
    }
    actions.push({ kind, op, from, to, note: note ?? null });
  };

  for (const rule of manifest.managed) {
    if (rule.mode === 'link') {
      // The destination is a symlink into the source by declaration. When it
      // already exists there is nothing to copy and nothing to compare: the
      // agent reads the source directly, so a change there is visible
      // immediately with no apply step. assertLinkRulesHold above verified the
      // link is honest — or absent.
      //
      // When it is absent, the bridge CREATES it. That is the step the user had
      // to perform by hand before adopting (and the step that made `adopt pi`
      // fail on a fresh machine with "the destination does not exist"). A
      // junction is used on Windows because an unprivileged process can create
      // one; `makeDirLink` picks the form.
      const source = join(claudeDir(home), rule.from);
      const dest = ruleDest(rule, home);
      if (existsSync(dest)) {
        actions.push({
          kind: rule.kind,
          op: OP.KEEP,
          from: source,
          to: dest,
          note: `declared link to ${rule.from}`,
          link: true,
        });
      } else if (existsSync(source)) {
        actions.push({
          kind: rule.kind,
          op: OP.ADD,
          from: source,
          to: dest,
          note: `create link to ${rule.from}`,
          link: true,
          linkTarget: source,
        });
      } else {
        // Nothing to link to. Say so instead of surfacing an ENOENT from the
        // middle of a write. The target keeps its own directory either way.
        warnings.push(
          `source ${rule.from} does not exist; ${manifest.name} keeps its own ${rule.kind} directory`,
        );
      }
      continue;
    }

    if (rule.kind === 'skill') {
      const destRoot = ruleDest(rule, home);
      const seen = new Set();
      for (const skill of source.skills.skills) {
        seen.add(skill.name);
        for (const rel of skill.files) {
          pushFile({
            kind: 'skill',
            from: join(skill.dir, rel),
            to: join(destRoot, skill.name, rel),
            note: `skill ${skill.name}`,
          });
        }
      }
      info.flatDuplicates += source.skills.flatDuplicates.length;
      if (prune) collectRemovals(actions, destRoot, seen, trackedBefore, 'skill');
      continue;
    }

    if (rule.kind === 'command') {
      const destRoot = ruleDest(rule, home);
      const seen = new Set();
      for (const cmd of source.commands.commands) {
        seen.add(`${cmd.name}.md`);
        pushFile({ kind: 'command', from: cmd.file, to: join(destRoot, `${cmd.name}.md`) });
      }
      if (prune) collectRemovals(actions, destRoot, seen, trackedBefore, 'command');
      continue;
    }

    if (rule.kind === 'agent') {
      const destRoot = ruleDest(rule, home);
      const seen = new Set();
      for (const agent of source.agents.agents) {
        seen.add(`${agent.name}.md`);
        pushFile({ kind: 'agent', from: agent.file, to: join(destRoot, `${agent.name}.md`) });
      }
      if (prune) collectRemovals(actions, destRoot, seen, trackedBefore, 'agent');
      continue;
    }

    if (rule.kind === 'rules-doc') {
      const dest = ruleDest(rule, home);
      if (source.rulesDoc === null) {
        warnings.push(`source has no rules document; ${manifest.name} keeps its own`);
      } else {
        pushFile({ kind: 'rules-doc', from: source.rulesDoc, to: dest });
      }
      continue;
    }

    if (rule.kind === 'mcp') {
      const dest = ruleDest(rule, home);
      const classified = Object.entries(source.mcp.servers).map(([name, def]) =>
        classifyMcpServer(name, def),
      );
      const emit = rule.mode === 'mcp-toml' ? emitMcpToml : emitMcpJson;
      const result = emit({
        existingText: readIfExists(dest),
        classified,
        derivedNames: stateEntry?.derivedMcp ?? [],
        secrets,
        prune,
        serverSettings: rule.serverSettings ?? null,
      });
      if (result.unsupported.length > 0) info.unsupportedMcp.push(...result.unsupported);
      info.derivedMcp = result.derived;
      if (result.missing.size > 0) {
        // Deferred: reported by the caller so the whole run aborts before writing.
        info.missingSecrets = [...(info.missingSecrets ?? []), ...result.missing];
      }
      const current = existsSync(dest) ? readFileSync(dest, 'utf8') : null;
      if (current !== result.text) {
        actions.push({
          kind: 'mcp',
          op: current === null ? OP.ADD : OP.UPDATE,
          from: `@mcpServers (${classified.length} server(s))`,
          to: dest,
          note: rule.mode,
          content: result.text,
          mode: 0o600,
          removes: result.removed,
        });
      } else {
        actions.push({
          kind: 'mcp',
          op: OP.KEEP,
          from: `@mcpServers (${classified.length} server(s))`,
          to: dest,
          note: rule.mode,
        });
      }
      continue;
    }

    throw businessError('MANIFEST_INVALID', `${manifest.name}: unhandled kind ${rule.kind}`);
  }

  // Gates are code that must land next to its engine, so they get a dedicated
  // planner instead of another copy-tree rule. Emitted through the same action
  // list, which is what makes adopt snapshot them and revoke restore them.
  for (const action of planGateInstall({ repo, home, manifest })) {
    actions.push(action);
  }
  if (manifest.gates?.supported && manifest.gates.autoLoad === false) {
    warnings.push(
      `${manifest.display} does not auto-load extensions; the gate is installed but must be mounted ` +
        `manually${manifest.gates.mountHint ? ` (${manifest.gates.mountHint})` : ''}`,
    );
  }

  return { name: manifest.name, display: manifest.display, actions, warnings, info };
};

/** Files under `destRoot` that this bridge previously created and no longer derives. */
const collectRemovals = (actions, destRoot, keepNames, trackedBefore, kind) => {
  if (!existsSync(destRoot)) return;
  for (const rel of listFiles(destRoot)) {
    const top = rel.split('/')[0];
    if (keepNames.has(top)) continue;
    const to = join(destRoot, rel);
    if (!trackedBefore.has(to)) continue; // never remove something we did not create
    actions.push({ kind, op: OP.REMOVE, from: null, to, note: 'no longer derived from source' });
  }
};

/**
 * Build the plan for every requested target.
 *
 * Targets that are missing on this machine, or that are not in `bridged` state,
 * produce a skipped entry rather than an error.
 */
export const buildPlan = ({ repo, home, targetNames, state, prune = false, adoptNames = [] }) => {
  const source = scanSource(home);
  const secrets = loadSecrets(home, process.env).values;
  const results = [];
  const adopting = new Set(adoptNames);

  for (const name of targetNames) {
    const manifest = loadManifest(repo, name);
    const status = state.agents[name]?.status ?? STATUS.NATIVE;

    if (!detectTarget(manifest, home)) {
      results.push({ name, status, skipped: 'not installed on this machine', actions: [] });
      continue;
    }
    if (status !== STATUS.BRIDGED && !adopting.has(name)) {
      results.push({ name, status, skipped: `not bridged (${status})`, actions: [] });
      continue;
    }

    const planned = planTarget({
      home,
      repo,
      manifest,
      source,
      secrets,
      stateEntry: state.agents[name],
      prune,
    });

    if (planned.info.missingSecrets?.length) {
      assertNoMissing(new Set(planned.info.missingSecrets), `${name}: mcp`);
    }

    results.push({ ...planned, status });
  }

  return { home, repo, prune, targets: results, source };
};

export const summarizePlan = (plan) => {
  const totals = { add: 0, update: 0, keep: 0, remove: 0, targets: 0, skipped: 0 };
  for (const target of plan.targets) {
    if (target.skipped) {
      totals.skipped += 1;
      continue;
    }
    totals.targets += 1;
    for (const action of target.actions) totals[action.op] += 1;
  }
  return totals;
};

/** Content that should be written for an action (file copy vs generated text). */
export const actionPath = (action) => action.to;

export const assertInsideHome = (home, absolute) => {
  if (!isInside(home, absolute)) {
    throw businessError('PATH_ESCAPE', `refusing to write outside home: ${absolute}`);
  }
};

export { OP, agentSnapshotDir, targetPath, sha256 };
