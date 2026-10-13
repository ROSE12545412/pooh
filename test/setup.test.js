/**
 * 「开战」流程的测试：正文模型读场面 → 掷骰模型结构化。
 *
 * 这个功能的设计核心是**分工**：
 *  - 读场面必须用**正文模型**（当前聊天在用的那个），因为只有它完整读过这张卡与这段剧情
 *  - 结构化交给**掷骰模型**（输入短、任务简单，便宜快）
 *
 * 所以测试重点在提示词的分工约束与降级行为上。
 */

import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import { buildSituationPrompt, countUnits, readSituation, resolveNarrativeChannel, structureSituation } from '../src/llm/setup.js';
import { normalizeCombatant, normalizePowerSystem } from '../src/core/schema.js';
import { defaultSettings } from '../src/config.js';

describe('buildSituationPrompt 场面读取提示词', () => {
    it('要求读出六项内容：人数、状态、技能、装备、临时加成、环境', () => {
        const { system } = buildSituationPrompt({ recentChat: '测试剧情' });
        for (const item of ['有哪些人在打', '当前的状态', '技能', '武器与装备', '临时加成', '战场环境']) {
            assert.ok(system.includes(item), `必须要求读出「${item}」`);
        }
    });

    it('明确要求血量用**估算**而不是编造精确值', () => {
        const { system } = buildSituationPrompt({ recentChat: '测试剧情' });
        assert.ok(system.includes('估算'), '必须声明血量是估算');
        assert.ok(system.includes('百分比或档位'), '应当给出估算的表达方式');
    });

    it('明确禁止编造剧情里没有的技能与装备', () => {
        const { system } = buildSituationPrompt({ recentChat: '测试剧情' });
        assert.ok(system.includes('不要编') || system.includes('不要编造'), '必须禁止编造');
    });

    it('要求输出自然语言而不是 JSON（结构化是下一步的事）', () => {
        const { system } = buildSituationPrompt({ recentChat: '测试剧情' });
        assert.ok(system.includes('不要输出 JSON'), '这一步应当要求自然语言');
    });

    it('要求明确区分「确定」与「估算」', () => {
        const { system } = buildSituationPrompt({ recentChat: '测试剧情' });
        assert.ok(system.includes('确定') && system.includes('估算'), '必须要求区分二者');
    });

    it('要求不做战术建议（只记录场面）', () => {
        const { system } = buildSituationPrompt({ recentChat: '测试剧情' });
        assert.ok(system.includes('不做战术建议') || system.includes('不要替用户决定'), '必须限定职责');
    });

    it('剧情里没有战斗时要求如实说明', () => {
        const { system } = buildSituationPrompt({ recentChat: '测试剧情' });
        assert.ok(system.includes('没有战斗场面'), '必须覆盖「没在打」的情形');
    });

    it('把最近的剧情放进 user 消息', () => {
        const { user } = buildSituationPrompt({ recentChat: '甲乙两人在河边对峙' });
        assert.ok(user.includes('甲乙两人在河边对峙'));
    });

    it('用户的补充说明优先级最高', () => {
        const { user } = buildSituationPrompt({ recentChat: 'x', situation: '只算主角和刺客单挑' });
        assert.ok(user.includes('只算主角和刺客单挑'));
        assert.ok(user.includes('优先级最高'), '必须声明补充说明优先');
    });

    it('带上已有战力表作为参考（但以剧情为准）', () => {
        const { user } = buildSituationPrompt({ recentChat: 'x', knownUnits: '甲（ally）HP上限500' });
        assert.ok(user.includes('甲（ally）HP上限500'));
        assert.ok(user.includes('以当前剧情为准'), '必须声明剧情优先于已有表');
    });

    it('带上角色卡与玩家名', () => {
        const { user } = buildSituationPrompt({ recentChat: 'x', characterName: '测试角色', userName: '玩家' });
        assert.ok(user.includes('测试角色'));
        assert.ok(user.includes('玩家'));
    });

    it('没有剧情时不崩', () => {
        assert.doesNotThrow(() => buildSituationPrompt({ recentChat: '' }));
        assert.doesNotThrow(() => buildSituationPrompt({}));
    });
});

describe('resolveNarrativeChannel 正文模型通道选择', () => {
    it('默认走主连接（只有它完整读过这张卡）', () => {
        const channel = resolveNarrativeChannel(defaultSettings());
        assert.equal(channel.mode, 'main');
    });

    it('用户可指定战斗模型读取场景', () => {
        const settings = defaultSettings();
        settings.battle.narrativeChannel = 'p2';
        assert.equal(resolveNarrativeChannel(settings), settings.p2.channel);
    });

    it('显式指定 main 时也返回 main', () => {
        const settings = defaultSettings();
        settings.battle.narrativeChannel = 'main';
        assert.equal(resolveNarrativeChannel(settings).mode, 'main');
    });

    it('设置残缺时不崩', () => {
        assert.doesNotThrow(() => resolveNarrativeChannel(null));
        assert.doesNotThrow(() => resolveNarrativeChannel({}));
    });
});

describe('readSituation 输入校验与降级', () => {
    it('最近没有剧情时明确报错', async () => {
        const ctx = { chat: [], name1: '玩家', name2: '角色' };
        const result = await readSituation(ctx, defaultSettings(), {});
        assert.equal(result.ok, false);
        assert.match(result.error, /没有可读的内容/);
    });

    it('已中止的信号立即返回', async () => {
        const controller = new AbortController();
        controller.abort();
        const ctx = { chat: [{ mes: '测试', is_user: false, name: '角色' }], name1: '玩家', name2: '角色' };
        const result = await readSituation(ctx, defaultSettings(), { signal: controller.signal });
        assert.equal(result.aborted, true);
    });

    it('带运行日志返回（便于 UI 展示过程）', async () => {
        const ctx = { chat: [], name1: '玩家', name2: '角色' };
        const result = await readSituation(ctx, defaultSettings(), {});
        assert.ok(Array.isArray(result.logs));
    });
});

describe('structureSituation 结构化提示词与降级', () => {
    it('已中止的信号立即返回', async () => {
        const controller = new AbortController();
        controller.abort();
        const result = await structureSituation(null, defaultSettings(), '我方两人，敌方一人', {
            signal: controller.signal,
        });
        assert.equal(result.aborted, true);
        assert.ok(Array.isArray(result.logs));
    });

    it('设置残缺时不抛异常（返回结构化失败）', async () => {
        const settings = defaultSettings();
        // 让它快速失败：给一个必然连不上的直连配置
        settings.p2.channel.mode = 'custom';
        settings.p2.channel.apiUrl = 'https://127.0.0.1:1/v1';
        settings.p2.channel.model = 'none';
        settings.p2.channel.timeout = 1;
        settings.p2.channel.retries = 0;

        const result = await structureSituation(null, settings, '我方：甲。敌方：乙。');
        assert.equal(typeof result.ok, 'boolean', '应当返回结构化结果而不是抛异常');
        assert.ok(Array.isArray(result.logs));
    });
});

describe('countUnits 三种单位格式都要认（真实 bug 的回归测试）', () => {
    /**
     * 这个 bug 的表现：用户看到战况汇报里**双方都读出来了**，
     * 但插件还是报「没能识别出参战者」。
     *
     * 根因：数数逻辑只数 `allies` + `enemies`，而模型时常返回**统一的 `combatants` 列表**。
     * 于是数出 0 → 判定失败 → 报错。**明明数据是好的，却被判成没检测到人。**
     */

    it('分栏格式（allies / enemies）', () => {
        assert.equal(countUnits({ allies: [{}, {}], enemies: [{}] }), 3);
    });

    it('统一列表格式（combatants）—— 这就是漏掉的那种', () => {
        assert.equal(countUnits({ combatants: [{}, {}, {}] }), 3);
    });

    it('units 字段', () => {
        assert.equal(countUnits({ units: [{}, {}] }), 2);
    });

    it('中文键名', () => {
        assert.equal(countUnits({ 我方: [{}, {}], 敌方: [{}] }), 3);
        assert.equal(countUnits({ 角色: [{}] }), 1);
    });

    it('直接是一个数组', () => {
        assert.equal(countUnits([{}, {}]), 2);
    });

    it('混用多种字段时累加（宁多算不少算）', () => {
        assert.equal(countUnits({ allies: [{}], combatants: [{}, {}] }), 3);
    });

    it('确实为空时返回 0', () => {
        assert.equal(countUnits({}), 0);
        assert.equal(countUnits({ allies: [], enemies: [] }), 0);
        assert.equal(countUnits(null), 0);
        assert.equal(countUnits(undefined), 0);
        assert.equal(countUnits('不是对象'), 0);
    });

    it('统一格式能一路走到「按 side 分栏」', () => {
        // 光能数还不够 —— 归一化必须真的把它分成敌我，否则开战仍然报「没有敌方单位」
        const unified = {
            combatants: [
                normalizeCombatant({ name: '甲', side: 'ally' }),
                normalizeCombatant({ name: '乙', side: 'enemy' }),
            ],
        };
        assert.equal(countUnits(unified), 2);

        const norm = normalizePowerSystem(unified);
        assert.equal(norm.combatants.length, 2);
        assert.equal(norm.combatants.filter((u) => u.side === 'ally').length, 1, '应当分出一个我方');
        assert.equal(norm.combatants.filter((u) => u.side === 'enemy').length, 1, '应当分出一个敌方');
    });

    it('setup.js 里的两处计数都必须用 countUnits（静态检查防回退）', () => {
        const source = readFileSync(new URL('../src/llm/setup.js', import.meta.url), 'utf8');
        // 不允许再出现「只数 allies + enemies」的写法
        assert.ok(
            !/\(.*\?\.allies\?\.length \?\? 0\)\s*\+\s*\(.*\?\.enemies\?\.length \?\? 0\)/.test(source),
            '不该再有「只数 allies+enemies」的加法计数',
        );
        assert.ok(source.includes('countUnits(extracted.value)'), '解析成功的分支必须用 countUnits');
    });
});

describe('分工约定的完整性', () => {
    it('配置里同时有正文模型与掷骰模型两条通道设置', () => {
        const settings = defaultSettings();
        assert.ok(settings.battle.narrativeChannel, '应当有正文模型通道设置');
        assert.ok(settings.battle.structureChannel, '应当有掷骰模型通道设置');
    });

    it('两个通道默认不同（正文走主连接、掷骰走便宜的更新通道）', () => {
        const settings = defaultSettings();
        assert.equal(settings.battle.narrativeChannel, 'main');
        assert.equal(settings.battle.structureChannel, 'p2');
    });

    it('有扫描消息条数与种子配置', () => {
        const settings = defaultSettings();
        assert.ok(settings.battle.scanMessages > 0);
        assert.equal(typeof settings.battle.seed, 'string');
    });
});

describe('结构化那步必须拿到足够的输入（防「没有任何战斗单位」）', () => {
    /**
     * 这是踩过的坑：早期只把「汇报」给结构化那步，不给原始剧情。
     * 第一个模型要是漏了人，第二步就无从补救 → 产出 0 个单位 →
     * 最后在开战那步报「没有任何战斗单位，无法开战」。
     */

    it('buildSituationPrompt 要求「至少列出名字」，并说明没在打时要讲清楚', () => {
        const { system } = buildSituationPrompt({ recentChat: '测试' });
        assert.ok(system.includes('名字'), '必须要求列出参战者名字');
        assert.ok(system.includes('杂兵'), '应当说明无名杂兵可以合并计数');
        assert.ok(system.includes('没有战斗场面'), '没在打时必须明说');
    });

    it('structureSituation 接受并透传 recentChat 与 situation', async () => {
        const settings = defaultSettings();
        // 用一个必然失败的直连配置，但先验证参数被接受（不抛异常）
        settings.p2.channel.mode = 'custom';
        settings.p2.channel.apiUrl = 'https://127.0.0.1:1/v1';
        settings.p2.channel.model = 'none';
        settings.p2.channel.timeout = 1;
        settings.p2.channel.retries = 0;

        const result = await structureSituation(null, settings, '我方：甲。敌方：乙。', {
            recentChat: '甲乙在河边对峙，甲拔出了剑。',
            situation: '只算这两个人',
        });
        assert.equal(typeof result.ok, 'boolean', '应当接受这些参数并返回结构化结果');
        assert.ok(Array.isArray(result.logs));
    });

    it('结构化提示词不得再把汇报称作「唯一数据来源」（那会让模型不敢用剧情补人）', () => {
        // 静态检查源码：提示词是模板字符串拼的，读源码最直接可靠。
        // 这个断言的价值在于防止有人把「原始剧情」这一路输入又改回去。
        const source = readFileSync(new URL('../src/llm/setup.js', import.meta.url), 'utf8');
        assert.ok(!source.includes('唯一数据来源'), '「唯一数据来源」的措辞会让模型不敢从剧情补人，必须去掉');
        assert.ok(source.includes('原始剧情（后备'), '必须把原始剧情作为后备输入给到结构化那步');
        assert.ok(source.includes('至少要产出一个人'), '必须明确要求至少产出一个单位');
    });

    it('app 层把剧情传给结构化那步', () => {
        const source = readFileSync(new URL('../src/app.js', import.meta.url), 'utf8');
        assert.ok(source.includes('recentChat'), 'app 层应当算出 recentChat 并传下去');
        assert.ok(/structureSituation\([^)]*\{[\s\S]{0,400}?recentChat/.test(source), 'recentChat 必须真的传进 structureSituation');
    });
});
