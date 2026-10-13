/**
 * tavern-dice / src/core/store.js
 * ---------------------------------------------------------------------------
 * 持久化层。
 *
 * 三种存储的选择（来自本地 API 手册 §7 的实测结论）：
 *
 * | 数据 | 存哪 | 为什么 |
 * |---|---|---|
 * | 设置（通道、规则、UI 偏好） | `ctx.extensionSettings[EXT_ID]` | 跨聊天共享，跟人走 |
 * | 战力体系 / 战斗状态 / 审计日志 | `ctx.chatMetadata['tavern-dice']` | **跟聊天走**：换一张卡、新开一个聊天使用独立的战斗数据 |
 *
 * 关键陷阱：
 *  - 三者都**不会自动落盘**，必须显式调用 save。
 *  - 群聊里 `ctx.saveChat()` 会抛异常，`saveMetadata()` 才是安全的。
 *  - `saveChat()` 会静默吞掉错误，所以重要数据要自己 try/catch 并回报。
 */

import { EXT_ID, deepFillDefaults, defaultSettings, pickDefaultChannel, structuredCloneSafe } from '../config.js';
import { normalizePowerSystem, validatePowerSystem } from './schema.js';
import { describeError } from '../llm/client.js';
import { normalizeLoadoutLibrary } from './loadout.js';

/** chatMetadata 里我们占用的键。 */
const CHAT_KEY = EXT_ID;

/**
 * 战力表数据的结构版本。结构变化时递增，用于迁移。
 * v1: { schemaVersion, powerSystem, battle, auditLog, createdAt, updatedAt }
 */
export const DATA_VERSION = 1;

/**
 * 首次使用时按当前环境配置战斗模型通道。
 *
 * 只在通道**从没被配置过**时动手（mode 是默认值、且没有 profileId / apiUrl / model）。
 * 一旦用户自己改过任何一项，就再也不碰 —— 绝不覆盖用户的显式选择。
 *
 * @param {any} ctx
 * @param {object} settings
 * @returns {string[]} 做过的调整说明（用于日志）
 */
export function autoConfigureChannels(ctx, settings) {
    const channel = settings?.p2?.channel;
    if (!channel) return [];
    // 连仅填写 Key 的配置也视为用户的显式选择。
    const untouched = channel.mode === 'tavern-helper' &&
        !channel.profileId && !channel.apiUrl && !channel.apiKey && !channel.model;
    if (!untouched) return [];
    const pick = pickDefaultChannel(ctx);
    if (pick.mode === 'tavern-helper') return [];
    channel.mode = pick.mode;
    if (pick.profileId) channel.profileId = pick.profileId;
    return [`战斗模型通道：${pick.reason}`];
}

/**
 * 当前的设置结构版本。
 * 每次需要**改动已有用户**的设置时递增，并在 `migrateSettings` 里加一段。
 */
const SETTINGS_VERSION = 3;

/**
 * 一次性设置迁移。
 *
 * 为什么必须有这个东西：`deepFillDefaults` **只在键缺失时填默认值**，
 * 所以「把某个默认值从 A 改成 B」对**已经存过设置的用户完全无效** ——
 * 他们设置里那个键已经存在（是旧的 A），永远停在 A。
 *
 * v2 迁移：把 `battle.decideForEnemies` 从 false 翻成 true。
 * 理由：默认关掉是错的 —— 战斗的意义就是「AI 当对手跟你打」，
 * 关掉之后敌方只会用启发式规则随机挑目标，等于玩家自己跟自己打。
 * 迁移**只做一次**，之后用户想关就关，不会再被改回来。
 *
 * @param {any} settings
 * @returns {string[]} 做过的调整说明
 */
export function migrateSettings(settings) {
    /** @type {string[]} */
    const notes = [];
    if (!settings || typeof settings !== 'object') return notes;

    const from = Number(settings.settingsVersion) || 1;
    if (from >= SETTINGS_VERSION) return notes;

    if (from < 2 && settings.battle && settings.battle.decideForEnemies === false) {
        settings.battle.decideForEnemies = true;
        notes.push('敌方回合改为由 AI 决策（原来是本地启发式，等于你自己跟自己打）');
    }

    if (from < 3) {
        // 只移除设置，不触碰 chatMetadata 中的单位、战斗与历史数据。
        for (const key of ['p1', 'buildMode', 'draft', 'search']) delete settings[key];
        if (settings.p2 && typeof settings.p2 === 'object') {
            for (const key of Object.keys(settings.p2)) {
                if (key !== 'channel') delete settings.p2[key];
            }
        }
        for (const key of Object.keys(settings.battle ?? {})) {
            if (key.endsWith('Channel') && settings.battle[key] === 'p1') {
                settings.battle[key] = 'p2';
            }
        }
        notes.push('已移除独立建表和正文全局更新设置；旧 P1 战斗选择已迁移至 P2，保留 P2 凭据');
    }

    settings.settingsVersion = SETTINGS_VERSION;
    if (notes.length) {
        console.log(`[战斗掷骰] 设置已迁移到 v${SETTINGS_VERSION}：\n  · ${notes.join('\n  · ')}`);
    }
    return notes;
}

/**
 * 读取设置（带深度默认值补全）。
 *
 * 首次调用时会顺手做一次「环境自适应」：按当前酒馆里可用的东西
 *（连接配置 / 酒馆助手 / 都没有）把战斗模型通道配成开箱即用的模式。
 * 只做一次，之后用户改过什么都不会被覆盖。
 *
 * @param {any} ctx
 * @returns {object}
 */
export function getSettings(ctx) {
    if (!ctx) return defaultSettings();
    if (!ctx.extensionSettings) ctx.extensionSettings = {};
    const store = ctx.extensionSettings[EXT_ID];
    if (!store || typeof store !== 'object') {
        ctx.extensionSettings[EXT_ID] = defaultSettings();
    } else {
        // 先迁移，避免无版本的旧设置被默认版本号掩盖。
        migrateSettings(store);
        if (store.loadout && store.loadout.accessoryMode === undefined) {
            store.loadout.accessoryMode = normalizeLoadoutLibrary(store.loadout.entries)
                .some(e => e.kind === 'accessory' && e.enabled && e.rule) ? 'custom' : 'story';
        }
        deepFillDefaults(store, defaultSettings());
    }

    const settings = ctx.extensionSettings[EXT_ID];

    // ---- 一次性环境自适应 ----
    if (!settings.channelsAutoConfigured) {
        try {
            const notes = autoConfigureChannels(ctx, settings);
            settings.channelsAutoConfigured = true;
            if (notes.length) {
                console.log(`[战斗掷骰] 已按当前环境自动配置通道：\n  · ${notes.join('\n  · ')}`);
            }
        } catch (e) {
            // 自动配置失败不该影响扩展启动
            console.warn('[战斗掷骰] 自动配置通道失败（可手动到设置页配置）', e);
            settings.channelsAutoConfigured = true;
        }
    }

    return settings;
}

/**
 * 保存设置。
 * @param {any} ctx
 * @returns {Promise<boolean>} 是否成功触发保存
 */
export async function saveSettings(ctx) {
    try {
        if (typeof ctx?.saveSettingsDebounced === 'function') {
            ctx.saveSettingsDebounced();
            return true;
        }
        console.warn('[战斗掷骰] 当前酒馆没有 saveSettingsDebounced，设置不会落盘');
        return false;
    } catch (e) {
        console.error('[战斗掷骰] 保存设置失败', e);
        return false;
    }
}

/**
 * 读取本聊天的插件数据（不存在则返回空白结构，不写入）。
 * @param {any} ctx
 * @returns {object}
 */
export function getChatData(ctx) {
    const raw = ctx?.chatMetadata?.[CHAT_KEY];
    if (!raw || typeof raw !== 'object') return blankChatData();
    // 补全缺失字段，避免调用方到处判空
    const data = raw;
    if (!data.powerSystem) data.powerSystem = null;
    if (!Array.isArray(data.auditLog)) data.auditLog = [];
    if (!data.battle) data.battle = null;
    if (!data.createdAt) data.createdAt = Date.now();
    if (typeof data.dataVersion !== 'number') data.dataVersion = DATA_VERSION;
    return data;
}

/**
 * 写入并持久化本聊天的插件数据。
 * @param {any} ctx
 * @param {object} data
 * @param {{silent?: boolean}} [opts]
 * @returns {Promise<{ok: boolean, error?: string}>}
 */
export async function saveChatData(ctx, data, opts = {}) {
    try {
        if (!ctx?.chatMetadata) throw new Error('chatMetadata 不可用');
        data.updatedAt = Date.now();
        ctx.chatMetadata[CHAT_KEY] = data;

        // 优先 saveMetadata：它只写 metadata 行，比整个聊天快，且群聊里也安全
        if (typeof ctx.saveMetadata === 'function') {
            await ctx.saveMetadata();
            return { ok: true };
        }
        // 回落 saveChat（群聊会抛，所以要 catch）
        if (typeof ctx.saveChat === 'function') {
            await ctx.saveChat();
            return { ok: true };
        }
        throw new Error('没有可用的保存方法');
    } catch (e) {
        const error = describeError(e);
        if (!opts.silent) console.error('[战斗掷骰] 保存聊天数据失败', e);
        return { ok: false, error };
    }
}

/**
 * 空白数据。
 * @returns {object}
 */
export function blankChatData() {
    return {
        dataVersion: DATA_VERSION,
        powerSystem: /** @type {object|null} */ (null),
        battle: /** @type {object|null} */ (null),
        auditLog: /** @type {Array<any>} */ ([]),
        createdAt: Date.now(),
        updatedAt: Date.now(),
    };
}

/**
 * 清空本聊天的插件数据。
 * @param {any} ctx
 * @returns {Promise<{ok: boolean, error?: string}>}
 */
export async function resetChatData(ctx) {
    return saveChatData(ctx, blankChatData());
}

/**
 * 写入战力体系（会自动归一化 + 校验，并把校验结果记进审计日志）。
 * @param {any} ctx
 * @param {object} rawSystem 原始对象（可能来自 LLM 或文本解析）
 * @param {{source?: string, note?: string, silent?: boolean}} [opts]
 * @returns {Promise<{ok: boolean, error?: string, system?: object, issues?: Array<any>}>}
 */
export async function setPowerSystem(ctx, rawSystem, opts = {}) {
    const data = getChatData(ctx);
    const normalized = normalizePowerSystem(rawSystem);
    if (opts.source) normalized.meta.note = opts.note ?? normalized.meta.note;
    normalized.meta.generatedAt = normalized.meta.generatedAt || Date.now();

    const issues = validatePowerSystem(normalized);
    const errors = issues.filter((i) => i.level === 'error');
    if (errors.length) {
        // 有致命问题就不落盘，让上层决定是否强行写入
        return { ok: false, error: errors.map((e) => e.message).join('；'), issues };
    }

    data.powerSystem = normalized;
    pushAudit(data, {
        type: 'set-power-system',
        source: opts.source ?? 'unknown',
        note: opts.note ?? '',
        summary: `写入战力体系「${normalized.systemName}」，共 ${normalized.combatants.length} 个单位`,
        issues: issues.slice(0, 20),
    });

    const saved = await saveChatData(ctx, data, { silent: opts.silent });
    if (!saved.ok) return { ok: false, error: saved.error, issues };
    return { ok: true, system: normalized, issues };
}

/**
 * 追加一条审计日志。
 * 记录战斗与数据操作的来源和说明。
 * @param {object} data
 * @param {object} entry
 */
export function pushAudit(data, entry) {
    if (!Array.isArray(data.auditLog)) data.auditLog = [];
    data.auditLog.push({
        at: Date.now(),
        round: data.battle?.round ?? null,
        ...structuredCloneSafe(entry),
    });
    // 只留最近 200 条，别让聊天文件无限膨胀
    if (data.auditLog.length > 200) data.auditLog.splice(0, data.auditLog.length - 200);
}

/**
 * 保存战斗状态。
 * @param {any} ctx
 * @param {object|null} battleState `Battle.toState()` 的结果；null 表示清空
 * @returns {Promise<{ok: boolean, error?: string}>}
 */
export async function setBattle(ctx, battleState) {
    const data = getChatData(ctx);
    data.battle = battleState;
    return saveChatData(ctx, data);
}

/**
 * 读取战斗状态（没有则 null）。
 * @param {any} ctx
 * @returns {object|null}
 */
export function getBattle(ctx) {
    const data = getChatData(ctx);
    return data.battle ?? null;
}

/**
 * 导出全部数据（给「导出 JSON」按钮用）。
 * @param {any} ctx
 * @returns {object}
 */
export function exportAll(ctx) {
    // 存档可分享，但连接凭据只能留在本机；只修改深拷贝，不改运行中的配置。
    const settings = structuredCloneSafe(getSettings(ctx));
    if (settings.p2?.channel) settings.p2.channel.apiKey = '';
    return {
        exportedAt: new Date().toISOString(),
        extId: EXT_ID,
        dataVersion: DATA_VERSION,
        settings,
        chat: structuredCloneSafe(getChatData(ctx)),
    };
}

/**
 * 导入聊天数据与战斗进度，默认不覆盖 API 通道配置。
 * @param {any} ctx
 * @param {object} payload
 * @param {{includeSettings?: boolean}} [opts]
 * @returns {Promise<{ok: boolean, error?: string, imported: string[]}>}
 */
export async function importAll(ctx, payload, opts = {}) {
    /** @type {string[]} */
    const imported = [];
    try {
        if (opts.includeSettings && payload?.settings) {
            const settings = structuredCloneSafe(payload.settings);
            migrateSettings(settings);
            deepFillDefaults(settings, defaultSettings());
            ctx.extensionSettings ??= {};
            ctx.extensionSettings[EXT_ID] = settings;
            await saveSettings(ctx);
            imported.push('设置');
        }
        if (payload?.chat && typeof payload.chat === 'object' && !Array.isArray(payload.chat)) {
            // 完整存档需保留战斗进度、审计日志及扩展字段；部分导入不清空已有字段。
            const data = { ...structuredCloneSafe(getChatData(ctx)), ...structuredCloneSafe(payload.chat) };
            if (payload.chat.powerSystem) {
                data.powerSystem = normalizePowerSystem(payload.chat.powerSystem);
                const errors = validatePowerSystem(data.powerSystem).filter((issue) => issue.level === 'error');
                if (errors.length) return { ok: false, error: errors.map((issue) => issue.message).join('；'), imported };
            }
            const saved = await saveChatData(ctx, data);
            if (!saved.ok) return { ok: false, error: saved.error, imported };
            if (payload.chat.powerSystem) imported.push('战斗数据');
            if (Object.hasOwn(payload.chat, 'battle')) imported.push('战斗进度');
        }
        return { ok: true, imported };
    } catch (e) {
        return { ok: false, error: describeError(e), imported };
    }
}

/**
 * 估算本插件在聊天文件里占用的字节数，用于提示用户「会不会把聊天文件撑大」。
 * @param {any} ctx
 * @returns {number}
 */
export function estimateFootprint(ctx) {
    try {
        return JSON.stringify(getChatData(ctx)).length;
    } catch {
        return 0;
    }
}
