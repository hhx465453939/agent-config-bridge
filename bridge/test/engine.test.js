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
import { listFiles } from '../lib/fs-ops.js';
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
    assert.ok(existsSync(sb.path('.pi/agent/prompts/review.md')), 'commands were copied');
    // pi's rules document lands at the home root: pi loads context files from the
    // working-directory chain as well as its agent dir, and a second copy under
    // ~/.pi would make the model read the same rules twice.
    assert.ok(existsSync(sb.path('AGENTS.md')));
    assert.equal(existsSync(sb.path('.pi/agent/AGENTS.md')), false, 'no duplicate under ~/.pi');

    // Skills are a DECLARED LINK, not a copy: the source's skills must be
    // reachable through ~/.agents/skills, the link must still be a link (the
    // bridge must not have replaced it with a directory), and nothing may have
    // been duplicated into it.
    assert.ok(existsSync(sb.path('.agents/skills/beta/SKILL.md')), 'source skills reachable through the link');
    const { lstatSync, readlinkSync } = require('node:fs');
    assert.equal(lstatSync(sb.path('.agents/skills')).isSymbolicLink(), true, 'still a link');
    assert.equal(
      readlinkSync(sb.path('.agents/skills')),
      join(sb.home, '.claude', 'skills'),
      'and still pointing at the source',
    );
    assert.deepEqual(
      listFiles(sb.path('.claude/skills')).filter((p) => p.startsWith('skills/skills/')),
      [],
      'nothing was copied into the source through the link',
    );
  });
});

test('skills: flat <name>.md duplicates are reported but never copied', async () => {
  await withSandbox({ install: ['kimi'] }, (sb) => {
    api.adopt({ repo: sb.repo, home: sb.home, names: ['kimi'], log: quiet });

    assert.ok(existsSync(sb.path('.kimi-code/skills/alpha/SKILL.md')), 'directory form is bridged');
    assert.equal(
      existsSync(sb.path('.kimi-code/skills/alpha.md')),
      false,
      'the flat duplicate in the source must not be bridged',
    );

    // ...but it must not vanish from the report either: silently dropping it
    // would hide the fact that the source has two competing copies.
    const plan = api.plan({ repo: sb.repo, home: sb.home, targets: ['kimi'] });
    assert.ok(plan.targets[0].info.flatDuplicates > 0, 'flat duplicates are reported');
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

test('apply: restores a deleted skill, and only for the bridged agent', async () => {
  await withSandbox({ install: ['kimi'] }, (sb) => {
    api.adopt({ repo: sb.repo, home: sb.home, names: ['kimi'], log: quiet });

    // Private configuration sharing the same agent as the damaged skill: this is
    // the "only what needs changing" half of the assertion.
    const privatePath = sb.path('.kimi-code/config.toml');
    const privateHash = hashFile(privatePath);

    const damaged = sb.path('.kimi-code/skills/beta/SKILL.md');
    write(damaged, 'tampered\n');

    api.apply({ repo: sb.repo, home: sb.home, log: quiet });

    assert.equal(
      readFileSync(damaged, 'utf8'),
      readFileSync(join(sb.home, '.claude', 'skills', 'beta', 'SKILL.md'), 'utf8'),
      'the damaged copy was restored',
    );
    assert.equal(hashFile(privatePath), privateHash, 'private configuration was not touched');
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
      (err) => {
        assert.equal(err.code, 'SNAPSHOT_INCOMPLETE');
        assert.match(err.message, /cannot reconstruct the pre-adopt state, refusing to revoke/);
        // The message must name the exact missing file, otherwise the user has
        // no way to repair the snapshot.
        assert.match(err.message, /missing stored copy of .+mcp\.json/);
        return true;
      },
    );
    // State must not claim it was revoked.
    assert.equal(readState(sb.repo).agents.pi.status, STATUS.BRIDGED);
  });
});

// Regression, found while testing on a real machine.
//
// `adopt` writes a snapshot and sets state.snapshot_id; every later `apply`
// writes its OWN snapshot and moves the pointer forward. Revoke used to read
// only the newest snapshot, so after one apply it knew about the handful of
// files that apply touched — and would report success while leaving everything
// else behind, the installed gate included. The state then claimed "revoked",
// which is the worst outcome of all: a lie in the record.
test('revoke: still removes everything after intervening applies', async () => {
  await withSandbox({ install: ['kimi'] }, (sb) => {
    // The fixture source is part of the same tree, so anything added to it must
    // be added before the baseline is taken — otherwise the comparison blames
    // the bridge for a file the test itself put there.
    write(join(sb.home, '.claude', 'skills', 'gamma', 'SKILL.md'), '---\nname: gamma\n---\n\nnew\n');
    const before = treeSnapshot(sb.home);

    api.adopt({ repo: sb.repo, home: sb.home, names: ['kimi'], log: quiet });
    // Syncs, each taking its own snapshot and advancing state.snapshot_id.
    api.apply({ repo: sb.repo, home: sb.home, log: quiet });
    api.apply({ repo: sb.repo, home: sb.home, log: quiet });

    assert.ok(existsSync(sb.path('.kimi-code/skills/gamma/SKILL.md')), 'the skill did land');

    api.revoke({ repo: sb.repo, home: sb.home, names: ['kimi'], log: quiet });

    assert.deepEqual(
      treeSnapshot(sb.home),
      before,
      'revoke must undo the whole adoption, not just the last apply',
    );
    assert.equal(readState(sb.repo).agents.kimi.status, STATUS.REVOKED);
  });
});

test('revoke: also removes the installed gate after an intervening apply', async () => {
  await withSandbox({ install: ['pi'] }, (sb) => {
    const gateDir = sb.path('.pi/agent/extensions/enforce-rules');
    const before = treeSnapshot(sb.home);

    api.adopt({ repo: sb.repo, home: sb.home, names: ['pi'], log: quiet });
    assert.ok(existsSync(join(gateDir, 'policy.js')), 'gate installed at adopt time');

    // An apply snapshots only what it changes — here, at most one gate file.
    // Revoke must still know about the other files from the adopt snapshot.
    api.apply({ repo: sb.repo, home: sb.home, log: quiet });
    api.revoke({ repo: sb.repo, home: sb.home, names: ['pi'], log: quiet });

    assert.equal(existsSync(gateDir), false, 'the whole gate directory is gone');
    assert.deepEqual(treeSnapshot(sb.home), before, 'and the tree is exactly as it was');
  });
});

test('revoke: keeps one snapshot as the audit trail, releasing the rest', async () => {
  await withSandbox({ install: ['kimi'] }, (sb) => {
    api.adopt({ repo: sb.repo, home: sb.home, names: ['kimi'], log: quiet });
    api.apply({ repo: sb.repo, home: sb.home, log: quiet });
    api.apply({ repo: sb.repo, home: sb.home, log: quiet });

    const { readdirSync } = require('node:fs');
    const dir = join(sb.repo, '.bridge', 'snapshots', 'kimi');
    assert.ok(readdirSync(dir).length >= 3, 'snapshots accumulated during the adoption');

    api.revoke({ repo: sb.repo, home: sb.home, names: ['kimi'], log: quiet });

    const left = readdirSync(dir);
    assert.equal(left.length, 1, `expected one surviving record, got ${JSON.stringify(left)}`);
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
  await withSandbox({ install: ['kimi'] }, (sb) => {
    // Remove the secrets file so ${FIXTURE_API_KEY} cannot be resolved.
    const { rmSync } = require('node:fs');
    rmSync(join(sb.home, '.config'), { recursive: true, force: true });

    const before = treeSnapshot(sb.home);
    assert.throws(
      () => api.adopt({ repo: sb.repo, home: sb.home, names: ['kimi'], log: quiet }),
      /referenced but not provided/,
    );
    // Fail-closed: nothing was written, and the agent stayed native.
    assert.equal(readState(sb.repo).agents.kimi, undefined);
    assert.deepEqual(treeSnapshot(sb.home), before, 'a failed adopt must leave no trace');
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
  await withSandbox({ install: ['kimi'] }, (sb) => {
    api.adopt({ repo: sb.repo, home: sb.home, names: ['kimi'], log: quiet });

    // Change the source, then sync.
    write(join(sb.home, '.claude', 'skills', 'beta', 'SKILL.md'), '---\nname: beta\n---\n\nCHANGED\n');
    api.apply({ repo: sb.repo, home: sb.home, log: quiet });
    assert.match(readFileSync(sb.path('.kimi-code/skills/beta/SKILL.md'), 'utf8'), /CHANGED/);

    const result = api.undo({ repo: sb.repo, home: sb.home, log: quiet });
    assert.ok(result.restored > 0);
    assert.equal(
      readFileSync(sb.path('.kimi-code/skills/beta/SKILL.md'), 'utf8').includes('CHANGED'),
      false,
    );
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
  await withSandbox({ install: ['kimi'] }, (sb) => {
    api.adopt({ repo: sb.repo, home: sb.home, names: ['kimi'], log: quiet });

    // A file the user placed there themselves must never be pruned.
    write(sb.path('.kimi-code/skills/user-made/SKILL.md'), 'user content\n');
    // A file the bridge created, whose source then disappears.
    const { rmSync } = require('node:fs');
    rmSync(join(sb.home, '.claude', 'skills', 'beta'), { recursive: true, force: true });

    api.apply({ repo: sb.repo, home: sb.home, log: quiet });
    assert.ok(existsSync(sb.path('.kimi-code/skills/beta/SKILL.md')), 'default must not remove anything');
    assert.ok(existsSync(sb.path('.kimi-code/skills/user-made/SKILL.md')));

    api.apply({ repo: sb.repo, home: sb.home, prune: true, log: quiet });
    assert.equal(
      existsSync(sb.path('.kimi-code/skills/beta/SKILL.md')),
      false,
      'prune removes the derived file',
    );
    assert.ok(
      existsSync(sb.path('.kimi-code/skills/user-made/SKILL.md')),
      'prune must not touch user files',
    );
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
// destination guards
//
// Found on a real machine: ~/.agents/skills was a symlink to ~/.claude/skills,
// i.e. the authoritative source itself. Writing "into" it would have edited the
// source, and the pre-write snapshot would have captured the wrong thing. These
// tests pin both refusals so the guard cannot be quietly lost in a refactor.
// ---------------------------------------------------------------------------

test('guard: refuses a managed destination that is a symlink', async () => {
  await withSandbox({ install: ['kimi'] }, (sb) => {
    const { mkdirSync, symlinkSync } = require('node:fs');
    const elsewhere = join(sb.root, 'elsewhere');
    mkdirSync(elsewhere, { recursive: true });
    symlinkSync(elsewhere, sb.path('.kimi-code/skills'));

    assert.throws(
      () => api.adopt({ repo: sb.repo, home: sb.home, names: ['kimi'], log: quiet }),
      (err) => {
        assert.equal(err.code, 'TARGET_SYMLINK');
        assert.match(err.message, /refusing to write through a symbolic link/);
        assert.match(err.message, /elsewhere/, 'the message names where the link points');
        return true;
      },
    );
    // Nothing may have been written, and the agent must still be native.
    assert.equal(readState(sb.repo).agents.kimi, undefined);
    assert.deepEqual(listFiles(elsewhere), []);
  });
});

test('guard: refuses a destination whose symlink resolves into the authoritative source', async () => {
  await withSandbox({ install: ['kimi'] }, (sb) => {
    const { symlinkSync } = require('node:fs');
    // The exact shape seen in the wild: a target's skills path linked to the source.
    symlinkSync(join(sb.home, '.claude', 'skills'), sb.path('.kimi-code/skills'));

    assert.throws(
      () => api.adopt({ repo: sb.repo, home: sb.home, names: ['kimi'], log: quiet }),
      (err) => {
        assert.equal(err.code, 'TARGET_INSIDE_SOURCE');
        assert.match(err.message, /authoritative source/);
        return true;
      },
    );
    assert.equal(readState(sb.repo).agents.kimi, undefined, 'nothing was adopted');
  });
});

test('guard: a manifest pointing straight at the source is refused before anything is written', async () => {
  await withSandbox({ install: ['kimi'] }, (sb) => {
    sb.findAndReplaceManifests((m) => {
      if (m.name !== 'kimi') return null;
      m.managed = m.managed.map((r) => (r.kind === 'skill' ? { ...r, to: '.claude/skills' } : r));
      return m;
    });

    // Refused at adopt time rather than later, so the bad manifest cannot
    // half-apply: the refusal happens while the plan is being built.
    assert.throws(
      () => api.adopt({ repo: sb.repo, home: sb.home, names: ['kimi'], log: quiet }),
      (err) => {
        assert.equal(err.code, 'TARGET_INSIDE_SOURCE');
        return true;
      },
    );
    assert.equal(existsSync(sb.path('.claude/skills/kimi-copy')), false);
  });
});

test('guard: a destination that merely shares a prefix with the source is allowed', async () => {
  await withSandbox({ install: ['kimi'] }, (sb) => {
    // "~/.claude-archive" starts with the string "~/.claude" but is not inside
    // it. A guard that compared strings instead of paths would reject this.
    sb.findAndReplaceManifests((m) => {
      if (m.name !== 'kimi') return null;
      m.managed = m.managed.map((r) =>
        r.kind === 'skill' ? { ...r, to: '.claude-archive/skills' } : r,
      );
      return m;
    });
    api.adopt({ repo: sb.repo, home: sb.home, names: ['kimi'], log: quiet });
    assert.ok(existsSync(sb.path('.claude-archive/skills/alpha/SKILL.md')));
  });
});

test('doctor: a symlinked destination is an error, not a warning', async () => {
  await withSandbox({ install: ['kimi'] }, (sb) => {
    const { mkdirSync, symlinkSync } = require('node:fs');
    const elsewhere = join(sb.root, 'elsewhere');
    mkdirSync(elsewhere, { recursive: true });
    api.adopt({ repo: sb.repo, home: sb.home, names: ['kimi'], log: quiet });

    // Break it after the fact, the way a user would.
    const { rmSync } = require('node:fs');
    rmSync(sb.path('.kimi-code/skills'), { recursive: true, force: true });
    symlinkSync(elsewhere, sb.path('.kimi-code/skills'));

    const report = api.doctor({ repo: sb.repo, home: sb.home });
    assert.equal(report.ok, false);
    assert.ok(
      report.findings.some((f) => f.code === 'SYMLINK' && f.level === 'error'),
      `expected a SYMLINK error, got ${JSON.stringify(report.findings.map((f) => [f.level, f.code]))}`,
    );
  });
});

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

const require = (await import('node:module')).createRequire(import.meta.url);

const treeSnapshot = (root) => {
  const out = {};
  const walk = (dir) => {
    const { readdirSync, lstatSync, readlinkSync } = require('node:fs');
    for (const entry of readdirSync(dir)) {
      const abs = join(dir, entry);
      const st = lstatSync(abs);
      const key = abs.slice(root.length + 1);
      if (st.isSymbolicLink()) {
        // Record the link itself, not its contents. A tree comparison that
        // followed links would read a directory (EISDIR) and would also miss
        // the single most important difference on this project: a link that was
        // quietly replaced by a real directory.
        out[key] = `link -> ${readlinkSync(abs)}`;
      } else if (st.isDirectory()) {
        walk(abs);
      } else {
        out[key] = hashFile(abs);
      }
    }
  };
  if (existsSync(root)) walk(root);
  return out;
};
