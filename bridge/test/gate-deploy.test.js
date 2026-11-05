/**
 * Deployment-layer tests (v4): machine-local policy merge.
 *
 *   node --test bridge/test/gate-deploy.test.js
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
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

test('installed README documents what the gate actually enforces', () => {
  // The README is the only place a user can discover the tiers, the categories
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
