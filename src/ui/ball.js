/**
 * 悬浮骰子：根节点本身既是按钮也是拖动把手。
 * 面板的通用拖动器会排除 role=button，因此这里独立处理手势，保留按钮语义。
 */

import { el, toast } from './dom.js';
import { BUILD_STAMP } from '../build.js';
import { diagLog } from './diag.js';

/**
 * @param {{
 *   onClick: () => void,
 *   initialPosition?: {x: number, y: number},
 *   initialSize?: number,
 *   onDestroy?: () => void,
 *   onMove?: (pos: {x: number, y: number}) => void,
 *   getBadge?: () => string,
 *   isOpen?: () => boolean,
 *   describePanel?: () => string,
 * }} opts
 * @returns {{node: HTMLElement, destroy: () => void, setBadge: (text: string) => void, setActive: (active: boolean) => void, setVisible: (visible: boolean) => void, diagnose: () => string}}
 */
export function createFloatBall(opts) {
    const icon = el('img', {
        class: 'td-ball-icon',
        src: new URL('../../assets/float-d20.png', import.meta.url).href,
        alt: '',
        draggable: 'false',
    });
    const node = el('div', {
        class: 'td-ball',
        id: 'tavern-dice-ball',
        role: 'button',
        tabindex: '0',
    }, [icon]);

    const threshold = 4;
    const compatibilityDelay = 800;
    let destroyed = false;
    let active = false;
    let badgeText = opts.getBadge?.() ?? '';
    let position = { x: 24, y: 180 };
    /** @type {null|{kind: string, id: number|undefined, startX: number, startY: number, origin: {x: number, y: number}, moved: boolean, ownsDragClass: boolean}} */
    let gesture = null;
    let ignoreMouseUntil = 0;
    let ignoreTouchUntil = 0;
    let suppressClickUntil = 0;
    let diagnosticTimer = null;
    const listeners = [];
    const tracking = [];

    const listen = (target, type, handler, options, bucket = listeners) => {
        target.addEventListener(type, handler, options);
        bucket.push(() => target.removeEventListener(type, handler, options));
    };
    const clearTracking = () => {
        for (const remove of tracking.splice(0)) remove();
    };
    const clearDiagnostic = () => {
        clearTimeout(diagnosticTimer);
        diagnosticTimer = null;
    };
    const finite = (value, fallback) => Number.isFinite(Number(value)) ? Number(value) : fallback;
    let size = 64;
    const setSize = (value) => {
        if (destroyed) return;
        const n = Number(value);
        size = Number.isFinite(n) ? Math.max(40, Math.min(128, n)) : 64;
        node.style.width = `${size}px`;
        node.style.height = `${size * 1.125}px`;
        place(position.x, position.y);
    };
    const place = (x, y) => {
        // 尚未挂载、暂时隐藏时使用 CSS 的固有尺寸。
        const width = size;
        const height = size * 1.125;
        const maxX = Math.max(0, Math.floor(window.innerWidth - width));
        const maxY = Math.max(0, Math.floor(window.innerHeight - height));
        position = {
            x: Math.min(maxX, Math.max(0, Math.round(finite(x, 24)))),
            y: Math.min(maxY, Math.max(0, Math.round(finite(y, 180)))),
        };
        node.style.right = 'auto';
        node.style.bottom = 'auto';
        node.style.left = `${position.x}px`;
        node.style.top = `${position.y}px`;
    };
    setSize(opts.initialSize);
    place(opts.initialPosition?.x ?? 24, opts.initialPosition?.y ?? 180);

    const updateLabel = () => {
        const label = `战斗掷骰（${active ? '点击收起' : '点击展开，可拖动'}）`;
        const hint = badgeText === '!' ? '有待处理的变化' : badgeText;
        node.title = hint ? `${label}｜${hint}` : label;
        node.setAttribute('aria-label', node.title);
        node.setAttribute('aria-expanded', String(active));
    };
    updateLabel();

    const diagnose = () => {
        const hasPointer = typeof globalThis.PointerEvent === 'function';
        const events = typeof globalThis.__TD_BALL_EVENTS__ === 'string' ? globalThis.__TD_BALL_EVENTS__ : '（无）';
        const panel = opts.describePanel?.() ?? '（拿不到面板状态）';
        return `版本=${BUILD_STAMP}｜事件=${events}｜PointerEvent=${hasPointer ? '支持' : '不支持'}｜${panel}`;
    };

    const fire = (source) => {
        if (destroyed) return;
        clearDiagnostic();
        try {
            const wasOpen = opts.isOpen?.();
            opts.onClick();
            // 只检查一次确实没有成功展开的操作。正常收起、展开后另行关闭都不报警。
            if (destroyed || wasOpen !== false || opts.isOpen?.() !== false) return;
            diagnosticTimer = setTimeout(() => {
                diagnosticTimer = null;
                if (destroyed || opts.isOpen?.() !== false) return;
                diagLog('error', `点了但面板没打开（来源 ${source}）：${diagnose()}`);
                toast('面板没能打开 —— 请按 Alt+Shift+D 复制诊断信息', 'error');
            }, 800);
        } catch (err) {
            console.error('[战斗掷骰] 悬浮球点击出错', err);
            toast(`打开面板失败：${String(/** @type {any} */ (err)?.message ?? err)}`, 'error');
        }
    };

    const move = (point) => {
        if (!gesture) return;
        const dx = finite(point.clientX, gesture.startX) - gesture.startX;
        const dy = finite(point.clientY, gesture.startY) - gesture.startY;
        if (!gesture.moved && Math.max(Math.abs(dx), Math.abs(dy)) <= threshold) return;
        if (!gesture.moved) {
            gesture.moved = true;
            gesture.ownsDragClass = !document.body.classList.contains('td-dragging');
            document.body.classList.add('td-dragging');
            node.classList.add('td-ball-dragging');
        }
        place(gesture.origin.x + dx, gesture.origin.y + dy);
    };

    const finish = (cancelled = false, point = null) => {
        if (!gesture) return;
        if (!cancelled && point) move(point);
        const ended = gesture;
        gesture = null;
        clearTracking();
        if (ended.ownsDragClass) document.body.classList.remove('td-dragging');
        node.classList.remove('td-ball-dragging');
        // 松手即完成一次操作；随后浏览器合成的 mouse/click 不能再次开合。
        suppressClickUntil = Date.now() + compatibilityDelay;
        if (ended.kind !== 'mouse') ignoreMouseUntil = suppressClickUntil;
        if (ended.kind === 'pointer') ignoreTouchUntil = suppressClickUntil;
        if (ended.kind === 'pointer' && ended.id !== undefined) {
            try { node.releasePointerCapture?.(ended.id); } catch { /* 捕获可能已由浏览器释放 */ }
        }
        if (cancelled) {
            place(ended.origin.x, ended.origin.y);
        } else if (ended.moved) {
            if (position.x !== ended.origin.x || position.y !== ended.origin.y) opts.onMove?.({ ...position });
        } else {
            fire(ended.kind);
        }
    };

    const matchesPointer = (e) => gesture?.kind === 'pointer' && e.pointerId === gesture.id;
    const primary = (e) => (e.button === undefined || e.button === 0) && e.isPrimary !== false;
    const pointerMove = (e) => {
        if (!matchesPointer(e) || e.isPrimary === false) return;
        if (e.buttons === 0) return finish(true);
        e.preventDefault();
        move(e);
    };
    const pointerUp = (e) => {
        if (matchesPointer(e) && primary(e)) finish(false, e);
    };
    const pointerCancel = (e) => {
        if (matchesPointer(e)) finish(true);
    };
    const mouseMove = (e) => {
        if (gesture?.kind !== 'mouse') return;
        if (e.buttons === 0) return finish(true);
        e.preventDefault();
        move(e);
    };
    const mouseUp = (e) => {
        if (gesture?.kind === 'mouse' && primary(e)) finish(false, e);
    };
    const changedTouch = (e) => Array.from(e.changedTouches ?? []).find((touch) => touch.identifier === gesture?.id);
    const touchMove = (e) => {
        if (gesture?.kind !== 'touch') return;
        if (e.touches?.length > 1) return finish(true);
        const touch = changedTouch(e);
        if (!touch) return;
        e.preventDefault();
        move(touch);
    };
    const touchEnd = (e) => {
        if (gesture?.kind !== 'touch') return;
        const touch = changedTouch(e);
        if (!touch) return;
        e.preventDefault();
        finish(false, touch);
    };
    const touchCancel = (e) => {
        if (gesture?.kind === 'touch' && (!e.changedTouches?.length || changedTouch(e))) finish(true);
    };

    const begin = (kind, e, point, id) => {
        if (destroyed || gesture || !primary(e)) return;
        if (kind === 'mouse' && Date.now() < ignoreMouseUntil) return;
        if (kind === 'touch' && Date.now() < ignoreTouchUntil) return;
        place(position.x, position.y);
        suppressClickUntil = 0;
        gesture = {
            kind, id,
            startX: finite(point.clientX, 0), startY: finite(point.clientY, 0),
            origin: { ...position }, moved: false, ownsDragClass: false,
        };
        globalThis.__TD_BALL_EVENTS__ = kind;
        if (kind !== 'mouse') ignoreMouseUntil = Date.now() + compatibilityDelay;
        if (kind === 'pointer') ignoreTouchUntil = ignoreMouseUntil;
        const events = kind === 'pointer'
            ? [['pointermove', pointerMove], ['pointerup', pointerUp], ['pointercancel', pointerCancel]]
            : kind === 'mouse'
                ? [['mousemove', mouseMove], ['mouseup', mouseUp]]
                : [['touchmove', touchMove], ['touchend', touchEnd], ['touchcancel', touchCancel]];
        // window 接住指针离开图片后的移动/松手；node 也处理被截断冒泡的宿主事件。
        for (const target of [node, window]) {
            for (const [type, handler] of events) listen(target, type, handler, { passive: false }, tracking);
        }
        if (kind === 'pointer' && id !== undefined) {
            try { node.setPointerCapture?.(id); } catch { /* window 监听仍可完成手势 */ }
        }
        node.focus?.({ preventScroll: true });
        e.preventDefault();
    };
    listen(node, 'pointerdown', (e) => begin('pointer', e, e, e.pointerId));
    listen(node, 'mousedown', (e) => begin('mouse', e, e));
    listen(node, 'touchstart', (e) => {
        if (e.touches?.length !== 1) {
            if (gesture?.kind === 'touch') finish(true);
            return;
        }
        const touch = e.touches[0];
        begin('touch', e, touch, touch.identifier);
    }, { passive: false });
    listen(node, 'lostpointercapture', pointerCancel);
    listen(node, 'dragstart', (e) => e.preventDefault());
    listen(node, 'selectstart', (e) => e.preventDefault());
    listen(node, 'click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (!primary(e) || gesture || Date.now() < suppressClickUntil) return;
        fire('click'); // 辅助技术或仅派发 click 的宿主仍可激活。
    });
    listen(node, 'keydown', (e) => {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        e.preventDefault();
        e.stopPropagation();
        if (e.repeat) return;
        finish(true);
        suppressClickUntil = Date.now() + compatibilityDelay;
        fire('键盘');
    });
    listen(node, 'blur', () => finish(true));
    listen(window, 'blur', () => finish(true));
    listen(window, 'resize', () => {
        finish(true);
        place(position.x, position.y);
    });

    const setBadge = (text) => {
        badgeText = String(text ?? '');
        updateLabel();
    };
    const setActive = (value) => {
        active = Boolean(value);
        if (active) clearDiagnostic();
        node.classList.toggle('td-ball-active', active);
        updateLabel();
    };
    const setVisible = (visible) => {
        if (!visible) finish(true);
        node.style.display = visible ? '' : 'none';
        if (visible) place(position.x, position.y);
    };

    return {
        node, setBadge, setActive, setVisible, setSize, diagnose,
        destroy: () => {
            if (destroyed) return;
            destroyed = true;
            finish(true);
            clearDiagnostic();
            for (const remove of listeners.splice(0)) remove();
            node.remove();
            opts.onDestroy?.();
        },
    };
}
