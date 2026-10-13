import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { AppController } from '../src/app.js';

async function fixture(options, task) {
    const keys = ['document', 'jQuery', '$', 'TavernHelper', 'SillyTavern'];
    const previous = new Map(keys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
    let clicks = 0;
    let forbidden = 0;
    const input = { value: '原先输入', events: [], dispatchEvent(event) { this.events.push(event.type); } };
    const button = { disabled: options.disabled === true, getAttribute: () => options.ariaDisabled ? 'true' : null,
        click() { clicks++; } };
    const reject = () => { forbidden++; throw new Error('不得调用只添加楼层或命令传输'); };
    const ctx = { chat: [], chatMetadata: {}, extensionSettings: {}, isGenerating: options.generating === true,
        executeSlashCommands: reject, sendMessageAsUser: reject, async saveMetadata() {} };
    try {
        for (const key of keys) delete globalThis[key];
        globalThis.document = { getElementById(id) {
            return id === 'send_textarea' ? (options.noInput ? null : input)
                : id === 'send_but' ? (options.noButton ? null : button) : null;
        } };
        globalThis.TavernHelper = { executeSlashCommands: reject, sendMessageAsUser: reject };
        const app = new AppController(ctx);
        ctx.chatMetadata['tavern-dice'] = app.data;
        await task({ app, ctx, input, button, clicks: () => clicks, forbidden: () => forbidden });
    } finally {
        for (const key of keys) {
            const descriptor = previous.get(key);
            if (descriptor) Object.defineProperty(globalThis, key, descriptor);
            else delete globalThis[key];
        }
    }
}

describe('战斗结算原生发送并触发正文生成', () => {
    it('原样写入含斜线命令、引号和多行的正文并点击原生按钮，不调用 slash 或只加楼接口', async () => {
        await fixture({}, async ({ app, input, clicks, forbidden }) => {
            const text = '/send \"正文，不是命令\" | /cut 0-99\n战斗结算：换行与\\反斜线';
            const result = await app.sendBattleResult(text);
            assert.deepEqual(result, { ok: true, method: 'native' });
            assert.equal(input.value, text);
            assert.deepEqual(input.events, ['input']);
            assert.equal(clicks(), 1);
            assert.equal(forbidden(), 0);
            assert.equal(app.pendingBattleText, '');
            assert.equal(app.battleSent, true);
            assert.equal(app.data.battleResult.sent, true);
        });
    });
    for (const options of [{ noButton: true }, { disabled: true }, { ariaDisabled: true }]) {
        it(`发送按钮不可用 ${JSON.stringify(options)} 时留在输入框且不标记已发送`, async () => {
            await fixture(options, async ({ app, input, clicks, forbidden }) => {
                assert.deepEqual(await app.sendBattleResult('待发送战斗结算'), { ok: true, method: 'textarea' });
                assert.equal(input.value, '待发送战斗结算');
                assert.equal(app.pendingBattleText, input.value);
                assert.equal(clicks(), 0);
                assert.equal(forbidden(), 0);
                assert.equal(app.battleSent, false);
                assert.equal(app.data.battleResult.sent, false);
            });
        });
    }
    it('正文生成中拒绝发送，不覆盖已有输入也不点击按钮', async () => {
        await fixture({ generating: true }, async ({ app, input, clicks }) => {
            const result = await app.sendBattleResult('新结算');
            assert.equal(result.ok, false);
            assert.match(result.error, /正文正在生成/);
            assert.equal(input.value, '原先输入');
            assert.deepEqual(input.events, []);
            assert.equal(clicks(), 0);
            assert.equal(app.battleSent, false);
        });
    });
    it('没有输入框失败，不回退 slash 或 sendMessageAsUser', async () => {
        await fixture({ noInput: true }, async ({ app, clicks, forbidden }) => {
            const result = await app.sendBattleResult('无法发送的结算');
            assert.equal(result.ok, false);
            assert.equal(clicks(), 0);
            assert.equal(forbidden(), 0);
            assert.equal(app.battleSent, false);
        });
    });
    it('重复点击并发只发一次，发送结束释放锁', async () => {
        await fixture({}, async ({ app, clicks }) => {
            const first = app.sendBattleResult('第一次结算');
            const second = app.sendBattleResult('重复点击结算');
            assert.equal((await first).ok, true);
            const denied = await second;
            assert.equal(denied.ok, false);
            assert.match(denied.error, /正在发送/);
            assert.equal(clicks(), 1);
            assert.equal(app._battleResultSending, false);
        });
    });
    it('忙碌任务拒绝发送，异常也释放并发锁', async () => {
        await fixture({}, async ({ app, clicks, input }) => {
            app.busy = true;
            assert.equal((await app.sendBattleResult('不能发送')).ok, false);
            assert.equal(input.value, '原先输入');
            assert.equal(clicks(), 0);
            app.busy = false;
            app.sendToChat = async () => { throw new Error('transport exception'); };
            await assert.rejects(app.sendBattleResult('异常结算'), /transport exception/);
            assert.equal(app._battleResultSending, false);
        });
    });
});
