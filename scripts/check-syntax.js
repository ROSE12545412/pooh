/**
 * 脚本自检：把整个源码依赖图真正 import 一遍，并检查编码陷阱。
 *
 * 比纯语法检查强得多：除了语法，还能抓出**路径写错、循环依赖、
 * 顶层就访问浏览器 API** 这类只有在加载时才会暴露的问题。
 * 这个插件最容易出的就是「某个 import 路径写错，整个扩展白白启动失败」。
 *
 * 同时检查 **UTF-8 BOM** —— 这是真实事故：
 * PowerShell 的 `Set-Content -Encoding UTF8` 会加上 BOM，而带 BOM 的
 * `manifest.json` 会让酒馆的 `JSON.parse` 直接抛错，扩展**完全无法加载**。
 * （而 PowerShell 自己的 `ConvertFrom-Json` 容忍 BOM，所以手工校验发现不了。）
 *
 * 实现上刻意**不派生子进程**（受限运行时里创建管道会 EPERM），
 * 全部在当前进程内用动态 import 完成。
 *
 * 用法：node scripts/check-syntax.js
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));

/** 递归收集 .js 文件。 */
function collectJs(/** @type {string} */ dir, /** @type {string[]} */ out = []) {
    for (const name of readdirSync(dir)) {
        if (name === 'node_modules' || name === '.git') continue;
        const full = join(dir, name);
        const stat = statSync(full);
        if (stat.isDirectory()) collectJs(full, out);
        else if (name.endsWith('.js')) out.push(full);
    }
    return out;
}

/** 只针对源码做 import 探测；测试与脚本自己会被 node:test 覆盖。 */
const targets = [...collectJs(join(root, 'src'))];

let failed = 0;

// ---------------------------------------------------------------------------
// 第 1 关：BOM 检查（真实事故的防线）
// ---------------------------------------------------------------------------

/** 需要检查 BOM 的文本文件。 */
const BOM_SENSITIVE = ['.json', '.js', '.mjs', '.md', '.css', '.html', '.yml', '.yaml'];

/** 递归收集文本文件。 */
function collectText(/** @type {string} */ dir, /** @type {string[]} */ out = []) {
    for (const name of readdirSync(dir)) {
        if (name === 'node_modules' || name === '.git') continue;
        const full = join(dir, name);
        const stat = statSync(full);
        if (stat.isDirectory()) {
            collectText(full, out);
            continue;
        }
        const ext = name.includes('.') ? `.${name.split('.').pop()}` : '';
        if (BOM_SENSITIVE.includes(ext)) out.push(full);
    }
    return out;
}

console.log('BOM 检查：');
let bomFound = 0;
for (const file of collectText(root)) {
    const buf = readFileSync(file);
    if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
        bomFound++;
        failed++;
        console.error(`  ✗ ${relative(root, file).replace(/\\/g, '/')} 带 UTF-8 BOM（会让 JSON.parse 失败）`);
        console.error(`    修复：node scripts/strip-bom.js .`);
    }
}
if (!bomFound) console.log('  ✓ 所有文本文件均无 BOM');
console.log('');

// ---------------------------------------------------------------------------
// 第 2 关：整个依赖图 import 一遍
// ---------------------------------------------------------------------------

console.log('加载检查：');
for (const file of targets) {
    const label = relative(root, file).replace(/\\/g, '/');
    try {
        // 带一个查询串避免命中模块缓存，保证每次都真的重新解析
        await import(`${pathToFileURL(file).href}?check=${Date.now()}`);
        console.log(`  ✓ ${label}`);
    } catch (e) {
        failed++;
        console.error(`  ✗ ${label}`);
        console.error(`    ${String(/** @type {any} */ (e)?.message ?? e).split('\n')[0]}`);
    }
}

console.log('');
if (failed) {
    console.error(`检查未通过：共 ${failed} 处问题`);
    process.exitCode = 1;
} else {
    console.log(`检查通过：无 BOM，且 ${targets.length} 个模块全部可正常 import`);
}
