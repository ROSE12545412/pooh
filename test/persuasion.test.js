import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { AppController } from '../src/app.js';
import { Battle } from '../src/combat/engine.js';
import { normalizePowerSystem } from '../src/core/schema.js';
import { LlmClient } from '../src/llm/client.js';
import { charmOdds, recordPersuasion } from '../src/combat/persuasion.js';
import { resolveRecruitment } from '../src/combat/social.js';

const talk = { intent: 'persuasion', reply: '我愿意考虑和你一起行动，再说说你的打算。', requestToDefect: true,
    requestEvidence: '这回站我这边', wavering: true, waveringEvidence: '愿意考虑和你一起行动', personaSummary: '关心同伴，仍有顾虑。',
    goal: '本场换到说服者一侧协助', progress: 35, summary: '愿意考虑，但还想确认接下来的打算。', reason: '承认了既有情谊，仍有顾虑。' };
const assessment = { eligible: true, dc: 15, charmValue: 80, reason: '已有35点累计动摇，顾虑尚在。' };
const answer = value => ({ ok: true, text: JSON.stringify(value) });
const clone = value => structuredClone(value);

function fixture() {
    const units = [['player', '旅行者', 'ally', true], ['friend', '同伴', 'ally', false], ['npc', '守卫', 'enemy', false], ['other', '同行者', 'enemy', false]]
        .map(([id, name, side, isUser]) => ({ id, name, side, isUser,
            attributes: { HP: { current: 30, max: 100 }, MP: { current: 12, max: 40 }, Speed: { current: 10, max: 10 } },
            social: { persona: '重视亲近的人，也有自己的承诺。', charm: isUser ? [{ targetName: '守卫', value: 80, reason: '既有信任' }] : [] } }));
    const battle = new Battle(normalizePowerSystem({ combatants: units }), { seed: 'cumulative-persuasion', combatMode: 'spar' });
    battle.start();
    const speaker = battle.units.find(unit => unit.id === 'player');
    const target = battle.units.find(unit => unit.id === 'npc');
    battle.turnIndex = battle.initiative.findIndex(entry => entry.unitId === speaker.id);
    const saves = [];
    const ctx = { chat: [{ is_user: false, mes: '参战双方之间也有亲情和信任。' }], chatMetadata: {}, extensionSettings: {},
        async saveMetadata() { saves.push(clone(this.chatMetadata)); } };
    const app = new AppController(ctx);
    app.battle = battle;
    app.settings.banter.readWorldbook = false;
    app.settings.banter.createMissingPersona = false;
    app.settings.battle.showDice = false;
    return { battle, speaker, target, app, ctx, saves };
}
async function withReplies(values, run) {
    const original = LlmClient.prototype.complete;
    const calls = [];
    LlmClient.prototype.complete = async options => {
        const value = values[calls.length];
        calls.push(options);
        assert.ok(value, '不能多调用API');
        return answer(value);
    };
    try { await run(calls); } finally { LlmClient.prototype.complete = original; }
}
async function offer(f, values = [talk, assessment]) {
    let result;
    await withReplies(values, async () => { result = await f.app.sendBanter({ targetId: f.target.id, text: '这回站我这边，好不好？' }); });
    assert.equal(result.ok, true, result.error);
    return result.pending;
}
function latch() {
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    return { resolve, promise };
}

describe('累计说服与玩家确认的完整流程', { concurrency: false }, () => {
    it('友方、自己、非敌方、倒下与已换边目标都不能发送说服，也不调用API或写记录', async () => {
        for (const kind of ['friend', 'player', 'neutral', 'fallen', 'recruited']) {
            const f = fixture();
            const target = f.battle.units.find(unit => unit.id === kind) ?? f.target;
            if (kind === 'neutral') target.side = 'neutral';
            if (kind === 'fallen') target.alive = false;
            if (kind === 'recruited') target.side = 'ally';
            const before = f.battle.toState();
            await withReplies([], async calls => {
                const result = await f.app.sendBanter({ targetId: target.id, text: '这回站我这边，好不好？' });
                assert.equal(result.ok, false, kind);
                assert.match(result.error, /存活的敌方/);
                assert.equal(calls.length, 0, kind);
            });
            assert.deepEqual(f.battle.toState(), before, kind);
            assert.equal(f.saves.length, 0, kind);
            assert.equal(f.app.busy, false, kind);
        }
    });
    it('等待回复期间目标换到我方时，不接受迟到回复或形成检定', async () => {
        const f = fixture();
        const original = LlmClient.prototype.complete;
        const started = latch();
        const response = latch();
        const rng = f.battle.rng.snapshot();
        let calls = 0;
        LlmClient.prototype.complete = async () => { calls++; started.resolve(); return response.promise; };
        try {
            const sending = f.app.sendBanter({ targetId: f.target.id, text: '这回站我这边，好不好？' });
            await started.promise;
            f.target.side = 'ally';
            response.resolve(answer(talk));
            const result = await sending;
            assert.equal(result.ok, false);
            assert.match(result.error, /目标已不是存活的敌方角色/);
            assert.equal(calls, 1);
            assert.equal(f.battle.banterHistory.length, 1, '只保留已经发送的玩家台词');
            assert.equal(f.app.getPersuasion(f.target.id), null);
            assert.equal(f.app.getCharmPreview(f.target.id), null);
            assert.deepEqual(f.battle.rng.snapshot(), rng);
            assert.equal(f.app.busy, false);
        } finally {
            response.resolve(answer(talk));
            LlmClient.prototype.complete = original;
        }
    });
    it('两次API只形成待确认条件；预览DC15、加成3、至少12点和45%，不消耗随机数', async () => {
        const f = fixture();
        const rng = f.battle.rng.snapshot();
        const units = clone(f.battle.units);
        const turn = f.battle.turnIndex;
        const pending = await offer(f);
        assert.deepEqual(f.battle.rng.snapshot(), rng);
        assert.deepEqual(f.battle.units, units);
        assert.equal(f.battle.turnIndex, turn);
        assert.equal(f.battle.log.some(entry => ['charm', 'defection'].includes(entry.type)), false);
        assert.deepEqual([pending.dc, pending.modifier, pending.requiredNatural, pending.successChance], [15, 3, 12, 0.45]);
        assert.equal(f.app.displayRoll, null);
        assert.equal(f.app.getPersuasion(f.target.id).progress, 35);
        assert.equal(f.app.data.battle.persuasion[0].pending.id, pending.id);
        assert.equal(f.ctx.chat.length, 1, '不能写聊天楼层');
    });

    it('暂缓后刷新仍保留条件与进度；被识别为继续劝说时即使模型报0也不能清空旧进展', async () => {
        const f = fixture();
        const pending = await offer(f);
        const rng = f.battle.rng.snapshot();
        assert.equal((await f.app.deferCharmCheck({ targetId: f.target.id, pendingId: pending.id })).ok, true);
        assert.equal(f.app.getCharmPreview(f.target.id).deferred, true);
        assert.deepEqual(f.battle.rng.snapshot(), rng);
        const restored = new AppController(f.ctx);
        assert.equal(restored.restoreBattle(), true);
        assert.equal(restored.getPersuasion(f.target.id).progress, 35);
        assert.equal(restored.getCharmPreview(f.target.id).id, pending.id);
        assert.equal(restored.getCharmPreview(f.target.id).deferred, true);
        await withReplies([{ ...talk, reply: '我还在考虑你刚才的提议。', requestToDefect: false, requestEvidence: '', wavering: false,
            waveringEvidence: '', goal: '', progress: 0, summary: '' }, { ...assessment, dc: 13 }], async calls => {
            const result = await restored.sendBanter({ targetId: f.target.id, text: '你担心什么？' });
            assert.equal(result.ok, true, result.error);
            assert.equal(calls.length, 2, '不必每句重新邀请，沿用已建立的说服目标');
            const sent = JSON.parse(calls[0].user);
            assert.equal(sent.persuasion.progress, 35);
            assert.equal(sent.persuasion.goal, talk.goal);
            assert.equal(sent.persuasion.milestones.length, 1);
            assert.equal(restored.getPersuasion(f.target.id).progress, 35);
            assert.equal(result.pending.requiredNatural, 10);
            assert.notEqual(result.pending.id, pending.id, '新一轮条件使旧按钮失效');
            assert.equal((await restored.rollCharmCheck({ targetId: f.target.id, pendingId: pending.id })).ok, false);
            assert.deepEqual(restored.battle.rng.snapshot(), rng);
        });
    });

    for (const [intent, text] of [
        ['banter', '这风吹得人睁不开眼。'],
        ['taunt', '你也不过如此，等着瞧！'],
        [undefined, '再接我下一招。'],
        ['unknown', '看来今天挺热闹。'],
    ]) {
        it(`本次意图为${String(intent)}时仅回复对白，真假劝说字段和高进度都不能启动评估`, async () => {
            const f = fixture();
            const before = clone(f.battle.units);
            const rng = f.battle.rng.snapshot();
            const turn = f.battle.turnIndex;
            const chat = clone(f.ctx.chat);
            await withReplies([{ ...talk, intent, reply: '那就继续吧。', progress: 99,
                summary: '不应写入的新记忆', reason: '不应成为检定依据' }], async calls => {
                const result = await f.app.sendBanter({ targetId: f.target.id, text });
                assert.equal(result.ok, true, result.error);
                assert.equal(result.reply, '那就继续吧。');
                assert.equal(result.intent, intent === 'taunt' ? 'taunt' : 'banter');
                assert.equal(result.pending, null);
                assert.equal(result.persuasion, null);
                assert.equal(calls.length, 1, '只调用回应模型，不调用条件模型');
            });
            assert.equal(f.app.getPersuasion(f.target.id), null);
            assert.equal(f.app.getCharmPreview(f.target.id), null);
            assert.equal(f.battle.banterHistory.length, 2);
            assert.equal(f.battle.banterHistory[1].data.intent, intent === 'taunt' ? 'taunt' : 'banter');
            assert.equal(f.battle.log.some(entry => ['charm', 'defection'].includes(entry.type)), false);
            assert.equal(f.battle.turnIndex, turn);
            assert.deepEqual(f.battle.units, before);
            assert.deepEqual(f.battle.rng.snapshot(), rng);
            assert.deepEqual(f.ctx.chat, chat);
            assert.equal(f.app.displayRoll, null);
        });
    }

    for (const intent of ['banter', 'taunt']) {
        it(`已有动摇后${intent}不会重算条件或改记忆，隐藏旧检定且刷新后仍保留后台进展`, async () => {
            const f = fixture();
            const pending = await offer(f);
            const saved = f.app.getPersuasion(f.target.id);
            const rng = f.battle.rng.snapshot();
            const units = clone(f.battle.units);
            const turn = f.battle.turnIndex;
            await withReplies([{ ...talk, intent, reply: '我听见了。', progress: 100,
                goal: '不应替换的后台目标', summary: '不应覆盖的记忆', reason: '不应写入的分析' }], async calls => {
                const result = await f.app.sendBanter({ targetId: f.target.id, text: '你这嘴还挺硬。' });
                assert.equal(result.ok, true, result.error);
                assert.equal(calls.length, 1);
                assert.equal(JSON.parse(calls[0].user).persuasion.progress, saved.progress);
                assert.deepEqual(result.persuasion, saved);
                assert.equal(result.pending, null, '旧目标不能将本次调味对白判为劝说');
            });
            assert.deepEqual(f.app.getPersuasion(f.target.id), saved);
            assert.equal(f.app.getCharmPreview(f.target.id), null);
            assert.equal((await f.app.rollCharmCheck({ targetId: f.target.id, pendingId: pending.id })).ok, false);
            assert.deepEqual(f.battle.units, units);
            assert.equal(f.battle.turnIndex, turn);
            assert.deepEqual(f.battle.rng.snapshot(), rng);
            const restored = new AppController(f.ctx);
            assert.equal(restored.restoreBattle(), true);
            assert.deepEqual(restored.getPersuasion(f.target.id), saved);
            assert.equal(restored.getCharmPreview(f.target.id), null);
            await withReplies([{ ...talk, progress: 50, summary: '回答了对方的具体顾虑。' }, { ...assessment, dc: 13 }], async calls => {
                const result = await restored.sendBanter({ targetId: f.target.id, text: '你担心的安全问题，我可以保证。' });
                assert.equal(result.ok, true, result.error);
                assert.equal(calls.length, 2, '本次被识别为真实继续劝说才重新评估');
                assert.equal(JSON.parse(calls[0].user).persuasion.progress, 35, '后台读取保留的旧进展');
                assert.equal(result.persuasion.progress, 50);
                assert.equal(result.persuasion.revision, saved.revision + 1, '普通口嗨不增加说服修订次数');
                assert.notEqual(result.pending.id, pending.id);
                assert.equal(result.pending.dc, 13);
            });
            assert.deepEqual(restored.battle.rng.snapshot(), rng);
        });
    }

    it('记忆和模型分析仅后台保存，确认后可见日志、骰子和结算也不夹带分析', async () => {
        const f = fixture();
        const memory = '后台记忆专用标记';
        const reason = '后台评估专用标记';
        const goal = '后台目标专用标记';
        let pending;
        await withReplies([{ ...talk, summary: memory, goal }, { ...assessment, reason }], async () => {
            const result = await f.app.sendBanter({ targetId: f.target.id, text: '这回站我这边，好不好？' });
            assert.equal(result.ok, true, result.error);
            pending = result.pending;
        });
        f.battle.rng.int = () => 20;
        const rolled = await f.app.rollCharmCheck({ targetId: f.target.id, pendingId: pending.id });
        assert.equal(rolled.ok, true, rolled.error);
        assert.equal(rolled.check.success, true);
        assert.equal(rolled.check.reason, reason, '内部机械记录仍可复查评估');
        assert.equal(f.app.getPersuasion(f.target.id).summary, memory);
        const visible = [
            ...f.battle.log.map(entry => entry.text),
            ...f.battle.banterHistory.map(entry => entry.text),
            JSON.stringify(f.app.displayRoll),
            f.app.battleResultText({ includeBanter: true }),
        ].join('\n');
        for (const marker of [memory, reason, goal]) assert.equal(visible.includes(marker), false, marker);
        assert.ok(visible.includes(talk.reply));
        assert.ok(visible.includes('本场战斗从敌方转为我方'));
    });

    it('直接状态合并也保留旧进度与记忆，新动摇由模型给出而非消息次数累加', () => {
        const f = fixture();
        const initial = recordPersuasion(f.battle, f.speaker, f.target, talk);
        const initialSummary = initial.summary;
        for (let i = 0; i < 5; i++) recordPersuasion(f.battle, f.speaker, f.target, { ...talk, progress: 0, summary: '忘记旧事了' });
        assert.equal(initial.progress, 35);
        assert.equal(initial.summary, initialSummary);
        assert.equal(initial.milestones.length, 1);
        recordPersuasion(f.battle, f.speaker, f.target, { ...talk, progress: 62, summary: '新的顾虑已得到回答' });
        assert.equal(initial.progress, 62);
        assert.equal(initial.milestones.length, 2);
    });

    it('进度按说服者与目标分别保存，不能拿另一人的关系或旧按钮掷骰', async () => {
        const f = fixture();
        const pending = await offer(f);
        assert.equal(f.app.getPersuasion('other'), null);
        assert.equal(f.app.getCharmPreview('other'), null);
        assert.equal((await f.app.rollCharmCheck({ targetId: 'other', pendingId: pending.id })).ok, false);
        f.speaker.isUser = false;
        const friend = f.battle.units.find(unit => unit.id === 'friend');
        friend.isUser = true;
        f.battle.turnIndex = f.battle.initiative.findIndex(entry => entry.unitId === friend.id);
        assert.equal(f.app.getPersuasion(f.target.id), null);
        assert.equal((await f.app.rollCharmCheck({ targetId: f.target.id, pendingId: pending.id })).ok, false);
        assert.equal(f.battle.persuasion[0].progress, 35);
    });

    it('确认仅掷一次，失败保留进度；后续模型收到失败记录与尝试次数', async () => {
        const f = fixture();
        const pending = await offer(f);
        let rolls = 0;
        f.battle.rng.int = () => { rolls++; return 1; };
        const result = await f.app.rollCharmCheck({ targetId: f.target.id, pendingId: pending.id });
        assert.equal(result.ok, true, result.error);
        assert.equal(result.check.success, false);
        const state = f.app.getPersuasion(f.target.id);
        assert.equal(state.progress, 35);
        assert.equal(state.attempts, 1);
        assert.equal(state.lastRoll.natural, 1);
        assert.equal(state.status, 'failed');
        assert.equal(f.app.getCharmPreview(f.target.id), null);
        assert.equal((await f.app.rollCharmCheck({ targetId: f.target.id, pendingId: pending.id })).ok, false);
        assert.equal(rolls, 1);
        await withReplies([{ ...talk, progress: 60 }, { ...assessment, dc: 11 }], async calls => {
            const next = await f.app.sendBanter({ targetId: f.target.id, text: '再想想我们的约定。' });
            assert.equal(next.ok, true, next.error);
            assert.equal(JSON.parse(calls[0].user).persuasion.attempts, 1);
            assert.equal(JSON.parse(calls[0].user).persuasion.lastRoll.success, false);
            assert.equal(f.app.getPersuasion(f.target.id).progress, 60);
            assert.equal(rolls, 1, '新条件仍需重新确认');
        });
    });

    it('完全动摇也先问玩家；明确确认后才改本场阵营且写入真实记录', async () => {
        const f = fixture();
        const pending = await offer(f, [{ ...talk, progress: 100, reply: '好，这场我愿意站到你这边。' }, { ...assessment, dc: 5 }]);
        assert.equal(f.target.side, 'enemy');
        assert.equal(pending.progress, 100);
        assert.equal(pending.requiredNatural, 2);
        assert.equal(pending.successChance, 0.95);
        f.battle.rng.int = () => 12;
        f.app._decisionQueue = { stale: true };
        const result = await f.app.rollCharmCheck({ targetId: f.target.id, pendingId: pending.id });
        assert.equal(result.ok, true, result.error);
        assert.equal(f.target.side, 'ally');
        assert.equal(f.target.isUser, false);
        assert.equal(f.target.attributes.HP.current, 30);
        assert.equal(f.app._decisionQueue, null);
        assert.equal(f.app.getPersuasion(f.target.id).progress, 100);
        assert.equal(f.app.getCharmPreview(f.target.id), null);
        assert.match(f.app.battleResultText(), /本场战斗从敌方转为我方/);
        assert.doesNotMatch(f.app.battleResultText(), /背叛亲人|永久转投/);
        assert.equal(f.ctx.chat.length, 1);
    });

    for (const interruption of ['取消', '切聊天', '离开玩家回合']) {
        it(`确认动画期间${interruption}不接受迟到结算，重复点击也不多掷`, async () => {
            const f = fixture();
            const pending = await offer(f);
            const before = f.battle.rng.snapshot();
            const entered = latch();
            f.app.settings.battle.showDice = true;
            f.app.settings.battle.diceMinDuration = 40;
            f.app.diceRoller = { roll() { entered.resolve(); }, hide() {}, settle() {} };
            const operation = f.app.rollCharmCheck({ targetId: f.target.id, pendingId: pending.id });
            await entered.promise;
            assert.equal((await f.app.rollCharmCheck({ targetId: f.target.id, pendingId: pending.id })).ok, false);
            if (interruption === '取消') f.app.abortRunning();
            else if (interruption === '切聊天') f.ctx.chatMetadata = { otherChat: true };
            else f.battle.turnIndex = f.battle.initiative.findIndex(entry => entry.unitId === f.target.id);
            const result = await operation;
            assert.equal(result.ok, false);
            assert.deepEqual(f.battle.rng.snapshot(), before);
            assert.equal(f.target.side, 'enemy');
            assert.equal(f.app.getPersuasion(f.target.id).progress, 35);
            assert.equal(f.app.getPersuasion(f.target.id).pending.id, pending.id);
            assert.equal(f.app.busy, false);
            if (interruption === '切聊天') assert.deepEqual(f.ctx.chatMetadata, { otherChat: true });
        });
    }

    it('已有动摇就展示合法骰点；第二次模型的旧资格标记不能取消玩家尝试机会', async () => {
        const f = fixture();
        const before = f.battle.rng.snapshot();
        const pending = await offer(f, [talk, { ...assessment, eligible: false, reason: '已有动摇，尚未满足的条件仍构成阻力。' }]);
        assert.equal(pending.requiredNatural, 12);
        assert.equal(f.app.getPersuasion(f.target.id).progress, 35);
        assert.equal(f.app.getPersuasion(f.target.id).status, 'ready');
        assert.match(f.app.getPersuasion(f.target.id).reason, /尚未满足/);
        assert.deepEqual(f.battle.rng.snapshot(), before);
    });

    it('评估缺少真实骰点时明确失败并保留动摇，不凭空生成难度或偷偷掷骰', async () => {
        const f = fixture();
        const before = f.battle.rng.snapshot();
        await withReplies([talk, { eligible: false, reason: '响应缺少难度。' }], async () => {
            const result = await f.app.sendBanter({ targetId: f.target.id, text: '这回站我这边。' });
            assert.equal(result.ok, false);
            assert.match(result.error, /难度无效/);
        });
        assert.equal(f.app.getCharmPreview(f.target.id), null);
        assert.equal(f.app.getPersuasion(f.target.id).progress, 35);
        assert.equal(f.app.getPersuasion(f.target.id).status, 'error');
        assert.deepEqual(f.battle.rng.snapshot(), before);
    });

    it('旧存档无说服字段照常恢复，不猜测旧台词中的进度', () => {
        const f = fixture();
        const saved = f.battle.toState();
        delete saved.persuasion;
        const restored = Battle.fromState(saved);
        assert.deepEqual(restored.persuasion, []);
        assert.equal(restored.currentUnit.name, f.speaker.name);
    });
});

describe('魅力预览与本地骰子的概率一致', () => {
    for (const [dc, charmValue] of [[15, 80], [5, 100], [30, 0], [15, 40], [20, 50]]) {
        it(`DC${dc}、魅力${charmValue}的所需点数和概率包含天然1/20例外`, () => {
            const successes = [];
            for (let natural = 1; natural <= 20; natural++) {
                const f = fixture();
                f.battle.rng.int = () => natural;
                if (resolveRecruitment(f.battle, f.speaker, f.target, { ...assessment, dc, charmValue }).success) successes.push(natural);
            }
            const odds = charmOdds({ dc, charmValue, modifier: 999 });
            assert.equal(odds.requiredNatural, successes[0]);
            assert.equal(odds.successChance, successes.length / 20);
            assert.equal(odds.natural20Only, successes.length === 1);
        });
    }
});
