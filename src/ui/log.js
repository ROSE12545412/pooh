/**
 * tavern-dice / src/ui/log.js
 * ---------------------------------------------------------------------------
 * 运行日志视图。记录场景读取、战斗与结算。
 */

import { APP_EVENT } from '../app.js';
import { button, clear, el, on } from './dom.js';

/**
 * 渲染日志视图。
 * @param {import('../app.js').AppController} app
 * @param {{rerender: () => void}} helpers
 * @returns {HTMLElement}
 */
export function renderLog(app, helpers) {
    const root = el('div', { class: 'td-view td-view-log' });
    const state = app.state;

    const toolbar = el('div', { class: 'td-toolbar' }, [
        el('div', { class: 'td-row td-gap' }, [
            button('🔄 刷新', () => helpers.rerender()),
            button('🧹 清屏', () => {
                app.lastLogs.length = 0;
                helpers.rerender();
            }),
            button('📋 复制全部', async () => {
                const text = app.lastLogs.join('\n');
                try {
                    await navigator.clipboard.writeText(text);
                    app.log('· 日志已复制到剪贴板');
                } catch {
                    window.prompt('复制下面的日志：', text);
                }
                helpers.rerender();
            }),
        ]),
        el('div', { class: 'notes' }, '场景读取、模型决策与战斗结算都会记录在这里。'),
    ]);
    root.appendChild(toolbar);

    // 当前状态摘要
    root.appendChild(
        el('div', { class: 'td-log-summary' }, [
            summaryItem('运行状态', state.busy ? `执行中：${state.busyLabel}` : '空闲'),
            summaryItem('当前场景', state.hasPowerSystem ? `${state.unitCount} 个单位` : '未建立'),
            summaryItem('规则集', state.rulesetName),
            summaryItem('场景摘要', state.lastUpdateSummary || '（无）'),
        ]),
    );

    // 日志输出
    const pre = el('pre', { class: 'td-log-output' });
    if (!app.lastLogs.length) {
        pre.textContent = '（暂无日志）\n\n提示：读取战斗场景、开战后的每一步都会在这里留下记录。';
    } else {
        pre.textContent = app.lastLogs.join('\n');
    }
    root.appendChild(pre);

    // 自动滚到底部（只在用户没有往上翻的时候）
    requestAnimationFrame(() => {
        const nearBottom = pre.scrollHeight - pre.scrollTop - pre.clientHeight < 120;
        if (nearBottom) pre.scrollTop = pre.scrollHeight;
    });

    // 实时追加，避免整页重画导致滚动位置丢失
    let appended = app.lastLogs.length;
    const unsubscribe = app.on(APP_EVENT.LOG, (/** @type {string} */ line) => {
        appended++;
        if (pre.textContent === '' || app.lastLogs.length === 1) pre.textContent = '';
        pre.textContent += `${line}\n`;
        pre.scrollTop = pre.scrollHeight;
    });
    // 视图被移除时自动解绑
    const observer = new MutationObserver(() => {
        if (!document.body.contains(root)) {
            unsubscribe();
            observer.disconnect();
        }
    });
    observer.observe(document.body, { childList: true, subtree: true });
    void appended;

    // 审计日志
    root.appendChild(renderAudit(app));

    return root;
}

/** 一条摘要。 */
function summaryItem(/** @type {string} */ label, /** @type {string} */ value) {
    return el('div', { class: 'td-log-summary-item' }, [
        el('span', { class: 'td-mini-label' }, label),
        el('span', {}, value),
    ]);
}

/** 审计日志列表。 */
function renderAudit(app) {
    const log = app.data.auditLog ?? [];
    const wrap = el('div', { class: 'td-audit-block' });
    wrap.appendChild(el('b', {}, `📜 变更审计（最近 ${Math.min(log.length, 40)} / 共 ${log.length} 条）`));

    if (!log.length) {
        wrap.appendChild(el('div', { class: 'notes' }, '还没有记录。每次场景读取、开战、战斗结算都会在这里留痕。'));
        return wrap;
    }

    for (const entry of [...log].reverse().slice(0, 40)) {
        const typeText =
            {
                'set-power-system': '场景读取',
                'auto-update': '自动更新',
                'manual-update': '手动更新',
                edit: '手工编辑',
                'battle-start': '开战',
                'battle-finish': '战斗结算',
                'battle-end': '战斗结束',
                import: '导入',
            }[entry.type] ?? entry.type;

        const item = el('div', { class: 'td-audit-item' }, [
            el('div', { class: 'td-audit-head' }, [
                el('span', { class: 'td-tag' }, typeText),
                el('span', { class: 'notes' }, new Date(entry.at).toLocaleString('zh-CN')),
                entry.source ? el('span', { class: 'notes' }, `来源：${entry.source}`) : null,
                entry.round ? el('span', { class: 'notes' }, `第 ${entry.round} 回合`) : null,
            ]),
            el('div', {}, entry.summary ?? ''),
        ]);

        if (Array.isArray(entry.changes) && entry.changes.length) {
            const list = el('ul', { class: 'td-audit-changes' });
            for (const change of entry.changes.slice(0, 40)) list.appendChild(el('li', {}, String(change)));
            item.appendChild(list);
        }
        if (Array.isArray(entry.issues) && entry.issues.length) {
            const list = el('ul', { class: 'td-audit-issues' });
            for (const issue of entry.issues.slice(0, 20)) {
                list.appendChild(el('li', {}, `[${issue.level}] ${issue.path}：${issue.message}`));
            }
            item.appendChild(list);
        }
        wrap.appendChild(item);
    }

    return wrap;
}

export { clear, on };
