/**
 * Bootstrap / skill-install tests (v4).
 *
 *   node --test bridge/test/bootstrap.test.js
 *
 * These run the real scripts against a throwaway home, so they also prove that
 * a missing pi is reported (not silently skipped) and that the skill install is
 * idempotent.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const bootstrap = join(repo, 'scripts', 'bootstrap.js');
const skill = join(repo, 'scripts', 'install-hard-gate-skill.js');

const withHome = (fn) => {
  const home = mkdtempSync(join(tmpdir(), 'gate-boot-'));
  try {
    return fn(home);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
};

const run = (script, args) =>
  spawnSync(process.execPath, [script, ...args], {
    encoding: 'utf8',
    env: { ...process.env, HOME: undefined, USERPROFILE: undefined },
  });

test('bootstrap: a machine without ~/.pi fails loudly', () => {
  withHome((home) => {
    const result = run(bootstrap, ['--home', home]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /未检测到 pi/);
  });
});

test('bootstrap: dry-run prints a plan and writes nothing', () => {
  withHome((home) => {
    mkdirSync(join(home, '.pi'), { recursive: true });
    const result = run(bootstrap, ['--home', home]);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /apply/);
    assert.match(result.stdout, /dry run/);
    assert.equal(existsSync(join(home, '.pi', 'agent', 'extensions')), false, 'nothing installed');
    assert.equal(existsSync(join(home, '.claude', 'skills', 'agent-hard-gates')), false, 'no skill');
  });
});

test('skill install: first run adds, second run keeps', () => {
  withHome((home) => {
    const first = run(skill, ['--apply', '--home', home]);
    assert.equal(first.status, 0);
    assert.match(first.stdout, /installed:/);
    assert.ok(existsSync(join(home, '.claude', 'skills', 'agent-hard-gates', 'SKILL.md')));

    const second = run(skill, ['--apply', '--home', home]);
    assert.equal(second.status, 0);
    assert.match(second.stdout, /already up to date/);
  });
});
