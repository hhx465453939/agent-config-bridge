/**
 * Sandbox harness.
 *
 * The bridge overwrites other agents' configuration, so no test may ever run
 * against the real home directory. This module builds a throwaway tree:
 *
 *   <tmp>/home/.claude/...      a synthetic authoritative source
 *   <tmp>/home/.pi/...          a synthetic target (already installed)
 *   <tmp>/home/.codex/...
 *   <tmp>/repo/                 a checkout-shaped directory holding .bridge/
 *
 * and hands out paths. `cleanup()` removes the whole thing, so a test run leaves
 * no trace on the machine — which is also why the CLI takes `--home`/`--repo`.
 */

import { mkdtempSync, mkdirSync, rmSync, writeFileSync, chmodSync, readFileSync, existsSync, cpSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * Create a directory link, preferring the one form Windows can make without
 * administrator rights.
 *
 * The fixtures need real links, because link semantics are what several tests
 * assert (`~/.agents/skills` must stay a link; the guard must refuse to write
 * through one). On Windows an unprivileged process cannot create a symbolic
 * link at all — `symlinkSync` fails with EPERM unless Developer Mode is on or
 * the shell is elevated — but it CAN create a junction, and Node reports a
 * junction as a symbolic link (`lstat().isSymbolicLink()` is true,
 * `readlinkSync` returns the target). So the junction form is tried first on
 * win32 and the classic form everywhere else.
 *
 * The two are not identical: a junction can only point at a directory, and its
 * link text is always resolved to an absolute path. Neither difference matters
 * here — every link the fixtures make points at a directory, and the tests
 * compare against absolute paths.
 */
export const makeDirLink = (target, path) => {
  // `type` is a string, not an options object: `symlinkSync(target, path, {type:
  // 'junction'})` is silently ignored as an unknown type and falls back to the
  // privileged form, so the junction attempt has to pass the bare string.
  const types = process.platform === 'win32' ? ['junction', undefined] : [undefined];
  let lastError = null;
  for (const type of types) {
    try {
      symlinkSync(target, path, type);
      return;
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError;
};

export const write = (file, content, mode) => {
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, content);
  if (mode) chmodSync(file, mode);
};

export const read = (file) => readFileSync(file, 'utf8');

export const makeSandbox = ({ install = ['pi', 'kimi'] } = {}) => {
  const root = mkdtempSync(join(tmpdir(), 'acb-test-'));
  const home = join(root, 'home');
  const repo = join(root, 'repo');

  mkdirSync(join(repo, 'bridge', 'targets'), { recursive: true });
  mkdirSync(join(repo, '.bridge'), { recursive: true, mode: 0o700 });

  // ---- authoritative source -------------------------------------------------
  write(
    join(home, '.claude', 'CLAUDE.md'),
    '# Global rules\n\n- always speak plainly\n- prefer small commits\n',
  );
  write(
    join(home, '.claude', 'skills', 'alpha', 'SKILL.md'),
    '---\nname: alpha\ndescription: first fixture skill\n---\n\nDo alpha things.\n',
  );
  write(join(home, '.claude', 'skills', 'alpha', 'reference.md'), 'alpha reference\n');
  write(
    join(home, '.claude', 'skills', 'beta', 'SKILL.md'),
    '---\nname: beta\ndescription: second fixture skill\n---\n\nDo beta things.\n',
  );
  // A flat duplicate that must never be bridged, only reported.
  write(join(home, '.claude', 'skills', 'alpha.md'), 'stale flat copy\n');
  write(join(home, '.claude', 'commands', 'review.md'), 'Review the staged diff.\n');
  write(join(home, '.claude', 'agents', 'inspector.md'), 'You are an inspector.\n');
  write(
    join(home, '.claude.json'),
    `${JSON.stringify(
      {
        mcpServers: {
          'local-tool': { command: 'npx', args: ['-y', 'some-mcp'], env: { LOG_LEVEL: 'info' } },
          'remote-tool': { type: 'http', url: 'https://mcp.example.com/endpoint', headers: {} },
          'secret-tool': {
            command: 'node',
            args: ['server.js'],
            env: { API_KEY: '${FIXTURE_API_KEY}', EMAIL: '${FIXTURE_EMAIL}' },
          },
        },
      },
      null,
      2,
    )}\n`,
  );
  write(
    join(home, '.config', 'agent-config-bridge', 'secrets.env'),
    '# fixture secrets\nFIXTURE_API_KEY=not-a-real-key\nFIXTURE_EMAIL=nobody@example.com\n',
    0o600,
  );

  // ---- targets --------------------------------------------------------------
  if (install.includes('pi')) {
    mkdirSync(join(home, '.pi', 'agent', 'extensions'), { recursive: true });
    write(join(home, '.pi', 'agent', 'settings.json'), '{"theme":"dark","defaultModel":"x"}\n');
    write(join(home, '.pi', 'agent', 'extensions', 'gate.ts'), '// private extension\n');
    write(join(home, '.pi', 'agent', 'APPEND_SYSTEM.md'), '# private system prompt tail\n');
    write(join(home, '.pi', 'agent', 'pi-router.json'), '{ "route": "private" }\n');
    // pi.json declares its skills rule as a LINK, so the fixture must look the
    // way a real machine looks. Creating a real directory here would make the
    // fixture disagree with the manifest it copies in — and the manifest is the
    // thing under test.
    mkdirSync(join(home, '.agents'), { recursive: true });
    makeDirLink(join(home, '.claude', 'skills'), join(home, '.agents', 'skills'));
    write(
      join(home, '.pi', 'agent', 'mcp.json'),
      `${JSON.stringify(
        { mcpServers: { 'pi-only': { command: 'pi-private', args: [], env: {} } } },
        null,
        2,
      )}\n`,
    );
  }
  if (install.includes('kimi')) {
    mkdirSync(join(home, '.kimi-code'), { recursive: true });
    write(join(home, '.kimi-code', 'config.toml'), '[general]\ntheme = "dark"\n');
    write(join(home, '.kimi-code', 'mcp.json'), `${JSON.stringify({ mcpServers: {} }, null, 2)}\n`);
  }
  if (install.includes('dsh')) {
    // dsh is the harness that does NOT auto-load extensions, so its fixture
    // exists to exercise the manual-mount warning path. Its rule document is
    // the only managed path it declares.
    mkdirSync(join(home, '.dsh'), { recursive: true });
    write(join(home, '.dsh', 'storages', 'workspace.json'), '{}\n');
  }

  // ---- target manifests + gate sources --------------------------------------
  // The REAL manifests and gate sources are copied in, not re-declared here. A
  // fixture that restates them would keep passing after someone edits a real
  // never_touch list or swaps a gate adapter, which is exactly the drift the
  // tests exist to catch.
  mkdirSync(join(repo, 'bridge'), { recursive: true });
  cpSync(join(REPO_ROOT, 'bridge', 'targets'), join(repo, 'bridge', 'targets'), { recursive: true });
  cpSync(join(REPO_ROOT, 'bridge', 'gates'), join(repo, 'bridge', 'gates'), { recursive: true });

  const findAndReplaceManifests = (mutate) => {
    for (const name of ['pi', 'kimi', 'dsh']) {
      const file = join(repo, 'bridge', 'targets', `${name}.json`);
      if (!existsSync(file)) continue;
      const next = mutate(JSON.parse(read(file)), name);
      if (next) write(file, `${JSON.stringify(next, null, 2)}\n`);
    }
  };

  return {
    root,
    home,
    repo,
    repoRoot: REPO_ROOT,
    findAndReplaceManifests,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
    exists: (rel) => existsSync(join(home, rel)),
    path: (rel) => join(home, rel),
    readHome: (rel) => read(join(home, rel)),
  };
};

/**
 * Run `fn` against a fresh sandbox and always clean up, even on assertion
 * failure. Every test uses this so a failing test cannot leave a temp tree
 * behind.
 */
export const withSandbox = async (options, fn) => {
  const sandbox = makeSandbox(options);
  try {
    return await fn(sandbox);
  } finally {
    sandbox.cleanup();
  }
};
