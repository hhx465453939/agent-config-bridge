/**
 * dsh MCP reader deployment.
 *
 * The bridge's MCP dimension normally ends at a generated document, because the
 * harness reads it. dsh is the exception: it has no global `mcp.json`, and the
 * only place it accepts MCP servers (the `mcp-manager` row in the profile
 * composition) is `never_touch` — that file is also the surface the GUI writes.
 *
 * So the bridge owns a document of its own and installs a small READER plugin
 * that turns it into `ctx.mcpManager.register()` calls at activation, re-reading
 * the document on change. `bridge apply` then reaches a RUNNING dsh with no
 * restart, and a `revoke` restores it like every other managed artefact.
 *
 * Same shape as ./commands.js and ./gates.js, and for the same reason: this is
 * code that has to sit where the harness looks, with a package.json declaring
 * its module type. dsh does not auto-load an extension directory, so the
 * manifest declares `auto_load: false` and the installer prints the one row.
 *
 * Installed layout:
 *
 *   <extension_dir>/<install_as>/
 *     index.js       the reader, copied from dsh/mcp/index.js
 *     package.json   {"type":"module"} — see the note in gates.js
 *     README.md      what it is, the mount row, and how to remove it
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { businessError } from './errors.js';
import { planFileOp } from './fs-ops.js';
import { targetPath } from './paths.js';

export const mcpReaderSourceDir = (repo) => join(repo, 'dsh', 'mcp');

export const mcpReaderInstallDir = (manifest, home) =>
  targetPath(home, `${manifest.mcpReader.extensionDir}/${manifest.mcpReader.installAs}`);

const MCP_READER_PACKAGE_JSON = `${JSON.stringify(
  {
    name: 'agent-config-mcp',
    version: '0.0.0',
    private: true,
    type: 'module',
    description:
      'Installed by agent-config-bridge: reads the generated MCP document and registers its servers with dsh’s mcp-manager.',
    main: 'index.js',
  },
  null,
  2,
)}\n`;

const readme = (manifest, dest) => {
  const document = manifest.managed.find((rule) => rule.kind === 'mcp')?.to ?? '<generated MCP document>';
  return [
    '# agent-config-mcp',
    '',
    'MCP reader for the DeepSeek Harness, installed by agent-config-bridge',
    `(${manifest.display}).`,
    '',
    'It does not define servers. `bridge apply` writes the document, this plugin',
    'reads it, and each entry becomes a `ctx.mcpManager.register()` call:',
    '',
    `  document  ~/${document}`,
    '  status    ~/.dsh/agent-config-bridge/mcp-status.json   (names, states, tool counts)',
    '',
    'Changed entries are rebuilt, entries removed from the authoritative Claude',
    'Code configuration are withdrawn, and a document that is missing or',
    'half-written leaves the running fleet alone. No restart is needed: the reader',
    'polls the document and reconciles within about a second.',
    '',
    '`/mcp` lists these servers (origin `plugin`) and `/mcp restart <name>`',
    'reconnects one, because the manager treats a registration exactly like a',
    'configured entry.',
    '',
    '## Mounting',
    '',
    'dsh does not auto-load an extensions directory. Add this row to the profile',
    'patch (`~/.dsh/profiles/<profile>/cordis.patch.yml`); the specifier is',
    'relative to that file, so it points at `~/.dsh/plugins/`:',
    '',
    '```yaml',
    '- insert:',
    '    - id: agent-config-mcp',
    "      name: '../../plugins/agent-config-mcp/index.js'",
    '```',
    '',
    `Installed at: ${dest}`,
    '',
    'Removing it: delete that row and this directory (`revoke dsh` restores the',
    'document, not this plugin — the plugin is installed by `scripts/install-dsh.js`).',
    '',
  ].join('\n');
};

/**
 * Plan the reader installation.
 * @returns {Array<object>} plan actions, the same shape the gate/command planners emit
 */
export const planMcpReaderInstall = ({ repo, home, manifest }) => {
  if (!manifest.mcpReader || manifest.mcpReader.supported === false) return [];
  const src = mcpReaderSourceDir(repo);
  const dest = mcpReaderInstallDir(manifest, home);
  const actions = [];

  const copyAction = (from, to, note) => {
    if (!existsSync(from)) {
      throw businessError(
        'MCP_READER_SOURCE_MISSING',
        `MCP reader source not found: ${from}\n` +
          `  the manifest declares a reader for ${manifest.name} but this checkout is incomplete.`,
      );
    }
    actions.push({ kind: 'mcp-reader', op: planFileOp(from, to), from, to, note });
  };

  const contentAction = (to, content, note) => {
    const exists = existsSync(to);
    const same = exists && readText(to) === content;
    actions.push({
      kind: 'mcp-reader',
      op: exists ? (same ? 'keep' : 'update') : 'add',
      from: note,
      to,
      note,
      content,
      mode: 0o644,
    });
  };

  copyAction(join(src, 'index.js'), join(dest, 'index.js'), 'mcp reader plugin');
  contentAction(join(dest, 'package.json'), MCP_READER_PACKAGE_JSON, 'dsh module type declaration');
  contentAction(join(dest, 'README.md'), readme(manifest, dest), 'mcp reader readme');

  return actions;
};

/** Where the reader lives, for `scripts/install-dsh.js` and `status`. */
export const mcpReaderStatus = ({ home, manifest }) => {
  if (!manifest.mcpReader || manifest.mcpReader.supported === false) {
    return { supported: false, reason: 'this harness has no MCP reader declared' };
  }
  const dir = mcpReaderInstallDir(manifest, home);
  return {
    supported: true,
    dir,
    installed: existsSync(join(dir, 'index.js')),
    autoLoad: manifest.mcpReader.autoLoad,
    manualMount: manifest.mcpReader.autoLoad === false,
    mountHint: manifest.mcpReader.mountHint ?? null,
  };
};

/** Tolerate absence: a plan is not allowed to throw on a missing target. */
function readText(file) {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}
