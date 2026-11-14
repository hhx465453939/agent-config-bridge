/**
 * Slash commands for the DeepSeek Harness desktop — the ones dsh does not ship,
 * plus the user's own prompt templates carried over from Claude Code.
 *
 * dsh ships `/goal` and `/compact`. Everything else a Claude Code user reaches
 * for is either an operational query (`/mcp`, `/gate`) or a prompt template
 * (`/code-review`, `/debug`, …), so both are registered here.
 *
 * WHY THIS FILE IMPORTS NOTHING
 *
 * It is installed under `~/.dsh/plugins/`, which is outside the dsh
 * installation, so a bare `import '@deepseek-ai/dsh-llm'` cannot resolve from
 * here at runtime (Node walks up from this directory; the packages live inside
 * the app bundle, not above this path). Everything is therefore built from what
 * the harness hands the plugin:
 *
 *   - `ctx.commands.register()` for the command surface,
 *   - `ctx.get('mcpManager')` / `ctx.get(...)` for services that may or may not
 *     be mounted (a missing one is reported, never fatal),
 *   - `node:fs` for the policy file and the prompt directory.
 *
 * A prompt template is turned into the same durable user message the shipped
 * `/goal` command builds with `createUserMessage()` — `{ id, role: 'user',
 * content, source: { kind: 'user' } }` — and handed to `agent.followup()`. That
 * is the documented boundary for "this should run as the human's next turn",
 * and it is what makes a prompt command behave like its Claude Code original
 * instead of merely printing text the user still has to copy.
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

export const name = 'agent-config-commands';

/** The command registry is the one thing this plugin cannot work without. */
export const inject = ['commands'];

/** One prompt file larger than this is not a slash command, it is a document. */
const MAX_PROMPT_BYTES = 256 * 1024;

/**
 * Names the harness or this plugin already owns. Registering over them throws,
 * and a duplicate would shadow a built-in the user relies on.
 */
const RESERVED = new Set(['mcp', 'gate', 'goal', 'compact', 'help']);

/** Normalize a file name into a dsh command name: lowercase, `[a-z0-9_-]`, no runs of dashes. */
export const commandName = (file) => file
  .replace(/\.md$/i, '')
  .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
  .toLowerCase()
  .replace(/[^a-z0-9_-]+/g, '-')
  .replace(/-{2,}/g, '-')
  .replace(/^-+|-+$/g, '');

/**
 * Split a leading `---` frontmatter block from the prompt body.
 *
 * Only the two keys a command surface uses are read (`description`,
 * `argument-hint`); everything else is kept out of the prompt, which is the
 * point of frontmatter. A file without frontmatter is all body.
 */
export const parseFrontmatter = (text) => {
  const normalized = String(text).replace(/^\uFEFF/, '');
  if (!normalized.startsWith('---')) return { meta: {}, body: normalized };
  const end = normalized.indexOf('\n---', 3);
  if (end < 0) return { meta: {}, body: normalized };
  const rawHead = normalized.slice(3, end);
  const body = normalized.slice(normalized.indexOf('\n', end + 1) + 1);
  const meta = {};
  for (const line of rawHead.split(/\r?\n/)) {
    const match = /^\s*([A-Za-z][\w-]*)\s*:\s*(.*)$/.exec(line);
    if (match) meta[match[1].toLowerCase()] = match[2].trim().replace(/^["']|["']$/g, '');
  }
  return { meta, body };
};

/**
 * Render a prompt template for one invocation.
 *
 * `$ARGUMENTS` is the Claude Code placeholder. When a template has no
 * placeholder, trailing arguments are appended as their own paragraph rather
 * than dropped — a command that silently ignores its input is worse than one
 * that echoes it.
 */
export const renderPrompt = (body, rawInput = '') => {
  const args = String(rawInput ?? '').trim();
  const template = String(body ?? '');
  if (template.includes('$ARGUMENTS')) return template.trimEnd().split('$ARGUMENTS').join(args);
  if (args.length === 0) return template.trimEnd();
  return `${template.trimEnd()}\n\n${args}`;
};

/** The message shape `createUserMessage()` produces, built without importing it. */
const userMessage = (text) => structuredClone({
  id: randomUUID(),
  role: 'user',
  content: [{ type: 'text', text }],
  source: { kind: 'user' },
});

/** One line per managed server, status rendered whatever shape the manager reports. */
export const renderServerList = (servers) => {
  if (!Array.isArray(servers) || servers.length === 0) return 'No MCP server is configured or registered.';
  const rows = servers.map((server) => {
    const state = typeof server?.status === 'string'
      ? server.status
      : (server?.status?.state ?? server?.status?.kind ?? JSON.stringify(server?.status ?? null));
    const origin = server?.configured === false ? 'plugin' : 'configured';
    return `  ${String(server?.name ?? '?')}  [${origin}]  ${state}`;
  });
  return ['MCP servers:', ...rows].join('\n');
};

/**
 * Describe the installed policy without loading the gate: the point is to tell
 * the user what is on disk, so a missing or broken file is reported as such.
 */
export const describeGate = (policyPath, machinePath) => {
  const lines = [`Hard gate policy: ${policyPath}`];
  const readJson = (file, label) => {
    if (!existsSync(file)) {
      lines.push(`  ${label}: not found`);
      return null;
    }
    try {
      return JSON.parse(readFileSync(file, 'utf8'));
    } catch (error) {
      lines.push(`  ${label}: unreadable (${error.message})`);
      return null;
    }
  };

  const policy = readJson(policyPath, 'policy');
  if (policy) {
    lines.push(`  checks: ${(policy.checks ?? []).join(', ') || '(none)'}`);
    const config = policy.config ?? {};
    lines.push(`  project_roots: ${(config.project_roots ?? []).length === 0 ? '(git repos only)' : (config.project_roots ?? []).join(', ')}`);
    lines.push(`  destructive_mode: ${config.destructive_mode ?? 'enforce'}`);
    lines.push(`  block window: ${config.max_blocks_per_session ?? '?'} per ${Math.round((config.block_cap_reset_ms ?? 0) / 60000) || '?'} min`);
  }

  const machine = readJson(machinePath, 'machine override');
  if (machine?.config) {
    const keys = Object.keys(machine.config);
    lines.push(`  machine override keys: ${keys.length === 0 ? '(none)' : keys.join(', ')}`);
  }
  return lines.join('\n');
};

/** Register every prompt template found in `dir`; a bad file is skipped, not fatal. */
const registerPrompts = (ctx, dir, problems) => {
  if (!existsSync(dir)) {
    problems.push(`prompt directory missing: ${dir}`);
    return 0;
  }
  const files = readdirSync(dir).filter((file) => file.toLowerCase().endsWith('.md')).sort();
  let registered = 0;
  for (const file of files) {
    const full = join(dir, file);
    const command = commandName(file);
    if (!command || RESERVED.has(command)) {
      problems.push(`skipped ${file}: reserved or empty name`);
      continue;
    }
    let size = 0;
    try {
      size = statSync(full).size;
    } catch (error) {
      problems.push(`skipped ${file}: ${error.message}`);
      continue;
    }
    if (size > MAX_PROMPT_BYTES) {
      problems.push(`skipped ${file}: ${size} bytes exceeds ${MAX_PROMPT_BYTES}`);
      continue;
    }
    const { meta, body } = parseFrontmatter(readFileSync(full, 'utf8'));
    if (body.trim() === '') {
      problems.push(`skipped ${file}: empty prompt`);
      continue;
    }
    try {
      ctx.commands.register({
        name: command,
        description: meta.description ?? `Run the ${command} prompt template`,
        input: { hint: meta['argument-hint'] ?? '<arguments>' },
        handler: (invocation) => {
          const agent = invocation?.agent;
          if (typeof agent?.followup !== 'function') {
            return { kind: 'error', text: `/${command}: this agent cannot accept an injected prompt.` };
          }
          agent.followup(userMessage(renderPrompt(body, invocation.rawInput)));
          return { kind: 'success', text: `/${command}: prompt sent as your next message.` };
        },
      });
      registered += 1;
    } catch (error) {
      problems.push(`skipped ${file}: ${error.message}`);
    }
  }
  return registered;
};

/** Copy the prompt directory next to this plugin (used by `scripts/install-dsh.js`). */
export const syncPrompts = (fromDir, toDir) => {
  mkdirSync(toDir, { recursive: true });
  const copied = [];
  for (const file of readdirSync(fromDir)) {
    if (!file.toLowerCase().endsWith('.md')) continue;
    copyFileSync(join(fromDir, file), join(toDir, file));
    copied.push(file);
  }
  return copied;
};

/**
 * Mount every command group.
 *
 * Config:
 *   promptsDir     prompt templates (default: ./prompts beside this file)
 *   gatePolicyPath policy.json to describe under /gate
 *   machineGatePath machine-local override to describe under /gate
 */
export function apply(ctx, config = {}) {
  const problems = [];
  const promptsDir = typeof config.promptsDir === 'string' && config.promptsDir
    ? config.promptsDir
    : fileURLToPath(new URL('./prompts/', import.meta.url));

  const defaultPolicy = fileURLToPath(new URL('../agent-config-gates/policy.json', import.meta.url));
  const defaultMachine = join(process.env.USERPROFILE ?? process.env.HOME ?? '', '.config', 'agent-config-bridge', 'gate-policy.json');
  const policyPath = typeof config.gatePolicyPath === 'string' && config.gatePolicyPath ? config.gatePolicyPath : defaultPolicy;
  const machinePath = typeof config.machineGatePath === 'string' && config.machineGatePath ? config.machineGatePath : defaultMachine;

  ctx.commands.register({
    name: 'mcp',
    description: 'List the MCP servers and their connection status; `/mcp restart <name>` reconnects one',
    input: { hint: '[restart <name>]' },
    handler: async (invocation) => {
      const manager = ctx.get?.('mcpManager');
      if (!manager || typeof manager.list !== 'function') {
        return { kind: 'error', text: 'No MCP manager is mounted in this profile, so there is nothing to list.' };
      }
      const rawInput = String(invocation?.rawInput ?? '').trim();
      if (rawInput.toLowerCase().startsWith('restart')) {
        const target = rawInput.slice('restart'.length).trim();
        if (!target) return { kind: 'error', text: 'Usage: /mcp restart <name>' };
        if (typeof manager.restart !== 'function') return { kind: 'error', text: 'This MCP manager cannot restart servers.' };
        try {
          await manager.restart(target);
          return { kind: 'success', text: `MCP server ${target}: restart requested.\n\n${renderServerList(manager.list())}` };
        } catch (error) {
          return { kind: 'error', text: `MCP server ${target}: ${error?.message ?? error}` };
        }
      }
      return { kind: 'success', text: renderServerList(manager.list()) };
    },
  });

  ctx.commands.register({
    name: 'gate',
    description: 'Show the hard-gate policy this machine is running (checks, roots, destructive mode)',
    handler: () => ({ kind: 'success', text: describeGate(policyPath, machinePath) }),
  });

  const registered = registerPrompts(ctx, promptsDir, problems);
  if (problems.length > 0) {
    const line = `[agent-config-commands] ${problems.length} prompt file(s) skipped:\n  ${problems.join('\n  ')}`;
    ctx.logger?.warn?.(line);
    process.stderr.write(`${line}\n`);
  }
  ctx.logger?.info?.(`[agent-config-commands] ${registered} prompt command(s) from ${promptsDir}`);
}
