/**
 * `status` — the first command anyone should run.
 *
 * Answers, without writing anything: which agents exist on this machine, which
 * of them follow the source, and how far each has drifted. Never mutates state;
 * a status command that changes things is not a status command.
 */

import { basename, join } from 'node:path';
import { existsSync } from 'node:fs';
import { detectTarget, loadAllManifests, ruleDest } from './manifest.js';
import { gateStatus } from './gates.js';
import { buildPlan, summarizePlan } from './plan.js';
import { latestSnapshot, readSnapshot } from './snapshot.js';
import { listBackups } from './rollback.js';
import { listBridged, readState, STATUS } from './state.js';
import { exists } from './fs-ops.js';

export const runStatus = ({ repo, home }) => {
  const state = readState(repo);
  const manifests = loadAllManifests(repo);
  const rows = [];

  for (const manifest of manifests) {
    const installed = detectTarget(manifest, home);
    const entry = state.agents[manifest.name];
    const status = entry?.status ?? STATUS.NATIVE;

    const row = {
      name: manifest.name,
      display: manifest.display,
      installed,
      status,
      homeHint: manifest.home_hint ?? manifest.detect.map((d) => `~/${d}`).join(', '),
      verified: manifest.verified,
      managedPaths: manifest.managed.map((r) => r.to),
      neverTouch: manifest.neverTouch.length,
      adoptedAt: entry?.adopted_at ?? null,
      lastApply: entry?.last_apply ?? null,
      snapshotId: entry?.snapshot_id ?? null,
      trackedCount: entry?.tracked?.length ?? 0,
      drift: null,
      skills: null,
      gate: null,
    };

    // Gate availability is reported even for a native target, so the user can
    // see which agents are even capable of hard enforcement before adopting.
    row.gate = installed
      ? gateStatus({ repo, home, manifest })
      : { supported: Boolean(manifest.gates?.supported), installed: false, dir: null };

    if (installed && status === STATUS.BRIDGED) {
      // Cheap, side-effect-free drift estimate: how many skill directories the
      // source has versus what the manifest destination currently holds.
      const skillRule = manifest.managed.find((r) => r.kind === 'skill');
      if (skillRule) {
        const dest = ruleDest(skillRule, home);
        row.skills = { dest, present: exists(dest) };
      }
      try {
        const plan = buildPlan({ repo, home, targetNames: [manifest.name], state });
        const summary = summarizePlan(plan);
        row.drift = { add: summary.add, update: summary.update, remove: summary.remove };
      } catch (err) {
        row.drift = { error: err.message };
      }
    }

    rows.push(row);
  }

  return {
    repo,
    home,
    stateFile: join(repo, '.bridge', 'state.json'),
    stateFileExists: existsSync(join(repo, '.bridge', 'state.json')),
    bridged: listBridged(state),
    backups: listBackups(repo).length,
    snapshots: snapshotSummary(repo, rows),
    agents: rows,
  };
};

const snapshotSummary = (repo, rows) => {
  const out = {};
  for (const row of rows) {
    const id = row.snapshotId ?? latestSnapshot(repo, row.name);
    if (!id) continue;
    try {
      const { manifest } = readSnapshot(repo, row.name, id);
      out[row.name] = { id, entries: manifest.entries.length, created_at: manifest.created_at };
    } catch {
      out[row.name] = { id, corrupt: true };
    }
  }
  return out;
};

const STATUS_LABEL = {
  native: 'native   (untouched — this project does not manage it)',
  bridged: 'bridged  (shared dimensions follow the source)',
  revoked: 'revoked  (restored to its own configuration)',
};

export const formatStatus = (report) => {
  const lines = [];
  lines.push(`repo : ${report.repo}`);
  lines.push(`home : ${report.home}`);
  lines.push(
    `state: ${report.stateFile}${report.stateFileExists ? '' : '  (absent — every agent is native)'}`,
  );
  lines.push('');
  lines.push('AGENTS');
  for (const row of report.agents) {
    const flag = row.installed ? 'detected' : 'not installed';
    lines.push(`  ${row.name.padEnd(10)} ${STATUS_LABEL[row.status] ?? row.status}   [${flag}]`);
    lines.push(`      home        : ${row.homeHint}`);
    lines.push(`      managed     : ${row.managedPaths.join(', ')}`);
    lines.push(`      never touch : ${row.neverTouch} private path(s)`);
    if (!row.verified) lines.push(`      ⚠ manifest paths unverified — confirm after first adopt`);
    if (row.gate?.supported) {
      lines.push(
        `      gate        : ${row.gate.adapter ?? 'adapter'} ` +
          `${row.gate.installed ? 'installed' : 'not installed'}` +
          `${row.gate.policy ? `  (policy: ${row.gate.policy})` : ''}`,
      );
      if (row.gate.installed && row.gate.mounts) {
        lines.push(`      gate mount  : manual — this harness does not auto-load extensions`);
      }
    } else if (row.status === STATUS.BRIDGED) {
      lines.push(`      gate        : not available on this harness (its rules stay advisory)`);
    }
    if (row.adoptedAt) lines.push(`      adopted     : ${row.adoptedAt}`);
    if (row.lastApply) lines.push(`      last apply  : ${row.lastApply}`);
    if (row.drift && row.drift.error) {
      lines.push(`      drift       : cannot compute (${row.drift.error})`);
    } else if (row.drift) {
      const total = row.drift.add + row.drift.update;
      lines.push(
        total === 0
          ? `      drift       : none — in sync with the source`
          : `      drift       : ${row.drift.add} to add, ${row.drift.update} to update  → run \`apply\``,
      );
    }
  }
  lines.push('');
  lines.push(`bridged agents : ${report.bridged.join(', ') || '(none)'}`);
  lines.push(`snapshots      : ${Object.keys(report.snapshots).length}`);
  lines.push(`backups        : ${report.backups}`);
  return lines.join('\n');
};

export { basename };
