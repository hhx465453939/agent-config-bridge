#!/usr/bin/env node
/**
 * 新宿主机一键部署硬门控（Windows / Linux / macOS 通用）。
 *
 * 流程（默认只打印计划，`--yes` 才写盘）：
 *   1. 探测本机是否安装了 pi（`<home>/.pi`）；
 *   2. 未桥接 → `bridge/cli.js adopt pi --yes`（会先快照）；
 *   3. `bridge/cli.js apply --yes`（写入门控与受管内容）；
 *   4. 校验门控文件存在、policy JSON 可解析、checks 含 graph-before-read；
 *   5. 安装全局技能 `agent-hard-gates`（Claude 与 pi 共享）；
 *   6. 机器本地 `gate-policy.json` 不存在时，生成一份**建议**（只含已存在的开发根）。
 *
 * 约定：不猜路径（门控目录取自 bridge/targets/pi.json）、不覆盖用户已有文件、
 * 不修改 never_touch 中的任何私有配置。
 *
 * 用法：
 *   node scripts/bootstrap.js             # 干跑
 *   node scripts/bootstrap.js --yes       # 执行
 *   node scripts/bootstrap.js --yes --home <dir>
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const yes = argv.includes('--yes') || argv.includes('-y');
const homeIdx = argv.indexOf('--home');
const home = homeIdx >= 0 ? resolve(argv[homeIdx + 1]) : homedir();
const explicitRoots = [];
for (let i = 0; i < argv.length; i += 1) {
  if (argv[i] === '--root' && argv[i + 1]) explicitRoots.push(resolve(argv[i + 1]));
}

const say = (s = '') => console.log(s);
const fail = (msg) => {
  console.error(`\n✖ ${msg}`);
  process.exit(1);
};

// --- 1. detect --------------------------------------------------------------

const piDir = join(home, '.pi');
say(`home: ${home}`);
say(`pi  : ${piDir}`);
if (!existsSync(piDir)) {
  fail(
    '未检测到 pi（缺少 ~/.pi）。\n' +
      '  先安装并启动一次 pi，再运行本脚本；不要在没有目标 agent 的机器上假装部署成功。',
  );
}

// --- 2. state ---------------------------------------------------------------

const manifestFile = join(repo, 'bridge', 'targets', 'pi.json');
if (!existsSync(manifestFile)) fail(`缺少 pi manifest：${manifestFile}`);
const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'));
const gateDirRel = manifest?.gates?.extension_dir && manifest?.gates?.install_as
  ? `${manifest.gates.extension_dir}/${manifest.gates.install_as}`
  : null;
if (!gateDirRel) fail('pi manifest 未声明 gates.extension_dir / gates.install_as；不猜路径。');

const stateFile = join(repo, '.bridge', 'state.json');
let state = null;
if (existsSync(stateFile)) {
  try {
    state = JSON.parse(readFileSync(stateFile, 'utf8'));
  } catch (err) {
    fail(`状态文件不可解析：${stateFile}\n  ${err.message}\n  先修好它或执行 node bridge/cli.js doctor。`);
  }
}
const piStatus = state?.agents?.pi?.status ?? 'native';

const cli = join(repo, 'bridge', 'cli.js');
const steps = [];
if (piStatus !== 'bridged') steps.push({ label: 'adopt pi（先快照）', args: ['adopt', 'pi', '--yes'] });
steps.push({ label: 'apply（写入门控与受管内容）', args: ['apply', '--yes'] });

// --- 3. machine-local suggestion -------------------------------------------

const machineDir = join(home, '.config', 'agent-config-bridge');
const machineFile = join(machineDir, 'gate-policy.json');
const candidateRoots = [
  join(home, 'Development'),
  join(home, 'dev'),
  join(home, 'projects'),
  join(home, 'repos'),
  join(home, 'mcp'),
  join(home, 'R'),
].filter((p) => existsSync(p));

// `project_roots` is EXCLUSIVE: when non-empty it replaces .git auto-detection.
// Writing it automatically from a partial candidate list would silently un-gate
// every repository outside those paths — the opposite of the goal. So it is
// written only when the operator names the roots explicitly with --root.
const rootsToWrite = [...new Set(explicitRoots)].filter((p) => existsSync(p));
const missingRoots = explicitRoots.filter((p) => !existsSync(p));
const machineContent = { config: { project_roots: rootsToWrite.map((p) => p.replace(/\\/g, '/')) } };
const willCreateMachine = !existsSync(machineFile) && rootsToWrite.length > 0;

// --- 4. plan ----------------------------------------------------------------

say('\n计划：');
steps.forEach((s, i) => say(`  ${i + 1}. ${s.label}`));
say(`  ${steps.length + 1}. 校验门控文件与 policy.json`);
say(`  ${steps.length + 2}. 安装共享技能 agent-hard-gates`);
if (missingRoots.length > 0) say(`  注意：以下 --root 不存在，将忽略：${missingRoots.join(', ')}`);
if (willCreateMachine) {
  say(`  ${steps.length + 3}. 创建机器本地作用域：${machineFile}`);
  say(`       project_roots = ${JSON.stringify(rootsToWrite)}`);
  say('       注意：project_roots 是非空即独占，会替代 .git 自动探测——只写你真正的开发根。');
} else if (existsSync(machineFile)) {
  say(`  ${steps.length + 3}. 机器本地作用域已存在，保留不动：${machineFile}`);
} else {
  say(`  ${steps.length + 3}. 机器本地作用域：未指定 --root，跳过（建议值：${JSON.stringify(candidateRoots)}）`);
  say('       想写入：node scripts/bootstrap.js --yes --root <开发根> [--root <另一个>]');
}

if (!yes) {
  say('\n(dry run) 加 --yes 才会写盘。');
  process.exit(0);
}

// Machine-local config must exist BEFORE apply: resolvePolicy reads it while
// generating policy.json. Writing it afterwards (the first version did) makes
// the very first deployment silently use an empty project_roots list.
if (willCreateMachine) {
  mkdirSync(machineDir, { recursive: true });
  writeFileSync(machineFile, `${JSON.stringify(machineContent, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  say(`\n✔ 已创建机器本地作用域：${machineFile}`);
}

// --- 5. apply ---------------------------------------------------------------

const runNode = (script, args) => {
  const result = spawnSync(process.execPath, [script, ...args], { stdio: 'inherit', env: process.env });
  return result.status ?? 1;
};

for (const step of steps) {
  say(`\n▶ ${step.label}`);
  const code = runNode(cli, step.args);
  if (code !== 0) fail(`步骤失败：${step.label}（exit ${code}）`);
}

// --- 6. verify --------------------------------------------------------------

const gateDir = join(home, ...gateDirRel.split('/'));
const policyFile = join(gateDir, 'policy.json');
const adapterFile = join(gateDir, 'pi', 'index.js');
if (!existsSync(adapterFile)) fail(`门控未安装：缺少 ${adapterFile}`);
if (!existsSync(policyFile)) fail(`门控未安装：缺少 ${policyFile}`);

let policy;
try {
  policy = JSON.parse(readFileSync(policyFile, 'utf8'));
} catch (err) {
  fail(`policy.json 不可解析：${policyFile}\n  ${err.message}`);
}
const checks = Array.isArray(policy.checks) ? policy.checks : [];
const required = ['graph-before-read', 'bash-graph-before-read'];
const missing = required.filter((name) => !checks.includes(name));
if (missing.length > 0) fail(`policy.json 缺少必需检查：${missing.join(', ')}`);

say(`\n✔ 门控已安装：${gateDir}`);
say(`  checks: ${checks.join(', ')}`);

// --- 7. shared skill --------------------------------------------------------

say('\n▶ 安装共享技能');
const skillCode = runNode(join(repo, 'scripts', 'install-hard-gate-skill.js'), ['--apply', '--home', home]);
if (skillCode !== 0) {
  fail(
    `技能安装未完成（exit ${skillCode}）。\n` +
      '  若是「目标已存在且内容不同」，说明你本地改过技能：保留用户版本，或加 --force 覆盖。',
  );
}

// --- 8. machine-local suggestion -------------------------------------------

if (willCreateMachine) {
  say(`\n· 机器本地作用域已写入（供本次 apply 使用）：${machineFile}`);
} else if (existsSync(machineFile)) {
  say(`\n· 机器本地作用域已存在，保留：${machineFile}`);
} else {
  say('\n· 未指定 --root，机器本地作用域未创建（默认继续用 .git 自动探测）。');
}

say('\n完成。最后一步：重启 pi，或在 pi 里执行 /reload。');
say('验证：直接读一个仓库内源码（应被 Layer 1 拦），或回复「稍后再补」且不动工具（应被轮次级拦）。');
