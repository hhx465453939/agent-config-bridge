/**
 * Point the machine-local gate override at an empty directory for this test
 * process.
 *
 * `applyMachineOverride` (imported by both adapters) reads
 * `$HOME/.config/agent-config-bridge/gate-policy.json`. On a real developer
 * host that file legitimately carries `project_roots` — the target manifest
 * documents it as the way to cover non-git working directories without putting
 * absolute paths in this public repository. Merging it rewrites the fixtures a
 * policy test builds, so the same commit is green in CI (where the file does not
 * exist) and red on the very machine the gate was written for. A test that
 * depends on the operator's home directory is not a test.
 *
 * Imported for its side effect, before any adapter is registered. Tests that
 * exercise the override itself pass an explicit `home` to
 * `applyMachineOverride`, so they are unaffected.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'gate-test-home-'));
process.env.HOME = home;
process.env.USERPROFILE = home;

export default home;
