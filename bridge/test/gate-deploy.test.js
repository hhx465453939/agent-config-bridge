/**
 * Deployment-layer tests (v4): machine-local policy merge.
 *
 *   node --test bridge/test/gate-deploy.test.js
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { planGateInstall, resolvePolicy } from '../lib/gates.js';
import { machineGateConfigFile } from '../lib/paths.js';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

const manifest = {
  name: 'pi',
  display: 'pi',
  gates: {
    adapter: 'pi',
    installAs: 'enforce-rules',
    extensionDir: '.pi/agent/extensions',
    policy: { config: { project_roots: [] } },
  },
};

const dshManifest = {
  name: 'dsh',
  display: 'DeepSeek Harness (dsh)',
  gates: {
    adapter: 'dsh',
    installAs: 'agent-config-gates',
    extension_dir: '.dsh/plugins',
    extensionDir: '.dsh/plugins',
    autoLoad: false,
    policy: { config: { project_roots: [] } },
  },
};

const withHome = (fn) => {
  const home = mkdtempSync(join(tmpdir(), 'gate-deploy-'));
  try {
    return fn(home);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
};

const writeMachine = (home, content) => {
  const file = machineGateConfigFile(home);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content, 'utf8');
};

test('machine override: absent file keeps the shipped policy', () => {
  withHome((home) => {
    const policy = resolvePolicy({ repo, manifest, home });
    assert.deepEqual(policy.config.project_roots, []);
  });
});

test('machine override: config is merged, checks are not overridden', () => {
  withHome((home) => {
    writeMachine(
      home,
      JSON.stringify({ config: { project_roots: ['<dev-root>'] }, checks: ['only-this'] }),
    );
    const policy = resolvePolicy({ repo, manifest, home });
    assert.deepEqual(policy.config.project_roots, ['<dev-root>']);
    assert.ok(policy.checks.includes('graph-before-read'), 'checks stay owned by the repository');
    assert.ok(!policy.checks.includes('only-this'), 'machine config cannot silently drop checks');
  });
});

test('machine override: invalid JSON is a hard error, not a silent no-op', () => {
  withHome((home) => {
    writeMachine(home, '{ not json');
    assert.throws(() => resolvePolicy({ repo, manifest, home }), /not valid JSON/);
  });
});

test('installed README documents what the gate actually enforces', () => {  // The README is the only place a user can discover the tiers, the categories
  // and `/gate`. It shipped v1 text ("three tiers", no categories, no `/gate`)
  // for a week after the two-layer model landed, because nothing asserted it.
  withHome((home) => {
    const actions = planGateInstall({ repo, home, manifest });
    const readme = actions.find((a) => String(a.to).endsWith('README.md'));
    assert.ok(readme, 'the install plan writes a README');
    const text = readme.content;

    assert.match(text, /two layers|TWO layers/i, 'states the two-layer model, not "three tiers"');
    assert.doesNotMatch(text, /three tiers/i, 'the v1 wording must not come back');
    for (const category of [
      'delete', 'git-history', 'git-force-push', 'db-ddl',
      'perm-recursive', 'process-kill', 'raw-write',
    ]) {
      assert.ok(text.includes(category), `README names the ${category} category`);
    }
    assert.match(text, /\/gate/, 'README tells the user the /gate command exists');
    assert.match(text, /gate-policy\.json/, 'README names where a persistent grant lives');
    assert.match(text, /no-self-grant/, 'README says the agent cannot grant itself');
    assert.match(text, /Tightening always beats loosening/, 'README states the priority rule');
  });
});

// --- dsh: the desktop deployment surface ------------------------------------

test('dsh install: the gate directory declares its module type', () => {
  withHome((home) => {
    const actions = planGateInstall({ repo, home, manifest: dshManifest });
    const pkg = actions.find((a) => String(a.to).endsWith('package.json'));
    // dsh imports dsh/index.js as an ES module. Without a package.json the file
    // is a typeless module: it loads only while the runtime detects module
    // syntax, warns on every load, and dies if an ancestor declares CommonJS.
    assert.ok(pkg, 'a package.json must be written beside the adapter');
    assert.equal(JSON.parse(pkg.content).type, 'module');
  });
});

test('dsh install: the mount snippet is a specifier, not a home-relative path', () => {
  withHome((home) => {
    const actions = planGateInstall({ repo, home, manifest: dshManifest });
    const readme = actions.find((a) => String(a.to).endsWith('README.md'));
    const text = readme.content;

    // The Cordis loader resolves module specifiers; a bare '~/.dsh/plugins/...'
    // path throws instead, which is what the first version told users to paste.
    assert.match(text, /name: '\.\.\/\.\.\/plugins\/agent-config-gates\/dsh\/index\.js'/, 'relative specifier anchored beside the patch file');
    assert.doesNotMatch(text, /- name: '\.dsh\/plugins/, 'the old bare path must not come back');
    assert.match(text, /insert:/, 'a row is inserted, not merely named');
    assert.match(text, /policyPath: '.+policy\.json'/, 'policyPath is absolute');
  });
});

test('pi install: no package.json lands in the extension directory', () => {
  withHome((home) => {
    const actions = planGateInstall({ repo, home, manifest });
    assert.ok(
      !actions.some((a) => String(a.to).endsWith('package.json')),
      'pi extensions are loaded by pi, not by Node as modules',
    );
    assert.ok(actions.some((a) => String(a.to).endsWith('index.js')), 'pi keeps its directory entry point');
  });
});

test('dsh manifest: the profile tree and the credential store are off limits', () => {
  const target = JSON.parse(readFileSync(join(repo, 'bridge', 'targets', 'dsh.json'), 'utf8'));
  for (const path of ['.dsh/profiles', '.dsh/storages', '.dsh/sessions', '.dsh/.credentials.yaml']) {
    assert.ok(target.never_touch.includes(path), `${path} must never be written by the bridge`);
  }
  assert.ok(
    !target.never_touch.includes('.dsh/plugins'),
    'the gate is installed under .dsh/plugins, so that directory cannot be never_touch',
  );
  assert.equal(target.gates.auto_load, false, 'dsh does not auto-load an extensions directory');
  assert.equal(target.gates.extension_dir, '.dsh/plugins');
});
