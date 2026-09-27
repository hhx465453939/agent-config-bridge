/**
 * MCP emitters.
 *
 * One reader (`@mcpServers` from the authoritative source) and one writer per
 * target format. The writers share two guarantees:
 *
 *   1. Merge, never replace. A target's own MCP servers, and any target-specific
 *      per-server keys (pi's `directTools`, for instance), survive untouched.
 *   2. Only names this bridge previously derived may be removed. A server the
 *      user added by hand is invisible to the removal pass.
 *
 * The latter is why `derivedNames` is passed in from state rather than inferred:
 * inferring "did I write this?" from file contents is guesswork, and guesswork
 * here deletes someone's configuration.
 */

import { existsSync, readFileSync } from 'node:fs';
import { businessError } from './errors.js';
import { expand, expandRecord } from './secrets.js';

/** Keys this bridge owns per server. Everything else in the entry is preserved. */
const OWNED_STDIO = ['command', 'args', 'env'];
const OWNED_HTTP = ['url', 'headers'];

const expandedServer = (classified, secrets) => {
  if (classified.transport === 'stdio') {
    const { value: env, missing } = expandRecord(classified.env, secrets);
    const args = classified.args.map((a) => expand(String(a), secrets, { missing }));
    const { value: commandAndArgs } = (() => {
      const cmdMissing = new Set();
      const command = expand(classified.command, secrets, { missing: cmdMissing });
      return { value: { command, extra: [...cmdMissing] } };
    })();
    return {
      entry: { command: commandAndArgs.command, args, env },
      missing,
      keys: OWNED_STDIO,
      transport: 'stdio',
    };
  }
  if (classified.transport === 'http') {
    const missing = new Set();
    const url = expand(classified.url, secrets, { missing });
    const headers = {};
    for (const [k, v] of Object.entries(classified.headers ?? {})) {
      headers[k] = expand(String(v), secrets, { missing });
    }
    return { entry: { url, headers }, missing, keys: OWNED_HTTP, transport: 'http' };
  }
  return { entry: null, missing: new Set(), keys: [], transport: 'unknown' };
};

/**
 * Build the merged `mcpServers` object for a JSON-shaped target.
 * @returns {{servers: object, missing: Set<string>, unsupported: string[], removed: string[]}}
 */
export const mergeJsonServers = ({ existing, classified, derivedNames, secrets, prune }) => {
  const servers = { ...(existing ?? {}) };
  const missing = new Set();
  const unsupported = [];
  const removed = [];

  for (const server of classified) {
    if (server.transport === 'unknown') {
      unsupported.push(`${server.name}: ${server.unsupported.join('; ')}`);
      continue;
    }
    const { entry, missing: m, keys, transport } = expandedServer(server, secrets);
    for (const name of m) missing.add(name);

    const previous = servers[server.name];
    const next = previous && typeof previous === 'object' ? { ...previous } : {};
    for (const key of keys) {
      if (entry[key] === undefined) delete next[key];
      else next[key] = entry[key];
    }
    if (next.type === undefined && server.transport === 'http') next.type = transport;
    if (server.transport === 'stdio' && next.type === 'http') delete next.type;
    servers[server.name] = next;
  }

  if (prune) {
    const live = new Set(classified.map((s) => s.name));
    for (const name of derivedNames ?? []) {
      if (!live.has(name) && name in servers) {
        delete servers[name];
        removed.push(name);
      }
    }
  }

  return { servers, missing, unsupported, removed };
};

export const emitMcpJson = ({ existingText, classified, derivedNames, secrets, prune }) => {
  let existing = {};
  if (existingText && existingText.trim() !== '') {
    try {
      existing = JSON.parse(existingText);
    } catch (err) {
      throw businessError('TARGET_JSON_CORRUPT', `target MCP file is not valid JSON (${err.message})`);
    }
  }
  const prior = existing?.mcpServers ?? {};
  const { servers, missing, unsupported, removed } = mergeJsonServers({
    existing: prior,
    classified,
    derivedNames,
    secrets,
    prune,
  });
  const next = { ...existing, mcpServers: servers };
  return {
    text: `${JSON.stringify(next, null, 2)}\n`,
    missing,
    unsupported,
    removed,
    derived: classified.filter((s) => s.transport !== 'unknown').map((s) => s.name).sort(),
  };
};

// ---------------------------------------------------------------------------
// TOML
// ---------------------------------------------------------------------------

const tomlString = (value) => {
  if (typeof value === 'string') return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  throw businessError('TOML_UNSUPPORTED', `cannot represent ${typeof value} in TOML`);
};

const tomlArray = (values) => `[${values.map(tomlString).join(', ')}]`;

const tomlInlineTable = (record) => {
  const parts = Object.entries(record).map(([k, v]) => `${k} = ${tomlString(v)}`);
  return `{ ${parts.join(', ')} }`;
};

/** Remove `[mcp_servers.X]` / `[mcp_servers.X.env]` blocks for the given names. */
export const stripTomlMcpSections = (text, names) => {
  const wanted = new Set(names);
  const lines = text.split('\n');
  const out = [];
  let skipping = false;
  for (const line of lines) {
    const m = /^\s*\[mcp_servers\.([^\].]+)/.exec(line);
    if (m) {
      skipping = wanted.has(m[1]);
      if (skipping) continue;
    } else if (/^\s*\[/.test(line)) {
      skipping = false;
    }
    if (!skipping) out.push(line);
  }
  // collapse trailing blank runs left behind by the removal
  return `${out.join('\n').replace(/\n{3,}/g, '\n\n').replace(/\s+$/, '')}\n`;
};

export const renderTomlMcpSections = (classified, secrets) => {
  const missing = new Set();
  const unsupported = [];
  const chunks = [];
  const emitted = [];

  for (const server of classified) {
    if (server.transport === 'unknown') {
      unsupported.push(`${server.name}: ${server.unsupported.join('; ')}`);
      continue;
    }
    const { entry, missing: m } = expandedServer(server, secrets);
    for (const name of m) missing.add(name);

    const lines = [`[mcp_servers.${server.name}]`];
    if (server.transport === 'stdio') {
      lines.push(`command = ${tomlString(entry.command)}`);
      if (entry.args.length > 0) lines.push(`args = ${tomlArray(entry.args)}`);
      if (entry.env && Object.keys(entry.env).length > 0) {
        lines.push(`env = ${tomlInlineTable(entry.env)}`);
      }
    } else {
      lines.push(`url = ${tomlString(entry.url)}`);
      if (entry.headers && Object.keys(entry.headers).length > 0) {
        lines.push(`http_headers = ${tomlInlineTable(entry.headers)}`);
      }
    }
    chunks.push(`${lines.join('\n')}\n`);
    emitted.push(server.name);
  }

  return { text: chunks.join('\n'), missing, unsupported, derived: emitted.sort() };
};

export const emitMcpToml = ({ existingText, classified, derivedNames, secrets, prune }) => {
  const previous = derivedNames ?? [];
  const liveNow = classified.filter((s) => s.transport !== 'unknown').map((s) => s.name);
  const toStrip = prune
    ? [...new Set([...previous, ...liveNow])]
    : [...new Set(liveNow)];

  const base = stripTomlMcpSections(existingText ?? '', toStrip);
  const { text: generated, missing, unsupported, derived } = renderTomlMcpSections(
    classified,
    secrets,
  );
  const merged = generated === '' ? base : `${base}\n${generated}`;

  const removed = prune ? previous.filter((n) => !liveNow.includes(n)) : [];
  return { text: merged.replace(/\n{3,}/g, '\n\n'), missing, unsupported, removed, derived };
};

export const mcpEmitterFor = (mode) => {
  if (mode === 'mcp-json') return emitMcpJson;
  if (mode === 'mcp-toml') return emitMcpToml;
  throw businessError('MANIFEST_INVALID', `unknown mcp mode ${mode}`);
};

export const readIfExists = (file) => (existsSync(file) ? readFileSync(file, 'utf8') : null);
