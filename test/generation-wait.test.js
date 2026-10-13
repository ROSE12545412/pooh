import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { createGenerationWait, readGenerationActivity } from '../src/llm/generation-wait.js';
import { AppController } from '../src/app.js';
import { defaultSettings, EXT_ID } from '../src/config.js';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function bounded(promise, ms = 2500) {
    let timer;
    try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('等待器没有按时收尾')), ms); })]); }
    finally { clearTimeout(timer); }
}

function monitor(t, options = {}) {
    let ctx = { chatId: 'scene-a', characterId: 0, chatMetadata: {}, chat: [{ is_user: false, mes: '旧正文，不能拿来开战' }] };
    let activity = true;
    const controller = new AbortController();
    const waiter = createGenerationWait({
        getContext: () => ctx, readActivity: () => activity, signal: controller.signal,
        timeoutMs: 1000, pollMs: 5, settleMs: 20, emptyGraceMs: 45, ...options,
    });
    let done = false;
    waiter.promise.then(() => { done = true; });
    t.after(() => waiter.cancel({ ok: false, aborted: true }));
    return {
        waiter, controller, get done() { return done; }, get ctx() { return ctx; },
        setActivity(value) { activity = value; }, setContext(value) { ctx = value; },
        reply(text = '新的完整战斗场景') { ctx.chat.push({ is_user: false, mes: text }); },
    };
}

describe('正文场景生成等待', () => {
    it('没有 GENERATION_ENDED，可靠空闲状态与新回复也能完成', async t => {
        const m = monitor(t);
        m.reply();
        m.setActivity(false);
        const result = await bounded(m.waiter.promise);
        assert.equal(result.ok, true);
        assert.equal(result.via, 'generation-state');
        assert.deepEqual(result.message, { index: 1, text: '新的完整战斗场景' });
    });

    it('流式正文暂停写字时仍等宿主停止，不解析半段', async t => {
        const m = monitor(t);
        m.reply('半段正文');
        await delay(65);
        assert.equal(m.done, false);
        m.ctx.chat.at(-1).mes += '，随后还有敌方与技能';
        m.setActivity(false);
        const result = await bounded(m.waiter.promise);
        assert.equal(result.message.text, '半段正文，随后还有敌方与技能');
    });

    it('结束事件先于宿主清理时，继续等待真实状态变空闲', async t => {
        const m = monitor(t);
        m.reply();
        m.waiter.notifyEnded();
        await delay(65);
        assert.equal(m.done, false);
        m.setActivity(false);
        assert.equal((await bounded(m.waiter.promise)).ok, true);
    });

    it('未知状态与静止文本不算结束，明确结束事件才能解除等待', async t => {
        const m = monitor(t);
        m.setActivity(null);
        m.reply();
        await delay(65);
        assert.equal(m.done, false);
        m.waiter.notifyEnded();
        assert.equal((await bounded(m.waiter.promise)).ok, true);
    });

    it('结束事件先到、消息随后写入时读取最终新回复', async t => {
        const m = monitor(t, { emptyGraceMs: 120 });
        m.setActivity(null);
        m.waiter.notifyEnded();
        await delay(15);
        m.reply();
        assert.equal((await bounded(m.waiter.promise)).message.text, '新的完整战斗场景');
    });

    it('旧正文和用户楼层不能冒充本次回复，失败后清理等待', async t => {
        const m = monitor(t);
        m.setActivity(false);
        m.ctx.chat.push({ is_user: true, mes: '请生成战斗场景' });
        m.waiter.notifyEnded();
        const result = await bounded(m.waiter.promise);
        assert.equal(result.ok, false);
        assert.match(result.error, /本次新的 AI 回复/);
        assert.equal(m.waiter.settled, true);
    });

    it('发送前的结束事件和回复不触发新场景', async t => {
        const m = monitor(t, { deferred: true });
        m.reply('发送之前其它请求的回复');
        m.waiter.notifyEnded();
        m.setActivity(false);
        m.waiter.arm();
        await delay(65);
        assert.equal(m.done, false);
        m.reply('属于本次发送的回复');
        assert.equal((await bounded(m.waiter.promise)).message.text, '属于本次发送的回复');
    });

    it('切换聊天后取消，迟到回复和结束事件不会重新成功', async t => {
        const m = monitor(t);
        m.setContext({ ...m.ctx, chatId: 'scene-b', chat: [{ is_user: false, mes: '另一聊天的正文' }] });
        const result = await bounded(m.waiter.promise);
        assert.equal(result.chatChanged, true);
        assert.equal(result.ok, false);
        m.reply(); m.setActivity(false); m.waiter.notifyEnded();
        assert.equal(await m.waiter.promise, result);
    });

    it('中断、停止、超时均不返回半段回复', async t => {
        const aborted = monitor(t); aborted.reply(); aborted.controller.abort();
        assert.equal((await bounded(aborted.waiter.promise)).aborted, true);
        const stopped = monitor(t); stopped.reply(); stopped.waiter.notifyStopped();
        assert.equal((await bounded(stopped.waiter.promise)).aborted, true);
        const timed = monitor(t, { timeoutMs: 40 }); timed.reply();
        const result = await bounded(timed.waiter.promise);
        assert.equal(result.timedOut, true);
        assert.equal(result.message, undefined);
    });

    it('优先读取助手实时状态，缺失或异常状态不误判为空闲', () => {
        const noDom = { helper: undefined, document: undefined, view: {} };
        assert.equal(readGenerationActivity({ streamingProcessor: null }, noDom), null);
        assert.equal(readGenerationActivity({ isGenerating: 'false' }, noDom), null);
        const helper = { builtin: { duringGenerating: () => true } };
        assert.equal(readGenerationActivity({ streamingProcessor: { isFinished: true } }, { ...noDom, helper }), true);
        helper.builtin.duringGenerating = () => false;
        assert.equal(readGenerationActivity({ streamingProcessor: { isFinished: false } }, { ...noDom, helper }), false);
        helper.builtin.duringGenerating = () => { throw new Error('不可用'); };
        assert.equal(readGenerationActivity({}, { ...noDom, helper }), null);
        assert.equal(readGenerationActivity({ isGenerating: false }, noDom), false);
    });

    it('DOM 回退同时检查停止按钮和可用发送按钮，隐藏页面不冒充空闲', () => {
        const stop = { hidden: false, style: { display: 'none' }, getClientRects: () => [{}] };
        const send = { hidden: false, disabled: false, style: { display: 'block' }, getClientRects: () => [{}] };
        const options = {
            helper: {}, view: { getComputedStyle: element => element.style },
            document: { getElementById: id => id === 'mes_stop' ? stop : id === 'send_but' ? send : null },
        };
        assert.equal(readGenerationActivity({}, options), false);
        send.disabled = true;
        assert.equal(readGenerationActivity({}, options), null);
        send.disabled = false; send.style.display = 'none';
        assert.equal(readGenerationActivity({}, options), null);
        send.style.display = 'block'; send.getClientRects = () => [];
        assert.equal(readGenerationActivity({}, options), null);
        stop.style.display = 'block';
        assert.equal(readGenerationActivity({}, options), true);
    });

    it('替换等待后旧 signal 和事件不会结束新的等待', async t => {
        const ctx = { chatId: 'fixture', chat: [], chatMetadata: {}, extensionSettings: { [EXT_ID]: defaultSettings() } };
        const app = new AppController(ctx);
        const old = new AbortController(); app._abort = old;
        const first = app.waitForGeneration();
        const current = new AbortController(); app._abort = current;
        const second = app.waitForGeneration();
        t.after(() => app._resolveGenerationWait?.(false));
        assert.equal((await bounded(first)).aborted, true);
        old.abort();
        assert.ok(app._sceneGenerationWait);
        assert.equal(app._sceneGenerationWait.settled, false);
        current.abort();
        assert.equal((await bounded(second)).aborted, true);
        assert.equal(app._sceneGenerationWait, null);
        assert.equal(app._resolveGenerationWait, null);
    });
});

const SCENE = `## 参战人员名单
### 参战
**【玩家】玩家**（参与切磋的人）｜我方
**对手**（参与切磋的人）｜敌方
### 观战
- 无
## 参战双方
### 我方
**【玩家】玩家**（参与切磋的人）
- 位阶：常人
- 人设：熟悉训练规则，谨慎出招。
- 血量：100%
- 魔量：100%
- 技能：
  - 试探｜伤害｜40｜0｜普通攻击
- 武器与装备：练习武器
- 临时属性：无
### 敌方
**对手**（参与切磋的人）
- 位阶：常人
- 人设：遵守切磋规则。
- 血量：100%
- 魔量：100%
- 技能：
  - 试探｜伤害｜40｜0｜普通攻击
- 武器与装备：练习武器
- 临时属性：无
## 战斗模式
切磋`;

function controllerFixture(t) {
    let generating = false;
    let ctx = { name1: '玩家', name2: '测试卡', chatId: 'controller-a', characterId: 0, chat: [{ is_user: false, mes: '旧回复' }], chatMetadata: {}, extensionSettings: { [EXT_ID]: defaultSettings() }, saveSettingsDebounced() {}, async saveMetadata() {} };
    const originalHost = globalThis.SillyTavern;
    const originalHelper = globalThis.TavernHelper;
    globalThis.SillyTavern = { getContext: () => ctx };
    globalThis.TavernHelper = { builtin: { duringGenerating: () => generating } };
    const app = new AppController(ctx);
    app._maybeContinueAutoDrive = () => {};
    app.writeToInput = () => true;
    t.after(() => {
        app.cancelSceneGeneration(); app._resolveGenerationWait?.(false);
        globalThis.SillyTavern = originalHost; globalThis.TavernHelper = originalHelper;
    });
    return { app, get ctx() { return ctx; }, setContext(value) { ctx = value; }, setGenerating(value) { generating = value; } };
}

describe('开战控制器完整时序', () => {
    it('正文已写完但漏结束事件，仍真正解析新场景并开战', async t => {
        const f = controllerFixture(t);
        f.app.clickSend = () => {
            f.ctx.chat.push({ is_user: true, mes: '场景指令' }, { is_user: false, mes: SCENE });
            return true;
        };
        const result = await bounded(f.app.startBattleByScene({ seed: 'scene-wait' }));
        assert.equal(result.ok, true, result.error);
        assert.equal(f.app.battleSituation.report, SCENE);
        assert.equal(f.app.battle.units.length, 2);
        assert.deepEqual(f.app.battle.units.map(u => u.name).sort(), ['对手', '玩家']);
        assert.equal(f.app.busy, false);
        assert.equal(f.app.progress.active, false);
        assert.equal(f.app._sceneGenerationWait, null);
    });

    it('发送前中断阻止点击，并拒绝双击重复开战', async t => {
        const f = controllerFixture(t);
        let clicks = 0; f.app.clickSend = () => { clicks++; return true; };
        const task = f.app.startBattleByScene();
        assert.equal(f.app.busy, true);
        assert.equal((await f.app.startBattleByScene()).error, '正在忙');
        f.app.abortRunning();
        assert.equal((await bounded(task)).aborted, true);
        assert.equal(clicks, 0);
        assert.equal(f.app.busy, false);
        assert.equal(f.app._abort, null);
        assert.equal(f.app._sceneGenerationWait, null);
    });

    it('助手独立任务的停止事件不取消正文，主正文停止则不进入解析', async t => {
        const f = controllerFixture(t);
        f.app.clickSend = () => {
            f.setGenerating(true);
            f.ctx.chat.push({ is_user: false, mes: '半段正文' });
            return true;
        };
        const task = f.app.startBattleByScene();
        await delay(150);
        f.app._notifyGenerationStopped('helper-independent-request');
        assert.equal(f.app._sceneGenerationWait.settled, false);
        f.app._notifyGenerationStopped();
        assert.equal((await bounded(task)).aborted, true);
        assert.equal(f.app.battleSituation, null);
        assert.equal(f.app.battle, null);
        assert.equal(f.app.busy, false);
    });

    it('切聊天时取消旧开战，不能向新聊天写场景或战斗', async t => {
        const f = controllerFixture(t);
        f.app.clickSend = () => { f.setGenerating(true); return true; };
        const task = f.app.startBattleByScene();
        await delay(150);
        f.setContext({ ...f.ctx, chatId: 'controller-b', chat: [{ is_user: false, mes: SCENE }], chatMetadata: {} });
        f.app.cancelSceneGeneration();
        f.setGenerating(false);
        f.app._notifyGenerationEnded();
        assert.equal((await bounded(task)).aborted, true);
        assert.equal(f.app.battleSituation, null);
        assert.deepEqual(f.ctx.chatMetadata, {});
        assert.equal(f.app.busy, false);
    });

    it('手动发送、缺输入框或缺发送按钮时均清掉控制器和忙碌状态', async t => {
        const f = controllerFixture(t);
        let clicks = 0; f.app.clickSend = () => { clicks++; return false; };
        assert.equal((await f.app.startBattleByScene({ autoSend: false })).needsManualSend, true);
        assert.equal(clicks, 0);
        assert.equal(f.app._abort, null);
        f.app.writeToInput = () => false;
        assert.match((await f.app.startBattleByScene()).error, /输入框/);
        f.app.writeToInput = () => true;
        assert.match((await bounded(f.app.startBattleByScene())).error, /发送按钮/);
        await Promise.resolve();
        assert.equal(f.app.busy, false);
        assert.equal(f.app.progress.active, false);
        assert.equal(f.app._abort, null);
        assert.equal(f.app._sceneGenerationWait, null);
    });
});
