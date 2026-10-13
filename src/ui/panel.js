/**
 * tavern-dice / src/ui/panel.js
 * ---------------------------------------------------------------------------
 * 主面板：可拖动、可缩放、带标签页的容器。
 *
 * 两种使用形态：
 *  - 悬浮面板（`embedded: false`）：挂在 body 上，由悬浮球开合，含拖动手柄与缩放手柄。
 *  - 内嵌面板（`embedded: true`）：插进酒馆的扩展设置区，不自己做拖拽。
 */

import { APP_EVENT } from '../app.js';
import { renderBattle, clearPendingAction } from './battle.js';
import { button, clear, el, makeDraggable, makeResizable, on } from './dom.js';
import { BUILD_STAMP } from '../build.js';
import { diagLog } from './diag.js';
import { renderLog } from './log.js';
import { renderLoadout } from './loadout.js';
import { closeProgress, openProgress } from './progress.js';
import { renderSettings } from './settings.js';
import { describeError } from '../llm/client.js';

/**
 * 标签页定义。
 *
 * 这里**没有「战力表」页** —— 数据仍然存在（战斗引擎、读场面、剧情更新都要用它），
 * 但不再暴露成一张要用户照看的表。玩家只需要「战斗」和「设置」。
 * 想查内部数据可以在「设置 → 高级」里导出 JSON。
 */
const TABS = [
    { id: 'battle', label: '🎲 战斗', title: '读当前场面并开打' },
    { id: 'loadout', label: '🎒 自定义库', title: '技能、武器、防具、饰品的正文润色与携带选择' },
    { id: 'settings', label: '⚙ 设置', title: '战斗模型、场景生成、掷骰规则与存档' },
    { id: 'log', label: '📜 日志', title: '运行日志与变更审计' },
];

/** Viewport-only geometry: never writes desktop preferences when a phone/keyboard resizes. */
export function panelGeometry(rect = {}, viewport = {}) {
    const positive = (value, fallback) => Number.isFinite(value) && value > 0 ? value : fallback;
    const width = positive(viewport.width, 1024), height = positive(viewport.height, 768);
    const mobile = width <= 600;
    if (mobile) {
        const visual = viewport.visualViewport;
        const vw = Math.min(width, positive(visual?.width, width));
        const vh = Math.min(height, positive(visual?.height, height));
        const x = Number.isFinite(visual?.offsetLeft) ? Math.max(0, visual.offsetLeft) : 0;
        const y = Number.isFinite(visual?.offsetTop) ? Math.max(0, visual.offsetTop) : 0;
        const margin = Math.min(8, vw / 4, vh / 4);
        const scale = Number.isFinite(rect.mobileScale) ? Math.max(0.6, Math.min(1, rect.mobileScale)) : 1;
        const w = (vw - margin * 2) * scale, h = (vh - margin * 2) * scale;
        return { mobile, x: x + (vw - w) / 2, y: y + (vh - h) / 2, w, h };
    }
    const w = Math.min(Math.max(1, width - 20), Math.max(420, positive(rect.w, 900)));
    const h = Math.min(Math.max(1, height - 20), Math.max(320, positive(rect.h, 640)));
    const clamp = (value, max) => Math.max(0, Math.min(Math.max(0, max), value));
    const stored = Boolean(rect.x || rect.y);
    return { mobile, w, h,
        x: stored ? clamp(Number.isFinite(rect.x) ? rect.x : 0, width - w) : Math.max(10, Math.round((width - w) / 2)),
        y: stored ? clamp(Number.isFinite(rect.y) ? rect.y : 0, height - h) : Math.max(10, Math.round((height - h) / 2)) };
}

export class MainPanel {
    /**
     * @param {import('../app.js').AppController} app
     * @param {{embedded?: boolean, initialTab?: string, onOpenChange?: (open: boolean) => void, domId?: string}} [opts]
     */
    constructor(app, opts = {}) {
        this.app = app;
        this.embedded = Boolean(opts.embedded);
        this.activeTab = opts.initialTab ?? 'battle';
        /** 面板根元素的 id。内嵌与悬浮用不同的 id，方便外部定位。 */
        this.domId = opts.domId ?? (this.embedded ? 'tavern-dice-panel-embedded' : 'tavern-dice-panel');
        /** @type {Map<string, HTMLElement>} */
        this.views = new Map();
        this.onOpenChange = opts.onOpenChange;
        this.node = this._build();
        if (!this.embedded) {
            this._onViewportChange = () => this.applyStoredGeometry();
            this._viewportWindow = globalThis.window;
            this._visualViewport = this._viewportWindow?.visualViewport;
            this._viewportWindow?.addEventListener?.('resize', this._onViewportChange);
            this._viewportWindow?.addEventListener?.('orientationchange', this._onViewportChange);
            this._visualViewport?.addEventListener?.('resize', this._onViewportChange);
            this._visualViewport?.addEventListener?.('scroll', this._onViewportChange);
        }
        this._unsubscribe = app.on(APP_EVENT.STATE_CHANGED, () => {
            if (!this.embedded) this._renderBadges();
        });
    }

    /** 打开（仅悬浮模式）。 */
    open() {
        if (this.embedded) return;
        diagLog('info', `panel.open() 调用前 open=${this._isOpen === true}`);

        // ---- 照抄「碧翠丝」那套已经验证可行的做法 ----
        //
        // 我前面折腾了很久都没解决「面板打开一瞬间就消失」，试过：
        //   · 把 z-index 从 29999 一路提到 2147483000 —— 没用（z-index 只在同一层叠上下文里比较）
        //   · popover 顶层 —— 诊断显示确实进了顶层，但依然看不见
        //   · 自建 overlay + 内联 display 切换 —— 时有反复
        //
        // 工作区里另一个插件（碧翠丝）的悬浮窗在同一个酒馆里完全正常，它的做法是：
        //   · 一个 **position:fixed; inset:0** 的全屏 overlay，创建时挂一次 body，此后**再也不动 DOM**
        //   · 显隐**完全不碰内联样式**，只切一个 `data-open` 属性
        //   · CSS 里 `.xxx-overlay{display:none}` + `.xxx-overlay[data-open='1']{display:flex}`
        //
        // 这个做法更可靠的原因：内联 display 会被 CSS 规则与层叠上下文的各种细节干扰，
        // 而「属性 + 属性选择器」只由一条规则决定，没有歧义。
        // 所以这里照抄，不再自创。
        this._ensureOverlay();
        this._isOpen = true;
        this._justOpenedAt = Date.now();

        this.node.classList.add('td-panel-open');
        if (this._overlay) {
            this._overlay.dataset.open = '1';
            this._overlay.setAttribute('data-open', '1');
        }
        // 兜底：万一 CSS 没加载，属性选择器不生效，内联样式保证还能显示
        if (this._overlay) this._overlay.style.display = 'flex';
        // 面板本体的 display 交给 CSS（.td-panel 是 flex）
        this.node.style.display = '';

        this.render();

        // ---- 自检：这一帧结束时面板到底还在不在 ----
        //
        // 用户报的现象是「球消失（=面板开了）→ 过一会球又回来（=面板被关了）」。
        // 所以必须抓出**是谁在关它**。这里分两个时间点采样：
        //   · 立即：确认 open 本身成功
        //   · 下一帧：如果这时已经变成收起，说明有别的调用把它关了
        const immediate = { open: this._isOpen, connected: this._overlay?.isConnected !== false };
        setTimeout(() => {
            if (!immediate.open) return;
            const stillOpen = this._isOpen;
            const connected = this._overlay?.isConnected !== false;
            if (!stillOpen) {
                // 抓到元凶：某处在 open 之后调了 close
                console.warn(
                    '[战斗骰子] 面板在 open() 之后被别处关闭了。调用栈：\n' +
                        new Error('谁调的 close？').stack,
                );
                diagLog('error', '面板在 open() 之后被别处关闭（见调用栈）');
            } else if (!connected) {
                diagLog('error', '面板容器被移出了文档（有代码在重建 body？）');
            } else {
                diagLog('info', `open 后 50ms 仍为展开｜${this.describeState()}`);
            }
        }, 50);

        this.onOpenChange?.(true);
        diagLog('info', `panel.open() 完成 → ${this.describeState()}`);
    }

    /**
     * 把面板容器放进浏览器顶层（Top Layer）。
     *
     * 顶层是唯一能**压过一切**的机制。失败时静默降级 ——
     * 不能因为环境不支持就打不开面板。
     */
    _enterTopLayer() {
        const node = /** @type {any} */ (this._overlay);
        if (!node || this._inTopLayer) return;
        if (typeof node.showPopover === 'function') {
            try {
                if (!node.hasAttribute?.('popover')) node.setAttribute?.('popover', 'manual');
                node.showPopover();
                this._inTopLayer = 'popover';
                diagLog('info', '面板容器已进入顶层（popover）');
                return;
            } catch (e) {
                diagLog('warn', `容器顶层失败：${String(e?.message ?? e)}`);
            }
        }
        this._inTopLayer = '';
    }

    /** 退出顶层。 */
    _exitTopLayer() {
        const node = /** @type {any} */ (this._overlay);
        const how = this._inTopLayer;
        this._inTopLayer = '';
        if (!how || !node) return;
        try {
            if (how === 'popover' && typeof node.hidePopover === 'function') node.hidePopover();
        } catch {
            /* 已经不在顶层就算了 */
        }
    }

    /**
     * 建立（或复用）承载面板的全屏 overlay。
     * 内联样式写在元素上，不依赖 style.css —— 最坏情况下也要能显示。
     */
    _ensureOverlay() {
        if (this._overlay?.isConnected) return this._overlay;

        // 桩环境里元素可能没有 ownerDocument，退回全局 document
        const doc = this.node.ownerDocument ?? globalThis.document;
        if (!doc) {
            diagLog('error', '拿不到 document，无法建立面板容器');
            return null;
        }
        const overlay = doc.createElement('div');
        overlay.id = 'tavern-dice-panel-layer';
        // 显隐交给 CSS 的属性选择器（见 style.css 里的 #tavern-dice-panel-layer）
        overlay.dataset.open = '0';
        // 内联只放「兜底 + 不影响属性选择器」的最小集合。
        // ⚠️ 内联 display 会盖掉 CSS 的 [data-open] 规则，所以这里**不写 display**，
        // 由 style.css 决定 —— 这是照抄碧翠丝的关键点。
        Object.assign(overlay.style, {
            position: 'fixed',
            inset: '0',
            zIndex: '31000',
            pointerEvents: 'none',
        });
        // 面板自己接收交互
        Object.assign(this.node.style, { pointerEvents: 'auto' });

        overlay.appendChild(this.node);
        doc.body.appendChild(overlay);
        this._overlay = overlay;
        diagLog('info', '面板容器（全屏 overlay）已建立');
        return overlay;
    }

    /** 关闭（仅悬浮模式）。 */
    close() {
        if (this.embedded) return;
        const elapsed = this._justOpenedAt ? Date.now() - this._justOpenedAt : -1;
        diagLog('info', `panel.close() 被调用（打开后 ${elapsed >= 0 ? elapsed + 'ms' : '不久'}）`);
        if (elapsed >= 0 && elapsed < 1500) {
            console.warn(`[战斗掷骰] 面板在打开 ${elapsed}ms 后就被关闭了。调用栈：\n` + new Error('谁关的？').stack);
        }

        this._isOpen = false;
        this.node.classList.remove('td-panel-open');
        // 同样只切属性，不碰内联 display（内联样式会盖掉 CSS，反而更难查）
        if (this._overlay) {
            this._overlay.dataset.open = '0';
            this._overlay.setAttribute('data-open', '0');
            this._overlay.style.display = 'none';
        }
        this.node.style.display = 'none';
        clearPendingAction(this.app.battle);
        this.onOpenChange?.(false);
    }

    /** 切换开合。 */
    toggle() {
        if (this.embedded) return;
        // 以**渲染出来的状态**为准，而不是任何内部标志 ——
        // 标志有可能和真实 DOM 不同步（那样就会出现「点了没反应」）。
        const hidden = !this.isOpen;
        console.log(`[战斗掷骰] 悬浮球点击：面板当前 ${hidden ? '收起' : '展开'} → ${hidden ? '展开' : '收起'}`);
        if (hidden) this.open();
        else this.close();
    }

    /** 诊断用：把面板的真实 DOM 状态说清楚。 */
    describeState() {
        const rect = this.node.getBoundingClientRect?.() ?? { width: 0, height: 0, left: 0, top: 0 };
        const vw = globalThis.innerWidth ?? 0;
        const vh = globalThis.innerHeight ?? 0;
        const offscreen = rect.left + rect.width < 0 || rect.top + rect.height < 0 || rect.left > vw || rect.top > vh;
        const overlayState = this._overlay ? this._overlay.style.display || '(空)' : '（没建）';
        const overlayConnected = this._overlay ? this._overlay.isConnected !== false : false;
        // 容器在父节点里的位置也有意义：宿主重建 body 会把它一起带走
        const parentTag = this._overlay?.parentNode?.tagName ?? '（无父节点）';
        const computed = globalThis.getComputedStyle?.(this.node);
        const zIndex = computed?.zIndex ?? this.node.style.zIndex ?? '(未知)';

        // ---- 多点采样判断遮挡 ----
        //
        // ⚠️ 不能只测中心点。悬浮球比面板层级更高，如果它正好悬在面板中心
        // （用户把球拖到那儿了），中心点就会被球命中 —— 于是误报「面板被挡住」，
        // 而实际上面板大部分都露着。真实踩坑。
        //
        // 所以取 9 个点，只有**全部**被非面板元素挡住才算真被挡；
        // 并把挡住最多点的那个元素报出来，方便定位。
        const doc = globalThis.document;
        let blockedCount = 0;
        let total = 0;
        /** @type {Map<string, number>} */
        const blockers = new Map();

        if (doc?.elementFromPoint && rect.width > 0 && rect.height > 0) {
            for (const fx of [0.2, 0.5, 0.8]) {
                for (const fy of [0.12, 0.5, 0.88]) {
                    const px = Math.round(rect.left + rect.width * fx);
                    const py = Math.round(rect.top + rect.height * fy);
                    if (px < 0 || py < 0 || px > vw || py > vh) continue;
                    total++;
                    let hit = null;
                    try {
                        hit = doc.elementFromPoint(px, py);
                    } catch {
                        /* 忽略 */
                    }
                    if (!hit) continue;
                    if (hit === this.node || this.node.contains(hit)) continue;

                    // ⚠️ 不是所有命中的元素都算「遮挡」：
                    //  · 不接收指针事件的（装饰层、穿透遮罩）挡不住点击；
                    //  · 完全透明的同理。
                    // 之前不筛这两类，导致误报（把透明的宿主容器算成了遮挡者）。
                    const hs = globalThis.getComputedStyle?.(hit);
                    const pe = hs?.pointerEvents;
                    const op = Number(hs?.opacity ?? 1);
                    const disp = hs?.display;
                    const vis = hs?.visibility;
                    if (pe === 'none' || op === 0 || disp === 'none' || vis === 'hidden') continue;

                    // ⚠️ 顶层元素要跳过。面板进了浏览器顶层（popover）之后，
                    // 它的绘制层级高于一切 —— 但 `elementFromPoint` 在部分 WebView 里
                    // **不考虑顶层**，于是仍然返回下面那个元素，造成
                    // 「面板明明看得见，却说被 recentChat 完全挡住」的误报（用户实测踩到）。
                    const inTopLayer =
                        hit.hasAttribute?.('popover') ||
                        (hit.matches?.(':popover-open') ?? false) ||
                        (Array.isArray(hit.getAttribute?.('popover')) ? false : false);
                    if (inTopLayer) continue;

                    blockedCount++;
                    const name = hit.id || (typeof hit.className === 'string' ? hit.className : '') || hit.tagName || '?';
                    const hz = hs?.zIndex ?? '';
                    const label = hz && hz !== 'auto' ? `${name}（z=${hz}）` : name;
                    blockers.set(label, (blockers.get(label) ?? 0) + 1);
                }
            }
        }

        const worst = [...blockers.entries()].sort((a, b) => b[1] - a[1])[0];
        const fullyBlocked = total > 0 && blockedCount === total;
        let hitText = '面板可点 ✓';
        if (total === 0) hitText = '(测不了)';
        else if (fullyBlocked) hitText = `⚠ 完全被「${worst?.[0]}」挡住`;
        else if (blockedCount > 0) hitText = `部分被「${worst?.[0]}」挡住（${blockedCount}/${total} 点）`;

        this._lastBlocked = fullyBlocked;
        this._lastBlocker = worst?.[0] ?? '';

        return [
            `display=${this.node.style.display || '(空)'}`,
            `尺寸=${Math.round(rect.width)}x${Math.round(rect.height)}`,
            `位置=${Math.round(rect.left)},${Math.round(rect.top)}`,
            `z-index=${zIndex}`,
            `开关=${this._isOpen ? '展开' : '收起'}`,
            `overlay=${overlayState}${overlayConnected ? '' : ' ⚠未挂载'}（父=${parentTag}）`,
            `顶层=${this._inTopLayer || '无'}`,
            `遮挡=${hitText}`,
            offscreen ? '⚠ 在屏幕外' : '',
            this.node.isConnected === false ? '⚠ 没挂在文档上' : '',
        ]
            .filter(Boolean)
            .join('｜');
    }

    /** 是否**完全**被别的元素挡住（部分遮挡不算，例如悬浮球压在角上）。 */
    get isFullyBlocked() {
        return this._lastBlocked === true;
    }


    /** 是否打开。 */
    get isOpen() {
        // 用显式标志而不是计算样式：
        // 面板现在被放在一个 overlay 里，可见性由 overlay 与面板共同决定，
        // 只看面板自己的 display 会误判（那正是「点了没反应」的成因之一）。
        if (this.embedded) return true;
        return this._isOpen === true;
    }

    /** 切到某个标签页。 */
    setTab(/** @type {string} */ tab) {
        this.activeTab = tab;
        this.render();
    }

    /** 构建外壳。 */
    _build() {
        this.tabBar = el('div', { class: 'td-tabs' });
        this.badgeHolder = el('div', { class: 'td-panel-badges' });
        this.content = el('div', { class: 'td-panel-content' });
        this.busyBar = el('div', { class: 'td-busy-bar', style: { display: 'none' } }, [
            el('div', { class: 'td-busy-spinner' }),
            el('span', { class: 'td-busy-text' }, ''),
            button('⏹ 终止', () => this.app.abortRunning(), {
                small: true,
                variant: 'danger',
                id: 'tavern-dice-abort',
                title: '中断当前长任务',
            }),
        ]);

        const title = el('div', { class: 'td-panel-title' }, [
            el('span', { class: 'td-panel-icon' }, '🎲'),
            el('b', {}, '战斗掷骰'),
            // 标题栏上常驻构建号：排查时第一件事就是确认跑的是哪一版
            el('span', { class: 'td-badge', title: '构建时间。刷新后如果这个没变，说明跑的还是旧代码' }, BUILD_STAMP.slice(5, 16)),
            this.badgeHolder,
        ]);

        const closeButton = button('✕', () => this.close(), {
            small: true,
            id: 'tavern-dice-panel-close',
            title: '收起面板（悬浮球可再次展开）',
        });

        const header = el('div', { class: 'td-panel-head' }, [
            title,
            el('div', { class: 'td-panel-head-actions' }, [closeButton]),
        ]);

        const resizeHandle = el('div', { class: 'td-resize-handle', title: '拖动调整大小' });

        const shell = el(
            'div',
            {
                class: `td-panel${this.embedded ? ' td-panel-embedded' : ''}`,
                // id 在创建时就定好：内嵌面板的 render() 会在元素插入后才被调用，
                // 如果 id 晚一步赋值，外部按 id 查找就会查不到
                id: this.domId,
            },
            [header, this.tabBar, this.busyBar, this.content, this.embedded ? null : resizeHandle],
        );

        if (!this.embedded) {
            // 手机铺在可用视口内，不能用桌面拖拽/缩放写回桌面几何。
            this._blockMobileGeometry = event => {
                if (window.innerWidth <= 600 && (event.target === resizeHandle ||
                    (header.contains?.(event.target) && !event.target?.closest?.('button, input, .menu_button, [role="button"]')))) {
                    event.stopImmediatePropagation();
                }
            };
            shell.addEventListener('pointerdown', this._blockMobileGeometry, true);
            this._undrag = makeDraggable(shell, header, {
                onEnd: (rect) => {
                    if (window.innerWidth <= 600) { this.applyStoredGeometry(); return; }
                    const settings = this.app.settings;
                    settings.panelRect = { ...settings.panelRect, x: rect.x, y: rect.y };
                    this.app.persistSettings({ silent: true });
                },
            });
            this._unresize = makeResizable(shell, resizeHandle, {
                minW: 420,
                minH: 320,
                onEnd: (rect) => {
                    if (window.innerWidth <= 600) { this.applyStoredGeometry(); return; }
                    const settings = this.app.settings;
                    settings.panelRect = { ...settings.panelRect, w: rect.w, h: rect.h };
                    this.app.persistSettings({ silent: true });
                },
            });
        }

        this.shell = shell;
        return shell;
    }

    /** 应用保存的位置与尺寸。 */
    applyStoredGeometry() {
        if (this.embedded) return;
        const geometry = panelGeometry({ ...this.app.settings.panelRect, mobileScale: this.app.settings.panelMobileScale }, {
            width: window.innerWidth, height: window.innerHeight, visualViewport: window.visualViewport,
        });
        this.shell.dataset.mobile = geometry.mobile ? '1' : '0';
        const values = { left: geometry.x, top: geometry.y, width: geometry.w, height: geometry.h };
        for (const [name, value] of Object.entries(values)) {
            const px = `${value}px`;
            // Existing phone CSS has !important + 100vh; override it for keyboard viewport.
            if (this.shell.style.setProperty) {
                this.shell.style.setProperty(name, px, geometry.mobile ? 'important' : '');
                this.shell.style.setProperty(`--td-panel-viewport-${name}`, px);
            } else this.shell.style[name] = px;
        }
        for (const [name, value] of Object.entries({ 'min-width': '0px', 'min-height': '0px',
            'max-width': `${geometry.w}px`, 'max-height': `${geometry.h}px`, 'box-sizing': 'border-box' })) {
            if (geometry.mobile) this.shell.style.setProperty?.(name, value, 'important');
            else this.shell.style.removeProperty?.(name);
        }
    }

    /** 重画标签栏上的角标。 */
    _renderBadges() {
        clear(this.badgeHolder);
        const state = this.app.state;
        if (!state.hasPowerSystem) {
            this.badgeHolder.appendChild(el('span', { class: 'td-badge td-badge-warn' }, '等待开战'));
        } else if (state.battleActive) {
            this.badgeHolder.appendChild(
                el('span', { class: 'td-badge td-badge-good' }, `战斗中 R${state.battleRound}`),
            );
        }
        if (this.app.busy) {
            this.badgeHolder.appendChild(el('span', { class: 'td-badge td-badge-warn' }, '执行中'));
        }
    }

    /** 整体重画。 */
    render() {
        const helpers = {
            rerender: (/** @type {string} */ tab) => {
                if (tab) this.activeTab = tab;
                this.render();
            },
            setTab: (/** @type {string} */ tab) => this.setTab(tab),
        };

        // 标签栏
        clear(this.tabBar);
        for (const tab of TABS) {
            const state = this.app.state;
            // 战斗标签上挂一个「单位数」角标，让用户知道当前内部数据有多少个单位
            const count =
                tab.id === 'battle' && state.hasPowerSystem && state.unitCount > 0
                    ? state.unitCount
                    : tab.id === 'log'
                      ? state.auditCount
                      : null;
            const node = el(
                'div',
                {
                    class: `td-tab${this.activeTab === tab.id ? ' td-tab-active' : ''}`,
                    title: tab.title,
                    role: 'tab',
                    tabindex: '0',
                },
                [tab.label, count !== null && count > 0 ? el('span', { class: 'td-tab-count' }, String(count)) : null],
            );
            on(node, 'click', () => this.setTab(tab.id));
            on(node, 'keydown', (e) => {
                const key = /** @type {KeyboardEvent} */ (e).key;
                if (key === 'Enter' || key === ' ') {
                    e.preventDefault();
                    this.setTab(tab.id);
                }
            });
            this.tabBar.appendChild(node);
        }

        // 忙碌条
        const state = this.app.state;
        this.busyBar.style.display = state.busy ? '' : 'none';
        const busyText = this.busyBar.querySelector('.td-busy-text');
        if (busyText) busyText.textContent = state.busyLabel || '处理中…';

        // 长任务进度窗口：任务开始时自动弹出，结束时自动收起。
        // 它盖在聊天上，所以做成可拖动的，用户能挪到一边继续看剧情。
        if (state.busy) openProgress(this.app);
        else closeProgress();

        // 内容
        clear(this.content);
        const view = this._renderView(helpers);
        this.content.appendChild(view);
        this._renderBadges();

        // 内嵌模式下高度自适应
        if (this.embedded) {
            this.shell.style.height = 'auto';
        } else {
            this.applyStoredGeometry();
        }
    }

    /** 渲染当前标签页。 */
    _renderView(/** @type {{rerender: (tab?: string) => void, setTab: (tab: string) => void}} */ helpers) {
        try {
            switch (this.activeTab) {
                case 'loadout':
                    return renderLoadout(this.app, helpers);
                case 'settings':
                    return renderSettings(this.app, helpers);
                case 'log':
                    return renderLog(this.app, helpers);
                case 'battle':
                default:
                    return renderBattle(this.app, helpers);
            }
        } catch (e) {
            console.error('[战斗掷骰] 渲染视图失败', e);
            return el('div', { class: 'td-test-bad' }, [
                el('b', {}, '界面渲染出错了'),
                el('div', {}, describeError(e)),
                el('div', { class: 'notes' }, '按 F12 打开控制台可以看到完整堆栈。数据本身没有损坏，刷新页面即可恢复。'),
                button('重试', () => this.render(), { variant: 'primary' }),
            ]);
        }
    }

    /** 销毁。 */
    destroy() {
        this._unsubscribe?.();
        this._undrag?.();
        this._unresize?.();
        this.shell.removeEventListener('pointerdown', this._blockMobileGeometry, true);
        this._viewportWindow?.removeEventListener?.('resize', this._onViewportChange);
        this._viewportWindow?.removeEventListener?.('orientationchange', this._onViewportChange);
        this._visualViewport?.removeEventListener?.('resize', this._onViewportChange);
        this._visualViewport?.removeEventListener?.('scroll', this._onViewportChange);
        closeProgress();
        this.node.remove();
    }
}

/**
 * 在酒馆的扩展设置区里挂一个入口（抽屉 + 内嵌面板）。
 *
 * 挂载点优先 `#extensions_settings2`，退回 `#extensions_settings`
 * —— 这是本机多个扩展一致的实测做法。
 *
 * @param {import('../app.js').AppController} app
 * @returns {MainPanel|null}
 */
export function mountExtensionSettings(app) {
    const container = document.getElementById('extensions_settings2') || document.getElementById('extensions_settings');
    if (!container) {
        console.warn('[战斗掷骰] 找不到扩展设置挂载点，跳过设置面板');
        return null;
    }
    if (document.getElementById('tavern-dice-settings-block')) return null;

    const panel = new MainPanel(app, {
        embedded: true,
        initialTab: 'settings',
        domId: 'tavern-dice-panel-embedded',
    });
    panel.render();

    const icon = el('div', { class: 'inline-drawer-icon fa-solid fa-circle-chevron-down down' });
    const content = el('div', { class: 'inline-drawer-content', style: { display: 'none' } }, panel.node);
    const header = el('div', { class: 'inline-drawer-toggle inline-drawer-header' }, [
        el('b', {}, '🎲 战斗掷骰'),
        icon,
    ]);
    const block = el('div', { class: 'inline-drawer', id: 'tavern-dice-settings' }, [header, content]);

    on(header, 'click', () => {
        const hidden = content.style.display === 'none';
        content.style.display = hidden ? '' : 'none';
        icon.classList.toggle('down', hidden);
        icon.classList.toggle('closed', !hidden);
        if (hidden) panel.render();
    });

    container.appendChild(block);
    return panel;
}
