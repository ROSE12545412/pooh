/**
 * tavern-dice —— 战斗掷骰
 * ---------------------------------------------------------------------------
 * SillyTavern / TauriTavern 扩展入口。
 * 当前场景 → 结构化参战数据 → 模型决策与本地掷骰 → 用户发送结果。
 */

import { EXT_ID, EXT_NAME, TAG, deriveExtensionFolder } from './src/config.js';
import { BUILD_STAMP } from './src/build.js';
import { diagLog, installDiagCapture, showDiagPanel } from './src/ui/diag.js';
import { AppController } from './src/app.js?v=1.0.6';
import { getSettings, saveSettings } from './src/core/store.js';
import { createFloatBall } from './src/ui/ball.js';
import { toast } from './src/ui/dom.js';
import { describeError } from './src/llm/client.js';
import { MainPanel, mountExtensionSettings } from './src/ui/panel.js';

/** 扩展目录名（从自身 URL 推导，用户改了文件夹名也不会错）。 */
const EXT_FOLDER = deriveExtensionFolder(import.meta.url);

// 更新脚本时清除上一个版本已挂到页面上的常驻诊断角标。
globalThis.document?.getElementById('tavern-dice-diag-badge')?.remove();

/** 运行期单例。 */
const runtime = {
    /** @type {AppController|null} */
    app: null,
    /** @type {MainPanel|null} */
    panel: null,
    /** @type {MainPanel|null} */
    embeddedPanel: null,
    /** @type {ReturnType<typeof createFloatBall>|null} */
    ball: null,
    booted: false,
    /** 是否已经装过「把错误显示到界面上」的处理器（避免重复挂）。 */
    errorReportingInstalled: false,
    /** 挂载时拿到的设置对象（供球与面板的联动使用）。 */
    settings: null,
};

/**
 * 取得酒馆上下文。
 * 扩展脚本可能在 `SillyTavern` 全局就绪之前就被加载，所以要轮询等待。
 * @param {number} [timeoutMs]
 * @returns {Promise<any>}
 */
async function waitForContext(timeoutMs = 30000) {
    const started = Date.now();
    // 已有就直接返回
    const immediate = tryGetContext();
    if (immediate) return immediate;

    return new Promise((resolve, reject) => {
        const timer = setInterval(() => {
            const ctx = tryGetContext();
            if (ctx) {
                clearInterval(timer);
                resolve(ctx);
                return;
            }
            if (Date.now() - started > timeoutMs) {
                clearInterval(timer);
                reject(new Error('等待 SillyTavern 就绪超时'));
            }
        }, 150);
    });
}

/** 安全地取上下文。 */
function tryGetContext() {
    try {
        const st = /** @type {any} */ (globalThis).SillyTavern;
        if (st && typeof st.getContext === 'function') {
            const ctx = st.getContext();
            // 确认关键字段已就绪，避免拿到半成品
            if (ctx && ctx.eventSource && ctx.chatMetadata !== undefined) return ctx;
        }
    } catch {
        /* 还没就绪 */
    }
    return null;
}

// ---------------------------------------------------------------------------
// 启动
// ---------------------------------------------------------------------------

/**
 * 启动扩展。
 */
/**
 * 把未捕获的错误**显示到界面上**。
 *
 * 用户反馈过一次「点悬浮球没反应」，但他不知道怎么打开控制台 ——
 * 于是我们只能靠猜。加上这个之后，任何未捕获异常都会直接弹到眼前，
 * 用户截图发过来就能定位。
 *
 * 顺便解决另一类问题：酒馆里扩展的报错常常被别的日志淹没，
 * 界面上完全看不出「有东西坏了」。
 */
function installVisibleErrorReporting() {
    if (runtime.errorReportingInstalled) return;
    runtime.errorReportingInstalled = true;

    const report = (/** @type {string} */ kind, /** @type {any} */ detail) => {
        const message = String(detail?.message ?? detail ?? '');
        // 只播报与本体相关的错误，避免把酒馆其它扩展的报错也算进来
        if (!/战斗掷骰|tavern-dice|td-/.test(message) && kind !== 'unhandledrejection') return;
        try {
            toast(`插件出错（${kind}）：${message.slice(0, 160)}`, 'error');
        } catch {
            /* toast 本身都坏了就算了 */
        }
    };

    globalThis.addEventListener?.('error', (e) => {
        const err = /** @type {any} */ (e);
        report('error', err?.error ?? err?.message);
    });
    globalThis.addEventListener?.('unhandledrejection', (e) => {
        const err = /** @type {any} */ (e);
        report('未处理的 Promise', err?.reason);
    });
}

async function boot() {
    if (runtime.booted) return;
    installVisibleErrorReporting();
    /** @type {any} */ (globalThis).__TD_BUILD__ = BUILD_STAMP;
    installDiagCapture();
    const ctx = await waitForContext();
    runtime.booted = true;

    const settings = getSettings(ctx);
    // 打出版本号：排查问题时第一件事就是确认「跑的是哪一版」
    console.log(`${TAG} 加载中…（扩展目录 ${EXT_FOLDER}｜构建 ${BUILD_STAMP}）`);

    const app = new AppController(ctx);
    runtime.app = app;

    // 恢复了战斗就接着打
    if (app.restoreBattle()) {
        console.log(`${TAG} 已恢复上次未打完的战斗`);
    }

    // 1) 酒馆扩展设置区的入口
    try {
        runtime.embeddedPanel = mountExtensionSettings(app);
    } catch (e) {
        console.error(`${TAG} 挂载设置面板失败`, e);
        try {
            toast(`设置面板挂载失败：${describeError(e)}`, 'error');
        } catch {
            /* 忽略 */
        }
    }

    // 2) 悬浮球 + 悬浮主面板
    try {
        mountFloatingUi(app, settings);
    } catch (e) {
        console.error(`${TAG} 挂载悬浮界面失败`, e);
        // ⚠️ 必须**可见** —— 挂载失败的表现就是「悬浮球点不开」，
        // 只打 console 的话用户完全不知道为什么。
        try {
            toast(`面板挂载失败：${describeError(e)}`, 'error');
        } catch {
            /* 忽略 */
        }
    }

    // 3) 事件挂接
    hookEvents(app, ctx);

    // 4) 斜杠命令
    registerSlashCommands(app);

    // 5) 键盘快捷键 —— 一个**完全不依赖鼠标**的入口。
    //
    // 排查「点悬浮球打不开」时很需要它：如果快捷键能打开而点击不行，
    // 问题就在点击链路上；反过来问题在渲染上。这比来回猜快得多。
    installPanelHotkey();


    console.log(`${TAG} 已就绪。点右下角的 🎲 悬浮球打开面板。`);
    exposeDebugApi(app);
}

/**
 * 装一个开合面板的快捷键（默认 Alt+D）。
 *
 * 这是刻意的「第二条路」：鼠标链路出问题时，用户还有办法打开面板，
 * 同时也能帮我们把「点击坏了」和「渲染坏了」区分开。
 */
function installPanelHotkey() {
    if (globalThis.__tdPanelHotkey) return;
    globalThis.__tdPanelHotkey = true;

    /**
     * 判断一个按键事件是不是我们要的那个键。
     *
     * ⚠️ **必须同时看 \`e.code\` 与 \`e.key\`**。
     * 用户实测 \`Alt+Shift+D\` 收不到 —— 原因之一就是按住 Alt 时
     * 某些环境里 \`e.key\` 不是 \`'d'\`（可能是 \`'ð'\`、\`'D'\` 或空字符串），
     * 只比 \`e.key\` 会直接漏掉。\`e.code\` 是物理键位，不受修饰键与输入法影响。
     */
    const isD = (/** @type {KeyboardEvent} */ e) => {
        const code = String(e.code ?? '');
        const key = String(e.key ?? '').toLowerCase();
        return code === 'KeyD' || key === 'd';
    };

    const onKey = (/** @type {KeyboardEvent} */ e) => {
        if (!isD(e)) return;

        // Alt+Shift+D → 诊断
        if (e.altKey && e.shiftKey) {
            e.preventDefault();
            e.stopPropagation();
            showDiagPanel();
            return;
        }
        // Ctrl+Shift+D → 也开诊断（Alt 被宿主占用时的备用）
        if (e.ctrlKey && e.shiftKey && !e.altKey) {
            e.preventDefault();
            e.stopPropagation();
            showDiagPanel();
            return;
        }
        // Alt+D → 开合面板
        if (e.altKey && !e.shiftKey && !e.ctrlKey && !e.metaKey) {
            e.preventDefault();
            e.stopPropagation();
            runtime.panel?.toggle();
            diagLog('info', `快捷键 Alt+D → 面板现在${runtime.panel?.isOpen ? '展开' : '收起'}`);
        }
    };

    // 同时挂 window 与 document，并用 capture 抢先拿到事件 ——
    // 酒馆里别的脚本可能 stopPropagation，挂在冒泡阶段会收不到。
    for (const target of [globalThis.window, globalThis.document].filter(Boolean)) {
        target.addEventListener('keydown', onKey, true);
    }

    // 诊断快捷键独立于战斗面板。
    diagLog('info', '快捷键已装：Alt+D 开合面板｜Alt+Shift+D 或 Ctrl+Shift+D 看诊断');
    console.log(`${TAG} 快捷键：Alt+D 开合面板｜Alt+Shift+D / Ctrl+Shift+D 看诊断`);
}

/**
 * 同步悬浮球的可见性。
 *
 * ⚠️ **面板打开时必须把球藏起来** —— 这是一个真实踩坑：
 * 球的 z-index 比面板还高（否则关不掉面板），于是它永远压在面板上面。
 * 用户把球拖到面板中间时，球就挡住了面板内容，
 * 而且球是真实 DOM 元素、**可以被选中复制**（用户就是这么发现它的）。
 *
 * 藏起来之后：面板打开就专心看面板，点 ✕ 关闭后球自动回来，逻辑也更清爽。
 */
function syncBallVisibility(settings) {
    if (!runtime.ball) return;
    // settings 只在挂载时拿得到；那之后就靠 runtime 里存的这份
    if (settings) runtime.settings = settings;
    const userWantsBall = runtime.settings?.showBall !== false;
    const panelOpen = runtime.panel?.isOpen === true;
    runtime.ball.setVisible(userWantsBall && !panelOpen);
}

/** 挂载悬浮球与悬浮面板。 */
function mountFloatingUi(app, settings) {
    const panel = new MainPanel(app, {
        embedded: false,
        initialTab: 'table',
        onOpenChange: (open) => {
            runtime.ball?.setActive(open);
            syncBallVisibility(settings);
        },
    });
    runtime.panel = panel;
    panel.applyStoredGeometry();
    panel.render();
    panel.close(); // 初始收起
    document.body.appendChild(panel.node);

    let unsubscribeBallSize = () => {};
    const ball = createFloatBall({
        onDestroy: () => unsubscribeBallSize(),
        initialPosition: settings.ballPosition ?? { x: 24, y: 180 },
        initialSize: settings.ballSize,
        getBadge: () => (app.powerSystem ? '' : '!'),
        onClick: () => {
            panel.toggle();
        },
        // 传进去让悬浮球能自检「点了到底有没有打开」——
        // 打不开时它会把这个结论播报出来，用户不用开 DevTools 也能反馈。
        isOpen: () => panel.isOpen,
        describePanel: () => `构建${BUILD_STAMP}｜${panel.describeState()}`,
        onMove: (pos) => {
            settings.ballPosition = pos;
            app.persistSettings({ silent: true });
        },
    });
    runtime.ball = ball;
    let lastPanelSize = JSON.stringify([app.settings.panelRect, app.settings.panelMobileScale]);
    unsubscribeBallSize = app.on('state-changed', () => {
        ball.setSize(app.settings.ballSize);
        const nextPanelSize = JSON.stringify([app.settings.panelRect, app.settings.panelMobileScale]);
        if (nextPanelSize !== lastPanelSize) {
            lastPanelSize = nextPanelSize;
            panel.applyStoredGeometry();
        }
    });
    syncBallVisibility(settings);
    ball.setBadge(app.powerSystem ? '' : '!');
    document.body.appendChild(ball.node);

    // 不挂载左下角常驻诊断按钮；保留快捷键及诊断记录。
    diagLog('info', `界面已挂载（构建 ${BUILD_STAMP}）`);

    // MainPanel owns viewport listeners and removes them in destroy().
}

/**
 * 挂接酒馆事件。
 *
 * 事件名全部取自本地实测的 `tavern_events` 表，注意两个反直觉的值：
 *   CHAT_CHANGED 的字符串是 `chat_id_changed`
 *   CHARACTER_DELETED 的字符串是 `characterDeleted`
 *
 * @param {AppController} app
 * @param {any} ctx
 */
function hookEvents(app, ctx) {
    const source = ctx.eventSource;
    // 部分宿主只给出不完整常量表，逐键兜底，避免空表遮住助手提供的常量。
    const fallbackEvents = { GENERATION_ENDED: 'generation_ended', GENERATION_STOPPED: 'generation_stopped', CHAT_CHANGED: 'chat_id_changed' };
    const registered = new Set();

    if (!source?.on) {
        console.warn(`${TAG} 没有可用的 eventSource，开战将使用生成状态检查，聊天切换由等待器核对`);
        return;
    }

    /** 安全注册：可选事件缺失时跳过，同名事件只绑定一次。 */
    const listen = (/** @type {string} */ key, /** @type {any} */ handler) => {
        const eventName = ctx.eventTypes?.[key]
            ?? globalThis.TavernHelper?.tavern_events?.[key]
            ?? globalThis.event_types?.[key]
            ?? fallbackEvents[key];
        if (!eventName) {
            console.warn(`${TAG} 事件 ${key} 在当前酒馆里不存在，跳过监听`);
            return;
        }
        if (registered.has(eventName)) return;
        try {
            source.on(eventName, handler);
            registered.add(eventName);
        } catch (e) {
            console.error(`${TAG} 监听 ${key} 失败`, e);
        }
    };

    // 完成事件只提示重新核对；事件缺失时还有实时生成状态检查。
    listen('GENERATION_ENDED', () => app._notifyGenerationEnded());
    listen('GENERATION_STOPPED', (generationId) => app._notifyGenerationStopped(generationId));

    // 切换聊天 → 换了一套数据，重画界面并尝试恢复该聊天的战斗
    listen('CHAT_CHANGED', () => {
        app.cancelSceneGeneration();
        try { app.ctx = globalThis.SillyTavern?.getContext?.() ?? app.ctx; } catch { /* 保留现有上下文 */ }
        app.stopAutoDrive();
        app.battle = null;
        app.restoreBattle();
        runtime.panel?.render();
        runtime.embeddedPanel?.render();
        runtime.ball?.setBadge(app.powerSystem ? '' : '!');
        console.log(`${TAG} 已切换聊天，已恢复该聊天的战斗存档`);
    });

    // 设置保存 → 同步悬浮球的显示开关
    listen('SETTINGS_UPDATED', () => {
        const settings = getSettings(app.ctx);
        runtime.ball?.setSize(settings.ballSize);
        syncBallVisibility(settings);
        runtime.panel?.applyStoredGeometry();
    });

    // 应用就绪（有些酒馆加载顺序不同，这里补一次界面刷新）
    listen('APP_READY', () => {
        runtime.panel?.render();
        runtime.embeddedPanel?.render();
    });
}

/**
 * 注册斜杠命令。
 *
 * 只用 ST 官方那套 `SlashCommandParser.addCommandObject(SlashCommand.fromProps(...))`，
 * 拿不到就静默跳过（插件主体功能不依赖命令行）。
 *
 * @param {AppController} app
 */
function registerSlashCommands(app) {
    const ctx = app.ctx;
    const parser = /** @type {any} */ (globalThis).SlashCommandParser ?? ctx?.SlashCommandParser;
    const SlashCommand = /** @type {any} */ (globalThis).SlashCommand ?? ctx?.SlashCommand;

    if (!parser?.addCommandObject || !SlashCommand?.fromProps) {
        console.warn(`${TAG} 当前酒馆不支持斜杠命令注册，跳过（不影响主要功能）`);
        return;
    }

    /** 统一包一层：命令回调里出错不要炸掉酒馆。 */
    const safe = (/** @type {string} */ name, /** @type {Function} */ fn) => async (/** @type {any[]} */ ...args) => {
        try {
            return await fn(...args);
        } catch (e) {
            console.error(`${TAG} 命令 /${name} 执行出错`, e);
            return `${EXT_NAME}：执行出错 — ${describeError(e)}`;
        }
    };

    /** 注册一个命令。 */
    const add = (/** @type {any} */ props) => {
        try {
            parser.addCommandObject(
                SlashCommand.fromProps({
                    ...props,
                    callback: safe(props.name, props.callback),
                }),
            );
        } catch (e) {
            console.error(`${TAG} 注册命令 /${props.name} 失败`, e);
        }
    };

    add({
        name: 'dice-init',
        aliases: ['掷骰开战', '开始战斗'],
        helpString: '让正文模型生成当前战斗场景并开战。用法：/dice-init [战况补充]',
        callback: async (/** @type {any} */ _args, /** @type {string} */ value) => {
            toast('正在让正文模型生成战斗场景…', 'info');
            runtime.panel?.open();
            runtime.panel?.setTab('battle');
            const result = await app.startBattleByScene({
                situation: String(value ?? '').trim() || undefined,
            });
            return result.ok
                ? `${EXT_NAME}：战斗已开始（${result.count} 个单位）。`
                : `${EXT_NAME}：开战失败 — ${result.error}`;
        },
    });

    add({
        name: 'dice-status',
        aliases: ['掷骰状态', '战斗状态'],
        helpString: '查看当前战斗数据摘要。用法：/dice-status',
        callback: async () => {
            const system = app.powerSystem;
            const battle = app.battle;
            const combatants = battle?.units ?? system?.combatants ?? [];
            if (!combatants.length) return `${EXT_NAME}：还没有当前场景数据。用 /dice-init 生成场景并开战。`;
            const lines = [
                `【${battle?.name ?? system?.systemName ?? '当前场景'}】共 ${combatants.length} 个单位　规则集：${battle?.ruleset?.name ?? app.ruleset.name}`,
            ];
            for (const side of ['ally', 'enemy', 'neutral']) {
                const units = combatants.filter((/** @type {any} */ u) => u.side === side);
                if (!units.length) continue;
                const label = side === 'ally' ? '我方' : side === 'enemy' ? '敌方' : '中立';
                lines.push(`${label}：${units.map((/** @type {any} */ u) => `${u.name}(${u.attributes?.HP?.current ?? 0}/${u.attributes?.HP?.max ?? 0})${u.alive ? '' : '✝'}`).join('、')}`);
            }
            if (battle) lines.push(`${battle.phase === 'finished' ? '已结束' : '进行中'}：${battle.name}，第 ${battle.round} 回合。`);
            return lines.join('\n');
        },
    });

    add({
        name: 'dice-roll',
        aliases: ['掷骰', '骰子'],
        helpString: '让当前行动单位自动行动一次；也可以 /dice-roll start 开战。用法：/dice-roll [start]',
        callback: async (/** @type {any} */ _args, /** @type {string} */ value) => {
            const sub = String(value ?? '').trim().toLowerCase();
            if (sub === 'start' || sub === '开战') {
                if (app.battle && app.battle.phase !== 'finished') {
                    return `${EXT_NAME}：已经有一场战斗在进行中（第 ${app.battle.round} 回合）。`;
                }
                const result = await app.startBattleByScene({});
                if (!result.ok) return `${EXT_NAME}：无法开战 — ${result.error}`;
                runtime.panel?.open();
                runtime.panel?.setTab('battle');
                return `${EXT_NAME}：战斗开始，种子 ${app.battle?.seed}。`;
            }
            if (!app.battle) return `${EXT_NAME}：没有进行中的战斗。用 /dice-roll start 开战。`;
            const unit = app.battle.currentUnit;
            const result = await app.autoAct();
            if (!result.ok) return `${EXT_NAME}：行动失败 — ${result.error}`;
            const lines = app.battle.log.slice(-6).map((/** @type {any} */ l) => l.text);
            return [`${EXT_NAME}：${unit?.name ?? ''} 行动完毕。`, ...lines].join('\n');
        },
    });

    add({
        name: 'dice-panel',
        aliases: ['掷骰面板'],
        helpString: '打开/收起战斗掷骰面板。用法：/dice-panel',
        callback: async () => {
            runtime.panel?.toggle();
            return `${EXT_NAME}：面板已${runtime.panel?.isOpen ? '展开' : '收起'}。`;
        },
    });

    console.log(`${TAG} 已注册斜杠命令：/dice-init /dice-status /dice-roll /dice-panel`);
}

/** 暴露一个调试用的全局对象，方便在控制台里排查。 */
function exposeDebugApi(/** @type {AppController} */ app) {
    /** @type {any} */ (globalThis).TavernDice = {
        version: '0.1.0',
        app,
        get panel() {
            return runtime.panel;
        },
        get ball() {
            return runtime.ball;
        },
        settings: () => getSettings(app.ctx),
        saveSettings: () => saveSettings(app.ctx),
        open: () => runtime.panel?.open(),
        close: () => runtime.panel?.close(),
        /** 打印当前状态。 */
        state: () => app.state,
    };
    console.log(`${TAG} 调试入口：window.TavernDice`);
}

// ---------------------------------------------------------------------------
// 入口：等 DOM 就绪后启动
// ---------------------------------------------------------------------------

if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => {
            boot().catch(reportBootFailure);
        });
    } else {
        boot().catch(reportBootFailure);
    }
}

/** 启动失败时给出可操作的提示，而不是静默死掉。 */
function reportBootFailure(/** @type {any} */ error) {
    console.error(`${TAG} 启动失败`, error);
    try {
        toast(
            `${EXT_NAME} 启动失败：${String(error?.message ?? error)}。请打开控制台（F12）查看详情，或到 GitHub 提 Issue。`,
            'error',
        );
    } catch {
        /* 什么都做不了 */
    }
}

export { boot, runtime, EXT_FOLDER, EXT_ID };
