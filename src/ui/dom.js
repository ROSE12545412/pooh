/**
 * tavern-dice / src/ui/dom.js
 * ---------------------------------------------------------------------------
 * 极简 DOM 工具。不引入任何框架：酒馆扩展要能在别人的页面里安全运行，
 * 引框架既有体积风险也会和主题样式打架。
 */

import { describeError } from '../llm/client.js';


/**
 * 创建元素。
 * @param {string} tag 标签名，支持 `div.cls#id` 简写
 * @param {object|string} [attrs] 属性对象，或直接给文本
 * @param {Array<Node|string|null|undefined>|string} [children]
 * @returns {HTMLElement}
 */
export function el(tag, attrs, children) {
    const match = String(tag).match(/^([a-zA-Z0-9-]+)((?:\.[\w-]+)*)?(#[\w-]+)?$/);
    const name = match?.[1] ?? 'div';
    const node = document.createElement(name);

    if (match?.[2]) {
        for (const cls of match[2].split('.').filter(Boolean)) node.classList.add(cls);
    }
    if (match?.[3]) node.id = match[3].slice(1);

    if (typeof attrs === 'string') {
        node.textContent = attrs;
        attrs = undefined;
    }

    if (attrs && typeof attrs === 'object') {
        for (const [key, value] of Object.entries(attrs)) {
            if (value === null || value === undefined || value === false) continue;
            if (key === 'class' || key === 'className') {
                for (const cls of String(value).split(/\s+/).filter(Boolean)) node.classList.add(cls);
            } else if (key === 'style' && typeof value === 'object') {
                for (const [k, v] of Object.entries(value)) {
                    if (v !== null && v !== undefined) /** @type {any} */ (node.style)[k] = v;
                }
            } else if (key === 'dataset' && typeof value === 'object') {
                for (const [k, v] of Object.entries(value)) node.dataset[k] = String(v);
            } else if (key === 'text') {
                node.textContent = String(value);
            } else if (key === 'html') {
                node.innerHTML = String(value);
            } else if (key.startsWith('on') && typeof value === 'function') {
                node.addEventListener(key.slice(2).toLowerCase(), /** @type {any} */ (value));
            } else if (key === 'value' && 'value' in node) {
                /** @type {any} */ (node).value = value;
            } else if (key === 'checked' || key === 'disabled' || key === 'selected') {
                /** @type {any} */ (node)[key] = Boolean(value);
            } else {
                node.setAttribute(key, String(value));
            }
        }
    }

    append(node, children);
    return node;
}

/**
 * 判断一个值是不是 DOM 节点。
 *
 * ⚠️ 这里刻意**不用 `instanceof Node`**：
 * `Node` 是宿主环境提供的全局构造器，在某些 WebView / 打包运行时里并不存在，
 * 而它是一个 ReferenceError（不是 undefined），会让整个 UI 挂载直接失败，
 * 而且外层 try/catch 会把错误吞掉，表现成「插件启动了但界面完全不见」。
 * 用鸭子类型判断既安全又够用。
 *
 * @param {any} value
 * @returns {boolean}
 */
export function isDomNode(value) {
    if (!value || typeof value !== 'object' || typeof value.nodeType !== 'number') return false;
    // 标准 DOM 有 nodeName；少数实现（以及测试桩）只给 tagName，两个都认
    return (
        typeof (/** @type {any} */ (value).nodeName) === 'string' ||
        typeof (/** @type {any} */ (value).tagName) === 'string'
    );
}

/**
 * 追加子节点。字符串按纯文本处理（**不解析 HTML，避免 XSS**）。
 * @param {Node} parent
 * @param {any} children
 */
export function append(parent, children) {
    if (children === null || children === undefined || children === false) return;
    if (Array.isArray(children)) {
        for (const child of children) append(parent, child);
        return;
    }
    if (isDomNode(children)) {
        parent.appendChild(children);
        return;
    }
    parent.appendChild(document.createTextNode(String(children)));
}

/** 清空元素。 */
export function clear(node) {
    while (node?.firstChild) node.removeChild(node.firstChild);
}

/**
 * 查询。
 * @param {string} selector
 * @param {ParentNode} [root]
 * @returns {HTMLElement|null}
 */
export function qs(selector, root = document) {
    return /** @type {HTMLElement|null} */ (root.querySelector(selector));
}

/**
 * 绑定事件。目标不支持事件（null、纯数据对象）时静默跳过 ——
 * 让 UI 代码不必到处判空，也避免因为某个挂载点缺失就整块界面挂掉。
 * @param {EventTarget|null|undefined} target
 * @param {string} type
 * @param {EventListenerOrEventListenerObject} handler
 * @param {any} [opts]
 */
export function on(target, type, handler, opts) {
    if (!target || typeof (/** @type {any} */ (target).addEventListener) !== 'function') return;
    /** @type {any} */ (target).addEventListener(type, handler, opts);
}

/**
 * 解绑事件。与 `on` 对称，目标不支持事件时静默跳过。
 * @param {EventTarget|null|undefined} target
 * @param {string} type
 * @param {EventListenerOrEventListenerObject} handler
 */
export function off(target, type, handler) {
    if (!target || typeof (/** @type {any} */ (target).removeEventListener) !== 'function') return;
    /** @type {any} */ (target).removeEventListener(type, handler);
}

/**
 * 生成一个主题化的按钮。
 * @param {string} label
 * @param {(ev?: Event) => void} onClick
 * @param {{id?: string, icon?: string, small?: boolean, title?: string, variant?: string, disabled?: boolean}} [opts]
 * @returns {HTMLElement}
 */
export function button(label, onClick, opts = {}) {
    const cls = ['menu_button'];
    if (opts.small) cls.push('menu_button_small');
    if (opts.variant) cls.push(`td-btn-${opts.variant}`);
    if (opts.disabled) cls.push('td-disabled');
    const node = el(
        'div',
        {
            class: cls.join(' '),
            id: opts.id,
            title: opts.title,
            role: 'button',
            tabindex: opts.disabled ? '-1' : '0',
            'aria-disabled': opts.disabled ? 'true' : null,
        },
        [opts.icon ? el('i', { class: opts.icon }) : null, opts.icon ? ' ' : null, label],
    );
    on(node, 'click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (opts.disabled) return;
        onClick(e);
    });
    on(node, 'keydown', (e) => {
        const key = /** @type {KeyboardEvent} */ (e).key;
        if (key === 'Enter' || key === ' ') {
            e.preventDefault();
            if (opts.disabled) return;
            onClick(e);
        }
    });
    return node;
}

/**
 * 带标签的输入行。
 * @param {string} label
 * @param {HTMLElement} input
 * @param {string} [hint]
 * @returns {HTMLElement}
 */
export function field(label, input, hint) {
    return el('div', { class: 'td-field' }, [
        el('label', { class: 'td-field-label' }, label),
        input,
        hint ? el('small', { class: 'notes' }, hint) : null,
    ]);
}

/**
 * 文本输入框。
 * @param {{value?: string, placeholder?: string, id?: string, type?: string, onInput?: (v: string) => void, min?: string, max?: string, step?: string}} opts
 * @returns {HTMLInputElement}
 */
export function textInput(opts = {}) {
    const input = /** @type {HTMLInputElement} */ (
        el('input', {
            class: 'text_pole',
            id: opts.id,
            type: opts.type ?? 'text',
            value: opts.value ?? '',
            placeholder: opts.placeholder ?? '',
            min: opts.min,
            max: opts.max,
            step: opts.step,
        })
    );
    if (opts.onInput) on(input, 'input', () => opts.onInput?.(input.value));
    return input;
}

/**
 * 下拉框。
 * @param {Array<{value: string, label: string, title?: string}>} options
 * @param {string} value
 * @param {(v: string) => void} onChange
 * @param {{id?: string}} [opts]
 * @returns {HTMLSelectElement}
 */
export function select(options, value, onChange, opts = {}) {
    const node = /** @type {HTMLSelectElement} */ (el('select', { class: 'text_pole', id: opts.id }));
    for (const opt of options) {
        const option = /** @type {HTMLOptionElement} */ (
            el('option', { value: opt.value, title: opt.title }, opt.label)
        );
        if (opt.value === value) option.selected = true;
        node.appendChild(option);
    }
    on(node, 'change', () => onChange(node.value));
    return node;
}

/**
 * 复选框行。
 * @param {string} label
 * @param {boolean} checked
 * @param {(v: boolean) => void} onChange
 * @param {{id?: string, hint?: string}} [opts]
 * @returns {HTMLElement}
 */
export function checkbox(label, checked, onChange, opts = {}) {
    const input = /** @type {HTMLInputElement} */ (
        el('input', { type: 'checkbox', id: opts.id, checked })
    );
    on(input, 'change', () => onChange(input.checked));
    return el('div', { class: 'td-checkbox-row' }, [
        el('label', { class: 'checkbox_label' }, [input, el('span', {}, label)]),
        opts.hint ? el('small', { class: 'notes' }, opts.hint) : null,
    ]);
}

/**
 * 折叠面板（用酒馆自带的 inline-drawer 样式，自动跟随主题）。
 * @param {string} title
 * @param {any} content
 * @param {{open?: boolean, id?: string}} [opts]
 * @returns {HTMLElement}
 */
export function drawer(title, content, opts = {}) {
    const body = el('div', { class: 'inline-drawer-content', style: opts.open === false ? { display: 'none' } : {} }, content);
    const icon = el('div', { class: 'inline-drawer-icon fa-solid fa-circle-chevron-down down' });
    if (opts.open === false) icon.classList.add('closed');
    const header = el('div', { class: 'inline-drawer-toggle inline-drawer-header' }, [el('b', {}, title), icon]);
    const node = el('div', { class: 'inline-drawer', id: opts.id }, [header, body]);
    on(header, 'click', () => {
        const hidden = body.style.display === 'none';
        body.style.display = hidden ? '' : 'none';
        icon.classList.toggle('down', hidden);
        icon.classList.toggle('closed', !hidden);
    });
    return node;
}

/**
 * 一个「统计数字」小卡片。
 * @param {string} label
 * @param {string|number} value
 * @param {string} [hint]
 * @returns {HTMLElement}
 */
export function stat(label, value, hint) {
    return el('div', { class: 'td-stat', title: hint ?? '' }, [
        el('div', { class: 'td-stat-value' }, String(value)),
        el('div', { class: 'td-stat-label' }, label),
    ]);
}

/**
 * 判断一个元素是不是「不该被拖拽抢走事件」的交互控件。
 *
 * ⚠️ 这里必须包含 `.menu_button` 与 `[role="button"]`：
 * 酒馆的按钮是 **`div`**（class 是 `menu_button`），不是 `<button>` 标签。
 * 早期版本的排除列表只查 `button` 标签，导致点面板标题栏上的 × 按钮时
 * 拖拽逻辑照样启动、`setPointerCapture` 把事件抢走，
 * **按钮的 click 永远不触发** —— 表现就是「× 点了没反应，纯摆设」。
 *
 * @param {Element|null} target
 * @returns {boolean}
 */
export function isInteractiveTarget(target) {
    if (!target || typeof (/** @type {any} */ (target).closest) !== 'function') return false;
    return Boolean(
        /** @type {Element} */ (target).closest(
            'button, input, textarea, select, option, a, label, ' +
                '[role="button"], [role="link"], [contenteditable="true"], ' +
                '.menu_button, .td-no-drag, .inline-drawer-toggle',
        ),
    );
}

/**
 * 让一个元素可拖动（用于悬浮球与主面板）。
 *
 * 关键点：
 *  - 用 pointer 事件，鼠标/触屏统一处理。
 *  - 位置用 `left/top` 像素存储，并在拖动结束时回调，方便持久化。
 *  - **交互控件上的按下不启动拖拽**，否则按钮点不动（见 `isInteractiveTarget`）。
 *  - 拖动期间给 body 加类，避免选中文字。
 *
 * @param {HTMLElement} node 要拖动的元素
 * @param {HTMLElement} handle 拖动把手（可以是 node 自己）
 * @param {{onEnd?: (rect: {x: number, y: number}) => void, bounds?: () => {w: number, h: number}, clamp?: boolean}} [opts]
 * @returns {() => void} 解绑函数
 */
export function makeDraggable(node, handle, opts = {}) {
    let startX = 0;
    let startY = 0;
    let originX = 0;
    let originY = 0;
    let dragging = false;

    const onPointerDown = (/** @type {PointerEvent} */ e) => {
        // 交互控件上不触发拖动（否则按钮的 click 会被拖拽吃掉）
        if (isInteractiveTarget(/** @type {any} */ (e.target))) return;
        if (e.button !== undefined && e.button !== 0) return;

        dragging = true;
        const rect = node.getBoundingClientRect();
        startX = e.clientX;
        startY = e.clientY;
        originX = rect.left;
        originY = rect.top;
        node.style.right = 'auto';
        node.style.bottom = 'auto';
        node.style.left = `${originX}px`;
        node.style.top = `${originY}px`;
        document.body.classList.add('td-dragging');
        handle.setPointerCapture?.(e.pointerId);
        e.preventDefault();
    };

    const onPointerMove = (/** @type {PointerEvent} */ e) => {
        if (!dragging) return;
        let x = originX + (e.clientX - startX);
        let y = originY + (e.clientY - startY);

        if (opts.clamp !== false) {
            const bounds = opts.bounds?.() ?? { w: window.innerWidth, h: window.innerHeight };
            const rect = node.getBoundingClientRect();
            // 至少留 48px 在视口内，防止把面板拖丢
            const minX = -rect.width + 48;
            const maxX = bounds.w - 48;
            const minY = 0;
            const maxY = bounds.h - 32;
            x = Math.min(maxX, Math.max(minX, x));
            y = Math.min(maxY, Math.max(minY, y));
        }

        node.style.left = `${Math.round(x)}px`;
        node.style.top = `${Math.round(y)}px`;
    };

    const onPointerUp = (/** @type {PointerEvent} */ e) => {
        if (!dragging) return;
        dragging = false;
        document.body.classList.remove('td-dragging');
        handle.releasePointerCapture?.(e.pointerId);
        const rect = node.getBoundingClientRect();
        opts.onEnd?.({ x: Math.round(rect.left), y: Math.round(rect.top) });
    };

    on(handle, 'pointerdown', onPointerDown);
    on(window, 'pointermove', onPointerMove);
    on(window, 'pointerup', onPointerUp);
    on(window, 'pointercancel', onPointerUp);

    return () => {
        handle.removeEventListener('pointerdown', onPointerDown);
        window.removeEventListener('pointermove', onPointerMove);
        window.removeEventListener('pointerup', onPointerUp);
        window.removeEventListener('pointercancel', onPointerUp);
    };
}

/**
 * 让元素可缩放（右下角把手）。
 * @param {HTMLElement} node
 * @param {HTMLElement} handle
 * @param {{minW?: number, minH?: number, onEnd?: (rect: {w: number, h: number}) => void}} [opts]
 * @returns {() => void}
 */
export function makeResizable(node, handle, opts = {}) {
    const minW = opts.minW ?? 360;
    const minH = opts.minH ?? 280;
    let startX = 0;
    let startY = 0;
    let originW = 0;
    let originH = 0;
    let resizing = false;

    const onDown = (/** @type {PointerEvent} */ e) => {
        resizing = true;
        const rect = node.getBoundingClientRect();
        startX = e.clientX;
        startY = e.clientY;
        originW = rect.width;
        originH = rect.height;
        document.body.classList.add('td-resizing');
        handle.setPointerCapture?.(e.pointerId);
        e.preventDefault();
        e.stopPropagation();
    };
    const onMove = (/** @type {PointerEvent} */ e) => {
        if (!resizing) return;
        const w = Math.max(minW, Math.min(window.innerWidth - 16, originW + (e.clientX - startX)));
        const h = Math.max(minH, Math.min(window.innerHeight - 16, originH + (e.clientY - startY)));
        node.style.width = `${Math.round(w)}px`;
        node.style.height = `${Math.round(h)}px`;
    };
    const onUp = (/** @type {PointerEvent} */ e) => {
        if (!resizing) return;
        resizing = false;
        document.body.classList.remove('td-resizing');
        handle.releasePointerCapture?.(e.pointerId);
        const rect = node.getBoundingClientRect();
        opts.onEnd?.({ w: Math.round(rect.width), h: Math.round(rect.height) });
    };

    on(handle, 'pointerdown', onDown);
    on(window, 'pointermove', onMove);
    on(window, 'pointerup', onUp);
    on(window, 'pointercancel', onUp);

    return () => {
        handle.removeEventListener('pointerdown', onDown);
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        window.removeEventListener('pointercancel', onUp);
    };
}

/**
 * 提示条。优先用酒馆的 toastr，没有就退化成自绘提示。
 * @param {string} message
 * @param {'success'|'info'|'warning'|'error'} [type]
 */
export function toast(message, type = 'success') {
    const globalToastr = /** @type {any} */ (globalThis).toastr;
    if (globalToastr && typeof globalToastr[type] === 'function') {
        globalToastr[type](message, '战斗掷骰');
        return;
    }
    console.log(`[战斗掷骰][${type}] ${message}`);
}

/**
 * 确认对话框。优先用酒馆弹窗，没有就用原生 confirm。
 * @param {string} message
 * @returns {Promise<boolean>}
 */
export function confirmDialog(message) {
    // ⚠️ 不用酒馆的 `callGenericPopup` / `window.confirm`。
    //
    // 踩过的坑：TauriTavern（WebView）里 `window.confirm` 可能被宿主禁用或直接静默返回，
    // 而 `callGenericPopup` 也不保证存在 —— 结果就是**按钮点了没反应**（用户报的「按不动」）。
    // 用插件自己的弹窗最可靠：不依赖任何宿主 API。
    return new Promise((resolve) => {
        let settled = false;
        const finish = (/** @type {boolean} */ value) => {
            if (settled) return;
            settled = true;
            resolve(value);
        };

        try {
            const overlay = openModal({
                title: '请确认',
                body: el('div', { class: 'td-confirm-body' }, String(message ?? '')),
                hideConfirm: true,
                buttons: [
                    { label: '取消', onClick: () => finish(false) },
                    { label: '确认', variant: 'danger', onClick: () => finish(true) },
                ],
            });
            // 用 ✕ / 点遮罩 / ESC 关掉也算取消（否则 Promise 永远不兑现）
            const observer = new MutationObserver(() => {
                if (!overlay.isConnected) {
                    finish(false);
                    observer.disconnect();
                }
            });
            observer.observe(document.body, { childList: true });
        } catch (e) {
            console.error('[战斗掷骰] 确认弹窗创建失败', e);
            // 最后的兜底：直接当成「确认」，至少不把用户卡住
            finish(true);
        }
    });
}

/**
 * 死斗致命攻击前的独立询问。关闭或异常只暂停，绝不默许致命攻击。
 * @param {{actorName?:string,targetName?:string,skillName?:string,isPlayer?:boolean,signal?:AbortSignal}} options
 * @returns {Promise<'mercy'|'continue'|'cancel'>}
 */
export function mercyDialog({ actorName, targetName, skillName, isPlayer, signal } = {}) {
    return new Promise(resolve => {
        let settled = false;
        let overlay;
        let observer;
        const finish = value => {
            if (settled) return;
            settled = true;
            signal?.removeEventListener('abort', onAbort);
            observer?.disconnect();
            if (overlay && currentOverlay === overlay) closeModal();
            resolve(value);
        };
        const onAbort = () => finish('cancel');
        if (signal?.aborted) { finish('cancel'); return; }
        try {
            const actor = String(actorName || (isPlayer ? '你' : '友方'));
            const target = String(targetName || '目标');
            const skill = String(skillName || '本次攻击');
            overlay = openModal({
                title: isPlayer ? '死斗 · 是否留手？' : '死斗 · 是否阻止友方？',
                body: el('div', { class: 'td-mercy-body' }, [
                    el('p', {}, `${actor}将对${target}使用「${skill}」，本次攻击可能致命。`),
                    el('p', {}, isPlayer ? '是否留手，让对方退出战斗前往观战席？'
                        : '是否尝试阻止友方的致命攻击？阻止是否成功由后续检定决定。'),
                    el('p', { class: 'notes' }, '继续攻击可能导致阵亡；暂停、关闭或取消不会自动继续攻击。'),
                ]),
                hideConfirm: true,
                onClose: () => finish('cancel'),
                buttons: [
                    { label: isPlayer ? '留手' : '尝试阻止', id: 'td-mercy-choose', variant: 'primary', onClick: () => { finish('mercy'); return false; } },
                    { label: '继续攻击', id: 'td-mercy-continue', variant: 'danger', onClick: () => { finish('continue'); return false; } },
                    { label: '暂停', id: 'td-mercy-cancel', onClick: () => { finish('cancel'); return false; } },
                ],
            });
            signal?.addEventListener('abort', onAbort, { once: true });
            // 外部移除弹窗也必须结束等待，不留下悬挂的致命攻击。
            if (typeof MutationObserver === 'function') {
                observer = new MutationObserver(() => { if (!overlay.isConnected) finish('cancel'); });
                observer.observe(document.body, { childList: true });
            }
            if (signal?.aborted) finish('cancel');
        } catch (error) {
            console.error('[战斗掷骰] 死斗询问弹窗创建失败，已暂停攻击', error);
            finish('cancel');
        }
    });
}

/**
 * 转义文本，仅在确实要拼 HTML 时使用。
 * @param {string} text
 * @returns {string}
 */
export function escapeHtml(text) {
    return String(text ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

/**
 * 格式化时间戳为 HH:MM:SS。
 * @param {number} ts
 * @returns {string}
 */
export function formatTime(ts) {
    const d = new Date(ts);
    const pad = (/** @type {number} */ n) => String(n).padStart(2, '0');
    return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/**
 * 格式化相对时间（「3 分钟前」）。
 * @param {number} ts
 * @returns {string}
 */
export function formatAgo(ts) {
    const diff = Date.now() - Number(ts || 0);
    if (!Number.isFinite(diff) || diff < 0) return '刚刚';
    const sec = Math.floor(diff / 1000);
    if (sec < 60) return `${sec} 秒前`;
    const min = Math.floor(sec / 60);
    if (min < 60) return `${min} 分钟前`;
    const hour = Math.floor(min / 60);
    if (hour < 24) return `${hour} 小时前`;
    return `${Math.floor(hour / 24)} 天前`;
}

// ---------------------------------------------------------------------------
// 通用模态弹窗
// ---------------------------------------------------------------------------

/** 当前打开的弹窗。 */
let currentOverlay = /** @type {HTMLElement|null} */ (null);
let currentModalCleanup = null;

/**
 * 打开一个模态弹窗。
 *
 * 从 power-table.js 挪到这里 —— 弹窗是通用组件，不该寄生在某个业务视图里。
 * （那个视图被砍掉后，设置页的「导出预览」就没得用了。）
 *
 * @param {{title: string, body: HTMLElement, onConfirm?: () => Promise<boolean|void>|boolean|void, hideConfirm?: boolean, wide?: boolean, onClose?: () => void, buttons?: Array<{label: string, onClick?: () => any, variant?: string, id?: string}>}} opts
 * @returns {HTMLElement} 弹窗根元素
 */
export function openModal(opts) {
    closeModal();

    const content = el('div', { class: `td-modal${opts.wide ? ' td-modal-wide' : ''}` });
    content.appendChild(
        el('div', { class: 'td-modal-head' }, [
            el('b', {}, opts.title),
            el('div', { class: 'td-modal-close', role: 'button', tabindex: '0' }, '✕'),
        ]),
    );
    content.appendChild(el('div', { class: 'td-modal-body' }, opts.body));

    const footer = el('div', { class: 'td-modal-foot' });

    if (Array.isArray(opts.buttons) && opts.buttons.length) {
        // 自定义按钮组：调用方自己决定语义（例如「确认 / 取消」）
        for (const spec of opts.buttons) {
            footer.appendChild(
                button(
                    spec.label,
                    async () => {
                        try {
                            const result = await spec.onClick?.();
                            if (result !== false) closeModal();
                        } catch (e) {
                            console.error('[战斗掷骰] 弹窗按钮出错', e);
                            toast(`操作失败：${describeError(e)}`, 'error');
                        }
                    },
                    { variant: spec.variant, id: spec.id },
                ),
            );
        }
    } else if (!opts.hideConfirm) {
        footer.appendChild(button('取消', () => closeModal()));
        const saveButton = button(
            '保存',
            async () => {
                if (saveButton.classList.contains('td-loading')) return;
                saveButton.classList.add('td-loading');
                try {
                    const result = await opts.onConfirm?.();
                    if (result !== false) closeModal();
                } catch (e) {
                    console.error('[战斗掷骰] 弹窗保存出错', e);
                    toast(`保存失败：${describeError(e)}`, 'error');
                } finally {
                    saveButton.classList.remove('td-loading');
                }
            },
            { variant: 'primary' },
        );
        footer.appendChild(saveButton);
    }
    content.appendChild(footer);

    const overlay = el('div', { class: 'td-overlay', id: 'tavern-dice-modal' }, content);
    on(overlay, 'click', (e) => {
        if (e.target === overlay) closeModal();
    });
    qs('.td-modal-close', content)?.addEventListener('click', () => closeModal());

    document.body.appendChild(overlay);
    currentOverlay = overlay;

    // ESC 关闭
    const onKey = (/** @type {KeyboardEvent} */ e) => {
        if (e.key === 'Escape') {
            closeModal();
            document.removeEventListener('keydown', onKey);
        }
    };
    document.addEventListener('keydown', onKey);
    currentModalCleanup = () => {
        document.removeEventListener('keydown', onKey);
        opts.onClose?.();
    };
    return overlay;
}

/** 关闭当前弹窗。 */
export function closeModal() {
    const overlay = currentOverlay;
    const cleanup = currentModalCleanup;
    currentOverlay = null;
    currentModalCleanup = null;
    overlay?.remove();
    cleanup?.();
}
