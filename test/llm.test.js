/**
 * LLM 响应解析测试。
 *
 * 模型不听话的方式五花八门，这一层的健壮性直接决定「插件是不是经常报错」。
 * 这里覆盖的每一种畸形输出，都是真实会遇到（或已经遇到）的形态。
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import {
    ABORT_MESSAGE,
    LlmClient,
    closeUnbalanced,
    countTokens,
    deriveMaxTokens,
    extractDiff,
    extractPowerSystem,
    extractBalanced,
    parseJsonLoose,
    repairJson,
    withTimeout,
} from '../src/llm/client.js';
import { parseCombatBlock } from '../src/core/schema.js';

describe('parseJsonLoose 容错解析', () => {
    it('标准 JSON 直接解析', () => {
        const result = parseJsonLoose('{"a":1,"b":[2,3]}');
        assert.equal(result.ok, true);
        assert.deepEqual(result.value, { a: 1, b: [2, 3] });
        assert.equal(result.strategy, 'direct');
    });

    it('剥掉 markdown 代码围栏', () => {
        const result = parseJsonLoose('```json\n{"a":1}\n```');
        assert.equal(result.ok, true);
        assert.deepEqual(result.value, { a: 1 });
        assert.equal(result.strategy, 'fence');
    });

    it('无语言标记的围栏也能剥', () => {
        const result = parseJsonLoose('```\n{"a":1}\n```');
        assert.equal(result.ok, true);
        assert.deepEqual(result.value, { a: 1 });
    });

    it('前后有解释文字时提取中间的对象', () => {
        const result = parseJsonLoose('好的，这是结果：\n{"a":1,"b":2}\n希望有帮助！');
        assert.equal(result.ok, true);
        assert.deepEqual(result.value, { a: 1, b: 2 });
    });

    it('处理尾随逗号', () => {
        const result = parseJsonLoose('{"a":1,"b":2,}');
        assert.equal(result.ok, true);
        assert.deepEqual(result.value, { a: 1, b: 2 });
    });

    it('处理数组尾随逗号', () => {
        const result = parseJsonLoose('{"list":[1,2,3,]}');
        assert.equal(result.ok, true);
        assert.deepEqual(result.value, { list: [1, 2, 3] });
    });

    it('处理被 max_tokens 截断的输出', () => {
        const result = parseJsonLoose('{"system":{"name":"测试"},"allies":[{"name":"甲"');
        assert.equal(result.ok, true);
        // 最后一个完整键值对之前的内容都能救回来
        assert.equal(result.value.system.name, '测试');
        // 残缺的 allies 被安全丢弃 —— 宁可少一个单位，也不编造半个角色
        assert.equal(result.value.allies, undefined);
    });

    it('截断发生在数组中途时也能救回数组', () => {
        const result = parseJsonLoose('{"list":[1,2');
        assert.equal(result.ok, true);
        assert.deepEqual(result.value.list, [1, 2]);
    });

    it('截断停在冒号上时补 null 而不是报错', () => {
        const result = parseJsonLoose('{"a":');
        assert.equal(result.ok, true);
        assert.equal(result.value.a, null);
    });

    it('处理对象里的中文字符串含括号', () => {
        const result = parseJsonLoose('{"desc":"他喊了一声「{你好}」然后走了","n":1}');
        assert.equal(result.ok, true);
        assert.equal(result.value.n, 1);
        assert.ok(result.value.desc.includes('你好'));
    });

    it('处理转义引号', () => {
        const result = parseJsonLoose('{"s":"他说：\\"别动\\""}');
        assert.equal(result.ok, true);
        assert.ok(result.value.s.includes('别动'));
    });

    it('完全不是 JSON 时返回失败而不是抛异常', () => {
        const result = parseJsonLoose('这是一段完全无关的文字');
        assert.equal(result.ok, false);
        assert.ok(result.error);
    });

    it('空输入返回失败', () => {
        assert.equal(parseJsonLoose('').ok, false);
        assert.equal(parseJsonLoose(null).ok, false);
        assert.equal(parseJsonLoose(undefined).ok, false);
    });

    it('数组顶层也能解析', () => {
        const result = parseJsonLoose('[1,2,3]');
        assert.equal(result.ok, true);
        assert.deepEqual(result.value, [1, 2, 3]);
    });
});

describe('extractBalanced 括号配平', () => {
    it('取出第一个完整的对象', () => {
        assert.equal(extractBalanced('前缀 {"a":{"b":1}} 后缀'), '{"a":{"b":1}}');
    });

    it('跳过字符串里的括号', () => {
        assert.equal(extractBalanced('{"s":"}]"}'), '{"s":"}]"}');
    });

    it('处理转义引号里的括号', () => {
        assert.equal(extractBalanced('{"s":"\\"}"}'), '{"s":"\\"}"}');
    });

    it('没有配平结构时返回 null', () => {
        assert.equal(extractBalanced('没有括号'), null);
        assert.equal(extractBalanced('{未闭合'), null);
    });
});

describe('closeUnbalanced 补全截断结构', () => {
    it('补全未闭合的对象', () => {
        const result = closeUnbalanced('{"a":1');
        assert.doesNotThrow(() => JSON.parse(result));
        assert.equal(JSON.parse(result).a, 1);
    });

    it('补全未闭合的数组', () => {
        const result = closeUnbalanced('{"list":[1,2');
        assert.doesNotThrow(() => JSON.parse(result));
        assert.deepEqual(JSON.parse(result).list, [1, 2]);
    });

    it('丢掉残缺的成员而不是编造内容', () => {
        // `allies` 那个对象只写了一半，任何补全都不可能知道原意
        const result = closeUnbalanced('{"system":{"name":"x"},"allies":[{"name":"甲"');
        const parsed = JSON.parse(result);
        assert.equal(parsed.system.name, 'x');
        assert.equal(parsed.allies, undefined, '残缺的成员必须被丢弃，不能凭空造出单位');
    });

    it('完整输入原样返回', () => {
        const text = '{"a":1,"b":{"c":2}}';
        assert.equal(closeUnbalanced(text), text);
    });

    it('补全未闭合的字符串', () => {
        const result = closeUnbalanced('{"a":"未写完');
        assert.doesNotThrow(() => JSON.parse(result));
    });

    it('处理停在冒号后面的情况', () => {
        const result = closeUnbalanced('{"a":');
        assert.doesNotThrow(() => JSON.parse(result));
    });
});

describe('repairJson 修复', () => {
    it('去掉尾随逗号', () => {
        assert.equal(repairJson('{"a":1,}').ok, true);
    });

    it('去掉注释', () => {
        const result = repairJson('{"a":1, // 这是注释\n"b":2}');
        assert.equal(result.ok, true);
        assert.equal(result.value.b, 2);
    });

    it('修复中文冒号与逗号', () => {
        const result = repairJson('{"a"：1，"b"：2}');
        assert.equal(result.ok, true);
        assert.equal(result.value.b, 2);
    });

    it('无法修复时返回错误信息', () => {
        const result = repairJson('{{{');
        assert.equal(result.ok, false);
        assert.ok(result.error);
    });
});

describe('extractPowerSystem', () => {
    it('解析直接的体系对象', () => {
        const result = extractPowerSystem('{"system":{"name":"测试"},"allies":[]}', parseCombatBlock);
        assert.equal(result.ok, true);
        assert.equal(result.value.system.name, '测试');
    });

    it('剥掉 powerSystem 包装层', () => {
        const result = extractPowerSystem('{"powerSystem":{"system":{"name":"内层"}}}', parseCombatBlock);
        assert.equal(result.ok, true);
        assert.equal(result.value.system.name, '内层');
    });

    it('剥掉 data 包装层', () => {
        const result = extractPowerSystem('{"data":{"system":{"name":"数据层"}}}', parseCombatBlock);
        assert.equal(result.ok, true);
        assert.equal(result.value.system.name, '数据层');
    });

    it('模型直接吐 Combat_block 文本时也能解析', () => {
        const text = `<Combat_block>
战斗数据栏:
  我方列表:
    - 角色:
        名字: "甲"
        属性: "[HP:100/100][Atk:10]"
</Combat_block>`;
        const result = extractPowerSystem(text, parseCombatBlock);
        assert.equal(result.ok, true);
        assert.equal(result.strategy, 'combat_block');
        assert.equal(result.value.combatants.length, 1);
    });

    it('两种都解析不出时返回失败', () => {
        const result = extractPowerSystem('完全无关的文字', parseCombatBlock);
        assert.equal(result.ok, false);
    });
});

describe('extractDiff', () => {
    it('解析标准 diff', () => {
        const result = extractDiff(
            '{"added":[],"updated":[{"name":"甲"}],"hpChanges":[{"name":"甲","attribute":"HP","delta":-10}],"removed":[],"notes":"受伤"}',
        );
        assert.equal(result.ok, true);
        assert.equal(result.value.hpChanges.length, 1);
        assert.equal(result.value.notes, '受伤');
    });

    it('缺字段时补空数组而不是 undefined', () => {
        const result = extractDiff('{"notes":"无变化"}');
        assert.equal(result.ok, true);
        assert.deepEqual(result.value.added, []);
        assert.deepEqual(result.value.updated, []);
        assert.deepEqual(result.value.removed, []);
        assert.deepEqual(result.value.hpChanges, []);
    });

    it('支持 snake_case 的 hp_changes', () => {
        const result = extractDiff('{"hp_changes":[{"name":"甲","attribute":"HP","delta":-5}]}');
        assert.equal(result.ok, true);
        assert.equal(result.value.hpChanges.length, 1);
    });

    it('剥掉 diff / changes 包装层', () => {
        const a = extractDiff('{"diff":{"notes":"包了一层"}}');
        assert.equal(a.value.notes, '包了一层');
        const b = extractDiff('{"changes":{"notes":"另一种包装"}}');
        assert.equal(b.value.notes, '另一种包装');
    });

    it('非对象字段被忽略而不是让下游崩', () => {
        const result = extractDiff('{"added":"不是数组","updated":null}');
        assert.equal(result.ok, true);
        assert.deepEqual(result.value.added, []);
    });
});

describe('响应正文提取', () => {
    it('通过 extractDiff 间接验证多种响应形状', () => {
        // 这些形状来自真实的不同 API 实现
        const shapes = [
            '{"notes":"纯字符串"}',
            '```json\n{"notes":"围栏"}\n```',
            '前言 {"notes":"带前言"} 后记',
        ];
        for (const shape of shapes) {
            const result = extractDiff(shape);
            assert.equal(result.ok, true, `解析失败：${shape}`);
            assert.ok(result.value.notes);
        }
    });
});

describe('max_tokens 推导', () => {
    it('未配置时按输入长度自动推导', () => {
        const tokens = deriveMaxTokens(1000, 0);
        assert.ok(tokens > 1000, `自动推导过小：${tokens}`);
        assert.ok(tokens <= 32768);
    });

    it('配置值更大时以配置为准', () => {
        assert.equal(deriveMaxTokens(100, 8000), 8000);
    });

    it('输入很长时自动抬高到配置值之上（避免 JSON 被截断）', () => {
        const tokens = deriveMaxTokens(20000, 1000);
        assert.ok(tokens > 1000, `长输入没有抬高上限：${tokens}`);
    });

    it('永远不超过 32768', () => {
        assert.ok(deriveMaxTokens(1000000, 999999) <= 32768);
    });
});

describe('countTokens', () => {
    it('没有酒馆计数器时用字符估算', async () => {
        const tokens = await countTokens(null, '一'.repeat(180));
        assert.equal(tokens, 100); // 180 / 1.8
    });

    it('有酒馆计数器时优先使用', async () => {
        const ctx = { getTokenCountAsync: async () => 12345 };
        assert.equal(await countTokens(ctx, '随便什么'), 12345);
    });

    it('计数器抛错时回落估算而不是崩', async () => {
        const ctx = {
            getTokenCountAsync: async () => {
                throw new Error('counter broken');
            },
        };
        const tokens = await countTokens(ctx, '一'.repeat(90));
        assert.equal(tokens, 50);
    });

    it('空文本返回 0', async () => {
        assert.equal(await countTokens(null, ''), 0);
    });
});

describe('complete 每次尝试的超时与取消', () => {
    const makeClient = (config = {}, ctx = null) => new LlmClient(ctx, {
        mode: 'custom', apiUrl: 'https://llm.invalid/v1', model: 'test',
        timeout: 0.02, retries: 0, ...config,
    }, '测试');
    const success = () => new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }));
    const pendingFetch = (signal, onAbort = () => {}) => new Promise((resolve, reject) => {
        assert.ok(signal instanceof AbortSignal);
        assert.equal(signal.aborted, false);
        signal.addEventListener('abort', () => {
            onAbort();
            // 模拟常见 fetch 实现：不管 reason 都返回 AbortError。
            reject(new DOMException('The operation was aborted', 'AbortError'));
        }, { once: true });
    });

    it('超时真正终止 custom fetch，且不误报用户取消', async (t) => {
        let requestSignal;
        let aborted = 0;
        t.mock.method(globalThis, 'fetch', async (url, init) => {
            requestSignal = init.signal;
            return pendingFetch(init.signal, () => aborted++);
        });
        const result = await makeClient().complete({ user: 'u' });
        assert.equal(result.ok, false);
        assert.match(result.error, /超时/);
        assert.equal(result.aborted, undefined);
        assert.equal(requestSignal.aborted, true);
        assert.equal(aborted, 1);
        assert.equal(result.meta.attempts, 1);
    });

    it('超时可重试，每次使用新 signal，前一次在重试前已终止', async (t) => {
        const signals = [];
        let active = 0;
        let peak = 0;
        t.mock.method(globalThis, 'fetch', async (url, init) => {
            signals.push(init.signal);
            active++;
            peak = Math.max(peak, active);
            if (signals.length === 1) return pendingFetch(init.signal, () => active--);
            assert.equal(signals[0].aborted, true);
            assert.equal(init.signal.aborted, false);
            active--;
            return success();
        });
        const result = await makeClient({ retries: 1 }).complete({ user: 'u' });
        assert.equal(result.ok, true);
        assert.equal(result.text, 'ok');
        assert.equal(result.meta.attempts, 2);
        assert.equal(signals.length, 2);
        assert.notEqual(signals[0], signals[1]);
        assert.equal(peak, 1, '不应叠加在途 fetch');
        assert.equal(active, 0);
    });

    it('用户取消联动底层 fetch，停止重试并移除用户 listener', async (t) => {
        const user = new AbortController();
        const add = t.mock.method(user.signal, 'addEventListener');
        const remove = t.mock.method(user.signal, 'removeEventListener');
        let requestSignal;
        t.mock.method(globalThis, 'fetch', async (url, init) => {
            requestSignal = init.signal;
            const pending = pendingFetch(init.signal);
            user.abort(new Error('user stop'));
            return pending;
        });
        const result = await makeClient({ retries: 2, timeout: 30 }).complete({ user: 'u', signal: user.signal });
        assert.equal(result.ok, false);
        assert.equal(result.error, ABORT_MESSAGE);
        assert.equal(result.aborted, true);
        assert.equal(result.meta.attempts, 1);
        assert.equal(requestSignal.aborted, true);
        assert.equal(add.mock.callCount(), 1);
        assert.equal(remove.mock.callCount(), 1);
        assert.equal(add.mock.calls[0].arguments[1], remove.mock.calls[0].arguments[1]);
    });

    it('重试退避期间用户取消，清除退避 timer 且不再发请求', async (t) => {
        const user = new AbortController();
        let cancelTimer;
        t.after(() => clearTimeout(cancelTimer));
        const fetchMock = t.mock.method(globalThis, 'fetch', async () => {
            cancelTimer = setTimeout(() => user.abort(), 10);
            throw new Error('temporary failure');
        });
        const result = await makeClient({ retries: 2, timeout: 30 }).complete({ user: 'u', signal: user.signal });
        assert.equal(result.aborted, true);
        assert.equal(result.error, ABORT_MESSAGE);
        assert.equal(result.meta.attempts, 1);
        assert.equal(fetchMock.mock.callCount(), 1);
    });

    it('已取消的用户 signal 不发请求', async (t) => {
        const user = new AbortController();
        user.abort();
        const fetchMock = t.mock.method(globalThis, 'fetch', async () => success());
        const result = await makeClient({ retries: 2 }).complete({ user: 'u', signal: user.signal });
        assert.equal(result.aborted, true);
        assert.equal(result.meta.attempts, 0);
        assert.equal(fetchMock.mock.callCount(), 0);
    });

    it('成功后清除 timeout 和用户 listener，不会迟到中断', async (t) => {
        const user = new AbortController();
        const remove = t.mock.method(user.signal, 'removeEventListener');
        let requestSignal;
        t.mock.method(globalThis, 'fetch', async (url, init) => {
            requestSignal = init.signal;
            return success();
        });
        const result = await makeClient().complete({ user: 'u', signal: user.signal });
        assert.equal(result.ok, true);
        assert.equal(remove.mock.callCount(), 1);
        user.abort();
        await new Promise((resolve) => setTimeout(resolve, 40));
        assert.equal(requestSignal.aborted, false);
    });

    it('失败后也清除 timeout 和用户 listener', async (t) => {
        const user = new AbortController();
        const remove = t.mock.method(user.signal, 'removeEventListener');
        let requestSignal;
        t.mock.method(globalThis, 'fetch', async (url, init) => {
            requestSignal = init.signal;
            throw new Error('network broken');
        });
        const result = await makeClient().complete({ user: 'u', signal: user.signal });
        assert.match(result.error, /network broken/);
        assert.equal(remove.mock.callCount(), 1);
        user.abort();
        await new Promise((resolve) => setTimeout(resolve, 40));
        assert.equal(requestSignal.aborted, false);
    });

    it('旧 helper 忽略 signal 时用户取消仍及时返回，传参保留', async (t) => {
        const user = new AbortController();
        let params;
        // 安全安装并在测试结束还原 helper，即使原环境不存在这个字段。
        const previous = Object.getOwnPropertyDescriptor(globalThis, 'TavernHelper');
        t.after(() => {
            if (previous) Object.defineProperty(globalThis, 'TavernHelper', previous);
            else delete globalThis.TavernHelper;
        });
        globalThis.TavernHelper = { generateRaw: async (value) => {
            params = value;
            user.abort();
            return new Promise(() => {});
        } };
        const result = await makeClient({ mode: 'tavern-helper', timeout: 30 }).complete({ user: 'u', signal: user.signal });
        assert.equal(result.aborted, true);
        assert.equal(params.signal.aborted, true);
        assert.equal(params.custom_api.model, 'test');
        assert.equal(params.ordered_prompts[0].content, 'u');
    });

    it('profile 保留响应提取与第四参 signal，超时能中断', async () => {
        let args;
        const ctx = { ConnectionManagerRequestService: { sendRequest: async (...value) => {
            args = value;
            return pendingFetch(value[3].signal);
        } } };
        const result = await makeClient({ mode: 'profile', profileId: 'p' }, ctx).complete({ user: 'u' });
        assert.match(result.error, /超时/);
        assert.equal(result.aborted, undefined);
        assert.equal(args[0], 'p');
        assert.equal(args[1][0].content, 'u');
        assert.equal(args[3].signal.aborted, true);
        ctx.ConnectionManagerRequestService.sendRequest = async () => ({ result: { choices: [{ message: { content: 'profile ok' } }] } });
        assert.equal((await makeClient({ mode: 'profile', profileId: 'p' }, ctx).complete({ user: 'u' })).text, 'profile ok');
    });
});

describe('withTimeout', () => {
    it('正常完成时透传结果', async () => {
        const result = await withTimeout(Promise.resolve('ok'), 1000);
        assert.equal(result, 'ok');
    });

    it('超时抛错且信息可读', async () => {
        await assert.rejects(
            () => withTimeout(new Promise((resolve) => setTimeout(resolve, 500)), 30, '测试调用 '),
            /测试调用.*超时/,
        );
    });

    it('内部错误正常透传（不被超时掩盖）', async () => {
        await assert.rejects(() => withTimeout(Promise.reject(new Error('内部错误')), 1000), /内部错误/);
    });

    it('未设置超时时不干预', async () => {
        assert.equal(await withTimeout(Promise.resolve(1), 0), 1);
    });
});
