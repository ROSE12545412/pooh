/**
 * tavern-dice / src/llm/client.js
 * ---------------------------------------------------------------------------
 * 双通道 LLM 客户端。
 *
 * 为什么要两条独立通道：
 *  P1（建表）需要吃下几万字世界书、输出结构化大 JSON；
 *  P2（更新）每轮对话都要跑一次，输入小、要求快。
 *  两者的模型、温度、超时需求完全不同 —— 所以设置里是两套独立配置，
 *  用户可以让 P1 用贵模型、P2 用便宜快模型。
 *
 * 四种传输模式（都在真实代码里验证过）：
 *  1. `tavern-helper` —— `window.TavernHelper.generateRaw`
 *     功能最强：支持 `custom_api`（自带 URL/Key/Model）与 `json_schema` 强约束。
 *     需要用户装「酒馆助手 / JS-Slash-Runner」扩展。
 *  2. `profile` —— `ctx.ConnectionManagerRequestService.sendRequest(profileId, messages, maxTokens)`
 *     复用用户在「连接配置」里存好的 profile。**API key 明文拿不到**（存在 secrets.json），
 *     所以「既想用独立模型又不想重复填 key」时这是最佳选择。
 *  3. `custom` —— 直连 OpenAI 兼容端点（fetch）。
 *     完全不依赖其它扩展，但需要自己填 URL/Key/Model，且可能被 WebView 域名白名单拦。
 *  4. `main` —— 复用当前主连接（走 generateRaw 不带 custom_api）。
 *     最省事但会被当前预设污染，只作为兜底。
 *
 * 所有通道统一返回 `{ ok, text, error, meta }`，由上层决定怎么解析。
 */

import { toText } from '../core/schema.js';

/**
 * 取酒馆助手（TavernHelper / JS-Slash-Runner）的全局对象。
 *
 * 用 `globalThis` 而不是 `window`：浏览器里两者等价，但在**非浏览器环境**
 *（冒烟测试，以及某些把扩展跑在 Worker 或特殊宿主里的实现）只有 `globalThis`。
 * 早期版本写死 `window`，会导致「装了助手却被误判成没装」，
 * 进而错误地回落到直连，把模型列表拉取这类功能变成不可用。
 *
 * @returns {any}
 */
export function getTavernHelper() {
    try {
        return /** @type {any} */ (globalThis)?.TavernHelper ?? undefined;
    } catch {
        return undefined;
    }
}

/**
 * 把任意异常转成**有信息量**的字符串。
 *
 * ⚠️ 这个函数的存在是有教训的：早期直接用 `describeError(e)`，
 * 遇到「不是标准 Error 的异常」时 `e.message` 是 `undefined`，
 * 而 `?? e` 又拿到了那个对象 → 字符串化成 `[object Object]` 或空串，
 * 最后被兜底成一句毫无用处的「未知错误」，把真实原因彻底掩盖。
 *
 * 现在按可靠性依次尝试：message → error/description → JSON → String → 类型名。
 *
 * @param {any} error
 * @returns {string}
 */
export function describeError(error) {
    if (error === null || error === undefined) return '';
    if (typeof error === 'string') return error.trim();
    if (typeof error === 'number' || typeof error === 'boolean') return String(error);

    // 标准 Error（注意 message 可能是空串，那不算有效信息）
    const message = typeof error.message === 'string' ? error.message.trim() : '';
    if (message) return message;

    for (const key of ['error', 'error_description', 'description', 'reason', 'detail', 'msg']) {
        const value = error[key];
        if (typeof value === 'string' && value.trim()) return value.trim();
        // 有些 SDK 把错误再套一层对象
        if (value && typeof value === 'object') {
            const nested = describeError(value);
            if (nested) return nested;
        }
    }

    // 对象没法直接读，就序列化看看（截断，避免把整个响应体塞进日志）
    try {
        const json = JSON.stringify(error);
        if (json && json !== '{}' && json !== 'null') return json.slice(0, 400);
    } catch {
        /* 循环引用之类，忽略 */
    }

    // 最后退到类型名 + 自有键，至少能看出「这是个什么东西」
    const name = typeof error.name === 'string' && error.name ? error.name : '';
    const keys = (() => {
        try {
            return Object.keys(error).slice(0, 8).join(',');
        } catch {
            return '';
        }
    })();
    const fallback = [name || '未知异常', keys ? `字段：${keys}` : ''].filter(Boolean).join('　');
    return fallback;
}

/**
 * 从各家响应里抠出正文文本的通用函数。
 *
 * 四种通道（酒馆助手 / 连接配置 / 直连 / 主连接）返回的形状各不相同，
 * 所以这里逐个探测，而不是假定某一种。
 *
 * @param {any} response
 * @returns {string}
 */
function extractContent(response) {
    if (response === null || response === undefined) return '';

    // TavernHelper.generateRaw 返回 string 或 GenerateToolCallResult
    if (typeof response === 'string') return response;
    if (typeof response === 'object') {
        // GenerateToolCallResult: { content, tool_calls }
        if (typeof response.content === 'string' && response.content) return response.content;
        // ConnectionManagerRequestService: { result: { choices: [...] } } 或 { content }
        const fromResult = response.result?.choices?.[0]?.message?.content;
        if (typeof fromResult === 'string') return fromResult;
        const fromChoices = response.choices?.[0]?.message?.content ?? response.choices?.[0]?.text;
        if (typeof fromChoices === 'string') return fromChoices;
        // 有些实现直接把 message 放顶层
        const fromMessage = response.message?.content;
        if (typeof fromMessage === 'string') return fromMessage;
        // 工具调用兜底
        const args = response.tool_calls?.[0]?.function?.arguments;
        if (typeof args === 'string') return args;
    }
    return '';
}

// ---------------------------------------------------------------------------
// 端点地址拼装
// ---------------------------------------------------------------------------

/**
 * 把用户填的地址规整成 OpenAI 兼容的 chat completions 端点。
 *
 * 用户会填成各种样子，都要能work：
 *   `https://api.x.com/v1`                        → `https://api.x.com/v1/chat/completions`
 *   `https://api.x.com/v1/`                       → `https://api.x.com/v1/chat/completions`
 *   `https://api.x.com/v1/chat/completions`       → 原样
 *   `https://api.x.com/v1/models`                 → `https://api.x.com/v1/chat/completions`
 *
 * @param {string} apiUrl
 * @returns {string}
 */
export function buildChatEndpoint(apiUrl) {
    const raw = toText(apiUrl);
    if (!raw) return '';
    const trimmed = raw.replace(/\/+$/, '');
    if (/\/chat\/completions$/i.test(trimmed)) return trimmed;
    if (/\/models$/i.test(trimmed)) return `${trimmed.replace(/\/models$/i, '')}/chat/completions`;
    return `${trimmed}/chat/completions`;
}

/**
 * 把用户填的地址规整成 OpenAI 兼容的模型列表端点。
 *
 * 这一条容易被忽略：**模型列表挂在与 chat completions 同一层**，
 * 不是 `/v1/chat/completions/models`。
 * 所以先要把地址归一到 base，再拼 `/models`。
 *
 * @param {string} apiUrl
 * @returns {string}
 */
export function buildModelsEndpoint(apiUrl) {
    const raw = toText(apiUrl);
    if (!raw) return '';
    let base = raw.replace(/\/+$/, '');
    if (/\/chat\/completions$/i.test(base)) base = base.replace(/\/chat\/completions$/i, '');
    if (/\/models$/i.test(base)) return base;
    return `${base}/models`;
}

/**
 * 从 OpenAI 风格的 /models 响应里提取模型名列表。
 * 兼容三种常见形状：`{data:[{id}]}`、`{models:[...]}`、`{data:[{name}]}`。
 *
 * @param {any} payload
 * @returns {string[]}
 */
export function extractModelIds(payload) {
    if (!payload) return [];
    /** @type {any[]} */
    let list = [];
    if (Array.isArray(payload)) list = payload;
    else if (Array.isArray(payload.data)) list = payload.data;
    else if (Array.isArray(payload.models)) list = payload.models;
    else if (Array.isArray(payload.result)) list = payload.result;
    else return [];

    const names = [];
    for (const item of list) {
        const name =
            typeof item === 'string'
                ? item
                : toText(item?.id ?? item?.name ?? item?.model ?? item?.slug ?? '');
        if (name) names.push(name);
    }
    // 去重 + 排序，方便在长列表里找
    return [...new Set(names)].sort((a, b) => a.localeCompare(b, 'en'));
}

/**
 * 判断一个 HTTP 错误是不是「服务端不认 `response_format` 这个参数」。
 *
 * 这个判定要保守：**只有同时满足「400 类状态码」和「错误文本提到相关关键字」才成立**，
 * 否则会把「模型名写错了」「额度用完了」这类真问题也当成 schema 问题，
 * 白白多发一次请求、还掩盖了真正的错误原因。
 *
 * @param {number} status
 * @param {string} detail 响应正文
 * @returns {boolean}
 */
export function isJsonSchemaUnsupported(status, detail) {
    if (status !== 400 && status !== 422) return false;
    const text = String(detail ?? '').toLowerCase();
    if (!text) return false;
    return (
        text.includes('response_format') ||
        text.includes('json_schema') ||
        text.includes('json schema') ||
        text.includes('invalid argument') ||
        text.includes('invalid_argument') ||
        text.includes('unsupported') ||
        text.includes('unknown field') ||
        text.includes('unrecognized')
    );
}

/**
 * 带超时的 Promise 包装。
 * 无论成功还是失败都会清掉定时器 —— 否则一个已经 reject 的请求
 * 还会留着一个待触发的 timer，把 node 进程挂住不退出。
 * @template T
 * @param {Promise<T>} promise
 * @param {number} ms
 * @param {string} [label]
 * @returns {Promise<T>}
 */
export function withTimeout(promise, ms, label = 'LLM 调用') {
    if (!ms || ms <= 0) return promise;
    return new Promise((resolve, reject) => {
        let settled = false;
        const timer = setTimeout(() => {
            if (settled) return;
            settled = true;
            reject(new Error(`${label}超时（${Math.round(ms / 1000)} 秒）`));
        }, ms);
        promise.then(
            (value) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                resolve(value);
            },
            (error) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                reject(error);
            },
        );
    });
}

/**
 * 每次尝试独立的取消范围：超时先报告 TimeoutError，再中断底层传输。
 * 即便旧 helper/profile 忽略 signal，也能及时结束等待；公开 withTimeout 保持不变。
 * @template T
 * @param {(signal: AbortSignal) => Promise<T>} task
 * @param {number} ms
 * @param {string} label
 * @param {AbortSignal} [signal]
 * @returns {Promise<T>}
 */
async function withAttemptAbort(task, ms, label, signal) {
    const controller = new AbortController();
    let timer;
    let onAbort;
    const cancelled = new Promise((resolve, reject) => {
        onAbort = () => {
            const error = new Error(ABORT_MESSAGE);
            error.name = 'AbortError';
            reject(error);
            controller.abort(signal?.reason ?? error);
        };
        if (signal?.aborted) {
            onAbort();
            return;
        }
        signal?.addEventListener('abort', onAbort, { once: true });
        if (ms > 0) {
            timer = setTimeout(() => {
                const error = new Error(`${label}超时（${Math.round(ms / 1000)} 秒）`);
                error.name = 'TimeoutError';
                // 先 reject，避免 fetch 的 AbortError 抢先把超时误判为用户取消。
                reject(error);
                controller.abort(error);
            }, ms);
        }
    });
    try {
        return await Promise.race([
            cancelled,
            Promise.resolve().then(() => {
                if (controller.signal.aborted) throw controller.signal.reason;
                return task(controller.signal);
            }),
        ]);
    } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
    }
}

/**
 * 估算输入的 token 数。优先用酒馆自带的计数器。
 * @param {any} ctx
 * @param {string} text
 * @returns {Promise<number>}
 */
export async function countTokens(ctx, text) {
    try {
        if (typeof ctx?.getTokenCountAsync === 'function') {
            const n = await ctx.getTokenCountAsync(text);
            if (Number.isFinite(n) && n > 0) return n;
        }
    } catch {
        /* 忽略，走估算 */
    }
    // 中文密集文本约 1.8 字符/token
    return Math.ceil(String(text ?? '').length / 1.8);
}

/** 单次请求的输出上限。超过这个值大多数端点会直接报错，所以硬性封顶。 */
const MAX_OUTPUT_TOKENS = 32768;

/**
 * 根据输入长度推导一个够用的 max_tokens，避免长 JSON 被截断。
 * 无论用户怎么填，结果都会被夹在 1 ~ MAX_OUTPUT_TOKENS 之间。
 * @param {number} inputTokens
 * @param {number} configured 用户配置值（0 = 自动）
 * @param {number} [expectedRatio] 输出/输入比例
 * @returns {number}
 */
export function deriveMaxTokens(inputTokens, configured, expectedRatio = 1.2) {
    const auto = Math.ceil((Number(inputTokens) || 0) * expectedRatio) + 1024;
    const want = Number(configured) || 0;
    const target = want > 0 ? Math.max(want, auto) : auto;
    return Math.max(1, Math.min(MAX_OUTPUT_TOKENS, target));
}

/**
 * 单个通道的请求封装。
 */
export class LlmClient {
    /**
     * @param {any} ctx SillyTavern context
     * @param {object} channelConfig 来自 settings.p1.channel / settings.p2.channel
     * @param {string} label 通道名，用于日志与报错
     */
    constructor(ctx, channelConfig, label) {
        this.ctx = ctx;
        this.config = channelConfig ?? {};
        this.label = label;
        /**
         * 上一次请求过程中的兼容性提示（例如「端点不支持 JSON Schema，已自动降级」）。
         * 由 `complete()` 带进 meta，供上层写进用户可见的日志。
         * @type {string}
         */
        this.lastNotice = '';
    }

    /** 当前环境能力探测：哪些模式可用。 */
    static probe(ctx) {
        const helper = getTavernHelper();
        const service = ctx?.ConnectionManagerRequestService;
        return {
            tavernHelper: Boolean(helper && typeof helper.generateRaw === 'function'),
            tavernHelperVersion: toText(helper?.version ?? helper?.info?.version),
            profileService: Boolean(service && typeof service.sendRequest === 'function'),
            profiles: LlmClient.listProfiles(ctx),
        };
    }

    /** 列出可用的连接配置（Connection Profile）。 */
    static listProfiles(ctx) {
        try {
            const profiles = ctx?.extensionSettings?.connectionManager?.profiles;
            if (!Array.isArray(profiles)) return [];
            return profiles
                .filter((p) => p && p.id)
                .map((p) => ({
                    id: p.id,
                    name: toText(p.name) || toText(p.model) || p.id,
                    api: toText(p.api),
                    apiUrl: toText(p['api-url']),
                    model: toText(p.model),
                }));
        } catch {
            return [];
        }
    }

    /**
     * 发一次请求。
     * @param {{system?: string, user: string, jsonSchema?: {name: string, description?: string, value: object, strict?: boolean}, maxTokens?: number, temperature?: number, expectedOutputRatio?: number, signal?: AbortSignal}} req
     * @returns {Promise<{ok: boolean, text: string, error?: string, meta: object}>}
     */
    async complete(req) {
        const signal = /** @type {AbortSignal|undefined} */ (req.signal);
        const messages = [];
        if (req.system) messages.push({ role: 'system', content: req.system });
        messages.push({ role: 'user', content: req.user });

        const inputTokens = await countTokens(this.ctx, messages.map((m) => m.content).join('\n'));
        const maxTokens = deriveMaxTokens(inputTokens, req.maxTokens ?? this.config.maxTokens, req.expectedOutputRatio);
        const temperature = req.temperature ?? this.config.temperature ?? 0.2;
        const timeoutMs = (Number(this.config.timeout) || 120) * 1000;
        const retries = Math.max(0, Number(this.config.retries) ?? 2);

        const meta = { mode: this.config.mode, inputTokens, maxTokens, temperature, attempts: 0 };
        /** @type {string} */
        let lastError = '';

        for (let attempt = 0; attempt <= retries; attempt++) {
            // 用户点了「终止」就不要继续重试了
            if (signal?.aborted) return { ok: false, text: '', error: ABORT_MESSAGE, meta, aborted: true };

            meta.attempts = attempt + 1;
            /** 每次尝试前清空，避免把上一轮的提示带进来。 */
            this.lastNotice = '';
            try {
                const text = await withAttemptAbort(
                    (attemptSignal) => this._dispatch(
                        messages,
                        {
                            maxTokens,
                            temperature,
                            jsonSchema: this.config.useJsonSchema ? req.jsonSchema : undefined,
                            signal: attemptSignal,
                        },
                    ),
                    timeoutMs,
                    `${this.label} `,
                    signal,
                );
                if (!text || !text.trim()) {
                    lastError = '模型返回了空内容';
                    // 空返回通常是瞬时问题，值得重试
                    continue;
                }
                // 把过程中的兼容性提示（例如自动去掉了 JSON Schema）带回去，让上层写进日志
                if (this.lastNotice) meta.notice = this.lastNotice;
                return { ok: true, text, meta };
            } catch (e) {
                // 中断是用户主动要求的，不该被当成失败去重试
                if (isAbortError(e) || signal?.aborted) {
                    return { ok: false, text: '', error: ABORT_MESSAGE, meta, aborted: true };
                }
                lastError = describeError(e) || '请求失败（异常对象没有可读信息）';
                console.warn(`[战斗掷骰] ${this.label} 第 ${attempt + 1} 次请求失败：${lastError}`);
                if (attempt < retries) {
                    // 退避：1s, 2s, 4s…（封顶 8s）。等待期间也要能被打断。
                    await sleep(Math.min(8000, 1000 * 2 ** attempt), signal);
                    if (signal?.aborted) return { ok: false, text: '', error: ABORT_MESSAGE, meta, aborted: true };
                }
            }
        }

        return { ok: false, text: '', error: lastError || '请求失败但没有拿到任何错误信息（请查看控制台）', meta };
    }

    /**
     * 按配置分发到具体传输方式。
     * @param {Array<{role: string, content: string}>} messages
     * @param {{maxTokens: number, temperature: number, jsonSchema?: object, signal?: AbortSignal}} opts
     * @returns {Promise<string>}
     */
    async _dispatch(messages, opts) {
        const mode = this.config.mode || 'tavern-helper';
        switch (mode) {
            case 'tavern-helper':
                return this._viaTavernHelper(messages, opts, true);
            case 'main':
                return this._viaTavernHelper(messages, opts, false);
            case 'profile':
                return this._viaProfile(messages, opts);
            case 'custom':
                return this._viaFetch(messages, opts);
            default:
                throw new Error(`未知的通道模式：${mode}`);
        }
    }

    /**
     * 走酒馆助手 generateRaw。
     * @param {Array<{role: string, content: string}>} messages
     * @param {{maxTokens: number, temperature: number, jsonSchema?: object}} opts
     * @param {boolean} useCustomApi
     * @returns {Promise<string>}
     */
    async _viaTavernHelper(messages, opts, useCustomApi) {
        const helper = getTavernHelper();
        if (!helper || typeof helper.generateRaw !== 'function') {
            throw new Error('未检测到酒馆助手（TavernHelper），请安装 JS-Slash-Runner 扩展，或把通道模式改成「直连」');
        }

        /** @type {Record<string, any>} */
        const params = {
            ordered_prompts: messages.map((m) => ({ role: m.role, content: m.content })),
            should_silence: true,
            should_stream: false,
        };

        // 酒馆助手支持 signal，能真正中断在途请求（用户点「终止」时用得上）
        if (opts.signal) params.signal = opts.signal;

        if (opts.jsonSchema) {
            params.json_schema = opts.jsonSchema;
        }
        // 联网搜索：把 tools 透传给酒馆助手
        if (opts.tools) params.tools = opts.tools;

        if (useCustomApi) {
            const url = toText(this.config.apiUrl);
            const model = toText(this.config.model);
            if (url && model) {
                params.custom_api = {
                    apiurl: url,
                    key: toText(this.config.apiKey),
                    model,
                    source: 'custom',
                    max_tokens: opts.maxTokens,
                    temperature: opts.temperature,
                };
            } else if (this.config.profileId) {
                // 用酒馆助手自定义连接时，允许指向一个代理预设
                params.custom_api = { proxy_preset: toText(this.config.profileName), max_tokens: opts.maxTokens, temperature: opts.temperature };
            }
        }

        const response = await helper.generateRaw(params);
        const text = extractContent(response);
        if (!text) throw new Error('酒馆助手返回内容为空（可能是模型拒绝或 schema 不匹配）');
        return text;
    }

    /**
     * 走连接配置（ConnectionManagerRequestService）。
     * @param {Array<{role: string, content: string}>} messages
     * @param {{maxTokens: number}} opts
     * @returns {Promise<string>}
     */
    async _viaProfile(messages, opts) {
        const service = this.ctx?.ConnectionManagerRequestService;
        if (!service || typeof service.sendRequest !== 'function') {
            throw new Error('当前酒馆不支持连接配置服务（ConnectionManagerRequestService）');
        }
        const profileId = toText(this.config.profileId);
        if (!profileId) throw new Error('通道模式为「连接配置」但没选具体配置');

        // 第 4 参是可选配置包。不同酒馆版本支持的字段不一致，
        // 所以只在确实拿到 signal 时才传，避免老版本因为多一个参数报错。
        const extra = opts.signal ? { signal: opts.signal } : undefined;
        const response = extra
            ? await service.sendRequest(profileId, messages, opts.maxTokens, extra)
            : await service.sendRequest(profileId, messages, opts.maxTokens);
        // 响应形状不统一，必须两种都探
        const text = extractContent(response);
        if (!text) throw new Error('连接配置返回内容为空（可能是该配置的模型不支持当前请求）');
        return text;
    }

    /**
     * 直连 OpenAI 兼容端点。
     *
     * 带一个重要的兼容处理：很多模型服务商**不支持 `response_format: json_schema`**
     *（典型是 Gemini 系，以及不少第三方中转），收到这个参数会直接返回 400
     * `INVALID_ARGUMENT / Request contains an invalid argument`。
     * 这种情况下自动去掉该参数重试一次 —— 提示词里本来就要求了「只输出 JSON」，
     * 只是少了服务端强约束，解析成功率会低一点但仍然可用。
     *
     * @param {Array<{role: string, content: string}>} messages
     * @param {{maxTokens: number, temperature: number, jsonSchema?: object}} opts
     * @returns {Promise<string>}
     */
    async _viaFetch(messages, opts) {
        const url = buildChatEndpoint(this.config.apiUrl);
        if (!url) throw new Error('通道模式为「直连」但没填 API 地址');
        const model = toText(this.config.model);
        if (!model) throw new Error('通道模式为「直连」但没填模型名');

        /** @type {Record<string, string>} */
        const headers = { 'Content-Type': 'application/json' };
        if (toText(this.config.apiKey)) headers.Authorization = `Bearer ${toText(this.config.apiKey)}`;

        /**
         * 发一次请求，返回原始 Response（不抛 HTTP 错误，交给调用方判断）。
         * @param {boolean} withJsonSchema
         */
        const send = async (withJsonSchema) => {
            /** @type {Record<string, any>} */
            const body = {
                model,
                messages,
                max_tokens: opts.maxTokens,
                temperature: opts.temperature,
                stream: false,
            };
            if (opts.tools) body.tools = opts.tools;
            if (withJsonSchema && opts.jsonSchema) {
                body.response_format = {
                    type: 'json_schema',
                    json_schema: {
                        name: opts.jsonSchema.name,
                        schema: opts.jsonSchema.value,
                        strict: opts.jsonSchema.strict !== false,
                    },
                };
            }
            // 把用户的终止信号接到 fetch 上：点「终止」能真正掐断在途请求
            return fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: opts.signal });
        };

        /** 读错误详情。 */
        const readError = async (/** @type {Response} */ res) => {
            try {
                return (await res.text()).slice(0, 400);
            } catch {
                return '';
            }
        };

        let res = await send(Boolean(opts.jsonSchema));

        // 每个错误 response 只消费一次 body，检测降级与最终诊断共用详情。
        let detail = res.ok ? '' : await readError(res);
        // JSON Schema 不被支持 → 去掉重试一次
        if (!res.ok && opts.jsonSchema && isJsonSchemaUnsupported(res.status, detail)) {
            console.warn(
                `[战斗掷骰] 端点不接受 response_format（HTTP ${res.status}），` +
                    `已自动去掉 JSON Schema 约束重试。若仍解析失败，请到设置里关掉「强制 JSON Schema」。`,
            );
            this.lastNotice = '端点不支持 JSON Schema，已自动改用纯提示词约束';
            res = await send(false);
            detail = res.ok ? '' : await readError(res);
        }

        if (!res.ok) {
            throw new Error(`HTTP ${res.status}${detail ? ` — ${detail}` : ''}`);
        }

        const data = await res.json();
        const text = extractContent(data);
        if (!text) throw new Error('直连端点返回内容为空');
        return text;
    }

    /**
     * 单轮对话式问答（没有 system 分层的模型用这个）。
     * @param {string} system
     * @param {string} user
     * @param {object} [extra]
     * @returns {Promise<{ok: boolean, text: string, error?: string, meta: object}>}
     */
    ask(system, user, extra = {}) {
        return this.complete({ system, user, ...extra });
    }

    /**
     * 带**联网搜索**的问答。
     *
     * 做法：给请求加 `tools: [{ type: 'web_search' }]`。这是 OpenAI 的联网搜索工具约定，
     * 智谱 GLM 系列与不少中转也认这个字段 —— 好处是**用户不用再申请搜索 API 的 key**。
     *
     * ⚠️ 不是所有端点都支持。不支持的会返回 400。调用方应当准备回落方案
     *（换成专用搜索 API，或直接告诉用户这个模型不支持联网）。
     *
     * @param {{system: string, user: string, signal?: AbortSignal, maxTokens?: number, temperature?: number}} req
     * @returns {Promise<{ok: boolean, text: string, error?: string, meta: object, unsupported?: boolean}>}
     */
    async search(req) {
        const messages = [];
        if (req.system) messages.push({ role: 'system', content: req.system });
        messages.push({ role: 'user', content: req.user });

        const inputTokens = await countTokens(this.ctx, messages.map((m) => m.content).join('\n'));
        const maxTokens = deriveMaxTokens(inputTokens, req.maxTokens ?? this.config.maxTokens, 1.0);
        const timeoutMs = (Number(this.config.timeout) || 120) * 1000;
        const temperature = req.temperature ?? this.config.temperature ?? 0.3;

        try {
            const text = await withTimeout(
                this._dispatch(messages, {
                    maxTokens,
                    temperature,
                    signal: req.signal,
                    // 联网搜索开关
                    tools: [{ type: 'web_search' }],
                }),
                timeoutMs,
                `${this.label}（联网搜索） `,
            );
            if (!text || !text.trim()) {
                return { ok: false, text: '', error: '模型返回了空内容', meta: {} };
            }
            return { ok: true, text, meta: { inputTokens, maxTokens } };
        } catch (e) {
            const message = describeError(e);
            return {
                ok: false,
                text: '',
                error: message,
                meta: {},
                // 帮调用方判断「是模型不支持联网」还是「别的问题」
                unsupported: looksLikeToolsUnsupported(message),
            };
        }
    }

    /**
     * 拉取这条通道可用的模型列表。
     *
     * 三条路径，按可用性依次尝试：
     *  1. 模式为「直连」，或填了 apiUrl → 直接打 OpenAI 兼容的 `/models`
     *  2. 酒馆助手的 `getModelList({apiurl, key})`（本机已确认存在）
     *  3. 走不通就返回空列表 + 可读原因，让用户手填
     *
     * @returns {Promise<{ok: boolean, models: string[], source: string, error?: string}>}
     */
    async listModels() {
        const apiUrl = toText(this.config.apiUrl);
        const apiKey = toText(this.config.apiKey);
        const helper = getTavernHelper();

        // ---- 路径 1：直连 ----
        if (apiUrl) {
            const endpoint = buildModelsEndpoint(apiUrl);
            try {
                /** @type {Record<string, string>} */
                const headers = {};
                if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
                const res = await fetch(endpoint, { method: 'GET', headers });
                if (!res.ok) {
                    let detail = '';
                    try {
                        detail = (await res.text()).slice(0, 200);
                    } catch {
                        /* 忽略 */
                    }
                    throw new Error(`HTTP ${res.status}${detail ? ` — ${detail}` : ''}`);
                }
                const models = extractModelIds(await res.json());
                if (models.length) return { ok: true, models, source: 'GET /models' };
                return {
                    ok: false,
                    models: [],
                    source: 'GET /models',
                    error: '端点返回了内容，但里面没有可识别的模型名',
                };
            } catch (e) {
                const message = describeError(e);
                // 直连失败时不要立刻放弃：如果装了酒馆助手，让它代发可能能绕过 CORS
                if (!(helper && typeof helper.getModelList === 'function')) {
                    return { ok: false, models: [], source: 'GET /models', error: message };
                }
                console.warn(`[战斗掷骰] 直连拉取模型失败（${message}），改用酒馆助手重试`);
            }
        }

        // ---- 路径 2：酒馆助手 ----
        if (helper && typeof helper.getModelList === 'function') {
            try {
                const result = await helper.getModelList(apiUrl ? { apiurl: apiUrl, key: apiKey } : undefined);
                const models = extractModelIds(result);
                if (models.length) return { ok: true, models, source: '酒馆助手' };
                return { ok: false, models: [], source: '酒馆助手', error: '酒馆助手没有返回任何模型' };
            } catch (e) {
                return {
                    ok: false,
                    models: [],
                    source: '酒馆助手',
                    error: describeError(e),
                };
            }
        }

        // ---- 路径 3：都给不出 ----
        return {
            ok: false,
            models: [],
            source: 'none',
            error: apiUrl
                ? '拿不到模型列表。可能是该端点不支持 /models，或浏览器跨域限制（CORS）。请手动填写模型名。'
                : '请先填写 API 地址，或把通道模式改成「酒馆助手」再拉取。',
        };
    }
}

/** 简易 sleep。等待期间可被 AbortSignal 打断。 */
function sleep(ms, signal) {
    return new Promise((resolve) => {
        if (signal?.aborted) {
            resolve(undefined);
            return;
        }
        const timer = setTimeout(() => {
            signal?.removeEventListener?.('abort', onAbort);
            resolve(undefined);
        }, ms);
        const onAbort = () => {
            clearTimeout(timer);
            resolve(undefined);
        };
        signal?.addEventListener?.('abort', onAbort, { once: true });
    });
}

/** 用户主动中断时统一使用的错误文案。 */
export const ABORT_MESSAGE = '已被用户终止';

/**
 * 判断一个报错是不是「这个模型 / 端点不支持联网搜索工具」。
 *
 * 用途：让上层能区分「模型不支持联网」和「网络挂了 / key 错了」——
 * 前者应当提示用户换模型或改用专用搜索 API，后者应当提示排查配置。
 *
 * 注意这个函数是**函数声明**（会被提升），因为 `search()` 在文件靠前的位置就用到它。
 *
 * @param {string} message
 * @returns {boolean}
 */
export function looksLikeToolsUnsupported(message) {
    const text = String(message ?? '').toLowerCase();
    if (!text) return false;
    if (text.includes('web_search')) return true;
    return (
        text.includes('tool') &&
        (text.includes('not support') ||
            text.includes('unsupported') ||
            text.includes('invalid') ||
            text.includes('unknown') ||
            text.includes('unrecognized'))
    );
}

/**
 * 判断一个错误是不是「中断」导致的。
 * 中断与网络失败必须区分开 —— 前者不该重试，也不该报成错误。
 * @param {any} error
 * @returns {boolean}
 */
export function isAbortError(error) {
    if (!error) return false;
    const name = String(error.name ?? '');
    const message = String(error.message ?? error);
    return (
        name === 'AbortError' ||
        message.includes('AbortError') ||
        message.includes('aborted') ||
        message.includes(ABORT_MESSAGE)
    );
}

// ---------------------------------------------------------------------------
// 响应解析
// ---------------------------------------------------------------------------

/**
 * 从模型输出里抠出 JSON。
 *
 * 模型不听话的方式五花八门，这里按「破坏性从小到大」依次尝试：
 *  1. 直接 JSON.parse
 *  2. 去掉 ```json 围栏
 *  3. 括号配平扫描：**尝试所有候选片段**，挑解析得下去、且内容最丰富的那个
 *  4. 修掉尾随逗号 / 单引号 / 未闭合括号（含截断丢弃残缺尾巴）
 *
 * @param {string} text
 * @returns {{ok: boolean, value?: any, error?: string, strategy?: string}}
 */
export function parseJsonLoose(text) {
    const raw = String(text ?? '').trim();
    if (!raw) return { ok: false, error: '内容为空' };

    // 1. 直接解析
    try {
        return { ok: true, value: JSON.parse(raw), strategy: 'direct' };
    } catch {
        /* 继续 */
    }

    // 2. 去围栏
    const fence = raw.match(/```(?:json|JSON)?\s*([\s\S]*?)```/);
    const fenceInner = fence ? fence[1].trim() : '';

    /**
     * 按「信息量」给解析结果打分。
     *
     * 关键点是**对象要压过数组**：候选片段里常常有一个外层对象和一个内层数组，
     * 而我们要的永远是外层对象（`{"list":[...]}` 而不是 `[...]`）。
     * 早期版本对两者用同一套 `1 + 元素数` 计分，导致数组因为元素多而胜出，
     * 结果只解析出一个裸数组、上层字段全丢。
     */
    const score = (/** @type {any} */ value) => {
        if (Array.isArray(value)) return 1 + value.length;
        if (value && typeof value === 'object') return (1 + Object.keys(value).length) * 10;
        return 0;
    };

    /** @type {Array<{value: any, strategy: string}>} */
    const parsedCandidates = [];

    /** 尝试把一个文本片段解析成 JSON，成功就收集起来。 */
    const tryParse = (/** @type {string} */ candidate, /** @type {string} */ strategy) => {
        if (!candidate) return;
        try {
            parsedCandidates.push({ value: JSON.parse(candidate), strategy });
            return;
        } catch {
            /* 试修复 */
        }
        const repaired = repairJson(candidate);
        if (repaired.ok) parsedCandidates.push({ value: repaired.value, strategy: `${strategy}+repair` });
    };

    // 围栏内的文本本身就是最好的候选；同时不要丢掉围栏外的内容
    if (fenceInner) tryParse(fenceInner, 'fence');
    tryParse(raw, 'raw');

    // 3. 括号配平的候选片段（可能有好几个嵌套层级）
    for (const candidate of extractBalancedCandidates(fenceInner || raw)) {
        tryParse(candidate, 'balanced');
    }

    if (parsedCandidates.length) {
        // 选信息量最大的那个：截断场景下内层对象会先配平，
        // 但外层（含 system/allies 等字段）才是我们真正要的
        parsedCandidates.sort((a, b) => score(b.value) - score(a.value));
        const best = parsedCandidates[0];
        return { ok: true, value: best.value, strategy: best.strategy };
    }

    // 4. 整体修复（含截断处理）
    const repaired = repairJson(raw);
    if (repaired.ok) return { ...repaired, strategy: 'repair' };

    return { ok: false, error: `无法解析为 JSON：${repaired.error ?? '格式错误'}` };
}

/**
 * 扫描出所有括号配平的 JSON 片段（跳过字符串里的括号），按起始位置排序。
 *
 * ⚠️ 为什么要返回「所有」而不是「第一个」：
 * 模型输出被截断时（`{"system":{...},"allies":[{"name":"甲`），
 * 内层对象 `{"name":"测试"}` 会先配平，如果只取第一个，就会把内层对象
 * 当成整个结果 —— 数据看起来「解析成功」但内容完全不对，比直接报错更难查。
 * 所以要拿到全部候选，再挑解析得下去、且信息量最大的那个。
 *
 * @param {string} text
 * @returns {string[]}
 */
export function extractBalancedCandidates(text) {
    const source = String(text ?? '');
    /** @type {Array<{start: number, text: string}>} */
    const found = [];
    const starts = ['{', '['];

    for (let i = 0; i < source.length; i++) {
        if (!starts.includes(source[i])) continue;
        const open = source[i];
        const close = open === '{' ? '}' : ']';
        let depth = 0;
        let inString = false;
        let escaped = false;
        for (let j = i; j < source.length; j++) {
            const ch = source[j];
            if (escaped) {
                escaped = false;
                continue;
            }
            if (ch === '\\') {
                escaped = true;
                continue;
            }
            if (ch === '"') {
                inString = !inString;
                continue;
            }
            if (inString) continue;
            if (ch === open) depth++;
            else if (ch === close) {
                depth--;
                if (depth === 0) {
                    found.push({ start: i, text: source.slice(i, j + 1) });
                    break;
                }
            }
        }
    }

    return found.map((f) => f.text);
}

/**
 * 扫描出第一个括号配平的 JSON 片段（跳过字符串里的括号）。
 *
 * 注意这里的「第一个」是**语法层面**的第一个。要解析模型输出请用
 * `parseJsonLoose`（它会尝试所有候选并挑最好的），不要直接用这个函数。
 *
 * @param {string} text
 * @returns {string|null}
 */
export function extractBalanced(text) {
    return extractBalancedCandidates(text)[0] ?? null;
}

/**
 * 尽力修复常见的 JSON 语法错误。
 * @param {string} text
 * @returns {{ok: boolean, value?: any, error?: string}}
 */
export function repairJson(text) {
    let s = String(text ?? '').trim();

    // 去掉前后废话：从第一个 { 或 [ 开始，到最后一个 } 或 ] 结束
    const firstBrace = s.search(/[{[]/);
    if (firstBrace > 0) s = s.slice(firstBrace);
    const lastBrace = Math.max(s.lastIndexOf('}'), s.lastIndexOf(']'));
    if (lastBrace >= 0 && lastBrace < s.length - 1) s = s.slice(0, lastBrace + 1);

    // 尾随逗号
    s = s.replace(/,\s*([}\]])/g, '$1');
    // 单引号键值（只在明显是键的时候替换，避免破坏中文引号）
    s = s.replace(/([{,]\s*)'([^'\n]+)'(\s*:)/g, '$1"$2"$3');
    // 注释
    s = s.replace(/\/\/[^\n\r]*/g, '');
    s = s.replace(/\/\*[\s\S]*?\*\//g, '');
    // 中文标点误用
    s = s.replace(/：/g, ':').replace(/，/g, ',');

    try {
        return { ok: true, value: JSON.parse(s) };
    } catch (e) {
        // 最后再试：补全未闭合的括号
        const completed = closeUnbalanced(s);
        if (completed !== s) {
            try {
                return { ok: true, value: JSON.parse(completed) };
            } catch {
                /* 落到失败 */
            }
        }
        return { ok: false, error: describeError(e) };
    }
}

/**
 * 补全未闭合的括号（模型输出被 max_tokens 截断时常见）。
 *
 * 策略是「先截断到最后一个完整的键值边界，再补齐括号」：
 *  1. 顺序扫描，把**已完成的键值对**（`"key": <值>`）记进 `completed`。
 *     一个值算「完成」的条件是它闭合后紧跟 `,`、`}`、`]` 或到达末尾 ——
 *     否则说明它其实是残缺的（例如 `"name":"甲` 里那个未闭合的字符串）。
 *  2. 从最后一个完整键值对之后截断，丢掉残缺的尾巴。
 *  3. 重新扫描补齐仍然缺失的括号。
 *
 * 例：`{"system":{"name":"测试"},"allies":[{"name":"甲"`
 *      → 最后一个完整键值对是 `"system":{...}`（紧跟 `,`）
 *      → 截断成 `{"system":{"name":"测试"}` → 补齐 → `{"system":{"name":"测试"}}`
 *
 * 补不出内容时退回**括号配平扫描**（从第一个 `{` / `[` 开始，扫到末尾直接补齐），
 * 这对「数组写到一半就断」的情况更有效：`{"list":[1,2` → `{"list":[1,2]}`。
 *
 * @param {string} text
 * @returns {string}
 */
export function closeUnbalanced(text) {
    const source = String(text ?? '');

    /** 扫描 source，返回「最后一个完整键值对的结束下标」。 */
    const findLastCompleteMember = () => {
        let i = 0;
        /** @type {number} */
        let completed = -1;

        /** 跳过空白 */
        const skipWs = () => {
            while (i < source.length && /\s/.test(source[i])) i++;
        };
        /** 值之后必须紧跟我们才认为它是完整的 */
        const followedByDelimiter = () => {
            let k = i;
            while (k < source.length && /\s/.test(source[k])) k++;
            if (k >= source.length) return true;
            return ',}]'.includes(source[k]);
        };
        /** 读一个字符串（假定 source[i] === '"' 或 '}' 作为终止符）。 */
        const readString = (/** @type {string} */ terminator) => {
            i++; // 跳过开引号
            while (i < source.length && source[i] !== terminator) {
                if (source[i] === '\\') i++;
                i++;
            }
            const closed = i < source.length;
            if (closed) i++;
            return closed;
        };
        /** 读一个对象或数组。返回是否完整闭合。 */
        const readContainer = () => {
            const stack = [source[i] === '{' ? '}' : ']'];
            i++;
            while (i < source.length && stack.length) {
                const ch = source[i];
                if (ch === '"') {
                    readString('"');
                    continue;
                }
                if (ch === '{' || ch === '[') {
                    stack.push(ch === '{' ? '}' : ']');
                    i++;
                    continue;
                }
                if (ch === '}' || ch === ']') {
                    if (ch === stack[stack.length - 1]) {
                        stack.pop();
                        i++;
                        continue;
                    }
                    // 括号不匹配：当作残缺处理，避免误判
                    return false;
                }
                i++;
            }
            return stack.length === 0;
        };

        skipWs();
        if (source[i] !== '{' && source[i] !== '[') return -1;
        const rootClose = source[i] === '{' ? '}' : ']';
        i++;

        while (i < source.length) {
            skipWs();
            if (i >= source.length) break;
            if (source[i] === rootClose) break; // 根容器正常结束

            // 键
            if (source[i] !== '"') {
                i++;
                continue;
            }
            if (!readString('"')) break;
            skipWs();
            if (source[i] !== ':') {
                i++;
                continue;
            }
            i++; // 跳过冒号

            // 值
            skipWs();
            if (i >= source.length) break;
            const ch = source[i];
            if (ch === '{' || ch === '[') {
                const ok = readContainer();
                if (!ok) break;
            } else if (ch === '"') {
                if (!readString('"')) break;
            } else {
                // 裸标量
                const start = i;
                while (i < source.length && !/[,}\]\s]/.test(source[i])) i++;
                if (i === start) break; // 认不出来的东西，停止
            }

            if (followedByDelimiter()) completed = i;
            skipWs();
            if (source[i] === ',') {
                i++;
                continue;
            }
        }

        return completed;
    };

    const cut = findLastCompleteMember();
    let body = cut >= 0 ? source.slice(0, cut) : source;
    body = body.replace(/[,\s]+$/, '');
    body = body.replace(/:\s*$/, ': null');

    // 补齐仍缺失的括号
    let inString = false;
    let escaped = false;
    /** @type {string[]} */
    const remaining = [];
    for (let i = 0; i < body.length; i++) {
        const ch = body[i];
        if (escaped) {
            escaped = false;
            continue;
        }
        if (ch === '\\') {
            escaped = true;
            continue;
        }
        if (ch === '"') {
            inString = !inString;
            continue;
        }
        if (inString) continue;
        if (ch === '{') remaining.push('}');
        else if (ch === '[') remaining.push(']');
        else if (ch === '}' || ch === ']') remaining.pop();
    }

    let out = body;
    if (inString) out += '"';
    while (remaining.length) out += remaining.pop();
    return out;
}

/**
 * 把模型输出归一化成「战力体系对象」。
 *
 * 模型可能返回：
 *   - 直接的体系对象 `{system, allies, enemies}`
 *   - 包一层 `{powerSystem: {...}}` 或 `{data: {...}}`
 *   - 只有 `{combatants: [...]}`
 *   - 干脆吐了一段 `<Combat_block>` 文本
 *
 * @param {string} text
 * @param {(blockText: string) => object|null} combBlockParser 传入 parseCombatBlock，避免这里反向依赖
 * @returns {{ok: boolean, value?: object, error?: string, strategy?: string}}
 */
export function extractPowerSystem(text, combBlockParser) {
    const raw = String(text ?? '');

    // 先试 JSON
    const parsed = parseJsonLoose(raw);
    if (parsed.ok && parsed.value && typeof parsed.value === 'object') {
        const v = parsed.value;
        // 去掉常见的包装层
        const candidate =
            (v.powerSystem && typeof v.powerSystem === 'object' && v.powerSystem) ||
            (v.data && typeof v.data === 'object' && !Array.isArray(v.data) && v.data) ||
            (v.result && typeof v.result === 'object' && v.result) ||
            v;
        return { ok: true, value: candidate, strategy: parsed.strategy };
    }

    // 再试 Combat_block 文本
    if (/<Combat_block>/i.test(raw) && typeof combBlockParser === 'function') {
        const block = combBlockParser(raw);
        if (block) return { ok: true, value: block, strategy: 'combat_block' };
    }

    return { ok: false, error: parsed.error ?? '未找到可用的战力数据' };
}

/**
 * 把模型输出归一化成 P2 的 diff 对象。
 * @param {string} text
 * @returns {{ok: boolean, value?: object, error?: string, strategy?: string}}
 */
export function extractDiff(text) {
    const parsed = parseJsonLoose(text);
    if (!parsed.ok || !parsed.value || typeof parsed.value !== 'object') {
        return { ok: false, error: parsed.error ?? '未找到 diff 数据' };
    }
    const v = parsed.value;
    const candidate =
        (v.diff && typeof v.diff === 'object' && v.diff) ||
        (v.changes && typeof v.changes === 'object' && v.changes) ||
        (v.data && typeof v.data === 'object' && !Array.isArray(v.data) && v.data) ||
        v;

    // 归一化每个字段为数组
    return {
        ok: true,
        value: {
            added: Array.isArray(candidate.added) ? candidate.added : [],
            updated: Array.isArray(candidate.updated) ? candidate.updated : [],
            removed: Array.isArray(candidate.removed) ? candidate.removed : [],
            hpChanges: Array.isArray(candidate.hpChanges)
                ? candidate.hpChanges
                : Array.isArray(candidate.hp_changes)
                  ? candidate.hp_changes
                  : [],
            notes: toText(candidate.notes ?? candidate.备注),
        },
        strategy: parsed.strategy,
    };
}
