/**
 * tavern-dice / src/ui/diag.js
 * ---------------------------------------------------------------------------
 * 内置诊断面板 —— **不依赖开发者工具**。
 *
 * ## 为什么要做这个
 *
 * 排查「点悬浮球打不开」时我一直在说「打开 F12 看控制台」，
 * 但用户用的是 **TauriTavern 桌面版**，那是本地程序、**根本没有 F12**。
 * 我让他们做一件做不到的事，白绕了好几轮。
 *
 * 所以这里把诊断信息**做进界面**：
 *  1. 拦住 console.warn/error 与未捕获异常，存进环形缓冲；
 *  2. 记录面板每次开合的「操作前 / 操作后」状态；
 *  3. 用一个**独立的悬浮角标**随时打开，不依赖主面板能不能开；
 *  4. 内容可以一键复制（桌面版没有控制台，复制粘贴是最实际的反馈方式）。
 *
 * 这个模块刻意不引用任何其它模块（除了 dom），避免它自己在排查问题时坏掉。
 */

import { el, on } from './dom.js';

/** @type {Array<{t: string, level: string, text: string}>} */
const entries = [];
const MAX_ENTRIES = 200;

/** 是否有面板正在显示（避免同时开两个）。 */
let openOverlay = null;

/**
 * 记一条诊断信息。
 * @param {string} level info / warn / error
 * @param {string} text
 */
export function diagLog(level, text) {
    const now = new Date();
    const t = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(
        now.getSeconds(),
    ).padStart(2, '0')}`;
    entries.push({ t, level, text: String(text).slice(0, 800) });
    if (entries.length > MAX_ENTRIES) entries.splice(0, entries.length - MAX_ENTRIES);
    // 角标上显示错误数量
    try {
        refreshBadgeCount();
    } catch {
        /* 角标不在就算了 */
    }
}

/** 取全部诊断记录（纯文本，方便复制）。 */
export function diagText() {
    return entries.map((e) => `[${e.t}] ${e.level.toUpperCase()} ${e.text}`).join('\n');
}

/** 清空。 */
export function diagClear() {
    entries.length = 0;
    refreshBadgeCount();
}

/**
 * 装全局拦截：console 与未捕获异常。
 *
 * 这是「没有控制台」场景下最重要的一步 ——
 * 插件内部所有 `console.warn/error` 都会进到诊断面板里，
 * 包括那些我为了排查而打的痕迹。
 */
export function installDiagCapture() {
    const g = /** @type {any} */ (globalThis);
    if (g.__tdDiagInstalled) return;
    g.__tdDiagInstalled = true;

    for (const level of ['warn', 'error']) {
        const original = console[level]?.bind(console);
        console[level] = (/** @type {any[]} */ ...args) => {
            try {
                diagLog(
                    level,
                    args
                        .map((a) => (a instanceof Error ? `${a.message}\n${a.stack ?? ''}` : String(a)))
                        .join(' '),
                );
            } catch {
                /* 记录失败不能影响原流程 */
            }
            original?.(...args);
        };
    }

    globalThis.addEventListener?.('error', (e) => {
        const err = /** @type {any} */ (e);
        diagLog('error', `未捕获异常：${err?.error?.message ?? err?.message ?? ''}\n${err?.error?.stack ?? ''}`);
    });
    globalThis.addEventListener?.('unhandledrejection', (e) => {
        const err = /** @type {any} */ (e);
        const r = err?.reason;
        diagLog('error', `未处理的 Promise：${r?.message ?? String(r)}\n${r?.stack ?? ''}`);
    });

    diagLog('info', `诊断已启动（构建 ${g.__TD_BUILD__ ?? '未知'}）`);
}

/** 角标上的错误计数。 */
function refreshBadgeCount() {
    const node = globalThis.document?.getElementById?.('tavern-dice-diag-badge');
    if (!node) return;
    const errs = entries.filter((e) => e.level === 'error').length;
    const warns = entries.filter((e) => e.level === 'warn').length;
    const count = globalThis.document?.getElementById?.('tavern-dice-diag-count');
    if (count) count.textContent = errs ? `⚠${errs}` : warns ? `·${warns}` : '·';
    node.title = `战斗掷骰诊断（错误 ${errs}／警告 ${warns}）—— 点击查看`;
}

/**
 * 创建一个**独立于主面板**的诊断角标。
 *
 * 为什么独立：主面板打不开时，用户就完全没法把信息给我。
 * 这个角标自带内联样式，即使 style.css 整个没加载也照样能显示。
 *
 * @param {{onOpen?: () => void}} [opts]
 * @returns {HTMLElement}
 */
export function createDiagBadge(opts = {}) {
    const node = el('div', {
        id: 'tavern-dice-diag-badge',
        title: '战斗掷骰诊断 —— 点击查看（面板打不开时用这个）',
        role: 'button',
        tabindex: '0',
    });
    // 内联样式：不依赖外部 CSS，保证「最坏情况下也能看到」
    // 做得**明显一点**：键盘快捷键在有些环境里收不到（用户实测 Alt+Shift+D 无效），
    // 所以鼠标必须有一条稳妥的路。原来那个 26×20 的小点太小了，容易看不见。
    Object.assign(node.style, {
        position: 'fixed',
        left: '8px',
        bottom: '8px',
        zIndex: '2147483600',
        height: '24px',
        padding: '0 10px',
        display: 'none',
        alignItems: 'center',
        justifyContent: 'center',
        gap: '4px',
        font: '12px/1 "Segoe UI", system-ui, sans-serif',
        color: '#ffd479',
        background: 'rgba(28,22,38,0.94)',
        border: '1px solid rgba(200,166,96,0.8)',
        borderRadius: '5px',
        cursor: 'pointer',
        userSelect: 'none',
        opacity: '0.85',
        boxShadow: '0 2px 8px rgba(0,0,0,0.5)',
    });
    const label = el('span', {}, '🐞 诊断');
    Object.assign(label.style, { pointerEvents: 'none' });
    const count = el('span', { id: 'tavern-dice-diag-count' }, '·');
    Object.assign(count.style, { pointerEvents: 'none', opacity: '0.8' });
    node.append(label, count);

    const open = () => {
        opts.onOpen?.();
        showDiagPanel();
    };
    on(node, 'click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        open();
    });
    on(node, 'keydown', (e) => {
        const key = /** @type {KeyboardEvent} */ (e).key;
        if (key === 'Enter' || key === ' ') {
            e.preventDefault();
            open();
        }
    });

    return node;
}

/** 显示诊断面板（自建 overlay，不依赖 main 面板）。 */
export function showDiagPanel() {
    if (openOverlay) {
        openOverlay.remove();
        openOverlay = null;
        return;
    }
    if (typeof document === 'undefined') return;

    const text = diagText() || '（还没有记录）';

    const overlay = el('div', { id: 'tavern-dice-diag-overlay' });
    Object.assign(overlay.style, {
        position: 'fixed',
        inset: '0',
        zIndex: '2147483601',
        background: 'rgba(0,0,0,0.6)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '16px',
    });

    const box = el('div');
    Object.assign(box.style, {
        width: 'min(760px, 94vw)',
        maxHeight: '82vh',
        display: 'flex',
        flexDirection: 'column',
        gap: '8px',
        padding: '12px',
        background: '#1a1622',
        color: '#e8e8ee',
        border: '1px solid rgba(200,166,96,0.6)',
        borderRadius: '8px',
        font: '12px/1.5 "Segoe UI", system-ui, sans-serif',
    });

    const head = el('div');
    Object.assign(head.style, { display: 'flex', alignItems: 'center', gap: '8px' });
    const title = el('b', {}, '战斗掷骰 · 诊断信息');
    title.style.flex = '1';
    head.appendChild(title);

    const copyButton = el('div', {}, '复制全部');
    const closeButton = el('div', {}, '关闭');
    const clearButton = el('div', {}, '清空');
    for (const [btn, label] of [
        [copyButton, '复制全部'],
        [clearButton, '清空'],
        [closeButton, '关闭'],
    ]) {
        btn.textContent = label;
        Object.assign(btn.style, {
            padding: '3px 10px',
            border: '1px solid rgba(200,166,96,0.6)',
            borderRadius: '4px',
            cursor: 'pointer',
            background: 'rgba(40,30,60,0.9)',
        });
        head.appendChild(btn);
    }

    on(copyButton, 'click', async () => {
        const payload = `构建: ${/** @type {any} */ (globalThis).__TD_BUILD__ ?? '未知'}\n${text}`;
        let ok = false;
        try {
            await navigator.clipboard.writeText(payload);
            ok = true;
        } catch {
            // 剪贴板 API 在桌面壳里可能不可用 → 退回选中文本让用户手动复制
            try {
                const range = document.createRange();
                range.selectNodeContents(pre);
                const sel = globalThis.getSelection?.();
                sel?.removeAllRanges();
                sel?.addRange(range);
            } catch {
                /* 忽略 */
            }
        }
        copyButton.textContent = ok ? '已复制 ✓' : '请手动 Ctrl+C';
        setTimeout(() => {
            copyButton.textContent = '复制全部';
        }, 1500);
    });
    on(clearButton, 'click', () => {
        diagClear();
        pre.textContent = '（已清空）';
    });
    on(closeButton, 'click', () => {
        overlay.remove();
        openOverlay = null;
    });
    on(overlay, 'click', (e) => {
        if (e.target === overlay) {
            overlay.remove();
            openOverlay = null;
        }
    });

    const pre = el('pre', {}, text);
    Object.assign(pre.style, {
        flex: '1',
        overflow: 'auto',
        margin: '0',
        padding: '10px',
        background: 'rgba(0,0,0,0.45)',
        border: '1px solid rgba(255,255,255,0.12)',
        borderRadius: '6px',
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
        userSelect: 'text',
        maxHeight: '60vh',
        font: '11px/1.5 Consolas, monospace',
    });

    const hint = el(
        'div',
        {},
        '这是给开发者看的诊断信息。面板打不开时，点「复制全部」把内容发过去即可（不必打开控制台）。',
    );
    hint.style.opacity = '0.7';
    hint.style.fontSize = '11px';

    box.append(head, pre, hint);
    overlay.appendChild(box);
    document.body.appendChild(overlay);
    openOverlay = overlay;
}
