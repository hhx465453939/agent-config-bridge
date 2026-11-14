#!/usr/bin/env node
/**
 * dsh（DeepSeek Harness）桌面端一键部署：硬门控 + 斜杠命令。
 *
 * 与 pi 的 bootstrap 不同的地方只有一处：dsh 的 profile 是设置面，本项目
 * **不写**它（`never_touch` 里有 `.dsh/profiles`）。所以这个脚本只做两件事：
 *
 *   1. 把门控（enforce-rules 引擎）与命令插件（/mcp、/gate、提示词命令）
 *      装进 `~/.dsh/plugins/`，并把 `~/.claude/commands/*.md` 同步成提示词；
 *   2. 打印**要粘进 profile patch 的那一段**，以及它是否已经粘过。
 *
 * 用法：
 *   node scripts/install-dsh.js          # 干跑：只打印计划
 *   node scripts/install-dsh.js --yes    # 写盘
 *   node scripts/install-dsh.js --home <dir> --yes
 *   node scripts/install-dsh.js --only gates|commands
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { planGateInstall, gateInstallDir } from '../bridge/lib/gates.js';
import { planCommandsInstall, commandsInstallDir } from '../bridge/lib/commands.js';
import { loadManifest } from '../bridge/lib/manifest.js';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const yes = argv.includes('--yes') || argv.includes('-y');
const homeIdx = argv.indexOf('--home');
const home = homeIdx >= 0 ? resolve(argv[homeIdx + 1]) : homedir();
const onlyIdx = argv.indexOf('--only');
const only = onlyIdx >= 0 ? argv[onlyIdx + 1] : null;

const say = (s = '') => console.log(s);
const fail = (msg) => {
  console.error(`\n✖ ${msg}`);
  process.exit(1);
};

const manifestPath = join(repo, 'bridge', 'targets', 'dsh.json');
if (!existsSync(manifestPath)) fail(`找不到 target 清单：${manifestPath}`);

// Load through the manifest validator, never the raw JSON: it is the one place
// that turns the snake_case on disk (`install_as`, `extension_dir`) into the
// camelCase every planner reads. Reading the file directly produced
// `undefined/undefined` paths the first time this script ran.
let manifest;
try {
  manifest = loadManifest(repo, 'dsh');
} catch (error) {
  fail(`清单无效：${error.message}`);
}

if (!existsSync(join(home, '.dsh'))) {
  fail(`本机没有 ${join(home, '.dsh')} —— 没装 dsh，或缺 --home。`);
}

const wants = (kind) => only === null || only === kind;
const actions = [];
if (wants('gates')) actions.push(...planGateInstall({ repo, home, manifest }));
if (wants('commands')) actions.push(...planCommandsInstall({ repo, home, manifest }));

if (actions.length === 0) fail('清单没有声明可部署的内容（gates / commands）。');

// --- 1. 计划 ---------------------------------------------------------------

const summary = actions.reduce((acc, action) => {
  acc[action.op] = (acc[action.op] ?? 0) + 1;
  return acc;
}, {});

say(`dsh 部署计划（${home}）`);
say(`  add ${summary.add ?? 0} / update ${summary.update ?? 0} / keep ${summary.keep ?? 0}`);
for (const action of actions) {
  if (action.op === 'keep') continue;
  say(`  ${action.op.padEnd(6)} ${action.note.padEnd(28)} ${action.to.replace(home, '~')}`);
}

// --- 2. 写盘 ---------------------------------------------------------------

let written = 0;
if (yes) {
  for (const action of actions) {
    if (action.op === 'keep') continue;
    mkdirSync(dirname(action.to), { recursive: true });
    if (action.content !== undefined) writeFileSync(action.to, action.content);
    else copyFileSync(action.from, action.to);
    written += 1;
  }
  say('');
  say(`✔ 已写入 ${written} 个文件`);
} else {
  say('');
  say('（干跑：未写盘。确认后加 --yes。）');
}

// --- 3. 校验 ---------------------------------------------------------------

const checks = [];
const gateDir = gateInstallDir(manifest, home);
const commandsDir = commandsInstallDir(manifest, home);

if (wants('gates')) {
  checks.push(['门控引擎', join(gateDir, 'policy.js')]);
  checks.push(['dsh 适配器', join(gateDir, 'dsh', 'index.js')]);
  checks.push(['策略文件', join(gateDir, 'policy.json')]);
  checks.push(['模块类型声明', join(gateDir, 'package.json')]);
}
if (wants('commands')) {
  checks.push(['命令插件', join(commandsDir, 'index.js')]);
  checks.push(['模块类型声明', join(commandsDir, 'package.json')]);
}

let ok = true;
say('');
say(yes ? '校验：' : '校验（干跑：以下是磁盘现状，不作为失败）：');
for (const [label, file] of checks) {
  const present = existsSync(file);
  ok = ok && present;
  say(`  ${present ? '✔' : '✖'} ${label.padEnd(12)} ${file.replace(home, '~')}`);
}
const promptsDir = join(commandsDir, 'prompts');
const prompts = existsSync(promptsDir) ? readdirSync(promptsDir).filter((f) => f.endsWith('.md')).length : 0;
if (wants('commands')) {
  say(`  ✔ 提示词命令    ${prompts} 个${prompts === 0 ? '（~/.claude/commands 为空？）' : ''}`);
}
const policyFile = join(gateDir, 'policy.json');
if (wants('gates') && existsSync(policyFile)) {
  try {
    const policy = JSON.parse(readFileSync(policyFile, 'utf8'));
    say(`  ✔ 策略可解析    checks: ${(policy.checks ?? []).join(', ')}`);
  } catch (error) {
    ok = false;
    say(`  ✖ 策略不可解析  ${error.message}`);
  }
}

// --- 4. 挂载状态 + 待粘贴片段 ----------------------------------------------

const profilesDir = join(home, '.dsh', 'profiles');
const patches = existsSync(profilesDir)
  ? readdirSync(profilesDir)
    .map((name) => join(profilesDir, name, 'cordis.patch.yml'))
    .filter((file) => existsSync(file))
  : [];

say('');
say('挂载状态（dsh 不会自动加载扩展目录）：');
let gateMounted = false;
let commandsMounted = false;
for (const patch of patches) {
  const text = readFileSync(patch, 'utf8');
  const g = text.includes('agent-config-gates');
  const c = text.includes('agent-config-commands');
  gateMounted = gateMounted || g;
  commandsMounted = commandsMounted || c;
  say(`  ${patch.replace(home, '~')}: 门控 ${g ? '已挂载' : '未挂载'} · 命令 ${c ? '已挂载' : '未挂载'}`);
}

// Report the rows that are actually missing: one mounted row must not make a
// missing sibling look deployed.
const missingGate = wants('gates') && !gateMounted;
const missingCommands = wants('commands') && !commandsMounted;
if (missingGate || missingCommands) {
  const policyPath = join(gateDir, 'policy.json').split('\\').join('/');
  say('');
  say('把下面这段贴进对应的 cordis.patch.yml 任意位置，然后保存（dsh 会热重载）：');
  say('');
  say('- insert:');
  if (missingGate) {
    say('    - id: enforce-rules');
    say("      name: '../../plugins/agent-config-gates/dsh/index.js'");
    say('      config:');
    say(`        policyPath: '${policyPath}'`);
  }
  if (missingCommands) {
    say('    - id: agent-config-commands');
    say("      name: '../../plugins/agent-config-commands/index.js'");
  }
  say('');
  say('（相对路径是相对 patch 文件所在目录，即 ~/.dsh/profiles/<profile>/。）');
} else {
  say('');
  say('两行都已挂载 —— 保存后 dsh 会热重载；`/mcp`、`/gate`、提示词命令立即可用。');
}

process.exit(!yes || ok ? 0 : 1);
