/**
 * tavern-dice / src/app.js
 * ---------------------------------------------------------------------------
 * 应用控制器：UI 与业务逻辑之间的唯一桥梁。
 *
 * UI 层只做两件事：调用 `AppController` 的方法、订阅它的状态变化。
 * 这样做的原因很实际：酒馆扩展的 UI 会因为主题、DOM 结构、其它扩展的干扰而频繁出错，
 * 把业务逻辑和 DOM 混在一起写，最后没法调试也没法测试。
 */

import { Battle, canUseSkill } from './combat/engine.js';
import { chooseFallbackTarget } from './combat/targeting.js';
import { normalizeLoadoutLibrary, createLoadoutEntry, updateLoadoutEntry, removeLoadoutEntry, saveRefinedLoadout, applyLoadout, loadoutSceneNote, selectedLoadoutEntries } from './core/loadout.js';
import { buildLoadoutChatRequest, collectLoadoutRefinements } from './llm/loadout.js';
import { captureLoadoutChatPair, deleteLoadoutChatPair } from './llm/loadout-chat.js?v=1.0.4';
import { hitPenaltyPreview } from './combat/preview.js';
import { resolveRecruitment } from './combat/social.js';
import { findPersuasion, recordPersuasion, offerCharmCheck, previewCharmCheck, recordCharmRoll } from './combat/persuasion.js';
import { generateBanter, evaluateCharm, shouldCheckCharm } from './llm/banter.js';
import { readCharacterPersona, ensureCharacterPersona } from './llm/persona-worldbook.js';
import { EXT_NAME, TAG } from './config.js';
import { diagLog } from './ui/diag.js';
import { GENERIC_D20, normalizeRuleset, sniffPowerMode } from './core/ruleset.js';
import {
    SEVERITY,
    validatePowerSystem,
    checkPowerSystemQuality,
    normalizePowerSystem,
    toCombatBlock,
    toText,
} from './core/schema.js';
import {
    getBattle,
    getChatData,
    getSettings,
    pushAudit,
    resetChatData,
    saveChatData,
    saveSettings,
    setBattle,
    setPowerSystem,
} from './core/store.js';
import { LlmClient, describeError, getTavernHelper } from './llm/client.js';
import { DECIDE_MODE, decideAction, decideActionsBatch } from './llm/decider.js';
import { getLastAssistantMessage, renderRecentMessages, summarizePowerSystem } from './llm/pipelines.js';
import { parseSituationReport, resolveUserUnit } from './llm/report-parser.js';
import { buildSceneRequest } from './llm/scene-prompt.js';
import { readSituation, resolveNarrativeChannel, structureSituation } from './llm/setup.js';
import { createGenerationWait, currentGenerationContext, generationChatIdentity, sameGenerationChat, readGenerationActivity } from './llm/generation-wait.js';
import { pickMainRoll } from './ui/dice.js';
import { toast, mercyDialog } from './ui/dom.js';

/** 睡一会儿（用于动画节奏控制）。 */
function sleep(ms, signal) {
    return new Promise((resolve, reject) => {
        const abort = () => {
            clearTimeout(timer);
            signal?.removeEventListener('abort', abort);
            reject(Object.assign(new Error('操作已终止'), { name: 'AbortError' }));
        };
        const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, Math.max(0, ms));
        if (signal?.aborted) abort();
        else signal?.addEventListener('abort', abort, { once: true });
    });
}

/** 控制器事件类型。 */
export const APP_EVENT = Object.freeze({
    STATE_CHANGED: 'state-changed',
    BUSY: 'busy',
    LOG: 'log',
});

export class AppController {
    /**
     * @param {any} ctx SillyTavern context
     */
    constructor(ctx) {
        this.ctx = ctx;
        /** @type {Map<string, Set<Function>>} */
        this._listeners = new Map();
        /** @type {Battle|null} */
        this.battle = null;
        /** @type {boolean} */
        this.busy = false;
        /** @type {string} 忙碌提示文案 */
        this.busyLabel = '';
        /** @type {string[]} */
        this.lastLogs = [];
        /** 最近一次场景读取摘要，UI 上展示 */
        this.lastUpdateSummary = '';
        /**
         * 正文模型读出的当前战况（开战流程用）。
         * 只放内存 —— 它是「这一刻的场面」，不该持久化。
         * @type {{report: string, situation: string, at: number}|null}
         */
        this.battleSituation = null;
        /**
         * 战斗结束后可供发送的结算文本快照。
         *
         * 战斗**全程不碰聊天**：所有结算都记在插件里。
         * 打完之后由用户点「发送战斗结算」，把整场合成一条消息发给正文模型续写。
         * 这个字段就是那条消息的内容。
         * @type {string|null}
         */
        this.battleResultSnapshot = null;
        /**
         * 掷骰动画控制器。由战斗界面在挂载时创建、卸载时销毁。
         * @type {{roll: Function, settle: Function, hide: Function, destroy: Function}|null}
         */
        this.diceRoller = null;
        /**
         * 本次行动的掷骰展示状态（界面据此显示 d20 结果与动作描述）。
         * @type {{rolling: boolean, value: number, outcome: string, flavor: string}|null}
         */
        this.displayRoll = null;
        /** 本次掷骰开始的时间戳（用于保证动画最短时长）。 */
        this._rollStartedAt = 0;
        /**
         * 本轮批量决策的缓存：`{battleId, round, side, byUnit}`。
         *
         * 一次调用想好同侧所有单位的行动，之后逐个「播放」时从这里取，
         * 取过就删 —— 一个单位一轮只消费一次。轮次或战斗变了就视为失效。
         * @type {{battleId: string, round: number, side: string, byUnit: Record<string, any>}|null}
         */
        this._decisionQueue = null;
        /**
         * 自动衔接是否正在运行。
         *
         * 用来防止递归：`autoAdvance` 内部会调 `act`，而 `act` 结束时又想把控制权
         * 交回 `autoAdvance` —— 没有这个标志会无限套娃。
         */
        this._autoDriving = false;
        /** 请求停止自动衔接（UI 上的「停」按钮会置它）。 */
        this._autoDriveStop = false;
        /** 自动衔接的累计步数（用于防无限循环，正常轮到玩家时清零）。 */
        this._autoDriveBudget = 0;
        /**
         * 当前长任务的终止控制器。
         * 用户在进度窗口点「终止」时 abort，底层会掐断在途请求并停止后续批次。
         * @type {AbortController|null}
         */
        this._abort = null;
        /**
         * 长任务的结构化进度，供进度窗口渲染。
         * @type {{active: boolean, kind: string, stage: string, detail: string, batch: number, total: number, percent: number, startedAt: number, cancellable: boolean}}
         */
        this.progress = {
            active: false,
            kind: '',
            stage: '',
            detail: '',
            batch: 0,
            total: 0,
            percent: 0,
            startedAt: 0,
            cancellable: false,
        };
    }

    // -----------------------------------------------------------------------
    // 长任务进度与终止
    // -----------------------------------------------------------------------

    /**
     * 判断当前有没有正在跑的长任务。
     * 就是 `busy` —— 两者是同一个状态的两面。
     */
    get isRunning() {
        return this.busy;
    }

    /**
     * 更新进度状态并通知界面。
     * @param {Partial<typeof this.progress>} patch
     */
    setProgress(patch) {
        Object.assign(this.progress, patch);
        this.emit('progress', this.progress);
        this.notify();
    }

    /**
     * 终止当前长任务。
     *
     * 做两件事：给底层发中断信号（会掐断在途请求），
     * 以及翻起一个标志位（各批次之间的检查点读它）。
     * 两者缺一不可 —— 只翻标志位的话，正在等 API 返回的那一步要等到超时才停。
     *
     * @returns {boolean} 是否确实发起了终止
     */
    abortRunning() {
        if (!this.busy) return false;
        this._abort?.abort();
        this.log('⏹ 已请求终止…');
        this.setProgress({ detail: '正在终止…' });
        return true;
    }

    /**
     * 结束长任务：清掉进度与中断控制器。
     */
    _endTask() {
        this._abort = null;
        this.setProgress({
            active: false,
            kind: '',
            stage: '',
            detail: '',
            batch: 0,
            total: 0,
            percent: 0,
            cancellable: false,
        });
        this.setBusy(false);
    }

    /**
     * 按当前阶段与批次算一个粗略但诚实的百分比。
     *
     * 不做假进度条：这个百分比是由「读了多少、分几批、做到第几批」算出来的，
     * 到不了 100 就说明还没做完。
     *
     * @param {string} stage
     * @param {number} batch
     * @param {number} total
     * @param {number} phases
     * @returns {number}
     */
    _pct(stage, batch, total, phases) {
        // 读世界书 10% + 组装 10% + 模型生成 75% + 收尾 5%，共 4 个阶段
        const span = 100 / Math.max(1, phases);
        if (stage === 'collect') return Math.min(10, span);
        if (stage === 'prepare') return span + 10;
        if (stage === 'generate') {
            const done = Math.max(0, batch - 1);
            const ratio = total > 0 ? Math.min(1, done / total) : 0;
            return Math.min(95, span + 10 + ratio * 75);
        }
        if (stage === 'merge') return 95;
        return 0;
    }

    /**
     * 统一的进度回调：把底层流水线上报的原始阶段翻译成界面状态。
     * @param {string} kind
     * @param {number} phases
     */
    _progressHandler(kind, phases) {
        return (/** @type {string} */ stage, /** @type {string} */ detail, /** @type {object} */ info) => {
            const batch = Number(/** @type {any} */ (info)?.batch ?? this.progress.batch ?? 0);
            const total = Number(/** @type {any} */ (info)?.total ?? this.progress.total ?? 0);
            this.setProgress({
                active: true,
                kind,
                stage,
                detail: detail || this.progress.detail,
                batch,
                total,
                percent: this._pct(stage, batch, total, phases),
            });
        };
    }

    // -----------------------------------------------------------------------
    // 事件
    // -----------------------------------------------------------------------

    /**
     * 订阅事件。
     * @param {string} event
     * @param {Function} handler
     * @returns {() => void} 取消订阅
     */
    on(event, handler) {
        if (!this._listeners.has(event)) this._listeners.set(event, new Set());
        this._listeners.get(event)?.add(handler);
        return () => this._listeners.get(event)?.delete(handler);
    }

    /**
     * 广播事件。
     * @param {string} event
     * @param {any} [payload]
     */
    emit(event, payload) {
        for (const handler of this._listeners.get(event) ?? []) {
            try {
                handler(payload, this);
            } catch (e) {
                console.error(`${TAG} 事件处理器出错（${event}）`, e);
            }
        }
    }

    /** 通知状态变更。 */
    notify() {
        this.emit(APP_EVENT.STATE_CHANGED, this.state);
    }

    /**
     * 设置忙碌状态（UI 会禁用按钮并显示进度）。
     * @param {boolean} busy
     * @param {string} [label]
     */
    setBusy(busy, label = '') {
        this.busy = busy;
        this.busyLabel = label;
        this.emit(APP_EVENT.BUSY, { busy, label });
        this.notify();
    }

    /**
     * 往 UI 日志里追加一行。
     * @param {string} message
     */
    log(message) {
        const line = String(message);
        this.lastLogs.push(line);
        if (this.lastLogs.length > 300) this.lastLogs.splice(0, this.lastLogs.length - 300);
        this.emit(APP_EVENT.LOG, line);
    }

    // -----------------------------------------------------------------------
    // 状态读取
    // -----------------------------------------------------------------------

    get settings() {
        return getSettings(this.ctx);
    }

    get data() {
        return getChatData(this.ctx);
    }

    /** 当前战力体系（可能为 null）。 */
    get powerSystem() {
        return this.data.powerSystem ?? null;
    }

    /** 当前规则集。优先用战力体系里带的，其次用用户覆盖，最后用通用预设。 */
    get ruleset() {
        const settings = this.settings;
        // 用户显式覆盖优先
        if (settings.rulesetOverride) {
            return normalizeRuleset({ ...settings.rulesetOverride, source: 'user' });
        }
        const fromSystem = this.powerSystem?.ruleset;
        if (fromSystem) return normalizeRuleset({ ...fromSystem, source: fromSystem.source ?? 'worldbook' });
        return normalizeRuleset({ ...GENERIC_D20 });
    }

    /** 汇总给 UI 的状态快照。 */
    get state() {
        const data = this.data;
        const system = data.powerSystem;
        return {
            busy: this.busy,
            busyLabel: this.busyLabel,
            hasPowerSystem: Boolean(system?.combatants?.length),
            systemName: system?.systemName ?? '',
            unitCount: system?.combatants?.length ?? 0,
            allyCount: system?.combatants?.filter((/** @type {any} */ u) => u.side === 'ally').length ?? 0,
            enemyCount: system?.combatants?.filter((/** @type {any} */ u) => u.side === 'enemy').length ?? 0,
            rulesetName: this.ruleset.name,
            rulesetId: this.ruleset.id,
            battleActive: Boolean(this.battle) && this.battle?.phase !== 'finished',
            battleRound: this.battle?.round ?? 0,
            battlePhase: this.battle?.phase ?? 'none',
            auditCount: data.auditLog?.length ?? 0,
            lastUpdateSummary: this.lastUpdateSummary,
            logs: this.lastLogs.slice(-120),
        };
    }

    // -----------------------------------------------------------------------
    // 设置
    // -----------------------------------------------------------------------

    /**
     * 保存设置。
     * @param {{silent?: boolean}} [opts]
     */
    async persistSettings(opts = {}) {
        const ok = await saveSettings(this.ctx);
        if (!ok && !opts.silent) toast('设置未能落盘，请检查控制台', 'warning');
        this.notify();
        return ok;
    }

    get loadoutEntries() {
        return normalizeLoadoutLibrary(this.settings.loadout.entries);
    }

    async saveLoadout(input = {}) {
        if (!toText(input.name) || !toText(input.description)) return { ok: false, error: '请填写名称和一句话作用' };
        if (!['skill', 'weapon', 'armor', 'accessory'].includes(input.kind)) return { ok: false, error: '请选择技能或装备类型' };
        const entries = this.loadoutEntries;
        if (input.id && !entries.some(e => e.id === input.id)) return { ok: false, error: '条目已被删除' };
        const entry = input.id ? null : createLoadoutEntry({ ...input, enabled: false });
        this.settings.loadout.entries = input.id ? updateLoadoutEntry(entries, input.id, {
            name: input.name, kind: input.kind, description: input.description,
        }) : [...entries, entry];
        const persisted = await this.persistSettings({ silent: true });
        return persisted ? { ok: true, id: input.id || entry.id } : { ok: false, error: '条目已在本次会话更新，但设置未能落盘，请重试保存' };
    }

    async deleteLoadout(id) {
        this.settings.loadout.entries = removeLoadoutEntry(this.loadoutEntries, id);
        const persisted = await this.persistSettings({ silent: true });
        return persisted ? { ok: true } : { ok: false, error: '删除已在本次会话生效，但设置未能落盘，请重试保存' };
    }

    get prebattleSelection() {
        const entries = selectedLoadoutEntries(this.loadoutEntries);
        const accessoryMode = ['story', 'custom', 'none'].includes(this.settings.loadout.accessoryMode)
            ? this.settings.loadout.accessoryMode : 'story';
        return {
            skills: entries.filter(e => e.kind === 'skill').map(e => e.id),
            weapon: entries.find(e => e.kind === 'weapon')?.id ?? null,
            armor: entries.find(e => e.kind === 'armor')?.id ?? null,
            accessories: accessoryMode === 'custom' ? entries.filter(e => e.kind === 'accessory').map(e => e.id) : [],
            accessoryMode,
        };
    }

    async setPrebattleSelection(kind, value) {
        if (this.busy) return { ok: false, error: '当前任务尚未结束，请稍后选择装备' };
        if (kind === 'accessoryMode') {
            if (!['story', 'custom', 'none'].includes(value)) return { ok: false, error: '饰品模式无效' };
            if (value === 'custom' && !selectedLoadoutEntries(this.loadoutEntries).some(e => e.kind === 'accessory'))
                return { ok: false, error: '请先选择自定义饰品' };
            this.settings.loadout.accessoryMode = value;
            if (value !== 'custom') this.settings.loadout.entries = this.loadoutEntries.map(e => e.kind === 'accessory' ? updateLoadoutEntry([e], e.id, { enabled: false })[0] : e);
        } else {
            if (!['skill', 'weapon', 'armor', 'accessory'].includes(kind)) return { ok: false, error: '选择类别无效' };
            const ids = ['weapon', 'armor'].includes(kind) ? (value === null ? [] : [value]) : value;
            if (!Array.isArray(ids) || ids.some(id => typeof id !== 'string') || new Set(ids).size !== ids.length)
                return { ok: false, error: '请选择不重复的有效条目' };
            const entries = this.loadoutEntries;
            const picked = ids.map(id => entries.find(e => e.id === id));
            if (picked.some(e => !e || e.kind !== kind || !e.rule)) return { ok: false, error: '条目不存在、类别不符或尚未润色' };
            if (kind === 'accessory' && (ids.length > 2 || new Set(picked.map(e => e.name.normalize('NFKC').trim().toLocaleLowerCase())).size !== ids.length))
                return { ok: false, error: '饰品最多选择两件，且不能同名' };
            this.settings.loadout.entries = entries.map(e => e.kind === kind ? updateLoadoutEntry([e], e.id, { enabled: ids.includes(e.id) })[0] : e);
            if (kind === 'accessory') this.settings.loadout.accessoryMode = ids.length ? 'custom' : 'none';
        }
        const persisted = await this.persistSettings({ silent: true });
        return persisted ? { ok: true } : { ok: false, error: '战前选择已在本次会话生效，但设置未能落盘，请重试保存' };
    }

    async setLoadoutEnabled(id, enabled) {
        const entry = this.loadoutEntries.find(e => e.id === id);
        if (!entry) return { ok: false, error: '条目已被删除' };
        if (enabled && !entry.rule) return { ok: false, error: '请先让正文润色为 d20 规则再携带' };
        const selection = this.prebattleSelection;
        if (entry.kind === 'weapon' || entry.kind === 'armor') {
            return this.setPrebattleSelection(entry.kind, enabled ? id : selection[entry.kind] === id ? null : selection[entry.kind]);
        }
        const ids = entry.kind === 'skill' ? selection.skills : selection.accessories;
        return this.setPrebattleSelection(entry.kind, enabled ? [...ids.filter(x => x !== id), id] : ids.filter(x => x !== id));
    }

    async refineLoadout(idOrIds) {
        if (this.busy || this._playerTurnRunning || this._autoDriving) return { ok: false, error: '当前任务尚未结束' };
        const ids = Array.isArray(idOrIds) ? idOrIds : [idOrIds];
        if (!ids.length || new Set(ids).size !== ids.length) return { ok: false, error: '请选择不重复的润色条目' };
        const entries = ids.map(id => this.loadoutEntries.find(e => e.id === id));
        if (entries.some(entry => !entry)) return { ok: false, error: '条目已被删除' };
        this.ctx = currentGenerationContext(this.ctx);
        const ctx = this.ctx;
        const identity = generationChatIdentity(ctx);
        if (readGenerationActivity(ctx) === true) return { ok: false, error: '正文正在生成，请结束后再发送润色请求' };
        const controller = new AbortController();
        this._abort = controller;
        this.setBusy(true, `准备发送 ${entries.length} 项正文润色…`);
        this.setProgress({ active: true, kind: '自定义库润色', stage: 'prepare', detail: '准备聊天润色提示词',
            batch: 1, total: entries.length, percent: 10, startedAt: Date.now(), cancellable: true });
        let waiter;
        const validContext = () => !controller.signal.aborted && sameGenerationChat(identity, currentGenerationContext(ctx));
        const opts = {
            powerSystem: this.battle ? { ...this.powerSystem, combatants: this.battle.units } : this.powerSystem,
            playerName: this.settings.battle.userUnitName || ctx.name1,
            situation: this.battleSituation?.report || '', signal: controller.signal,
        };
        try {
            const request = buildLoadoutChatRequest(ctx, this.settings, entries, opts);
            if (!this.writeToInput(request)) return { ok: false, error: '找不到酒馆输入框，未发送润色请求' };
            const waitPromise = this.waitForGeneration(Number(this.settings.battle.sceneTimeout) || 180000, { deferred: true });
            waiter = this._sceneGenerationWait;
            await sleep(120, controller.signal);
            if (!validContext()) return { ok: false, aborted: true, error: '润色已停止或聊天已切换' };
            const baseline = currentGenerationContext(ctx).chat?.length ?? 0;
            waiter.arm();
            if (waiter.settled || !this.clickSend()) return { ok: false, error: '无法发送；润色提示词已留在输入框' };
            this.setProgress({ stage: 'generate', percent: 35, detail: '已发送到酒馆聊天，等待正文结合世界观与主角实力润色…' });
            const waited = await waitPromise;
            if (!waited.ok) return { ok: false, aborted: Boolean(waited.aborted), error: waited.error || (waited.timedOut ? '等待正文润色超时' : '正文润色已停止') };
            if (!validContext()) return { ok: false, aborted: true, error: '聊天已切换，未回填或删除楼层' };
            const captured = captureLoadoutChatPair(currentGenerationContext(ctx), identity, baseline, request, waited.message);
            if (!captured.ok) return { ok: false, error: captured.error };
            this.setProgress({ stage: 'generate', percent: 65, detail: '正文已输出完毕，插件模型正在回收并校验规则…' });
            const collected = await collectLoadoutRefinements(ctx, this.settings, entries, waited.message.text, opts);
            if (!validContext()) return { ok: false, aborted: true, error: '润色已停止或聊天已切换，未回填' };
            if (!collected.ok) return collected;
            // 全批次核对版本，任何一项过期都不得部分覆盖其他条目。
            let next = this.loadoutEntries;
            for (const result of collected.results) {
                const saved = saveRefinedLoadout(next, result);
                if (!saved.ok) return saved;
                next = saved.entries;
            }
            this.settings.loadout.entries = next;
            if (!await this.persistSettings({ silent: true })) return { ok: false, error: '规则已回填到本次会话，但设置未能落盘；保留润色两楼，请重试保存' };
            this.setProgress({ stage: 'cleanup', percent: 90, detail: '回填成功，核对并删除本次润色请求及回复两楼…' });
            const cleaned = await deleteLoadoutChatPair(() => currentGenerationContext(ctx), captured.pair, { signal: controller.signal, helper: getTavernHelper() });
            if (!cleaned.ok) {
                const warning = `规则已回填，但未清理润色两楼：${cleaned.error}`;
                this.log(`⚠ ${warning}`);
                toast(warning, 'warning');
                return { ok: true, count: entries.length, cleaned: false, warning };
            }
            this.log(`✔ 已回填 ${entries.length} 项规则并删除本次润色两楼；携带勾选保持不变`);
            return { ok: true, count: entries.length, cleaned: true };
        } catch (error) {
            return { ok: false, aborted: controller.signal.aborted, error: describeError(error) };
        } finally {
            waiter?.cancel({ ok: false, aborted: true });
            if (this._abort === controller) this._endTask();
        }
    }

    /** 清空本聊天的场景数据与战斗（重新开始）。 */
    async reset() {
        this.stopAutoDrive();
        this.battleResultSnapshot = null;
        this.battleSent = false;
        this.battle = null;
        await resetChatData(this.ctx);
        this.lastUpdateSummary = '';
        this.log('· 已清空本聊天的场景数据与战斗记录');
        this.notify();
        return { ok: true };
    }

    // -----------------------------------------------------------------------
    // 正文注入
    // -----------------------------------------------------------------------

    /**
     * 把一段文本作为消息**发送**进聊天，让正文模型接着写。
     *
     * ⚠️ 与「注入系统提示」是两件不同的事，这点很关键：
     *  - **注入**（`injectMessage`）是往聊天里塞一条 `is_system` 的旁注，**不触发 AI**，
     *    而且每条都占一个楼层 —— 战斗期间每回合注入一次，一晚上下来聊天记录全是旁白。
     *  - **发送**（本函数）是走酒馆正常的发送流程，发出去之后正文模型会**接着写**。
     *
     * 战斗现在**全程不碰聊天**：所有结算都在插件里显示。打完之后用这个函数
     * 把整场战斗合成**一条**消息发出去，让剧情继续。
     *
     * 实现要点：
     *  - 使用正文输入框与原生发送按钮，真正启动正常聊天生成。
     *  - `/send`、`sendMessageAsUser` 只添加楼层，不作为生成入口；文本也不交给斜杠解析器。
     *  - 都没有就把文本放进输入框并提示用户自己按发送 —— **宁可让用户多点一下，
     *    也不要静默地什么都不做**。
     *
     * @param {string} text
     * @param {{silent?: boolean}} [opts]
     * @returns {Promise<{ok: boolean, method?: string, error?: string}>}
     */
    async sendToChat(text, opts = {}) {
        const body = String(text ?? '').trim();
        if (!body) return { ok: false, error: '内容为空' };

        const ctx = currentGenerationContext(this.ctx);
        if (readGenerationActivity(ctx) === true) return { ok: false, error: '正文正在生成，请结束后再发送战斗结算' };
        // 原生发送同时创建用户楼层并启动正文；不把结算交给 /send 命令解析。
        this.pendingBattleText = body;
        if (this.writeToInput(body)) {
            if (this.clickSend()) {
                this.pendingBattleText = '';
                this.log('📤 已通过酒馆发送按钮发送战斗结算，正文开始衔接剧情');
                return { ok: true, method: 'native' };
            }
            this.log('· 已把战斗结算放进输入框 —— 发送按钮不可用，请按发送让 AI 续写');
            if (!opts.silent) toast('已放进输入框，发送按钮不可用，请手动发送', 'warning');
            return { ok: true, method: 'textarea' };
        }

        this.log('✖ 找不到可用的发送方式，战斗结算已存在插件里，可手动复制');
        if (!opts.silent) toast('当前酒馆不支持自动发送 —— 请到「日志」页复制战斗结算', 'warning');
        return { ok: false, error: '当前酒馆没有可用的发送接口' };
    }

    /**
     * 把战斗结算作为一条消息发出去，让正文模型接着写剧情。
     *
     * 由用户在战斗结束后**主动触发**（面板上的按钮），不是自动的 ——
     * 自动发送会让用户失去「要不要现在继续剧情」的控制权。
     *
     * @returns {Promise<{ok: boolean, error?: string}>}
     */
    async discardBattleResult() {
        this.battleResultSnapshot = null;
        this.battleSent = false;
        this.data.battleResult = null;
        await saveChatData(this.ctx, this.data, { silent: true });
        this.notify();
    }

    /** 每场结算单独选择；默认不附带口嗨。 */
    get includeBanterInResult() {
        return this.data.battleResult?.includeBanter === true;
    }

    /** 完整口嗨附录。结束战斗后仍保留，供用户切换发送选择。 */
    battleBanterText() {
        if (!this.battle) return this.data.battleResult?.banterText ?? '';
        const entries = this.battle.banterHistory ?? [];
        if (!entries.length) return '';
        return [
            '战中口嗨记录（以下为角色对白，不作为伤害、阵营变更或成败的判定依据）：',
            ...entries.map(entry => `· ${entry.text}`),
        ].join('\n');
    }

    /** 同时保留可编辑的战斗文本、口嗨附录和当前发送选择。 */
    _captureBattleResult({ data = this.data, combatText, includeBanter = this.includeBanterInResult, sent = false } = {}) {
        const base = combatText ?? this.battleResultText({ includeBanter: false });
        const banterText = this.battleBanterText();
        const text = includeBanter && banterText ? `${base}\n\n${banterText}` : base;
        const result = { text, combatText: base, banterText, includeBanter: Boolean(includeBanter), sent };
        data.battleResult = result;
        this.battleResultSnapshot = text;
        this.battleSent = sent;
        return result;
    }

    async setBattleResultIncludeBanter(includeBanter, editedCombatText) {
        const data = this.data;
        this._captureBattleResult({
            data,
            combatText: editedCombatText ?? data.battleResult?.combatText,
            includeBanter: Boolean(includeBanter),
            sent: this.battleSent,
        });
        const saved = await saveChatData(this.ctx, data, { silent: true });
        this.notify();
        return saved;
    }

    /** editedText 只含可编辑的战斗结算；口嗨按开关统一附加。 */
    async sendBattleResult(editedText) {
        if (this._battleResultSending) return { ok: false, error: '战斗结算正在发送，请勿重复点击' };
        if (this.busy) return { ok: false, error: '当前任务尚未结束，请稍后发送战斗结算' };
        this._battleResultSending = true;
        try {
            const data = this.data;
            const combatText = editedText ?? data.battleResult?.combatText ?? this.battleResultText({ includeBanter: false });
            if (!combatText) return { ok: false, error: '没有可发送的战斗结果' };
            const record = this._captureBattleResult({ data, combatText, sent: this.battleSent });
            const result = await this.sendToChat(record.text);
            if (result.ok) {
                this.battleSent = result.method !== 'textarea';
                record.sent = this.battleSent;
                await saveChatData(this.ctx, data, { silent: true });
                this.notify();
            } else {
                toast(result.error ?? '发送失败', 'error');
            }
            return result;
        } finally {
            this._battleResultSending = false;
        }
    }

    /**
     * 生成**一条**完整的战斗结算文本（战斗结束后发给正文模型用）。
     *
     * 设计目标：正文模型读完这一段，能自然地继续写下一段剧情。
     * 所以包含：谁和谁打、结果如何、过程中发生了什么（关键回合）、
     * 以及各人现在的状态（血量/状态/阵亡）—— 这些是续写必须知道的。
     *
     * @returns {string}
     */
    battleResultText({ includeBanter = this.includeBanterInResult } = {}) {
        // 战斗还在进行时用它做实时预览；结束后按保存的选择组合快照。
        const battle = this.battle;
        const banterText = includeBanter ? this.battleBanterText() : '';
        const compose = text => text && banterText ? `${text}\n\n${banterText}` : text;
        if (!battle) return compose(this.data.battleResult?.combatText ?? this.battleResultSnapshot ?? '');

        const lines = [];
        lines.push(`【战斗结算 · ${battle.name}】`);
        lines.push(`共 ${battle.round} 回合，随机种子 ${battle.seed}（可用于复盘）。`);
        lines.push('');

        // 参战双方与结果
        const allies = battle.units.filter((/** @type {any} */ u) => u.side === 'ally');
        const enemies = battle.units.filter((/** @type {any} */ u) => u.side === 'enemy' || u.mercyWithdrawn);
        const downWord = this.battle.combatMode === 'deadly' ? '阵亡' : '力竭';
        const describe = (/** @type {any[]} */ units) =>
            units.map((u) => `${u.name}${u.mercyWithdrawn ? '（留手保命，退出至观战席）' : u.alive ? '' : `（${downWord}）`}`).join('、') || '无';
        lines.push(`我方：${describe(allies)}`);
        lines.push(`敌方：${describe(enemies)}`);
        if (battle.winner) lines.push(`结果：${battle.winner}`);
        lines.push('');

        // 战后各人状态 —— 续写必须知道谁受伤了、谁死了
        lines.push('战后状态：');
        for (const unit of battle.units) {
            const hp = unit.attributes?.HP;
            const mp = unit.attributes?.MP;
            const pct = hp?.max ? Math.round(((hp.current ?? 0) / hp.max) * 100) : 0;
            lines.push(
                `- ${unit.side === 'ally' ? '我方' : unit.side === 'enemy' ? '敌方' : '中立'} ${unit.name}：` +
                    (unit.mercyWithdrawn
                    ? `被留手保命，HP ${hp?.current ?? 1}/${hp?.max ?? 0}；已退出至观战席，丧失战斗能力（未阵亡）`
                    : unit.alive
                    ? `HP ${hp?.current ?? 0}/${hp?.max ?? 0}（${pct}%）`
                    : this.battle.combatMode === 'deadly'
                      ? '已阵亡'
                      : '力竭（失去战斗力）') +
                    (mp && unit.alive ? `，MP ${mp.current}/${mp.max}` : '') +
                    (unit.statuses?.length
                        ? `，状态：${unit.statuses.map((/** @type {any} */ s) => `${s.name}${s.duration ? `(${s.duration}回合)` : ''}`).join('、')}`
                        : ''),
            );
        }
        lines.push('');

        // 关键过程 —— 全量日志太长，挑出有伤害/倒下的那些行；口嗨不参与结算。
        const combatLog = battle.log.filter(entry => entry.type !== 'banter');
        const keyLines = combatLog
            .filter((/** @type {any} */ l) => /伤害|阵亡|倒下|命中|闪避|暴击|大失败|护盾|治疗/.test(l.text))
            .map((/** @type {any} */ l) => l.text);
        const shown = keyLines.slice(-24);
        if (shown.length) {
            lines.push(`战斗过程（共 ${combatLog.length} 条结算，节选关键 ${shown.length} 条）：`);
            for (const t of shown) lines.push(`· ${t}`);
            lines.push('');
        }

        const socialLines = combatLog.filter(l => l.type === 'charm').slice(-16);
        if (socialLines.length) {
            lines.push('魅力检定（最近记录）：');
            for (const entry of socialLines) lines.push(`· ${entry.text}`);
            lines.push('');
        }
        const mercies = battle.log.filter(l => l.type === 'mercy');
        if (mercies.length) {
            lines.push('致命行动的留手／阻止记录（全部保留）：');
            for (const entry of mercies) lines.push(`· ${entry.text}`);
            lines.push('成功保命者仅退出战斗进入观战席，不得续写为阵亡或仍能参战。');
            lines.push('');
        }
        const defections = battle.log.filter(l => l.type === 'defection');
        if (defections.length) {
            lines.push('已结算的阵营变更（全部保留）：');
            for (const entry of defections) lines.push(`· ${entry.text}`);
            lines.push('');
        }
        lines.push('（以上是掷骰引擎已经结算完毕的客观结果。请据此续写后续剧情，不要推翻已发生的伤害、阵亡、阵营变更与状态变化。）');
        return compose(lines.join('\n'));
    }

    /**
     * 战斗期间**不再往聊天里写任何东西**。
     *
     * 早期版本按「每回合 / 每次行动 / 战斗结束」往聊天里注入 `is_system` 旁注，
     * 结果是每打一回合就多一个楼层 —— 一晚上下来聊天记录里全是战斗旁白，
     * 把剧情淹了。而且那些旁注**不触发 AI**，纯粹是占位。
     *
     * 现在的做法：
     *  - 战斗全程在插件里显示（战斗页 + 日志页），聊天一个字都不动
     *  - 打完之后由用户点「发送战斗结算」，把整场合成**一条**消息发出去让正文模型续写
     *
     * 这个方法保留为空实现，是为了不改动那些调用点 —— 也顺便说明「这里曾经会写聊天」。
     *
     * @param {'round'|'action'|'end'} _trigger
     * @returns {Promise<void>}
     */
    async maybeInject(_trigger) {
        // 刻意不做事。见上面的说明：战斗期间不写聊天。
        return;
    }

    /**
     * 探测「正文模型通道」是否真的可用。
     *
     * 发一次很短的请求。存在的意义：用户遇到通道问题时，
     * 需要能**在设置页当场测出具体原因**，而不是等到开战时看到一句笼统的失败。
     *
     * @returns {Promise<{ok: boolean, ms: number, detail: string}>}
     */
    async probeNarrativeChannel() {
        const started = Date.now();
        const channel = resolveNarrativeChannel(this.settings);
        const modeLabel =
            {
                main: '主连接（当前聊天在用的模型）',
                'tavern-helper': '酒馆助手',
                profile: '连接配置',
                custom: '直连',
            }[channel?.mode] ?? channel?.mode;

        // 主连接模式先做静态检查 —— 能立刻给出确定结论，不必等一次网络往返
        if (channel?.mode === 'main') {
            const helper = getTavernHelper();
            if (!helper || typeof helper.generateRaw !== 'function') {
                return {
                    ok: false,
                    ms: Date.now() - started,
                    detail:
                        '未检测到酒馆助手（TavernHelper）。「主连接」依赖扩展 JS-Slash-Runner（界面显示为「酒馆助手」）—— ' +
                        '请确认它已安装并启用；或者把上面的「正文模型」改成「战斗模型」。',
                };
            }
        }

        try {
            const client = new LlmClient(this.ctx, channel, '通道测试');
            const response = await client.ask('你是一个测试助手。', '请只回复两个字：正常', {
                maxTokens: 32,
                temperature: 0,
                expectedOutputRatio: 0.1,
            });
            const ms = Date.now() - started;
            if (response.ok) {
                return {
                    ok: true,
                    ms,
                    detail: `通道：${modeLabel}　模型：${channel?.model || '（由主连接决定）'}　返回：${response.text.trim().slice(0, 40)}`,
                };
            }
            const reason = describeError(response.error) || '请求失败但没有拿到可读信息（请按 F12 看控制台）';
            return { ok: false, ms, detail: `通道：${modeLabel}\n原因：${reason}` };
        } catch (e) {
            return {
                ok: false,
                ms: Date.now() - started,
                detail: `通道：${modeLabel}\n异常：${describeError(e) || '（异常对象没有可读信息）'}`,
            };
        }
    }

    // -----------------------------------------------------------------------
    // 开战（核心入口）：正文模型读场面 → 掷骰模型结构化 → 开打
    // -----------------------------------------------------------------------

    /**
     * 让正文模型读出当前战斗场面。
     *
     * @param {{situation?: string}} [opts]
     * @returns {Promise<{ok: boolean, error?: string, report?: string, hasBattle?: boolean}>}
     */
    async readBattleSituation(opts = {}) {
        if (this.busy) return { ok: false, error: '正在忙' };
        const settings = this.settings;

        this._abort = new AbortController();
        this.setBusy(true, '正在让正文模型读当前场面…');
        this.setProgress({
            active: true,
            kind: '读取战况',
            stage: 'generate',
            detail: '正在让正文模型读当前场面…',
            batch: 1,
            total: 1,
            percent: 20,
            startedAt: Date.now(),
            cancellable: true,
        });
        this.log('▶ 让正文模型读取当前战斗场面');

        try {
            const result = await readSituation(this.ctx, settings, {
                situation: opts.situation,
                signal: this._abort.signal,
                scanMessages: settings.battle.scanMessages,
                knownUnits: this.powerSystem
                    ? summarizePowerSystem(this.powerSystem, { maxUnits: 30 })
                    : '',
                onProgress: this._progressHandler('读取战况', 2),
            });

            if (result.aborted) {
                this.log('⏹ 读取战况已终止');
                return { ok: false, error: '已被用户终止' };
            }
            if (!result.ok) {
                this.log(`✖ 读取战况失败：${result.error}`);
                // 给出可立刻执行的下一步，而不是让用户对着一个错误干瞪眼
                this.log('  排查：到「设置 → ⚔ 战斗用哪两个模型 → 🔌 测试正文模型」，那里会显示具体原因。');
                if (this.settings.battle.narrativeChannel === 'main') {
                    this.log(
                        '  「主连接」需要酒馆助手（JS-Slash-Runner）。没装或没启用的话，' +
                            '把「正文模型」改成「战斗模型」即可。',
                    );
                }
                toast(`读取战况失败：${result.error}`, 'error');
                return { ok: false, error: result.error };
            }

            this.battleSituation = { report: result.report, situation: opts.situation ?? '', at: Date.now() };
            this.log(`✔ 战况读取完成${result.hasBattle ? '' : '（模型认为当前没有战斗场面）'}`);
            this.notify();
            return { ok: true, report: result.report, hasBattle: result.hasBattle };
        } finally {
            this._endTask();
        }
    }

    /**
     * 用读到的战况开战。
     *
     * 流程：场面汇报 →（**先本地解析**，不行才调模型）→ 写入战力数据 → 开打
     *
     * ⚠️ 这里的关键改动：**本地解析优先**。
     * 原来一律把汇报丢给「掷骰模型」转 JSON，但那份汇报本身就是结构化的
     * （有分节标题、`**名字**`、`- **状态**：`），再让一个小模型去转等于重新赌一次 ——
     * 用户看到的现象就是「汇报里双方都写清楚了，点开战却说没识别到人」。
     * 现在先本地解析，只有解析不出足够单位时才退回调用模型。
     *
     * @param {{situation?: string, skipRead?: boolean, seed?: string, force?: boolean}} [opts]
     * @returns {Promise<{ok: boolean, error?: string, count?: number, noBattle?: boolean}>}
     */
    async startBattleFromSituation(opts = {}) {
        if (this.busy) return { ok: false, error: '正在忙' };
        const settings = this.settings;

        // 1) 先拿到场面汇报（没有就现读一次）
        let report = opts.skipRead ? this.battleSituation?.report : '';
        if (!report) {
            const read = await this.readBattleSituation({ situation: opts.situation });
            if (!read.ok) return { ok: false, error: read.error };
            report = read.report ?? '';

            // 模型明说「当前没有战斗场面」时，不要硬往下走 ——
            // 那样只会让结构化那步产出 0 个单位，最后报一句「没有任何战斗单位」。
            // 把汇报交回界面，让用户看清楚再决定。
            if (read.hasBattle === false && opts.force !== true) {
                this.log('· 正文模型认为当前剧情没有战斗场面，已暂停开战，请确认战况汇报');
                toast('模型认为当前没有战斗场面 —— 看一下战况汇报再决定', 'warning');
                this.notify();
                return { ok: false, error: '模型认为当前剧情没有战斗场面', noBattle: true };
            }
        }
        if (!report.trim()) return { ok: false, error: '没有读到战况内容' };

        this._abort = new AbortController();

        // 2) **先本地解析** —— 汇报是结构化的，直接读就行，不用调模型
        const local = parseSituationReport(report);
        if (local.needsReview) {
            this.log(`⚠ 战斗未启动：${local.error}`);
            this.notify();
            return { ok: false, error: local.error };
        }
        if (local.ok) {
            for (const line of local.logs) this.log(`  ${line}`);
        } else {
            this.log(`· 本地解析没能认出参战者（${local.error}），改用模型结构化`);
        }

        // 本地解析认出了双方就直接用；否则退回模型
        const localUsable = local.ok && (local.stats?.allies ?? 0) > 0 && (local.stats?.enemies ?? 0) > 0;

        // ---- 判定「哪个单位是玩家操控的」----
        //
        // ⚠️ 这里**绝不能猜某个固定名字** —— 插件要适配任何一张卡。
        // 优先级：模型打的【玩家】标记 > 与酒馆 persona 名字匹配 > 用户补充说明里提到。
        // 三个都不中就明说「没识别出来」，让你在界面上点名，而不是瞎指一个。
        if (localUsable) {
            const resolved = resolveUserUnit(local.system.combatants, {
                userName: this.ctx?.name1,
                situationText: opts.situation ?? this.battleSituation?.situation ?? '',
            });
            const persona = toText(this.ctx?.name1);
            if (resolved.unit) {
                for (const u of local.system.combatants) u.isUser = u === resolved.unit;
                // 记住名字 —— 下次开战会重建数据，靠这个名字把「你是谁」带过去
                settings.battle.userUnitName = resolved.unit.name;
                await this.persistSettings({ silent: true });
                const viaLabel = {
                    marker: '正文模型打的【玩家】标记',
                    'marker-ambiguous': '正文模型打了多个标记，取了第一个',
                    'persona-name': `与你在酒馆里登记的名字「${persona}」匹配`,
                    'situation-mention': '出现在你写的补充要求里',
                }[resolved.via] ?? resolved.via;
                this.log(`★ 玩家角色：${resolved.unit.name}（依据：${viaLabel}）`);
                if (resolved.via === 'marker-ambiguous') {
                    this.log('  提示：标记打了多个，可能不准 —— 战斗页可以改。');
                }
            } else {
                this.log('⚠ 没能识别出哪个角色是你操控的（正文模型没打【玩家】标记，名字也对不上）');
                this.log(`  你的 persona 名字是「${persona || '（未设置）'}」。`);
                this.log('  不影响开战 —— 你的角色仍可正常操作，只是「哪些队友该交给 AI」会按全体我方处理。');
                toast('没识别出你的角色 —— 会在日志里说明', 'info');
            }
        }

        let rawSystem = localUsable ? local.system : null;

        if (!rawSystem) {
            this.setBusy(true, '正在把战况转成战斗数据…');
            this.setProgress({
                active: true,
                kind: '准备战斗',
                stage: 'generate',
                detail: '正在把战况转成战斗数据…',
                batch: 1,
                total: 1,
                percent: 60,
                startedAt: Date.now(),
                cancellable: true,
            });
        }

        try {
            if (!rawSystem) {
                const structured = await this._structureViaModel(report, settings, opts);
                if (!structured.ok) return structured;
                rawSystem = structured.system;
            }

            const system = normalizePowerSystem(rawSystem);
            const issues = validatePowerSystem(system);
            const errors = issues.filter((i) => i.level === SEVERITY.ERROR);
            if (errors.length) {
                const message = errors.map((e) => e.message).join('；');
                this.log(`✖ 战况数据有问题：${message}`);
                toast(message, 'error');
                return { ok: false, error: message };
            }

            // 3) 写入战力数据（这样战斗结束后的回写、以及后续更新都有落点）
            const saved = await this.replacePowerSystem(system, localUsable ? '战况解析' : '战况读取');
            if (!saved.ok) return { ok: false, error: saved.error };

            const count = this.powerSystem?.combatants?.length ?? 0;
            this.log(
                `✔ 战况已转成 ${count} 个战斗单位` +
                    (localUsable ? '（本地解析，未消耗 token）' : '（模型结构化）'),
            );

            // 4) 开打
            const started = await this.startBattle({ seed: opts.seed || settings.battle.seed || undefined });
            if (!started.ok) return { ok: false, error: started.error };

            toast(`战斗开始（${count} 个单位）`, 'success');
            this.notify();
            return { ok: true, count };
        } finally {
            this._endTask();
        }
    }

    /**
     * 退回模型做结构化（只在本地解析不出参战者时才走这里）。
     *
     * @param {string} report
     * @param {object} settings
     * @param {{situation?: string}} opts
     * @returns {Promise<{ok: boolean, error?: string, system?: object}>}
     */
    async _structureViaModel(report, settings, opts) {
        this.setBusy(true, '正在把战况转成战斗数据…');
        this.setProgress({
            active: true,
            kind: '准备战斗',
            stage: 'generate',
            detail: '正在把战况转成战斗数据…',
            batch: 1,
            total: 1,
            percent: 60,
            startedAt: Date.now(),
            cancellable: true,
        });

        // 把原始剧情也传过去 —— 汇报漏了谁，模型能从剧情里补
        const situationText = opts.situation ?? this.battleSituation?.situation ?? '';
        const { text: recentChat } = renderRecentMessages(
            this.ctx,
            Math.max(4, Number(settings.battle.scanMessages) || 12),
            { maxCharsPerMessage: 4000 },
        );

        const structured = await structureSituation(this.ctx, settings, report, {
            signal: this._abort?.signal,
            powerSystem: this.powerSystem,
            recentChat,
            situation: toText(situationText) || undefined,
            onProgress: this._progressHandler('准备战斗', 3),
        });

        if (structured.aborted) {
            this.log('⏹ 准备战斗已终止');
            return { ok: false, error: '已被用户终止' };
        }
        if (!structured.ok) {
            this.log(`✖ 结构化失败：${structured.error}`);
            toast(`准备战斗失败：${structured.error}`, 'error');
            return { ok: false, error: structured.error };
        }
        return { ok: true, system: structured.system };
    }

    /**
     * 把文本写进酒馆的输入框（不发送）。
     *
     * 兼容两种环境：
     *  - 有 jQuery 时用 `$('#send_textarea').val(x).trigger('input')` —— 这是本地实测
     *    有效的写法（酒馆自身的输入监听绑在 jQuery 上，光改 `.value` 有时不够）
     *  - 没有 jQuery 时退回原生 `value` + `dispatchEvent('input')`
     *
     * @param {string} text
     * @returns {boolean} 是否写入成功
     */
    writeToInput(text) {
        if (typeof document === 'undefined') return false;
        const el = /** @type {HTMLTextAreaElement|null} */ (document.getElementById('send_textarea'));
        if (!el) return false;

        const value = String(text ?? '');
        try {
            const jq = /** @type {any} */ (globalThis).jQuery ?? /** @type {any} */ (globalThis).$;
            if (typeof jq === 'function') {
                jq(el).val(value).trigger('input');
                return true;
            }
        } catch {
            /* 落到原生路径 */
        }
        try {
            el.value = value;
            el.dispatchEvent(new Event('input', { bubbles: true }));
            return true;
        } catch (e) {
            console.warn(`${TAG} 写入输入框失败`, e);
            return false;
        }
    }

    /**
     * 点发送按钮把输入框里的内容发出去。
     * @returns {boolean} 是否点到按钮
     */
    clickSend() {
        if (typeof document === 'undefined') return false;
        const btn = /** @type {HTMLElement|null} */ (document.getElementById('send_but'));
        if (!btn || btn.disabled || btn.getAttribute?.('aria-disabled') === 'true') return false;
        if (readGenerationActivity(currentGenerationContext(this.ctx)) === true) return false;
        try {
            const jq = /** @type {any} */ (globalThis).jQuery ?? /** @type {any} */ (globalThis).$;
            if (typeof jq === 'function') {
                jq(btn).click();
                return true;
            }
            btn.click();
            return true;
        } catch (e) {
            console.warn(`${TAG} 点击发送按钮失败`, e);
            return false;
        }
    }

    /** 等待本次场景的新回复；结束事件缺失时使用宿主实时生成状态兜底。 */
    waitForGeneration(timeoutMs = 180000, { deferred = false } = {}) {
        this._sceneGenerationWait?.cancel({ ok: false, aborted: true });
        const waiter = createGenerationWait({
            getContext: () => currentGenerationContext(this.ctx),
            signal: this._abort?.signal,
            timeoutMs: Math.max(5000, Number(timeoutMs) || 180000),
            deferred,
            onUpdate: ({ chars, activity }) => {
                if (!this.busy) return;
                if (this.progress.kind === '自定义库润色') {
                    this.setProgress({ detail: chars ? `正文润色已收到 ${chars} 字，等待生成结束…` : '等待正文开始润色…' });
                    return;
                }
                if (this.progress.kind !== '生成战斗场景') return;
                const detail = chars
                    ? activity === true
                        ? `正文模型正在输出战斗场景…（已收到 ${chars} 字）`
                        : `已收到 ${chars} 字，正在确认正文生成结束…`
                    : '等待正文模型开始输出战斗场景…';
                this.setProgress({ detail });
            },
        });
        this._sceneGenerationWait = waiter;
        // 保留清理入口，不能绕过新回复校验直接宣布成功。
        this._resolveGenerationWait = (ok) => ok ? waiter.notifyEnded() : waiter.cancel({ ok: false, aborted: true });
        return waiter.promise.finally(() => {
            if (this._sceneGenerationWait !== waiter) return;
            this._sceneGenerationWait = null;
            this._resolveGenerationWait = null;
        });
    }

    /** 结束事件可能先于流式状态复位，只通知等待器重新核对。 */
    _notifyGenerationEnded() {
        this._sceneGenerationWait?.notifyEnded();
    }

    _notifyGenerationStopped(generationId) {
        // 助手独立请求也发送此事件，带字符串 id；不取消无关的正文场景。
        if (typeof generationId === 'string') return;
        this._sceneGenerationWait?.notifyStopped();
    }

    cancelSceneGeneration() {
        if (!this._sceneGenerationWait && this.progress.kind !== '生成战斗场景') return;
        this._abort?.abort();
        this._sceneGenerationWait?.cancel({ ok: false, aborted: true, chatChanged: true });
    }

    /**
     * **一个按钮完成整个开战流程**（用户要的时序）。
     *
     *     点「开始战斗」
     *        ↓ 自动把战斗场景指令写进输入框并发送
     *     正文模型当场写出一份战斗场景清单
     *        ↓ 等它输出完（GENERATION_ENDED）
     *     本地解析这份清单 → 战斗人物/位阶/武器/临时属性/血量/魔量/技能
     *        ↓
     *     掷骰模型开始战斗
     *
     * 为什么要这么绕：原来是**被动读**已有剧情，剧情里没在打就读不出人、开不了战。
     * 现在是**主动驱动** —— 让正文模型当场生成一份战斗场景，它同时也是能看的剧情。
     *
     * @param {{situation?: string, seed?: string, autoSend?: boolean}} [opts]
     * @returns {Promise<{ok: boolean, error?: string, count?: number, needsManualSend?: boolean}>}
     */
    async startBattleByScene(opts = {}) {
        if (this.busy) return { ok: false, error: '正在忙' };
        this.ctx = currentGenerationContext(this.ctx);
        const identity = generationChatIdentity(this.ctx);
        const settings = this.settings;
        const controller = new AbortController();
        this._abort = controller;
        // 在发送前就锁住入口，防止双击创建两套等待，也让准备阶段可以终止。
        this.setBusy(true, '准备生成战斗场景…');
        this.setProgress({
            active: true, kind: '生成战斗场景', stage: 'prepare', detail: '准备战斗场景指令…',
            batch: 1, total: 1, percent: 10, startedAt: Date.now(), cancellable: true,
        });
        let waiter = null;
        let waited;
        let request;
        let baseline;
        try {
            request = [buildSceneRequest({
                situation: opts.situation, template: settings.battle.scenePrompt,
                characterName: this.ctx?.name2, userName: this.ctx?.name1,
            }), loadoutSceneNote(this.loadoutEntries, { accessoryMode: this.prebattleSelection.accessoryMode })].filter(Boolean).join('\n\n');
            if (!this.writeToInput(request)) {
                this.log('✖ 找不到酒馆输入框（#send_textarea），已把战斗场景指令复制到插件日志');
                this.log('--- 战斗场景指令 ---');
                for (const line of request.split('\n')) this.log(`  ${line}`);
                toast('找不到输入框 —— 指令已写进「日志」页，请手动复制发送', 'warning');
                return { ok: false, error: '找不到酒馆输入框' };
            }
            this.log('📝 已把战斗场景指令写入输入框');
            if (opts.autoSend === false) {
                toast('指令已写入输入框 —— 检查后按发送', 'info');
                return { ok: false, needsManualSend: true, error: '已写入输入框，等待你手动发送' };
            }

            const waitPromise = this.waitForGeneration(Number(settings.battle.sceneTimeout) || 180000, { deferred: true });
            waiter = this._sceneGenerationWait;
            await sleep(120);
            if (controller.signal.aborted || !sameGenerationChat(identity, currentGenerationContext(this.ctx))) {
                return { ok: false, aborted: true, error: '战斗场景读取已停止' };
            }
            // 发送前记录楼层边界，发送前的旧回复和旧结束事件都不能充当结果。
            baseline = currentGenerationContext(this.ctx).chat?.length ?? 0;
            waiter.arm();
            if (waiter.settled) return { ok: false, aborted: true, error: '战斗场景读取已停止' };
            if (!this.clickSend()) {
                this.log('✖ 找不到发送按钮（#send_but）—— 指令已在输入框里，请手动按发送');
                toast('找不到发送按钮 —— 指令已在输入框里，请手动发送', 'warning');
                return { ok: false, error: '找不到发送按钮' };
            }
            this.log('▶ 已发送战斗场景指令，等待正文模型输出…');
            this.setBusy(true, '等待正文模型写出战斗场景…');
            this.setProgress({ stage: 'generate', percent: 40, detail: '等待正文模型输出战斗场景…' });
            waited = await waitPromise;
        } catch (error) {
            const message = describeError(error);
            this.log(`✖ 生成战斗场景失败：${message}`);
            toast(`生成战斗场景失败：${message}`, 'error');
            return { ok: false, error: message };
        } finally {
            waiter?.cancel({ ok: false, aborted: true });
            if (this._abort === controller) this._endTask();
        }

        if (!waited.ok) {
            const error = waited.error ?? (waited.timedOut ? '等待正文输出超时' : '战斗场景读取已停止');
            this.log(`${waited.aborted ? '⏹' : '✖'} ${error}`);
            if (!waited.aborted) toast(error, 'error');
            return { ok: false, aborted: Boolean(waited.aborted), error };
        }
        const ctx = currentGenerationContext(this.ctx);
        if (controller.signal.aborted || !sameGenerationChat(identity, ctx)) {
            return { ok: false, aborted: true, error: '已切换聊天，停止读取原场景' };
        }
        this.ctx = ctx;
        // 使用等待器确认的那条新回复，不能回退到任意旧的 lastAssistantMessage。
        const last = waited.message;
        // 必须在解析或模型结构化前记录准确双楼及原剧情快照；失败不得猜测最新两楼。
        const captured = captureLoadoutChatPair(ctx, identity, baseline, request, last);
        this.battleSituation = { report: last.text, situation: opts.situation ?? '', at: Date.now() };
        this.log(`✔ 已拿到战斗场景（${last.text.length} 字；${waited.via === 'event' ? '结束事件已确认' : '生成状态已确认'}），开始解析`);
        let started;
        try {
            started = await this.startBattleFromSituation({ skipRead: true, seed: opts.seed, force: true });
        } catch (error) {
            const warning = '开战解析或启动异常，已保留本次开战请求与正文回复';
            this.log(`⚠ ${warning}：${describeError(error)}`);
            toast(warning, 'warning');
            return { ok: false, error: describeError(error), cleaned: false, warning };
        }
        if (!started.ok) {
            const warning = '开战未成功，已保留本次开战请求与正文回复';
            this.log(`⚠ ${warning}`);
            toast(warning, 'warning');
            return { ...started, cleaned: false, warning };
        }
        const retained = error => {
            const warning = `战斗已启动，但未清理开战两楼：${error}`;
            this.log(`⚠ ${warning}`);
            toast(warning, 'warning');
            return { ...started, cleaned: false, warning };
        };
        if (controller.signal.aborted || !sameGenerationChat(identity, currentGenerationContext(this.ctx))) {
            return retained('已停止或切换聊天，保留原请求与正文回复');
        }
        if (!captured.ok) return retained(captured.error);
        // startBattle 的旧路径未检查保存返回值；显式确认落盘后才允许清理正文。
        const persisted = await saveChatData(currentGenerationContext(this.ctx), this.data, { silent: true });
        if (!persisted.ok) {
            return retained(`战斗数据未能落盘，保留请求与正文回复：${persisted.error || '保存失败'}`);
        }
        this.log('ℹ 开战清楼模块 1.0.4：核对本次两楼，先删回复再删请求');
        const cleaned = await deleteLoadoutChatPair(() => currentGenerationContext(this.ctx), captured.pair, {
            signal: controller.signal, helper: getTavernHelper(),
        });
        if (!cleaned.ok) return retained(cleaned.error);
        this.log('✔ 战斗已启动并保存，已安全清理本次开战请求与正文回复两楼');
        return { ...started, cleaned: true };
    }

    // -----------------------------------------------------------------------
    // 战力表数据：整体替换与质量自检
    //
    // 注意：战力表**没有界面**了（用户觉得碍事，砍掉了），但数据层必须留着 ——
    // 战斗引擎、开战时读场面、以及剧情后的增量更新都靠它。
    // 它对用户是透明的：不用建、不用看、不用维护。
    // -----------------------------------------------------------------------

    /**
     * 用一份新的战力体系**整体替换**现有表（开战读场面时用）。
     *
     * 每次开战使用当前场景整体替换参战数据。
     *
     * @param {object} rawSystem
     * @param {string} [summary]
     * @returns {Promise<{ok: boolean, error?: string}>}
     */
    async replacePowerSystem(rawSystem, summary = '导入') {
        const saved = await setPowerSystem(this.ctx, rawSystem, {
            source: summary,
            note: summary,
        });
        if (!saved.ok) return { ok: false, error: saved.error };

        // 战斗中的单位跟新表对不上就直接结束战斗，避免两边数据打架
        if (this.battle) {
            this.battle = null;
            await setBattle(this.ctx, null);
            this.log('· 战力数据被整体替换，已结束进行中的战斗');
        }

        // 数据被整体重建 → 重新标出「哪个是玩家」。
        // 忘了这一步的后果：批量决策会连玩家自己也一起替你做决定（踩过）。
        const who = this.markUserUnit(saved.system);
        if (who) this.log(`★ 玩家角色：${who.name}（${who.via}）`);

        this.lastUpdateSummary = `${summary}：${saved.system.combatants.length} 个单位`;
        this.notify();
        return { ok: true };
    }

    /**
     * 对一份战力体系做质量自检。
     * @param {object} system
     * @returns {{ok: boolean, fatal: string[], warn: string[], stats: object}}
     */
    assessQuality(system) {
        return checkPowerSystemQuality(system ?? this.powerSystem);
    }

    /** 当前战力数据的质量自检结果。 */
    get quality() {
        return this.assessQuality(this.powerSystem);
    }

    // -----------------------------------------------------------------------
    // 战斗
    // -----------------------------------------------------------------------

    /**
     * 开一场新战斗。
     * @param {{seed?: string, name?: string, includeNeutral?: boolean, fresh?: boolean}} [opts]
     * @returns {Promise<{ok: boolean, error?: string}>}
     */
    async startBattle(opts = {}) {
        const system = applyLoadout(this.powerSystem, this.loadoutEntries, { playerName: this.settings.battle.userUnitName || this.ctx?.name1, accessoryMode: this.prebattleSelection.accessoryMode });
        if (!system?.combatants?.length) {
            toast('还没有战斗数据，请先点「读场面并开战」', 'warning');
            return { ok: false, error: '还没有战斗数据' };
        }

        // 开战需要双方都在。缺一方时给出**可操作**的说明，而不是只丢一句「没有敌方单位」。
        const aliveAllies = system.combatants.filter((/** @type {any} */ u) => u.side === 'ally' && u.alive !== false);
        const aliveEnemies = system.combatants.filter((/** @type {any} */ u) => u.side === 'enemy' && u.alive !== false);
        if (!aliveAllies.length || !aliveEnemies.length) {
            const missing = !aliveAllies.length ? '我方' : '敌方';
            const detail =
                `当前战斗数据里没有可战的${missing}单位（共 ${system.combatants.length} 个单位：` +
                `我方 ${aliveAllies.length}，敌方 ${aliveEnemies.length}）。\n` +
                `常见原因：读场面时没读全参战双方。可以在战况输入框里写清「谁在打谁」再重读一次。`;
            this.log(`✖ 无法开战：缺少${missing}单位`);
            toast(`无法开战：缺少${missing}单位`, 'error');
            return { ok: false, error: `没有可战的${missing}单位` };
        }

        const ruleset = this.ruleset;
        // 战斗模式：设置里可以强制指定，默认用正文 AI 判定的那个
        const modeSetting = this.settings.battle.combatMode;
        const combatMode =
            modeSetting === 'spar' || modeSetting === 'deadly'
                ? modeSetting
                : system.combatMode === 'deadly'
                  ? 'deadly'
                  : 'spar';

        const battle = new Battle(system, {
            seed: opts.seed,
            name: opts.name || `${system.systemName} · 第 ${this._battleCount() + 1} 战`,
            ruleset,
            includeNeutral: opts.includeNeutral,
            combatMode,
        });

        const started = battle.start();
        if (!started.ok) {
            toast(`无法开战：${started.error}`, 'error');
            return { ok: false, error: started.error };
        }

        // 开战只建立战场与先攻；玩家提交行动才处理排在其前面的 AI。
        battle.awaitingPlayerAction = true;
        this._autoDriveBudget = 0;
        this.battle = battle;
        this.displayRoll = null;
        this.diceRoller?.hide();
        this.battleResultSnapshot = null;
        this.battleSent = false;
        this.data.battleResult = null;
        await setBattle(this.ctx, battle.toState());
        const modeLabel = battle.combatMode === 'deadly' ? '生死搏杀' : '切磋';
        const modeFrom = modeSetting === 'auto' ? '正文 AI 判定' : '设置里指定';
        this.log(
            `⚔️ 开战：${battle.name}（${modeLabel}，${modeFrom}；种子 ${battle.seed}，` +
                `规则集「${ruleset.name}」，${battle.units.length} 个单位）`,
        );
        if (battle.combatMode === 'spar') {
            this.log('  · 切磋模式：倒下算「力竭」，不会阵亡');
        }
        this.notify();
        // 开战、换人和界面渲染均不自动消费回合。
        this._autoDriveStop = true;
        return { ok: true };
    }

    /** 统计本聊天打过几场（用审计日志计数，避免额外存字段）。 */
    _battleCount() {
        return (this.data.auditLog ?? []).filter((/** @type {any} */ e) => e.type === 'battle-start').length;
    }

    /**
     * 执行当前单位的行动。
     * @param {{action?: string, skillId?: string, targetIds?: string[]}} action
     * @returns {Promise<{ok: boolean, error?: string}>}
     */
    /**
     * 从本轮批量决策缓存里取出某个单位的行动。
     *
     * 取过就删掉 —— 一个单位一轮只能消费一次决策，
     * 否则「连续推进」时会重复使用同一份决策。
     *
     * @param {any} battle
     * @param {any} unit
     * @returns {any|null}
     */
    _takeQueuedDecision(battle, unit) {
        const queue = this._decisionQueue;
        if (!queue || queue.battleId !== battle.id) return null;
        if (queue.round !== battle.round) return null;
        const decision = queue.byUnit?.[unit.id];
        if (!decision) return null;
        delete queue.byUnit[unit.id];
        return decision;
    }

    /**
     * 判断一个单位是不是**玩家操控的**。
     *
     * 两级依据（因为数据会被重建，两个都得看）：
     *  ① 单位上的 `isUser` 标记 —— 本次开战时识别出来的
     *  ② 设置里持久化的 `userUnitName` —— 跨战斗记住的
     *
     * @param {any} unit
     * @returns {boolean}
     */
    isUserUnit(unit) {
        if (!unit) return false;
        if (unit.isUser) return true;
        const remembered = toText(this.settings.battle.userUnitName);
        if (!remembered) return false;
        return toText(unit.name) === remembered;
    }

    /**
     * 给一份战斗数据标好「哪一个是玩家」。
     *
     * 每次数据被重建（读场面 / 生成场景 / 增量更新）之后都要调一次 ——
     * 否则 `isUser` 会丢，批量决策就会连你自己也一起替你做决定。
     *
     * @param {any} system
     * @returns {{name: string, via: string}|null}
     */
    markUserUnit(system) {
        const combatants = system?.combatants ?? [];
        if (!combatants.length) return null;

        // ① 数据里已经带了标记
        const marked = combatants.filter((/** @type {any} */ u) => u.isUser);
        if (marked.length >= 1) {
            for (const u of combatants) u.isUser = u === marked[0];
            return { name: marked[0].name, via: 'marker' };
        }

        // ② 设置里记住的名字（跨战斗）
        const remembered = toText(this.settings.battle.userUnitName);
        if (remembered) {
            const hit = combatants.find((/** @type {any} */ u) => toText(u.name) === remembered);
            if (hit) {
                hit.isUser = true;
                return { name: hit.name, via: 'remembered' };
            }
        }

        // ③ 拿 persona 名字再试一次
        const persona = toText(this.ctx?.name1);
        if (persona) {
            const hit = combatants.find(
                (/** @type {any} */ u) => toText(u.name) === persona || toText(u.name).includes(persona),
            );
            if (hit) {
                hit.isUser = true;
                return { name: hit.name, via: 'persona' };
            }
        }

        return null;
    }

    /**
     * 手动指定「哪个单位是我」。
     * @param {string} unitName
     * @returns {Promise<{ok: boolean}>}
     */
    async setUserUnit(unitName) {
        if (this.busy || this._autoDriving || this._playerTurnRunning) {
            return { ok: false, error: '当前行动尚未结束，请等待后换人' };
        }
        const name = toText(unitName);
        const battle = this.battle;
        const metadata = this.ctx.chatMetadata;
        if (name && battle && !battle.units.some(u => u.side === 'ally' && u.alive && toText(u.name) === name)) {
            return { ok: false, error: '只能切换到仍可行动的我方角色' };
        }
        // 身份必须在任何异步保存/重绘前一起更新，避免临时出现两个玩家。
        this.settings.battle.userUnitName = name;
        // 换人只改变操控选择；回合和骰子等到玩家提交行动才继续。
        this._autoDriveStop = true;
        if (battle) battle.awaitingPlayerAction = true;
        this._autoDriveBudget = 0;
        this._decisionQueue = null;
        if (battle) {
            for (const u of battle.units) u.isUser = toText(u.name) === name;
            // 队列里可能排了「替你行动」的决策 —— 清掉，别让它顶掉你的操作
            if (this._decisionQueue) {
                for (const u of battle.units) {
                    if (u.isUser) delete this._decisionQueue.byUnit[u.id];
                }
            }
        }
        const data = getChatData(this.ctx);
        for (const u of data.powerSystem?.combatants ?? []) u.isUser = toText(u.name) === name;
        await this.persistSettings({ silent: true });
        if (this.battle !== battle || this.ctx.chatMetadata !== metadata) return { ok: false, error: '聊天或战斗已切换' };
        await saveChatData(this.ctx, data, { silent: true });
        if (this.battle !== battle || this.ctx.chatMetadata !== metadata) return { ok: false, error: '聊天或战斗已切换' };
        if (battle) await setBattle(this.ctx, battle.toState());
        if (this.battle !== battle || this.ctx.chatMetadata !== metadata) return { ok: false, error: '聊天或战斗已切换' };
        this.log(`★ 已把你指定为「${name || '（未指定）'}」`);
        this.notify();
        return { ok: true };
    }

    /**
     * 为**同侧所有单位**这一轮的行动做一次批量决策。
     *
     * 多人战的关键优化：5 个敌人原本 5 次调用，现在 1 次。
     * 而且模型能看到所有同伴的技能，可以**互相配合**（先控住谁、再集火谁）——
     * 逐单位分别决策是做不到这一点的。
     *
     * @param {any} battle
     * @returns {Promise<{ok: boolean, error?: string, count?: number, saved?: number}>}
     */
    async planRound(battle) {
        const settings = this.settings;
        if (!battle || battle.phase === 'finished') return { ok: false, error: '战斗已结束' };
        if (settings.battle.decideMode === DECIDE_MODE.OFF) {
            return { ok: false, error: '决策模式是「不调用」，无法批量思考' };
        }
        if (settings.battle.batchDecisions === false) {
            return { ok: false, error: '设置里关掉了「合并成一次思考」' };
        }

        // 待决策 = 同侧全部存活单位（敌方要不要 AI 由 decideForEnemies 决定）
        const unit = battle.currentUnit;
        if (!unit) return { ok: false, error: '当前没有行动单位' };
        const side = unit.side;
        if (side === 'enemy' && settings.battle.decideForEnemies === false) {
            return { ok: false, error: '设置里关掉了「敌方也让 AI 思考」' };
        }

        const allAlive = battle.units.filter((/** @type {any} */ u) => u.side === side && u.alive);

        // ---- 我方：把玩家操控的那个排除掉 ----
        //
        // 用户要的是「队友交给 AI，我只管自己」。所以批量决策覆盖的是**队友**，
        // 玩家自己的行动永远由玩家决定。
        const owners = battle.units.filter((u) => this.isUserUnit(u));
        if (owners.length !== 1) return { ok: false, error: '玩家身份未唯一确定，请在「你操控」中指定角色' };
        if (side === 'ally' && settings.battle.aiControlsAllies === false) return { ok: false, error: '队友自动操作已关闭' };
        let units = allAlive.filter((u) => !this.isUserUnit(u));
        let skippedUser = '';
        if (side === 'ally') {
            const userUnit = allAlive.find((/** @type {any} */ u) => this.isUserUnit(u));
            if (userUnit) {
                units = allAlive.filter((/** @type {any} */ u) => u !== userUnit);
                skippedUser = userUnit.name;
            }
        }

        if (!units.length) {
            return {
                ok: false,
                error: skippedUser
                    ? `这一侧只剩你操控的「${skippedUser}」—— 你自己决定怎么打`
                    : '这一侧没有可交给 AI 的单位',
                skippedUser,
            };
        }
        if (units.length < 2 && side === 'enemy') {
            return { ok: false, error: '这一侧只有 1 个单位，直接让它出手即可（合并思考没有意义）' };
        }

        this._abort = new AbortController();
        this.setBusy(true, `正在为 ${units.length} 个${side === 'ally' ? '我方' : '敌方'}单位做本轮决策…`);
        this.setProgress({
            active: true,
            kind: '本轮决策',
            stage: 'generate',
            detail: `正在一次想好 ${units.length} 个单位的行动…`,
            batch: 1,
            total: 1,
            percent: 30,
            startedAt: Date.now(),
            cancellable: true,
        });
        this.log(`▶ 批量决策：${side === 'ally' ? '我方' : '敌方'} ${units.length} 个单位（${units.map((u) => u.name).join('、')}）`);

        try {
            const result = await decideActionsBatch(this.ctx, settings, battle, units, {
                signal: this._abort.signal,
                onProgress: this._progressHandler('本轮决策', 2),
            });

            if (result.aborted) {
                this.log('⏹ 批量决策已终止');
                return { ok: false, error: '已被用户终止' };
            }
            for (const line of result.logs ?? []) this.log(`  ${line}`);
            if (!result.ok) {
                this.log(`✖ 批量决策失败：${result.error}`);
                return { ok: false, error: result.error };
            }

            /** @type {Record<string, any>} */
            const byUnit = { ...(result.decisions ?? {}) };
            let count = Object.keys(byUnit).length;
            let localsFilled = 0;

            // ---- 兜底：模型没给到的单位，用本地规则补上 ----
            //
            // 不这么做的话，解析失败就意味着「整侧单位这一轮什么都不做」——
            // 用户会看到「已想好 0/2 个单位」然后战斗卡住。
            // 本地规则至少让它们正常出手（只是没有 AI 写的那句动作描述）。
            if (count < units.length) {
                const { autoChooseAction } = await import('./combat/engine.js');
                for (const u of units) {
                    if (byUnit[u.id]) continue;
                    const choice = autoChooseAction(battle, { forUnit: u });
                    if (choice) {
                        byUnit[u.id] = {
                            skillId: choice.skillId ?? '',
                            targetName: this._targetNameFor(choice, battle),
                            action: choice.action ?? (choice.skillId ? 'skill' : 'attack'),
                            flavor: '',
                            fromLocalRule: true,
                        };
                        localsFilled++;
                    }
                }
                count = Object.keys(byUnit).length;
            }

            this._decisionQueue = { battleId: battle.id, round: battle.round, side, byUnit };

            if (localsFilled) {
                this.log(`· 其中 ${localsFilled} 个单位改用本地规则（模型没给到）`);
            }
            this.log(`✔ 本轮已想好 ${count}/${units.length} 个单位的行动（省下 ${Math.max(0, units.length - 1)} 次调用）`);
            toast(
                localsFilled
                    ? `已安排 ${count} 个单位（${localsFilled} 个用本地规则）`
                    : `已一次想好 ${count} 个单位的行动`,
                localsFilled ? 'warning' : 'success',
            );
            this.notify();
            const saved = Math.max(0, units.length - 1);
            return { ok: true, count, saved, localsFilled, parseFailed: Boolean(result.parseFailed) };
        } finally {
            this._endTask();
        }
    }

    /**
     * 让当前单位行动一步。
     *
     * ## 这是「一回合」的完整流程（用户要的时序）
     *
     *   1. 记录当前日志长度，准备取本次掷骰结果
     *   2. **骰子开始转** ──────────────────┐
     *   3. 调 API 思考本次行动                │ 这段时间骰子在转 ——
     *      （flavor 模式只写动作描述；        │ 等待被赋予了「正在掷骰」的意义
     *        auto 模式连技能与目标一起决定）  │
     *   4. **骰子停下，显示 d20 结果** ───────┘
     *   5. 本地引擎结算（命中/伤害/状态）—— 不调 LLM
     *   6. 显示回合结果，轮到下一个单位
     *
     * 注意第 5 步永远在本地：AI 只决定「怎么打」，**不决定成败**。
     * 否则模型会写出「一剑刺穿心脏造成 240 伤害」，而引擎算出的是「未命中」。
     *
     * @param {{action?: string, skillId?: string, targetIds?: string[], targetId?: string}} action
     * @returns {Promise<{ok: boolean, error?: string, lines?: string[], roll?: object, flavor?: string}>}
     */
    /** 当前玩家对一个具体NPC的累计说服；切换角色时不能沿用他人的关系进展。 */
    getPersuasion(targetId) {
        const players = this.battle?.units.filter(unit => unit.alive && this.isUserUnit(unit)) ?? [];
        if (players.length !== 1) return null;
        const state = findPersuasion(this.battle, players[0].id, targetId);
        return state ? JSON.parse(JSON.stringify(state)) : null;
    }

    getCharmPreview(targetId) {
        const players = this.battle?.units.filter(unit => unit.alive && this.isUserUnit(unit)) ?? [];
        return players.length === 1 ? previewCharmCheck(this.battle, players[0].id, targetId) : null;
    }

    _charmContext(targetId, pendingId) {
        if (this.busy || this._playerTurnRunning || this._autoDriving) return { error: '请等待当前行动结束' };
        const battle = this.battle;
        const preview = this.getCharmPreview(targetId);
        if (!battle || battle.phase === 'finished' || !this.isUserUnit(battle.currentUnit)) return { error: '请在你的回合确认说服检定' };
        if (!preview || preview.id !== pendingId) return { error: '这次检定已不可用，请继续劝说后再确认新条件' };
        const speaker = battle.currentUnit;
        const target = battle.units.find(unit => unit.id === targetId);
        if (preview.speakerId !== speaker.id) return { error: '这次说服不属于当前操控的角色' };
        return { battle, speaker, target, state: findPersuasion(battle, speaker.id, targetId), preview, metadata: this.ctx.chatMetadata };
    }

    async deferCharmCheck({ targetId, pendingId } = {}) {
        const context = this._charmContext(targetId, pendingId);
        if (context.error) return { ok: false, error: context.error };
        const controller = new AbortController();
        this._abort = controller;
        this.setBusy(true, '保存检定选择…');
        try {
            context.state.pending.deferred = true;
            await this._persistBattle();
            if (this.battle !== context.battle || this.ctx.chatMetadata !== context.metadata) return { ok: false, error: '聊天或战斗已切换' };
            return { ok: true };
        } finally {
            if (this._abort === controller) this._endTask();
        }
    }

    /** 只有玩家点击确认才消耗随机数并结算；待确认条件单次使用。 */
    async rollCharmCheck({ targetId, pendingId } = {}) {
        const context = this._charmContext(targetId, pendingId);
        if (context.error) return { ok: false, error: context.error };
        const { battle, speaker, target, state, preview, metadata } = context;
        const controller = new AbortController();
        const assertCurrent = () => {
            if (controller.signal.aborted || this.battle !== battle || this.ctx.chatMetadata !== metadata ||
                battle.currentUnit !== speaker || !this.isUserUnit(speaker) || !speaker.alive || !target.alive || target.side !== 'enemy' ||
                state.pending?.id !== pendingId || battle.phase === 'finished') {
                throw Object.assign(new Error('说服检定已终止或当前战况已变化'), { name: 'AbortError' });
            }
        };
        this._abort = controller;
        this.setBusy(true, '正在进行说服检定…');
        let settled = false;
        try {
            this.displayRoll = { rolling: true, value: 0, outcome: '', checkKind: 'charm', actorName: speaker.name, targetName: target.name };
            this.notify();
            if (this.settings.battle.showDice !== false) {
                this.diceRoller?.roll({ cycleMs: this.settings.battle.diceCycleMs });
                await sleep(Math.max(0, Math.min(15000, Number(this.settings.battle.diceMinDuration) || 0)), controller.signal);
            }
            assertCurrent();
            const check = resolveRecruitment(battle, speaker, target, preview);
            recordCharmRoll(state, check);
            if (check.success) this._decisionQueue = null;
            this.displayRoll = {
                rolling: false, checkKind: 'charm', hitMode: 'dice', value: check.natural, nat: check.natural,
                dieFaces: 20, total: check.total, target: check.dc,
                actorName: speaker.name, targetName: target.name, outcome: check.success ? 'hit' : 'miss',
                formula: 'd20 + floor((对目标魅力 - 50) / 10)',
                modifiers: [{ source: '对目标的魅力', value: check.modifier,
                    detail: `魅力 ${check.charmValue}：floor((${check.charmValue} − 50) / 10)` }],
                override: check.natural === 20 ? 'crit' : check.natural === 1 ? 'fumble' : null,
                specialRule: check.natural === 20 ? '天然 d20 = 20' : check.natural === 1 ? '天然 d20 = 1' : '',
                dice: [{ count: 1, faces: 20, rolls: [check.natural], total: check.natural }],
            };
            this.diceRoller?.settle(check.natural, 20);
            settled = true;
            await this._persistBattle();
            return { ok: true, check };
        } catch (error) {
            const message = describeError(error);
            if (this.battle === battle && this.ctx.chatMetadata === metadata) this.log(`⚠ 说服检定：${message}`);
            return { ok: false, error: message };
        } finally {
            if (!settled && this.battle === battle) { this.diceRoller?.hide(); this.displayRoll = null; }
            if (this._abort === controller) this._endTask();
        }
    }

    /** 口嗨留在插件内；模型评估累计进展和条件，玩家确认后才掷骰。 */
    async sendBanter({ targetId, text } = {}) {
        const battle = this.battle;
        if (this.busy || this._playerTurnRunning || this._autoDriving) return { ok: false, error: '请等待当前行动结束' };
        if (!battle || battle.phase === 'finished' || !this.isUserUnit(battle.currentUnit)) return { ok: false, error: '请在你的回合口嗨' };
        const speaker = battle.currentUnit;
        const target = battle.units.find(u => u.id === targetId && u.id !== speaker.id && u.alive && u.side === 'enemy' && !this.isUserUnit(u));
        text = String(text ?? '').trim();
        if (!target || !text || text.length > 2000) return { ok: false, error: '请选择存活的敌方角色，并输入1～2000字' };
        const metadata = this.ctx.chatMetadata;
        const settings = { banter: JSON.parse(JSON.stringify(this.settings.banter)) };
        const controller = new AbortController();
        const signal = controller.signal;
        const assertCurrent = () => {
            if (signal.aborted || this.battle !== battle || this.ctx.chatMetadata !== metadata) {
                throw Object.assign(new Error('口嗨已终止或聊天已切换'), { name: 'AbortError' });
            }
            if (!target.alive || target.side !== 'enemy' || this.isUserUnit(target)) {
                throw Object.assign(new Error('目标已不是存活的敌方角色，已取消说服'), { name: 'AbortError' });
            }
        };
        this._abort = controller;
        this.setBusy(true, '正在等待NPC回应…');
        let reply;
        let persuasion;
        try {
            const previous = findPersuasion(battle, speaker.id, target.id);
            const previousPersuasion = previous ? JSON.parse(JSON.stringify(previous)) : null;
            battle.pushBanter(`💬 ${speaker.name} → ${target.name}：${text}`, { speakerId: speaker.id, targetId: target.id });
            await this._persistBattle();
            assertCurrent();
            const bookName = settings.banter.readWorldbook !== false ? settings.banter.worldbookName : '';
            const person = await readCharacterPersona(this.ctx, { bookName, characterName: target.name, signal });
            assertCurrent();
            if (!person.ok && bookName) this.log(`⚠ 人设读取：${person.error || person.status}`);
            const persona = person.persona || target.social?.persona || '';
            reply = await generateBanter(this.ctx, settings, { battle, speaker, target, text, persona, signal, persuasion: previousPersuasion });
            assertCurrent();
            battle.pushBanter(`💬 ${target.name}：${reply.reply}`, { speakerId: target.id, targetId: speaker.id, intent: reply.intent });
            // 仅本次真实劝说可以更新累计状态；闲聊与狠话只保存对白。
            persuasion = reply.intent === 'persuasion' ? recordPersuasion(battle, speaker, target, reply) : previous;
            await this._persistBattle();
            assertCurrent();
            this.notify();
            if (person.status === 'missing' && settings.banter.createMissingPersona !== false) {
                const summary = reply.personaSummary || target.social?.persona || `${target.name}是当前战斗的${target.side === 'enemy' ? '敌方' : '我方'}成员；其余人设尚未明确。`;
                const saved = await ensureCharacterPersona(this.ctx, { bookName, characterName: target.name,
                    persona: { text: summary, source: '当前战斗场景与所选最近剧情楼层整理' }, signal });
                assertCurrent();
                if (saved.created) this.log(`· 已向「${bookName}」补写${target.name}的人设条目`);
                else if (!saved.ok) this.log(`⚠ 人设补写失败：${saved.error || saved.status}`);
            }
            if (reply.intent === 'persuasion' && shouldCheckCharm(target, reply, persuasion)) {
                this.setBusy(true, '正在确认检定条件…');
                const assessment = await evaluateCharm(this.ctx, settings, { battle, speaker, target, text, reply, persona, signal, persuasion });
                assertCurrent();
                const pending = offerCharmCheck(battle, persuasion, assessment);
                if (pending) this.log(`· ${target.name}的说服条件已就绪：DC ${pending.dc}，d20需${pending.requiredNatural}点；等待你选择是否掷骰`);
                await this._persistBattle();
                assertCurrent();
            }
            return { ok: true, reply: reply.reply, intent: reply.intent, pending: this.getCharmPreview(target.id),
                persuasion: persuasion ? JSON.parse(JSON.stringify(persuasion)) : null };
        } catch (error) {
            const message = describeError(error);
            if (this.battle === battle && this.ctx.chatMetadata === metadata) {
                this.log(`⚠ 口嗨：${message}`);
                // 已得到的台词和累计进展不丢失；失败或取消都不能擅自掷骰、改阵营。
                if (reply?.intent === 'persuasion' && persuasion?.status === 'awaiting_assessment') {
                    persuasion.status = 'error';
                    persuasion.reason = `条件评估未完成：${message}。累计动摇已保留，可继续劝说。`;
                }
                await this._persistBattle();
            }
            return { ok: false, error: message, reply: reply?.reply };
        } finally {
            if (this._abort === controller) this._endTask();
            this.notify();
        }
    }

    /** 换人暂停期间可先选新角色技能；不改先攻顺序、不在预览时推进。 */
    getActionUnit() {
        const battle = this.battle;
        if (battle?.awaitingPlayerAction) {
            const owners = battle.units.filter(u => u.alive && u.side === 'ally' && this.isUserUnit(u));
            return owners.length === 1 ? owners[0] : null;
        }
        return battle?.currentUnit ?? null;
    }

    async playPlayerTurn(action = {}) {
        if (this._playerTurnRunning || this.busy) return { ok: false, error: '本轮正在处理，请等待' };
        const battle = this.battle;
        const actor = this.getActionUnit?.() ?? battle?.currentUnit;
        if (!battle || !actor || !this.isUserUnit(actor) || battle.phase === 'finished') return { ok: false, error: '当前不是你的回合' };
        // 换人后的计划必须先合法，错误按钮/失效目标不能触发 AI 快进。
        if (battle.awaitingPlayerAction) {
            const skill = action.skillId ? actor.skills.find(s => s.id === action.skillId) : { target: 'single', effects: [{ type: 'damage' }] };
            if (!skill) return { ok: false, error: '技能已失效，请重新选择' };
            if (action.skillId && !canUseSkill(actor, skill).usable) return { ok: false, error: canUseSkill(actor, skill).reason };
            if (!['defend', 'skip'].includes(action.action)) {
                const targets = battle.targetCandidates(actor, skill);
                if (!targets.length || (action.targetIds !== undefined && (!Array.isArray(action.targetIds) || !action.targetIds.length
                    || action.targetIds.some(id => !targets.some(t => t.id === id))))
                    || (skill.target === 'single' && action.targetIds?.length !== 1)) {
                    return { ok: false, error: '请先选定有效目标' };
                }
            }
        }
        const metadata = this.ctx?.chatMetadata;
        const controller = new AbortController();
        this._playerTurnRunning = true;
        this._abort = controller;
        this._autoDriveStop = false;
        battle.awaitingPlayerAction = false;
        this.setBusy(true, '正在处理本轮行动…');
        try {
            // 保留先攻：只有提交技能后才处理排在所选角色前面的 AI 行动。
            if (battle.currentUnit !== actor) await this.autoAdvance({ maxSteps: 60 });
            if (controller.signal.aborted || this._autoDriveStop || this.battle !== battle || this.ctx?.chatMetadata !== metadata) {
                return { ok: false, error: '行动已停止' };
            }
            if (battle.currentUnit !== actor || !this.isUserUnit(actor) || actor.alive === false || battle.phase === 'finished') {
                return { ok: false, error: '尚未轮到所选角色或其已无法行动，请重新选择' };
            }
            // 之前的 AI 可能改变目标状态；engine 会在扣费前再次验证。
            const result = await this.act(action);
            if (!result.ok || this._autoDriveStop || this.battle !== battle) return result;
            await this.autoAdvance({ maxSteps: 60 });
            return result;
        } finally {
            if (this.battle === battle) {
                battle.awaitingPlayerAction = true;
                this._autoDriveStop = true;
                await this._persistBattle?.();
            }
            if (this._abort === controller) this._abort = null;
            this._playerTurnRunning = false;
            this.setBusy(false);
            this.notify();
        }
    }

    /** 可注入测试；关闭或终止询问必须暂停，不能默认继续致命行动。 */
    askMercy(options) {
        return mercyDialog(options);
    }

    async act(action = {}) {
        // ⚠️ 出手时清掉上一次的「停止自动推进」状态。
        // 否则只要你点过一次「⏹ 停止」，之后每打一手都会停在原地 ——
        // 表现就是「敌方还要我一个个点」（用户实测报过）。
        this._autoDriveStop = false;

        if (!this.battle) return { ok: false, error: '没有进行中的战斗' };
        const battle = this.battle;
        const unit = battle.currentUnit;
        if (!unit) return { ok: false, error: '当前没有行动单位' };

        const settings = this.settings;
        const before = battle.phase;
        const roundBefore = battle.round;
        const metadataBefore = this.ctx.chatMetadata;
        const signal = this._abort?.signal;
        const logIndexBefore = battle.log.length;

        const aiControlled = !this.isUserUnit(unit) && (unit.side === 'enemy' || settings.battle.aiControlsAllies !== false);
        const decisionSettings = aiControlled ? { ...settings, battle: { ...settings.battle, decideMode: DECIDE_MODE.AUTO, decideForEnemies: true } } : settings;
        const useAi =
            (aiControlled || settings.battle.decideMode !== DECIDE_MODE.OFF) &&
            action.action !== 'skip' &&
            action.action !== 'defend';

        // ---- 1. 取本次要用的决策 ----
        //
        // 两种来源，优先级从高到低：
        //  ① 本轮批量决策的缓存（多人战时一次调用想好所有人的行动）
        //  ② 现调一次 API（单身决策）
        const side = unit.side;
        /**
         * 玩家是否明确指定了这一手。
         *
         * ⚠️ 这个判断很重要：批量决策排队之后，轮到玩家自己的单位时必须**让位** ——
         * 否则 AI 排队的那一手会把玩家的选择悄悄顶掉，玩家会以为按钮坏了。
         */
        const playerChose = Boolean(action.skillId) || action.action === 'attack' ||
            Boolean(action.targetIds?.length) || action.action === 'defend' || action.action === 'skip';

        /** @type {any} */
        let decision = null;
        let decisionFromCache = false;

        if (useAi && settings.battle.batchDecisions !== false && !playerChose) {
            decision = this._takeQueuedDecision(battle, unit);
            decisionFromCache = Boolean(decision);
        }

        if (useAi) {
            // ---- 2. 骰子开始转 ----
            this._rollStartedAt = Date.now();
            // 换面间隔可调（设置里的「骰子转速」）。默认 150ms —— 比早期慢一倍多，
            // 因为用户实测「转的太快了，慢一点」（65ms 时数字快到看不清）。
            this.diceRoller?.roll({ cycleMs: this.settings.battle.diceCycleMs });
            this.displayRoll = { rolling: true, value: 0, outcome: '', actorName: unit.name,
                penaltyPreview: hitPenaltyPreview(unit, battle.ruleset),
                skillName: unit.skills?.find(s => s.id === action.skillId)?.name || '攻击' };
            this.notify();

            if (!decisionFromCache) {
                try {
                    // ---- 3. 调 API 思考（骰子在这段时间一直转）----
                    const result = await decideAction(this.ctx, decisionSettings, battle, {
                        signal: this._abort?.signal,
                        preselect: {
                            skillId: action.skillId,
                            targetName: this._targetNameFor(action, battle),
                            action: action.action ?? (action.skillId ? 'skill' : 'attack'),
                        },
                        onProgress: null,
                    });

                    if (result.aborted) {
                        this.diceRoller?.hide();
                        this.displayRoll = null;
                        this.notify();
                        return { ok: false, error: '已被用户终止' };
                    }
                    if (result.ok && result.decision) decision = result.decision;
                    for (const line of result.logs ?? []) this.log(`  ${line}`);
                } catch (e) {
                    // 决策失败**不该让战斗卡住** —— 退回本地规则继续打
                    this.log(`⚠ 决策异常，本回合退回本地规则：${describeError(e)}`);
                }
            } else {
                this.log(`· 使用本轮已想好的行动（批量决策，未额外调用）`);
            }
        }

        // ---- 4. 合并 AI 决策与玩家选择，然后结算 ----
        /** @type {any} */
        let finalAction = { ...action };
        if (aiControlled && !decision) {
            const { autoChooseAction } = await import('./combat/engine.js');
            finalAction = autoChooseAction(battle);
            this.log('⚠ AI 决策不可用，本次使用本地行动规则');
        }
        if (decision && aiControlled) {
            if (decision.action === 'defend' || decision.action === 'skip') {
                finalAction.action = decision.action;
            } else if (decision.skillId) {
                finalAction.skillId = decision.skillId;
                finalAction.action = 'skill';
            } else if (!finalAction.skillId) {
                finalAction.action = 'attack';
            }
            // 目标：玩家选过就听玩家的，否则用 AI 选的
            if ((!finalAction.targetIds || !finalAction.targetIds.length) && (decision.targetId || decision.targetName)) {
                const target = battle.units.find(u => decision.targetId ? u.id === decision.targetId : u.name === decision.targetName);
                if (target) finalAction.targetIds = [target.id];
            }
        }

        if (signal?.aborted || this.battle !== battle || this.ctx.chatMetadata !== metadataBefore ||
            battle.currentUnit !== unit || battle.round !== roundBefore) {
            if (this.battle === battle) { this.diceRoller?.hide(); this.displayRoll = null; this.notify(); }
            return { ok: false, error: '战斗或当前行动者已改变，本次行动未执行' };
        }
        if (aiControlled && !['defend', 'skip'].includes(finalAction.action)) {
            const skill = unit.skills?.find(s => s.id === finalAction.skillId) || { target: 'single', effects: [{ type: 'damage' }] };
            const legal = battle.targetCandidates(unit, skill);
            if (finalAction.targetIds?.some(id => !legal.some(target => target.id === id))) {
                this.log('⚠ AI 选择的目标已不合法，改用当前合法目标');
                delete finalAction.targetIds;
            }
            if (skill.target === 'single' && finalAction.targetIds?.length !== 1) {
                const target = chooseFallbackTarget(battle, unit, skill);
                if (target) finalAction.targetIds = [target.id];
            }
        }
        // 致命风险只作无副作用预判；真正命中与阻止骰仍由引擎结算。
        delete finalAction.mercyTargetIds;
        delete finalAction.interceptTargetIds;
        const threats = battle.lethalCandidates(finalAction);
        if (threats.length) {
            this.diceRoller?.hide();
            this.displayRoll = null;
            this.notify();
            const identity = generationChatIdentity(this.ctx);
            const isPlayer = this.isUserUnit(unit);
            const skillName = unit.skills?.find(s => s.id === finalAction.skillId)?.name || '普通攻击';
            // 不接受调用者预塞的留手指令绕过本次询问。
            delete finalAction.mercyTargetIds;
            delete finalAction.interceptTargetIds;
            for (const target of threats) {
                let choice = 'cancel';
                try {
                    choice = await this.askMercy({ actorName: unit.name, targetName: target.name, skillName, isPlayer, signal });
                } catch (error) {
                    this.log(`⚠ 留手询问失败，已暂停：${describeError(error)}`);
                }
                if (!['mercy', 'continue'].includes(choice) || signal?.aborted || this.battle !== battle || battle.currentUnit !== unit ||
                    this.ctx.chatMetadata !== metadataBefore || battle.round !== roundBefore || !sameGenerationChat(identity, currentGenerationContext(this.ctx))) {
                    this._autoDriveStop = true;
                    battle.awaitingPlayerAction = true;
                    this.notify();
                    return { ok: false, cancelled: true, error: '致命行动已暂停，未掷骰或消耗资源' };
                }
                if (choice === 'mercy') {
                    const field = isPlayer ? 'mercyTargetIds' : 'interceptTargetIds';
                    (finalAction[field] ??= []).push(target.id);
                }
            }
        }
        const result = battle.act(finalAction);

        // 无论成败都要让骰子停下 —— 否则它会一直转下去
        const roll = pickMainRoll(battle.log, logIndexBefore);

        if (useAi) {
            // 保证动画至少转够设定时长（太快看不见，就没有仪式感了）
            const minMs = Number(settings.battle.diceMinDuration) || 900;
            const elapsed = this._rollStartedAt ? Date.now() - this._rollStartedAt : minMs;
            if (elapsed < minMs) await sleep(minMs - elapsed);

            if (roll && settings.battle.showDice !== false) {
                this.diceRoller?.settle(roll.nat, roll.dieFaces);
            } else {
                this.diceRoller?.hide();
            }
            // 让「停下」这一帧先渲染出来，用户才看得到结果落在哪个数上
            await sleep(220);
        }

        this.displayRoll = roll
            ? { ...roll, rolling: false, value: roll.nat, actorName: roll.actorName || unit.name, flavor: decision?.flavor ?? '' }
            : { rolling: false, value: 0, outcome: '', actorName: unit.name,
                skillName: unit.skills?.find(s => s.id === finalAction.skillId)?.name || '', flavor: decision?.flavor ?? '' };

        if (!result.ok) {
            toast(result.error ?? '行动失败', 'warning');
            this.notify();
            return result;
        }
        for (const line of result.lines) this.log(`  ${line}`);

        // 把 AI 的动作描述写进战斗日志 —— 这样结算面板里也能看到
        if (decision?.flavor) {
            battle.pushLog('flavor', `「${decision.flavor}」`);
        }

        await this._persistBattle(before);
        this.notify();

        // ---- 自动衔接：AI 单位行动完接着下一个，一路跑到轮到你 ----
        //
        // 用户要的是「AI 输出完直接跳到我」。手动点的时候如果下一手还是 AI，
        // 就自动接着打 —— 否则每打一手都要点一下，很烦。
        this._maybeContinueAutoDrive();

        return { ...result, roll, flavor: decision?.flavor };
    }

    /**
     * 看看要不要自动接着推进。
     *
     * 条件：设置开着 + 没在自动推进中 + 战斗还在 + 当前不是你的单位。
     * 用 `setTimeout(0)` 而不是直接 await —— 让本次行动的界面先渲染出来，
     * 否则连续推进时会「跳帧」，看不到中间过程。
     */
    _maybeContinueAutoDrive() {
        // ⚠️ 每一处「不继续」都要能说清原因。
        // 用户报「敌方还要我来点击」时，只靠猜是查不出来的 ——
        // 到底是因为设置关了、还是没识别出玩家、还是已经在你回合，必须能从日志看出来。
        const why = (/** @type {string} */ reason) => {
            diagLog('info', `自动推进未启动：${reason}`);
        };

        if (this.battle?.awaitingPlayerAction) return;
        if (this.busy || (this.battle && this._autoDriveScheduled === this.battle)) return;
        if (this._playerTurnRunning) return why('玩家回合事务正在推进');
        if (this._autoDriving) return why('已在推进循环中');
        if (this._autoDriveStop) return why('被用户停止过（_autoDriveStop）');
        if (!this.battle) return why('没有战斗');
        if (this.battle.phase === 'finished') return why('战斗已结束');
        // 玩家选择后必须处理完 AI 回合；旧的 autoDrive 设置不再阻断衔接。

        const unit = this.battle.currentUnit;
        if (!unit) return why('没有当前行动单位');
        // 轮到你 → 停，把控制权交给你
        if (this.isUserUnit(unit)) return why(`轮到你操控的「${unit.name}」`);
        if (this.battle.units.filter((u) => this.isUserUnit(u)).length !== 1) return why('玩家身份未唯一确定，请指定「你操控」的角色');
        if (unit.side === 'ally' && this.settings.battle.aiControlsAllies === false) return why('队友由玩家手动指挥');

        diagLog('info', `自动推进启动：${unit.name}（${unit.side}）由 AI 接管`);

        // ---- 步数上限：防止「没识别出玩家角色」时无限打下去 ----
        //
        // 一轮正常情况下最多 = 场上单位数 + 一点余量。
        // 超过就说明没有人会被识别为玩家（例如没指定、persona 也对不上），
        // 这时必须停下来问用户，而不是永远打下去。
        const aliveCount = (this.battle.units ?? []).filter((/** @type {any} */ u) => u.alive).length;
        const budget = Math.max(12, aliveCount * 2 + 4);
        this._autoDriveBudget = (this._autoDriveBudget ?? 0) + 1;
        if (this._autoDriveBudget > budget) {
            this._autoDriveBudget = 0;
            this.log(
                `⚠ 连续自动推进超过 ${budget} 步仍未轮到玩家 —— 可能没识别出「哪个角色是你」。已暂停。`,
            );
            this.log('  到战斗页顶部的「🎮 你操控」点一下你的角色即可。');
            toast('没识别出你的角色，自动推进已暂停 —— 请指定哪个是你', 'warning');
            this.notify();
            return;
        }

        const scheduledBattle = this.battle;
        this._autoDriveScheduled = scheduledBattle;
        setTimeout(() => {
            if (this._autoDriveScheduled === scheduledBattle) this._autoDriveScheduled = false;
            // 再检查一次：这期间可能被用户中止、换人或切换聊天。
            if (this.battle !== scheduledBattle || scheduledBattle.awaitingPlayerAction || this.busy || this._playerTurnRunning || this._autoDriving || this._autoDriveStop) return;
            if (!this.battle || this.battle.phase === 'finished') return;
            const u = this.battle.currentUnit;
            if (!u || this.isUserUnit(u)) return;
            // 用 void + catch：这个 Promise 在 setTimeout 里没人接，
            // 一旦 reject 就是 unhandled rejection（会污染控制台甚至中断流程）
            void this.autoAdvance({ maxSteps: 60 }).catch((e) => {
                console.error(`${TAG} 自动推进出错`, e);
                this.log(`✖ 自动推进出错：${describeError(e)}`);
            });
        }, 0);
    }

    /**
     * 启动自动推进（UI 的「继续」按钮用）。
     * @returns {Promise<{ok: boolean, steps: number, stoppedAt?: string}>}
     */
    async continueAutoDrive() {
        this._autoDriveStop = false;
        return this.autoAdvance({ maxSteps: 60 });
    }

    /** 请求停止自动推进。 */
    stopAutoDrive() {
        this._autoDriveStop = true;
        this.log('· 已请求停止自动推进');
        this.notify();
    }

    /**
     * 从玩家点的目标里取出名字（给决策模型做参考）。
     * @param {any} action
     * @param {any} battle
     * @returns {string}
     */
    _targetNameFor(action, battle) {
        const id = action?.targetIds?.[0] ?? action?.targetId;
        if (!id) return '';
        const target = (battle?.units ?? []).find((/** @type {any} */ u) => u.id === id);
        return target?.name ?? '';
    }

    /**
     * 让当前单位自动行动一步（用本地启发式规则选行动，不调 AI 决策）。
     * @returns {Promise<{ok: boolean, error?: string}>}
     */
    async autoAct() {
        if (!this.battle) return { ok: false, error: '没有进行中的战斗' };
        const owners = this.battle.units.filter((u) => this.isUserUnit(u));
        if (owners.length !== 1) return { ok: false, error: '玩家身份未唯一确定，请在「你操控」中指定角色' };
        if (this.isUserUnit(this.battle.currentUnit)) return { ok: false, error: '玩家回合必须由你选择技能' };
        if (this.battle.currentUnit?.side === 'ally' && this.settings.battle.aiControlsAllies === false) {
            return { ok: false, error: '队友自动操作已关闭' };
        }
        return this.act({});
    }

    /**
    /**
     * 连续自动推进，**直到轮到你自己的角色**（或战斗结束）。
     *
     * ⚠️ 停止条件必须是「轮到玩家操控的单位」，**不能**是「轮到我方单位」。
     * 队友也是我方 —— 按阵营停的话，每个队友回合都会停下来让你点一下，
     * 而那一手本来应该由 AI 打（用户报的「轮到敌方操作时还需要我多点一下很奇怪」）。
     *
     * @param {{maxSteps?: number, stopOnAlly?: boolean, stopOnUser?: boolean}} [opts]
     * @returns {Promise<{ok: boolean, steps: number, stoppedAt?: string}>}
     */
    async autoAdvance(opts = {}) {
        if (this._autoDriving) return { ok: false, steps: 0, error: '自动推进已在运行' };
        if (!this.battle) return { ok: false, steps: 0 };
        const maxSteps = opts.maxSteps ?? 60;
        // stopOnAlly 保留兼容：只有显式传 true 时才按「我方」停（旧行为）
        const stopOnAlly = opts.stopOnAlly === true;
        const stopOnUser = opts.stopOnUser !== false;
        let steps = 0;
        /** @type {string} */
        let stoppedAt = '';

        this._autoDriving = true;
        this.setBusy(true, '自动推进中…');
        /** @type {string} */
        let exitReason = '';
        try {
            while (this.battle && this.battle.phase !== 'finished' && steps < maxSteps) {
                // 用户点了「停」→ 立刻退出
                if (this._autoDriveStop) {
                    exitReason = '用户点了停止';
                    break;
                }
                const unit = this.battle.currentUnit;
                if (!unit) {
                    exitReason = '没有当前行动单位';
                    break;
                }

                // 轮到你自己的角色 → 停，交给你操作
                if (stopOnUser && this.isUserUnit(unit)) {
                    stoppedAt = unit.name;
                    exitReason = `轮到你操控的「${unit.name}」`;
                    break;
                }
                // 旧行为（只有显式要求时才按阵营停）
                if (stopOnAlly && unit.side === 'ally') {
                    stoppedAt = unit.name;
                    exitReason = `按阵营停在「${unit.name}」`;
                    break;
                }

                const result = await this.autoAct();
                steps++;
                if (!result.ok) {
                    exitReason = `行动失败：${result.error ?? '未知'}`;
                    break;
                }
                // 让出主线程，避免长循环卡住页面
                await new Promise((resolve) => setTimeout(resolve, 120));
            }
        } finally {
            this._autoDriving = false;
            this.setBusy(false);
        }
        if (!exitReason) {
            exitReason =
                this.battle?.phase === 'finished'
                    ? '战斗结束'
                    : steps >= maxSteps
                      ? `达到步数上限 ${maxSteps}`
                      : '未知';
        }
        diagLog('info', `自动推进结束：走了 ${steps} 步｜原因：${exitReason}`);
        if (stoppedAt) {
            // 正常停在玩家身上 → 预算清零，下一轮重新计
            this._autoDriveBudget = 0;
            this.log(`· 自动推进 ${steps} 步，停在「${stoppedAt}」（该你操作了）`);
        }
        this.notify();
        return { ok: true, steps, stoppedAt };
    }

    /** 结束当前战斗（不结算，直接丢弃）。 */
    async abandonBattle() {
        if (!this.battle) return { ok: false };
        this.battle = null;
        await setBattle(this.ctx, null);
        this.log('· 已放弃当前战斗');
        this.notify();
        return { ok: true };
    }

    /**
     * 结束战斗并持久化结算，等待用户发送给正文续写。
     * @returns {Promise<{ok: boolean, error?: string, applied?: string[]}>}
     */
    async finishBattle(editedCombatText) {
        if (!this.battle) return { ok: false, error: '没有战斗' };
        const data = this.data;
        this.stopAutoDrive();
        this._captureBattleResult({ data, combatText: editedCombatText ?? data.battleResult?.combatText });
        const battleName = this.battle.name;
        pushAudit(data, { type: 'battle-end', source: 'engine', summary: battleName + '：已整理战斗结果' });
        this.battle = null;
        data.battle = null;
        await saveChatData(this.ctx, data);
        this.log('🏁 「' + battleName + '」结束，伤势、消耗与状态变化已整理到结算');
        toast('战斗结果已整理，可发送给正文模型续写', 'success');
        this.notify();
        return { ok: true };
    }

    /** 保存战斗状态到聊天。 */
    async _persistBattle(previousPhase) {
        const battle = this.battle;
        const metadata = this.ctx.chatMetadata;
        if (!battle) return;
        await setBattle(this.ctx, battle.toState());
        if (this.battle !== battle || this.ctx.chatMetadata !== metadata) return;

        // 战斗刚结束 → 保存结算快照
        if (this.battle.phase === 'finished' && previousPhase !== 'finished') {
            this.log('🏁 战斗判定结束');
            // 战斗对象清空前保存两部分，结束后仍可决定是否附带口嗨。
            const data = this.data;
            this._captureBattleResult({ data, combatText: data.battleResult?.combatText });
            pushAudit(data, {
                type: 'battle-finish',
                source: 'engine',
                summary: `${this.battle.name}：${this.battle.winner ?? '未知'}`,
            });
            await saveChatData(this.ctx, data, { silent: true });
        }
        // 战斗结束 → 停掉骰子动画，避免它一直转
        if (this.battle?.phase === 'finished') {
            this.diceRoller?.hide();
        }

        this.notify();
    }

    /**
     * 从聊天数据恢复战斗（刷新页面后继续打）。
     * @returns {boolean} 是否恢复成功
     */
    restoreBattle() {
        this.displayRoll = null;
        this.diceRoller?.hide();
        this.battleResultSnapshot = this.data.battleResult?.text ?? null;
        this.battleSent = this.data.battleResult?.sent === true;
        const state = getBattle(this.ctx);
        if (!state) return false;
        try {
            this.battle = Battle.fromState(state);
            // 老存档可能没有 combatMode 字段，
            // 默认按切磋处理 —— 把切磋当生死会写出「阵亡」，那更糟。
            if (this.battle.combatMode !== 'spar' && this.battle.combatMode !== 'deadly') {
                this.battle.combatMode = 'spar';
            }
            // 从存盘恢复时 `isUser` 标记可能已经丢了（或者当时压根没标）——
            // 不补这一步，恢复战斗后批量决策就会连你自己一起替你做决定。
            const who = this.markUserUnit({ combatants: this.battle.units });
            this.log(
                `· 已恢复战斗：${this.battle.name}（第 ${this.battle.round} 回合）` +
                    (who ? `　你操控：${who.name}` : '　⚠ 未指定你操控哪个角色'),
            );
            // 换人/行动后等待手动提交的状态必须跨刷新保留。
            this._autoDriveStop = this.battle.awaitingPlayerAction === true;
            this._maybeContinueAutoDrive();
            return true;
        } catch (e) {
            console.error(`${TAG} 恢复战斗失败`, e);
            this.battle = null;
            return false;
        }
    }

    // -----------------------------------------------------------------------
    // 导出文本
    // -----------------------------------------------------------------------

    /**
     * 把当前战力表导出成 Combat_block 文本（用于注入正文或手动复制）。
     * @param {{maxChars?: number}} [opts]
     * @returns {string}
     */
    toCombatBlockText(opts = {}) {
        const system = this.powerSystem;
        if (!system) return '';
        let text = toCombatBlock(system);
        const maxChars = opts.maxChars ?? this.settings.injection.maxChars ?? 4000;
        if (maxChars > 0 && text.length > maxChars) {
            // 超长就只保留存活单位与前若干个，避免刷屏
            const alive = {
                ...system,
                combatants: system.combatants.filter((/** @type {any} */ u) => u.alive),
            };
            text = toCombatBlock(alive, { maxUnits: 12 });
            if (text.length > maxChars) text = `${text.slice(0, maxChars)}\n…（已截断）`;
        }
        return text;
    }

    /** 当前回合的简要战况文本（注入用）。 */
    battleSummaryText() {
        const battle = this.battle;
        if (!battle) return '';
        const lines = [`【战斗掷骰 · ${battle.name}】第 ${battle.round} 回合`];
        for (const unit of battle.units) {
            const hp = unit.attributes?.HP;
            const mp = unit.attributes?.MP;
            const power =
                unit.powerRating && (unit.powerRating.rating > 0 || unit.powerRating.grade)
                    ? `战力${unit.powerRating.rating || '?'}${unit.powerRating.grade ? `(${unit.powerRating.grade})` : ''}｜`
                    : '';
            lines.push(
                `${unit.side === 'ally' ? '我方' : unit.side === 'enemy' ? '敌方' : '中立'} ${unit.name}：` +
                    `${power}` +
                    `HP ${hp?.current ?? 0}/${hp?.max ?? 0}` +
                    (mp ? `，MP ${mp.current}/${mp.max}` : '') +
                    (unit.alive ? '' : '（阵亡）') +
                    (unit.statuses?.length
                        ? `｜状态：${unit.statuses.map((/** @type {any} */ s) => `${s.name}${s.duration ? `(${s.duration})` : ''}`).join('、')}`
                        : ''),
            );
        }
        const recent = battle.log.slice(-8).map((/** @type {any} */ l) => l.text);
        if (recent.length) {
            lines.push('最近结算：');
            for (const t of recent) lines.push(`· ${t}`);
        }
        lines.push('');
        lines.push('（以上为掷骰引擎的机械结算结果，请据此继续叙事，不要推翻已结算的伤害与状态。）');
        return lines.join('\n');
    }

    /** 给 UI 的引擎自检信息。 */
    diagnostics() {
        const probeHelper = getTavernHelper();
        return {
            extName: EXT_NAME,
            tavernHelper: Boolean(probeHelper && typeof probeHelper.generateRaw === 'function'),
            profiles: (this.ctx?.extensionSettings?.connectionManager?.profiles ?? []).length,
            worldInfoAvailable: typeof this.ctx?.loadWorldInfo === 'function',
            chatId: this.ctx?.chatId ?? '',
            characterName: this.ctx?.name2 ?? '',
            userName: this.ctx?.name1 ?? '',
        };
    }

    /**
     * 读取最近一条 AI 消息（供 P2 手动检测用）。
     * @returns {{text: string, index: number}|null}
     */
    lastAssistantMessage() {
        return getLastAssistantMessage(this.ctx);
    }
}
