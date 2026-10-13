/**
 * 测试总入口。
 *
 * 为什么不用 `node --test test/`：
 *   那个形式会让 Node 为每个测试文件派生一个子进程，在受限环境（沙箱、
 *   部分打包后的运行时）里会因为无法创建管道而直接 EPERM 失败。
 *   这里改成在**同一个进程内**依次 import 各测试文件，
 *   node:test 会自动收集并执行它们，结果等价。
 *
 * 用法：npm test
 */

import { run } from 'node:test';
import { spec } from 'node:test/reporters';

// 引入即注册测试。顺序只影响输出顺序。
import './config.test.js';
import './store.test.js';
import './portraits.test.js';
import './rng.test.js';
import './ruleset.test.js';
import './schema.test.js';
import './power-rating.test.js';
import './equipment.test.js';
import './engine.test.js';
import './llm.test.js';
import './model-list.test.js';
import './setup.test.js';
import './dice.test.js';
import './report-parser.test.js';
import './batch-decide.test.js';
import './scene-prompt.test.js';
import './user-unit.test.js';
import './user-unit-ownership.test.js';
import './skill-parse.test.js';
import './combat-mode.test.js';
import './roster.test.js';
import './pipelines.test.js';
import './player-cycle.test.js';
import './persona-worldbook.test.js';
import './charm.test.js';
import './banter.test.js';
import './battle-result-options.test.js';
import './battle-result-send.test.js';
import './roll-display.test.js';
import './dice-resolution.test.js';
import './modifier-pipeline.test.js';
import './generation-wait.test.js';
import './persuasion.test.js';
import './persuasion-llm.test.js';
import './skill-classification.test.js';
import './skill-mechanics.test.js';
import './loadout.test.js';
import './loadout-app.test.js';
import './loadout-ui.test.js';
import './loadout-chat.test.js';
import './scene-cleanup.test.js';
import './mercy.test.js';
import './mercy-app.test.js';
import './mercy-ui.test.js';
import './prebattle.test.js';
import './prebattle-ui.test.js';
import './mobile-panel.test.js';
import './ai-targets.test.js';
import './equipment-checks.test.js';
import './release.test.js';

// concurrency 1 + 不派生子进程：所有测试都在这个进程里跑完。
// 这是为了绕开「沙箱/受限运行时无法创建管道」导致 node --test 目录模式 EPERM 的问题。
const stream = run({ concurrency: 1, timeout: 60000, files: [] });

let failures = 0;
stream.on('test:fail', () => {
    failures++;
});

stream.compose(spec).pipe(process.stdout);

stream.on('end', () => {
    // 有失败时用非零退出码，方便 CI 判断
    if (failures > 0) process.exitCode = 1;
});
