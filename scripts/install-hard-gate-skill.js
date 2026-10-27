#!/usr/bin/env node
/**
 * 安装全局技能 `agent-hard-gates`（Claude 与 pi 共享同一份）。
 *
 * 约定（与 CONTRIBUTING.md 一致）：
 *   - plan 先于 apply：默认只打印计划；
 *   - 幂等：内容相同则 keep；
 *   - 冲突保留用户版本：目标已存在且内容不同时默认拒绝覆盖，`--force` 才覆盖；
 *   - 写前备份：覆盖前落 `.bak.<timestamp>`；
 *   - 零第三方依赖。
 *
 * 技能装到 `~/.claude/skills/agent-hard-gates/`；pi 通过既有的
 * `~/.agents/skills -> ~/.claude/skills` 链接读取，不需要第二份副本。
 *
 * 用法：
 *   node scripts/install-hard-gate-skill.js                 # 干跑
 *   node scripts/install-hard-gate-skill.js --apply         # 安装
 *   node scripts/install-hard-gate-skill.js --apply --force # 覆盖用户改过的版本
 *   node scripts/install-hard-gate-skill.js --apply --home <dir>
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const apply = argv.includes('--apply');
const force = argv.includes('--force');
const homeIdx = argv.indexOf('--home');
const home = homeIdx >= 0 ? resolve(argv[homeIdx + 1]) : homedir();

const src = join(repo, 'skills', 'agent-hard-gates', 'SKILL.md');
if (!existsSync(src)) {
  console.error(`source not found: ${src}`);
  process.exit(1);
}

const destDir = join(home, '.claude', 'skills', 'agent-hard-gates');
const dest = join(destDir, 'SKILL.md');
const content = readFileSync(src, 'utf8');
const exists = existsSync(dest);
const same = exists && readFileSync(dest, 'utf8') === content;
const op = exists ? (same ? 'keep' : 'conflict') : 'add';

console.log(`plan: ${op}`);
console.log(`  from ${src}`);
console.log(`  to   ${dest}`);

if (!apply) {
  console.log('\n(dry run) 加 --apply 才会写盘');
  process.exit(0);
}
if (op === 'keep') {
  console.log('already up to date; nothing written');
  process.exit(0);
}
if (op === 'conflict' && !force) {
  console.error(
    '\n目标已存在且内容不同，默认不覆盖（用户改过的版本优先）。\n' +
      '  确认要用仓库版本覆盖：--force\n' +
      '  想保留自己的版本：不做任何事',
  );
  process.exit(2);
}

mkdirSync(destDir, { recursive: true });
if (exists) {
  const backup = `${dest}.bak.${Date.now()}`;
  copyFileSync(dest, backup);
  console.log(`backup: ${backup}`);
}
copyFileSync(src, dest);
console.log(`installed: ${dest}`);

const shared = join(home, '.agents', 'skills', 'agent-hard-gates');
if (existsSync(shared)) {
  console.log(`pi shares it through: ${shared}`);
} else {
  console.log(
    '\n提示：pi 通过 ~/.agents/skills 链接共享技能。该链接尚未包含本技能；\n' +
      '  在 agent-config-bridge 里执行 `node bridge/cli.js adopt pi`（或 apply）会自动建立/修复链接。',
  );
}
