import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { AppController } from '../src/app.js';
import { Battle } from '../src/combat/engine.js';
import { resolveRecruitment } from '../src/combat/social.js';
import { normalizePowerSystem } from '../src/core/schema.js';
import { generateBanter, evaluateCharm, shouldCheckCharm } from '../src/llm/banter.js';
import { LlmClient } from '../src/llm/client.js';

const request = '放下武器，离开敌方加入我们吧。';
const wavering = {
    intent: 'persuasion', reply: '也许我该重新选择立场。',
    requestToDefect: true, requestEvidence: '离开敌方加入我们',
    wavering: true, waveringEvidence: '也许我该重新选择立场', personaSummary: '重诺，曾受玩家帮助。',
};
const assessment = { eligible: true, dc: 15, charmValue: 10, reason: '昔日恩情令他犹豫。' };
const response = value => ({ ok: true, text: JSON.stringify(value) });
const clone = value => structuredClone(value);

function fixture({ enemies = 2, charm = 80 } = {}) {
    const unit = (id, name, side) => ({
        id, name, side, isUser: side === 'ally',
        attributes: { HP: { current: 37, max: 100 }, MP: { current: 9, max: 40 }, Speed: { current: 10, max: 10 } },
        skills: [{ id: `${id}-skill`, name: '试锋', power: 12, cost: 3, target: 'single', effects: [{ type: 'damage', power: 12 }] }],
        social: { persona: '重诺，曾受玩家帮助。', charm: side === 'ally' && charm !== null ? [{ targetName: '守门人', value: charm, reason: '旧识' }] : [] },
    });
    const system = normalizePowerSystem({ combatants: [unit('player', '旅人', 'ally'), unit('guard', '守门人', 'enemy'),
        ...(enemies > 1 ? [unit('other', '卫兵', 'enemy')] : [])] });
    const battle = new Battle(system, { seed: 'banter-behavior' });
    battle.start();
    const speaker = battle.units.find(u => u.name === '旅人');
    const target = battle.units.find(u => u.name === '守门人');
    battle.turnIndex = battle.initiative.findIndex(entry => entry.unitId === speaker.id);
    const saves = [];
    const ctx = { chat: [{ name: '旁白', mes: '守门人曾得到旅人帮助。', is_user: false }], chatMetadata: {}, extensionSettings: {},
        async saveMetadata() { saves.push(clone(this.chatMetadata)); } };
    const app = new AppController(ctx);
    app.settings.banter.readWorldbook = false;
    app.settings.banter.createMissingPersona = false;
    app.settings.battle.showDice = false;
    app.battle = battle;
    assert.equal(battle.currentUnit, speaker);
    return { app, ctx, battle, speaker, target, saves };
}

// These tests intentionally run serially: restore the shared prototype even on failure.
async function withCompletions(values, run) {
    const original = LlmClient.prototype.complete;
    const calls = [];
    LlmClient.prototype.complete = async function (options) {
        const index = calls.push(options) - 1;
        assert.ok(index < values.length, 'unexpected extra model call');
        return typeof values[index] === 'function' ? values[index](options) : response(values[index]);
    };
    try { return await run(calls); }
    finally { LlmClient.prototype.complete = original; }
}
function position(battle) {
    return { round: battle.round, turnIndex: battle.turnIndex, currentId: battle.currentUnit?.id };
}
function deferred() {
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    return { promise, resolve };
}
function args(f) {
    return { battle: f.battle, speaker: f.speaker, target: f.target, text: request, persona: f.target.social.persona };
}

describe('口嗨与招降实际行为', { concurrency: false }, () => {
    for (const [label, text, reply, expectsOffer = false] of [
        ['普通闲聊', '今天风很大。', { ...wavering, intent: 'banter', reply: '确实如此。', requestToDefect: false, requestEvidence: '', wavering: false, waveringEvidence: '' }],
        ['仅动摇没有请求', '你似乎有心事。', { ...wavering, intent: 'banter', requestToDefect: false, requestEvidence: '' }],
        ['明确请求但坚决拒绝', request, { ...wavering, reply: '绝不背叛！', wavering: false, waveringEvidence: '' }],
        ['真实劝说的请求引用不一致时交模型二次评估', '我会保证你的安全，愿意和我们一道吗？', wavering, true],
        ['NPC引用不一致时交模型二次评估', request, { ...wavering, reply: '绝不背叛！' }, true],
    ]) {
        it(`${label}仅提供回应和条件，不改阵营、资源或推进回合`, async () => {
            const f = fixture();
            const before = clone(f.battle.units);
            const turn = position(f.battle);
            const initiative = clone(f.battle.initiative);
            await withCompletions(expectsOffer ? [reply, assessment] : [reply], async calls => {
                const result = await f.app.sendBanter({ targetId: f.target.id, text });
                assert.equal(result.ok, true, result.error);
                assert.equal(result.reply, reply.reply);
                assert.equal(result.check, undefined);
                assert.equal(Boolean(result.pending), expectsOffer);
                assert.equal(calls.length, expectsOffer ? 2 : 1);
            });
            assert.deepEqual(f.battle.units, before);
            assert.deepEqual(f.battle.initiative, initiative);
            assert.deepEqual(position(f.battle), turn);
            assert.equal(f.battle.banterHistory.length, 2);
            assert.equal(f.battle.log.some(l => l.type === 'banter'), false);
            assert.deepEqual(f.app.data.battle.banterHistory, f.battle.banterHistory);
            assert.equal(f.battle.log.some(l => ['charm', 'defection'].includes(l.type)), false);
            assert.ok(f.saves.length >= 2);
            assert.deepEqual(f.ctx.chat, [{ name: '旁白', mes: '守门人曾得到旅人帮助。', is_user: false }]);
            assert.equal(f.app.busy, false);
        });
    }

    it('口嗨单独保存并供模型续聊，含战斗关键词的台词也不进入结算', async () => {
        const f = fixture();
        const combatLog = clone(f.battle.log);
        const firstText = '刚才的暴击很精彩，但先别谈伤害了。';
        const npcReply = { ...wavering, intent: 'banter', reply: '我想谈的是天气，不是治疗。',
            requestToDefect: false, requestEvidence: '', wavering: false, waveringEvidence: '' };
        await withCompletions([npcReply, npcReply], async calls => {
            assert.equal((await f.app.sendBanter({ targetId: f.target.id, text: firstText })).ok, true);
            const initialTalk = f.battle.banterHistory.map(entry => entry.text);
            assert.equal((await f.app.sendBanter({ targetId: f.target.id, text: '那就聊聊今天的风。' })).ok, true);
            const sentHistory = JSON.parse(calls[1].user).recentBattleTalk;
            assert.deepEqual(sentHistory.slice(0, 2), initialTalk, '后续口嗨应读取已独立保存的对话');
            assert.equal(sentHistory.some(text => combatLog.some(entry => entry.text === text)), false);
        });
        assert.deepEqual(f.battle.log, combatLog, '普通口嗨不增加战斗日志');
        assert.equal(f.battle.banterHistory.length, 4);
        assert.deepEqual(Battle.fromState(f.app.data.battle).banterHistory, f.battle.banterHistory);
        assert.equal(f.app.battleResultText().includes(firstText), false);
        assert.equal(f.app.battleResultText().includes(npcReply.reply), false);
        await f.app.finishBattle();
        assert.equal(f.app.data.battleResult.text.includes(firstText), false);
        assert.equal(f.app.data.battleResult.text.includes(npcReply.reply), false);
    });

    it('旧存档口嗨迁出战斗日志，保留检定和投靠，重复恢复不复制对话', () => {
        const f = fixture();
        const state = f.battle.toState();
        delete state.banterHistory;
        state.log = [
            { i: 0, round: 1, at: 10, type: 'attack', text: '一次命中造成伤害', data: { damage: 5 } },
            { i: 1, round: 1, at: 20, type: 'banter', text: '暴击只是旧口嗨台词', data: { speakerId: f.speaker.id } },
            { i: 2, round: 1, at: 30, type: 'charm', text: '旧魅力检定已成功', data: { total: 20 } },
            { i: 3, round: 1, at: 40, type: 'banter', text: '旧NPC回应', data: { speakerId: f.target.id } },
            { i: 4, round: 1, at: 50, type: 'defection', text: '旧敌人已投靠我方' },
        ];
        const original = clone(state);
        const restored = Battle.fromState(state);
        assert.deepEqual(state, original, '迁移不原地更改输入存档');
        assert.deepEqual(restored.banterHistory.map(entry => entry.text), ['暴击只是旧口嗨台词', '旧NPC回应']);
        assert.deepEqual(restored.log.map(entry => entry.type), ['attack', 'charm', 'defection']);
        assert.deepEqual(restored.log.map(entry => entry.i), [0, 1, 2]);
        assert.deepEqual(restored.banterHistory[0].data, original.log[1].data);
        assert.deepEqual(Battle.fromState(restored.toState()).toState(), restored.toState());
        f.app.battle = restored;
        const summary = f.app.battleResultText();
        assert.doesNotMatch(summary, /旧口嗨台词|旧NPC回应/);
        assert.match(summary, /旧魅力检定已成功/);
        assert.match(summary, /旧敌人已投靠我方/);
    });

    it('引用差异显示警告但不代替模型语义判断，只有存活敌人满足换边入口条件', async () => {
        const f = fixture();
        await withCompletions([wavering, { ...wavering, requestEvidence: '虚构请求' }, { ...wavering, waveringEvidence: '虚构回复' }], async calls => {
            const valid = await generateBanter(f.ctx, f.app.settings, args(f));
            assert.equal(shouldCheckCharm(f.target, valid), true);
            assert.equal(shouldCheckCharm({ ...f.target, side: 'ally' }, valid), false);
            assert.equal(shouldCheckCharm({ ...f.target, alive: false }, valid), false);
            const badRequest = await generateBanter(f.ctx, f.app.settings, args(f));
            assert.equal(badRequest.requestToDefect, true);
            assert.equal(badRequest.wavering, true);
            assert.ok(badRequest.evidenceWarnings.length > 0);
            const badReply = await generateBanter(f.ctx, f.app.settings, args(f));
            assert.equal(badReply.requestToDefect, true);
            assert.equal(badReply.wavering, true);
            assert.ok(badReply.evidenceWarnings.length > 0);
            assert.equal(calls.length, 3);
        });
    });

    it('模型给出条件后需玩家确认；成功转side和initiative，保留HP/MP/skills且不耗行动', async () => {
        const f = fixture();
        const before = clone(f.target);
        const turn = position(f.battle);
        f.app._decisionQueue = { stale: true };
        f.battle.rng.int = (min, max) => { assert.deepEqual([min, max], [1, 20]); return 12; };
        await withCompletions([wavering, assessment], async calls => {
            const result = await f.app.sendBanter({ targetId: f.target.id, text: request });
            assert.equal(result.ok, true, result.error);
            assert.equal(calls.length, 2);
            assert.equal(JSON.parse(calls[1].user).npcReply, wavering.reply);
            assert.equal(JSON.parse(calls[1].user).directedCharm.value, 80);
            assert.equal(result.check, undefined);
            assert.equal(f.target.side, 'enemy');
            assert.equal(result.pending.requiredNatural, 12);
            const rolled = await f.app.rollCharmCheck({ targetId: f.target.id, pendingId: result.pending.id });
            assert.equal(rolled.ok, true, rolled.error);
            assert.deepEqual({ natural: rolled.check.natural, modifier: rolled.check.modifier, total: rolled.check.total, success: rolled.check.success },
                { natural: 12, modifier: 3, total: 15, success: true });
        });
        assert.deepEqual(f.target, { ...before, side: 'ally', isUser: false });
        assert.equal(f.battle.initiative.find(entry => entry.unitId === f.target.id).side, 'ally');
        assert.deepEqual(position(f.battle), turn);
        assert.equal(f.battle.phase, 'awaiting_input');
        assert.equal(f.app._decisionQueue, null);
        assert.equal(f.app.data.battle.units.find(u => u.id === f.target.id).side, 'ally');
        // Defections must survive the rolling dialogue window in the final narrative.
        for (let i = 0; i < 20; i++) f.battle.pushLog('banter', `后续闲聊${i}`);
        const resultText = f.app.battleResultText();
        assert.match(resultText, /守门人接受旅人的劝说，本场战斗从敌方转为我方/);
        assert.match(resultText, /我方 守门人：HP 37\/100.*MP 9\/40/);
        assert.doesNotMatch(resultText, /后续闲聊|他缓缓放低剑尖|战中对话/);
        assert.equal(f.battle.banterHistory.length, 22);
        assert.equal(f.battle.log.some(entry => entry.type === 'banter'), false);
    });

    it('最后敌方被招降后结束战斗，并持久化包含投靠记录的结算快照', async () => {
        const f = fixture({ enemies: 1 });
        f.battle.rng.int = () => 20;
        await withCompletions([wavering, assessment], async calls => {
            const result = await f.app.sendBanter({ targetId: f.target.id, text: request });
            assert.equal(result.ok, true, result.error);
            assert.equal(result.check, undefined);
            assert.notEqual(f.battle.phase, 'finished');
            const rolled = await f.app.rollCharmCheck({ targetId: f.target.id, pendingId: result.pending.id });
            assert.equal(rolled.ok, true, rolled.error);
            assert.equal(rolled.check.success, true);
            assert.equal(calls.length, 2);
        });
        assert.equal(f.battle.phase, 'finished');
        assert.equal(f.battle.winner, 'ally');
        assert.equal(f.app.data.battle.phase, 'finished');
        assert.match(f.app.battleResultSnapshot, /本场战斗从敌方转为我方/);
        assert.match(f.app.data.battleResult.text, /本场战斗从敌方转为我方/);
    });

    for (const [label, natural, charmValue, dc, success] of [
        ['天然1即使总数达标仍失败', 1, 100, 5, false],
        ['天然20即使总数未达标仍成功', 20, 0, 30, true],
        ['普通未达标失败', 8, 50, 15, false],
    ]) {
        it(`本地resolveRecruitment：${label}`, () => {
            const f = fixture();
            const before = clone(f.battle.units);
            const initiative = clone(f.battle.initiative);
            f.battle.rng.int = () => natural;
            const result = resolveRecruitment(f.battle, f.speaker, f.target, { ...assessment, charmValue, dc, modifier: 999 });
            assert.equal(result.success, success);
            assert.equal(result.modifier, Math.floor((charmValue - 50) / 10));
            if (!success) {
                assert.deepEqual(f.battle.units, before);
                assert.deepEqual(f.battle.initiative, initiative);
                assert.equal(f.battle.log.some(l => l.type === 'defection'), false);
            }
        });
    }

    for (const eligible of [true, false]) {
        it(`第二API旧资格标记${eligible}都保留已动摇者的尝试机会；仅确认后掷骰且失败不改阵营`, async () => {
            const f = fixture();
            const before = clone(f.battle.units);
            const turn = position(f.battle);
            let rolls = 0;
            f.battle.rng.int = () => { rolls++; return 1; };
            await withCompletions([wavering, { ...assessment, eligible }], async calls => {
                const result = await f.app.sendBanter({ targetId: f.target.id, text: request });
                assert.equal(result.ok, true, result.error);
                assert.equal(result.check, undefined);
                assert.equal(rolls, 0, '第二API只评估，确认前不能掷骰');
                assert.ok(result.pending, '已有动摇后不能再以额外资格门槛取消玩家尝试机会');
                const rolled = await f.app.rollCharmCheck({ targetId: f.target.id, pendingId: result.pending.id });
                assert.equal(rolled.ok, true, rolled.error);
                assert.equal(rolled.check.success, false);
                assert.equal(calls.length, 2);
            });
            assert.equal(rolls, 1);
            assert.deepEqual(f.battle.units, before);
            assert.deepEqual(position(f.battle), turn);
            assert.equal(f.battle.log.some(l => l.type === 'defection'), false);
        });
    }

    it('evaluateCharm沿用定向魅力；缺失时估算；非法DC拒绝', async () => {
        const f = fixture();
        await withCompletions([assessment, { ...assessment, charmValue: 69 }, { ...assessment, dc: 31 }], async () => {
            const known = await evaluateCharm(f.ctx, f.app.settings, { ...args(f), reply: wavering });
            assert.equal(known.charmValue, 80);
            assert.equal(known.modifier, 3);
            assert.equal(known.estimated, false);
            f.speaker.social.charm = [];
            const estimated = await evaluateCharm(f.ctx, f.app.settings, { ...args(f), reply: wavering });
            assert.equal(estimated.charmValue, 69);
            assert.equal(estimated.modifier, 1);
            assert.equal(estimated.estimated, true);
            await assert.rejects(evaluateCharm(f.ctx, f.app.settings, { ...args(f), reply: wavering }), /难度无效/);
        });
    });

    for (const stage of [1, 2]) {
        for (const interruption of ['取消', '切聊天']) {
            it(`${interruption}拒绝第${stage}次API迟到结果，不掷骰或转换阵营`, async () => {
                const f = fixture();
                const before = clone(f.battle.units);
                const turn = position(f.battle);
                const entered = deferred();
                const late = deferred();
                let rolls = 0;
                f.battle.rng.int = () => { rolls++; return 20; };
                const pendingResponse = options => { entered.resolve(options); return late.promise; };
                await withCompletions(stage === 1 ? [pendingResponse] : [wavering, pendingResponse], async calls => {
                    const pending = f.app.sendBanter({ targetId: f.target.id, text: request });
                    try {
                        const options = await entered.promise;
                        if (interruption === '取消') {
                            assert.equal(f.app.abortRunning(), true);
                            assert.equal(options.signal.aborted, true);
                        } else {
                            f.ctx.chatMetadata = { otherChat: true };
                        }
                    } finally {
                        // Simulate a transport that ignores abort and returns a successful payload.
                        late.resolve(response(stage === 1 ? wavering : assessment));
                    }
                    const result = await pending;
                    assert.equal(result.ok, false);
                    assert.match(result.error, /终止|切换/);
                    assert.equal(calls.length, stage);
                });
                assert.equal(rolls, 0);
                assert.deepEqual(f.battle.units, before);
                assert.deepEqual(position(f.battle), turn);
                assert.equal(f.battle.banterHistory.length, stage);
                assert.equal(f.battle.log.some(l => l.type === 'banter'), false);
                assert.equal(f.battle.log.some(l => ['charm', 'defection'].includes(l.type)), false);
                assert.equal(f.app.busy, false);
                assert.equal(f.app.displayRoll, null);
                if (interruption === '切聊天') assert.deepEqual(f.ctx.chatMetadata, { otherChat: true });
            });
        }
    }
});
