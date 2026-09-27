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

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { businessError } from './errors.js';
import { planFileOp } from './fs-ops.js';
import { targetPath } from './paths.js';

export const gatesSourceDir = (repo) => join(repo, 'bridge', 'gates');

export const gateInstallDir = (manifest, home) =>
  targetPath(home, `${manifest.gates.extension_dir}/${manifest.gates.install_as}`);

/** The home-relative form of the gate directory, used to carve it out of never_touch. */
export const gateRelDir = (manifest) =>
  manifest.gates ? `${manifest.gates.extension_dir}/${manifest.gates.install_as}` : null;

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
    'Installed by agent-config-bridge. Removing it:',
    '',
    '```',
    `node bridge/cli.js revoke ${manifest.name}`,
    '```',
    '',
    'which restores this directory to whatever was here before it was adopted.',
  ];

  if (manifest.gates.auto_load === false) {
    lines.push(
      '',
      '## This harness does not auto-load extensions',
      '',
      ...(manifest.gates.mount_hint ? [manifest.gates.mount_hint, ''] : []),
      'Mount this directory with a Cordis plugin row:',
      '',
      '```yaml',
      `- name: '${manifest.gates.extension_dir}/${manifest.gates.install_as}/'`,
      '```',
    );
  }

  lines.push('');
  return lines.join('\n');
};

/** Merge the shipped policy for this adapter with the manifest's override. */
export const resolvePolicy = ({ repo, manifest }) => {
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
  return {
    ...base,
    ...override,
    config: { ...(base.config ?? {}), ...(override.config ?? {}) },
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
  copyAction(join(src, adapter, 'index.js'), join(dest, adapter, 'index.js'), `${adapter} adapter`);

  // Only pi needs a directory entry point; dsh mounts the file by path.
  if (adapter === 'pi') {
    contentAction(join(dest, 'index.js'), PI_ENTRY, 'pi directory entry point');
  }

  const policy = resolvePolicy({ repo, manifest });
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
    mounts: manifest.gates.mount_hint ?? null,
  };
};

const adapterEntry = (manifest) =>
  manifest.gates.adapter === 'pi' ? 'index.js' : join(manifest.gates.adapter, 'index.js');
