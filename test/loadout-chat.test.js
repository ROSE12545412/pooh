import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { captureLoadoutChatPair, deleteLoadoutChatPair } from '../src/llm/loadout-chat.js';
import { generationChatIdentity } from '../src/llm/generation-wait.js';

function fixture(baseline = 2) {
    const ctx = { chatId: 'chat-a', characterId: 1, groupId: null, chatMetadata: {}, isGenerating: false,
        chat: Array.from({ length: baseline }, (_, i) => ({ mes: `story-${i}`, is_user: false, extra: { stable: true } })) };
    const identity = generationChatIdentity(ctx);
    ctx.chat.push({ is_user: true, mes: 'request' }, { is_user: false, mes: ' report\n' });
    const message = { index: baseline + 1, text: ' report\n' };
    const capture = () => captureLoadoutChatPair(ctx, identity, baseline, 'request', message);
    return { ctx, identity, message, baseline, capture, pair: capture().pair };
}
const erase = (ctx) => async (indices, opts) => {
    assert.deepEqual(opts, { refresh: 'affected' });
    assert.deepEqual(indices, [ctx.chat.length - 1, ctx.chat.length - 2]);
    for (const index of indices) ctx.chat.splice(index, 1);
};

describe('精确捕获润色聊天楼层', () => {
    it('保留逐项引用、未trim的原文及prefix快照，支持空prefix', () => {
        for (const baseline of [0, 2]) {
            const f = fixture(baseline);
            const result = f.capture();
            assert.equal(result.ok, true);
            assert.equal(result.pair.user.reference, f.ctx.chat[baseline]);
            assert.equal(result.pair.assistant.reference, f.ctx.chat[baseline + 1]);
            assert.equal(result.pair.text, ' report\n');
            assert.equal(result.pair.prefix.length, baseline);
            if (baseline) assert.equal(result.pair.prefix[0].reference, f.ctx.chat[0]);
        }
    });
    it('拒绝换聊天、换角色/群组、错误基线、迟到或额外楼层', () => {
        for (const change of [f => { f.ctx.chatId = 'other'; }, f => { f.ctx.characterId++; },
            f => { f.ctx.groupId = 'group'; }, f => { f.ctx.chat.pop(); },
            f => { f.ctx.chat.push({ mes: 'late reply', is_user: false }); }]) {
            const f = fixture(); change(f);
            assert.equal(f.capture().ok, false);
        }
        const f = fixture();
        for (const baseline of [-1, 1.5, NaN, '2']) assert.equal(captureLoadoutChatPair(f.ctx, f.identity, baseline, 'request', f.message).ok, false);
    });
    it('严格核对用户请求和非user非system回复的索引、文本', () => {
        for (const change of [f => { f.ctx.chat[2].is_user = false; }, f => { f.ctx.chat[2].mes += ' '; },
            f => { f.ctx.chat[3].is_user = true; }, f => { f.ctx.chat[3].is_system = true; },
            f => { f.ctx.chat[3].mes = 'report'; }, f => { f.message.index = 2; },
            f => { f.message.text = 'report'; }]) {
            const f = fixture(); change(f); assert.equal(f.capture().ok, false);
        }
    });
});

describe('保守删除润色请求与报告', () => {
    it('手机无helper时优先原生接口，倒序逐楼删除、禁用级联并立即保存', async () => {
        const f = fixture(); const calls = []; let saves = 0;
        f.ctx.deleteMessage = async function (...args) {
            assert.equal(this.chatId, 'chat-a');
            calls.push(args); this.chat.splice(args[0], 1);
        };
        f.ctx.saveChat = async () => { saves++; assert.equal(f.ctx.chat.length, 2); };
        const helper = { deleteChatMessages() { assert.fail('native must win'); } };
        assert.equal((await deleteLoadoutChatPair(() => ({ ...f.ctx }), f.pair, { helper })).ok, true);
        assert.deepEqual(calls, [[3, undefined, false, false], [2, undefined, false, false]]);
        assert.equal(saves, 1);
        assert.deepEqual(f.ctx.chat.map(x => x.mes), ['story-0', 'story-1']);
    });
    it('原生第一步后换聊天、新消息、生成、取消、文本变化或无实际删除时停止，不回落helper', async () => {
        for (const change of [f => { f.ctx.chatId = 'other'; }, f => { f.ctx.chat.push({ mes: 'late' }); },
            f => { f.ctx.isGenerating = true; }, f => { f.abort.abort(); },
            f => { f.ctx.chat[0].mes = 'edited'; }, f => { f.ctx.chat[2].mes = 'edited request'; }]) {
            const f = fixture(); f.abort = new AbortController(); let calls = 0;
            f.ctx.deleteMessage = async index => { calls++; f.ctx.chat.splice(index, 1); change(f); };
            const helper = { deleteChatMessages() { assert.fail('never fall back'); } };
            assert.equal((await deleteLoadoutChatPair(() => f.ctx, f.pair, { helper, signal: f.abort.signal })).ok, false);
            assert.equal(calls, 1);
        }
        for (const result of [undefined, false, { ok: false }]) {
            const f = fixture(); let calls = 0;
            f.ctx.deleteMessage = async () => { calls++; return result; };
            assert.equal((await deleteLoadoutChatPair(() => f.ctx, f.pair, { helper: null })).ok, false);
            assert.equal(calls, 1); assert.equal(f.ctx.chat.length, 4);
        }
    });
    it('原生保存失败不重新删除；保存期间换聊天也报告失败', async () => {
        for (const save of [async () => false, async () => { throw Error('save failed'); },
            async f => { f.ctx.chatId = 'other'; }]) {
            const f = fixture(); let calls = 0;
            f.ctx.deleteMessage = async index => { calls++; f.ctx.chat.splice(index, 1); };
            f.ctx.saveChat = () => save(f);
            assert.equal((await deleteLoadoutChatPair(() => f.ctx, f.pair, { helper: null })).ok, false);
            assert.equal(calls, 2); assert.equal(f.ctx.chat.length, 2);
        }
    });
    it('优先helper，精确传索引及refresh，保留全部原剧情', async () => {
        const f = fixture();
        const prefix = f.ctx.chat.slice(0, 2);
        f.ctx.deleteChatMessages = () => { throw Error('must not call fallback'); };
        const helper = { deleteChatMessages: erase(f.ctx) };
        assert.deepEqual(await deleteLoadoutChatPair(() => f.ctx, f.pair, { helper }), { ok: true, error: null });
        assert.deepEqual(f.ctx.chat, prefix);
        assert.equal(f.ctx.chat[0], prefix[0]);
    });
    it('没有helper时使用ctx相同接口；没有接口时不调用未经验证slash', async () => {
        const f = fixture(); f.ctx.deleteChatMessages = erase(f.ctx);
        assert.equal((await deleteLoadoutChatPair(() => f.ctx, f.pair, { helper: null })).ok, true);
        const missing = fixture();
        missing.ctx.executeSlashCommands = () => { throw Error('unverified slash must not run'); };
        const result = await deleteLoadoutChatPair(() => missing.ctx, missing.pair, { helper: null });
        assert.equal(result.ok, false); assert.match(result.error, /没有精确删除接口/);
        assert.equal(missing.ctx.chat.length, 4);
    });
    it('宿主重建消息或补写元数据不阻断删除，原生两步间刷新也兼容', async () => {
        const f = fixture();
        f.ctx.chat = structuredClone(f.ctx.chat);
        for (const message of f.ctx.chat) { message.extra = { token_count: 42 }; message.gen_finished = 'later'; }
        const calls = [];
        f.ctx.deleteMessage = async index => {
            calls.push(index); f.ctx.chat.splice(index, 1);
            f.ctx.chat = structuredClone(f.ctx.chat);
            for (const message of f.ctx.chat) message.extra.rendered = true;
        };
        assert.equal((await deleteLoadoutChatPair(() => f.ctx, f.pair, { helper: null })).ok, true);
        assert.deepEqual(calls, [3, 2]);
        assert.deepEqual(f.ctx.chat.map(x => x.mes), ['story-0', 'story-1']);
    });
    it('删除前阻止换聊天、新楼层、原剧情或请求报告正文和身份改动', async () => {
        for (const change of [f => { f.ctx.chatId = 'other'; }, f => { f.ctx.chat.push({ mes: 'late' }); },
            f => { f.ctx.chat.pop(); },
            f => { f.ctx.chat[0].mes = 'edited'; }, f => { f.ctx.chat[0].is_user = true; },
            f => { f.ctx.chat[2].name = 'someone else'; }, f => { f.ctx.chat[2].mes = 'edited'; },
            f => { f.ctx.chat[3].swipe_id = 1; }, f => { f.ctx.chat[3].mes = 'edited'; },
            f => { f.ctx.chat[3].is_system = true; }]) {
            const f = fixture(); let called = 0; change(f);
            assert.equal((await deleteLoadoutChatPair(() => f.ctx, f.pair, { helper: { deleteChatMessages() { called++; } } })).ok, false);
            assert.equal(called, 0);
        }
    });
    it('生成状态true或已取消时不删；未知活动状态允许已经wait完成的精确pair', async () => {
        for (const helperActive of [false, true]) {
            const f = fixture(); let called = 0;
            if (!helperActive) f.ctx.isGenerating = true;
            const helper = { builtin: { duringGenerating: () => helperActive ? true : undefined }, deleteChatMessages() { called++; } };
            assert.equal((await deleteLoadoutChatPair(() => f.ctx, f.pair, { helper })).ok, false); assert.equal(called, 0);
        }
        const f = fixture(); const abort = new AbortController(); abort.abort();
        assert.equal((await deleteLoadoutChatPair(() => f.ctx, f.pair, { signal: abort.signal, helper: { deleteChatMessages() { assert.fail(); } } })).ok, false);
        delete f.ctx.isGenerating;
        assert.equal((await deleteLoadoutChatPair(() => f.ctx, f.pair, { helper: { deleteChatMessages: erase(f.ctx) } })).ok, true);
    });
    it('删除接口抛错、拒绝或无实际删除时不尝试另种方式', async () => {
        for (const implementation of [() => { throw Error('host failed'); }, () => false, () => ({ ok: false }), () => undefined]) {
            const f = fixture(); let calls = 0;
            f.ctx.deleteChatMessages = () => { assert.fail('never retry'); };
            f.ctx.executeSlashCommands = () => { assert.fail('never retry'); };
            const result = await deleteLoadoutChatPair(() => f.ctx, f.pair, { helper: { deleteChatMessages() { calls++; return implementation(); } } });
            assert.equal(result.ok, false); assert.equal(calls, 1); assert.equal(f.ctx.chat.length, 4);
        }
    });
    it('等待删除期间换聊天、出现迟到新消息、原楼改变或误删均判失败', async () => {
        for (const change of [f => { f.ctx.chatId = 'other'; }, f => { f.ctx.chat.push({ mes: 'late' }); },
            f => { f.ctx.chat[0].mes = 'edited'; }, f => { f.ctx.chat[0].name = 'another speaker'; },
            f => { f.ctx.chat.shift(); }]) {
            const f = fixture(); let release;
            const pending = deleteLoadoutChatPair(() => f.ctx, f.pair, { helper: { deleteChatMessages: () => new Promise(resolve => { release = resolve; }) } });
            f.ctx.chat = f.ctx.chat.slice(0, 2); change(f); release();
            assert.equal((await pending).ok, false);
        }
    });
    it('宿主每次返回新context快照时仍使用最新ctx删除接口', async () => {
        const f = fixture();
        f.ctx.deleteChatMessages = erase(f.ctx);
        assert.equal((await deleteLoadoutChatPair(() => ({ ...f.ctx }), f.pair, { helper: null })).ok, true);
    });
    it('最新context已开始生成时拒绝删除，第二次活动读取改变聊天也拒绝', async () => {
        const f = fixture(); let called = 0, reads = 0;
        const getContext = () => ({ ...f.ctx, isGenerating: ++reads > 1,
            deleteChatMessages() { called++; } });
        assert.equal((await deleteLoadoutChatPair(getContext, f.pair, { helper: null })).ok, false);
        assert.equal(called, 0);
        const other = fixture(); let activityReads = 0;
        const helper = { builtin: { duringGenerating() {
            if (++activityReads === 2) other.ctx.chat.push({ mes: 'new message', is_user: true });
            return false;
        } }, deleteChatMessages() { called++; } };
        assert.equal((await deleteLoadoutChatPair(() => other.ctx, other.pair, { helper })).ok, false);
        assert.equal(called, 0);
    });
    it('活动读取产生换聊天或新消息的时序在调用删除前再次挡住', async () => {
        const f = fixture(); let called = 0;
        const helper = { builtin: { duringGenerating() { f.ctx.chat.push({ mes: 'late' }); return false; } }, deleteChatMessages() { called++; } };
        assert.equal((await deleteLoadoutChatPair(() => f.ctx, f.pair, { helper })).ok, false);
        assert.equal(called, 0);
    });
});
