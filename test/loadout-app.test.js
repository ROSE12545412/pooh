import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { AppController } from '../src/app.js';
import { LlmClient } from '../src/llm/client.js';
import { normalizePowerSystem } from '../src/core/schema.js';
import { effectiveStats } from '../src/combat/engine.js';

function fixture(save = () => {}) {
    const ctx = { name1: '玩家', name2: '任意角色卡', chat: [{ mes: '玩家持剑面对试炼对手', is_user: false }],
        chatMetadata: {}, extensionSettings: {}, saveSettingsDebounced: save, async saveMetadata() {} };
    const app = new AppController(ctx);
    ctx.chatMetadata['tavern-dice'] = app.data;
    app.data.powerSystem = normalizePowerSystem({ combatants: [
        { id: 'p', name: '玩家', isUser: true, side: 'ally', attributeBasis: 'base', attributes: { HP: 100, MP: 30, Atk: 10 },
            equipment: [{ name: '剧情剑', slot: 'weapon', bonuses: { Atk: 3 } }] },
        { id: 'e', name: '对手', side: 'enemy', attributes: { HP: 100 } },
    ] });
    app.settings.p2.channel = { ...app.settings.p2.channel, mode: 'custom', loadoutTest: true };
    app.testChat = { input: '', sendCount: 0, deleted: [], writeOk: true, sendOk: true };
    app.writeToInput = text => { app.testChat.input = text; return app.testChat.writeOk; };
    let resolveGeneration;
    app.waitForGeneration = (_timeout, { deferred }) => {
        assert.equal(deferred, true);
        let armed = false;
        let settled = false;
        const promise = new Promise(resolve => { resolveGeneration = resolve; });
        app._sceneGenerationWait = {
            arm() { armed = true; },
            get settled() { return settled; },
            cancel(result) { settled = true; resolveGeneration(result); },
        };
        app.testChat.isArmed = () => armed;
        return promise;
    };
    app.clickSend = () => {
        assert.equal(app.testChat.isArmed(), true);
        app.testChat.sendCount++;
        if (!app.testChat.sendOk) return false;
        ctx.chat.push({ mes: app.testChat.input, is_user: true });
        const report = '正文已结合世界观、主角实力润色：攻击精准，防守略弱，武器攻击 +5，攻击优势、防御劣势。';
        ctx.chat.push({ mes: report, is_user: false });
        resolveGeneration({ ok: true, message: { index: ctx.chat.length - 1, text: report } });
        return true;
    };
    ctx.deleteChatMessages = async (ids, options) => {
        assert.deepEqual(options, { refresh: 'affected' });
        app.testChat.deleted.push([...ids]);
        for (const id of [...ids].sort((a, b) => b - a)) ctx.chat.splice(id, 1);
    };
    return app;
}
const rule = (name) => ({ name, description: '可靠攻击，但防守略弱', slot: 'weapon', bonuses: { Atk: 5 },
    checks: { attack: 'advantage', defense: 'disadvantage' } });
async function withModel(mock, task) {
    const old = LlmClient.prototype.complete;
    LlmClient.prototype.complete = mock;
    try { return await task(); } finally { LlmClient.prototype.complete = old; }
}
const response = (entries) => ({ ok: true, text: JSON.stringify({ entries: entries.map(entry => ({ id: entry.id, revision: entry.revision,
    rule: rule(entry.name), pros: ['攻击稳定'], cons: ['防御劣势'], balanceNote: '按当前玩家实力适配' })) }) });

describe('自定义库控制器与开战集成', () => {
    it('新增、正文回填、携带只影响未来战斗；再次开战不叠加，取消勾选恢复正文', async () => {
        let saves = 0;
        const app = fixture(() => saves++);
        const raw = structuredClone(app.powerSystem);
        const added = await app.saveLoadout({ kind: 'weapon', name: '自定义剑', description: '剑更精准，防守变弱' });
        assert.equal(added.ok, true);
        assert.equal((await app.setLoadoutEnabled(added.id, true)).ok, false);
        const story = [...app.ctx.chat];
        await withModel(async function ({ user }) {
            assert.equal(this.config.mode, 'custom');
            assert.equal(this.config.loadoutTest, true, '必须使用配置的 P2，不是正文 main');
            assert.ok(user.includes('已经完成的正文报告'));
            assert.equal(app.ctx.chat.length, 3, 'P2 回收前已经实际发送并收到正文两楼');
            return response(app.loadoutEntries);
        }, async () => {
            const refined = await app.refineLoadout(added.id);
            assert.equal(refined.ok, true);
            assert.equal(refined.cleaned, true);
        });
        assert.deepEqual(app.ctx.chat, story);
        assert.deepEqual(app.testChat.deleted, [[2, 1]]);
        assert.equal(app.testChat.sendCount, 1);
        assert.ok(app.testChat.input.includes(added.id));
        assert.equal(app.loadoutEntries[0].enabled, false);
        assert.equal((await app.setLoadoutEnabled(added.id, true)).ok, true);
        assert.equal((await app.startBattle({ seed: 'library' })).ok, true);
        assert.equal(effectiveStats(app.battle.units.find(u => u.isUser)).Atk, 15);
        assert.deepEqual(app.powerSystem, raw);
        const running = app.battle.toState();
        await app.setLoadoutEnabled(added.id, false);
        assert.deepEqual(app.battle.toState(), running);
        await app.startBattle({ seed: 'library' });
        assert.equal(effectiveStats(app.battle.units.find(u => u.isUser)).Atk, 13);
        await app.setLoadoutEnabled(added.id, true);
        await app.startBattle({ seed: 'library' });
        assert.equal(effectiveStats(app.battle.units.find(u => u.isUser)).Atk, 15);
        assert.ok(saves >= 5);
        await app.saveLoadout({ id: added.id, kind: 'weapon', name: '自定义剑', description: '新构思' });
        assert.equal(app.loadoutEntries[0].rule, null);
        await app.deleteLoadout(added.id);
        assert.equal(app.loadoutEntries.length, 0);
    });

    it('最后勾选者优先，其他同槽位条目虽保留勾选但不重复叠加', async () => {
        const app = fixture();
        for (const name of ['甲剑', '乙剑']) {
            const { id } = await app.saveLoadout({ kind: 'weapon', name, description: '锋利但不适合防御' });
            await withModel(async () => response(app.loadoutEntries.filter(entry => entry.id === id)), async () => {
                assert.equal((await app.refineLoadout(id)).ok, true);
            });
            await app.setLoadoutEnabled(id, true);
        }
        const firstId = app.loadoutEntries.find(e => e.name === '甲剑').id;
        await app.setLoadoutEnabled(firstId, true);
        await app.startBattle({ seed: 'priority' });
        const equipment = app.battle.units.find(u => u.isUser).equipment;
        assert.equal(equipment.length, 1);
        assert.equal(equipment[0].name, '甲剑');
    });

    it('取消或请求期间编辑条目后迟到结果不回填', async () => {
        for (const cancel of [true, false]) {
            const app = fixture();
            const { id } = await app.saveLoadout({ kind: 'weapon', name: '自定义剑', description: '初稿' });
            const original = [...app.loadoutEntries];
            let release, markStarted;
            const started = new Promise(resolve => { markStarted = resolve; });
            await withModel(() => new Promise(resolve => { release = resolve; markStarted(); }), async () => {
                const pending = app.refineLoadout(id);
                await started;
                if (cancel) app._abort.abort();
                else await app.saveLoadout({ id, kind: 'weapon', name: '自定义剑', description: '更新后的构思' });
                release(response(original));
                assert.equal((await pending).ok, false);
            });
            assert.equal(app.ctx.chat.length, 3, '取消或版本过期应保留正文两楼');
            assert.deepEqual(app.testChat.deleted, []);
            assert.equal(app.loadoutEntries[0].rule, null);
            assert.equal(app.busy, false);
        }
    });

    it('多选整批回填后只删除本次双楼，不改变携带或既有聊天', async () => {
        const app = fixture();
        const ids = [];
        for (const name of ['甲剑', '乙剑']) ids.push((await app.saveLoadout({ kind: 'weapon', name, description: '更精准但防守弱' })).id);
        const before = [...app.ctx.chat];
        await withModel(async () => response([...app.loadoutEntries].reverse()), async () => {
            assert.deepEqual(await app.refineLoadout(ids), { ok: true, count: 2, cleaned: true });
        });
        assert.ok(app.loadoutEntries.every(entry => entry.rule && !entry.enabled));
        assert.deepEqual(app.ctx.chat, before);
        assert.deepEqual(app.testChat.deleted, [[2, 1]]);
        assert.equal(app.testChat.sendCount, 1);
    });

    it('批次内任一规则无效、缺失或版本迟到都不得部分回填，失败保留两楼', async () => {
        for (const failure of ['invalid', 'missing', 'stale']) {
            const app = fixture();
            const ids = [];
            for (const name of ['甲剑', '乙剑']) ids.push((await app.saveLoadout({ kind: 'weapon', name, description: '批次构思' })).id);
            const original = [...app.loadoutEntries];
            await withModel(async () => {
                const result = response(original);
                const parsed = JSON.parse(result.text);
                if (failure === 'invalid') parsed.entries[1].rule.bonuses = { HP: 5 };
                if (failure === 'missing') parsed.entries.pop();
                if (failure === 'stale') await app.saveLoadout({ id: ids[1], kind: 'weapon', name: '乙剑', description: '新版构思' });
                return { ok: true, text: JSON.stringify(parsed) };
            }, async () => { assert.equal((await app.refineLoadout(ids)).ok, false); });
            assert.ok(app.loadoutEntries.every(entry => entry.rule === null), failure);
            assert.equal(app.ctx.chat.length, 3, failure);
            assert.deepEqual(app.testChat.deleted, [], failure);
            assert.equal(app.busy, false);
        }
    });

    it('P2 调用失败或保存失败保留正文两楼，输入或发送失败不调用 P2', async () => {
        for (const failure of ['p2', 'persist', 'write', 'send']) {
            let failSave = false;
            const app = fixture(() => { if (failSave) throw new Error('save failure'); });
            const { id } = await app.saveLoadout({ kind: 'weapon', name: '测试剑', description: '有代价的加值' });
            if (failure === 'persist') failSave = true;
            app.testChat.writeOk = failure !== 'write';
            app.testChat.sendOk = failure !== 'send';
            let calls = 0;
            await withModel(async () => {
                calls++;
                return failure === 'p2' ? { ok: false, error: 'P2 unavailable' } : response(app.loadoutEntries);
            }, async () => { assert.equal((await app.refineLoadout(id)).ok, false, failure); });
            assert.equal(calls, ['write', 'send'].includes(failure) ? 0 : 1, failure);
            assert.equal(app.ctx.chat.length, ['write', 'send'].includes(failure) ? 1 : 3, failure);
            assert.deepEqual(app.testChat.deleted, [], failure);
            assert.equal(app.busy, false);
        }
    });

    it('正文等待超时或捕获到额外楼层时不调用 P2 或删除聊天', async () => {
        for (const failure of ['timeout', 'extra']) {
            const app = fixture();
            const { id } = await app.saveLoadout({ kind: 'weapon', name: '等待剑', description: '攻击加值但防守弱' });
            if (failure === 'timeout') {
                app.waitForGeneration = () => {
                    app._sceneGenerationWait = { arm() {}, settled: false, cancel() {} };
                    return Promise.resolve({ ok: false, timedOut: true });
                };
                app.clickSend = () => { app.ctx.chat.push({ mes: app.testChat.input, is_user: true }); return true; };
            } else {
                const send = app.clickSend;
                app.clickSend = () => { const sent = send(); app.ctx.chat.push({ mes: '并发用户消息', is_user: true }); return sent; };
            }
            await withModel(async () => { assert.fail('正文未安全完成前不能调用 P2'); }, async () => {
                assert.equal((await app.refineLoadout(id)).ok, false);
            });
            assert.equal(app.loadoutEntries[0].rule, null);
            assert.equal(app.ctx.chat.length, failure === 'timeout' ? 2 : 4);
            assert.deepEqual(app.testChat.deleted, []);
            assert.equal(app.busy, false);
        }
    });

    it('P2 等待期间聊天被修改或切换时不危险删除，规则已保存时报告清理警告', async () => {
        for (const changed of ['append', 'mutate', 'prefix', 'switch', 'no-api', 'delete-failed']) {
            const app = fixture();
            const { id } = await app.saveLoadout({ kind: 'weapon', name: '安全剑', description: '攻击精准、防守弱' });
            await withModel(async () => {
                if (changed === 'append') app.ctx.chat.push({ mes: '新的用户发言', is_user: true });
                if (changed === 'mutate') app.ctx.chat[1].mes += '\n后来修改';
                if (changed === 'prefix') app.ctx.chat[0].mes += '剧情被编辑';
                if (changed === 'switch') app.ctx.chatMetadata = {};
                if (changed === 'no-api') delete app.ctx.deleteChatMessages;
                if (changed === 'delete-failed') app.ctx.deleteChatMessages = async () => false;
                return response(app.loadoutEntries);
            }, async () => {
                const result = await app.refineLoadout(id);
                if (changed === 'switch') {
                    assert.equal(result.ok, false);
                    assert.equal(app.loadoutEntries[0].rule, null);
                } else {
                    assert.equal(result.ok, true);
                    assert.equal(result.cleaned, false);
                    assert.match(result.warning, /未清理/);
                    assert.ok(app.loadoutEntries[0].rule);
                }
            });
            assert.deepEqual(app.testChat.deleted, [], changed);
            assert.ok(app.ctx.chat.length >= 3);
        }
    });

    it('宿主保存失败不得伪报已经持久化成功', async () => {
        const app = fixture(() => { throw new Error('storage unavailable'); });
        const result = await app.saveLoadout({ kind: 'weapon', name: '剑', description: '简单构思' });
        assert.equal(result.ok, false);
        assert.match(result.error, /未能落盘/);
        assert.equal(app.loadoutEntries.length, 1, '保留本次会话构思供重试');
    });
});
