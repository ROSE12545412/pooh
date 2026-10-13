import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { AppController } from '../src/app.js';
import { LlmClient } from '../src/llm/client.js';
import { generationChatIdentity } from '../src/llm/generation-wait.js';

const system = { systemName: 'A战况', combatants: [
    { id: 'p', name: '玩家', side: 'ally', attributes: { HP: 100 } },
    { id: 'e', name: '敌人', side: 'enemy', attributes: { HP: 100 } },
] };
function deferred() {
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    return { promise, resolve };
}
function fixture() {
    const context = id => ({ chatId: id, name1: '玩家', name2: id, chat: [{ mes: `${id}剧情`, is_user: false }],
        chatMetadata: {}, extensionSettings: {}, async saveMetadata() {}, saveSettingsDebounced() {} });
    const a = context('A'), b = context('B');
    const app = new AppController(a);
    a.chatMetadata['tavern-dice'] = app.data;
    const oldHost = globalThis.SillyTavern;
    globalThis.SillyTavern = { getContext: () => app.ctx };
    app.settings.battle.narrativeChannel = 'p2';
    app.settings.p2.channel.mode = 'custom';
    return { app, a, b, switchChat() { app.cancelSceneGeneration(); app.ctx = b; app.battle = null; },
        restore() { globalThis.SillyTavern = oldHost; } };
}
function report(app, ctx = app.ctx) {
    app.battleSituation = { report: '非结构化战况，需要模型提取', situation: '', identity: generationChatIdentity(ctx) };
}

describe('开战异步聊天隔离', () => {
    for (const cancelOnly of [false, true]) it(`${cancelOnly ? '用户取消' : '切聊天'}后结构化迟到结果不写表或开战`, async () => {
        const f = fixture();
        const response = deferred();
        report(f.app);
        f.app._structureViaModel = () => response.promise;
        try {
            const pending = f.app.startBattleFromSituation({ skipRead: true });
            const oldController = f.app._abort;
            if (cancelOnly) f.app.abortRunning(); else f.switchChat();
            assert.equal(oldController.signal.aborted, true);
            response.resolve({ ok: true, system });
            assert.equal((await pending).ok, false);
            assert.equal(f.app.powerSystem, null);
            assert.equal(f.app.battle, null);
        } finally { f.restore(); }
    });

    it('旧结构化 finally 不清新聊天任务 busy/abort/progress', async () => {
        const f = fixture(), old = deferred(), next = deferred();
        report(f.app);
        f.app._structureViaModel = () => old.promise;
        const complete = LlmClient.prototype.complete;
        try {
            const pending = f.app.startBattleFromSituation({ skipRead: true });
            f.switchChat();
            assert.equal(f.app.busy, false);
            LlmClient.prototype.complete = () => next.promise;
            const newPending = f.app.readBattleSituation();
            const newController = f.app._abort;
            old.resolve({ ok: true, system });
            assert.equal((await pending).ok, false);
            assert.equal(f.app.busy, true);
            assert.equal(f.app._abort, newController);
            assert.equal(newController.signal.aborted, false);
            assert.equal(f.app.progress.kind, '读取战况');
            next.resolve({ ok: true, text: 'B的最新战况' });
            assert.equal((await newPending).ok, true);
            assert.equal(f.app.battleSituation.report, 'B的最新战况');
        } finally { LlmClient.prototype.complete = complete; f.restore(); }
    });

    for (const cancelOnly of [false, true]) it(`读取期间${cancelOnly ? '取消' : '切聊天'}，迟到汇报不能污染状态`, async () => {
        const f = fixture(), response = deferred();
        const complete = LlmClient.prototype.complete;
        try {
            LlmClient.prototype.complete = () => response.promise;
            const pending = f.app.readBattleSituation();
            if (cancelOnly) f.app.abortRunning(); else f.switchChat();
            response.resolve({ ok: true, text: 'A的迟到战况' });
            assert.equal((await pending).ok, false);
            assert.equal(f.app.battleSituation, null);
            assert.equal(f.app.busy, false);
            assert.equal(f.app.progress.active, false);
        } finally { LlmClient.prototype.complete = complete; f.restore(); }
    });

    it('没有CHAT_CHANGED事件也不能复用A报告到B', async () => {
        const f = fixture();
        report(f.app);
        let reads = 0, structures = 0;
        f.app.readBattleSituation = async () => { reads++; return { ok: false, error: 'B无新报告' }; };
        f.app._structureViaModel = async () => { structures++; return { ok: true, system }; };
        try {
            f.app.ctx = f.b;
            assert.equal((await f.app.startBattleFromSituation({ skipRead: true })).ok, false);
            assert.equal(reads, 1);
            assert.equal(structures, 0);
            assert.equal(f.app.battleSituation, null);
        } finally { f.restore(); }
    });

    it('保存A表期间切聊天不能清B战斗或在B保存旧战斗', async () => {
        const f = fixture(), saved = deferred();
        report(f.app);
        f.a.saveMetadata = () => saved.promise;
        f.app._structureViaModel = async () => ({ ok: true, system });
        const sentinel = { id: 'B-battle' };
        try {
            const pending = f.app.startBattleFromSituation({ skipRead: true });
            // 结构化返回后进入 setPowerSystem 的 metadata 保存。
            await Promise.resolve(); await Promise.resolve();
            assert.ok(f.a.chatMetadata['tavern-dice'].powerSystem);
            f.switchChat(); f.app.battle = sentinel;
            saved.resolve();
            assert.equal((await pending).ok, false);
            assert.equal(f.app.battle, sentinel);
            assert.equal(f.b.chatMetadata['tavern-dice'], undefined);
        } finally { f.restore(); }
    });
});
