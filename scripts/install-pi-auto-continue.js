#!/usr/bin/env node
/**
 * 安装 pi 长任务续跑扩展（可选，默认不装）。
 *
 * 背景：pi 每一轮回复结束都会把控制权交回用户。这不是配置项，也关不掉 ——
 * 它是对话协议的边界。但扩展的 turn_end 边界可以投递下一条指令，于是长任务
 * （里程碑式开发、批量重构、整库迁移）可以连续跑，不必每轮回来按一次回车。
 *
 * 约定（与 CONTRIBUTING.md 一致）：
 *   - plan 先于 apply：默认只打印计划，加 --apply 才写盘；
 *   - 写前必备份：目标已存在时先落 `<file>.bak.<timestamp>`；
 *   - 不猜路径：目标目录取自 bridge/targets/pi.json 的 gates.extension_dir；
 *   - 幂等：内容相同则 keep，不重复写；
 *   - 零第三方依赖：只用 node: 标准库。
 *
 * 用法：
 *   node scripts/install-pi-auto-continue.js                  # 干跑
 *   node scripts/install-pi-auto-continue.js --apply          # 安装
 *   node scripts/install-pi-auto-continue.js --apply --home <dir>
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifestPath = join(repo, "bridge", "targets", "pi.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));

const relDir = manifest?.gates?.extension_dir;
if (!relDir) {
  console.error(
    `pi manifest 未声明 gates.extension_dir: ${manifestPath}\n` +
      "  不猜路径是仓库铁律；请先在 manifest 里声明目标目录。",
  );
  process.exit(1);
}

const argv = process.argv.slice(2);
const apply = argv.includes("--apply");
const homeIdx = argv.indexOf("--home");
const home = homeIdx >= 0 ? argv[homeIdx + 1] : homedir();

const src = join(repo, "bridge", "gates", "pi", "extensions", "auto-continue.ts");
if (!existsSync(src)) {
  console.error(`source not found: ${src}`);
  process.exit(1);
}

const destDir = join(home, relDir);
const dest = join(destDir, "auto-continue.ts");
const content = readFileSync(src, "utf8");
const exists = existsSync(dest);
const same = exists && readFileSync(dest, "utf8") === content;
const op = exists ? (same ? "keep" : "update") : "add";

console.log(`plan: ${op}`);
console.log(`  from ${src}`);
console.log(`  to   ${dest}`);

if (!apply) {
  console.log("\n(dry run) 加 --apply 才会写盘");
  process.exit(0);
}
if (op === "keep") {
  console.log("already up to date; nothing written");
  process.exit(0);
}

mkdirSync(destDir, { recursive: true });
if (exists) {
  const backup = `${dest}.bak.${Date.now()}`;
  copyFileSync(dest, backup);
  console.log(`backup: ${backup}`);
}
copyFileSync(src, dest);
console.log(`installed: ${dest}`);
console.log("\n下一步：在 pi 里执行 /reload（或重启 pi），然后 /auto on 40");
