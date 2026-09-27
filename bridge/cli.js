#!/usr/bin/env node
/**
 * CLI entry point.
 *
 * Deliberately thin: argument parsing, dispatch into lib/api.js, rendering.
 * Every behaviour worth testing lives in lib/ so the test suite can drive it
 * without spawning processes.
 *
 *   node bridge/cli.js <command> [options]
 */

import { existsSync } from 'node:fs';
import { BridgeError, EXIT, usageError } from './lib/errors.js';
import { claudeDir, resolveHome, repoRoot, secretsFile, stateFile } from './lib/paths.js';
import createLogger from './lib/log.js';
import * as api from './lib/api.js';
import { formatStatus } from './lib/status.js';
import { formatDoctorReport } from './lib/doctor.js';
import { OP, summarizePlan } from './lib/plan.js';

const COMMANDS = ['status', 'adopt', 'revoke', 'plan', 'apply', 'diff', 'doctor', 'rollback', 'help'];

const HELP = `agent-config-bridge — let selected agents follow your Claude Code configuration

USAGE
  node bridge/cli.js <command> [options]

COMMANDS
  status                     show every agent: detected?, native/bridged/revoked, drift
  adopt <agent>...           hand an agent's shared dimensions to the source (snapshots first)
  revoke <agent>...          restore an agent to its own configuration (from the snapshot)
  plan                       show exactly what would change (writes nothing)
  apply                      refresh every bridged agent (snapshots + backups first)
  diff                       like plan, but only the rows that actually differ
  doctor                     self-check: state, manifests, snapshots, permissions, drift
  rollback [timestamp]       undo one apply (defaults to the most recent)

OPTIONS
  --home <path>       pretend the home directory is <path>   (default: $HOME)
  --repo <path>       repository checkout holding .bridge/   (default: this checkout)
  --targets a,b       restrict to these agents
  --prune             also remove files this bridge created that the source no longer has
  --dry-run           preview the run without writing anything (adopt, apply, revoke)
  --yes, -y           skip the confirmation prompt for adopt/revoke
  --json              emit a machine-readable report
  --strict            doctor/diff: treat warnings as failures
  --quiet, -q         only print the summary
  -h, --help          this text

EXIT CODES
  0 ok   1 business failure   2 usage error   3 environment error

EXAMPLES
  node bridge/cli.js status
  node bridge/cli.js adopt gemini kimi
  node bridge/cli.js plan
  node bridge/cli.js apply
  node bridge/cli.js revoke kimi
`;

const parseArgs = (argv) => {
  const positional = [];
  const opts = {
    home: null,
    repo: null,
    targets: null,
    prune: false,
    dryRun: false,
    yes: false,
    json: false,
    strict: false,
    quiet: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case '--home': opts.home = argv[++i]; break;
      case '--repo': opts.repo = argv[++i]; break;
      case '--targets': opts.targets = String(argv[++i] ?? '').split(',').map((s) => s.trim()).filter(Boolean); break;
      case '--prune': opts.prune = true; break;
      case '--dry-run': opts.dryRun = true; break;
      case '--yes': case '-y': opts.yes = true; break;
      case '--json': opts.json = true; break;
      case '--strict': opts.strict = true; break;
      case '--quiet': case '-q': opts.quiet = true; break;
      case '--help': case '-h': opts.help = true; break;
      default:
        if (arg.startsWith('--home=')) opts.home = arg.slice(7);
        else if (arg.startsWith('--repo=')) opts.repo = arg.slice(7);
        else if (arg.startsWith('--targets=')) opts.targets = arg.slice(10).split(',').filter(Boolean);
        else if (arg.startsWith('-')) throw usageError(`unknown option: ${arg}`);
        else positional.push(arg);
    }
  }
  return { positional, opts };
};

const renderPlan = (result, log, { onlyChanges }) => {
  const totals = summarizePlan(result);
  for (const target of result.targets) {
    if (target.skipped) {
      log.say(`  ${target.name.padEnd(10)} skipped — ${target.skipped}`);
      continue;
    }
    const rows = target.actions.filter((a) => (onlyChanges ? a.op !== OP.KEEP : true));
    const counts = rows.reduce((acc, a) => ({ ...acc, [a.op]: (acc[a.op] ?? 0) + 1 }), {});
    const summary = Object.entries(counts).map(([k, v]) => `${k}=${v}`).join(' ') || 'no changes';
    log.say(`  ${target.name.padEnd(10)} ${summary}`);
    for (const action of rows) {
      const rel = action.to.replace(`${result.home}/`, '~/');
      log.info(`      ${action.op.padEnd(6)} ${rel}${action.note ? `  (${action.note})` : ''}`);
      if (action.removes?.length) log.info(`             also removes: ${action.removes.join(', ')}`);
    }
    for (const warning of target.warnings ?? []) log.warn(`${target.name}: ${warning}`);
  }
  log.say('');
  log.say(
    `plan: ${totals.targets} bridged agent(s), ${totals.add} to add, ${totals.update} to update, ` +
      `${totals.remove} to remove, ${totals.keep} already identical` +
      `${totals.skipped ? `, ${totals.skipped} skipped` : ''}`,
  );
  return totals;
};

const confirm = async (question) => {
  if (!process.stdin.isTTY) {
    throw usageError(`${question}\n  (stdin is not a TTY — pass --yes to confirm non-interactively)`);
  }
  process.stdout.write(`${question} [y/N] `);
  const answer = await new Promise((resolve) => {
    process.stdin.once('data', (chunk) => resolve(String(chunk).trim().toLowerCase()));
  });
  return answer === 'y' || answer === 'yes';
};

const main = async () => {
  const { positional, opts } = parseArgs(process.argv.slice(2));
  const log = createLogger({ quiet: opts.quiet, json: opts.json });

  const command = positional[0] ?? (opts.help ? 'help' : null);
  if (!command || opts.help || command === 'help') {
    log.say(HELP);
    return command ? EXIT.OK : EXIT.USAGE;
  }
  if (!COMMANDS.includes(command)) throw usageError(`unknown command: ${command}\n\n${HELP}`);

  const home = resolveHome(opts.home);
  const repo = opts.repo ? opts.repo : repoRoot();
  const names = positional.slice(1);

  switch (command) {
    case 'status': {
      const result = api.status(repo, home);
      if (opts.json) log.payload(result);
      else log.say(formatStatus(result));
      return EXIT.OK;
    }

    case 'plan':
    case 'diff': {
      const result = api.plan({
        repo,
        home,
        targets: opts.targets,
        prune: opts.prune,
        onlyChanges: command === 'diff',
      });
      if (opts.json) log.payload(result);
      else {
        log.say(`${command}: ${home}`);
        renderPlan(result, log, { onlyChanges: command === 'diff' });
      }
      return EXIT.OK;
    }

    case 'doctor': {
      const report = api.doctor({ repo, home, strict: opts.strict });
      if (opts.json) log.payload(report);
      else log.say(formatDoctorReport(report));
      return report.ok ? EXIT.OK : EXIT.BUSINESS;
    }

    case 'adopt': {
      if (names.length === 0) throw usageError('adopt needs at least one agent name, e.g. `adopt gemini`');
      if (opts.dryRun) {
        // Preview goes through the very same planner `adopt` uses, so the preview
        // cannot drift from what the real run would do.
        const preview = api.adopt({ repo, home, names, prune: opts.prune, dryRun: true, log });
        if (opts.json) log.payload(preview);
        else {
          log.say(`adopt --dry-run: ${home}`);
          for (const target of preview.targets) {
            if (target.skipped) {
              log.say(`  ${target.name.padEnd(10)} skipped — ${target.skipped}`);
              continue;
            }
            const counts = target.actions.reduce(
              (acc, a) => ({ ...acc, [a.op]: (acc[a.op] ?? 0) + 1 }),
              {},
            );
            log.say(
              `  ${target.name.padEnd(10)} ` +
                Object.entries(counts).map(([k, v]) => `${k}=${v}`).join(' '),
            );
            for (const action of target.actions) {
              if (action.op === OP.KEEP) continue;
              log.info(
                `      ${action.op.padEnd(6)} ${action.to.replace(`${home}/`, '~/')}` +
                  `${action.note ? `  (${action.note})` : ''}`,
              );
            }
            for (const warning of target.warnings ?? []) log.warn(`${target.name}: ${warning}`);
          }
          log.say('\nnothing was written.');
        }
        return EXIT.OK;
      }
      if (!opts.yes) {
        const ok = await confirm(
          `adopt ${names.join(', ')} — these agents will follow ${claudeDir(home)}.\n` +
            `A snapshot of their current configuration is taken first.`,
        );
        if (!ok) {
          log.say('aborted; nothing was written.');
          return EXIT.OK;
        }
      }
      const result = api.adopt({ repo, home, names, prune: opts.prune, log });
      if (opts.json) log.payload(result);
      else {
        for (const target of result.targets) {
          if (target.skipped) log.say(`  ${target.name}: skipped — ${target.skipped}`);
          else log.say(`  ${target.name}: bridged  (snapshot ${target.snapshotId})`);
        }
        log.say(`\nadopted. state written to ${stateFile(repo)}`);
      }
      return EXIT.OK;
    }

    case 'apply': {
      const result = api.apply({
        repo,
        home,
        targets: opts.targets,
        prune: opts.prune,
        dryRun: opts.dryRun,
        log,
      });
      if (opts.json) log.payload(result);
      else if (opts.dryRun) {
        log.say(`apply --dry-run: ${home}`);
        for (const target of result.targets) {
          if (target.skipped) log.say(`  ${target.name}: skipped — ${target.skipped}`);
          else {
            const s = target.summary;
            log.say(`  ${target.name}: ${s.add} to add, ${s.update} to update, ${s.keep} already identical`);
          }
        }
        log.say('\nnothing was written.');
      } else {
        if (result.targets.length === 0) {
          log.say(`nothing to do: ${result.note}`);
        } else {
          for (const target of result.targets) {
            if (target.skipped) log.say(`  ${target.name}: skipped — ${target.skipped}`);
            else {
              const a = target.applied;
              log.say(`  ${target.name}: +${a.added} ~${a.updated} -${a.removed} (kept ${a.kept})`);
            }
          }
        }
      }
      return EXIT.OK;
    }

    case 'revoke': {
      if (names.length === 0) throw usageError('revoke needs at least one agent name');
      const preview = api.revoke({ repo, home, names, dryRun: true });
      if (!opts.yes) {
        log.say(`revoke ${names.join(', ')} — restore their own configuration:`);
        for (const target of preview.targets) {
          if (target.skipped) {
            log.say(`  ${target.name}: skipped — ${target.skipped}`);
            continue;
          }
          const deletes = target.actions.filter((a) => a.kind === 'delete').length;
          const restores = target.actions.length - deletes;
          log.say(`  ${target.name}: restore ${restores} file(s), remove ${deletes} file(s) it added`);
        }
        const ok = await confirm('proceed?');
        if (!ok) {
          log.say('aborted; nothing was written.');
          return EXIT.OK;
        }
      }
      const result = api.revoke({ repo, home, names, log });
      if (opts.json) log.payload(result);
      else {
        for (const target of result.targets) {
          if (target.skipped) log.say(`  ${target.name}: skipped — ${target.skipped}`);
          else log.say(`  ${target.name}: restored ${target.applied.restored}, removed ${target.applied.deleted}`);
        }
        log.say(`\nrevoked. those agents are back to their own configuration.`);
      }
      return EXIT.OK;
    }

    case 'rollback': {
      const result = api.undo({ repo, home, timestamp: names[0] ?? null, log });
      if (opts.json) log.payload(result);
      else {
        log.say(`rolled back ${result.backup}: restored ${result.restored} file(s)`);
        log.say(`a backup of the pre-rollback state is in ${result.guard}`);
      }
      return EXIT.OK;
    }

    default:
      throw usageError(`unknown command: ${command}`);
  }
};

main()
  .then((code) => {
    process.exitCode = code ?? EXIT.OK;
  })
  .catch((err) => {
    if (err instanceof BridgeError) {
      process.stderr.write(`error: ${err.message}\n`);
      process.exitCode = err.exit;
    } else {
      process.stderr.write(`unexpected error: ${err?.stack ?? err}\n`);
      process.exitCode = EXIT.ENV;
    }
  });

export { main, parseArgs };
