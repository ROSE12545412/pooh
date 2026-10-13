/**
 * 对「已安装副本」跑冒烟测试。
 *
 * 与 `smoke-boot.js` 的区别：那个测的是仓库里的源码，
 * 这个测的是**真正躺在酒馆扩展目录里的那一份**。
 * 两者可能有差异（复制漏文件、路径大小写、编码问题），所以都要测。
 *
 * 用法：
 *   node scripts/smoke-installed.js [扩展目录绝对路径]
 * 或设置 TD_INSTALLED_DIR 环境变量；不默认引用开发者本机路径。
 */

import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const directory = process.argv[2] || process.env.TD_INSTALLED_DIR;
if (!directory) {
    console.error('请指定安装目录：node scripts/smoke-installed.js <扩展目录>，或设置 TD_INSTALLED_DIR。');
    process.exit(1);
}
const target = resolve(directory);

console.log(`目标扩展目录：${target}`);
console.log('');

if (!existsSync(target)) {
    console.error('✗ 目录不存在。请先安装扩展，或用参数指定正确路径。');
    process.exitCode = 1;
    process.exit();
}

// ---- 先做静态检查：manifest 与入口文件 ----
const manifestPath = join(target, 'manifest.json');
if (!existsSync(manifestPath)) {
    console.error('✗ 缺少 manifest.json —— 酒馆不会加载这个目录');
    process.exitCode = 1;
    process.exit();
}

// ⚠️ BOM 检查必须用「读字节」的方式做，不能只看 JSON.parse 成功与否 ——
// 因为这个脚本跑在 Node 里，而 Node 的 JSON.parse 对 BOM 是**严格报错**的，
// 但换到酒馆的加载器里表现可能不同。显式检查字节最可靠。
const manifestBytes = readFileSync(manifestPath);
if (manifestBytes.length >= 3 && manifestBytes[0] === 0xef && manifestBytes[1] === 0xbb && manifestBytes[2] === 0xbf) {
    console.error('✗ manifest.json 带 UTF-8 BOM —— 这会让酒馆的 JSON.parse 失败、扩展完全无法加载！');
    console.error('  修复：node scripts/strip-bom.js .');
    process.exitCode = 1;
    process.exit();
}
console.log('✓ manifest.json 无 BOM');

let manifest;
try {
    manifest = JSON.parse(manifestBytes.toString('utf8'));
    console.log('✓ manifest.json 是合法 JSON');
} catch (e) {
    console.error(`✗ manifest.json 解析失败：${String(e?.message ?? e)}`);
    process.exitCode = 1;
    process.exit();
}

let ok = true;
for (const key of ['js', 'css']) {
    const file = manifest[key];
    if (!file) {
        console.error(`✗ manifest 缺少 "${key}" 字段`);
        ok = false;
        continue;
    }
    if (existsSync(join(target, file))) {
        console.log(`✓ manifest.${key} 指向的 ${file} 存在`);
    } else {
        console.error(`✗ manifest.${key} 指向的 ${file} 不存在`);
        ok = false;
    }
}

if (manifest.display_name) console.log(`✓ 显示名：${manifest.display_name}`);
console.log(`✓ 版本：${manifest.version ?? '(未填写)'}`);

// 检查 src 是否完整（多文件扩展最容易漏的就是子目录）
const requiredModules = [
    'src/config.js',
    'src/app.js',
    'src/combat/engine.js',
    'src/core/rng.js',
    'src/core/schema.js',
    'src/core/ruleset.js',
    'src/core/store.js',
    'src/llm/client.js',
    'src/llm/setup.js',
    'src/llm/pipelines.js',
    'src/prompts/index.js',
    'src/ui/dom.js',
    'src/ui/ball.js',
    'src/ui/panel.js',
    'src/ui/progress.js',
    'src/ui/battle.js',
    'src/ui/settings.js',
    'src/ui/log.js',
];
for (const rel of requiredModules) {
    if (!existsSync(join(target, rel))) {
        console.error(`✗ 缺少模块 ${rel}`);
        ok = false;
    }
}
if (ok) console.log(`✓ 全部 ${requiredModules.length} 个源码模块都在`);

// ---- 用真冒烟测试去驱动这份副本 ----
// smoke-boot.js 是同目录下的独立脚本，它自己会 import '../index.js'。
// 为了让它跑在「已安装副本」上，这里用环境变量把目标目录传给它。
console.log('');
console.log('接下来用已安装的副本跑完整冒烟测试：');
console.log('─'.repeat(60));

process.env.TAVERN_DICE_TARGET = target;
await import(pathToFileURL(join(target, 'scripts', 'smoke-boot.js')).href);
