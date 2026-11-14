/**
 * dsh MCP reader: the plugin's translation and reconciliation, plus the
 * deployment that puts it on disk and the generated document it consumes.
 *
 *   node --test bridge/test/mcp-reader.test.js
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { apply as readerApply, createSync, translateServers } from '../../dsh/mcp/index.js';
import { mcpReaderStatus, planMcpReaderInstall } from '../lib/mcp-reader.js';
import { emitMcpJson } from '../lib/mcp.js';
import { loadManifest } from '../lib/manifest.js';
import { buildPlan, OP } from '../lib/plan.js';
import { withSandbox } from './sandbox.js';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

const withTmp = (fn) => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-mcp-reader-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

// --- translation ------------------------------------------------------------

test('stdio entries keep command, args, env and cwd', () => {
  const { entries, skipped } = translateServers({
    alpha: {
      command: 'node',
      args: ['server.js', 42],
      env: { LOG_LEVEL: 'info', DROPPED: 7 },
      cwd: 'E:/work/alpha',
      type: 'stdio',
    },
  });
  assert.deepEqual(skipped, []);
  assert.deepEqual(entries.alpha, {
    transport: 'stdio',
    command: 'node',
    args: ['server.js', '42'],
    env: { LOG_LEVEL: 'info' },
    cwd: 'E:/work/alpha',
  });
});

test('a url becomes streamable-http with string headers', () => {
  const { entries } = translateServers({
    remote: {
      type: 'http',
      url: 'https://mcp.example.com/mcp',
      headers: { Authorization: 'Bearer x', EMPTY: null },
    },
  });
  assert.deepEqual(entries.remote, {
    transport: 'streamable-http',
    url: 'https://mcp.example.com/mcp',
    headers: { Authorization: 'Bearer x' },
  });
});

test('what cannot be expressed is reported, never dropped silently', () => {
  const { entries, skipped } = translateServers({
    'bad name!': { command: 'x' },
    nothing: { transport: 'stdio' },
    nullish: null,
  });
  assert.deepEqual(entries, {});
  assert.deepEqual(skipped.map((s) => s.name).sort(), ['bad name!', 'nothing', 'nullish']);
});

// --- reconciliation ---------------------------------------------------------

const makeManager = () => {
  const registered = new Map();
  const log = [];
  return {
    log,
    registered,
    register(name, entry) {
      if (registered.has(name)) throw new Error(`already registered: ${name}`);
      registered.set(name, entry);
      log.push(`register:${name}`);
      let done = false;
      return () => {
        if (done) return;
        done = true;
        registered.delete(name);
        log.push(`dispose:${name}`);
      };
    },
    list() {
      return [...registered.keys()].map((name) => ({
        name,
        configured: false,
        status: { state: 'connected', toolCount: 3 },
      }));
    },
  };
};

const tempDoc = () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-mcp-doc-'));
  const file = join(dir, 'mcp.json');
  return {
    dir,
    file,
    write: (servers) => writeFileSync(file, `${JSON.stringify({ mcpServers: servers }, null, 2)}\n`),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
};

test('changed entries are rebuilt, removed entries withdrawn, untouched ones kept', () => {
  const doc = tempDoc();
  try {
    const manager = makeManager();
    const sync = createSync({ manager, file: doc.file, statusFile: join(doc.dir, 'mcp-status.json') });

    doc.write({
      keep: { command: 'node', args: ['a.js'] },
      changed: { command: 'node', args: ['b.js'] },
      dropped: { command: 'node', args: ['c.js'] },
    });
    sync.sync();
    assert.deepEqual([...manager.registered.keys()].sort(), ['changed', 'dropped', 'keep']);

    doc.write({
      keep: { command: 'node', args: ['a.js'] },
      changed: { command: 'node', args: ['b2.js'] },
      added: { url: 'https://mcp.example.com/mcp' },
    });
    sync.sync();

    assert.deepEqual([...manager.registered.keys()].sort(), ['added', 'changed', 'keep']);
    assert.equal(manager.log.filter((line) => line === 'register:keep').length, 1);
    assert.equal(manager.log.filter((line) => line === 'dispose:changed').length, 1);
    assert.equal(manager.log.filter((line) => line === 'dispose:dropped').length, 1);
    assert.equal(manager.registered.get('added').transport, 'streamable-http');

    const status = JSON.parse(readFileSync(join(doc.dir, 'mcp-status.json'), 'utf8'));
    assert.equal(status.registered, 3);
    assert.deepEqual(status.servers.map((s) => s.name).sort(), ['added', 'changed', 'keep']);
    assert.equal(status.servers[0].state, 'connected');
  } finally {
    doc.cleanup();
  }
});

test('a malformed or missing document leaves the live fleet alone', () => {
  const doc = tempDoc();
  try {
    const manager = makeManager();
    const sync = createSync({ manager, file: doc.file, statusFile: null });
    doc.write({ alpha: { command: 'node', args: ['a.js'] } });
    sync.sync();
    assert.deepEqual([...manager.registered.keys()], ['alpha']);

    writeFileSync(doc.file, '{ "mcpServers": { "alpha": ');
    assert.doesNotThrow(() => sync.sync());
    assert.deepEqual([...manager.registered.keys()], ['alpha']);

    rmSync(doc.file);
    assert.doesNotThrow(() => sync.sync());
    assert.deepEqual([...manager.registered.keys()], ['alpha']);
  } finally {
    doc.cleanup();
  }
});

test('one server failing to register does not abort the rest', () => {
  const doc = tempDoc();
  try {
    const manager = makeManager();
    const register = manager.register.bind(manager);
    manager.register = (name, entry) => {
      if (name === 'broken') throw new Error('boom');
      return register(name, entry);
    };
    const sync = createSync({ manager, file: doc.file, statusFile: null });
    doc.write({ broken: { command: 'node', args: [] }, fine: { command: 'node', args: [] } });
    sync.sync();
    assert.deepEqual([...manager.registered.keys()], ['fine']);
  } finally {
    doc.cleanup();
  }
});

test('apply registers through ctx.effect and releases everything on cleanup', () => {
  const doc = tempDoc();
  try {
    const manager = makeManager();
    const cleanups = [];
    const ctx = {
      mcpManager: manager,
      logger: { info() {}, warn() {} },
      effect(fn) {
        cleanups.push(fn());
      },
    };
    doc.write({
      alpha: { command: 'node', args: ['a.js'] },
      beta: { url: 'https://mcp.example.com/mcp' },
    });
    readerApply(ctx, { file: doc.file, watch: false, status: false });
    assert.deepEqual([...manager.registered.keys()].sort(), ['alpha', 'beta']);

    assert.equal(cleanups.length, 1);
    cleanups[0]();
    assert.deepEqual([...manager.registered.keys()], []);
  } finally {
    doc.cleanup();
  }
});

test('a UTF-8 BOM does not stop the reader from parsing the document', () => {
  const doc = tempDoc();
  try {
    const manager = makeManager();
    const sync = createSync({ manager, file: doc.file, statusFile: null });
    writeFileSync(doc.file, `\uFEFF${JSON.stringify({ mcpServers: { alpha: { command: 'node', args: [] } } })}`);
    sync.sync();
    assert.deepEqual([...manager.registered.keys()], ['alpha']);
  } finally {
    doc.cleanup();
  }
});

test('a BOM in an existing target file does not break the emitter', () => {
  const result = emitMcpJson({
    existingText: '\uFEFF{"mcpServers": {"hand-added": {"command": "mine", "args": []}}}',
    classified: [
      { name: 'alpha', transport: 'stdio', command: 'node', args: ['a.js'], env: {}, cwd: null },
    ],
    derivedNames: [],
    secrets: {},
    prune: false,
  });
  const parsed = JSON.parse(result.text);
  assert.ok(parsed.mcpServers['hand-added'], 'a hand-added entry must survive the merge');
  assert.equal(parsed.mcpServers.alpha.command, 'node');
  assert.deepEqual(result.derived, ['alpha']);
});

// --- manifest ---------------------------------------------------------------
test('the dsh manifest declares the document, the reader, and keeps the profile private', () => {
  const manifest = loadManifest(repo, 'dsh');
  assert.ok(manifest.mcpReader?.supported, 'dsh must declare an MCP reader');
  assert.equal(manifest.mcpReader.installAs, 'agent-config-mcp');
  assert.equal(manifest.mcpReader.autoLoad, false);
  assert.ok(manifest.mcpReader.mountHint.includes('agent-config-mcp'));

  const rule = manifest.managed.find((entry) => entry.kind === 'mcp');
  assert.ok(rule, 'dsh must declare the generated MCP document');
  assert.equal(rule.mode, 'mcp-json');
  assert.ok(rideSafe(rule.to, manifest), 'the document must not sit under never_touch');

  assert.ok(manifest.neverTouch.includes('.dsh/profiles'));
});

const rideSafe = (target, manifest) =>
  manifest.neverTouch.every((guard) => target !== guard && !target.startsWith(`${guard}/`));

test('an invalid reader block is refused at load', async () => {
  await withSandbox({ install: ['dsh'] }, (sandbox) => {
    const file = join(sandbox.repo, 'bridge', 'targets', 'dsh.json');
    const base = JSON.parse(readFileSync(file, 'utf8'));

    const broken = { ...base, mcp_reader: { ...base.mcp_reader, install_as: 'Not A Slug' } };
    writeFileSync(file, `${JSON.stringify(broken, null, 2)}\n`);
    assert.throws(() => loadManifest(sandbox.repo, 'dsh'), /mcp_reader\.install_as|MANIFEST_INVALID/);
  });
});

// --- deployment -------------------------------------------------------------

test('plan installs the reader; a second plan is a no-op', () => {
  withTmp((dir) => {
    const home = join(dir, 'home');
    mkdirSync(join(home, '.dsh'), { recursive: true });
    const manifest = loadManifest(repo, 'dsh');

    const first = planMcpReaderInstall({ repo, home, manifest });
    assert.ok(first.length >= 3);
    for (const action of first) {
      assert.equal(action.op, OP.ADD);
      if (action.content !== undefined) writeFileSync(action.to, action.content);
      else {
        mkdirSync(dirname(action.to), { recursive: true });
        writeFileSync(action.to, readFileSync(action.from));
      }
    }

    const second = planMcpReaderInstall({ repo, home, manifest });
    assert.deepEqual(second.filter((action) => action.op !== OP.KEEP).map((a) => a.to), []);

    const status = mcpReaderStatus({ home, manifest });
    assert.equal(status.installed, true);
    assert.equal(status.manualMount, true);
  });
});

test('buildPlan writes the MCP document the reader consumes', async () => {
  await withSandbox({ install: ['dsh'] }, (sandbox) => {
    const built = buildPlan({
      repo: sandbox.repo,
      home: sandbox.home,
      targetNames: ['dsh'],
      state: { version: 1, agents: {} },
      prune: false,
      adoptNames: ['dsh'],
    });
    const target = built.targets[0];
    const action = target.actions.find((entry) => entry.kind === 'mcp');
    assert.ok(action, 'the generated document must be planned');
    assert.ok(action.to.endsWith(join('.dsh', 'agent-config-bridge', 'mcp.json')));
    assert.ok(action.content.includes('"remote-tool"'));
  });
});
