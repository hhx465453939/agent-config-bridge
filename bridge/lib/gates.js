/**
 * Gate deployment.
 *
 * A gate is code, not content: it has to sit inside the agent's extension
 * directory and be loadable by that agent. So it gets its own planner rather
 * than being expressed as another `copy-tree` rule — the shared policy engine
 * has to land next to the adapter (the adapter imports it as `../policy.js`),
 * and the policy JSON is generated per machine from the manifest.
 *
 * Installed layout (identical for every harness, which is why the relative
 * import in the adapters never needs rewriting):
 *
 *   <extension_dir>/<install_as>/
 *     policy.js              the rule engine, copied verbatim
 *     policy.json            generated: defaults merged with the manifest override
 *     index.js               pi entry point (re-exports ./pi/index.js)
 *     pi/index.js            pi adapter
 *     dsh/index.js           dsh adapter
 *     README.md              what this is and how to remove it
 *
 * Every file produced here is a normal plan action, so it is snapshotted on
 * adopt and restored by revoke without any special-casing. That is the whole
 * point of routing it through the same planner.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { businessError } from './errors.js';
import { planFileOp } from './fs-ops.js';
import { machineGateConfigFile, targetPath } from './paths.js';

export const gatesSourceDir = (repo) => join(repo, 'bridge', 'gates');

export const gateInstallDir = (manifest, home) =>
  targetPath(home, `${manifest.gates.extensionDir}/${manifest.gates.installAs}`);

/** The home-relative form of the gate directory, used to carve it out of never_touch. */
export const gateRelDir = (manifest) =>
  manifest.gates ? `${manifest.gates.extensionDir}/${manifest.gates.installAs}` : null;

const PI_ENTRY = `// Entry point so the harness finds the adapter when it loads this directory.
// pi loads a subdirectory that contains an index.ts / index.js.
export { default } from './pi/index.js';
`;

const readme = (manifest) => {
  const lines = [
    '# agent-config-gates',
    '',
    'Hard gates ported from a rules document, so the rules survive a model that',
    'decides not to follow them.',
    '',
    `Harness : ${manifest.display} (adapter: \`${manifest.gates.adapter}\`)`,
    'Policy  : `policy.json` in this directory. Edit it to change which checks run,',
    '          which paths are in scope, and how many times a session may be blocked.',
    '',
    'Files   :',
    '  policy.js            rule engine',
    '  classifier.js        domain classifier (fingerprint -> keyword -> optional model)',
    '  policy.json          which checks run on this machine, and the base config',
    '  profiles/*.json      domain definitions: extra checks, domain config, reminder text',
    `  ${manifest.gates.adapter}/index.js  harness adapter`,
    '',
    'Changing domain rules: edit `profiles/<name>.json` - its `checks` are ADDED to',
    'the ones in `policy.json`, and its `config` OVERRIDES the same keys in',
    '`policy.json`. Put domain knobs (worklog path/TTL, result dirs, log-required',
    'extensions) in the profile, not in policy.json; a key set in both is decided',
    'by the profile.',
    '',
    'Destructive commands are split into TWO layers, because "how bad is it" is not',
    'the only question: "can it be recovered?" and "did the user authorise it?" are',
    'different questions with different answers.',
    '',
    '  1. guardrail - unrecoverable, and NO grant can reach it: deleting `$HOME` or',
    '     an ancestor of it, the working directory or an ancestor of it, a path with a',
    '     `..` segment, a top-level directory, a git repository root, formatting a',
    '     disk, writing to a raw device, shutting the machine down. Blocked outright.',
    '',
    '  2. permission - serious but survivable. Seven categories, each with its own',
    '     tier (allow / confirm / deny):',
    '',
    '       delete          rm / rmdir / unlink / del / rd /s / Remove-Item -Recurse',
    '                       / find -delete / clear-content',
    '       git-history     reset --hard / clean -f / checkout -- . / restore',
    '                       / branch -D / filter-* / stash drop|clear',
    '       git-force-push  push --force / --force-with-lease / -f',
    '       db-ddl          DROP TABLE|DATABASE|SCHEMA / TRUNCATE TABLE, including the',
    '                       same statement passed to psql -c / mysql -e / sqlite3 /',
    '                       mongosh --eval            (default: deny)',
    '       perm-recursive  chmod -R / chown -R / chgrp -R',
    '       process-kill    taskkill /F',
    '       raw-write       dd of=<a normal file>   (a raw device is a guardrail)',
    '',
    '  Build output (`node_modules`, `dist`, `build`, `.venv`, `tmp`, ...) is not a',
    '  destructive operation at all: it runs without asking.',
    '',
    'A `confirm` tier asks before it runs. On this harness the adapter shows a dialog',
    'with three choices - allow once / allow this whole category for this session /',
    'refuse (closing the dialog counts as refuse). A harness without a UI runs it and',
    'writes one stderr line, because an automated run already carries the user\'s',
    'authorisation; the guardrail layer still refuses there.',
    '',
    'Only the user can change a tier. Two supported ways:',
    '',
    '  - the dialog above ("allow this category for this session");',
    '  - the `/gate` command (pi): `list`, `grant <category>`, `ask <category>`,' ,
    '    `deny <category>`, `reset <category>`, `session <category>`, `mode ...`.',
    '',
    '## Destructive-command mode: enforce / bypass',
    '',
    'A long unattended run used to stall on a `confirm` dialog nobody was awake to',
    'answer. `config.destructive_mode` is the switch for that, and its scope is',
    'DELIBERATELY NARROW: it governs `no-destructive-bash` and nothing else.',
    '',
    '  enforce (default)  the tiers above decide allow / ask / deny.',
    '  bypass             no dialog and no refusal for destructive commands.',
    '',
    'What bypass does and does not touch:',
    '',
    '  affected        the seven permission categories (delete, git-history,',
    '                  git-force-push, db-ddl, perm-recursive, process-kill,',
    '                  raw-write) - allowed outright instead of asked/refused.',
    '  still blocked   the guardrail tier of `no-destructive-bash` (delete $HOME or',
    '                  an ancestor, the cwd or an ancestor, a `..` path, a top-level',
    '                  directory, a git repo root, format a disk, write to a raw',
    '                  device, shut the host down) and `no-self-grant`.',
    '  unaffected      EVERY other check. The graph/think/contract research rules,',
    '                  the secret and out-of-scope write rules, the blind-retry',
    '                  rule, the AI4S domain rules, the turn-end checks and the',
    '                  per-turn reminder all keep running exactly as before.',
    '',
    'That last row is the design: those rules are not "questions the user gets',
    'tired of", they are the discipline this gate exists for. A switch that',
    'silenced them because a delete at 03:00 wants a dialog would trade one',
    'annoyance for a much worse blind spot.',
    '',
    'Two things are deliberately outside the bypass even for destructive commands:',
    'the guardrail (a bypass that deletes $HOME is not a feature) and',
    '`no-self-grant` (the switch lives in the same files, so a write carrying',
    '`destructive_mode` is refused - otherwise one write would escalate the agent',
    'to a permanent, global, permission-layer-off state).',
    '',
    'Switch it (pi):',
    '',
    '  /gate mode                   show the active mode (and a picker, with a UI)',
    '  /gate mode bypass            global, persistent',
    '  /gate mode bypass 8h         global, and it tightens itself in 8h (s/m/h/d)',
    '  /gate mode enforce           global, back to enforcing',
    '  /gate mode bypass session    this session only (no file written)',
    '  /gate mode enforce session   this session only, overriding a global bypass',
    '',
    'A session override wins in BOTH directions (unlike the tier table, where',
    'tightening beats loosening): only a slash command the user types can reach it,',
    'and an agent cannot invoke those.',
    '',
    'On a harness with no command channel (dsh) the mode is read from this file or',
    'from `~/.config/agent-config-bridge/gate-policy.json` at startup, and a bypass',
    'is announced once on stderr - a silent bypass is indistinguishable from a gate',
    'that works.',
    '',,
    'Persistent grants go to `~/.config/agent-config-bridge/gate-policy.json`, which',
    '`bridge apply` never overwrites. The agent itself cannot write either file: the',
    '`no-self-grant` check refuses a write that carries `destructive_grants`, because',
    'a gate its own subject can re-key is decoration.',
    '',
    'Tightening always beats loosening: a `deny` in `policy.json` cannot be reopened',
    'by a session grant.',
    '',
    'Set `destructive_confirm_mode: false` to turn every `confirm` back into a hard',
    'refusal (the behaviour before 2026-11-05). The guardrail layer and any `deny`',
    'tier ignore that switch - they never asked a question in the first place.',
    '',
    'Installed by agent-config-bridge. Removing it:',
    '',
    '```',
    `node bridge/cli.js revoke ${manifest.name}`,
    '```',
    '',
    'which restores this directory to whatever was here before it was adopted.',
  ];

  if (manifest.gates.autoLoad === false) {
    lines.push(
      '',
      '## This harness does not auto-load extensions',
      '',
      ...(manifest.gates.mountHint ? [manifest.gates.mountHint, ''] : []),
      'Mount this directory with a Cordis plugin row:',
      '',
      '```yaml',
      `- name: '${manifest.gates.extensionDir}/${manifest.gates.installAs}/'`,
      '```',
    );
  }

  lines.push('');
  return lines.join('\n');
};

/**
 * Read the optional machine-local override.
 *
 * The public repository must never contain one person's absolute paths, but the
 * gate is far more useful when non-git working directories (scripts, MCP source,
 * skill trees) are in scope. So the machine supplies only `config` from
 * `~/.config/agent-config-bridge/gate-policy.json`; `checks` and the rule text
 * stay owned by the repository. A malformed file is a hard error, never a
 * silent no-op.
 */
const readMachineOverride = (home) => {
  if (!home) return {};
  const file = machineGateConfigFile(home);
  if (!existsSync(file)) return {};
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    throw businessError('GATE_POLICY_INVALID', `${file}: not valid JSON (${err.message})`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw businessError('GATE_POLICY_INVALID', `${file}: must contain a JSON object`);
  }
  return parsed.config && typeof parsed.config === 'object' && !Array.isArray(parsed.config)
    ? parsed.config
    : {};
};

/** Merge the shipped policy for this adapter with the manifest's override. */
export const resolvePolicy = ({ repo, manifest, home = null }) => {
  const shipped = join(gatesSourceDir(repo), manifest.gates.adapter, 'policy.json');
  let base = {};
  if (existsSync(shipped)) {
    try {
      base = JSON.parse(readFileSync(shipped, 'utf8'));
    } catch (err) {
      throw businessError('GATE_POLICY_INVALID', `${shipped}: not valid JSON (${err.message})`);
    }
  }
  const override = manifest.gates.policy ?? {};
  const machineConfig = readMachineOverride(home);
  return {
    ...base,
    ...override,
    config: { ...(base.config ?? {}), ...(override.config ?? {}), ...machineConfig },
    checks: override.checks ?? base.checks ?? [],
  };
};

/**
 * @returns {Array<object>} plan actions (same shape the file planner emits)
 */
export const planGateInstall = ({ repo, home, manifest }) => {
  if (!manifest.gates || manifest.gates.supported === false) return [];
  const src = gatesSourceDir(repo);
  const dest = gateInstallDir(manifest, home);
  const adapter = manifest.gates.adapter;
  const actions = [];

  const copyAction = (from, to, note) => {
    if (!existsSync(from)) {
      throw businessError(
        'GATE_SOURCE_MISSING',
        `gate source not found: ${from}\n` +
          `  the manifest declares gates for ${manifest.name} but this checkout is incomplete.`,
      );
    }
    actions.push({ kind: 'gate', op: planFileOp(from, to), from, to, note });
  };

  const contentAction = (to, content, note) => {
    const exists = existsSync(to);
    const same = exists && readFileSync(to, 'utf8') === content;
    actions.push({
      kind: 'gate',
      op: exists ? (same ? 'keep' : 'update') : 'add',
      from: note,
      to,
      note,
      content,
      mode: 0o644, // code and config, never credentials
    });
  };

  copyAction(join(src, 'policy.js'), join(dest, 'policy.js'), 'gate rule engine');
  // v5: the adapters import `../classifier.js`, so it has to sit next to
  // policy.js in the installed layout too. Missing it makes the extension fail to
  // LOAD (not silently degrade) — the install test caught exactly this.
  copyAction(join(src, 'classifier.js'), join(dest, 'classifier.js'), 'domain classifier');
  copyAction(join(src, adapter, 'index.js'), join(dest, adapter, 'index.js'), `${adapter} adapter`);

  // v5: the domain profile definitions.
  //
  // They live outside the adapter directories because both harnesses read the
  // same table, and they MUST be installed: `policy.json` only names the profiles
  // it wants, so a missing `profiles/` makes every session silently classify as
  // `general-dev` - installed, running, and enforcing only the base rules. That is
  // the "装进去但不生效" failure ADR-003 §4 already records for dsh mounting.
  //
  // Each JSON becomes its own plan action, so adopt snapshots them and revoke
  // removes them exactly like every other gate file.
  const profilesSrc = join(src, 'profiles');
  if (existsSync(profilesSrc)) {
    for (const file of readdirSync(profilesSrc)) {
      if (!file.endsWith('.json')) continue;
      copyAction(
        join(profilesSrc, file),
        join(dest, 'profiles', file),
        'domain profile definition',
      );
    }
  }

  // Only pi needs a directory entry point; dsh mounts the file by path.
  if (adapter === 'pi') {
    contentAction(join(dest, 'index.js'), PI_ENTRY, 'pi directory entry point');
  }

  const policy = resolvePolicy({ repo, manifest, home });
  contentAction(join(dest, 'policy.json'), `${JSON.stringify(policy, null, 2)}\n`, 'gate policy');
  contentAction(join(dest, 'README.md'), readme(manifest), 'gate readme');

  return actions;
};

/** Where the gate lives, for `status` and `doctor`. */
export const gateStatus = ({ repo, home, manifest }) => {
  if (!manifest.gates || manifest.gates.supported === false) {
    return { supported: false, reason: 'this harness has no extension mechanism' };
  }
  const dir = gateInstallDir(manifest, home);
  const policyFile = join(dir, 'policy.json');
  let policyName = null;
  if (existsSync(policyFile)) {
    try {
      policyName = JSON.parse(readFileSync(policyFile, 'utf8')).name ?? null;
    } catch {
      policyName = '<unreadable>';
    }
  }
  return {
    supported: true,
    adapter: manifest.gates.adapter,
    dir,
    installed: existsSync(join(dir, adapterEntry(manifest))),
    policy: policyName,
    /**
     * Whether the user still has to mount this by hand.
     *
     * Derived from `autoLoad`, NOT from the presence of a hint. The first
     * version keyed off the hint and therefore told the user pi needed manual
     * mounting — pi auto-loads its extension directory perfectly well. A false
     * statement on the single line people read to decide whether their gate is
     * live is worse than saying nothing.
     */
    manualMount: manifest.gates.autoLoad === false,
    mountHint: manifest.gates.mountHint ?? null,
  };
};

const adapterEntry = (manifest) =>
  manifest.gates.adapter === 'pi' ? 'index.js' : join(manifest.gates.adapter, 'index.js');
