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

import { resolvePolicy } from '../lib/gates.js';
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
