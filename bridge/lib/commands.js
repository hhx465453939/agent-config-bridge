/**
 * dsh slash-command deployment.
 *
 * Same shape as the gate installer in ./gates.js, and for the same reason: the
 * command surface is code, not a file an agent reads. dsh has no prompt-template
 * directory, so a prompt command only exists once a plugin registers it.
 *
 * Installed layout:
 *
 *   <extension_dir>/<commands.install_as>/
 *     index.js       the plugin, copied from dsh/commands/index.js
 *     package.json   {"type":"module"} — see the note in gates.js
 *     prompts/*.md   the user's Claude Code command templates, copied flat
 *     README.md      what this is, and how to mount it
 *
 * The prompt templates are copied from the authoritative source
 * (~/.claude/commands) rather than from this repository: the repository owns the
 * mechanism, the user owns the prompts.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { businessError } from './errors.js';
import { planFileOp } from './fs-ops.js';
import { claudeCommandDir, targetPath } from './paths.js';

export const commandsSourceDir = (repo) => join(repo, 'dsh', 'commands');

export const commandsInstallDir = (manifest, home) =>
  targetPath(home, `${manifest.commands.extensionDir}/${manifest.commands.installAs}`);

const COMMANDS_PACKAGE_JSON = `${JSON.stringify({
  name: 'agent-config-commands',
  version: '0.0.0',
  private: true,
  type: 'module',
  description: 'Installed by agent-config-bridge: dsh slash commands and prompt templates.',
  main: 'index.js',
}, null, 2)}\n`;

const readme = (manifest, dest) => [
  '# agent-config-commands',
  '',
  'Slash commands for the DeepSeek Harness desktop, installed by',
  `agent-config-bridge (${manifest.display}).`,
  '',
  'Commands this adds:',
  '',
  '  /mcp                  list every MCP server with its connection status',
  '  /mcp restart <name>   reconnect one server',
  '  /gate                 show the hard-gate policy this machine is running',
  '  /<template>           every prompts/*.md file, injected as the next prompt',
  '',
  'A prompt command sends the template as a user message through',
  '`agent.followup()`, which is what makes it behave like a Claude Code slash',
  'command instead of printing text you still have to copy. `$ARGUMENTS` in a',
  'template is replaced with the text typed after the command.',
  '',
  'Mounting (dsh does not auto-load an extension directory). Add to',
  '`<home>/.dsh/profiles/<profile>/cordis.patch.yml`:',
  '',
  '```yaml',
  '- insert:',
  '    - id: agent-config-commands',
  '      name: \'../../plugins/agent-config-commands/index.js\'',
  '```',
  '',
  `Installed at: ${dest}`,
  '',
  'Removing it: delete that row and this directory.',
  '',
].join('\n');

/**
 * Plan the command-surface installation.
 * @returns {Array<object>} plan actions, the same shape the gate planner emits
 */
export const planCommandsInstall = ({ repo, home, manifest }) => {
  if (!manifest.commands || manifest.commands.supported === false) return [];
  const src = commandsSourceDir(repo);
  const dest = commandsInstallDir(manifest, home);
  const actions = [];

  const copyAction = (from, to, note) => {
    if (!existsSync(from)) {
      throw businessError(
        'COMMAND_SOURCE_MISSING',
        `command source not found: ${from}\n  the manifest declares commands for ${manifest.name} but this checkout is incomplete.`,
      );
    }
    actions.push({ kind: 'command', op: planFileOp(from, to), from, to, note });
  };

  const contentAction = (to, content, note) => {
    const exists = existsSync(to);
    const same = exists && readText(to) === content;
    actions.push({
      kind: 'command',
      op: exists ? (same ? 'keep' : 'update') : 'add',
      from: note,
      to,
      note,
      content,
      mode: 0o644,
    });
  };

  copyAction(join(src, 'index.js'), join(dest, 'index.js'), 'slash-command plugin');
  contentAction(join(dest, 'package.json'), COMMANDS_PACKAGE_JSON, 'dsh module type declaration');
  contentAction(join(dest, 'README.md'), readme(manifest, dest), 'command readme');

  // Prompts come from the authoritative Claude Code directory, so a user editing
  // /code-review only has to do it once.
  const promptsFrom = claudeCommandDir(home);
  if (existsSync(promptsFrom)) {
    for (const file of readdirSync(promptsFrom).sort()) {
      if (!file.toLowerCase().endsWith('.md')) continue;
      copyAction(join(promptsFrom, file), join(dest, 'prompts', file), 'prompt template');
    }
  }

  return actions;
};

/** Read a file's text, tolerating absence (a plan is not allowed to throw on a missing target). */
function readText(file) {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}
