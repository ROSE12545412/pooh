import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { AppController } from '../src/app.js';

function fixture({ parseOk = true, afterCapture, noApi = false, saveFails = false } = {}) {
    const original = { mes: '原剧情必须保留', is_user: false };
    const ctx = { name1: '玩家', name2: '任意卡', chatId: 'scene-chat', chat: [original],
        chatMetadata: {}, extensionSettings: {}, isGenerating: false,
        async saveMetadata() { if (saveFails) throw new Error('scene persistence failed'); events.push('save'); } };
    const events = [];
    const app = new AppController(ctx);
    ctx.chatMetadata['tavern-dice'] = app.data;
    const deleted = [];
    let request;
    let resolveWait;
    app.writeToInput = text => { request = text; return true; };
    app.waitForGeneration = (_timeout, { deferred }) => {
        assert.equal(deferred, true);
        let armed = false;
        let settled = false;
        const promise = new Promise(resolve => { resolveWait = resolve; });
        app._sceneGenerationWait = { arm() { armed = true; }, get settled() { return settled; },
            cancel(value) { settled = true; resolveWait(value); } };
        app.clickSend = () => {
            assert.equal(armed, true);
            ctx.chat.push({ mes: request, is_user: true }, { mes: '本次正文开战报告', is_user: false });
            resolveWait({ ok: true, message: { index: 2, text: ctx.chat[2].mes } });
            return true;
        };
        return promise;
    };
    app.startBattleFromSituation = async opts => {
        assert.equal(opts.skipRead, true);
        assert.equal(app.battleSituation.report, '本次正文开战报告');
        assert.equal(ctx.chat.length, 3, '成功前不删楼');
        events.push('start');
        if (afterCapture) await afterCapture(ctx, app);
        return parseOk ? { ok: true, count: 2 } : { ok: false, error: '无法解析场景' };
    };
    if (!noApi) ctx.deleteChatMessages = async (ids, options) => {
        assert.deepEqual(options, { refresh: 'affected' });
        assert.ok(events.includes('start') && events.includes('save'), '只有启动及持久化后才能删除');
        deleted.push(ids);
        events.push('delete');
        for (const i of [...ids].sort((a, b) => b - a)) ctx.chat.splice(i, 1);
    };
    return { app, ctx, original, deleted, events, request: () => request };
}

describe('正文开战成功后安全清理本次两楼', () => {
    it('手机无助手使用ctx原生deleteMessage倒序清理，再保存聊天', async () => {
        const f = fixture({ noApi: true }); const nativeCalls = []; let saved = false;
        f.ctx.deleteMessage = async (id, swipe, confirm, cascade) => {
            assert.equal(swipe, undefined); assert.equal(confirm, false); assert.equal(cascade, false);
            assert.ok(f.events.includes('start') && f.events.includes('save'));
            nativeCalls.push(id); f.ctx.chat.splice(id, 1);
        };
        f.ctx.saveChat = async () => { saved = true; assert.deepEqual(f.ctx.chat, [f.original]); };
        const result = await f.app.startBattleByScene();
        assert.equal(result.cleaned, true); assert.deepEqual(nativeCalls, [2, 1]); assert.equal(saved, true);
        assert.deepEqual(f.ctx.chat, [f.original]);
    });
    it('捕获发送前baseline和准确正文，启动并持久化后只清理本次双楼', async () => {
        const f = fixture();
        const result = await f.app.startBattleByScene({ seed: 'scene-clean', situation: '玩家面对对手' });
        assert.deepEqual(result, { ok: true, count: 2, cleaned: true });
        assert.deepEqual(f.deleted, [[2, 1]]);
        assert.deepEqual(f.ctx.chat, [f.original]);
        assert.deepEqual(f.events, ['start', 'save', 'delete']);
        assert.ok(f.request().includes('玩家面对对手'));
    });
    it('解析或启动失败保留请求与回复并明确提示', async () => {
        const f = fixture({ parseOk: false });
        const result = await f.app.startBattleByScene();
        assert.equal(result.ok, false);
        assert.equal(result.cleaned, false);
        assert.match(result.warning, /开战未成功/);
        assert.equal(f.ctx.chat.length, 3);
        assert.deepEqual(f.deleted, []);
        assert.deepEqual(f.events, ['start']);
    });
    for (const mode of ['append', 'report', 'prefix', 'chat', 'no-api', 'save']) {
        it(`成功后 ${mode} 不危险清理，明确warning且保留两楼`, async () => {
            const f = fixture({ noApi: mode === 'no-api', saveFails: mode === 'save',
                afterCapture: (ctx) => {
                    if (mode === 'append') ctx.chat.push({ mes: '迟到消息', is_user: false });
                    if (mode === 'report') ctx.chat[2].mes += '被编辑';
                    if (mode === 'prefix') ctx.chat[0].mes += '被编辑';
                    if (mode === 'chat') ctx.chatId = 'other-chat';
                } });
            const result = await f.app.startBattleByScene();
            assert.equal(result.ok, true);
            assert.equal(result.cleaned, false);
            assert.match(result.warning, /未清理开战两楼/);
            if (mode === 'save') assert.match(result.warning, /未能落盘/);
            assert.ok(f.ctx.chat.length >= 3);
            assert.deepEqual(f.deleted, []);
        });
    }
    it('生成期间多出的楼层导致capture失败，不猜测清理，但仍可启动战斗', async () => {
        const f = fixture();
        const wait = f.app.waitForGeneration;
        f.app.waitForGeneration = (...args) => {
            const promise = wait(...args);
            const send = f.app.clickSend;
            f.app.clickSend = () => { const ok = send(); f.ctx.chat.push({ mes: '额外楼层', is_user: false }); return ok; };
            return promise;
        };
        f.app.startBattleFromSituation = async () => ({ ok: true, count: 2 });
        const result = await f.app.startBattleByScene();
        assert.equal(result.ok, true);
        assert.equal(result.cleaned, false);
        assert.match(result.warning, /楼层数量不匹配/);
        assert.equal(f.ctx.chat.length, 4);
        assert.deepEqual(f.deleted, []);
    });
});
