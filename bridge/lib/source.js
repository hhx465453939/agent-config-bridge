/**
 * Reads the authoritative source (the Claude Code global configuration).
 *
 * The source is treated as read-only. Nothing in this module writes.
 *
 * Layout it understands:
 *   <home>/.claude/skills/<name>/SKILL.md     directory-form skills (the only accepted form)
 *   <home>/.claude/skills/<name>.md           flat duplicates — reported, never bridged
 *   <home>/.claude/commands/<name>.md         slash commands / prompt templates
 *   <home>/.claude/agents/<name>.md           sub-agent definitions
 *   <home>/.claude/CLAUDE.md                  global rules document
 *   <home>/.claude.json  #mcpServers          MCP declarations
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { claudeAgentDir, claudeCommandDir, claudeJson, claudeRulesDoc, claudeSkillDir, } from './paths.js';
import { listFiles } from './fs-ops.js';
import { businessError } from './errors.js';

/** Directory-form skills, keyed by skill name. Flat `<name>.md` files are NOT included. */
export const scanSkills = (home) => {
  const root = claudeSkillDir(home);
  const skills = [];
  const flatDuplicates = [];
  if (!existsSync(root)) return { root, skills, flatDuplicates };

  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      const dir = join(root, entry.name);
      if (existsSync(join(dir, 'SKILL.md'))) {
        skills.push({ name: entry.name, dir, files: listFiles(dir) });
      }
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      flatDuplicates.push({ name: basename(entry.name, '.md'), file: join(root, entry.name) });
    }
  }

  skills.sort((a, b) => a.name.localeCompare(b.name));
  flatDuplicates.sort((a, b) => a.name.localeCompare(b.name));
  return { root, skills, flatDuplicates };
};

/** Markdown commands, keyed by command name (filename without extension). */
export const scanCommands = (home) => {
  const root = claudeCommandDir(home);
  if (!existsSync(root)) return { root, commands: [] };
  const commands = readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith('.md'))
    .map((e) => ({ name: basename(e.name, '.md'), file: join(root, e.name) }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return { root, commands };
};

/** Sub-agent definitions. */
export const scanAgents = (home) => {
  const root = claudeAgentDir(home);
  if (!existsSync(root)) return { root, agents: [] };
  const agents = readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith('.md'))
    .map((e) => ({ name: basename(e.name, '.md'), file: join(root, e.name) }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return { root, agents };
};

/** Global rules document, or null when the source has none. */
export const scanRulesDoc = (home) => {
  const file = claudeRulesDoc(home);
  return existsSync(file) ? file : null;
};

/**
 * MCP server declarations from the authoritative source.
 *
 * Two locations are consulted, in this order:
 *   1. <home>/.claude.json          (the real Claude Code user config)
 *   2. <home>/.claude/.mcp.json     (project-style extra file, lower precedence)
 * Servers already defined in an earlier source win, so the user's main config
 * is never overridden by the auxiliary file.
 */
export const scanMcpServers = (home) => {
  const servers = {};
  const sources = [];

  const primary = claudeJson(home);
  if (existsSync(primary)) {
    const parsed = parseJson(primary, 'MCP_SOURCE_CORRUPT');
    if (parsed?.mcpServers && typeof parsed.mcpServers === 'object') {
      Object.assign(servers, parsed.mcpServers);
      sources.push({ file: primary, count: Object.keys(parsed.mcpServers).length });
    } else {
      sources.push({ file: primary, count: 0 });
    }
  }

  const secondary = join(claudeSkillDir(home), '..', '.mcp.json');
  if (existsSync(secondary)) {
    const parsed = parseJson(secondary, 'MCP_SOURCE_CORRUPT');
    if (parsed?.mcpServers && typeof parsed.mcpServers === 'object') {
      let added = 0;
      for (const [name, def] of Object.entries(parsed.mcpServers)) {
        if (!(name in servers)) {
          servers[name] = def;
          added += 1;
        }
      }
      sources.push({ file: secondary, count: added });
    }
  }

  return { servers, sources };
};

/**
 * Classify an MCP server definition into the smallest common shape every target
 * can express. Anything outside this shape is reported, never silently dropped.
 */
export const classifyMcpServer = (name, def) => {
  if (!def || typeof def !== 'object') {
    return { name, transport: 'unknown', unsupported: ['definition is not an object'] };
  }
  if (typeof def.url === 'string' && def.url.length > 0) {
    return { name, transport: 'http', url: def.url, headers: def.headers ?? {}, unsupported: [] };
  }
  if (typeof def.command === 'string' && def.command.length > 0) {
    return {
      name,
      transport: 'stdio',
      command: def.command,
      args: Array.isArray(def.args) ? def.args.map(String) : [],
      env: def.env && typeof def.env === 'object' ? def.env : {},
      unsupported: [],
    };
  }
  return { name, transport: 'unknown', unsupported: ['neither "url" nor "command" is present'] };
};

const parseJson = (file, code) => {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    throw businessError(code, `${file}: not valid JSON (${err.message})`);
  }
};

/** Everything the bridge can derive, in one call. */
export const scanSource = (home) => {
  if (!existsSync(home)) {
    throw businessError('HOME_MISSING', `home directory does not exist: ${home}`);
  }
  return {
    home,
    skills: scanSkills(home),
    commands: scanCommands(home),
    agents: scanAgents(home),
    rulesDoc: scanRulesDoc(home),
    mcp: scanMcpServers(home),
  };
};
