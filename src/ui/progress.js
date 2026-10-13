/**
 * tavern-dice / src/ui/progress.js
 * ---------------------------------------------------------------------------
 * 长任务进度窗口。
 *
 * 为什么单独做一个窗口，而不是只用面板顶部那根忙碌条：
 * 建表可能要跑一两分钟（读几十万字世界书 + 多次模型调用），
 * 用户需要看到**具体在做什么、到第几步了、还要多久**，
 * 并且要能**随时终止** —— 否则一旦点错或发现选错了书，只能干等。
 *
 * 这个窗口是**可拖动**的：它盖在聊天上面，用户往往想边看剧情边等，
 * 所以能拖到一边去。
 */

import { button, clear, el, makeDraggable, on } from './dom.js';

/** 单例窗口。 */
let overlay = /** @type {HTMLElement|null} */ (null);
/** 已运行秒数的刷新计时器。 */
let ticker = /** @type {any} */ (null);
/** 解绑拖拽。 */
let undrag = /** @type {(() => void)|null} */ (null);

/**
 * 打开（或更新）进度窗口。
 * @param {import('../app.js').AppController} app
 * @returns {HTMLElement}
 */
export function openProgress(app) {
    if (overlay) return overlay;

    const title = el('b', {}, '处理中');
    const closeButton = button('✕', () => dismissProgress(), {
        small: true,
        title: '收起进度窗口（任务仍在后台继续，可从日志页查看进度）',
    });

    const header = el('div', { class: 'td-progress-head' }, [
        el('span', { class: 'td-progress-icon' }, '⏳'),
        title,
        closeButton,
    ]);

    const stageText = el('div', { class: 'td-progress-stage' }, '准备中…');
    const bar = el('div', { class: 'td-progress-bar' });
    const percentText = el('span', { class: 'td-progress-percent' }, '0%');
    const batchText = el('span', { class: 'td-progress-batch' }, '');
    const elapsedText = el('span', { class: 'td-progress-elapsed' }, '');
    const hintText = el('div', { class: 'td-progress-hint' }, '');

    const body = el('div', { class: 'td-progress-body' }, [
        stageText,
        el('div', { class: 'td-progress-bar-wrap' }, [bar]),
        el('div', { class: 'td-progress-meta' }, [percentText, batchText, elapsedText]),
        hintText,
    ]);

    const stopButton = button('⏹ 终止', () => {
        const ok = app.abortRunning();
        if (!ok) return;
        stopButton.classList.add('td-disabled');
        hintText.textContent = '已发出终止请求，正在等待当前请求中断…';
    }, { variant: 'danger', title: '中断当前任务（已完成的批次不会丢失）' });

    const footer = el('div', { class: 'td-progress-foot' }, [
        el('div', { class: 'notes td-progress-note' }, '任务在后台继续，可以拖动本窗口或先关掉它。'),
        stopButton,
    ]);

    const shell = el('div', { class: 'td-progress-window', id: 'tavern-dice-progress' }, [
        header,
        body,
        footer,
    ]);

    overlay = el('div', { class: 'td-progress-overlay' }, shell);
    document.body.appendChild(overlay);

    // 可拖动：用户常想边看剧情边等
    undrag = makeDraggable(shell, header, {});

    /** 渲染当前状态。 */
    const render = () => {
        const p = app.progress;
        if (!p.active) {
            closeProgress();
            return;
        }
        title.textContent = p.kind || '处理中';
        stageText.textContent = p.detail || '处理中…';
        const pct = Math.max(0, Math.min(100, Math.round(p.percent || 0)));
        bar.style.width = `${pct}%`;
        percentText.textContent = `${pct}%`;
        batchText.textContent = p.total > 1 ? `第 ${p.batch}/${p.total} 批` : '';
        const elapsed = p.startedAt ? Math.round((Date.now() - p.startedAt) / 1000) : 0;
        elapsedText.textContent = elapsed > 0 ? `已用 ${formatDuration(elapsed)}` : '';
        stopButton.classList.toggle('td-disabled', !p.cancellable);
    };

    render();
    // 用字面量事件名而不是从 app.js 导入常量：progress.js 与 app.js 互相依赖会形成循环 import，
    // 而 ESM 的循环 import 初始化顺序很脆（这里踩过一次）。事件名与 app.js 的
    // `APP_EVENT` 之外的 `emit('progress')` 保持一致。
    app.on('progress', render);
    if (!ticker) {
        ticker = setInterval(() => {
            if (!overlay) return;
            render();
        }, 500);
    }

    return overlay;
}

/**
 * 把秒数格式化成「1分23秒」这样的可读形式。
 * @param {number} seconds
 * @returns {string}
 */
function formatDuration(seconds) {
    const s = Math.max(0, Math.round(seconds));
    if (s < 60) return `${s} 秒`;
    const m = Math.floor(s / 60);
    const rest = s % 60;
    return `${m} 分 ${rest} 秒`;
}

/**
 * 关闭并清理进度窗口。
 */
export function closeProgress() {
    if (ticker) {
        clearInterval(ticker);
        ticker = null;
    }
    undrag?.();
    undrag = null;
    overlay?.remove();
    overlay = null;
}

/**
 * 用户主动收起窗口。
 * 注意：**只是收起窗口，不终止任务** —— 终止要靠「⏹ 终止」按钮。
 * 这两件事混在一起很容易误操作（想看剧情结果把任务关了）。
 */
export function dismissProgress() {
    closeProgress();
}
