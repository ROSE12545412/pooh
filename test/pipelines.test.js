/**
 * 流水线编排测试。
 *
 * 这里用**假的 ctx**（一个普通对象）替代真实酒馆上下文，
 * 因为流水线的输入输出都是纯数据，不需要真的跑起酒馆。
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { normalizePowerSystem } from '../src/core/schema.js';
import {
    getLastAssistantMessage,
    renderRecentMessages,
    summarizePowerSystem,
} from '../src/llm/pipelines.js';

/** 造一个假上下文。 */
function fakeCtx(overrides = {}) {
    return {
        name1: '玩家',
        name2: '角色卡',
        chat: [],
        ...overrides,
    };
}

/** 造一条消息。 */
function msg(text, opts = {}) {
    return { mes: text, is_user: false, is_system: false, name: '角色卡', ...opts };
}

/** 造一个单位。 */
function unit(overrides = {}) {
    return {
        name: '甲',
        side: 'ally',
        attributes: {
            HP: { current: 100, max: 100 },
            MP: { current: 50, max: 50 },
            Atk: { current: 20, max: 20 },
            Armor: { current: 5, max: 5 },
            Speed: { current: 10, max: 10 },
        },
        skills: [{ name: '斩击', power: 30, aim: 100, cost: 5, target: 'single', effects: [{ type: 'damage', power: 30, duration: 0 }] }],
        statuses: [],
        alive: true,
        ...overrides,
    };
}

describe('renderRecentMessages', () => {
    it('取最近 N 条并标注说话人', () => {
        const ctx = fakeCtx({
            chat: [msg('第一条'), msg('我是玩家', { is_user: true }), msg('第三条')],
        });
        const result = renderRecentMessages(ctx, 2);
        assert.ok(result.text.includes('我是玩家'));
        assert.ok(result.text.includes('第三条'));
        assert.ok(!result.text.includes('第一条'), '超出范围的旧消息不应包含');
    });

    it('区分玩家与角色名', () => {
        const ctx = fakeCtx({
            chat: [msg('角色说的话'), msg('玩家说的话', { is_user: true })],
        });
        const result = renderRecentMessages(ctx, 10);
        assert.ok(result.text.includes('【角色卡】'));
        assert.ok(result.text.includes('【玩家】'));
    });

    it('跳过系统消息', () => {
        const ctx = fakeCtx({
            chat: [msg('正常消息'), msg('系统提示', { is_system: true })],
        });
        const result = renderRecentMessages(ctx, 10);
        assert.ok(!result.text.includes('系统提示'));
    });

    it('超长消息按上限截断', () => {
        const ctx = fakeCtx({ chat: [msg('字'.repeat(10000))] });
        const result = renderRecentMessages(ctx, 1, { maxCharsPerMessage: 100 });
        assert.ok(result.text.length < 500, `没有截断：${result.text.length}`);
        assert.ok(result.text.includes('截断'));
    });

    it('空聊天返回空文本且不崩', () => {
        const result = renderRecentMessages(fakeCtx(), 5);
        assert.equal(result.text, '');
        assert.equal(renderRecentMessages(null, 5).text, '');
    });

    it('count 为 0 时返回空', () => {
        const ctx = fakeCtx({ chat: [msg('a'), msg('b')] });
        assert.equal(renderRecentMessages(ctx, 0).text, '');
    });
});

describe('getLastAssistantMessage', () => {
    it('取最后一条 AI 消息', () => {
        const ctx = fakeCtx({
            chat: [msg('第一条AI'), msg('用户插话', { is_user: true }), msg('最后一条AI')],
        });
        const result = getLastAssistantMessage(ctx);
        assert.equal(result.text, '最后一条AI');
        assert.equal(result.index, 2);
    });

    it('没有 AI 消息时返回 null', () => {
        const ctx = fakeCtx({ chat: [msg('用户说话', { is_user: true })] });
        assert.equal(getLastAssistantMessage(ctx), null);
    });

    it('空聊天返回 null', () => {
        assert.equal(getLastAssistantMessage(fakeCtx()), null);
        assert.equal(getLastAssistantMessage(null), null);
    });
});

describe('summarizePowerSystem', () => {
    it('按阵营分组列出', () => {
        const system = normalizePowerSystem({
            allies: [unit({ name: '甲' })],
            enemies: [unit({ name: '敌', side: 'enemy' })],
        });
        const text = summarizePowerSystem(system);
        assert.ok(text.includes('我方'));
        assert.ok(text.includes('敌方'));
        assert.ok(text.includes('甲'));
        assert.ok(text.includes('敌'));
    });

    it('包含 HP 与技能信息（供战斗决策参考）', () => {
        const system = normalizePowerSystem({ allies: [unit()] });
        const text = summarizePowerSystem(system);
        assert.ok(text.includes('HP:100/100'));
        assert.ok(text.includes('斩击'));
        assert.ok(text.includes('power:30'));
    });

    it('标注阵亡单位', () => {
        const system = normalizePowerSystem({ allies: [unit({ alive: false })] });
        assert.ok(summarizePowerSystem(system).includes('已阵亡'));
    });

    it('列出状态', () => {
        const system = normalizePowerSystem({
            allies: [unit({ statuses: [{ name: '中毒', type: 'dot', duration: 3, power: 5 }] })],
        });
        assert.ok(summarizePowerSystem(system).includes('中毒'));
    });

    it('空体系返回占位文本而不是崩', () => {
        assert.ok(summarizePowerSystem(null).includes('空'));
        assert.ok(summarizePowerSystem({ combatants: [] }).includes('空'));
    });

    it('单位过多时截断并说明', () => {
        const allies = Array.from({ length: 50 }, (_, i) => unit({ name: `角色${i}` }));
        const system = normalizePowerSystem({ allies });
        const text = summarizePowerSystem(system, { maxUnits: 5 });
        assert.ok(text.includes('未列出'));
    });
});
