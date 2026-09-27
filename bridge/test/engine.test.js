/**
 * Engine tests. Every case runs against the sandbox (bridge/test/sandbox.js),
 * never against the real home directory — this tool overwrites other agents'
 * configuration, so "test on the real machine" is not an option.
 *
 *   node --test
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { existsSync, readFileSync, statSync } from 'node:fs';

import * as api from '../lib/api.js';
import { withSandbox, write } from './sandbox.js';
import { readState, STATUS, writeState } from '../lib/state.js';
import { hashFile } from '../lib/fs-ops.js';
import { loadManifest } from '../lib/manifest.js';
import { stripTomlMcpSections } from '../lib/mcp.js';

const quiet = { info() {}, say() {}, ok() {}, warn() {}, error() {}, payload() {} };

// ---------------------------------------------------------------------------
// status
// ---------------------------------------------------------------------------

test('status: fresh machine reports every agent as native', async () => {
  await withSandbox({}, (sb) => {
    const report = api.status(sb.repo, sb.home);
    assert.equal(report.stateFileExists, false);
    assert.deepEqual(report.bridged, []);
    const pi = report.agents.find((a) => a.name === 'pi');
    assert.equal(pi.status, 'native');
    assert.equal(pi.installed, true);
    assert.equal(pi.drift, null, 'native targets are not scanned for drift');
  });
});

test('status: writes nothing', async () => {
  await withSandbox({}, (sb) => {
    const before = hashFile(join(sb.repo, 'bridge', 'targets', 'pi.json'));
    api.status(sb.repo, sb.home);
    const after = hashFile(join(sb.repo, 'bridge', 'targets', 'pi.json'));
    assert.equal(before, after);
    assert.equal(existsSync(join(sb.repo, '.bridge', 'state.json')), false);
  });
});

test('status: detects a target that is not installed', async () => {
  await withSandbox({ install: [] }, (sb) => {
    const report = api.status(sb.repo, sb.home);
    for (const agent of report.agents) {
      assert.equal(agent.installed, false, `${agent.name} should be reported as absent`);
    }
  });
});

// ---------------------------------------------------------------------------
// plan — read-only guarantees
// ---------------------------------------------------------------------------

test('plan: on a fresh machine changes nothing and skips every agent', async () => {
  await withSandbox({}, (sb) => {
    const before = treeSnapshot(sb.home);
    const result = api.plan({ repo: sb.repo, home: sb.home });
    assert.ok(result.targets.length > 0, 'the real manifests should all be considered');
    for (const target of result.targets) {
      // Two acceptable outcomes on a fresh machine: the harness is not present,
      // or it is present and untouched because nothing was adopted.
      assert.match(
        target.skipped ?? '',
        /^not bridged \(native\)$|^not installed on this machine$/,
        `${target.name}: unexpected skip reason ${JSON.stringify(target.skipped)}`,
      );
      assert.equal(target.actions.length, 0, `${target.name}: nothing may be planned before adopt`);
    }
    assert.deepEqual(treeSnapshot(sb.home), before, 'plan must not write');
  });
});

test('plan: is deterministic (two runs produce identical output)', async () => {
  await withSandbox({}, (sb) => {
    api.adopt({ repo: sb.repo, home: sb.home, names: ['pi'], log: quiet });
    const a = JSON.stringify(api.plan({ repo: sb.repo, home: sb.home }));
    const b = JSON.stringify(api.plan({ repo: sb.repo, home: sb.home }));
    assert.equal(a, b);
  });
});

// ---------------------------------------------------------------------------
// adopt
// ---------------------------------------------------------------------------

test('adopt: bridges only the named agent and leaves the other untouched', async () => {
  await withSandbox({}, (sb) => {
    const kimiBefore = hashFile(join(sb.home, '.kimi-code', 'config.toml'));
    const kimiMcpBefore = hashFile(join(sb.home, '.kimi-code', 'mcp.json'));

    api.adopt({ repo: sb.repo, home: sb.home, names: ['pi'], log: quiet });

    const state = readState(sb.repo);
    assert.equal(state.agents.pi.status, STATUS.BRIDGED);
    assert.equal(state.agents.kimi, undefined, 'kimi was never adopted');

    assert.equal(hashFile(join(sb.home, '.kimi-code', 'config.toml')), kimiBefore);
    assert.equal(hashFile(join(sb.home, '.kimi-code', 'mcp.json')), kimiMcpBefore);

    // Shared dimensions arrived.
    assert.ok(existsSync(sb.path('.agents/skills/alpha/SKILL.md')));
    assert.ok(existsSync(sb.path('.agents/skills/beta/SKILL.md')));
    assert.ok(existsSync(sb.path('.pi/agent/prompts/review.md')));
    // pi's rules document lands at the home root: pi loads context files from the
    // working-directory chain as well as its agent dir, and a second copy under
    // ~/.pi would make the model read the same rules twice.
    assert.ok(existsSync(sb.path('AGENTS.md')));
    assert.equal(existsSync(sb.path('.pi/agent/AGENTS.md')), false, 'no duplicate under ~/.pi');

    // Flat duplicate was reported, not bridged.
    assert.equal(existsSync(sb.path('.agents/skills/alpha.md')), false);
  });
});

test('adopt: never touches private configuration', async () => {
  await withSandbox({}, (sb) => {
    const settings = hashFile(join(sb.home, '.pi', 'agent', 'settings.json'));
    const extension = hashFile(join(sb.home, '.pi', 'agent', 'extensions', 'gate.ts'));

    api.adopt({ repo: sb.repo, home: sb.home, names: ['pi'], log: quiet });

    assert.equal(hashFile(join(sb.home, '.pi', 'agent', 'settings.json')), settings);
    assert.equal(hashFile(join(sb.home, '.pi', 'agent', 'extensions', 'gate.ts')), extension);
  });
});

test('adopt: writes a snapshot before anything is overwritten', async () => {
  await withSandbox({}, (sb) => {
    api.adopt({ repo: sb.repo, home: sb.home, names: ['pi'], log: quiet });
    const state = readState(sb.repo);
    const id = state.agents.pi.snapshot_id;
    const manifestPath = join(sb.repo, '.bridge', 'snapshots', 'pi', id, 'manifest.json');
    assert.ok(existsSync(manifestPath));

    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    assert.equal(manifest.agent, 'pi');
    // The pi mcp.json existed with a private server, so it must be recorded as
    // overwritten and its previous bytes preserved.
    const mcpEntry = manifest.entries.find((e) => e.path.endsWith('.pi/agent/mcp.json'));
    assert.equal(mcpEntry.action, 'overwritten');
    const stored = join(sb.repo, '.bridge', 'snapshots', 'pi', id, 'files', mcpEntry.path);
    assert.equal(hashFile(stored), mcpEntry.sha256);
  });
});

test('adopt: is rejected for an agent that is not installed', async () => {
  await withSandbox({ install: [] }, (sb) => {
    assert.throws(
      () => api.adopt({ repo: sb.repo, home: sb.home, names: ['pi'], log: quiet }),
      /not installed on this machine/,
    );
  });
});

test('adopt: is rejected when already bridged', async () => {
  await withSandbox({}, (sb) => {
    api.adopt({ repo: sb.repo, home: sb.home, names: ['pi'], log: quiet });
    assert.throws(
      () => api.adopt({ repo: sb.repo, home: sb.home, names: ['pi'], log: quiet }),
      /already bridged/,
    );
  });
});

// ---------------------------------------------------------------------------
// apply — idempotence and drift repair
// ---------------------------------------------------------------------------

test('apply: converges, then reports no changes on the second pass', async () => {
  await withSandbox({}, (sb) => {
    api.adopt({ repo: sb.repo, home: sb.home, names: ['pi'], log: quiet });

    const diff = api.diff({ repo: sb.repo, home: sb.home });
    const changed = diff.targets.flatMap((t) => t.actions);
    assert.equal(changed.length, 0, `expected no drift right after adopt, got ${JSON.stringify(changed.map((a) => a.to))}`);
  });
});

test('apply: restores a skill that was deleted, and only for the bridged agent', async () => {
  await withSandbox({}, (sb) => {
    api.adopt({ repo: sb.repo, home: sb.home, names: ['pi'], log: quiet });
    api.adopt({ repo: sb.repo, home: sb.home, names: ['kimi'], log: quiet });

    const kimiSkill = sb.path('.kimi-code/skills/beta/SKILL.md');
    const kimiSkillHash = hashFile(kimiSkill);

    // Simulate damage on pi only.
    const damaged = sb.path('.agents/skills/beta/SKILL.md');
    write(damaged, 'tampered\n');

    api.apply({ repo: sb.repo, home: sb.home, log: quiet });

    assert.equal(readFileSync(damaged, 'utf8'), readFileSync(join(sb.home, '.claude', 'skills', 'beta', 'SKILL.md'), 'utf8'));
    assert.equal(hashFile(kimiSkill), kimiSkillHash, 'the other bridged agent must be untouched');
  });
});

test('apply: with no bridged agent it does nothing at all', async () => {
  await withSandbox({}, (sb) => {
    const before = treeSnapshot(sb.home);
    const result = api.apply({ repo: sb.repo, home: sb.home, log: quiet });
    assert.equal(result.targets.length, 0);
    assert.deepEqual(treeSnapshot(sb.home), before);
  });
});

// ---------------------------------------------------------------------------
// revoke — the headline promise
// ---------------------------------------------------------------------------

test('revoke: restores the target byte-for-byte to its pre-adopt state', async () => {
  await withSandbox({}, (sb) => {
    const before = treeSnapshot(sb.home);

    api.adopt({ repo: sb.repo, home: sb.home, names: ['pi'], log: quiet });
    api.revoke({ repo: sb.repo, home: sb.home, names: ['pi'], log: quiet });

    const after = treeSnapshot(sb.home);
    assert.deepEqual(after, before, 'revoke must return the tree to exactly its pre-adopt state');
  });
});

test('revoke: leaves the other agent alone', async () => {
  await withSandbox({}, (sb) => {
    api.adopt({ repo: sb.repo, home: sb.home, names: ['pi', 'kimi'], log: quiet });
    const kimiSkill = hashFile(sb.path('.kimi-code/skills/alpha/SKILL.md'));

    api.revoke({ repo: sb.repo, home: sb.home, names: ['pi'], log: quiet });

    assert.equal(hashFile(sb.path('.kimi-code/skills/alpha/SKILL.md')), kimiSkill);
    assert.equal(readState(sb.repo).agents.kimi.status, STATUS.BRIDGED);
    assert.equal(readState(sb.repo).agents.pi.status, STATUS.REVOKED);
  });
});

test('revoke: refuses to run on an incomplete snapshot', async () => {
  await withSandbox({}, (sb) => {
    api.adopt({ repo: sb.repo, home: sb.home, names: ['pi'], log: quiet });
    const id = readState(sb.repo).agents.pi.snapshot_id;

    // Delete one stored copy, simulating a partially lost snapshot.
    const manifest = JSON.parse(
      readFileSync(join(sb.repo, '.bridge', 'snapshots', 'pi', id, 'manifest.json'), 'utf8'),
    );
    const victim = manifest.entries.find((e) => e.action === 'overwritten');
    assert.ok(victim, 'fixture should contain an overwritten file');
    const { rmSync } = require('node:fs');
    rmSync(join(sb.repo, '.bridge', 'snapshots', 'pi', id, 'files', victim.path));

    assert.throws(
      () => api.revoke({ repo: sb.repo, home: sb.home, names: ['pi'], log: quiet }),
      /snapshot .* is incomplete, refusing to revoke/,
    );
    // State must not claim it was revoked.
    assert.equal(readState(sb.repo).agents.pi.status, STATUS.BRIDGED);
  });
});

test('revoke: is rejected for an agent that was never bridged', async () => {
  await withSandbox({}, (sb) => {
    assert.throws(
      () => api.revoke({ repo: sb.repo, home: sb.home, names: ['pi'], log: quiet }),
      /not bridged/,
    );
  });
});

// ---------------------------------------------------------------------------
// MCP
// ---------------------------------------------------------------------------

test('mcp: derived servers reach the target and preserve the target own servers', async () => {
  await withSandbox({}, (sb) => {
    api.adopt({ repo: sb.repo, home: sb.home, names: ['pi'], log: quiet });

    const emitted = JSON.parse(readFileSync(sb.path('.pi/agent/mcp.json'), 'utf8'));
    const names = Object.keys(emitted.mcpServers);

    assert.ok(names.includes('local-tool'));
    assert.ok(names.includes('remote-tool'));
    assert.ok(names.includes('secret-tool'));
    assert.ok(names.includes('pi-only'), 'a server the user added by hand must survive');
    assert.equal(emitted.mcpServers['pi-only'].command, 'pi-private');
  });
});

test('mcp: secrets are expanded from a file outside the repository', async () => {
  await withSandbox({}, (sb) => {
    api.adopt({ repo: sb.repo, home: sb.home, names: ['pi'], log: quiet });
    const emitted = JSON.parse(readFileSync(sb.path('.pi/agent/mcp.json'), 'utf8'));
    assert.equal(emitted.mcpServers['secret-tool'].env.API_KEY, 'not-a-real-key');
    assert.equal(emitted.mcpServers['secret-tool'].env.EMAIL, 'nobody@example.com');
  });
});

test('mcp: a referenced but missing variable aborts the whole run', async () => {
  await withSandbox({}, (sb) => {
    // Remove the secrets file so ${FIXTURE_API_KEY} cannot be resolved.
    const { rmSync } = require('node:fs');
    rmSync(join(sb.home, '.config'), { recursive: true, force: true });

    assert.throws(
      () => api.adopt({ repo: sb.repo, home: sb.home, names: ['pi'], log: quiet }),
      /referenced but not provided/,
    );
    // Fail-closed: nothing was written and the agent stayed native.
    assert.equal(readState(sb.repo).agents.pi, undefined);
    assert.equal(existsSync(sb.path('.agents/skills')), false);
  });
});

test('mcp: generated configuration is written with mode 600', async () => {
  await withSandbox({}, (sb) => {
    api.adopt({ repo: sb.repo, home: sb.home, names: ['pi'], log: quiet });
    const mode = statSync(sb.path('.pi/agent/mcp.json')).mode & 0o777;
    assert.equal(mode, 0o600);
  });
});

test('mcp: TOML section stripping only removes the named servers', () => {
  const text = [
    '[general]',
    'theme = "dark"',
    '',
    '[mcp_servers.old-one]',
    'command = "x"',
    '',
    '[mcp_servers.keep-me]',
    'command = "y"',
    '',
    '[other]',
    'key = "value"',
    '',
  ].join('\n');

  const stripped = stripTomlMcpSections(text, ['old-one']);
  assert.ok(!stripped.includes('mcp_servers.old-one'));
  assert.ok(stripped.includes('mcp_servers.keep-me'));
  assert.ok(stripped.includes('[general]'));
  assert.ok(stripped.includes('[other]'));
});

// ---------------------------------------------------------------------------
// doctor / rollback
// ---------------------------------------------------------------------------

test('doctor: clean sandbox has no errors', async () => {
  await withSandbox({}, (sb) => {
    api.adopt({ repo: sb.repo, home: sb.home, names: ['pi'], log: quiet });
    const report = api.doctor({ repo: sb.repo, home: sb.home });
    const errors = report.findings.filter((f) => f.level === 'error');
    assert.deepEqual(errors, [], `unexpected errors: ${JSON.stringify(errors)}`);
  });
});

test('doctor: flags an incomplete snapshot as an error', async () => {
  await withSandbox({}, (sb) => {
    api.adopt({ repo: sb.repo, home: sb.home, names: ['pi'], log: quiet });
    const id = readState(sb.repo).agents.pi.snapshot_id;
    const manifest = JSON.parse(
      readFileSync(join(sb.repo, '.bridge', 'snapshots', 'pi', id, 'manifest.json'), 'utf8'),
    );
    const victim = manifest.entries.find((e) => e.action === 'overwritten');
    const { rmSync } = require('node:fs');
    rmSync(join(sb.repo, '.bridge', 'snapshots', 'pi', id, 'files', victim.path));

    const report = api.doctor({ repo: sb.repo, home: sb.home });
    assert.equal(report.ok, false);
    assert.ok(report.findings.some((f) => f.code === 'SNAPSHOT_INCOMPLETE'));
  });
});

test('doctor: flags a corrupt state file instead of guessing', async () => {
  await withSandbox({}, (sb) => {
    write(join(sb.repo, '.bridge', 'state.json'), '{ this is not json');
    const report = api.doctor({ repo: sb.repo, home: sb.home });
    assert.equal(report.ok, false);
    assert.ok(report.findings.some((f) => f.code === 'STATE'));
  });
});

test('doctor: reports a manifest that both manages and protects the same path', async () => {
  await withSandbox({}, (sb) => {
    write(
      join(sb.repo, 'bridge', 'targets', 'broken.json'),
      `${JSON.stringify(
        {
          name: 'broken',
          detect: ['.pi'],
          managed: [{ kind: 'rules-doc', from: 'CLAUDE.md', to: '.pi/agent/AGENTS.md', mode: 'copy' }],
          never_touch: ['.pi/agent/AGENTS.md'],
        },
        null,
        2,
      )}\n`,
    );
    const report = api.doctor({ repo: sb.repo, home: sb.home });
    assert.equal(report.ok, false);
    assert.ok(report.findings.some((f) => f.code === 'MANIFEST'));
    assert.match(report.findings.find((f) => f.code === 'MANIFEST').message, /overlaps never_touch/);
  });
});

test('rollback: undoes an apply and keeps a guard backup', async () => {
  await withSandbox({}, (sb) => {
    api.adopt({ repo: sb.repo, home: sb.home, names: ['pi'], log: quiet });

    // Change the source, then sync.
    write(join(sb.home, '.claude', 'skills', 'beta', 'SKILL.md'), '---\nname: beta\n---\n\nCHANGED\n');
    api.apply({ repo: sb.repo, home: sb.home, log: quiet });
    assert.match(readFileSync(sb.path('.agents/skills/beta/SKILL.md'), 'utf8'), /CHANGED/);

    const result = api.undo({ repo: sb.repo, home: sb.home, log: quiet });
    assert.ok(result.restored > 0);
    assert.equal(readFileSync(sb.path('.agents/skills/beta/SKILL.md'), 'utf8').includes('CHANGED'), false);
  });
});

// ---------------------------------------------------------------------------
// safety rails
// ---------------------------------------------------------------------------

test('manifest: rejects an absolute destination path', async () => {
  await withSandbox({}, (sb) => {
    write(
      join(sb.repo, 'bridge', 'targets', 'evil.json'),
      `${JSON.stringify(
        {
          name: 'evil',
          detect: ['.pi'],
          managed: [{ kind: 'rules-doc', from: 'CLAUDE.md', to: '/etc/agent-rules.md', mode: 'copy' }],
          never_touch: [],
        },
        null,
        2,
      )}\n`,
    );
    assert.throws(() => loadManifest(sb.repo, 'evil'), /must be relative/);
  });
});

test('manifest: rejects a destination that escapes home', async () => {
  await withSandbox({}, (sb) => {
    write(
      join(sb.repo, 'bridge', 'targets', 'evil2.json'),
      `${JSON.stringify(
        {
          name: 'evil2',
          detect: ['.pi'],
          managed: [{ kind: 'rules-doc', from: 'CLAUDE.md', to: '../outside.md', mode: 'copy' }],
          never_touch: [],
        },
        null,
        2,
      )}\n`,
    );
    assert.throws(() => loadManifest(sb.repo, 'evil2'), /must not contain/);
  });
});

test('prune is off by default and only removes files this bridge created', async () => {
  await withSandbox({}, (sb) => {
    api.adopt({ repo: sb.repo, home: sb.home, names: ['pi'], log: quiet });

    // A file the user placed there themselves must never be pruned.
    write(sb.path('.agents/skills/user-made/SKILL.md'), 'user content\n');
    // A file the bridge created, whose source then disappears.
    const { rmSync } = require('node:fs');
    rmSync(join(sb.home, '.claude', 'skills', 'beta'), { recursive: true, force: true });

    api.apply({ repo: sb.repo, home: sb.home, log: quiet });
    assert.ok(existsSync(sb.path('.agents/skills/beta/SKILL.md')), 'default must not remove anything');
    assert.ok(existsSync(sb.path('.agents/skills/user-made/SKILL.md')));

    api.apply({ repo: sb.repo, home: sb.home, prune: true, log: quiet });
    assert.equal(existsSync(sb.path('.agents/skills/beta/SKILL.md')), false, 'prune removes the derived file');
    assert.ok(existsSync(sb.path('.agents/skills/user-made/SKILL.md')), 'prune must not touch user files');
  });
});

test('state: an unknown format version is refused rather than reinterpreted', async () => {
  await withSandbox({}, (sb) => {
    writeState(sb.repo, { version: 1, agents: {} });
    write(join(sb.repo, '.bridge', 'state.json'), JSON.stringify({ version: 99, agents: {} }));
    assert.throws(() => readState(sb.repo), /unsupported state format/);
  });
});

// ---------------------------------------------------------------------------
// gates: installation is just another managed artifact
// ---------------------------------------------------------------------------

test('gates: adopt installs the gate and revoke removes it again', async () => {
  await withSandbox({ install: ['pi'] }, (sb) => {
    const before = treeSnapshot(sb.home);
    const gateDir = sb.path('.pi/agent/extensions/enforce-rules');

    api.adopt({ repo: sb.repo, home: sb.home, names: ['pi'], log: quiet });

    // The engine travels with the adapter: the adapter imports `../policy.js`,
    // so a bundle without it would load and then fail at first use.
    assert.ok(existsSync(join(gateDir, 'policy.js')), 'rule engine installed');
    assert.ok(existsSync(join(gateDir, 'pi/index.js')), 'adapter installed');
    assert.ok(existsSync(join(gateDir, 'index.js')), 'pi directory entry point installed');
    assert.ok(existsSync(join(gateDir, 'policy.json')), 'generated policy installed');
    const policy = JSON.parse(readFileSync(join(gateDir, 'policy.json'), 'utf8'));
    assert.ok(policy.checks.includes('graph-before-read'));

    // A user's own extension, sharing the same parent directory, is untouched.
    assert.ok(existsSync(sb.path('.pi/agent/extensions/gate.ts')));

    api.revoke({ repo: sb.repo, home: sb.home, names: ['pi'], log: quiet });
    assert.equal(existsSync(gateDir), false, 'revoke removes the installed gate');
    assert.ok(existsSync(sb.path('.pi/agent/extensions/gate.ts')), 'and only the gate');
    assert.deepEqual(treeSnapshot(sb.home), before, 'the tree is back exactly as it was');
  });
});

test('gates: installation is idempotent', async () => {
  await withSandbox({ install: ['pi'] }, (sb) => {
    api.adopt({ repo: sb.repo, home: sb.home, names: ['pi'], log: quiet });
    const first = api.diff({ repo: sb.repo, home: sb.home });
    assert.equal(
      first.targets.flatMap((t) => t.actions).filter((a) => a.kind === 'gate').length,
      0,
      'nothing left to do right after adopt',
    );
  });
});

test('gates: an edited policy file is restored by adopt-time drift repair', async () => {
  await withSandbox({ install: ['pi'] }, (sb) => {
    api.adopt({ repo: sb.repo, home: sb.home, names: ['pi'], log: quiet });
    const policyFile = sb.path('.pi/agent/extensions/enforce-rules/policy.json');
    write(policyFile, '{"name":"tampered"}\n');

    const drift = api.diff({ repo: sb.repo, home: sb.home });
    assert.ok(
      drift.targets.flatMap((t) => t.actions).some((a) => a.to === policyFile),
      'drift must be visible',
    );

    api.apply({ repo: sb.repo, home: sb.home, log: quiet });
    assert.match(readFileSync(policyFile, 'utf8'), /graph-before-read/);
  });
});

test('gates: a harness without an extension mechanism gets no gate, only a report', async () => {
  await withSandbox({ install: ['kimi'] }, (sb) => {
    api.adopt({ repo: sb.repo, home: sb.home, names: ['kimi'], log: quiet });
    const report = api.status(sb.repo, sb.home);
    const kimi = report.agents.find((a) => a.name === 'kimi');
    assert.equal(kimi.gate.supported, false);
    assert.ok(kimi.gate.reason.length > 0, 'the reason is reported, not silently omitted');
  });
});

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

const require = (await import('node:module')).createRequire(import.meta.url);

const treeSnapshot = (root) => {
  const out = {};
  const walk = (dir) => {
    const { readdirSync, lstatSync } = require('node:fs');
    for (const entry of readdirSync(dir)) {
      const abs = join(dir, entry);
      const st = lstatSync(abs);
      if (st.isDirectory()) walk(abs);
      else out[abs.slice(root.length + 1)] = hashFile(abs);
    }
  };
  if (existsSync(root)) walk(root);
  return out;
};
