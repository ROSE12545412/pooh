/**
 * 端点拼装与模型列表拉取的测试。
 *
 * `/models` 的地址拼装是最容易错的一处：模型列表挂在与 `chat/completions`
 * **同一层**，不是 `.../chat/completions/models`。拼错了用户只会看到一个
 * 404 或者莫名其妙的报错，很难自己看出原因。
 */

import { strict as assert } from 'node:assert';
import { describe, it, afterEach } from 'node:test';

import {
    LlmClient,
    buildChatEndpoint,
    buildModelsEndpoint,
    extractModelIds,
    isJsonSchemaUnsupported,
} from '../src/llm/client.js';

describe('buildChatEndpoint 地址归一化', () => {
    it('补上 /chat/completions', () => {
        assert.equal(buildChatEndpoint('https://api.x.com/v1'), 'https://api.x.com/v1/chat/completions');
    });

    it('去掉末尾斜杠', () => {
        assert.equal(buildChatEndpoint('https://api.x.com/v1/'), 'https://api.x.com/v1/chat/completions');
        assert.equal(buildChatEndpoint('https://api.x.com/v1///'), 'https://api.x.com/v1/chat/completions');
    });

    it('已经是完整端点时原样返回', () => {
        const full = 'https://api.x.com/v1/chat/completions';
        assert.equal(buildChatEndpoint(full), full);
        assert.equal(buildChatEndpoint(`${full}/`), full);
    });

    it('从 /models 地址换回 chat 端点', () => {
        assert.equal(buildChatEndpoint('https://api.x.com/v1/models'), 'https://api.x.com/v1/chat/completions');
    });

    it('空输入返回空串', () => {
        assert.equal(buildChatEndpoint(''), '');
        assert.equal(buildChatEndpoint(null), '');
        assert.equal(buildChatEndpoint(undefined), '');
    });
});

describe('buildModelsEndpoint 地址归一化', () => {
    it('基础地址拼 /models', () => {
        assert.equal(buildModelsEndpoint('https://api.x.com/v1'), 'https://api.x.com/v1/models');
    });

    it('去掉末尾斜杠再拼', () => {
        assert.equal(buildModelsEndpoint('https://api.x.com/v1/'), 'https://api.x.com/v1/models');
    });

    it('从 chat 端点换到 /models（关键：不能拼成 .../chat/completions/models）', () => {
        assert.equal(
            buildModelsEndpoint('https://api.x.com/v1/chat/completions'),
            'https://api.x.com/v1/models',
        );
    });

    it('已经是 /models 时原样返回', () => {
        assert.equal(buildModelsEndpoint('https://api.x.com/v1/models'), 'https://api.x.com/v1/models');
    });

    it('保留路径里的版本前缀', () => {
        assert.equal(buildModelsEndpoint('https://api.x.com/openai/v2/chat/completions'), 'https://api.x.com/openai/v2/models');
    });

    it('空输入返回空串', () => {
        assert.equal(buildModelsEndpoint(''), '');
    });
});

describe('extractModelIds 响应解析', () => {
    it('解析 OpenAI 标准形状 {data:[{id}]}', () => {
        const ids = extractModelIds({ object: 'list', data: [{ id: 'gpt-4' }, { id: 'gpt-3.5' }] });
        assert.deepEqual(ids, ['gpt-3.5', 'gpt-4']); // 已排序
    });

    it('解析 {data:[{name}]}', () => {
        assert.deepEqual(extractModelIds({ data: [{ name: 'model-b' }] }), ['model-b']);
    });

    it('解析 {models:[...]}', () => {
        assert.deepEqual(extractModelIds({ models: ['z', 'a'] }), ['a', 'z']);
    });

    it('解析纯字符串数组', () => {
        assert.deepEqual(extractModelIds(['m1', 'm2']), ['m1', 'm2']);
    });

    it('解析 {result:[...]}', () => {
        assert.deepEqual(extractModelIds({ result: [{ id: 'r1' }] }), ['r1']);
    });

    it('去重', () => {
        assert.deepEqual(extractModelIds({ data: [{ id: 'dup' }, { id: 'dup' }] }), ['dup']);
    });

    it('忽略没有名字的条目', () => {
        assert.deepEqual(extractModelIds({ data: [{ id: 'ok' }, {}, { id: '' }, null] }), ['ok']);
    });

    it('无法识别的形状返回空数组而不是崩', () => {
        assert.deepEqual(extractModelIds(null), []);
        assert.deepEqual(extractModelIds(undefined), []);
        assert.deepEqual(extractModelIds({ weird: true }), []);
        assert.deepEqual(extractModelIds(42), []);
    });

    it('支持 slug 字段（部分中转站这么写）', () => {
        assert.deepEqual(extractModelIds({ data: [{ slug: 'vendor/model' }] }), ['vendor/model']);
    });
});

describe('isJsonSchemaUnsupported 降级判定', () => {
    it('识别 Gemini / 中转站返回的 400', () => {
        // 这条是真实遇到过的报错（用户建表时被卡住的原因）
        const geminiLike =
            '{"error":{"message":"upstream status 400: {\\"error\\":{\\"code\\":400,\\"message\\":\\"Request contains an invalid argument.\\",\\"status\\":\\"INVALID_ARGUMENT\\"}}","type":"invalid_request_error","code":"invalid_argument"}}';
        assert.equal(isJsonSchemaUnsupported(400, geminiLike), true);
    });

    it('识别明确提到 response_format 的报错', () => {
        assert.equal(
            isJsonSchemaUnsupported(400, '{"error":{"message":"Unsupported parameter: response_format"}}'),
            true,
        );
        assert.equal(isJsonSchemaUnsupported(400, 'unknown parameter: json_schema'), true);
        assert.equal(isJsonSchemaUnsupported(422, 'Unrecognized request argument supplied: response_format'), true);
    });

    it('不把无关的 400 误判成 schema 问题（避免掩盖真错误）', () => {
        // 模型名写错：这是用户自己填错了，不是 schema 问题
        assert.equal(isJsonSchemaUnsupported(400, 'model not found: gpt-99'), false);
        // 额度用尽
        assert.equal(isJsonSchemaUnsupported(429, 'rate limit exceeded'), false);
        // 请求体里别的字段有问题，但没提 schema
        assert.equal(isJsonSchemaUnsupported(400, 'messages must be an array'), false);
        // 空响应体无法判断
        assert.equal(isJsonSchemaUnsupported(400, ''), false);
    });

    it('非 400/422 状态码一律不判定（401/403/500 是别的问题）', () => {
        assert.equal(isJsonSchemaUnsupported(401, 'response_format unsupported'), false);
        assert.equal(isJsonSchemaUnsupported(403, 'response_format unsupported'), false);
        assert.equal(isJsonSchemaUnsupported(500, 'response_format unsupported'), false);
    });
});

describe('直连遇到 schema 不支持时自动降级重试', () => {
    const originalFetch = globalThis.fetch;
    afterEach(() => {
        globalThis.fetch = originalFetch;
    });

    it('第一次带 response_format 被 400，第二次去掉后成功', async () => {
        /** @type {any[]} */
        const bodies = [];
        globalThis.fetch = async (url, init) => {
            const body = JSON.parse(String(init?.body ?? '{}'));
            bodies.push(body);
            if (body.response_format) {
                return {
                    ok: false,
                    status: 400,
                    text: async () => '{"error":{"message":"Request contains an invalid argument."}}',
                };
            }
            return {
                ok: true,
                status: 200,
                json: async () => ({ choices: [{ message: { content: '{"system":{"name":"ok"}}' } }] }),
            };
        };

        const client = new LlmClient(
            null,
            {
                mode: 'custom',
                apiUrl: 'https://api.x.com/v1',
                model: 'gemini-3.7-flash',
                useJsonSchema: true,
                retries: 0,
                timeout: 30,
            },
            '测试',
        );
        const result = await client.complete({
            system: 's',
            user: 'u',
            jsonSchema: { name: 'x', value: { type: 'object' }, strict: true },
        });

        assert.equal(result.ok, true, `应当降级后成功：${result.error}`);
        assert.equal(bodies.length, 2, '应当发出两次请求');
        assert.ok(bodies[0].response_format, '第一次应当带 response_format');
        assert.equal(bodies[1].response_format, undefined, '第二次应当去掉 response_format');
        assert.ok(result.meta.notice, '应当带一条降级提示');
        assert.match(result.meta.notice, /JSON Schema/);
    });

    it('无关的 400 不会触发降级重试（直接失败）', async () => {
        let calls = 0;
        globalThis.fetch = async () => {
            calls++;
            return { ok: false, status: 400, text: async () => 'model not found: 不存在' };
        };

        const client = new LlmClient(
            null,
            { mode: 'custom', apiUrl: 'https://api.x.com/v1', model: 'x', useJsonSchema: true, retries: 0, timeout: 30 },
            '测试',
        );
        const result = await client.complete({
            system: 's',
            user: 'u',
            jsonSchema: { name: 'x', value: { type: 'object' } },
        });

        assert.equal(result.ok, false);
        assert.equal(calls, 1, '不相关的 400 不该多发请求');
        assert.match(result.error, /model not found/);
    });

    it('没开 JSON Schema 时行为不变（只发一次）', async () => {
        let calls = 0;
        globalThis.fetch = async () => {
            calls++;
            return { ok: false, status: 400, text: async () => 'Request contains an invalid argument.' };
        };

        const client = new LlmClient(
            null,
            { mode: 'custom', apiUrl: 'https://api.x.com/v1', model: 'x', useJsonSchema: false, retries: 0, timeout: 30 },
            '测试',
        );
        const result = await client.complete({
            system: 's',
            user: 'u',
            jsonSchema: { name: 'x', value: { type: 'object' } },
        });

        assert.equal(result.ok, false);
        assert.equal(calls, 1);
    });
});

describe('listModels 拉取流程', () => {
    /** 保存原 fetch 以便还原。 */
    const originalFetch = globalThis.fetch;
    afterEach(() => {
        globalThis.fetch = originalFetch;
    });

    it('直连成功时返回模型列表', async () => {
        /** @type {string[]} */
        const calledUrls = [];
        globalThis.fetch = (async (url) => {
            calledUrls.push(String(url));
            return {
                ok: true,
                status: 200,
                json: async () => ({ data: [{ id: 'model-a' }, { id: 'model-b' }] }),
            };
        });

        const client = new LlmClient(null, { mode: 'custom', apiUrl: 'https://api.x.com/v1', apiKey: 'k' }, '测试');
        const result = await client.listModels();

        assert.equal(result.ok, true);
        assert.deepEqual(result.models, ['model-a', 'model-b']);
        assert.equal(calledUrls[0], 'https://api.x.com/v1/models', '端点拼错了');
    });

    it('HTTP 错误时返回可读原因而不是抛异常', async () => {
        globalThis.fetch = async () => ({
            ok: false,
            status: 401,
            text: async () => 'Unauthorized',
        });

        const client = new LlmClient(null, { mode: 'custom', apiUrl: 'https://api.x.com/v1' }, '测试');
        const result = await client.listModels();

        assert.equal(result.ok, false);
        assert.ok(result.error.includes('401'), `错误信息里应包含状态码：${result.error}`);
        assert.deepEqual(result.models, []);
    });

    it('网络异常（CORS 等）时给出可操作的提示', async () => {
        globalThis.fetch = async () => {
            throw new TypeError('Failed to fetch');
        };

        const client = new LlmClient(null, { mode: 'custom', apiUrl: 'https://api.x.com/v1' }, '测试');
        const result = await client.listModels();

        assert.equal(result.ok, false);
        // 没有酒馆助手可用时，应当直接给出「手动填写」的建议
        assert.ok(result.error, '必须有错误信息');
    });

    it('端点返回 200 但没有模型名时明确说明', async () => {
        globalThis.fetch = async () => ({
            ok: true,
            status: 200,
            json: async () => ({ data: [] }),
        });

        const client = new LlmClient(null, { mode: 'custom', apiUrl: 'https://api.x.com/v1' }, '测试');
        const result = await client.listModels();

        assert.equal(result.ok, false);
        assert.match(result.error, /没有可识别的模型名/);
    });

    it('没填地址也没装酒馆助手时，提示先填地址', async () => {
        const client = new LlmClient(null, { mode: 'custom', apiUrl: '' }, '测试');
        const result = await client.listModels();
        assert.equal(result.ok, false);
        assert.match(result.error, /请先填写 API 地址|手填/);
    });

    it('装了酒馆助手时优先用它（直连失败后的回落路径）', async () => {
        globalThis.fetch = async () => {
            throw new TypeError('Failed to fetch');
        };
        const fakeWindow = /** @type {any} */ (globalThis);
        const hadHelper = 'TavernHelper' in fakeWindow;
        const previous = fakeWindow.TavernHelper;

        /** @type {any[]} */
        const calls = [];
        fakeWindow.TavernHelper = {
            getModelList: async (cfg) => {
                calls.push(cfg);
                return ['helper-model-1', 'helper-model-2'];
            },
        };

        try {
            const client = new LlmClient(null, { mode: 'custom', apiUrl: 'https://api.x.com/v1', apiKey: 'k' }, '测试');
            const result = await client.listModels();

            assert.equal(result.ok, true, `应当回落到酒馆助手：${result.error}`);
            assert.deepEqual(result.models, ['helper-model-1', 'helper-model-2']);
            assert.equal(result.source, '酒馆助手');
            assert.equal(calls.length, 1);
            assert.equal(calls[0].apiurl, 'https://api.x.com/v1', '应当把地址透传给酒馆助手');
        } finally {
            if (hadHelper) fakeWindow.TavernHelper = previous;
            else delete fakeWindow.TavernHelper;
        }
    });

    it('酒馆助手报错时也不抛异常', async () => {
        globalThis.fetch = async () => {
            throw new TypeError('Failed to fetch');
        };
        const fakeWindow = /** @type {any} */ (globalThis);
        const hadHelper = 'TavernHelper' in fakeWindow;
        const previous = fakeWindow.TavernHelper;

        fakeWindow.TavernHelper = {
            getModelList: async () => {
                throw new Error('助手内部错误');
            },
        };

        try {
            const client = new LlmClient(null, { mode: 'custom', apiUrl: 'https://api.x.com/v1' }, '测试');
            const result = await client.listModels();
            assert.equal(result.ok, false);
            assert.ok(result.error);
        } finally {
            if (hadHelper) fakeWindow.TavernHelper = previous;
            else delete fakeWindow.TavernHelper;
        }
    });
});
