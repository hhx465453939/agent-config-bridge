/**
 * DeepSeek Harness (dsh) adapter for the hard-gate policy.
 *
 * dsh is "everything is a plugin": a plugin is a module exporting `apply(ctx)`,
 * and policy is expressed as listeners on documented extension points. This file
 * is the same shape as the pi adapter: translate the harness event into the
 * normalized question, ask ../policy.js, translate the answer back.
 *
 * Configure through the cordis plugin row, e.g.
 *
 *   - insert:
 *       - id: enforce-rules
 *         # A bare home-relative path ('~/.dsh/plugins/...') does NOT resolve:
 *         # dsh's loader takes a module specifier, and a relative one is
 *         # anchored beside the patch file (~/.dsh/profiles/<profile>/). This is
 *         # the verified form; a file:// URL works too.
 *         name: '../../plugins/agent-config-gates/dsh/index.js'
 *         config:
 *           # policyPath is read with a plain fs call, so it must be absolute.
 *           policyPath: '/absolute/path/to/agent-config-gates/policy.json'
 *
 * ---------------------------------------------------------------------------
 * Hook parity with the pi adapter (CHG-20261115-dsh-gate-parity)
 * ---------------------------------------------------------------------------
 *
 * The previous revision recorded "dsh has no result hook and no turn-level
 * injection" and turned three checks off in policy.json because of it. That was
 * true of the dsh version it was written against and is FALSE of the installed
 * one, so the checks are back:
 *
 *   pi `tool_call`        -> `tools/pre-execute`   waterfall, deny/ask/next
 *   pi `tool_result`      -> `tools/result`        synchronous, frozen outcome
 *   pi `turn_end`         -> `agent/turn-stopping` serial; object by steering
 *   pi `before_agent_start` -> `agent/pre-step`    waterfall; sees claimed messages
 *   pi `context` (reminder) -> `agent.inject(message)`
 *   pi `ctx.ui.confirm`     -> `{ kind: 'ask' }` + `ctx.approval`
 *
 * Sources (installed version, read 2026-11-15):
 *   docs/user/develop/framework/events.md            tools/result signature
 *   docs/tool-execution-pipeline.md                  pipeline order
 *   docs/subsystems/tools.md                         PreToolDecision, ToolExecutionResult
 *   docs/subsystems/core.md                          agent/pre-step, agent/turn-stopping
 *   docs/subsystems/approval.md                      ctx.approval.effectivePolicy
 *   docs/subsystems/practices.md                     incremental-fold performance rule
 *
 * Two deliberate asymmetries REMAIN and are documented rather than hidden:
 *
 *   - `agent/turn-stopping` hands over `{agent, turn, signal}` and no text, so
 *     the turn's final assistant text is folded incrementally from
 *     `session/event` (practices.md forbids rescanning the whole log there).
 *   - Steering and injection take a `UserMessage`, which this adapter cannot
 *     construct through the typed factory (`@deepseek-ai/dsh-llm` is not a
 *     declared dependency of this plugin). It therefore tries the documented
 *     shapes in order and, if every one is rejected, writes one stderr line
 *     instead of throwing: a gate that breaks a turn is worse than a gate that
 *     reports it could not act.
 *
 * Two harness details are matched here rather than assumed, because both were
 * silent failures on Windows Desktop (2026-11-14):
 *
 *   - the shell tool is named per platform (`bash` on POSIX presets, `pwsh` on
 *     the Windows one), so it must be matched as a set — an exact `'bash'`
 *     comparison disables every shell rule on Windows while the plugin row still
 *     reports `active`;
 *   - `ToolExecution` carries no `cwd`, so relative paths must be resolved
 *     against the Session's directory (the `workingDirectory` service), not
 *     against the directory the Desktop app happened to be launched from.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  analysisScriptTargets,
  applyMachineOverride,
  graphResultIsEvidence,
  isChgContract,
  isConventionDoc,
  isDestructiveBypass,
  loadPolicy,
  newSessionState,
  normalizePath,
  outputArtifactFindings,
  policyFromObject,
  profilePolicy,
  recordCommandResult,
  recordDocRead,
  recordIndexRefresh,
  recordInspection,
  recordInvestigation,
  recordScriptRun,
  recordSignal,
  recordUnlocks,
  recordWrite,
  reminderFor,
  resetMtimeCache,
  shellReadTargets,
  shouldBlock,
  slackFinding,
  unlockTokensFromQualifiedName,
  unlockTokensFromText,
} from '../policy.js';
import { classify } from '../classifier.js';

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * Where the policy JSON can live. Same two layouts the pi adapter supports, and
 * the same silent failure if it is got wrong: a missing file means the gate
 * falls back to fail-open, i.e. it looks installed and enforces nothing.
 *
 *   repo checkout : bridge/gates/dsh/policy.json
 *   installed     : <gate dir>/dsh/index.js  +  <gate dir>/policy.json
 */
export const policyCandidates = (here, explicit) =>
  [explicit, join(here, 'policy.json'), join(here, '..', 'policy.json')].filter(Boolean);

export const firstExistingPolicy = (here, explicit, exists = existsSync) => {
  for (const candidate of policyCandidates(here, explicit)) {
    if (exists(candidate)) return candidate;
  }
  return null;
};

export const name = 'enforce-rules';

/** The full probe set the policy expects, not just `exists`. */
const realFs = {
  exists: (p) => existsSync(p),
  isFile: (p) => {
    try {
      return statSync(p).isFile();
    } catch {
      return false;
    }
  },
  isDirectory: (p) => {
    try {
      return statSync(p).isDirectory();
    } catch {
      return false;
    }
  },
  statMtime: (p) => {
    try {
      return statSync(p).mtimeMs;
    } catch {
      return 0;
    }
  },
  listDir: (dir) => {
    try {
      return readdirSync(dir);
    } catch {
      return [];
    }
  },
  readText: (p) => {
    try {
      return readFileSync(p, 'utf8');
    } catch {
      return null;
    }
  },
};

/** Graph-query tool names that satisfy the "ask the graph first" rule. */
const SIGNAL_TOOLS = [
  'search_graph',
  'trace_path',
  'get_code_snippet',
  'query_graph',
  'get_architecture',
  'search_code',
];

const WRITE_TOOLS = new Set(['write', 'edit', 'apply_patch', 'str_replace_editor', 'create_file', 'multi_edit']);
const READ_TOOLS = new Set(['read', 'read_file', 'view', 'open_file']);
/**
 * Tool names that run a shell command.
 *
 * dsh names the shell tool per platform: the POSIX presets mount `tool-bash`
 * (tool name `bash`) and the Windows preset mounts `tool-pwsh` (tool name
 * `pwsh`). An exact `toolName === 'bash'` test therefore left
 * `no-destructive-bash`, `bash-graph-before-read` and the AI4S script tracking
 * completely inactive on Windows while the plugin still reported `active` — the
 * "installed, running, enforcing nothing" failure mode.
 */
const SHELL_TOOLS = new Set(['bash', 'pwsh', 'shell']);

/**
 * The dialect a shell command is written in.
 *
 * The policy parses `Get-Content x` and `cat x` with different parsers
 * (`shellOf(input)`), and the dsh adapter never told it which one applies — so a
 * PowerShell command was parsed as bash, where `Get-Content` is not a read verb.
 * `pwsh` must therefore declare itself, exactly as the pi adapter does for its
 * `powershell` tool.
 */
const shellDialect = (toolName) => (toolName === 'pwsh' || toolName === 'powershell' ? 'powershell' : 'bash');

const isSignalTool = (toolName) => SIGNAL_TOOLS.some((s) => toolName === s || toolName.endsWith(`_${s}`));

/** Read one field out of an `unknown` args object without trusting its shape. */
const str = (args, key) => {
  if (args && typeof args === 'object' && typeof args[key] === 'string') return args[key];
  return null;
};

const argPath = (args) => str(args, 'file_path') ?? str(args, 'path');
const argContent = (args) =>
  ['content', 'new_string', 'newText', 'patch', 'text']
    .map((key) => str(args, key))
    .find((value) => value !== null) ?? null;

/** All string leaves of a tool input, so a query's arguments become unlocks. */
const inputStrings = (value, out = []) => {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) for (const item of value) inputStrings(item, out);
  else if (value && typeof value === 'object') for (const item of Object.values(value)) inputStrings(item, out);
  return out;
};

/**
 * Model-facing text of a settled tool result.
 *
 * `ToolExecutionResult` is `{ isError, content, value? }` (docs/subsystems/tools.md).
 * Only `content` is the projection the model saw; `value` is execution-local and
 * deliberately omitted from durable events, so evidence is judged on `content` —
 * the thing the model actually learned from.
 */
const resultText = (result) => {
  if (!result || typeof result !== 'object') return '';
  const blocks = Array.isArray(result.content) ? result.content : [];
  return blocks
    .map((block) => (typeof block === 'string' ? block : typeof block?.text === 'string' ? block.text : ''))
    .join('\n');
};

/**
 * Visible assistant text carried by one `assistant/message` session event.
 *
 * The event wraps the model stream (`expandAssistantStream` is the typed reader,
 * but `@deepseek-ai/dsh-llm` is not a declared dependency here). Rather than
 * depend on an unowned package the adapter collects the visible text blocks by
 * shape: only `text` / `text-delta` count, so reasoning content never satisfies
 * the anti-slack rule. Bounded in depth and length so a pathological event
 * cannot stall a turn boundary.
 */
const assistantTextOf = (event) => {
  const parts = [];
  let budget = 20000;
  const walk = (value, depth) => {
    if (budget <= 0 || depth > 8 || parts.length > 400) return;
    if (Array.isArray(value)) {
      for (const item of value) walk(item, depth + 1);
      return;
    }
    if (!value || typeof value !== 'object') return;
    const kind = value.type;
    if ((kind === 'text' || kind === 'text-delta') && typeof value.text === 'string') {
      parts.push(value.text);
      budget -= value.text.length;
      return;
    }
    for (const item of Object.values(value)) walk(item, depth + 1);
  };
  walk(event?.data, 0);
  return parts.join('');
};

/** Concatenated text of the messages a pre-step has already claimed for entry. */
const messagesText = (messages) => {
  if (!Array.isArray(messages)) return '';
  const parts = [];
  for (const message of messages) {
    if (typeof message?.content === 'string') {
      parts.push(message.content);
      continue;
    }
    if (!Array.isArray(message?.content)) continue;
    for (const block of message.content) {
      if (typeof block === 'string') parts.push(block);
      else if (block?.type === 'text' && typeof block.text === 'string') parts.push(block.text);
    }
  }
  return parts.join('\n');
};

let messageSeq = 0;
const newMessageId = () => `enforce-rules-${Date.now().toString(36)}-${(messageSeq += 1).toString(36)}`;

/**
 * Candidate `UserMessage` shapes for `agent.inject` / `agent.steer`.
 *
 * `session.md` says a message is "one identified, immutable role/source/content
 * value", and `MessageSourceMap` is a merge-extensible sum type where "each
 * producer declares its own kind" and consumers "fall through unknown kinds" —
 * so `{ kind: 'enforce-rules' }` is the semantically correct source; the extra
 * shapes exist only because the exact id requirement is not verifiable from the
 * documents alone. First one that the harness accepts wins.
 */
const messageCandidates = (text) => [
  { role: 'user', messageId: newMessageId(), content: [{ type: 'text', text }], source: { kind: 'enforce-rules' } },
  { role: 'user', content: [{ type: 'text', text }], source: { kind: 'enforce-rules' } },
  { role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } },
];

/**
 * Deliver one message through `agent[method]`, trying the documented shapes.
 *
 * Never throws: this runs inside `agent/turn-stopping`, which is awaited on the
 * turn boundary — a throw there would fail the turn. Returning `false` lets the
 * caller report that the gate could not act, which is the honest outcome.
 */
const deliver = (agent, method, text) => {
  if (!agent || typeof agent[method] !== 'function' || typeof text !== 'string' || text === '') return false;
  for (const message of messageCandidates(text)) {
    try {
      agent[method](message);
      return true;
    } catch {
      // Try the next documented shape; report only if all of them fail.
    }
  }
  return false;
};

export function apply(ctx, config = {}) {
  // An inline `policy` object lets a host inject configuration; `policyPath`
  // keeps the file-based route for real deployments.
  const resolved =
    typeof config.policyPath === 'string'
      ? config.policyPath
      : firstExistingPolicy(HERE, null);
  const loaded = config.policy
    ? policyFromObject(config.policy)
    : resolved
      ? loadPolicy(resolved)
      : {
          ok: false,
          error:
            'no policy file found; looked in:\n' +
            policyCandidates(HERE, null)
              .map((c) => `    ${c}`)
              .join('\n'),
        };
  const policy = applyMachineOverride(
    loaded.ok
      ? loaded.policy
      : {
          name: 'enforce-rules',
          version: 1,
          description: 'fallback: policy unreadable, gate inactive',
          reminded: '',
          checks: [],
          config: { max_blocks_per_session: 0, signal_ttl_ms: 0 },
        },
  );

  if (!loaded.ok) {
    // Fail open, loudly. A gate that bricks the agent because of a typo in a
    // JSON file is worse than an unenforced rule — but a gate that is silently
    // off is worse still, because everyone assumes it is working.
    const message = `enforce-rules: DISABLED (${loaded.error})`;
    ctx.logger?.warn?.(message);
    process.stderr.write(`${message}\n`);
  }

  const state = newSessionState();

  /**
   * ADR-013: the destructive gate's mode is read from the same config both paths
   * already share, so dsh needs no command channel to obey it. It does need to
   * SAY it, because a silent bypass on this harness is invisible.
   */
  if (isDestructiveBypass(policy.config, state)) {
    const line =
      '[enforce-rules] 破坏性命令 BYPASS 生效（全局）：删除/git 重写/force push/DDL 等不再询问或拦截；' +
      '红线（删 $HOME / 删 cwd / 含 .. / 磁盘格式化 / 裸设备写入 / 关机）仍然拦。' +
      '其他门控规则不受影响。收回：编辑 policy.json 或机器本地 gate-policy.json。';
    ctx.logger?.warn?.(line);
    process.stderr.write(`${line}\n`);
  }

  /**
   * v5: classify lazily, on the first tool event.
   *
   * Kept as a fallback for harness builds without `agent/pre-step`; when that
   * hook is present the classification happens at the turn start with the real
   * user prompt (see that listener), which is the accurate moment.
   */
  let classified = false;

  /** The last `agent/pre-step` prompt we classified, and the turn it belonged to. */
  let lastPreStepKey = null;

  /**
   * The final assistant text of each session, folded incrementally.
   *
   * `agent/turn-stopping` receives `{agent, turn, signal}` only, so the text the
   * anti-slack rule needs is not in the hook payload. `docs/subsystems/practices.md`
   * forbids rescanning `session.events` on `session/event`, and an incremental
   * fold is exactly the allowed alternative: one map write per assistant message.
   */
  const lastAssistantText = new Map();

  /**
   * The directory this call's relative paths resolve against.
   *
   * `exec.cwd` is not part of dsh's `ToolExecution`, so the previous
   * `process.cwd()` fallback judged every relative path against the directory
   * the Desktop app was launched from — a different project than the Session's.
   */
  const cwdOf = (exec) => {
    if (typeof exec?.cwd === 'string' && exec.cwd) return exec.cwd;
    const session = exec?.agent?.session;
    const service = ctx.get?.('workingDirectory');
    if (session !== undefined && service && typeof service.get === 'function') {
      try {
        const directory = service.get(session);
        if (typeof directory === 'string' && directory) return directory;
      } catch {
        // A wrong cwd is worse than an explicit fallback: fall through.
      }
    }
    if (typeof config.cwd === 'string' && config.cwd) return config.cwd;
    return process.cwd();
  };

  /**
   * Whether returning `ask` would actually reach a human.
   *
   * `PreToolDecision.ask` runs the call only after `ctx.approval` answers
   * `allowed-once`; a `never` policy or a missing service means "deny". Turning
   * every recoverable delete into a hard denial because approvals happen to be
   * disabled is the "gate bricks the agent" failure this design avoids, so the
   * question is only asked when it can be answered.
   */
  const approvalUsable = (exec) => {
    const service = ctx.get?.('approval');
    const session = exec?.agent?.session;
    if (!service || session === undefined || typeof service.effectivePolicy !== 'function') return false;
    try {
      return service.effectivePolicy(session) === 'ask';
    } catch {
      return false;
    }
  };

  // -------------------------------------------------------------------------
  // Turn boundary: fold the assistant text the anti-slack rule will read.
  // -------------------------------------------------------------------------
  ctx.on('session/event', (session, event) => {
    try {
      if (!event || event.type !== 'assistant/message') return;
      const text = assistantTextOf(event);
      if (text) lastAssistantText.set(session, text);
    } catch {
      // An observation listener must never break the session.
    }
  });

  // -------------------------------------------------------------------------
  // Turn start: turnStart, domain classification, per-turn reminder.
  // -------------------------------------------------------------------------
  ctx.on('agent/pre-step', async (payload, next) => {
    try {
      const agent = payload?.agent;
      const cwd = cwdOf({ agent });
      const turn = payload?.turn;
      const key = `${cwd}\u0000${turn}`;
      const firstOfTurn = key !== lastPreStepKey;

      if (firstOfTurn) {
        lastPreStepKey = key;
        // A new turn is the boundary the output checks (W2) compare mtimes to.
        state.turnStart = Date.now();
      }

      if (!classified) {
        classified = true;
        const result = await classify({
          cwd,
          prompt: messagesText(payload?.messages),
          fs: realFs,
          policy,
          modelHint: typeof config.modelHint === 'function' ? config.modelHint : null,
        });
        state.profile = result.profile;
        state.profileSource = result.source;
      }

      if (firstOfTurn) {
        const reminder = reminderFor(policy, state);
        if (reminder && !deliver(agent, 'inject', reminder)) {
          process.stderr.write('[enforce-rules] 提醒注入失败：agent.inject 拒绝所有已知消息形状\n');
        }
      }
    } catch (err) {
      process.stderr.write(`[enforce-rules] agent/pre-step observer failed: ${err?.message ?? err}\n`);
    }
    return next();
  });

  // -------------------------------------------------------------------------
  // Tool result: the only truthful source of "what the model learned".
  // -------------------------------------------------------------------------
  ctx.on('tools/result', (exec, result) => {
    try {
      const toolName = String(exec?.name ?? '');
      const args = exec?.arguments;
      const cwd = cwdOf(exec);
      const command = str(args, 'command') ?? '';
      const failed = result?.isError === true;

      if (failed) {
        // A failed shell command feeds the blind-retry rule. A failed graph query
        // must not record a signal — the model has learned nothing yet.
        if (SHELL_TOOLS.has(toolName)) recordCommandResult(state, command, true);
        return;
      }

      // A successful read is evidence about the exact file, which is what Layer 0
      // needs before an edit. Convention documents additionally satisfy the
      // "project conventions" question.
      const path = normalizePath(argPath(args), cwd);
      if (READ_TOOLS.has(toolName) && path) {
        recordInspection(state, path);
        if (isConventionDoc(path, policy.config) || isChgContract(path, policy.config)) {
          recordDocRead(state, path);
        }
      }

      if (SHELL_TOOLS.has(toolName)) {
        recordCommandResult(state, command, false);
        const shell = shellDialect(toolName);
        for (const target of shellReadTargets(
          { command, shell },
          { config: policy.config, cwd, isFile: realFs.isFile, exists: realFs.exists },
        )) {
          recordInspection(state, normalizePath(target));
        }
        // `cat CONTRIBUTING.md` satisfies the convention rule just like `read`.
        for (const token of command.match(/"[^"]+"|'[^']+'|[^\s;&|]+/g) ?? []) {
          const candidate = normalizePath(token.replace(/^["']|["']$/g, ''), cwd);
          if (
            candidate &&
            (isConventionDoc(candidate, policy.config) || isChgContract(candidate, policy.config)) &&
            realFs.isFile(candidate)
          ) {
            recordDocRead(state, candidate);
          }
        }
      }

      // A successful index refresh is Layer-2 evidence that works even when the
      // index lives in a global data directory (no repo-local marker). Re-indexing
      // also changes a marker's mtime, so a cached value must be dropped.
      if (/(?:^|_)index_repository$/.test(toolName) || /(?:^|_)detect_changes$/.test(toolName)) {
        resetMtimeCache();
        recordIndexRefresh(state);
      }

      if (!isSignalTool(toolName)) return;

      // A successful call is not enough: an empty result ("total":0) used to buy
      // a full read window without telling the model anything. Only evidence counts.
      const body = resultText(result);
      if (!graphResultIsEvidence(body, policy.config)) return;

      const now = Date.now();
      recordSignal(state, now);
      // …and remember *what the query was about*: arguments plus the result text
      // become scoped unlocks, so a query about one file never buys a free pass
      // for the whole repository.
      recordUnlocks(state, unlockTokensFromText(inputStrings(args).join('\n')), now);
      if (typeof args?.qualified_name === 'string') {
        recordUnlocks(state, unlockTokensFromQualifiedName(args.qualified_name), now);
      }
      recordUnlocks(state, unlockTokensFromText(body), now);
    } catch (err) {
      process.stderr.write(`[enforce-rules] tools/result observer failed: ${err?.message ?? err}\n`);
    }
  });

  // -------------------------------------------------------------------------
  // Turn close: the anti-slack gate. A promise is not a delivery.
  // -------------------------------------------------------------------------
  ctx.on('agent/turn-stopping', async (payload) => {
    try {
      const max = policy.config.slack_max_continues ?? 0;
      if (max <= 0 || state.slackContinues >= max) return;

      const agent = payload?.agent;
      if (!agent || typeof agent.steer !== 'function') return;

      const effective = profilePolicy(policy, state.profile);

      // AI4S output artifacts (W4 log file / W2 result README). Both are
      // discovered after the computation has finished, and one more turn is
      // enough to fix them — `outputArtifactFindings` returns [] for a
      // general-dev session, so ordinary work pays one Map lookup.
      const artifacts = outputArtifactFindings({
        policy: effective,
        state,
        fs: realFs,
        cwd: cwdOf({ agent }),
      });
      if (artifacts.length > 0) {
        if (deliver(agent, 'steer', artifacts.map((f) => f.reason).join('\n\n'))) {
          state.slackContinues += 1;
        } else {
          process.stderr.write('[enforce-rules] AI4S 产出物缺失，但 agent.steer 不可用，本轮放弃续跑\n');
        }
        return;
      }

      if (policy.config.slack_check === false) return;

      const text = lastAssistantText.get(agent.session);
      if (!text) return;
      const finding = slackFinding(text, policy.config);
      if (!finding) return;

      if (deliver(agent, 'steer', finding.reason)) {
        state.slackContinues += 1;
      } else {
        process.stderr.write('[enforce-rules] 检测到拖延承诺，但 agent.steer 不可用，本轮放弃续跑\n');
      }
    } catch (err) {
      // `agent/turn-stopping` is awaited on the boundary: never throw from here.
      process.stderr.write(`[enforce-rules] agent/turn-stopping observer failed: ${err?.message ?? err}\n`);
    }
  });

  // -------------------------------------------------------------------------
  // Pre-execute: allow / deny / ask. Never records a graph signal.
  // -------------------------------------------------------------------------
  ctx.on('tools/pre-execute', async (exec, next) => {
    const toolName = String(exec?.name ?? '');
    const args = exec?.arguments;
    const cwd = cwdOf(exec);

    if (!classified) {
      // Fallback only: `agent/pre-step` normally classifies with the real prompt
      // before any tool runs. This keeps the profile sane on builds without it.
      classified = true;
      const result = await classify({
        cwd,
        prompt: '',
        fs: realFs,
        policy,
        modelHint: typeof config.modelHint === 'function' ? config.modelHint : null,
      });
      state.profile = result.profile;
      state.profileSource = result.source;
    }

    const effective = profilePolicy(policy, state.profile);

    if (WRITE_TOOLS.has(toolName)) {
      const path = normalizePath(argPath(args), cwd);
      const verdict = shouldBlock({
        policy: effective,
        input: { action: 'write', path, tool: toolName, content: argContent(args) },
        state,
        fs: realFs,
      });
      if (verdict.block) return { kind: 'deny', reason: verdict.reason };
      // Record only after the gate allows: a blocked write is not a file this
      // session may later read back freely.
      recordWrite(state, path);
      recordInvestigation(state);
      return next();
    }

    if (READ_TOOLS.has(toolName)) {
      const path = normalizePath(argPath(args), cwd);
      const verdict = shouldBlock({
        policy: effective,
        input: { action: 'read', path, tool: toolName },
        state,
        fs: realFs,
      });
      if (verdict.block) return { kind: 'deny', reason: verdict.reason };
      // Layer 0 only: "did this session read before editing". Recorded at
      // admission on purpose — a file the gate let through has been inspected
      // for the purposes of the edit rule, and keeping it here means Layer 0
      // still works if the result hook is ever unavailable. Layer 1 (the graph
      //通行证) is NOT recorded here; see `tools/result`.
      recordInspection(state, path);
      return next();
    }

    if (SHELL_TOOLS.has(toolName)) {
      const command = str(args, 'command') ?? '';
      const verdict = shouldBlock({
        policy: effective,
        input: { action: 'bash', path: null, tool: toolName, command, cwd, shell: shellDialect(toolName) },
        state,
        fs: realFs,
      });
      if (verdict.block) return { kind: 'deny', reason: verdict.reason };

      // Three-tier destructive policy (CHG-20261105): a `confirm` finding is not
      // a refusal. dsh can ask — `{kind:'ask'}` routes through `ctx.approval` —
      // but only when an approval channel can actually answer; otherwise the
      // call proceeds exactly as before and says so on stderr. That keeps a
      // recoverable delete working in headless/unattended runs without
      // pretending it was reviewed. The `high` tier above still denies.
      if (verdict.confirm) {
        const why = verdict.confirmReason ?? '破坏性命令需要确认';
        if (approvalUsable(exec)) {
          return { kind: 'ask', reason: why, displayReason: { en: why, 'zh-CN': why } };
        }
        process.stderr.write(
          `[enforce-rules] DESTRUCTIVE_CONFIRM auto-approved (no approval channel): ${command.slice(0, 200)}\n`,
        );
      }

      // AI4S: remember the script this call runs (W1 first-run test, W4 log date).
      for (const script of analysisScriptTargets(command, {
        config: effective.config,
        cwd,
        isFile: realFs.isFile,
      })) {
        recordScriptRun(state, script);
      }
      return next();
    }

    // NOTE: a graph query is deliberately NOT recorded here. `recordSignal` now
    // lives in the `tools/result` listener, where the outcome can be judged — an
    // admission-time signal lets `{"total":0}` buy a read window, which is the
    // hole ADR-006 recorded.
    return next();
  });
}

export const inject = ['tools'];
