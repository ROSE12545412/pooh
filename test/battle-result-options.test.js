import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { AppController } from '../src/app.js';
import { Battle } from '../src/combat/engine.js';
import { resolveRecruitment } from '../src/combat/social.js';
import { EXT_ID } from '../src/config.js';
import { normalizePowerSystem } from '../src/core/schema.js';

const clone = value => structuredClone(value);

function controller({ metadata = {}, sent = [] } = {}) {
    const saves = [];
    const ctx = {
        chat: [], chatMetadata: clone(metadata), extensionSettings: {},
        async saveMetadata() { saves.push(clone(this.chatMetadata)); },
    };
    const app = new AppController(ctx);
    // Only the external transport is replaced; result generation and persistence stay real.
    app.sendToChat = async text => {
        sent.push(text);
        return { ok: true, method: 'slash' };
    };
    return { app, ctx, saves, sent };
}

function fixture() {
    const f = controller();
    const unit = (id, name, side) => ({
        id, name, side, isUser: side === 'ally',
        attributes: {
            HP: { current: 37, max: 100 }, MP: { current: 9, max: 40 },
            Speed: { current: 10, max: 10 },
        },
        skills: [{ id: `${id}-skill`, name: '试锋', power: 12, cost: 3, target: 'single',
            effects: [{ type: 'damage', power: 12 }] }],
    });
    const system = normalizePowerSystem({ combatants: [
        unit('player', '旅人', 'ally'), unit('guard', '守门人', 'enemy'), unit('other', '卫兵', 'enemy'),
    ] });
    const battle = new Battle(system, { seed: 'result-option' });
    assert.equal(battle.start().ok, true);
    const speaker = battle.units.find(u => u.id === 'player');
    const target = battle.units.find(u => u.id === 'guard');
    // Keep every live battle on the player's turn: no model or auto-drive is needed.
    battle.turnIndex = battle.initiative.findIndex(entry => entry.unitId === speaker.id);
    assert.equal(battle.currentUnit.isUser, true);
    f.app.battle = battle;

    const originalInt = battle.rng.int;
    battle.rng.int = () => 12;
    try {
        const check = resolveRecruitment(battle, speaker, target, {
            eligible: true, dc: 15, charmValue: 80, reason: '守门人记起旧日恩情。',
        });
        assert.equal(check.success, true);
    } finally {
        battle.rng.int = originalInt;
    }
    const socialFacts = battle.log.filter(entry => ['charm', 'defection'].includes(entry.type)).map(entry => entry.text);
    assert.equal(socialFacts.length, 2);
    assert.equal(target.side, 'ally');
    assert.notEqual(battle.phase, 'finished', '保留另一敌人，以验证改选项不推进战斗');

    const dialogues = Array.from({ length: 18 }, (_, i) => {
        const from = i % 2 === 0 ? speaker : target;
        const to = i % 2 === 0 ? target : speaker;
        const claim = i % 2 === 0 ? '我吹嘘造成了999点伤害，但这只是对白。' : '我宣称治疗了888点生命，但这只是对白。';
        const text = `💬 ${from.name} → ${to.name}：[口嗨${String(i + 1).padStart(2, '0')}] ${claim}`;
        battle.pushBanter(text, { speakerId: from.id, targetId: to.id });
        return text;
    });
    return { ...f, battle, speaker, target, dialogues, socialFacts };
}

function assertBanter(text, dialogues, included) {
    assert.equal(typeof text, 'string');
    let previous = -1;
    for (const dialogue of dialogues) {
        assert.equal(text.split(dialogue).length - 1, included ? 1 : 0,
            `${included ? '完整保留且仅出现一次' : '不应混入结算事实'}：${dialogue}`);
        if (included) {
            const index = text.indexOf(dialogue);
            assert.ok(index > previous, '全部口嗨应按原对话顺序保留');
            previous = index;
        }
    }
}

function assertFacts(text, f) {
    for (const fact of f.socialFacts) assert.ok(text.includes(fact), `结算不能丢失：${fact}`);
    assert.match(text, /我方 守门人：HP 37\/100.*MP 9\/40/);
}

function assertRecord(f, { combatText, banterText, includeBanter, sent = false }) {
    const record = f.app.data.battleResult;
    assert.ok(record, '结算应保存在聊天元数据中');
    assert.equal(record.combatText, combatText, '保留玩家编辑的独立战斗文本');
    assert.equal(record.banterText, banterText, '关闭选项不能删除独立口嗨记录');
    assert.equal(record.includeBanter, includeBanter);
    assert.equal(record.sent, sent);
    assertBanter(record.combatText, f.dialogues, false);
    assertBanter(record.banterText, f.dialogues, true);
    assertBanter(record.text, f.dialogues, includeBanter);
    if (includeBanter) {
        assert.ok(record.text.startsWith(combatText), '战斗事实及玩家编辑应位于口嗨附录之前');
        assert.ok(record.text.endsWith(banterText), '完整口嗨应作为独立附录追加');
    } else {
        assert.equal(record.text, combatText);
    }
    assertFacts(record.text, f);
    return record;
}

function assertSaved(f) {
    assert.ok(f.saves.length > 0, '应实际调用 saveMetadata 保存结果');
    assert.deepEqual(f.saves.at(-1)[EXT_ID].battleResult, f.app.data.battleResult);
}

function reopen(f) {
    assertSaved(f);
    return {
        ...controller({ metadata: f.saves.at(-1), sent: f.sent }),
        dialogues: f.dialogues, socialFacts: f.socialFacts,
    };
}

describe('战斗结算的口嗨发送选项', () => {
    it('默认关闭，只有保存的布尔 true 才开启', () => {
        const { app, ctx, sent } = controller();
        assert.equal(app.includeBanterInResult, false);
        ctx.chatMetadata[EXT_ID] = app.data;
        for (const value of [undefined, null, false, 0, 1, 'true']) {
            app.data.battleResult = { includeBanter: value };
            assert.equal(app.includeBanterInResult, false);
        }
        app.data.battleResult = { includeBanter: true };
        assert.equal(app.includeBanterInResult, true);
        assert.deepEqual(sent, []);
        assert.deepEqual(ctx.chat, []);
    });

    it('完整格式化18条口嗨；存在战斗时读当前记录，清空战斗时读保存的附录', () => {
        const f = fixture();
        f.ctx.chatMetadata[EXT_ID] = f.app.data;
        const savedBanter = '此前保存的另一场战斗对白';
        f.app.data.battleResult = { banterText: savedBanter };
        const current = f.app.battleBanterText();
        assertBanter(current, f.dialogues, true);
        assert.equal(current.includes(savedBanter), false);
        f.app.battle = null;
        assert.equal(f.app.battleBanterText(), savedBanter);
        f.app.data.battleResult = null;
        assert.equal(f.app.battleBanterText(), '');
        assert.deepEqual(f.sent, []);
    });

    it('默认预览和结束只保存事实；显式预览口嗨不改变开关且不会发送', async () => {
        const f = fixture();
        const combatText = f.app.battleResultText();
        const banterText = f.app.battleBanterText();
        assert.equal(f.app.includeBanterInResult, false);
        assert.equal(combatText, f.app.battleResultText({ includeBanter: false }));
        assertBanter(combatText, f.dialogues, false);
        assertFacts(combatText, f);
        assertBanter(f.app.battleResultText({ includeBanter: true }), f.dialogues, true);
        assert.equal(f.app.includeBanterInResult, false, '临时预览不能替玩家保存发送选择');
        assert.deepEqual(f.sent, []);

        assert.equal((await f.app.finishBattle()).ok, true);
        assert.equal(f.app.battle, null);
        assert.equal(f.app.data.battle, null);
        assertRecord(f, { combatText, banterText, includeBanter: false });
        assertSaved(f);
        assert.equal(f.app.battleResultText(), combatText);
        assert.equal(f.app.battleBanterText(), banterText);
        assert.deepEqual(f.sent, [], '即使结束战斗也绝不自动发送');
        assert.deepEqual(f.ctx.chat, []);

        assert.equal((await f.app.sendBattleResult()).ok, true);
        assert.deepEqual(f.sent, [combatText], '未开启选项时，主动发送也只含战斗事实');
        assertRecord(f, { combatText, banterText, includeBanter: false, sent: true });
        assertSaved(f);
    });

    it('首次选择写入空元数据，反复开关保留编辑和全部对白，不耗资源或推进回合', async () => {
        const f = fixture();
        const before = f.battle.toState();
        const banterText = f.app.battleBanterText();
        const combatText = f.app.battleResultText({ includeBanter: false });
        const firstEdit = `${combatText}\n玩家补记：暂时停战，稍后续写。`;
        const secondEdit = `${combatText}\n玩家修订：众人留在原地整理装备。`;
        let expectedEdit = firstEdit;
        assert.deepEqual(f.ctx.chatMetadata, {}, '首次选择也必须能够保存');
        for (const [includeBanter, edit] of [
            [true, firstEdit], [false, undefined], [true, secondEdit], [false, undefined], [true, undefined],
        ]) {
            if (edit !== undefined) expectedEdit = edit;
            const saveCount = f.saves.length;
            await f.app.setBattleResultIncludeBanter(includeBanter, edit);
            assert.equal(f.app.includeBanterInResult, includeBanter);
            assertRecord(f, { combatText: expectedEdit, banterText, includeBanter });
            assert.ok(f.saves.length > saveCount);
            assertSaved(f);
            assertBanter(f.app.battleResultText(), f.dialogues, includeBanter);
            assertBanter(f.app.battleResultText({ includeBanter: !includeBanter }), f.dialogues, !includeBanter);
            assert.equal(f.app.includeBanterInResult, includeBanter, '显式预览参数不改动已保存选择');
            assert.equal(f.app.battleResultText({ includeBanter: false }), combatText, '开关不应把对白变成战斗事实');
            assert.deepEqual(f.battle.toState(), before, '不改变战斗、阵营、资源、日志、回合或完整对话');
            assert.deepEqual(f.sent, [], '开关本身绝不发送');
            assert.deepEqual(f.ctx.chat, []);
        }
    });

    for (const passFinalEdit of [false, true]) {
        it(`finish保存${passFinalEdit ? '此次传入' : '之前保存'}的编辑，清空战斗后恢复仍能反复选择`, async () => {
            const f = fixture();
            const banterText = f.app.battleBanterText();
            const draft = `${f.app.battleResultText({ includeBanter: false })}\n玩家编辑：保留守门人的承诺。`;
            const combatText = passFinalEdit ? `${draft}\n最终补记：先休整再继续剧情。` : draft;
            await f.app.setBattleResultIncludeBanter(true, draft);
            const finished = passFinalEdit ? await f.app.finishBattle(combatText) : await f.app.finishBattle();
            assert.equal(finished.ok, true);
            assert.equal(f.app.battle, null);
            assert.equal(f.app.data.battle, null);
            assertRecord(f, { combatText, banterText, includeBanter: true });
            assert.deepEqual(f.sent, []);

            let restored = reopen(f);
            assert.equal(restored.app.restoreBattle(), false, '只有结算、没有战斗时应返回false');
            assert.equal(restored.app.battle, null);
            assert.equal(restored.app.includeBanterInResult, true);
            assertRecord(restored, { combatText, banterText, includeBanter: true });
            assert.equal(restored.app.battleResultText({ includeBanter: false }), combatText);
            for (const includeBanter of [false, true, false]) {
                await restored.app.setBattleResultIncludeBanter(includeBanter);
                assertRecord(restored, { combatText, banterText, includeBanter });
                const savedRecord = clone(restored.app.data.battleResult);
                restored = reopen(restored);
                assert.equal(restored.app.restoreBattle(), false);
                assert.deepEqual(restored.app.data.battleResult, savedRecord, 'restore不能清除已结束战斗的结算');
                assert.equal(restored.app.includeBanterInResult, includeBanter);
                assertBanter(restored.app.battleResultText(), f.dialogues, includeBanter);
                assertFacts(restored.app.battleResultText(), f);
                assert.equal(restored.app.battleBanterText(), banterText);
                assert.deepEqual(restored.sent, [], '恢复及再次选择都不能自动发送');
                assert.deepEqual(restored.ctx.chat, []);
            }
        });
    }

    for (const includeBanter of [false, true]) {
        it(`显式发送按${includeBanter ? '开启' : '关闭'}选择组合编辑文本，重发不重复附录且保留魅力和投靠`, async () => {
            const f = fixture();
            const banterText = f.app.battleBanterText();
            const draft = `${f.app.battleResultText({ includeBanter: false })}\n玩家编辑：这是一份待发送草稿。`;
            await f.app.setBattleResultIncludeBanter(includeBanter, draft);
            assert.equal((await f.app.finishBattle()).ok, true);
            const restored = reopen(f);
            assert.equal(restored.app.restoreBattle(), false);
            assert.deepEqual(restored.sent, [], '点击发送之前，正文调用数必须为零');
            const edited = `${draft}\n发送前修订：守门人继续跟随旅人。`;

            assert.equal((await restored.app.sendBattleResult(edited)).ok, true);
            assert.equal(restored.sent.length, 1);
            let record = assertRecord(restored, { combatText: edited, banterText, includeBanter, sent: true });
            assert.equal(restored.sent[0], record.text);
            assert.equal(restored.app.battleSent, true);
            assertSaved(restored);
            const sentAgain = await restored.app.sendBattleResult();
            assert.equal(sentAgain.ok, true);
            assert.equal(restored.sent.length, 2, '每次显式发送恰好调用一次正文接口');
            assert.equal(restored.sent[1], restored.sent[0], '从已组合结算再次发送不能追加第二份口嗨');
            assertBanter(restored.sent[1], f.dialogues, includeBanter);

            await restored.app.setBattleResultIncludeBanter(!includeBanter);
            assert.equal(restored.sent.length, 2, '发送后改变选项仍需用户再次点发送');
            assert.equal((await restored.app.sendBattleResult()).ok, true);
            assert.equal(restored.sent.length, 3);
            record = assertRecord(restored, { combatText: edited, banterText, includeBanter: !includeBanter, sent: true });
            assert.equal(restored.sent[2], record.text);
            assertBanter(restored.sent[2], f.dialogues, !includeBanter);
            assertSaved(restored);
            const refreshed = reopen(restored);
            assert.equal(refreshed.app.restoreBattle(), false);
            assertRecord(refreshed, { combatText: edited, banterText, includeBanter: !includeBanter, sent: true });
            assert.equal(refreshed.app.battleSent, true);
            assert.equal(refreshed.sent.length, 3, '已发送结果恢复后也不能自动重发');
            assert.deepEqual(refreshed.ctx.chat, []);
        });
    }
});
