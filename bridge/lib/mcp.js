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
const OWNED_STDIO = ['command', 'args', 'env', 'cwd'];
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
    // `cwd` is expanded like `command` (a leading `~/` and `${VAR}` both work)
    // and kept null when the source has none, so a target that added its own
    // cwd is brought back in line with the authority instead of drifting.
    const cwd = typeof classified.cwd === 'string' && classified.cwd !== ''
      ? expand(classified.cwd, secrets, { missing })
      : null;
    return {
      // A null cwd is not written at all: `"cwd": null` in a config file is a
      // field a human then has to reason about, and merge already treats a
      // missing entry as "delete the key".
      entry: cwd ? { command: commandAndArgs.command, args, env, cwd } : { command: commandAndArgs.command, args, env },
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

export const emitMcpJson = ({
  existingText,
  classified,
  derivedNames,
  secrets,
  prune,
  serverSettings = null,
}) => {
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

  // Per-server keys the manifest declares (pi's `exposure`, for example).
  // A `'*'` entry applies to every derived server first, then the named entries
  // refine it: a target can default the whole list without repeating it, and
  // still single out one server. Only names the source actually derives are
  // touched: a stale override must not resurrect a server that is gone from the
  // source, especially under --prune, where the user explicitly asked for stale
  // entries to be removed.
  if (serverSettings) {
    const { '*': every, ...named } = serverSettings;
    const derived = new Set(classified.filter((s) => s.transport !== 'unknown').map((s) => s.name));
    if (every && typeof every === 'object') {
      for (const name of derived) {
        servers[name] = { ...servers[name], ...every };
      }
    }
    for (const [name, settings] of Object.entries(named)) {
      if (!servers[name] || !derived.has(name)) continue;
      servers[name] = { ...servers[name], ...settings };
    }
  }

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
      // The Codex target's schema has no working-directory field. Say so instead
      // of writing a config that looks complete: a silently dropped cwd is how a
      // server starts reading the wrong directory.
      if (entry.cwd) {
        unsupported.push(`${server.name}: cwd (${entry.cwd}) cannot be expressed in config.toml`);
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
