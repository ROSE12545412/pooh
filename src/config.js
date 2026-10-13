/**
 * tavern-dice / src/config.js
 * ---------------------------------------------------------------------------
 * 扩展身份、默认设置、以及「设置读取与深补全」。
 *
 * 注意这里的关键约定（来自本地 API 手册的实测结论）：
 *  - `extensionSettings` 的键名与 manifest 的 display_name 无关，用我们自己的 ID。
 *  - 设置**必须手动落盘**（`saveSettingsDebounced()`），不会自动保存。
 *  - 老用户升级后新增设置项要有默认值，所以读取时必须逐字段深补全。
 */

/** 扩展 ID，用作 extensionSettings / chatMetadata 的键。 */
export const EXT_ID = 'tavern-dice';

/** 扩展显示名。 */
export const EXT_NAME = '战斗掷骰';

/** 日志前缀。 */
export const TAG = `[${EXT_NAME}]`;

/**
 * 从 `import.meta.url` 推导扩展所在目录名。
 *
 * 不要写死目录名 —— 用户可能把文件夹改名（例如装成 `tavern-dice-main`），
 * 也可能从 `third-party/` 或其它用户目录下加载。
 * 本插件目前没有依赖这个值做任何 IO（配置都存在 extensionSettings 里），
 * 它只用于日志与调试，所以推导失败也不影响功能。
 *
 * @param {string} moduleUrl `import.meta.url`
 * @returns {string}
 */
export function deriveExtensionFolder(moduleUrl) {
    const url = String(moduleUrl ?? '');

    // 收集 `extensions/` 之后的所有路径段，取第一个像目录名的（不含 `.`）
    const segments = url.split('/').filter(Boolean);
    const extIndex = segments.indexOf('extensions');
    if (extIndex >= 0) {
        for (let i = extIndex + 1; i < segments.length; i++) {
            const seg = segments[i].split(/[?#]/)[0]; // 去掉 query / hash
            // 跳过 `third-party` 这类组织层级；遇到带 `.` 的说明已经是文件名了
            if (seg === 'third-party') continue;
            if (!seg || seg.includes('.')) break;
            return seg;
        }
    }

    // 退而求其次：匹配任意 `xxx/extensions/<name>/index.js` 形态
    const match = url.match(/\/extensions\/(?:third-party\/)?([^/?#]+)\//);
    if (match && !match[1].includes('.')) return match[1];

    return EXT_ID;
}

/**
 * 战斗模型 P2 通道的默认配置。
 * @returns {object}
 */
export function defaultChannel() {
    return {
        /**
         * 通道类型：
         *  - 'tavern-helper'  走酒馆助手 generateRaw（功能最强，支持 json_schema + custom_api）
         *  - 'profile'        走连接配置 ConnectionManagerRequestService
         *  - 'custom'         直连 OpenAI 兼容端点（需要自己填 URL/Key/Model）
         *  - 'main'           复用当前主连接（不推荐，会被预设污染）
         */
        mode: 'tavern-helper',
        /** mode='profile' 时使用 */
        profileId: '',
        /** mode='custom' 时使用 */
        apiUrl: '',
        apiKey: '',
        model: '',
        /** 采样参数 */
        temperature: 0.2,
        /** 最大输出 token（0 = 自动根据输入估算） */
        maxTokens: 8192,
        /** 单次请求超时（秒） */
        timeout: 120,
        /** 失败重试次数 */
        retries: 2,
        /** 是否要求模型按 JSON Schema 输出（关掉则只靠提示词约束） */
        useJsonSchema: true,
        /** 是否使用流式（这里一律 false：我们需要完整 JSON 才能解析） */
        stream: false,
    };
}

/**
 * 已知的大型模型服务商域名（含国内常见的官方/半官方网关）。
 *
 * 用途：判断用户填的地址是不是「第三方中转站」。
 * 中转站往往是按次/按分钟限流的共享额度 —— 对聊天够用，
 * 战斗模型会连续处理回合决策，可能触发服务商的调用限额。
 */
export const KNOWN_PROVIDER_HOSTS = Object.freeze([
    // 国际
    'api.openai.com',
    'api.anthropic.com',
    'generativelanguage.googleapis.com',
    'openrouter.ai',
    'api.deepseek.com',
    'api.mistral.ai',
    'api.cohere.ai',
    'api.groq.com',
    'api.x.ai',
    'api.together.xyz',
    'api.perplexity.ai',
    'dashscope.aliyuncs.com',
    // 国内
    'api.siliconflow.cn',
    'api.siliconflow.com',
    'open.bigmodel.cn',
    'api.moonshot.cn',
    'api.minimax.chat',
    'ark.cn-beijing.volces.com',
    'qianfan.baidubce.com',
    'api.hunyuan.cloud.tencent.com',
    'dashscope.aliyuncs.com',
    'api.baichuan-ai.com',
    'api.lingyiwanwu.com',
    'api.stepfun.com',
    // 本地
    'localhost',
    '127.0.0.1',
]);

/**
 * 判断一个 API 地址是不是「第三方中转 / 公益站」。
 *
 * ⚠️ 只做**提示**，不做拦截：用户完全有权用任何端点，
 * 而且有些自建网关跑在自己域名上看起来也像中转站。
 * 这里只是把风险摆到台面上，让人自己决定。
 *
 * @param {string} apiUrl
 * @returns {{known: boolean, host: string, isLocal: boolean}}
 */
export function describeEndpoint(apiUrl) {
    const raw = String(apiUrl ?? '').trim();
    if (!raw) return { known: false, host: '', isLocal: false };
    let host = '';
    try {
        host = new URL(raw).hostname.toLowerCase();
    } catch {
        // 用户可能只填了 `api.x.com/v1`（没带协议），手工抠一下主机名
        const match = raw.match(/^(?:https?:\/\/)?([^/:?#]+)/i);
        host = (match?.[1] ?? '').toLowerCase();
    }
    const isLocal = host === 'localhost' || host === '127.0.0.1' || host.endsWith('.local') || /^192\.168\./.test(host);
    const known = KNOWN_PROVIDER_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
    return { known, host, isLocal };
}

/**
 * 根据当前酒馆环境挑一个**开箱即用**的通道默认值。
 *
 * 为什么需要这个（真实设计错误）：
 *   最初把默认模式写死成 `tavern-helper`，但它依赖用户安装另一个扩展。
 *   没装的人打开设置就会看到「不可用」，得自己猜要装什么、该改成哪个模式。
 *   正确做法是按环境自动选一个当下就能用的：
 *     有连接配置 → 用连接配置（Key 已存在酒馆里，不用另填）
 *     没有配置   → 直连（手填 URL/Key/Model，不依赖任何其它扩展）
 *     只有助手   → 用助手
 *
 * @param {any} ctx
 * @returns {{mode: string, profileId: string, reason: string}}
 */
export function pickDefaultChannel(ctx) {
    const profiles = Array.isArray(ctx?.extensionSettings?.connectionManager?.profiles)
        ? ctx.extensionSettings.connectionManager.profiles.filter((/** @type {any} */ p) => p?.id)
        : [];
    const helper = /** @type {any} */ (globalThis)?.TavernHelper;

    if (profiles.length) {
        // 战斗决策优先选择响应快的配置。
        const preferred = profiles.find((/** @type {any} */ p) =>
            /flash|mini|turbo|lite|haiku|small/i.test(`${p.name} ${p.model}`),
        ) ?? profiles[0];
        return {
            mode: 'profile',
            profileId: preferred.id,
            reason: `检测到 ${profiles.length} 个连接配置，已自动选用「${preferred.name}」`,
        };
    }

    if (helper && typeof helper.generateRaw === 'function') {
        return {
            mode: 'tavern-helper',
            profileId: '',
            reason: '未找到连接配置，但你装了 JS-Slash-Runner（酒馆助手），已自动选用它',
        };
    }

    return {
        mode: 'custom',
        profileId: '',
        reason: '未检测到连接配置或酒馆助手，请手动填写 API 地址 / Key / 模型',
    };
}

/**
 * 全部默认设置。
 * @returns {object}
 */
export function defaultSettings() {
    return {
        /** 数据模型版本，未来做迁移用 */
        schemaVersion: 1,

        /**
         * 是否已经做过「环境自适应」。
         * 只做一次 —— 之后用户改过任何设置都不会被自动覆盖。
         */
        channelsAutoConfigured: false,

        /** 总开关 */
        enabled: true,
        /** 是否显示悬浮球 */
        showBall: true,
        ballSize: 64,
        /** 悬浮球位置（像素，相对视口左上角） */
        ballPosition: { x: 24, y: 180 },
        /** 主面板尺寸与位置 */
        panelRect: { x: 0, y: 0, w: 880, h: 620 },
        panelMobileScale: 1,

        // ---------------- 设置结构版本 ----------------
        /**
         * 设置结构版本。改动已有用户的设置时递增（见 store.js 的 migrateSettings）。
         * 新用户直接是当前版本，不会经过迁移。
         */
        settingsVersion: 3,

        // ---------------- 战斗模型 P2 ----------------
        p2: { channel: defaultChannel() },

        // ---------------- 口嗨模型（独立通道，不共享 P2 配置）----------------
        banter: {
            channel: defaultChannel(),
            /** 读取最近多少层上下文，范围 1..60 */
            contextMessages: 12,
            /** 留空时不读写任何世界书 */
            worldbookName: '',
            /** 从所选世界书读取目标角色人设 */
            readWorldbook: true,
            /** 目标角色缺少人设时补写到所选世界书 */
            createMissingPersona: true,
        },

        // 自定义技能与装备：只在新战斗装载，当前战斗不随编辑改变。
        loadout: { entries: [], contextMessages: 20, accessoryMode: 'story' },

        // ---------------- 战斗规则 ----------------
        rules: {
            hitDie: 20,
            initiativeUsesSpeed: true,
            critOnNat20: true,
            critMultiplier: 2,
            fumbleOnNat1: true,
            fumbleSelfHarmChance: 0.5,
            fumbleSelfHarmRatio: 0.1,
            minDamageOnHit: 1,
            aoeFalloff: 'sqrt',
            aoeFalloffFloor: 0.35,
            damageDieCount: 1,
            damageDieFaces: 6,
            grazeRatio: 0,
        },

        // ---------------- 开战（核心入口）----------------
        battle: {
            /**
             * 「正文模型」用哪条通道 —— 负责读当前场面（谁在打、什么状态）。
             *
             * 默认 `main`：复用当前聊天的主连接。理由：只有它完整读过这张卡与这段剧情，
             * 别的模型看几段摘要是猜不准的。
             */
            narrativeChannel: 'main',
            /**
             * 「掷骰模型」用哪条通道 —— 负责把场面转成结构化数据、以及流程中的判定。
             * 输入短、任务简单，用便宜快的即可。
             */
            structureChannel: 'p2',
            /** 读场面时扫描最近多少条消息 */
            scanMessages: 12,
            /** 读到的场面是否需要用户确认后才开战 */
            confirmBeforeStart: true,
            /** 开战时使用的随机种子（空 = 随机） */
            seed: '',
            /** 把中立单位也拉进战斗 */
            includeNeutral: false,

            // ---------------- 回合流程：AI 思考 + 掷骰动画 ----------------
            /**
             * 每个回合是否让 AI 先思考一次行动。
             *
             * - `flavor`（默认）：玩家点技能选目标，AI 只写一句动作描述
             * - `auto`：连用哪个技能、打谁都交给 AI 决定
             * - `off`：完全不调 API，用引擎的启发式规则
             */
            decideMode: 'flavor',
            /** 决策走哪条通道（输入很短，用便宜的即可） */
            decideChannel: 'p2',
            /**
             * 敌方回合是否也让 AI 决策。
             *
             * **默认开**：战斗的意义就是「AI 当对手跟你打」。
             * 关掉的话敌方只会用引擎的启发式规则随便挑目标 ——
             * 那就变成你自己跟自己打了，毫无意义（用户的反馈）。
             * 关掉只有一个合理理由：嫌慢或想省 token。
             */
            decideForEnemies: true,
            /**
             * 多人战时把**同侧所有单位**这一轮的行动合并成**一次**思考。
             *
             * 5 个敌人原本要 5 次调用，合并后只要 1 次 —— 数量级的差别。
             * 顺带还能让模型考虑彼此配合（先控住谁、再集火谁），
             * 这是逐单位分别决策做不到的。
             */
            batchDecisions: true,
            /**
             * 骰面**换面间隔**（毫秒）。越大转得越慢。
             *
             * 默认 150（约每秒 6.7 张）—— 能看清数字在跳，又有「在转」的实感。
             * 早期用的 65ms 快到看不清数字，用户实测反馈「转的太快了，慢一点」。
             */
            diceCycleMs: 150,
            /** 掷骰动画最短时长（毫秒）—— 保证「转一下」看得见 */
            diceMinDuration: 900,
            /** 掷骰动画最长时长（毫秒）—— 超过就强行停下，避免 API 太慢时一直转 */
            diceMaxDuration: 15000,
            /** 是否显示掷骰动画 */
            showDice: true,
            /** 战斗页是否用博德之门 3 风格 */
            bg3Style: true,

            // ---------------- 主动生成战斗场景 ----------------
            /**
             * 「开始战斗」时写进输入框的那段指令。
             * 留空则用内置模板（`src/llm/scene-prompt.js` 的 DEFAULT_SCENE_PROMPT）。
             * 模板里可以用 `{{SITUATION}}` 占位，会被用户在界面上写的补充说明替换。
             */
            scenePrompt: '',
            /**
             * 战斗模式由谁决定。
             *
             * - `auto`（默认）：**让正文 AI 判定** —— 它读过剧情，最清楚这是切磋还是生死搏杀
             * - `spar` / `deadly`：强制指定，忽略 AI 的判断
             */
            combatMode: 'auto',
            /** 是否自动点发送（关掉则只写进输入框，让你先看一眼再自己发） */
            autoSendScene: true,
            /** 等正文输出完成的超时（毫秒） */
            sceneTimeout: 180000,

            // ---------------- 谁是玩家 ----------------
            /**
             * **玩家操控的单位名**（跨战斗保存）。
             *
             * 为什么不能只靠单位上的 `isUser` 标记：每次开战都会**重建**战斗数据
             * （读场面/生成场景会整体替换它），标记就丢了。
             * 所以这里按**名字**记住 —— 名字在剧情里是稳定的。
             *
             * 空字符串 = 还没定，这时可以在战斗页点「这是我」手动指定。
             */
            userUnitName: '',
            /** 队友是否交给 AI 操作（默认交给 AI，你只管自己那一个） */
            aiControlsAllies: true,
            /**
             * 自动衔接：AI 单位行动完**自动接着下一个**，一路跑到轮到你为止。
             *
             * 关掉的话每打完一手都要你点一下「继续」—— 用户反馈那样很烦。
             */
            autoDrive: true,
        },

        // ---------------- 正文注入 ----------------
        injection: {
            /** 掷骰结果是否回写正文（作为系统消息让 AI 知道战况） */
            enabled: true,
            /** 注入频率：'each-round' | 'each-action' | 'battle-end' */
            mode: 'each-round',
            /** 注入的消息类型 */
            messageType: 'system',
            /** 是否用小字样式 */
            isSmallSys: true,
            /** 注入到聊天中的最大字符数（Combat_block 会被裁剪到这么大） */
            maxChars: 4000,
        },

        /** UI 偏好 */
        ui: { theme: 'auto', logLimit: 400 },
    };
}

/**
 * 递归深补全：把 defaults 里存在、target 里缺失的键补上。
 * 数组不做合并（数组语义是「用户显式选择」，不能被默认值污染）。
 * @param {any} target
 * @param {any} defaults
 * @returns {any} target 本体（原地修改）
 */
export function deepFillDefaults(target, defaults) {
    if (target === null || typeof target !== 'object' || Array.isArray(target)) return target;
    for (const [key, value] of Object.entries(defaults)) {
        if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
            if (target[key] === null || typeof target[key] !== 'object' || Array.isArray(target[key])) {
                target[key] = structuredCloneSafe(value);
            } else {
                deepFillDefaults(target[key], value);
            }
        } else if (target[key] === undefined) {
            target[key] = Array.isArray(value) ? [...value] : value;
        }
    }
    return target;
}

/**
 * structuredClone 的兜底实现（WebView 老版本可能没有）。
 * @template T
 * @param {T} value
 * @returns {T}
 */
export function structuredCloneSafe(value) {
    if (typeof globalThis.structuredClone === 'function') {
        try {
            return globalThis.structuredClone(value);
        } catch {
            /* 落到 JSON 方案 */
        }
    }
    return JSON.parse(JSON.stringify(value));
}
