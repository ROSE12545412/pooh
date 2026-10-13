/**
 * 去除文件开头的 UTF-8 BOM。
 *
 * 为什么需要这个脚本（真实事故）：
 *   用 PowerShell 的 `Set-Content -Encoding UTF8` 改写文件时，Windows PowerShell 5.1
 *   会**自动加上 UTF-8 BOM**。而 `JSON.parse(readFileSync('manifest.json'))` 遇到
 *   BOM 会直接抛 `Unexpected token '﻿'` —— 结果是**酒馆完全无法加载这个扩展**。
 *   更阴险的是 `.NET` 的 `ConvertFrom-Json` 会容忍 BOM，所以用 PowerShell 校验
 *   manifest「能解析成功」，完全掩盖了这个问题。
 *
 * 用法：
 *   node scripts/strip-bom.js <目录>             # 处理该目录（递归）
 *   node scripts/strip-bom.js <目录> --dry-run   # 只报告，不改动
 */

import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const BOM = [0xef, 0xbb, 0xbf];

/** 需要检查的文本类扩展名。 */
const TEXT_EXTENSIONS = new Set([
    '.json',
    '.js',
    '.mjs',
    '.cjs',
    '.md',
    '.css',
    '.html',
    '.yml',
    '.yaml',
    '.txt',
    '.gitignore',
]);

/** 判断文件是否以 BOM 开头。 */
function hasBom(/** @type {Buffer} */ buf) {
    return buf.length >= 3 && buf[0] === BOM[0] && buf[1] === BOM[1] && buf[2] === BOM[2];
}

/** 递归收集候选文件。 */
function collect(/** @type {string} */ dir, /** @type {string[]} */ out = []) {
    for (const name of readdirSync(dir)) {
        if (name === 'node_modules' || name === '.git') continue;
        const full = join(dir, name);
        const stat = statSync(full);
        if (stat.isDirectory()) {
            collect(full, out);
            continue;
        }
        const ext = name.includes('.') ? `.${name.split('.').pop()}` : '';
        if (TEXT_EXTENSIONS.has(ext) || name === '.gitignore') out.push(full);
    }
    return out;
}

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const targetArg = args.find((a) => !a.startsWith('--'));
const target = resolve(targetArg ?? '.');

if (!statSync(target).isDirectory()) {
    console.error(`✗ 不是目录：${target}`);
    process.exitCode = 1;
    process.exit();
}

const files = collect(target);
/** @type {string[]} */
const fixed = [];

for (const file of files) {
    let buf;
    try {
        buf = readFileSync(file);
    } catch {
        continue;
    }
    if (!hasBom(buf)) continue;
    const label = relative(target, file).replace(/\\/g, '/');
    if (dryRun) {
        console.log(`  发现 BOM：${label}`);
    } else {
        writeFileSync(file, buf.subarray(3));
        console.log(`  已去除 BOM：${label}`);
    }
    fixed.push(label);
}

console.log('');
if (!fixed.length) {
    console.log(`BOM 检查通过：${files.length} 个文本文件均无 BOM`);
} else if (dryRun) {
    console.error(`发现 ${fixed.length} 个文件带 BOM（会导致 JSON.parse 失败、扩展无法加载）`);
    process.exitCode = 1;
} else {
    console.log(`已修复 ${fixed.length} 个文件的 BOM`);
}
