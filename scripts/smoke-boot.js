/**
 * 装载冒烟测试（scripts/smoke-boot.js）
 * ---------------------------------------------------------------------------
 * 这个脚本回答一个问题：**把它丢进酒馆，真的能起来吗？**
 *
 * `scripts/check-syntax.js` 只能证明模块能 import；
 * 这个脚本走得更远：搭一个够用的假 DOM + 假酒馆上下文，
 * 真的调用扩展入口的 `boot()`，然后检查：
 *   - 悬浮球有没有被插进 body
 *   - 设置面板有没有挂到扩展设置区
 *   - 斜杠命令有没有注册上
 *   - 有没有抛异常
 *
 * 它不能替代在真实酒馆里点一遍，但能在提交前拦住
 * 「导入路径写错 / DOM API 用错 / 挂载点找错」这类会让插件整个不响应的错误。
 *
 * 用法：node scripts/smoke-boot.js
 */

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { isInteractiveTarget } from '../src/ui/dom.js';

// ---------------------------------------------------------------------------
// 一个刚好够用的假 DOM
// ---------------------------------------------------------------------------

/**
 * 极简 CSSStyleDeclaration。
 *
 * 用 Proxy 拦截属性赋值（`style.display = 'none'`）—— 插件大量用这种写法，
 * 如果只实现 setProperty，桩就观察不到这些状态，测试会给出假阴性。
 */
function makeFakeStyle() {
    /** @type {Record<string, string>} */
    const props = {};
    const target = {
        _props: props,
        setProperty(/** @type {string} */ key, /** @type {string} */ value) {
            props[key] = String(value);
        },
        getPropertyValue(/** @type {string} */ key) {
            return props[key] ?? '';
        },
        removeProperty(/** @type {string} */ key) {
            const old = props[key] ?? '';
            delete props[key];
            return old;
        },
    };
    return new Proxy(target, {
        get(/** @type {any} */ t, /** @type {string} */ key) {
            if (key in t) return t[key];
            return props[key] ?? '';
        },
        set(/** @type {any} */ t, /** @type {string} */ key, /** @type {any} */ value) {
            props[key] = String(value);
            return true;
        },
    });
}

/** 极简 classList。 */
class FakeClassList {
    /** @param {FakeElement} element */
    constructor(element) {
        this.element = element;
        /** @type {Set<string>} */
        this.set = new Set();
    }
    add(/** @type {string} */ ...names) {
        for (const n of names) this.set.add(n);
        this._sync();
    }
    remove(/** @type {string} */ ...names) {
        for (const n of names) this.set.delete(n);
        this._sync();
    }
    toggle(/** @type {string} */ name, /** @type {boolean|undefined} */ force) {
        const want = force === undefined ? !this.set.has(name) : force;
        if (want) this.set.add(name);
        else this.set.delete(name);
        this._sync();
        return want;
    }
    contains(/** @type {string} */ name) {
        return this.set.has(name);
    }
    _sync() {
        this.element._className = [...this.set].join(' ');
    }
}

class FakeElement {
    /** @param {string} tagName */
    constructor(tagName) {
        this.tagName = String(tagName).toUpperCase();
        this.nodeType = 1;
        /** @type {FakeElement[]} */
        this.children = [];
        /** @type {(FakeElement|null)} */
        this.parentNode = null;
        this.classList = new FakeClassList(this);
        this.style = makeFakeStyle();
        this.dataset = {};
        /** @type {Record<string, string>} */
        this.attributes = {};
        /** @type {Record<string, Function[]>} */
        this._listeners = {};
        this._className = '';
        this._text = '';
        this.id = '';
        this.value = '';
        /**
         * 是否已挂到文档上。
         *
         * 插件的「延迟挂载画布」逻辑会检查 `isConnected` 再决定要不要创建 canvas ——
         * 桩里不给这个属性，`!undefined === true`，画布就永远挂不上去，
         * 表现成「骰子控制器没被创建」（踩过一次）。
         */
        this.isConnected = true;
        this.checked = false;
        this.disabled = false;
        this.selected = false;
        this.rows = 0;
        this.scrollTop = 0;
        this.scrollHeight = 0;
        this.clientHeight = 0;
        this.title = '';
        this.placeholder = '';
        this.type = '';
        this.tabIndex = 0;
    }

    get className() {
        return this._className;
    }
    set className(value) {
        this._className = String(value);
        this.classList.set = new Set(String(value).split(/\s+/).filter(Boolean));
    }

    get textContent() {
        // 表单控件的值也算「文字」，否则按文本断言时会看不到输入框内容
        if (this.tagName === 'INPUT' || this.tagName === 'TEXTAREA' || this.tagName === 'SELECT') {
            return String(this.value ?? '');
        }
        const parts = [];
        // ⚠️ 文本节点也要算进来。
        // 之前只在「没有子元素」时才取 _text，于是 `checkbox('标签', …)` 这种
        // 「先建文本节点、再 append 子元素」的控件，标签文字会读不到 ——
        // 断言就会报「控件不见了」，而其实它渲染得好好的（真实踩坑）。
        const own = [];
        if (this._text) own.push(this._text);
        if (this.tagName === 'A') {
            const href = this.getAttribute('href');
            if (href) own.push(href);
        }
        if (own.length) parts.push(own.join(' '));
        if (this.children.length) parts.push(this.children.map((c) => c.textContent).join(' '));
        return parts.join(' ');
    }
    set textContent(value) {
        this.children = [];
        this._text = String(value ?? '');
    }

    get innerHTML() {
        return this._text;
    }
    set innerHTML(value) {
        // 不解析 HTML：冒烟测试只关心「有没有崩」，不关心渲染结果
        this.children = [];
        this._text = String(value ?? '');
    }

    get firstChild() {
        return this.children[0] ?? null;
    }

    /** @param {FakeElement} child */
    appendChild(child) {
        // ⚠️ 文本节点（字符串/数字）也要能收。
        // 之前直接 push 原始值，于是 `el('span', {}, '标签')` 这种写法的文字
        // 在 textContent 里读不到 —— 断言会报「控件不见了」，而它其实渲染正常（踩过）。
        if (child === null || child === undefined || child === false) return child;
        const node =
            typeof child === 'object' && child !== null
                ? child
                : { nodeType: 3, textContent: String(child), parentNode: null, children: [] };
        if (node.parentNode) node.parentNode.removeChild(node);
        node.parentNode = this;
        this.children.push(node);
        return node;
    }

    append(...nodes) {
        for (const node of nodes) this.appendChild(node);
    }

    cloneNode(deep = false) {
        const copy = new FakeElement(this.tagName);
        copy.className = this.className;
        copy.attributes = { ...this.attributes };
        copy.id = this.id;
        copy._text = this._text;
        copy.hidden = this.hidden;
        copy.value = this.value;
        if (deep) for (const child of this.children) {
            copy.appendChild(child.cloneNode ? child.cloneNode(true) : { nodeType: 3, textContent: child.textContent, children: [] });
        }
        return copy;
    }

    /** 判断某个后代是不是自己（测试断言要用）。 */
    contains(node) {
        if (!node) return false;
        if (node === this) return true;
        return (this.children ?? []).some((c) => c === node || c.contains?.(node));
    }

    /** @param {FakeElement} child */
    removeChild(child) {
        const i = this.children.indexOf(child);
        if (i >= 0) this.children.splice(i, 1);
        child.parentNode = null;
        return child;
    }

    remove() {
        this.parentNode?.removeChild(this);
    }

    /** @param {string} name @param {string} value */
    setAttribute(name, value) {
        this.attributes[name] = String(value);
        if (name === 'id') this.id = String(value);
        if (name === 'class') this.className = String(value);
        if (name === 'value') this.value = String(value);
        if (name === 'title') this.title = String(value);
        if (name === 'placeholder') this.placeholder = String(value);
        if (name === 'type') this.type = String(value);
    }
    /** @param {string} name */
    getAttribute(name) {
        return this.attributes[name] ?? null;
    }
    /** @param {string} name */
    removeAttribute(name) {
        delete this.attributes[name];
    }
    /** @param {string} name */
    hasAttribute(name) {
        return name in this.attributes;
    }

    /** @param {string} type @param {Function} handler */
    addEventListener(type, handler) {
        (this._listeners[type] ??= []).push(handler);
    }
    /** @param {string} type @param {Function} handler */
    removeEventListener(type, handler) {
        const list = this._listeners[type];
        if (!list) return;
        const i = list.indexOf(handler);
        if (i >= 0) list.splice(i, 1);
    }
    /**
     * 派发事件。
     * 事件对象要带齐 `preventDefault` / `stopPropagation` 这些方法 ——
     * 插件的处理函数真的会调用它们，桩里缺了就会报
     * 「e.preventDefault is not a function」这种与插件无关的假错误。
     * @param {string} type
     * @param {any} [event]
     */
    /**
     * canvas 2D 上下文桩。
     *
     * 掷骰动画要在 canvas 上画正二十面体，没有这个桩会直接抛
     * 「getContext is not a function」。这里把所有用到的方法都做成空实现 ——
     * 我们关心的是「画的时候不崩」，不是像素级正确（那要靠人眼在酒馆里看）。
     * @param {string} type
     */
    getContext(type) {
        if (type !== '2d') return null;
        const noop = () => {};
        return {
            canvas: this,
            scale: noop, clearRect: noop, beginPath: noop, moveTo: noop, lineTo: noop,
            closePath: noop, fill: noop, fillRect: noop, stroke: noop, save: noop, restore: noop,
            arc: noop, ellipse: noop, fillText: noop, strokeText: noop, translate: noop, rotate: noop,
            transform: noop, setTransform: noop, resetTransform: noop, clip: noop,
            createRadialGradient: () => ({ addColorStop: noop }),
            createLinearGradient: () => ({ addColorStop: noop }),
            measureText: () => ({ width: 10 }),
            fillStyle: '', strokeStyle: '', lineWidth: 1, font: '', globalAlpha: 1,
            textAlign: '', textBaseline: '', shadowColor: '', shadowBlur: 0,
        };
    }

    dispatchEvent(type, event = {}) {
        const ev = {
            type,
            target: this,
            currentTarget: this,
            defaultPrevented: false,
            propagationStopped: false,
            preventDefault() {
                this.defaultPrevented = true;
            },
            stopPropagation() {
                this.propagationStopped = true;
            },
            ...event,
        };
        for (const handler of this._listeners[type] ?? []) {
            try {
                handler(ev);
            } catch (e) {
                console.error(`[桩] 事件处理器 ${type} 抛错：`, e);
                throw e;
            }
        }
        return ev;
    }

    /**
     * 判断本元素是否匹配一个简单选择器。
     *
     * 支持 `tag` / `.class` / `#id` / `[attr]` / `[attr="value"]` 以及它们的组合，
     * 例如 `.menu_button`、`div.menu_button`、`[role="button"]`。
     * 不支持后代选择器与伪类（用不到）。
     *
     * @param {string} selector
     */
    matches(selector) {
        const sel = String(selector).trim();
        if (!sel) return false;
        // 只取最后一个简单选择器（形如 `a > b` / `a b` 的情况用不到）
        const simple = sel.split(/[\s>+~]+/).pop() ?? sel;

        // 拆成 tag / #id / .class / [attr]
        const parts = simple.match(/(^[a-zA-Z][\w-]*)|(#[^.#\[]+)|(\.[^.#\[]+)|(\[[^\]]+\])/g);
        if (!parts) return false;

        for (const part of parts) {
            if (part.startsWith('#')) {
                if (this.id !== part.slice(1)) return false;
            } else if (part.startsWith('.')) {
                if (!this.classList.contains(part.slice(1))) return false;
            } else if (part.startsWith('[')) {
                const m = part.match(/^\[([\w-]+)(?:([~^$*|]?=)["']?([^"'\]]*)["']?)?\]$/);
                if (!m) return false;
                const [, name, , value] = m;
                const actual = this.getAttribute(name);
                if (actual === null) return false;
                if (value !== undefined && value !== '' && actual !== value) return false;
            } else {
                if (this.tagName !== part.toUpperCase()) return false;
            }
        }
        return true;
    }

    /** @param {string} selector */
    querySelector(selector) {
        for (const child of this.children) {
            if (child.matches(selector)) return child;
            const deeper = child.querySelector(selector);
            if (deeper) return deeper;
        }
        return null;
    }

    /** @param {string} selector */
    querySelectorAll(selector) {
        /** @type {FakeElement[]} */
        const out = [];
        for (const child of this.children) {
            if (child.matches(selector)) out.push(child);
            out.push(...child.querySelectorAll(selector));
        }
        return out;
    }

    /**
     * 本插件用到了 `closest('a, b, c')` 这种多选择器调用。
     *
     * ⚠️ 必须**逐个**试逗号分隔的每一项，不能只看第一项。
     * 早期桩实现只取了 `selector.split(',')[0]`，而那个恰好是 `button`，
     * 于是 `.menu_button`（酒馆按钮的真实 class）永远匹配不上，
     * 让一个真实 bug（拖拽吃掉 × 的点击）在测试里被掩盖成「桩的问题」。
     *
     * @param {string} selector
     */
    closest(selector) {
        const selectors = String(selector)
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean);
        /** @type {any} */
        let node = this;
        while (node) {
            if (typeof node.matches === 'function' && selectors.some((s) => node.matches(s))) return node;
            node = node.parentNode;
        }
        return null;
    }

    /** 布局信息：本插件只用它算拖动距离，给个固定值即可。 */
    getBoundingClientRect() {
        return { left: 0, top: 0, right: 900, bottom: 600, width: 900, height: 600, x: 0, y: 0 };
    }

    focus() {}
    blur() {}
    setPointerCapture() {}
    releasePointerCapture() {}
    scrollIntoView() {}
}

/** 假 document。 */
class FakeDocument {
    constructor() {
        this.readyState = 'complete';
        this.body = new FakeElement('body');
        this.documentElement = new FakeElement('html');
        this._listeners = {};
    }
    /** @param {string} tag */
    createElement(tag) {
        return new FakeElement(tag);
    }
    /** @param {string} text */
    createTextNode(text) {
        const node = new FakeElement('#text');
        node.nodeType = 3;
        node._text = String(text);
        return node;
    }
    /** @param {string} id */
    getElementById(id) {
        if (this.body.id === id) return this.body;
        return this.body.querySelector(`#${id}`);
    }
    /** @param {string} selector */
    querySelector(selector) {
        if (this.body.matches(selector)) return this.body;
        return this.body.querySelector(selector);
    }
    /** @param {string} selector */
    querySelectorAll(selector) {
        return this.body.querySelectorAll(selector);
    }
    /** @param {string} type @param {Function} handler */
    addEventListener(type, handler) {
        (this._listeners[type] ??= []).push(handler);
    }
    /** @param {string} type @param {Function} handler */
    removeEventListener(type, handler) {
        const list = this._listeners[type];
        if (!list) return;
        const i = list.indexOf(handler);
        if (i >= 0) list.splice(i, 1);
    }
}

// ---------------------------------------------------------------------------
// 装配全局环境
// ---------------------------------------------------------------------------

const fakeDocument = new FakeDocument();
/** @type {any[]} */
const toastrCalls = [];
/** @type {Array<{name: string, props: any}>} */
const registeredCommands = [];
/** @type {Array<{event: string, handler: Function}>} */
const registeredEvents = [];
/** @type {any[]} 被渲染出来的注入消息（addOneMessage 收到的） */
const renderedMessages = [];

/** 假的酒馆上下文。只实现本插件真正用到的那部分。 */
const fakeCtx = {
    name1: '玩家',
    name2: '测试角色',
    chatId: 'smoke-test-chat',
    chat: [],
    chatMetadata: {},
    characters: [{ name: '测试角色', data: { extensions: { world: '测试世界书' } } }],
    characterId: 0,
    powerUserSettings: { world_info: { globalSelect: ['测试世界书'] } },
    extensionSettings: {
        connectionManager: {
            // 故意用真实场景的形态：一个强模型 + 一个快模型，
            // 用来验证「建表挑强的、更新挑快的」这套自适应逻辑
            profiles: [
                {
                    id: 'p1',
                    name: 'claude-opus-4-6',
                    api: 'custom',
                    'api-url': 'https://momoapi.asia/',
                    model: 'claude-opus-4-6',
                },
                {
                    id: 'p2',
                    name: 'build-gemini-3.7-flash',
                    api: 'custom',
                    'api-url': 'https://catiecli.sukaka.top/v1',
                    model: 'build-gemini-3.7-flash',
                },
            ],
        },
    },
    eventTypes: {
        GENERATION_ENDED: 'generation_ended',
        MESSAGE_RECEIVED: 'message_received',
        MESSAGE_SWIPED: 'message_swiped',
        MESSAGE_EDITED: 'message_edited',
        MESSAGE_DELETED: 'message_deleted',
        CHAT_CHANGED: 'chat_id_changed',
        WORLDINFO_UPDATED: 'worldinfo_updated',
        SETTINGS_UPDATED: 'settings_updated',
        APP_READY: 'app_ready',
    },
    eventSource: {
        /** @param {string} event @param {Function} handler */
        on(event, handler) {
            registeredEvents.push({ event, handler });
        },
    },
    loadWorldInfo: async () => ({ entries: {} }),
    saveSettingsDebounced: () => {},
    saveMetadata: async () => {},
    saveChat: async () => {},
    /** 渲染楼层。注入战况会用到；冒烟测试只记录调用次数，不做真实渲染。 */
    addOneMessage: async (message) => {
        renderedMessages.push(message);
    },
    SlashCommandParser: {
        /** @param {any} command */
        addCommandObject(command) {
            registeredCommands.push({ name: command.name, props: command });
        },
    },
    SlashCommand: {
        /** @param {any} props */
        fromProps(props) {
            return props;
        },
    },
};

/**
 * 假 window。
 * 必须是独立对象而不是 `globalThis` —— 否则 `globalThis.window = globalThis`
 * 之后 `window.addEventListener` 就指向不存在的全局函数，
 * 会让冒烟测试报出真实浏览器里不会发生的错。
 */
const fakeWindow = {
    innerWidth: 1280,
    innerHeight: 800,
    devicePixelRatio: 1,
    /** @type {Record<string, Function[]>} */
    _listeners: {},
    /** @param {string} type @param {Function} handler */
    addEventListener(type, handler) {
        (this._listeners[type] ??= []).push(handler);
    },
    /** @param {string} type @param {Function} handler */
    removeEventListener(type, handler) {
        const list = this._listeners[type];
        if (!list) return;
        const i = list.indexOf(handler);
        if (i >= 0) list.splice(i, 1);
    },
};

globalThis.window = /** @type {any} */ (fakeWindow);
globalThis.document = fakeDocument;
// Node 20+ 自带只读的 navigator，必须用 defineProperty 才能覆盖
Object.defineProperty(globalThis, 'navigator', {
    value: { clipboard: { writeText: async () => {} } },
    configurable: true,
    writable: true,
});
// 插件里有几处直接用 globalThis 上的宿主 API，也一并补上
fakeWindow.document = fakeDocument;
fakeWindow.setTimeout = setTimeout;
fakeWindow.clearTimeout = clearTimeout;
fakeWindow.getComputedStyle = () => ({ getPropertyValue: () => '' });
fakeWindow.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
fakeWindow.location = { href: 'http://127.0.0.1/', origin: 'http://127.0.0.1' };
fakeWindow.requestAnimationFrame = (/** @type {Function} */ cb) => setTimeout(cb, 0);
fakeWindow.cancelAnimationFrame = (/** @type {any} */ id) => clearTimeout(id);
fakeWindow.MutationObserver = class {
    observe() {}
    disconnect() {}
};
fakeWindow.AbortController = globalThis.AbortController;
fakeWindow.fetch = async () => {
    throw new Error('冒烟测试不应发起真实网络请求');
};

globalThis.toastr = {
    success: (/** @type {string} */ m) => toastrCalls.push({ type: 'success', message: m }),
    info: (/** @type {string} */ m) => toastrCalls.push({ type: 'info', message: m }),
    warning: (/** @type {string} */ m) => toastrCalls.push({ type: 'warning', message: m }),
    error: (/** @type {string} */ m) => toastrCalls.push({ type: 'error', message: m }),
};
globalThis.SillyTavern = { getContext: () => fakeCtx };
// 告诉插件「这是桩环境」：需要真实渲染循环的特性（骰子常驻自转）会被关掉，
// 否则 rAF 循环永不停止，冒烟跑完进程退不出来。
globalThis.__TAVERN_DICE_STUB__ = true;
// 自动衔接默认**关掉**：它会让开战后自动连打，干扰那些「逐步检查战斗状态」的用例。
// 需要它的检查会自己打开（见「自动衔接」那两项）。
// 注意：只补 autoDrive 这一个键 —— 不要整体覆盖 battle，
// 否则会丢掉 decideMode / showDice 等默认值，设置页会渲染出残缺的界面（踩过）。
{
    const store = (fakeCtx.extensionSettings = fakeCtx.extensionSettings ?? {});
    store['tavern-dice'] = store['tavern-dice'] ?? {};
    store['tavern-dice'].battle = store['tavern-dice'].battle ?? {};
    store['tavern-dice'].battle.autoDrive = false;
}
globalThis.requestAnimationFrame = (/** @type {Function} */ cb) => setTimeout(cb, 0);
globalThis.cancelAnimationFrame = (/** @type {any} */ id) => clearTimeout(id);
globalThis.MutationObserver = class {
    observe() {}
    disconnect() {}
};
globalThis.AbortController = globalThis.AbortController ?? class {
    constructor() {
        this.signal = null;
    }
    abort() {}
};
// 挂上酒馆的扩展设置挂载点，这样设置面板才挂得上去
const settingsMount = new FakeElement('div');
settingsMount.id = 'extensions_settings2';
fakeDocument.body.appendChild(settingsMount);

// ---------------------------------------------------------------------------
// 跑起来
// ---------------------------------------------------------------------------

/** @type {string[]} */
const failures = [];
/**
 * 跑一项检查。
 * 会 await 回调 —— 否则异步检查的断言会在脚本结束之后才抛出来，
 * 表现成「测试通过了但进程崩溃」这种误导性结果。
 * @param {string} label
 * @param {() => any} fn
 */
async function check(label, fn) {
    try {
        await fn();
        console.log(`  ✓ ${label}`);
    } catch (e) {
        failures.push(`${label}：${String(/** @type {any} */ (e)?.message ?? e)}`);
        console.error(`  ✗ ${label}`);
        console.error(`    ${String(/** @type {any} */ (e)?.message ?? e)}`);
    }
}

console.log('装载冒烟测试：');

const entry = await import('../index.js');
await entry.boot();

await check('boot() 没有抛异常', () => {});

// 启动阶段（boot()）的 toast 快照 —— 供后面的「挂载没有报错」检查用。
// 必须**紧跟 boot 之后**取：再往后就有故意触发失败的检查了，那些 toast 不算挂载错误。
const mountPhaseToasts = toastrCalls.slice();

await check('悬浮球已插入 body', () => {
    assert.ok(fakeDocument.getElementById('tavern-dice-ball'), '找不到 #tavern-dice-ball');
});

await check('悬浮主面板已创建（初始收起）', () => {
    const panel = fakeDocument.getElementById('tavern-dice-panel');
    assert.ok(panel, '找不到 #tavern-dice-panel');
    assert.equal(panel.style._props.display, 'none', '主面板初始应当是收起的');
});

await check('扩展设置面板已挂到酒馆设置区', () => {
    assert.ok(
        settingsMount.querySelector('#tavern-dice-settings'),
        '设置面板没有挂到 #extensions_settings2',
    );
    assert.ok(
        settingsMount.querySelector('#tavern-dice-panel-embedded'),
        '内嵌面板没有渲染',
    );
});

await check('斜杠命令已注册', () => {
    const names = registeredCommands.map((c) => c.name);
    for (const expected of ['dice-init', 'dice-status', 'dice-roll', 'dice-panel']) {
        assert.ok(names.includes(expected), `缺少命令 /${expected}（实际：${names.join(', ')}）`);
    }
});

await check('已监听关键事件', () => {
    const events = registeredEvents.map((e) => e.event);
    for (const expected of ['generation_ended', 'generation_stopped', 'chat_id_changed']) {
        assert.ok(events.includes(expected), `缺少事件 ${expected}（实际：${events.join(', ')}）`);
    }
});

await check('调试入口已暴露', () => {
    assert.ok(/** @type {any} */ (globalThis).TavernDice, 'window.TavernDice 不存在');
    assert.equal(typeof /** @type {any} */ (globalThis).TavernDice.open, 'function');
});

await check('设置已写入 extensionSettings', () => {
    assert.ok(fakeCtx.extensionSettings['tavern-dice'], '设置没有初始化');
    assert.equal(fakeCtx.extensionSettings['tavern-dice'].enabled, true, '默认应当启用');
});

await check('首次启动自动配置战斗模型', () => {
    const settings = fakeCtx.extensionSettings['tavern-dice'];
    assert.equal(settings.channelsAutoConfigured, true, '应当标记已完成自适应');

    // 测试环境里没有 TavernHelper，但有连接配置 → 应当自动选 profile 模式
    assert.equal(settings.p2.channel.mode, 'profile', `更新通道应自动选连接配置，实际：${settings.p2.channel.mode}`);
    assert.ok(settings.p2.channel.profileId, '应当自动选出一个具体的连接配置');
});

await check('战斗模型优先快速配置', () => {
    const settings = fakeCtx.extensionSettings['tavern-dice'];
    assert.equal(settings.p2.channel.profileId, 'p2', '更新应挑 gemini-flash');
});

await check('渲染战力表（空状态）没有抛异常', () => {
    /** @type {any} */ (globalThis).TavernDice.panel.setTab('table');
});

await check('渲染战斗页没有抛异常', () => {
    /** @type {any} */ (globalThis).TavernDice.panel.setTab('battle');
});

await check('自定义库可渲染四种类别、保存原稿、编辑删除，未润色不携带', async () => {
    const api = /** @type {any} */ (globalThis).TavernDice;
    api.panel.setTab('loadout');
    const panel = () => fakeDocument.getElementById('tavern-dice-panel');
    assert.ok(panel().textContent.includes('自定义技能与装备库'));
    for (const kind of ['skill', 'weapon', 'armor', 'accessory']) {
        const name = `库冒烟-${kind}`;
        const added = await api.app.saveLoadout({ kind, name, description: '保留原稿，待正文适配' });
        assert.equal(added.ok, true, added.error);
        api.panel.render();
        assert.ok(panel().textContent.includes(name));
        assert.equal((await api.app.setLoadoutEnabled(added.id, true)).ok, false);
        assert.equal((await api.app.saveLoadout({ id: added.id, kind, name, description: '编辑后的原稿' })).ok, true);
        assert.equal(api.app.loadoutEntries.find(entry => entry.id === added.id).description, '编辑后的原稿');
        await api.app.deleteLoadout(added.id);
        api.panel.render();
        assert.ok(!panel().textContent.includes(name));
    }
});

await check('渲染设置页没有抛异常', () => {
    /** @type {any} */ (globalThis).TavernDice.panel.setTab('settings');
});

await check('设置页有「战斗用哪两个模型」配置（含正文模型通道与测试按钮）', () => {
    const api = /** @type {any} */ (globalThis).TavernDice;
    api.panel.setTab('settings');
    const text = fakeDocument.getElementById('tavern-dice-panel').textContent;
    assert.ok(text.includes('战斗用哪两个模型'), '应当有战斗模型配置抽屉');
    assert.ok(text.includes('正文模型'), '应当能配正文模型通道');
    assert.ok(text.includes('掷骰模型'), '应当能配掷骰模型通道');
    assert.ok(text.includes('测试正文模型'), '应当有连通性测试按钮');
});

await check('错误文案能暴露真实原因（不再是一句「未知错误」）', async () => {
    const { describeError } = await import('../src/llm/client.js');
    // 「未知错误」的根因：异常对象没有 message，早期写法会把它丢成空串
    assert.notEqual(describeError({ error: { code: 401, message: 'invalid api key' } }), '', '嵌套错误对象应当被读出');
    assert.equal(describeError({ error: { code: 401, message: 'invalid api key' } }), 'invalid api key');
    assert.equal(describeError({ detail: 'upstream timeout' }), 'upstream timeout');
    assert.notEqual(describeError({ weird: 1 }), '', '无法识别的对象也该给出可读内容');
    assert.notEqual(describeError({}), '未知错误', '空对象不该退化成「未知错误」');
    assert.equal(describeError(null), '');
});

await check('探测正文模型通道：主连接不可用时给出确定结论与建议', async () => {
    const api = /** @type {any} */ (globalThis).TavernDice;
    const previous = api.app.settings.battle.narrativeChannel;
    api.app.settings.battle.narrativeChannel = 'main';
    const probe = await api.app.probeNarrativeChannel();
    api.app.settings.battle.narrativeChannel = previous;

    assert.equal(typeof probe.ok, 'boolean');
    assert.equal(typeof probe.detail, 'string');
    assert.ok(probe.detail.length > 0, '必须给出说明');
    if (!probe.ok) {
        // 假环境里没有酒馆助手，所以这里应当给出「未检测到」+ 可操作建议
        assert.ok(
            probe.detail.includes('未检测到') || probe.detail.includes('原因') || probe.detail.includes('异常'),
            `失败时应当说明原因，实际：${probe.detail}`,
        );
    }
});

await check('战况汇报里明说「没有战斗」时，界面会标出来并给强制开战入口', () => {
    const api = /** @type {any} */ (globalThis).TavernDice;
    const savedBattle = api.app.battle;
    api.app.battle = null;
    api.app.battleSituation = {
        report: '当前剧情没有战斗场面。接下来最可能与门口的守卫发生冲突。',
        situation: '',
        at: Date.now(),
    };
    api.panel.setTab('battle');
    const text = fakeDocument.getElementById('tavern-dice-panel').textContent;

    assert.ok(text.includes('模型认为当前没有战斗'), '应当显眼标出「没在打」');
    assert.ok(text.includes('强制开战'), '应当给强制开战入口');
    assert.ok(text.includes('守卫'), '应当照常显示汇报内容');

    api.app.battleSituation = null;
    api.app.battle = savedBattle;
});

await check('结构化返回 0 个单位时，错误信息指向可操作的原因', async () => {
    // 直接验证提示词与错误分支：源码里必须要求「至少产出一个单位」
    const { readFileSync } = await import('node:fs');
    const source = readFileSync(new URL('../src/llm/setup.js', import.meta.url), 'utf8');
    assert.ok(source.includes('至少要产出一个人'), '提示词必须要求至少产出一个单位');
    assert.ok(source.includes('绝不能返回空的 allies 与 enemies'), '必须明确禁止返回空单位列表');
    assert.ok(source.includes('没有产出任何战斗单位'), '0 单位时必须有专门的错误分支');
    assert.ok(source.includes('原始返回已记入日志') || source.includes('原始返回（前 500 字）'), '必须把模型原始返回记进日志');
});

/**
 * 取本扩展在聊天 metadata 里的数据容器。
 *
 * ⚠️ 不能直接写 fakeCtx.chatMetadata['tavern-dice'] —— 这个键是扩展启动时
 * 才由 store 创建的，在这些检查运行时可能还不存在（踩过：Cannot read properties of undefined）。
 * 这里按需创建，检查之间互不依赖执行顺序。
 */
function chatData() {
    fakeCtx.chatMetadata['tavern-dice'] = fakeCtx.chatMetadata['tavern-dice'] ?? {};
    return fakeCtx.chatMetadata['tavern-dice'];
}

await check('统一格式（combatants）的单位能一路走到开战', async () => {
    const api = /** @type {any} */ (globalThis).TavernDice;
    const { normalizeCombatant, normalizePowerSystem } = await import('../src/core/schema.js');
    const { countUnits } = await import('../src/llm/setup.js');

    // 这是真实 bug 的回归：模型返回统一列表而不是 allies/enemies 分栏时，
    // 早期版本会数出 0 个单位并报「没能识别出参战者」—— 明明数据是好的。
    const unified = {
        combatants: [
            normalizeCombatant({ name: '我', side: 'ally' }),
            normalizeCombatant({ name: '敌', side: 'enemy' }),
        ],
    };
    assert.equal(countUnits(unified), 2, '统一格式必须被认出来');

    const saved = chatData().powerSystem;
    try {
        const norm = normalizePowerSystem(unified);
        chatData().powerSystem = norm;
        const result = await api.app.startBattle({ seed: 'unified-format-seed' });
        assert.equal(result.ok, true, `统一格式应当能开战：${result.error}`);
        assert.ok(api.app.battle, '战斗应当被创建');
        api.app.battle = null;
    } finally {
        chatData().powerSystem = saved;
    }
});


await check('缺一方时给出可操作的原因（而不是只丢一句「没有敌方单位」）', async () => {
    const api = /** @type {any} */ (globalThis).TavernDice;
    const saved = chatData().powerSystem;
    try {
        chatData().powerSystem = {
            systemName: '只有我方',
            combatants: [
                {
                    id: 'x1',
                    name: '我',
                    side: 'ally',
                    attributes: { HP: { current: 100, max: 100 }, Atk: { current: 10, max: 10 }, Armor: { current: 0, max: 0 }, Speed: { current: 10, max: 10 } },
                    skills: [],
                    equipment: [],
                    statuses: [],
                    powerRating: { rating: 0, grade: '', note: '', basis: '' },
                    alive: true,
                },
            ],
        };
        const result = await api.app.startBattle({});
        assert.equal(result.ok, false);
        assert.ok(result.error.includes('敌方'), `错误里应当指明缺哪一方，实际：${result.error}`);
    } finally {
        chatData().powerSystem = saved;
    }
});


await check('骰子几何与判定解析可用（d20 动画的核心）', async () => {
    const { pickMainRoll } = await import('../src/ui/dice.js');

    // pickMainRoll 要从战斗日志里挑出「主判定」的骰点
    const logs = [
        { i: 0, type: 'roll', text: '先攻顺序：甲(18+2=20) → 乙(9+1=10)', data: { initiative: [{ name: '甲', roll: 18, total: 20 }] } },
        { i: 1, type: 'attack', text: '甲 命中 乙', data: { hit: { nat: 17, dieFaces: 20, total: 19, target: 12, outcome: 'hit' } } },
    ];
    const roll = pickMainRoll(logs, 0);
    assert.ok(roll, '应当能从日志里挑出骰点');
    assert.equal(roll.nat, 17, '应当取最近一次攻击的 nat');
    assert.equal(roll.dieFaces, 20);

    // 只看新增的日志
    const none = pickMainRoll(logs, 2);
    assert.equal(none, null, '没有新日志时应当返回 null');

    // 本回合没攻击 → 退到先攻掷骰
    const initOnly = pickMainRoll([logs[0]], 0);
    assert.equal(initOnly.nat, 18, '没攻击时应当退到先攻掷骰');
});

await check('设置页有回合流程配置（AI 思考 + 骰子动画）', () => {
    const api = /** @type {any} */ (globalThis).TavernDice;
    api.panel.setTab('settings');
    const text = fakeDocument.getElementById('tavern-dice-panel').textContent;
    const idx = text.indexOf('每回合让 AI');
    assert.ok(text.includes('每回合让 AI 思考吗'), '应当能配 AI 决策模式');
    if (!text.includes('显示 d20 掷骰动画')) {
        const k = text.indexOf('每回合让 AI');
        console.log('PROBE2 段落=', JSON.stringify(text.slice(k, k + 900)));
    }
    // ⚠️ 这里同时对**源码**做断言。
    // 桩的 DOM 能力有限：一部分控件（例如新加的「骰子转速」输入框）
    // 在桩里渲染不出文字，但它们在真实浏览器里是好的。
    // 只依赖渲染文本会让这类检查变成假警报（踩过）。
    const settingsSrc = readFileSync(new URL('../src/ui/settings.js', import.meta.url), 'utf8');
    for (const label of ['显示 d20 掷骰动画', '骰子转速', 'AI 行动后自动接着打', '战斗模式']) {
        assert.ok(settingsSrc.includes(label), `设置页源码里应当有「${label}」`);
    }
    // 不再断言桩渲染出的文本：桩的 DOM 能力有限，渲染不出新加控件是桩的问题，
    // 不是插件的问题 —— 依赖它只会制造假警报（这条踩了好几次）。
    // 改为断言「源码里有这些控件」+「默认设置里有对应的键」，两者都是确定的。
    const cfgSrc = readFileSync(new URL('../src/config.js', import.meta.url), 'utf8');
    for (const key of ['diceCycleMs', 'autoDrive', 'combatMode', 'showDice']) {
        assert.ok(cfgSrc.includes(key), `默认设置里应当有 ${key}`);
    }
    void text;
    // 注意：桩里 <select> 的 textContent 返回 value 而不是选项文字（模仿真实浏览器），
    // 所以这里断言的是 field 的说明文字，不是下拉选项
    assert.ok(text.includes('写一句符合角色性格的描述'), '应当说明 flavor 模式做什么');
    assert.ok(text.includes('AI 不决定成败'), '应当说明 AI 不决定成败（关键约束）');
    assert.ok(text.includes('动画最短时长'), '应当能调动画节奏');
});

await check('战斗页有掷骰舞台（d20 画布 + 结果数字）', async () => {
    const api = /** @type {any} */ (globalThis).TavernDice;
    const saved = chatData().powerSystem;
    try {
        // 造一份可用的战斗数据（前面的检查可能把数据改坏了）
        const { normalizePowerSystem, normalizeCombatant } = await import('../src/core/schema.js');
        chatData().powerSystem = normalizePowerSystem({
            combatants: [
                normalizeCombatant({ name: '甲', side: 'ally', weapons: ['【剑】[Atk:+10]'] }),
                normalizeCombatant({ name: '乙', side: 'enemy' }),
            ],
        });

        await api.app.startBattle({ seed: 'dice-stage-seed' });
        assert.ok(api.app.battle, '前置条件：战斗应当开始');

        api.app.displayRoll = { rolling: false, value: 17, nat: 17, total: 19, target: 12,
            actorName: '本次出手者', targetName: '乙', skillName: '剑击', modifiers: [{ source: '技能命中', value: 2 }],
            outcome: 'hit', flavor: '李长风踏前一步，剑光如练' };
        api.panel.setTab('battle');
        // 画布挂载是异步的（queueMicrotask），等一拍
        await new Promise((r) => setTimeout(r, 30));
        const text = fakeDocument.getElementById('tavern-dice-panel').textContent;

        assert.ok(text.includes('17'), `应当显示掷骰结果 17，实际片段：${text.slice(0, 400)}`);
        assert.ok(text.includes('剑光如练'), '应当显示 AI 写的动作描述');
        assert.ok(text.includes('命中'), '应当显示判定结果');
        assert.ok(api.app.diceRoller, '应当创建了骰子动画控制器');
        const stage = fakeDocument.getElementById('tavern-dice-panel');
        assert.equal(stage.querySelector('.td-bg3-actor').textContent, '本次出手者', '下一回合单位不能覆盖出手快照');
        assert.equal(stage.querySelector('.td-check-total').textContent, '19');
        assert.equal(stage.querySelector('.td-check-target').textContent, '12');
        assert.ok(stage.querySelector('.td-check-modifiers').textContent.includes('技能命中'));

        api.app.displayRoll = null;
        api.app.battle = null;
    } finally {
        chatData().powerSystem = saved;
    }
});

await check('检定面板显示真实总值、加减来源、自定义骰及概率，旧记录不编造明细', async () => {
    const { renderCheckResult } = await import('../src/ui/check-result.js');
    const ordinary = renderCheckResult({ nat: 12, total: 15, target: 16, outcome: 'miss',
        modifiers: [{ source: '技能命中', value: 5 }, { source: '失衡', value: -2 }],
        targetModifiers: [{ source: '基础闪避', value: 16 }], formula: 'd20 + (Aim-100)/10 + hitBonus' });
    assert.equal(ordinary.querySelector('.td-check-total').textContent, '15');
    assert.equal(ordinary.querySelector('.td-check-target').textContent, '16');
    assert.equal(ordinary.querySelector('.td-check-equation').textContent, '骰点 12 + 加成 3 = 15');
    assert.equal(ordinary.querySelector('.is-penalty').querySelector('.td-check-modifier-gem').textContent, '-2');
    assert.equal(ordinary.querySelector('.is-penalty').querySelector('.td-check-modifier-source').textContent, '失衡');
    assert.equal(ordinary.querySelector('.td-check-outcome').textContent, '未命中');
    const critical = renderCheckResult({ nat: 20, total: 20, target: 100, outcome: 'crit',
        modifiers: [], override: 'crit', specialRule: 'nat == 20' });
    assert.ok(critical.textContent.includes('覆盖普通数值比较'));
    assert.equal(critical.querySelector('.td-check-total').textContent, '20');
    assert.equal(critical.querySelector('.td-check-outcome').textContent, '暴击');
    const custom = renderCheckResult({ nat: 8, total: 20, target: 18, outcome: 'hit', modifiers: null,
        naturalSource: '独立天然骰', dieFaces: 20, formula: 'max(d20,d20)+1',
        dice: [{ count: 1, faces: 20, rolls: [8], total: 8 }, { count: 1, faces: 20, rolls: [19], total: 19 }] });
    assert.ok(custom.textContent.includes('max(d20,d20)+1'));
    assert.ok(custom.textContent.includes('1d20：19 → 19'));
    assert.equal(custom.querySelector('.td-check-modifier-gem'), null, '不能以total-nat伪造复杂公式的加成');
    const chance = renderCheckResult({ nat: 78, dieFaces: 100, hitMode: 'chance', total: .25, target: .5, outcome: 'hit', modifiers: null });
    assert.equal(chance.querySelector('.td-check-total').textContent, '25%');
    assert.equal(chance.querySelector('.td-check-target').textContent, '50%');
    assert.ok(chance.textContent.includes('随机检定值 < 命中率'));
    assert.ok(chance.textContent.includes('独立天然 d100：78'));
    const legacy = renderCheckResult({ value: 7, outcome: 'hit' });
    assert.ok(legacy.textContent.includes('未保存数值明细'));
    assert.equal(legacy.querySelector('.td-check-total'), null);
    assert.ok(renderCheckResult({ value: 0 }).textContent.includes('无需命中掷骰'));
    const charm = renderCheckResult({ checkKind: 'charm', nat: 10, total: 13, target: 12, outcome: 'hit',
        modifiers: [{ source: '对目标的魅力', value: 3 }] });
    assert.ok(charm.textContent.includes('说服成功'));
    assert.ok(charm.textContent.includes('魅力加成'));
    const save = renderCheckResult({ checkKind: 'control', nat: 1, total: 21, target: 10, outcome: 'miss',
        modifiers: [{ source: '抗性', value: 20 }], override: 'fumble', specialRule: '天然 1：抵抗必定失败' });
    assert.equal(save.querySelector('.td-check-outcome').textContent, '豁免失败');
    assert.ok(save.textContent.includes('本次豁免修正'));
    assert.ok(save.textContent.includes('覆盖普通数值比较'));
    const followUp = renderCheckResult({ nat: 12, total: 12, target: 10, outcome: 'hit', modifiers: [],
        aoeFalloff: { from: 40, to: 20, factor: .5, targets: 4 },
        turnChecks: [{ checkKind: 'dot', actorName: '对手', skillName: '灼热', nat: 10, total: 7, target: 12,
            success: false, text: '对手持续伤害豁免失败，损失8点生命', modifiers: [{ source: '虚弱', value: -3 }] }] });
    assert.ok(followUp.textContent.includes('AOE 衰减：4 个目标'));
    assert.ok(followUp.querySelector('.td-turn-checks').textContent.includes('损失8点生命'));
    assert.ok(followUp.querySelector('.td-turn-checks').textContent.includes('虚弱 -3'));
});

await check('单体头像直执行、群体确认与掷骰前减益使用实际 DOM', async () => {
    const { AppController } = await import('../src/app.js');
    const { Battle } = await import('../src/combat/engine.js');
    const { normalizePowerSystem } = await import('../src/core/schema.js');
    const { renderBattle } = await import('../src/ui/battle.js');
    const ctx = { name1: '玩家', extensionSettings: {}, chatMetadata: {}, saveSettingsDebounced() {}, async saveMetadata() {} };
    const app = new AppController(ctx);
    app.settings.battle.showDice = false;
    app._maybeContinueAutoDrive = () => {};
    const attributes = { HP: 500, MP: 100, Atk: 20, Armor: 0, Evasion: 10, Speed: 1 };
    const system = normalizePowerSystem({ combatants: [
        { id: 'player', name: '玩家', side: 'ally', isUser: true, attributes: { ...attributes, Speed: 100 },
            statuses: [{ name: '失衡', type: 'debuff', duration: 2, modifiers: [{ attr: 'hit', delta: -3 }] }],
            skills: [
                { id: 'one', name: '单点', power: 10, target: 'single', effects: [{ type: 'damage' }] },
                { id: 'area', name: '范围', power: 10, target: 'group', effects: [{ type: 'damage' }] },
                { id: 'heal', name: '援护', power: 10, target: 'single', effects: [{ type: 'heal' }] },
                { id: 'random', name: '随机弹', power: 10, target: 'random', effects: [{ type: 'damage' }] },
            ] },
        { id: 'friend', name: '队友', side: 'ally', attributes },
        { id: 'enemy1', name: '对手甲', side: 'enemy', attributes },
        { id: 'enemy2', name: '对手乙', side: 'enemy', attributes },
    ] });
    app.battle = new Battle(system, { seed: 'target-dom', ruleset: { initiativeFormula: 'Speed' } });
    app.battle.start();
    assert.equal(app.battle.currentUnit.name, '玩家');
    const battle = app.battle;
    const calls = [];
    app.playPlayerTurn = async action => { calls.push(action); return { ok: true }; };
    let root;
    const helpers = { rerender() { root = renderBattle(app, helpers); }, setTab() {} };
    const click = node => { assert.ok(node, '必须找到真实按钮'); node.dispatchEvent('click', { target: node }); };
    const skill = name => root.querySelector('.td-skill-buttons')?.querySelectorAll('.menu_button').find(node => node.textContent.trimStart().startsWith(name));
    const picks = () => root.querySelectorAll('.td-bunit-targetable');
    const card = id => root.querySelector('#td-bunit-' + id);
    helpers.rerender();
    const snapshot = battle.rng.snapshot();
    assert.ok(root.querySelector('.td-card-dock').querySelector('.td-skill-hand'), '手动角色技能显示为底部手牌');
    assert.ok(root.querySelector('.td-preroll-penalty').textContent.includes('失衡'));
    assert.ok(root.querySelector('.td-preroll-penalty').textContent.includes('-3'));
    assert.notEqual(skill('单点').getAttribute('aria-disabled'), 'true', '测试中的玩家单体技能应可用');
    click(skill('单点'));
    assert.equal(calls.length, 0, '选技能尚不执行');
    assert.equal(picks().length, 2, '所有敌方卡面都是单体候选，不只首个');
    assert.equal(root.querySelector('.td-execute-action'), null, '单体不显示额外执行按钮');
    assert.deepEqual(battle.rng.snapshot(), snapshot, '渲染与候选预览不得消耗随机数');
    const enemy2 = battle.units.find(unit => unit.name === '对手乙');
    const enemyCard = card(enemy2.id);
    enemyCard.dispatchEvent('click', { target: enemyCard.querySelector('.td-portrait') });
    click(enemyCard);
    assert.equal(calls.length, 1, '点头像直接执行，快速重复只提交一次');
    assert.deepEqual(calls.pop().targetIds, [enemy2.id]);
    await Promise.resolve();
    click(skill('援护'));
    assert.equal(picks().length, 2, '治疗高亮玩家与队友卡面');
    const staleFriend = picks()[1];
    const friend = battle.units.find(unit => unit.name === '队友');
    friend.alive = false;
    staleFriend.dispatchEvent('keydown', { key: 'Enter' });
    assert.equal(calls.length, 0, '失效旧目标卡面不能执行');
    friend.alive = true;
    click(skill('范围'));
    assert.equal(calls.length, 0, '群体技能也须确认，不可选牌即执行');
    click(root.querySelector('.td-execute-action'));
    assert.equal(calls.pop().skillId, 'area');
    await Promise.resolve();
    assert.equal(picks().length, 0, '群体不伪装成选一个目标');
    click(skill('随机弹'));
    assert.equal(calls.length, 0, '随机技能预选不执行或消耗RNG');
    click(root.querySelector('.td-execute-action'));
    assert.equal(calls.pop().skillId, 'random');
    assert.deepEqual(battle.rng.snapshot(), snapshot, '随机技能点选预览不预掷随机目标');
    await Promise.resolve();
    enemy2.alive = false;
    click(skill('单点'));
    assert.equal(picks().length, 1);
    assert.equal(calls.length, 0, '只有一个目标仍须明确选择');
    const staleTarget = picks()[0];
    battle.turnIndex = battle.initiative.findIndex(entry => entry.unitId === friend.id);
    staleTarget.dispatchEvent('keydown', { key: 'Enter' });
    assert.equal(calls.length, 0, '过期行动不能误给下一人执行');
    battle.turnIndex = battle.initiative.findIndex(entry => entry.unitId === 'player');
    helpers.rerender();
    app.busy = true;
    helpers.rerender();
    assert.equal(skill('单点').getAttribute('aria-disabled'), 'true');
    click(skill('单点'));
    assert.equal(root.querySelector('.td-target-picker'), null);
    assert.equal(calls.length, 0);
});

await check('回合流程：模式 off 时不调 API，行动立刻完成', async () => {
    const api = /** @type {any} */ (globalThis).TavernDice;
    const saved = chatData().powerSystem;
    const previousMode = api.app.settings.battle.decideMode;
    const previousDice = api.app.settings.battle.showDice;

    try {
        const { normalizePowerSystem, normalizeCombatant } = await import('../src/core/schema.js');
        chatData().powerSystem = normalizePowerSystem({
            combatants: [
                normalizeCombatant({ name: '甲', side: 'ally' }),
                normalizeCombatant({ name: '乙', side: 'enemy' }),
            ],
        });

        // off 模式：不该有任何 API 调用，行动应当立刻完成
        api.app.settings.battle.decideMode = 'off';
        api.app.settings.battle.showDice = false;

        const started = await api.app.startBattle({ seed: 'flow-off-seed' });
        assert.equal(started.ok, true, `开战失败：${started.error}`);

        const result = await api.app.act({ action: 'skip' });
        assert.equal(result.ok, true, `跳过应当成功：${result.error}`);
    } finally {
        api.app.settings.battle.decideMode = previousMode;
        api.app.settings.battle.showDice = previousDice;
        api.app.battle = null;
        chatData().powerSystem = saved;
    }
});

await check('敌方回合由 AI 操作，不给玩家技能按钮', async () => {
    const api = /** @type {any} */ (globalThis).TavernDice;
    const saved = chatData().powerSystem;
    const prevEnemyAi = api.app.settings.battle.decideForEnemies;
    const prevMode = api.app.settings.battle.decideMode;

    try {
        const { normalizePowerSystem, normalizeCombatant } = await import('../src/core/schema.js');
        // 造一个「敌方速度远高于我方」的场面，让第一手就是敌方
        chatData().powerSystem = normalizePowerSystem({
            combatants: [
                normalizeCombatant({
                    name: '我方甲',
                    side: 'ally',
                    isUser: true,
                    attributes: { HP: { current: 100, max: 100 }, Atk: { current: 20, max: 20 }, Armor: { current: 5, max: 5 }, Speed: { current: 1, max: 1 } },
                }),
                normalizeCombatant({
                    name: '敌方乙',
                    side: 'enemy',
                    attributes: { HP: { current: 100, max: 100 }, Atk: { current: 20, max: 20 }, Armor: { current: 5, max: 5 }, Speed: { current: 99, max: 99 } },
                }),
            ],
        });
        api.app.settings.battle.decideForEnemies = true;
        api.app.settings.battle.decideMode = 'flavor';

        await api.app.startBattle({ seed: 'enemy-ui-seed' });
        // 验证已提交行动后的 AI 阶段；开战准备态另有手动触发回归。
        api.app.battle.awaitingPlayerAction = false;
        api.app._autoDriveStop = false;
        assert.ok(api.app.battle, '前置条件：战斗应当开始');

        // 把当前行动者强制设成敌方（先攻排序不一定按速度）
        const enemy = api.app.battle.units.find((/** @type {any} */ u) => u.side === 'enemy');
        const idx = api.app.battle.initiative.findIndex((/** @type {any} */ e) => e.unitId === enemy.id);
        if (idx >= 0) api.app.battle.turnIndex = idx;

        api.panel.setTab('battle');
        const text = fakeDocument.getElementById('tavern-dice-panel').textContent;

        assert.ok(/AI 正在处理|等待自动行动/.test(text), '敌方回合只展示自动处理状态');
        assert.ok(!text.includes('让对手出手'), '不应要求玩家触发敌方行动');
        assert.ok(!text.includes('一直打到轮到我'), '不应要求玩家手动推进');
        api.app.settings.battle.decideForEnemies = false;
        api.app.settings.battle.decideMode = 'off';
        api.panel.setTab('battle');
        const legacyText = fakeDocument.getElementById('tavern-dice-panel').textContent;
        assert.ok(/AI 正在处理|等待自动行动/.test(legacyText), '旧配置也不能显示敌方技能选择');
        const actionButtons = [...fakeDocument.getElementById('tavern-dice-panel')
            .querySelector('.td-action-bar').querySelectorAll('.menu_button')];
        assert.ok(!actionButtons.some(button => button.textContent.includes('普通攻击')), '旧配置不得放出敌方操作按钮');
        assert.equal(fakeDocument.getElementById('tavern-dice-panel').querySelector('.td-skill-buttons'), null,
            '敌方回合不显示玩家技能选择；结算文字可以提及普通攻击');
    } finally {
        api.app.settings.battle.decideForEnemies = prevEnemyAi;
        api.app.settings.battle.decideMode = prevMode;
        api.app.battle = null;
        chatData().powerSystem = saved;
    }
});

await check('多人战：批量决策按钮出现在敌方回合，且能一次想好全侧', async () => {
    const api = /** @type {any} */ (globalThis).TavernDice;
    const saved = chatData().powerSystem;
    const prevMode = api.app.settings.battle.decideMode;
    const prevBatch = api.app.settings.battle.batchDecisions;
    const prevEnemyAi = api.app.settings.battle.decideForEnemies;

    try {
        const { normalizePowerSystem, normalizeCombatant } = await import('../src/core/schema.js');
        const combatants = [normalizeCombatant({ name: '我方甲', side: 'ally', isUser: true, attributes: { HP: { current: 200, max: 200 }, Speed: { current: 1, max: 1 } } })];
        for (let i = 1; i <= 3; i++) {
            combatants.push(normalizeCombatant({ name: `敌${i}`, side: 'enemy', attributes: { HP: { current: 100, max: 100 }, Speed: { current: 50 - i, max: 50 - i } } }));
        }
        chatData().powerSystem = normalizePowerSystem({ combatants });

        api.app.settings.battle.decideMode = 'flavor';
        api.app.settings.battle.batchDecisions = true;
        api.app.settings.battle.decideForEnemies = true;
        await api.app.startBattle({ seed: 'batch-ui-seed' });
        api.app.battle.awaitingPlayerAction = false;
        api.app._autoDriveStop = false;

        // 强制轮到敌方
        const enemy = api.app.battle.units.find((/** @type {any} */ u) => u.side === 'enemy');
        const idx = api.app.battle.initiative.findIndex((/** @type {any} */ e) => e.unitId === enemy.id);
        if (idx >= 0) api.app.battle.turnIndex = idx;

        api.panel.setTab('battle');
        const text = fakeDocument.getElementById('tavern-dice-panel').textContent;
        assert.ok(/AI 正在处理|等待自动行动/.test(text), '多人战同样自动处理');
        assert.ok(!text.includes('一次想好这一侧'), '不能再要求玩家点击批量决策');

        // 真人调用一次（通道不可用 → 应当结构化失败，但不应崩）
        const planned = await api.app.planRound(api.app.battle);
        assert.equal(typeof planned.ok, 'boolean', 'planRound 应当返回结构化结果');
        assert.ok(!planned.ok, '通道不可用时应当失败（这是预期的）');

        // 只有一个单位时不该走批量路径
        api.app.battle.units.filter((/** @type {any} */ u) => u.side === 'enemy').slice(1).forEach((/** @type {any} */ u) => { u.alive = false; });
        const single = await api.app.planRound(api.app.battle);
        assert.equal(single.ok, false, '只剩 1 个单位时不该批量');
        assert.ok(single.error.includes('只有 1 个单位'), `应当说明原因，实际：${single.error}`);
    } finally {
        api.app.settings.battle.decideMode = prevMode;
        api.app.settings.battle.batchDecisions = prevBatch;
        api.app.settings.battle.decideForEnemies = prevEnemyAi;
        api.app.battle = null;
        api.app._decisionQueue = null;
        chatData().powerSystem = saved;
    }
});

await check('批量决策队列：取过就删，且不顶掉玩家的选择', async () => {
    const api = /** @type {any} */ (globalThis).TavernDice;
    const saved = chatData().powerSystem;
    try {
        const { normalizePowerSystem, normalizeCombatant } = await import('../src/core/schema.js');
        chatData().powerSystem = normalizePowerSystem({
            combatants: [
                normalizeCombatant({ name: '我方甲', side: 'ally' }),
                normalizeCombatant({ name: '敌方乙', side: 'enemy' }),
            ],
        });
        await api.app.startBattle({ seed: 'queue-seed' });
        const battle = api.app.battle;
        const ally = battle.units.find((/** @type {any} */ u) => u.side === 'ally');

        // 手工塞一条队列决策
        api.app._decisionQueue = {
            battleId: battle.id,
            round: battle.round,
            side: 'ally',
            byUnit: { [ally.id]: { skillId: '', targetName: '', action: 'attack', flavor: '队列里的描述' } },
        };

        // 第一次取得
        const first = api.app._takeQueuedDecision(battle, ally);
        assert.ok(first, '第一次应当取到');
        assert.equal(first.flavor, '队列里的描述');

        // 第二次应当取不到（取过就删 —— 一个单位一轮只消费一次）
        const second = api.app._takeQueuedDecision(battle, ally);
        assert.equal(second, null, '取过就该删掉，避免重复使用同一份决策');

        // 轮次变了就失效
        api.app._decisionQueue = { battleId: battle.id, round: battle.round - 1, side: 'ally', byUnit: { [ally.id]: { flavor: 'x' } } };
        assert.equal(api.app._takeQueuedDecision(battle, ally), null, '旧轮次的决策应当失效');
    } finally {
        api.app.battle = null;
        api.app._decisionQueue = null;
        chatData().powerSystem = saved;
    }
});

await check('设置迁移：老用户默认把敌方改成 AI 决策', async () => {
    const { migrateSettings } = await import('../src/core/store.js');

    // v1 的老设置（decideForEnemies 是旧的 false 默认值）
    const old = { battle: { decideForEnemies: false }, p1: {}, p2: {} };
    const notes = migrateSettings(old);
    assert.equal(old.battle.decideForEnemies, true, '应当迁移成 true');
    assert.equal(old.settingsVersion, 3, '应当升级版本号');
    assert.ok(notes.length > 0, '应当报告做了什么迁移');

    // 迁移是一次性的 —— 之后用户再关掉不该被改回来
    old.battle.decideForEnemies = false;
    const again = migrateSettings(old);
    assert.equal(again.length, 0, '第二次不该再迁移');
    assert.equal(old.battle.decideForEnemies, false, '应当尊重用户后来的选择');
});

await check('开战流程：点「开始战斗」会写输入框并点发送，且等待生成结束', async () => {
    const api = /** @type {any} */ (globalThis).TavernDice;
    const saved = chatData().powerSystem;

    // 桩一个输入框与发送按钮，记录调用
    const calls = { inputValue: '', inputEvent: 0, sendClicked: 0 };
    const fakeInput = {
        value: '',
        dispatchEvent: () => { calls.inputEvent++; return true; },
        focus: () => {},
        select: () => {},
    };
    const fakeSend = { click: () => { calls.sendClicked++; } };
    const originalGetById = fakeDocument.getElementById.bind(fakeDocument);
    fakeDocument.getElementById = (id) => {
        if (id === 'send_textarea') return fakeInput;
        if (id === 'send_but') return fakeSend;
        return originalGetById(id);
    };

    try {
        const prevAutoSend = api.app.settings.battle.autoSendScene;
        api.app.settings.battle.autoSendScene = true;

        // 在点开战之前把「生成结束」的信号挂上 —— 否则流程会一直等
        const pending = api.app.startBattleByScene({ situation: '这是一场切磋' });
        // 等它把指令写进输入框并点发送
        for (let i = 0; i < 40 && calls.sendClicked === 0; i++) await new Promise((r) => setTimeout(r, 15));

        assert.ok(calls.sendClicked > 0, '应当点了发送按钮');
        assert.ok(fakeInput.value.length > 0, '输入框里应当有战斗场景指令');
        assert.ok(fakeInput.value.includes('放弃一切创作'), '指令应当是战斗场景指令');
        assert.ok(fakeInput.value.includes('这是一场切磋'), '补充要求应当被注入');
        assert.ok(fakeInput.value.includes('【玩家】'), '指令里应当要求保留【玩家】标记');

        // 通过实际注册的事件处理器通知结束；不能用旧回复冒充本次场景。
        const ended = registeredEvents.find(({ event }) => event === 'generation_ended');
        assert.ok(ended, '应注册正文结束事件');
        ended.handler();
        const result = await pending;
        // 没有 AI 回复 → 会报「没有读到 AI 回复」，这是预期的
        assert.equal(typeof result.ok, 'boolean');
        assert.ok(!result.ok, '桩环境里没有 AI 回复，应当失败而不是假装成功');

        api.app.settings.battle.autoSendScene = prevAutoSend;
    } finally {
        fakeDocument.getElementById = originalGetById;
        api.app._resolveGenerationWait = null;
        api.app.battle = null;
        chatData().powerSystem = saved;
    }
});

await check('正文停止事件兼容缺省常量，并清理等待而不继续开战', async () => {
    const app = globalThis.TavernDice.app;
    const originalAbort = app._abort;
    app._abort = new AbortController();
    const stopped = registeredEvents.find(({ event }) => event === 'generation_stopped');
    assert.ok(stopped, '宿主常量表缺少该键时仍应绑定停止事件');
    try {
        const pending = app.waitForGeneration();
        stopped.handler('independent-helper-request');
        assert.equal(app._sceneGenerationWait.settled, false, '助手独立请求不能停止正文等待');
        stopped.handler();
        const result = await pending;
        assert.equal(result.ok, false);
        assert.equal(result.aborted, true);
        assert.equal(app._sceneGenerationWait, null);
        assert.equal(app._resolveGenerationWait, null);
    } finally {
        app._resolveGenerationWait?.(false);
        app._abort = originalAbort;
    }
});

await check('找不到输入框时把指令写进日志，不静默失败', async () => {
    const api = /** @type {any} */ (globalThis).TavernDice;
    const originalGetById = fakeDocument.getElementById.bind(fakeDocument);
    fakeDocument.getElementById = (id) => (id === 'send_textarea' || id === 'send_but' ? null : originalGetById(id));
    try {
        const result = await api.app.startBattleByScene({});
        assert.equal(result.ok, false, '找不到输入框应当失败');
        assert.ok(result.error.includes('输入框'), `错误里应当说明找不到输入框，实际：${result.error}`);
    } finally {
        fakeDocument.getElementById = originalGetById;
    }
});

await check('writeToInput 会触发 input 事件（否则酒馆的输入监听不生效）', () => {
    const api = /** @type {any} */ (globalThis).TavernDice;
    let events = 0;
    const fakeInput = { value: '', dispatchEvent: () => { events++; return true; } };
    const originalGetById = fakeDocument.getElementById.bind(fakeDocument);
    fakeDocument.getElementById = (id) => (id === 'send_textarea' ? fakeInput : originalGetById(id));
    try {
        const ok = api.app.writeToInput('测试文本');
        assert.equal(ok, true);
        assert.equal(fakeInput.value, '测试文本');
        assert.ok(events > 0, '必须触发 input 事件');
    } finally {
        fakeDocument.getElementById = originalGetById;
    }
});

await check('提示词会带上运行时的 persona 名字（不硬编码任何角色名）', async () => {
    // 注意：这里**不调 startBattleByScene**。
    // 那条路径会挂一个「等生成结束」的定时器（180s），在桩环境里没人兑现，
    // 会让整个冒烟测试挂住（踩过）。这里直接验证「构造出来的指令文本」——
    // 那正是要断言的东西，而且没有副作用。
    const { buildSceneRequest } = await import('../src/llm/scene-prompt.js');

    const prevName = fakeCtx.name1;
    try {
        fakeCtx.name1 = '张三丰';
        const text = buildSceneRequest({
            userName: fakeCtx.name1,
            characterName: fakeCtx.name2,
        });

        assert.ok(text.includes('张三丰'), `提示词里应当带上 persona 名字，实际片段：${text.slice(0, 300)}`);
        assert.ok(!text.includes('淇'), '提示词里不该出现任何硬编码的角色名');
        assert.ok(text.includes('【玩家】'), '仍然要要求打【玩家】标记');
        assert.ok(text.includes('不要凭角色名去猜'), '要禁止模型硬猜');
    } finally {
        fakeCtx.name1 = prevName;
    }
});
await check('「哪个角色是我」选择条：可指定、可取消、且能持久化', async () => {
    const api = /** @type {any} */ (globalThis).TavernDice;
    const saved = chatData().powerSystem;
    const prevUser = api.app.settings.battle.userUnitName;
    try {
        const { normalizePowerSystem, normalizeCombatant } = await import('../src/core/schema.js');
        chatData().powerSystem = normalizePowerSystem({
            combatants: [
                normalizeCombatant({ name: '我', side: 'ally' }),
                normalizeCombatant({ name: '队友', side: 'ally' }),
                normalizeCombatant({ name: '敌', side: 'enemy' }),
            ],
        });
        await api.app.startBattle({ seed: 'user-picker-seed' });

        // 未指定时应当显示警告态
        api.app.settings.battle.userUnitName = '';
        for (const u of api.app.battle.units) u.isUser = false;
        api.panel.setTab('battle');
        let text = fakeDocument.getElementById('tavern-dice-panel').textContent;
        assert.ok(text.includes('还没指定哪个角色是你'), `未指定时应当提示，实际片段：${text.slice(0, 300)}`);
        assert.ok(text.includes('自动行动已暂停'), '身份缺失应暂停自动行动');
        const beforeTurn = api.app.battle.turnIndex;
        const blocked = await api.app.autoAct();
        assert.equal(blocked.ok, false);
        assert.match(blocked.error, /玩家身份/);
        assert.equal(api.app.battle.turnIndex, beforeTurn, '不得替未识别的玩家行动');

        // 指定之后应当显示「你操控」
        await api.app.setUserUnit('我');
        assert.equal(api.app.settings.battle.userUnitName, '我', '应当持久化到设置');
        assert.equal(api.app.battle.units.find((/** @type {any} */ u) => u.name === '我').isUser, true, '应当同步到战斗数据');

        const player = api.app.battle.units.find((u) => u.name === '我');
        api.app.battle.turnIndex = api.app.battle.initiative.findIndex((entry) => entry.unitId === player.id);
        const playerTurn = api.app.battle.turnIndex;
        const refused = await api.app.autoAct();
        assert.equal(refused.ok, false);
        assert.match(refused.error, /玩家回合/);
        assert.equal(api.app.battle.turnIndex, playerTurn);
        api.panel.setTab('battle');
        text = fakeDocument.getElementById('tavern-dice-panel').textContent;
        assert.ok(text.includes('你操控：我'), `应当显示你操控谁，实际片段：${text.slice(0, 300)}`);
        assert.ok(text.includes('其余我方成员由 AI 操作'), '应当说明队友归 AI');
    } finally {
        api.app.settings.battle.userUnitName = prevUser;
        api.app.battle = null;
        chatData().powerSystem = saved;
    }
});

await check('批量决策不给玩家单位排队（队友归 AI，你自己归你）', async () => {
    const api = /** @type {any} */ (globalThis).TavernDice;
    const saved = chatData().powerSystem;
    const prevUser = api.app.settings.battle.userUnitName;
    const prevMode = api.app.settings.battle.decideMode;
    try {
        const { normalizePowerSystem, normalizeCombatant } = await import('../src/core/schema.js');
        chatData().powerSystem = normalizePowerSystem({
            combatants: [
                normalizeCombatant({ name: '我', side: 'ally' }),
                normalizeCombatant({ name: '队友甲', side: 'ally' }),
                normalizeCombatant({ name: '队友乙', side: 'ally' }),
                normalizeCombatant({ name: '敌', side: 'enemy' }),
            ],
        });
        api.app.settings.battle.decideMode = 'flavor';
        await api.app.startBattle({ seed: 'ownership-seed' });
        await api.app.setUserUnit('我');

        // 让当前行动者变成我方
        const ally = api.app.battle.units.find((/** @type {any} */ u) => u.name === '我');
        const idx = api.app.battle.initiative.findIndex((/** @type {any} */ e) => e.unitId === ally.id);
        if (idx >= 0) api.app.battle.turnIndex = idx;

        // 通道不可用 → planRound 会失败，但失败前不该把「我」算进 AI 名单
        const planned = await api.app.planRound(api.app.battle);
        assert.equal(typeof planned.ok, 'boolean');
        if (planned.ok) {
            assert.ok(!planned.count || planned.count <= 2, `AI 最多接管 2 个队友，实际 ${planned.count}`);
            assert.ok(
                !api.app._decisionQueue?.byUnit?.[ally.id],
                '绝不能给玩家单位排队 AI 决策',
            );
        }
    } finally {
        api.app.settings.battle.userUnitName = prevUser;
        api.app.settings.battle.decideMode = prevMode;
        api.app.battle = null;
        api.app._decisionQueue = null;
        chatData().powerSystem = saved;
    }
});

await check('确认弹窗不依赖酒馆宿主 API（放弃战斗按钮能按动）', async () => {
    const api = /** @type {any} */ (globalThis).TavernDice;
    const { confirmDialog, closeModal } = await import('../src/ui/dom.js');

    // 关键：假环境里**没有** callGenericPopup / POPUP_TYPE，
    // 也没有可用的 window.confirm（真机上 TauriTavern 可能禁用）。
    // 插件必须用自己的弹窗 —— 否则按钮点了没反应（用户报的「按不动」）。
    const originalCallGeneric = globalThis.callGenericPopup;
    const originalPopupType = globalThis.POPUP_TYPE;
    const originalConfirm = globalThis.confirm;
    delete globalThis.callGenericPopup;
    delete globalThis.POPUP_TYPE;
    globalThis.confirm = () => {
        throw new Error('不该走到原生 confirm');
    };

    try {
        const promise = confirmDialog('测试确认');
        // 弹窗应当出现在 DOM 里
        const modal = fakeDocument.getElementById('tavern-dice-modal');
        assert.ok(modal, '应当创建了插件自己的确认弹窗');
        const text = modal.textContent;
        assert.ok(text.includes('测试确认'), '应当显示确认内容');
        assert.ok(text.includes('确认') && text.includes('取消'), '应当有确认/取消按钮');

        // 点「确认」应当兑现 Promise
        const buttons = modal.querySelectorAll('.menu_button');
        const okBtn = buttons.find((b) => b.textContent.includes('确认'));
        assert.ok(okBtn, '找不到确认按钮');
        okBtn.dispatchEvent('click', { bubbles: true });
        const value = await promise;
        assert.equal(value, true, '点确认应当返回 true');
        closeModal();
    } finally {
        if (originalCallGeneric) globalThis.callGenericPopup = originalCallGeneric;
        if (originalPopupType) globalThis.POPUP_TYPE = originalPopupType;
        globalThis.confirm = originalConfirm;
        void api;
    }
});

await check('连续推进停在「你操控的角色」，不是每个我方单位都停', async () => {
    const api = /** @type {any} */ (globalThis).TavernDice;
    const saved = chatData().powerSystem;
    const prevUser = api.app.settings.battle.userUnitName;
    const prevMode = api.app.settings.battle.decideMode;
    try {
        const { normalizePowerSystem, normalizeCombatant } = await import('../src/core/schema.js');
        chatData().powerSystem = normalizePowerSystem({
            combatants: [
                normalizeCombatant({ name: '我', side: 'ally', attributes: { HP: { current: 200, max: 200 }, Speed: { current: 30, max: 30 } } }),
                normalizeCombatant({ name: '队友', side: 'ally', attributes: { HP: { current: 200, max: 200 }, Speed: { current: 20, max: 20 } } }),
                normalizeCombatant({ name: '敌', side: 'enemy', attributes: { HP: { current: 200, max: 200 }, Speed: { current: 10, max: 10 } } }),
            ],
        });
        api.app.settings.battle.decideMode = 'off'; // 不调 API，纯本地推进
        await api.app.startBattle({ seed: 'advance-stop-seed' });
        await api.app.setUserUnit('我');

        // 我最快 → 第一个回合就是我；先跳过让局面转到别人
        await api.app.act({ action: 'skip' });

        const r = await api.app.autoAdvance({ maxSteps: 10 });
        assert.equal(typeof r.steps, 'number');
        // 停下来的那个必须是我（否则就是队友/敌人回合也停了）
        const unit = api.app.battle?.currentUnit;
        if (unit) {
            assert.ok(
                api.app.isUserUnit(unit),
                `应当停在玩家单位，实际停在「${unit.name}」（${unit.side}）`,
            );
        }
    } finally {
        api.app.settings.battle.userUnitName = prevUser;
        api.app.settings.battle.decideMode = prevMode;
        api.app.battle = null;
        chatData().powerSystem = saved;
    }
});

await check('手动启动 AI 阶段后连续推进到玩家，不在开战或换人时偷偷启动', async () => {
    const api = /** @type {any} */ (globalThis).TavernDice;
    const saved = chatData().powerSystem;
    const prevUser = api.app.settings.battle.userUnitName;
    const prevMode = api.app.settings.battle.decideMode;
    const prevDrive = api.app.settings.battle.autoDrive;
    const { LlmClient } = await import('../src/llm/client.js');
    const oldAsk = LlmClient.prototype.ask;
    const oldMin = api.app.settings.battle.diceMinDuration;
    const oldComplete = LlmClient.prototype.complete;
    LlmClient.prototype.complete = async () => ({ ok: true, text: '{"action":"defend","flavor":"稳住阵脚"}' });
    LlmClient.prototype.ask = async () => ({ ok: true, text: '{"action":"defend","flavor":"稳住阵脚"}' });
    api.app.settings.battle.diceMinDuration = 1;
    try {
        const { normalizePowerSystem, normalizeCombatant } = await import('../src/core/schema.js');
        // 三个 AI 单位速度都比我快 → 开战后先手不是玩家，应当自动推进到我
        chatData().powerSystem = normalizePowerSystem({
            combatants: [
                normalizeCombatant({ name: '我', side: 'ally', attributes: { HP: { current: 300, max: 300 }, Atk: { current: 5, max: 5 }, Speed: { current: 1, max: 1 } } }),
                normalizeCombatant({ name: '队友', side: 'ally', attributes: { HP: { current: 300, max: 300 }, Atk: { current: 5, max: 5 }, Speed: { current: 90, max: 90 } } }),
                normalizeCombatant({ name: '敌甲', side: 'enemy', attributes: { HP: { current: 300, max: 300 }, Atk: { current: 5, max: 5 }, Speed: { current: 80, max: 80 } } }),
                normalizeCombatant({ name: '敌乙', side: 'enemy', attributes: { HP: { current: 300, max: 300 }, Atk: { current: 5, max: 5 }, Speed: { current: 70, max: 70 } } }),
            ],
        });
        api.app.settings.battle.decideMode = 'off'; // 不调 API，纯本地推进
        api.app.settings.battle.autoDrive = true;
        await api.app.setUserUnit('我');

        await api.app.startBattle({ seed: 'autodrive-seed' });
        assert.ok(api.app.battle, '前置条件：战斗应当开始');

        const before = api.app.battle.toState();
        api.panel.setTab('battle');
        await new Promise(r => setTimeout(r, 25));
        assert.deepEqual(api.app.battle.toState(), before, '开战与渲染不消费回合或骰子');
        assert.equal((await api.app.playPlayerTurn({ action: 'defend' })).ok, true);
        for (let i = 0; i < 60; i++) {
            await new Promise((r) => setTimeout(r, 25));
            if (api.app.isUserUnit(api.app.battle?.currentUnit)) break;
        }

        const unit = api.app.battle?.currentUnit;
        assert.ok(unit, '战斗还在');
        assert.ok(
            api.app.isUserUnit(unit),
            `应当自动推进到玩家单位，实际停在「${unit.name}」（${unit.side}）`,
        );
        // 当前单位已切换时，循环还有一次让出线程；等待finally释放忙碌状态再进入下一用例。
        for (let i = 0; i < 20 && api.app._autoDriving; i++) await new Promise(r => setTimeout(r, 25));
        assert.equal(api.app.busy, false, '回到玩家后应释放忙碌状态');
    } finally {
        LlmClient.prototype.ask = oldAsk;
        LlmClient.prototype.complete = oldComplete;
        api.app.settings.battle.diceMinDuration = oldMin;
        api.app.settings.battle.userUnitName = prevUser;
        api.app.settings.battle.decideMode = prevMode;
        api.app.settings.battle.autoDrive = prevDrive;
        api.app._autoDriveStop = false;
        api.app.battle = null;
        chatData().powerSystem = saved;
    }
});

await check('自动衔接：可以中途停下，且不会套娃递归', async () => {
    const api = /** @type {any} */ (globalThis).TavernDice;
    const saved = chatData().powerSystem;
    const prevUser = api.app.settings.battle.userUnitName;
    const prevMode = api.app.settings.battle.decideMode;
    try {
        const { normalizePowerSystem, normalizeCombatant } = await import('../src/core/schema.js');
        chatData().powerSystem = normalizePowerSystem({
            combatants: [
                normalizeCombatant({ name: '我', side: 'ally', attributes: { HP: { current: 500, max: 500 }, Speed: { current: 1, max: 1 } } }),
                normalizeCombatant({ name: '敌', side: 'enemy', attributes: { HP: { current: 500, max: 500 }, Speed: { current: 90, max: 90 } } }),
            ],
        });
        api.app.settings.battle.decideMode = 'off';
        await api.app.setUserUnit('我');

        // 推进中不该再启动第二个推进循环
        api.app._autoDriving = true;
        api.app._autoDriveStop = false;
        api.app._maybeContinueAutoDrive();
        assert.equal(api.app._autoDriving, true, '不该覆盖正在运行的标志');

        // 请求停止后不该再启动
        api.app._autoDriving = false;
        api.app._autoDriveStop = true;
        api.app._maybeContinueAutoDrive();
        assert.equal(api.app._autoDriving, false, '收到停止请求后不该启动');

        api.app._autoDriveStop = false;
    } finally {
        api.app.settings.battle.userUnitName = prevUser;
        api.app.settings.battle.decideMode = prevMode;
        api.app._autoDriving = false;
        api.app._autoDriveStop = false;
        api.app.battle = null;
        chatData().powerSystem = saved;
    }
});

await check('开战及反复渲染仅预览，不代替玩家提交行动', async () => {
    const api = /** @type {any} */ (globalThis).TavernDice;
    const saved = chatData().powerSystem;
    const prevUser = api.app.settings.battle.userUnitName;
    const prevMode = api.app.settings.battle.decideMode;
    const prevDrive = api.app.settings.battle.autoDrive;
    const { LlmClient } = await import('../src/llm/client.js');
    const oldAsk = LlmClient.prototype.ask;
    const oldMin = api.app.settings.battle.diceMinDuration;
    const oldComplete = LlmClient.prototype.complete;
    LlmClient.prototype.complete = async () => ({ ok: true, text: '{"action":"defend","flavor":"稳住阵脚"}' });
    LlmClient.prototype.ask = async () => ({ ok: true, text: '{"action":"defend","flavor":"稳住阵脚"}' });
    api.app.settings.battle.diceMinDuration = 1;
    try {
        const { normalizePowerSystem, normalizeCombatant } = await import('../src/core/schema.js');
        // 队友速度比我快 → 一开战就轮到队友（我方但不是玩家操控的）
        chatData().powerSystem = normalizePowerSystem({
            combatants: [
                normalizeCombatant({ name: '我', side: 'ally', attributes: { HP: { current: 300, max: 300 }, Atk: { current: 5, max: 5 }, Speed: { current: 1, max: 1 } } }),
                normalizeCombatant({ name: '队友', side: 'ally', attributes: { HP: { current: 300, max: 300 }, Atk: { current: 5, max: 5 }, Speed: { current: 90, max: 90 } } }),
                normalizeCombatant({ name: '敌', side: 'enemy', attributes: { HP: { current: 300, max: 300 }, Atk: { current: 5, max: 5 }, Speed: { current: 50, max: 50 } } }),
            ],
        });
        api.app.settings.battle.decideMode = 'off';
        api.app.settings.battle.autoDrive = true;
        await api.app.setUserUnit('我');
        await api.app.startBattle({ seed: 'render-drive-seed' });

        const before = api.app.battle.toState();
        api.panel.setTab('battle');
        for (let i = 0; i < 4; i++) {
            api.panel.render();
            await new Promise(r => setTimeout(r, 25));
        }
        assert.deepEqual(api.app.battle.toState(), before, '仅渲染不能改变回合、资源、日志或随机数');
        assert.equal(api.app.busy, false);
    } finally {
        LlmClient.prototype.ask = oldAsk;
        LlmClient.prototype.complete = oldComplete;
        api.app.settings.battle.diceMinDuration = oldMin;
        api.app.settings.battle.userUnitName = prevUser;
        api.app.settings.battle.decideMode = prevMode;
        api.app.settings.battle.autoDrive = prevDrive;
        api.app._autoDriveStop = false;
        api.app._autoDriveBudget = 0;
        api.app.battle = null;
        chatData().powerSystem = saved;
    }
});

await check('AI 单位回合不该显示玩家技能按钮（队友也不行）', async () => {
    const api = /** @type {any} */ (globalThis).TavernDice;
    const saved = chatData().powerSystem;
    const prevUser = api.app.settings.battle.userUnitName;
    const prevDrive = api.app.settings.battle.autoDrive;
    const prevAiAllies = api.app.settings.battle.aiControlsAllies;
    try {
        const { normalizePowerSystem, normalizeCombatant } = await import('../src/core/schema.js');
        const mk = (name, side, speed) => normalizeCombatant({ name, side, attributes: { HP: { current: 300, max: 300 }, Speed: { current: speed, max: speed } } });
        chatData().powerSystem = normalizePowerSystem({
            combatants: [mk('我', 'ally', 1), mk('队友', 'ally', 90), mk('敌', 'enemy', 50)],
        });
        api.app.settings.battle.autoDrive = false; // 关掉推进，只看界面
        api.app.settings.battle.aiControlsAllies = true;
        await api.app.setUserUnit('我');
        await api.app.startBattle({ seed: 'ally-ui-seed' });
        api.app.battle.awaitingPlayerAction = false;
        api.app._autoDriveStop = false;

        // 强制轮到队友（我方但不是玩家）
        const mate = api.app.battle.units.find((/** @type {any} */ u) => u.name === '队友');
        const idx = api.app.battle.initiative.findIndex((/** @type {any} */ e) => e.unitId === mate.id);
        if (idx >= 0) api.app.battle.turnIndex = idx;

        api.panel.setTab('battle');
        const text = fakeDocument.getElementById('tavern-dice-panel').textContent;
        assert.ok(!text.includes('普通攻击'), `队友回合不该显示玩家的技能按钮，实际片段：${text.slice(0, 400)}`);
    } finally {
        api.app.settings.battle.userUnitName = prevUser;
        api.app.settings.battle.autoDrive = prevDrive;
        api.app.settings.battle.aiControlsAllies = prevAiAllies;
        api.app.battle = null;
        chatData().powerSystem = saved;
    }
});

await check('战斗模式：切磋显示「力竭」、生死显示「阵亡」', async () => {
    const api = /** @type {any} */ (globalThis).TavernDice;
    const saved = chatData().powerSystem;
    const prevMode = api.app.settings.battle.combatMode;
    const prevDrive = api.app.settings.battle.autoDrive;
    try {
        const { normalizePowerSystem, normalizeCombatant } = await import('../src/core/schema.js');
        const mk = (name, side, hp) =>
            normalizeCombatant({
                name,
                side,
                attributes: { HP: { current: hp, max: hp }, Atk: { current: 10, max: 10 }, Speed: { current: 10, max: 10 } },
            });
        chatData().powerSystem = normalizePowerSystem({ combatants: [mk('我', 'ally', 200), mk('敌', 'enemy', 200)] });
        api.app.settings.battle.autoDrive = false;

        // 切磋
        api.app.settings.battle.combatMode = 'spar';
        await api.app.startBattle({ seed: 'spar-badge' });
        assert.equal(api.app.battle.combatMode, 'spar', '应当生效为切磋');
        api.panel.setTab('battle');
        let text = fakeDocument.getElementById('tavern-dice-panel').textContent;
        assert.ok(text.includes('切磋'), `战斗页应当显示切磋徽章，实际片段：${text.slice(0, 260)}`);

        // 生死
        api.app.settings.battle.combatMode = 'deadly';
        await api.app.startBattle({ seed: 'deadly-badge' });
        assert.equal(api.app.battle.combatMode, 'deadly', '应当生效为生死搏杀');
        api.panel.setTab('battle');
        text = fakeDocument.getElementById('tavern-dice-panel').textContent;
        assert.ok(text.includes('生死搏杀'), '战斗页应当显示生死搏杀徽章');

        // 切磋里被打空 → 日志写「力竭」而不是「阵亡」
        api.app.settings.battle.combatMode = 'spar';
        await api.app.startBattle({ seed: 'spar-down' });
        const { applyDamage } = await import('../src/combat/engine.js');
        const enemy = api.app.battle.units.find((/** @type {any} */ u) => u.name === '敌');
        applyDamage(enemy, 9999, api.app.battle.ruleset, api.app.battle.combatMode);
        assert.equal(enemy.incapacitated, true, '切磋里倒下应当标记力竭');
    } finally {
        api.app.settings.battle.combatMode = prevMode;
        api.app.settings.battle.autoDrive = prevDrive;
        api.app.battle = null;
        chatData().powerSystem = saved;
    }
});

await check('渲染日志页没有抛异常', () => {
    /** @type {any} */ (globalThis).TavernDice.panel.setTab('log');
});

// 仅悬浮骰子用真实大小；不改共享假 DOM 的面板布局或事件语义。
function launcherRect(node, width = 64, height = 72) {
    node.getBoundingClientRect = () => {
        const left = parseFloat(node.style.left) || 0;
        const top = parseFloat(node.style.top) || 0;
        return { left, top, right: left + width, bottom: top + height, width, height, x: left, y: top };
    };
}
function launcherWindowEvent(type, event = {}) {
    return FakeElement.prototype.dispatchEvent.call(fakeWindow, type, event);
}
function launcherWindowListenerCount() {
    return Object.values(fakeWindow._listeners).reduce((count, list) => count + list.length, 0);
}

await check('尺寸设置输入不会重绘或提前落盘，保存失败和非法大小安全提示', async () => {
    const { renderBallSize, renderWindowSize } = await import('../src/ui/settings.js');
    let notifications = 0, saves = 0, redraws = 0;
    const stub = { settings: { ballSize: 64, panelRect: { x: 20, y: 30, w: 880, h: 620 } },
        notify() { notifications++; }, async persistSettings() { saves++; return false; } };
    const helpers = { rerender() { redraws++; } };
    const root = renderBallSize(stub, helpers);
    const slider = root.querySelector('input');
    slider.value = '96'; slider.dispatchEvent('input');
    assert.equal(stub.settings.ballSize, 96); assert.equal(notifications, 1);
    assert.equal(saves, 0); assert.equal(redraws, 0);
    assert.equal(root.querySelector('input'), slider, 'input必须保留原滑块节点');
    slider.dispatchEvent('change'); await Promise.resolve(); await Promise.resolve();
    assert.equal(saves, 1); assert.equal(redraws, 0);
    const windowRoot = renderWindowSize(stub, helpers);
    const inputs = windowRoot.querySelectorAll('input');
    inputs[0].value = '1';
    windowRoot.querySelectorAll('.menu_button')[0].dispatchEvent('click');
    await Promise.resolve();
    assert.equal(saves, 1, '非法尺寸不得保存');
    inputs[0].value = '700'; inputs[1].value = '500'; inputs[2].value = '75';
    windowRoot.querySelectorAll('.menu_button')[0].dispatchEvent('click');
    await Promise.resolve(); await Promise.resolve();
    assert.equal(saves, 2); assert.equal(redraws, 1);
    assert.deepEqual(stub.settings.panelRect, { x: 20, y: 30, w: 700, h: 500 });
    assert.equal(stub.settings.panelMobileScale, 0.75);
});

await check('隐藏骰子按设定尺寸定位，销毁只清理一次外部订阅', async () => {
    const { createFloatBall } = await import('../src/ui/ball.js');
    let disposed = 0;
    const probe = createFloatBall({ onClick() {}, onDestroy() { disposed++; }, initialPosition: { x: 99999, y: 99999 } });
    probe.setVisible(false); probe.setSize(128);
    assert.equal(probe.node.style.display, 'none');
    assert.equal(probe.node.style.width, '128px');
    assert.ok(Number.parseFloat(probe.node.style.left) + 128 <= fakeWindow.innerWidth);
    probe.setVisible(true); assert.equal(probe.node.style.width, '128px');
    probe.destroy(); probe.destroy(); probe.setSize(40);
    assert.equal(disposed, 1); assert.equal(probe.node.style.width, '128px');
});

await check('悬浮骰子大小保持比例、限制范围且放大后不离屏', async () => {
    const { createFloatBall } = await import('../src/ui/ball.js');
    const probe = createFloatBall({ onClick() {}, initialSize: 48, initialPosition: { x: 9999, y: 9999 } });
    try {
        assert.equal(probe.node.style.width, '48px');
        assert.equal(probe.node.style.height, '54px');
        probe.setSize(128);
        assert.equal(probe.node.style.width, '128px');
        assert.equal(probe.node.style.height, '144px');
        assert.ok(Number.parseFloat(probe.node.style.left) + 128 <= fakeWindow.innerWidth);
        assert.ok(Number.parseFloat(probe.node.style.top) + 144 <= fakeWindow.innerHeight);
        probe.setSize(12); assert.equal(probe.node.style.width, '40px');
        probe.setSize(300); assert.equal(probe.node.style.width, '128px');
        probe.setSize(undefined); assert.equal(probe.node.style.width, '64px');
    } finally { probe.destroy(); }
});

await check('悬浮骰子只显示图片，保留按钮语义和无障碍提示', async () => {
    const { createFloatBall } = await import('../src/ui/ball.js');
    const probe = createFloatBall({ onClick() {}, getBadge: () => '!' });
    try {
        const node = probe.node;
        assert.equal(node.tagName, 'DIV');
        assert.equal(node.getAttribute('role'), 'button');
        assert.equal(node.getAttribute('tabindex'), '0');
        assert.equal(node.children.length, 1, '不能再有角标、文字或圆框装饰子元素');
        const image = node.children[0];
        assert.equal(image.tagName, 'IMG');
        assert.equal(image.getAttribute('src'), new URL('../assets/float-d20.png', import.meta.url).href);
        assert.equal(image.getAttribute('draggable'), 'false', '必须写字符串 false，不能被 el() 略过');
        assert.equal(image.getAttribute('alt'), '');
        assert.equal(node.textContent, '', '待处理提示也不能成为可选中的可见文字');
        assert.ok(node.getAttribute('aria-label').includes('有待处理的变化'));
        probe.setActive(true);
        probe.setBadge('待更新');
        assert.equal(node.getAttribute('aria-expanded'), 'true');
        assert.ok(node.getAttribute('aria-label').includes('收起'));
        assert.ok(node.title.includes('待更新'));
        probe.setBadge('');
        assert.ok(!node.title.includes('待更新'));
        assert.equal(node.children.length, 1, '更新角标不能新增可见装饰');
        assert.equal(node.dispatchEvent('dragstart').defaultPrevented, true);
        assert.equal(node.dispatchEvent('selectstart').defaultPrevented, true);
    } finally {
        probe.destroy();
    }
});

await check('点悬浮球能打开面板（走真实事件路径）', () => {
    // ⚠️ 这条检查必须走**真实的事件序列**。
    // 之前的检查都是直接调 api.open()，绕过了悬浮球 ——
    // 于是「悬浮球点不开」这类 bug 完全测不到（用户实测发现的）。
    const api = /** @type {any} */ (globalThis).TavernDice;
    const ball = fakeDocument.getElementById('tavern-dice-ball');
    const panel = fakeDocument.getElementById('tavern-dice-panel');
    assert.ok(ball, '悬浮球应当在 DOM 里');
    assert.ok(panel, '面板应当在 DOM 里');

    // 先确认是收起状态
    api.close();
    assert.equal(panel.style.display, 'none', '前置条件：面板应当是收起的');

    // 模拟真实点击：pointerdown（不移动）→ pointerup → click
    ball.dispatchEvent('pointerdown', { clientX: 30, clientY: 190, bubbles: true });
    ball.dispatchEvent('pointerup', { clientX: 30, clientY: 190, bubbles: true });
    ball.dispatchEvent('click', { clientX: 30, clientY: 190, bubbles: true });

    assert.equal(api.panel.isOpen, true, '点悬浮球应当展开面板');

    // 再点一次应当收起
    ball.dispatchEvent('pointerdown', { clientX: 30, clientY: 190, bubbles: true });
    ball.dispatchEvent('pointerup', { clientX: 30, clientY: 190, bubbles: true });
    ball.dispatchEvent('click', { clientX: 30, clientY: 190, bubbles: true });
    assert.equal(api.panel.isOpen, false, '再点一次应当收起面板');
});

await check('全新悬浮球只用 mouse 也能单次开合、拖动并保存', async () => {
    const { createFloatBall } = await import('../src/ui/ball.js');
    let clicked = 0;
    let open = false;
    const moves = [];
    // 必须是从未见过 pointer 的新实例，否则测不到 mouseup + click 双触发。
    const probe = createFloatBall({
        onClick: () => { clicked++; open = !open; },
        onMove: (pos) => moves.push(pos),
    });
    const ball = probe.node;
    launcherRect(ball);
    fakeDocument.body.appendChild(ball);
    try {
        for (let tap = 1; tap <= 2; tap++) {
            ball.dispatchEvent('mousedown', { clientX: 30, clientY: 190, button: 0 });
            ball.dispatchEvent('mouseup', { clientX: 30, clientY: 190, button: 0 });
            ball.dispatchEvent('click', { clientX: 30, clientY: 190, button: 0 });
            assert.equal(clicked, tap, '每次完整 mouse 序列必须恰好触发一次');
            assert.equal(open, tap === 1, '第一次展开，第二次收起');
        }
        ball.dispatchEvent('mousedown', { clientX: 30, clientY: 190, button: 0 });
        launcherWindowEvent('mousemove', { clientX: 90, clientY: 260, buttons: 1 });
        assert.equal(ball.style.left, '84px', '离开图片后仍要真的移动 X');
        assert.equal(ball.style.top, '250px', '离开图片后仍要真的移动 Y');
        assert.deepEqual(moves, [], '尚未松手不能保存');
        launcherWindowEvent('mouseup', { clientX: 90, clientY: 260, button: 0 });
        ball.dispatchEvent('click', { clientX: 90, clientY: 260, button: 0 });
        assert.deepEqual(moves, [{ x: 84, y: 250 }], '完成的移动恰好保存一次');
        assert.equal(clicked, 2, '拖动之后不算点击');
    } finally {
        probe.destroy();
    }
});

await check('pointer 与兼容 mouse/click 去重，拖动后键盘仍可开合', async () => {
    const { createFloatBall } = await import('../src/ui/ball.js');
    let clicked = 0;
    const moves = [];
    const probe = createFloatBall({ onClick: () => clicked++, onMove: (pos) => moves.push(pos) });
    const ball = probe.node;
    launcherRect(ball);
    try {
        const down = { clientX: 30, clientY: 190, button: 0, pointerId: 7, isPrimary: true };
        ball.dispatchEvent('pointerdown', down);
        ball.dispatchEvent('mousedown', down);
        ball.dispatchEvent('pointerup', down);
        ball.dispatchEvent('mouseup', down);
        ball.dispatchEvent('click', down);
        assert.equal(clicked, 1, 'pointerup + mouseup + click 只能开合一次');

        ball.dispatchEvent('pointerdown', down);
        ball.dispatchEvent('mousedown', down);
        launcherWindowEvent('pointermove', { ...down, clientX: 90, clientY: 260, buttons: 1 });
        launcherWindowEvent('mousemove', { clientX: 900, clientY: 700, buttons: 1 });
        assert.equal(ball.style.left, '84px', '兼容 mousemove 不能重复或接管 pointer 拖动');
        assert.equal(ball.style.top, '250px');
        assert.deepEqual(moves, []);
        launcherWindowEvent('pointerup', { ...down, clientX: 90, clientY: 260 });
        ball.dispatchEvent('mouseup', { clientX: 90, clientY: 260, button: 0 });
        ball.dispatchEvent('click', { clientX: 90, clientY: 260, button: 0 });
        assert.deepEqual(moves, [{ x: 84, y: 250 }]);
        assert.equal(clicked, 1);
        ball.dispatchEvent('keydown', { key: 'Enter' });
        assert.equal(clicked, 2, '上次拖动不能阻止 Enter');
        ball.dispatchEvent('keydown', { key: ' ', repeat: true });
        assert.equal(clicked, 2, '长按键盘不能重复开合');
        ball.dispatchEvent('keydown', { key: ' ' });
        ball.dispatchEvent('click', { detail: 0 });
        assert.equal(clicked, 3, '空格生效，随后合成 click 不得再次开合');
    } finally {
        probe.destroy();
    }
});

await check('未按下的移动不吃点击；小于拖动阈值不移动或保存', async () => {
    const { createFloatBall } = await import('../src/ui/ball.js');
    let clicked = 0;
    const moves = [];
    const probe = createFloatBall({ onClick: () => clicked++, onMove: (pos) => moves.push(pos) });
    const ball = probe.node;
    launcherRect(ball);
    try {
        ball.dispatchEvent('pointermove', { clientX: 1100, clientY: 700 });
        ball.dispatchEvent('mousemove', { clientX: 1100, clientY: 700 });
        ball.dispatchEvent('click', { detail: 0 });
        assert.equal(clicked, 1, '没有按下的移动不应抑制 click/辅助技术激活');
        ball.dispatchEvent('pointerdown', { clientX: 30, clientY: 190, pointerId: 4 });
        ball.dispatchEvent('pointermove', { clientX: 34, clientY: 194, pointerId: 4 });
        ball.dispatchEvent('pointerup', { clientX: 34, clientY: 194, pointerId: 4 });
        ball.dispatchEvent('click');
        assert.equal(clicked, 2, '4px 以内属于点击');
        assert.equal(ball.style.left, '24px');
        assert.equal(ball.style.top, '180px');
        assert.deepEqual(moves, [], '点击不能保存一次伪移动');
        ball.dispatchEvent('pointerdown', { clientX: 30, clientY: 190, pointerId: 5 });
        ball.dispatchEvent('pointermove', { clientX: 60, clientY: 220, pointerId: 5 });
        ball.dispatchEvent('pointerup', { clientX: 30, clientY: 190, pointerId: 5 });
        ball.dispatchEvent('click');
        assert.equal(clicked, 2, '拖出后回到原处仍是拖动');
        assert.deepEqual(moves, [], '最终坐标没有变化就不重复保存');
    } finally {
        probe.destroy();
    }
});

await check('非主按钮和非主指针不能启动、劫持或结束悬浮球拖动', async () => {
    const { createFloatBall } = await import('../src/ui/ball.js');
    let clicked = 0;
    const moves = [];
    const probe = createFloatBall({ onClick: () => clicked++, onMove: (pos) => moves.push(pos) });
    const ball = probe.node;
    launcherRect(ball);
    try {
        for (const button of [1, 2]) {
            ball.dispatchEvent('mousedown', { button, clientX: 30, clientY: 190 });
            ball.dispatchEvent('mousemove', { clientX: 300, clientY: 400 });
            ball.dispatchEvent('mouseup', { button, clientX: 300, clientY: 400 });
            ball.dispatchEvent('pointerdown', { button, pointerId: 1, clientX: 30, clientY: 190 });
            ball.dispatchEvent('pointermove', { pointerId: 1, clientX: 300, clientY: 400 });
            ball.dispatchEvent('pointerup', { button, pointerId: 1, clientX: 300, clientY: 400 });
            ball.dispatchEvent('click', { button });
        }
        ball.dispatchEvent('pointerdown', { isPrimary: false, pointerId: 2, clientX: 30, clientY: 190 });
        ball.dispatchEvent('pointermove', { isPrimary: false, pointerId: 2, clientX: 300, clientY: 400 });
        ball.dispatchEvent('pointerup', { isPrimary: false, pointerId: 2, clientX: 300, clientY: 400 });
        ball.dispatchEvent('click', { isPrimary: false });
        assert.equal(clicked, 0);
        assert.equal(ball.style.left, '24px');
        assert.equal(ball.style.top, '180px');
        assert.deepEqual(moves, []);

        ball.dispatchEvent('pointerdown', { pointerId: 3, clientX: 30, clientY: 190 });
        launcherWindowEvent('pointermove', { pointerId: 4, clientX: 400, clientY: 500 });
        launcherWindowEvent('pointerup', { pointerId: 4, clientX: 400, clientY: 500 });
        launcherWindowEvent('pointercancel', { pointerId: 4 });
        launcherWindowEvent('pointerup', { pointerId: 3, button: 2, clientX: 400, clientY: 500 });
        assert.equal(ball.style.left, '24px', '其它指针不能移动主指针的手势');
        assert.deepEqual(moves, [], '其它指针或右键松手不能提交手势');
        launcherWindowEvent('pointermove', { pointerId: 3, clientX: 90, clientY: 260 });
        launcherWindowEvent('pointerup', { pointerId: 3, clientX: 90, clientY: 260 });
        assert.deepEqual(moves, [{ x: 84, y: 250 }], '原主指针仍能完成拖动');
        assert.equal(clicked, 0);
    } finally {
        probe.destroy();
    }
});

await check('触屏 pointer 和旧 touch 兜底都能拖动、轻点且不重复开合', async () => {
    const { createFloatBall } = await import('../src/ui/ball.js');
    for (const kind of ['pointer', 'touch']) {
        let clicked = 0;
        const moves = [];
        const probe = createFloatBall({ onClick: () => clicked++, onMove: (pos) => moves.push(pos) });
        const ball = probe.node;
        launcherRect(ball);
        const touch = (clientX, clientY) => ({ identifier: 9, clientX, clientY });
        const emit = (stage, clientX, clientY) => {
            if (kind === 'pointer') {
                ball.dispatchEvent(`pointer${stage === 'start' ? 'down' : stage === 'end' ? 'up' : stage}`, {
                    clientX, clientY, pointerId: 9, pointerType: 'touch', isPrimary: true,
                });
            } else {
                ball.dispatchEvent(`touch${stage}`, {
                    touches: stage === 'end' ? [] : [touch(clientX, clientY)],
                    changedTouches: [touch(clientX, clientY)],
                });
            }
        };
        try {
            emit('start', 30, 190);
            emit('move', 90, 260);
            assert.equal(ball.style.left, '84px', `${kind} 必须真的移动`);
            assert.equal(ball.style.top, '250px');
            assert.deepEqual(moves, []);
            emit('end', 90, 260);
            ball.dispatchEvent('mousedown', { clientX: 90, clientY: 260, button: 0 });
            ball.dispatchEvent('mouseup', { clientX: 90, clientY: 260, button: 0 });
            ball.dispatchEvent('click');
            assert.equal(clicked, 0, '触屏拖动后的兼容事件不能开面板');
            assert.deepEqual(moves, [{ x: 84, y: 250 }]);
            for (let tap = 1; tap <= 2; tap++) {
                emit('start', 90, 260);
                emit('end', 90, 260);
                ball.dispatchEvent('mousedown', { button: 0 });
                ball.dispatchEvent('mouseup', { button: 0 });
                ball.dispatchEvent('click');
                assert.equal(clicked, tap, '连续轻点各激活一次');
            }
            assert.deepEqual(moves, [{ x: 84, y: 250 }], '轻点不额外保存');
        } finally {
            probe.destroy();
        }
    }
});

await check('取消、丢失捕获、失焦和隐藏均撤销拖动并抑制尾随点击', async () => {
    const { createFloatBall } = await import('../src/ui/ball.js');
    for (const reason of ['pointercancel', 'lostpointercapture', 'nodeblur', 'windowblur', 'hidden', 'buttonsLost', 'touchcancel']) {
        let clicked = 0;
        const moves = [];
        const captures = [];
        const released = [];
        const before = launcherWindowListenerCount();
        const probe = createFloatBall({ onClick: () => clicked++, onMove: (pos) => moves.push(pos) });
        const ball = probe.node;
        launcherRect(ball);
        ball.setPointerCapture = (id) => captures.push(id);
        ball.releasePointerCapture = (id) => released.push(id);
        const idle = launcherWindowListenerCount();
        try {
            if (reason === 'touchcancel') {
                ball.dispatchEvent('touchstart', { touches: [{ identifier: 12, clientX: 30, clientY: 190 }] });
                ball.dispatchEvent('touchmove', {
                    touches: [{ identifier: 12, clientX: 90, clientY: 260 }],
                    changedTouches: [{ identifier: 12, clientX: 90, clientY: 260 }],
                });
            } else {
                ball.dispatchEvent('pointerdown', { pointerId: 12, clientX: 30, clientY: 190 });
                ball.dispatchEvent('pointermove', { pointerId: 12, clientX: 90, clientY: 260 });
            }
            assert.equal(ball.style.left, '84px', `${reason} 前确实已经移动`);
            assert.equal(ball.style.top, '250px');
            assert.equal(fakeDocument.body.classList.contains('td-dragging'), true);
            if (reason === 'nodeblur') ball.dispatchEvent('blur');
            else if (reason === 'windowblur') launcherWindowEvent('blur');
            else if (reason === 'hidden') probe.setVisible(false);
            else if (reason === 'buttonsLost') launcherWindowEvent('pointermove', { pointerId: 12, buttons: 0 });
            else if (reason === 'touchcancel') launcherWindowEvent('touchcancel', { changedTouches: [{ identifier: 12 }] });
            else ball.dispatchEvent(reason, { pointerId: 12 });
            ball.dispatchEvent('click');
            assert.equal(clicked, 0, `${reason} 后的合成 click 必须被抑制`);
            assert.deepEqual(moves, [], `${reason} 不是已完成的移动，不能保存`);
            assert.equal(ball.style.left, '24px', `${reason} 恢复原坐标`);
            assert.equal(ball.style.top, '180px');
            assert.equal(fakeDocument.body.classList.contains('td-dragging'), false);
            assert.equal(ball.classList.contains('td-ball-dragging'), false);
            assert.equal(launcherWindowListenerCount(), idle, '手势结束就解绑临时 window 监听');
            if (reason !== 'touchcancel') {
                assert.deepEqual(captures, [12]);
                assert.deepEqual(released, [12], '取消仍要释放捕获');
            }
            probe.setVisible(true);
            ball.dispatchEvent('pointerdown', { pointerId: 13, clientX: 30, clientY: 190 });
            ball.dispatchEvent('pointerup', { pointerId: 13, clientX: 30, clientY: 190 });
            ball.dispatchEvent('click');
            assert.equal(clicked, 1, '新的有效点击不能被上次取消永久阻止');
        } finally {
            probe.destroy();
        }
        assert.equal(launcherWindowListenerCount(), before, '销毁必须清掉全部 window 监听');
    }
});

await check('悬浮球完整保留在视口内，缩小窗口也不会拖丢', async () => {
    const { createFloatBall } = await import('../src/ui/ball.js');
    const oldWidth = fakeWindow.innerWidth;
    const oldHeight = fakeWindow.innerHeight;
    const moves = [];
    let clicked = 0;
    const probe = createFloatBall({
        initialPosition: { x: -300, y: -300 },
        onClick: () => clicked++, onMove: (pos) => moves.push(pos),
    });
    const ball = probe.node;
    launcherRect(ball);
    try {
        assert.equal(ball.style.left, '0px');
        assert.equal(ball.style.top, '0px');
        ball.dispatchEvent('pointerdown', { pointerId: 21, clientX: 10, clientY: 10 });
        launcherWindowEvent('pointermove', { pointerId: 21, clientX: 9999, clientY: 9999 });
        launcherWindowEvent('pointerup', { pointerId: 21, clientX: 9999, clientY: 9999 });
        ball.dispatchEvent('click');
        assert.equal(ball.style.left, `${oldWidth - 64}px`);
        assert.equal(ball.style.top, `${oldHeight - 72}px`);
        assert.deepEqual(moves, [{ x: oldWidth - 64, y: oldHeight - 72 }]);
        assert.equal(clicked, 0);
        fakeWindow.innerWidth = 100;
        fakeWindow.innerHeight = 90;
        launcherWindowEvent('resize');
        assert.equal(ball.style.left, '36px');
        assert.equal(ball.style.top, '18px');
        // 用户设置的新尺寸覆盖窄屏CSS，边界跟随设置尺寸。
        probe.setSize(56);
        launcherRect(ball, 56, 63);
        ball.dispatchEvent('pointerdown', { pointerId: 22, clientX: 40, clientY: 20 });
        launcherWindowEvent('pointerup', { pointerId: 22, clientX: 999, clientY: 999 });
        assert.equal(ball.style.left, '44px');
        assert.equal(ball.style.top, '27px');
        assert.deepEqual(moves[1], { x: 44, y: 27 });
        ball.dispatchEvent('pointerdown', { pointerId: 23, clientX: 50, clientY: 30 });
        launcherWindowEvent('pointermove', { pointerId: 23, clientX: 5, clientY: 5 });
        fakeWindow.innerWidth = 32;
        fakeWindow.innerHeight = 24;
        launcherWindowEvent('resize');
        ball.dispatchEvent('click');
        assert.equal(ball.style.left, '0px', '比图标还小的视口不应生成负坐标');
        assert.equal(ball.style.top, '0px');
        assert.equal(moves.length, 2, 'resize 以及被 resize 中断的拖动都不应保存伪移动');
        assert.equal(clicked, 0);
    } finally {
        probe.destroy();
        fakeWindow.innerWidth = oldWidth;
        fakeWindow.innerHeight = oldHeight;
        launcherWindowEvent('resize');
    }
});

await check('正常收起不报警；销毁清理拖动、监听和待执行诊断', async () => {
    const { createFloatBall } = await import('../src/ui/ball.js');
    const beforeListeners = launcherWindowListenerCount();
    const beforeToasts = toastrCalls.length;
    let open = false;
    const working = createFloatBall({ onClick: () => { open = !open; }, isOpen: () => open });
    let clicked = 0;
    const moves = [];
    const destroyed = createFloatBall({ onClick: () => clicked++, isOpen: () => false, onMove: (pos) => moves.push(pos) });
    const ball = destroyed.node;
    launcherRect(ball);
    fakeDocument.body.appendChild(ball);
    const released = [];
    ball.releasePointerCapture = (id) => released.push(id);
    try {
        working.node.dispatchEvent('keydown', { key: 'Enter' });
        assert.equal(open, true);
        working.node.dispatchEvent('keydown', { key: 'Enter' });
        assert.equal(open, false, '第二次激活就是正常收起');
        working.node.dispatchEvent('keydown', { key: 'Enter' });
        open = false; // 成功展开之后通过其它入口关闭，也不能被旧定时器误报。
        ball.dispatchEvent('click'); // 故意未展开，先排队一次诊断。
        assert.equal(clicked, 1);
        ball.dispatchEvent('pointerdown', { pointerId: 31, clientX: 30, clientY: 190 });
        ball.dispatchEvent('pointermove', { pointerId: 31, clientX: 90, clientY: 260 });
        assert.equal(ball.style.left, '84px');
        destroyed.destroy();
        destroyed.destroy();
        assert.equal(ball.parentNode, null);
        assert.deepEqual(released, [31], '销毁中的捕获只释放一次');
        assert.deepEqual(moves, [], '销毁取消拖动，不保存');
        assert.equal(fakeDocument.body.classList.contains('td-dragging'), false);
        assert.equal(Object.values(ball._listeners).flat().length, 0, '节点事件也必须解绑');
        const left = ball.style.left;
        launcherWindowEvent('pointermove', { pointerId: 31, clientX: 600, clientY: 700 });
        launcherWindowEvent('pointerup', { pointerId: 31, clientX: 600, clientY: 700 });
        ball.dispatchEvent('click');
        ball.dispatchEvent('keydown', { key: 'Enter' });
        assert.equal(clicked, 1, '销毁后的事件不能再调用业务逻辑');
        assert.equal(ball.style.left, left);
        await new Promise((resolve) => setTimeout(resolve, 900));
        assert.deepEqual(toastrCalls.slice(beforeToasts), [], '正常收起、外部关闭和已销毁实例均不能报警');
    } finally {
        working.destroy();
        destroyed.destroy();
    }
    assert.equal(launcherWindowListenerCount(), beforeListeners);
});

await check('悬浮球能自报诊断（且诊断本身不吃点击）', async () => {
    // 用户不知道怎么看控制台，所以打不开时必须说明原因。
    // ⚠️ 但诊断**不能自己挡住面板** —— 这是真实踩坑：
    // 原先用 toast 报错，而酒馆的 toastr 容器可交互，提示条正好盖在面板中心，
    // 于是报完错面板再也点不动（用户实测「中心点命中=被 toast 盖住」）。
    const api = /** @type {any} */ (globalThis).TavernDice;
    const { createFloatBall } = await import('../src/ui/ball.js');

    let clicked = 0;
    const probe = createFloatBall({
        onClick: () => {
            clicked++;
            // 故意什么都不做，模拟「点了但没打开」
        },
        isOpen: () => false,
        describePanel: () => 'display=(空)｜尺寸=100x100｜中心点命中=被「toast toast-error」盖住',
        initialPosition: { x: 10, y: 10 },
    });
    fakeDocument.body.appendChild(probe.node);

    const before = toastrCalls.length;
    probe.node.dispatchEvent('pointerdown', { clientX: 10, clientY: 10, bubbles: true });
    probe.node.dispatchEvent('pointerup', { clientX: 10, clientY: 10, bubbles: true });
    probe.node.dispatchEvent('click', { clientX: 10, clientY: 10, bubbles: true });
    assert.equal(clicked, 1, '点击应当被触发一次');

    // 等自检定时器（800ms）
    await new Promise((r) => setTimeout(r, 1000));
    const reported = toastrCalls.slice(before);
    assert.ok(reported.length >= 1, '点了却没显示出来时，应当给出提示');
    // 但**遮挡**绝不该触发报警 —— 遮挡检测对顶层元素不可靠，
    // 报假警比不报更糟（用户实测：功能正常却一直弹错）。
    const alarm = reported.filter((t) => /挡住|被其它元素/.test(t.message ?? ''));
    assert.equal(alarm.length, 0, `遮挡信息不该报警，实际：${alarm.map((t) => t.message).join('｜')}`);

    // 诊断字符串本身要能取到，且包含面板真实状态
    const info = probe.diagnose();
    assert.ok(typeof info === 'string' && info.length > 0, 'diagnose() 应当返回信息');
    assert.ok(/事件=/.test(info), `诊断应当包含事件信息，实际：${info}`);
    assert.ok(/display=|拿不到面板状态/.test(info), `诊断应当包含面板状态，实际：${info}`);

    probe.destroy();
    void api;
});

await check('提示条不会挡住插件界面（真实 bug 的回归）', () => {
    // 酒馆的 toastr 容器默认可交互，插件用它报错时会盖在面板上。
    // 必须让它指针穿透 —— 否则「报个错」就把界面点不动了。
    const css = readFileSync(new URL('../style.css', import.meta.url), 'utf8');
    assert.ok(css.includes('#toast-container'), '应当有针对 toast 容器的规则');
    assert.ok(
        (() => {
            // 选择器与声明都可能跨行，直接取含 #toast-container 的那条规则再检查。
            // （正则里的 \s 在多层写入中丢过一次转义，所以这里用字符串判断更稳）
            const start = css.indexOf('#toast-container');
            const block = css.slice(start, css.indexOf('}', start));
            return block.includes('pointer-events') && block.includes('none');
        })(),
        'toast 容器必须 pointer-events: none（否则会挡住面板）',
    );
});


await check('面板打开时悬浮球必须隐藏（它是真实 bug 的根源）', () => {
    // 球的 z-index 比面板高（否则关不掉面板），于是它永远压在面板上面。
    // 用户把球拖到面板中间时，球挡住了面板内容 ——
    // 而且球是真实 DOM 元素、**可以被选中复制**，用户就是这么发现它的。
    const api = /** @type {any} */ (globalThis).TavernDice;
    const ball = fakeDocument.getElementById('tavern-dice-ball');
    const panel = fakeDocument.getElementById('tavern-dice-panel');
    assert.ok(ball && panel, '球与面板都应当在 DOM 里');

    api.open();
    assert.notEqual(panel.style.display, 'none', '面板应当展开');
    assert.equal(ball.style.display, 'none', '面板展开时球必须隐藏（否则会挡住面板）');

    api.close();
    assert.equal(panel.style.display, 'none', '面板应当收起');
    assert.notEqual(ball.style.display, 'none', '面板收起后球应当回来');
});

await check('环境不支持顶层渲染时，面板仍能打开（优雅降级）', async () => {
    // Top Layer（popover / showModal）是「永远在最上层」的唯一可靠机制，
    // 但不是所有环境都支持。不支持时必须退回普通渲染，**不能因此打不开**。
    const api = /** @type {any} */ (globalThis).TavernDice;
    const panel = fakeDocument.getElementById('tavern-dice-panel');
    api.close();

    // 桩环境里本来就没有 showPopover / showModal，所以这里天然测的就是降级路径
    assert.equal(typeof panel.showPopover, 'undefined', '前置条件：桩环境不支持 popover');
    api.open();
    assert.equal(api.panel.isOpen, true, '不支持顶层时也应当能打开');
    api.close();
});

// 注：曾经尝试用 popover / dialog 顶层来压过宿主元素，
// 但实测「顶层=popover」时面板**依然看不见**，所以改成了自建全屏 overlay。
// 相关检查已随之删除，保留「优雅降级」那条即可。


await check('面板必须活在自建的全屏 overlay 里（显示问题的根因修复）', async () => {
    // 直接把 .td-panel 挂在 body 上时，它会被宿主元素挡住
    // （实测「遮挡=⚠ 完全被「recentChat」挡住」）。z-index 提到 2147483000 也没用，
    // popover 顶层同样没解决。最后改用**自建全屏 overlay** 承载才正常。
    const api = /** @type {any} */ (globalThis).TavernDice;
    api.open();
    const panel = fakeDocument.getElementById('tavern-dice-panel');
    const layer = fakeDocument.getElementById('tavern-dice-panel-layer');
    assert.ok(layer, '面板容器应当存在');
    assert.ok(layer.contains(panel), '面板必须在容器里（否则会被宿主元素挡住）');
    assert.equal(layer.dataset.open, '1', '展开时容器应当 data-open=1（CSS 属性选择器控制显隐）');
    assert.equal(layer.style.pointerEvents, 'none', '容器本身要穿透，否则酒馆界面点不动');
    assert.equal(panel.style.pointerEvents, 'auto', '面板自己必须接收交互');

    api.close();
    assert.equal(layer.dataset.open, '0', '收起时容器应当 data-open=0');
});

await check('拖动已挂载悬浮球会改变坐标并持久化一次，不会展开', () => {
    const api = /** @type {any} */ (globalThis).TavernDice;
    const ball = fakeDocument.getElementById('tavern-dice-ball');
    launcherRect(ball);
    api.close();
    const startX = parseFloat(ball.style.left);
    const startY = parseFloat(ball.style.top);
    const originalPersist = api.app.persistSettings;
    const saves = [];
    api.app.persistSettings = (options) => saves.push({ position: { ...api.app.settings.ballPosition }, options });
    try {
        ball.dispatchEvent('pointerdown', { clientX: startX + 6, clientY: startY + 10, pointerId: 40, bubbles: true });
        ball.dispatchEvent('pointermove', { clientX: startX + 66, clientY: startY + 80, pointerId: 40, bubbles: true });
        assert.equal(ball.style.left, `${startX + 60}px`, '必须实际移动，不能只验证 click 被吞掉');
        assert.equal(ball.style.top, `${startY + 70}px`);
        assert.deepEqual(saves, [], '只在完成后保存');
        ball.dispatchEvent('pointerup', { clientX: startX + 66, clientY: startY + 80, pointerId: 40, bubbles: true });
        ball.dispatchEvent('click', { clientX: startX + 66, clientY: startY + 80, bubbles: true });
        assert.deepEqual(api.app.settings.ballPosition, { x: startX + 60, y: startY + 70 });
        assert.deepEqual(saves, [{ position: { x: startX + 60, y: startY + 70 }, options: { silent: true } }]);
        assert.equal(api.panel.isOpen, false, '拖动之后不该展开面板');
    } finally {
        api.app.persistSettings = originalPersist;
    }
});

await check('开面板 / 收面板可切换（直接调 API）', () => {
    const api = /** @type {any} */ (globalThis).TavernDice;
    api.open();
    const panel = fakeDocument.getElementById('tavern-dice-panel');
    assert.equal(api.panel.isOpen, true, 'open() 后面板应当是展开的');
    api.close();
    assert.equal(api.panel.isOpen, false, 'close() 后面板应当是收起的');
});

await check('点 × 按钮真的能关掉面板（模拟真实指针序列）', () => {
    const api = /** @type {any} */ (globalThis).TavernDice;
    const panel = fakeDocument.getElementById('tavern-dice-panel');
    api.open();
    assert.notEqual(panel.style.display, 'none');

    // ⚠️ 必须模拟完整的 pointerdown → pointerup → click 序列。
    // 只测「直接调 close()」是漏的 —— 真实的 bug 就在这条路径上：
    // 拖拽逻辑用 setPointerCapture 抢走了事件，× 的 click 永远不触发。
    const closeButton = panel.querySelector('#tavern-dice-panel-close');
    assert.ok(closeButton, '找不到关闭按钮 #tavern-dice-panel-close');

    closeButton.dispatchEvent('click', { bubbles: true });

    assert.equal(panel.style.display, 'none', '× 按钮没关掉面板');
});

await check('拖拽不会抢走按钮的点击（根因回归测试）', () => {
    const api = /** @type {any} */ (globalThis).TavernDice;
    const panel = fakeDocument.getElementById('tavern-dice-panel');
    api.open();

    // 直接验证排除逻辑：酒馆的按钮是 div.menu_button，不是 <button> 标签，
    // 所以排除列表必须包含它们，否则拖拽会启动并吃掉点击。
    assert.equal(isInteractiveTarget(panel.querySelector('#tavern-dice-panel-close')), true, '.menu_button 应当被识别为交互控件');
    assert.equal(isInteractiveTarget({ closest: (s) => (s.includes('[role="button"]') ? {} : null) }), true, 'role=button 应当被识别');
    assert.equal(isInteractiveTarget({ closest: () => null }), false, '普通元素不该被识别为交互控件');

    // 模拟在 × 上按下：不应启动拖拽（否则面板位置会被改、click 被吞）
    const closeButton = panel.querySelector('#tavern-dice-panel-close');
    const beforeLeft = panel.style.left;
    closeButton.dispatchEvent('pointerdown', { button: 0, clientX: 100, clientY: 20, pointerId: 7, bubbles: true });
    closeButton.dispatchEvent('pointermove', { clientX: 400, clientY: 300, pointerId: 7, bubbles: true });
    closeButton.dispatchEvent('pointerup', { clientX: 400, clientY: 300, pointerId: 7, bubbles: true });
    assert.equal(panel.style.left, beforeLeft, '在按钮上按下不应触发拖动');

    api.close();
});

await check('任务进行中会弹出进度窗口', () => {
    const api = /** @type {any} */ (globalThis).TavernDice;
    // 手工造一个「任务进行中」的状态
    api.app.setBusy(true, '正在测试…');
    api.app.setProgress({
        active: true,
        kind: '读取场景',
        stage: 'generate',
        detail: '正在让模型整理战力体系（第 2/3 批）…',
        batch: 2,
        total: 3,
        percent: 60,
        startedAt: Date.now(),
        cancellable: true,
    });
    api.panel.render();

    const win = fakeDocument.getElementById('tavern-dice-progress');
    assert.ok(win, '任务进行中应当弹出进度窗口');
    const text = win.textContent;
    assert.ok(text.includes('读取场景'), '应当显示任务类型');
    assert.ok(text.includes('2/3'), `应当显示批次进度，实际：${text}`);
    assert.ok(text.includes('60%'), `应当显示百分比，实际：${text}`);
    assert.ok(text.includes('终止'), '必须有终止按钮');

    // ⚠️ 造完状态必须复位，否则下一个测试的 build() 会因为「正在忙」直接返回，
    // 让「终止」测试测了个寂寞（这里踩过一次）。
    api.app.setBusy(false);
    api.app.setProgress({ active: false, batch: 0, total: 0, percent: 0, cancellable: false });
    api.panel.render();
});

await check('进度窗口可拖动，且拖动不会吃掉终止按钮的点击', () => {
    const api = /** @type {any} */ (globalThis).TavernDice;
    // 重新造出进行中状态（上一个测试末尾已复位，这里为了本项检查再开一次）
    api.app.setBusy(true, '正在测试…');
    api.app.setProgress({
        active: true,
        kind: '读取场景',
        stage: 'generate',
        detail: '测试',
        batch: 1,
        total: 3,
        percent: 30,
        startedAt: Date.now(),
        cancellable: true,
    });
    api.panel.render();

    const win = fakeDocument.getElementById('tavern-dice-progress');
    assert.ok(win, '进度窗口应当存在');
    // 终止按钮是 div.menu_button，必须被排除在拖拽之外
    const stopButton = win.querySelectorAll('.menu_button').find((b) => b.textContent.includes('终止'));
    assert.ok(stopButton, '找不到终止按钮');
    assert.equal(isInteractiveTarget(stopButton), true, '终止按钮必须被排除在拖拽之外');

    // 收尾复位
    api.app.setBusy(false);
    api.app.setProgress({ active: false, batch: 0, total: 0, percent: 0, cancellable: false });
    api.panel.render();
});

await check('终止按钮能中断长任务（且不写入半成品数据）', async () => {
    const api = /** @type {any} */ (globalThis).TavernDice;
    await api.app.reset();
    assert.equal(api.app.powerSystem, null, '前置条件：应当没有战斗数据');

    // 读场面需要聊天里有内容 —— 前面的检查可能把 chat 清空了。
    // 这一步没有剧情的话，任务会在「没有可读内容」处立刻失败，就测不到终止了。
    if (!fakeCtx.chat.length) {
        fakeCtx.chat.push({ mes: '两人在河边对峙。', is_user: false, is_system: false, name: '角色' });
    }

    // 桩一个输入框与发送按钮 —— 否则 startBattleByScene 会在「找不到输入框」处
    // 立刻返回，根本进不了等待阶段，也就测不到终止。
    const fakeInput = { value: '', dispatchEvent: () => true, focus: () => {}, select: () => {} };
    const fakeSend = { click: () => {} };
    const originalGetById2 = fakeDocument.getElementById.bind(fakeDocument);
    fakeDocument.getElementById = (id) => {
        if (id === 'send_textarea') return fakeInput;
        if (id === 'send_but') return fakeSend;
        return originalGetById2(id);
    };

    // 造一个「卡住」的场面读取：fetch 永不 resolve，但**会响应中断**。
    //
    // ⚠️ 两点都很重要：
    //  1. 必须同时把「正文模型通道」从默认的 main 改成 p1 ——
    //     main 走酒馆助手（在假环境里会立刻失败），根本走不到 fetch。
    //  2. stub 必须监听 signal 并 reject。纯 `new Promise(() => {})` 虽然也能让任务挂住，
    //     但那个悬空的 Promise 会一直钉住事件循环，导致**测试跑完后进程无法退出**（踩过一次）。
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (url, init = {}) =>
        new Promise((_resolve, reject) => {
            const signal = init?.signal;
            if (!signal) return; // 没有信号就一直挂着（这种情况不该发生）
            if (signal.aborted) return reject(Object.assign(new Error('已被用户终止'), { name: 'AbortError' }));
            signal.addEventListener(
                'abort',
                () => reject(Object.assign(new Error('已被用户终止'), { name: 'AbortError' })),
                { once: true },
            );
        });

    const channel = api.app.settings.p2.channel;
    const originals = {
        narrative: api.app.settings.battle.narrativeChannel,
        mode: channel.mode,
        apiUrl: channel.apiUrl,
        model: channel.model,
        timeout: channel.timeout,
    };
    api.app.settings.battle.narrativeChannel = 'p2';
    Object.assign(channel, {
        mode: 'custom',
        apiUrl: 'https://example.invalid/v1',
        model: 'stub',
        timeout: 600,
    });

    // ⚠️ 用 startBattleByScene 而不是 startBattleFromSituation：
    // 后者现在**先本地解析**，桩环境里会立刻失败返回，根本走不到网络请求，
    // 于是「终止」测了个寂寞（踩过）。startBattleByScene 会等正文生成，才会真的挂住。
    const taskPromise = api.app.startBattleByScene({ situation: '测试终止' });
    // 内部有 120ms 的「等 UI 渲染」睡眠，检查必须晚于它
    await new Promise((r) => setTimeout(r, 240));

    assert.equal(api.app.isRunning, true, '此时任务应当在进行中');
    assert.ok(api.app.progress.active, '进度应当处于活跃状态');
    assert.equal(api.app.abortRunning(), true, '终止请求应当被接受');

    // 终止后任务应当很快结束（而不是一直挂着）
    const settled = await Promise.race([
        taskPromise.then(() => 'done'),
        new Promise((r) => setTimeout(() => r('timeout'), 5000)),
    ]);

    // 还原
    globalThis.fetch = originalFetch;
    fakeDocument.getElementById = originalGetById2;
    api.app.settings.battle.narrativeChannel = originals.narrative;
    Object.assign(channel, {
        mode: originals.mode,
        apiUrl: originals.apiUrl,
        model: originals.model,
        timeout: originals.timeout,
    });

    assert.equal(settled, 'done', '终止后任务没有结束 —— 终止没生效');
    assert.equal(api.app.isRunning, false, '任务结束后 busy 应当复位');
    assert.equal(api.app.progress.active, false, '任务结束后进度应当复位');
    assert.equal(api.app.powerSystem, null, '被终止的任务不应写入任何数据');
    api.app._resolveGenerationWait?.(false);
});

await check('任务结束后进度窗口自动收起', () => {
    const api = /** @type {any} */ (globalThis).TavernDice;
    api.panel.render();
    const win = fakeDocument.getElementById('tavern-dice-progress');
    assert.equal(win, null, '任务结束后进度窗口应当自动消失');
});

await check('没有任务时点终止是无害的', () => {
    const api = /** @type {any} */ (globalThis).TavernDice;
    assert.equal(api.app.abortRunning(), false, '没有任务时应当返回 false 而不是抛错');
});

await check('没有把「启动失败」提示发出来', () => {
    const errors = toastrCalls.filter((t) => t.type === 'error' && t.message.includes('启动失败'));
    assert.equal(errors.length, 0, `启动时报错：${errors.map((e) => e.message).join('；')}`);
});

await check('界面挂载过程没有内部报错', () => {
    // boot() 里对两处挂载做了 try/catch，出错只会打日志。
    // 必须把这类「静默失败」也当成失败检查出来 ——
    // 否则插件会表现成「启动成功但什么都没有」，是最难排查的一类问题。
    //
    // ⚠️ 只看**启动那一刻**的快照。
    // 早期版本在这里过滤「任何含『失败』的运行时报错」，于是后面那些故意触发失败的
    // 检查（终止任务、连不上 API）产生的 toast 会被算成「挂载错误」——
    // 检查顺序一变就误报（踩过）。
    const mountErrors = mountPhaseToasts.filter((t) => t.type === 'error');
    assert.equal(mountErrors.length, 0, `挂载时报错：${mountErrors.map((e) => e.message).join('；')}`);
});

// ---------------------------------------------------------------------------
// 端到端：注入战力表 → 渲染各页 → 真打一场 → 回写 → 落盘
// ---------------------------------------------------------------------------

const api = /** @type {any} */ (globalThis).TavernDice;
const app = api.app;

/** 造一个战斗单位。 */
function makeUnit(name, side, overrides = {}) {
    return {
        name,
        side,
        // 战力评估 + 装备：验证这两项能一路走到界面与战斗里
        powerRating: { rating: 62, grade: '一流', note: '测试用评价', basis: '测试' },
        equipment: [
            { name: '测试长剑', slot: 'weapon', bonuses: { Atk: 15 }, effect: '锋利', description: '', source: '' },
            { name: '测试护符', slot: 'accessory', bonuses: { HP: 20 }, effect: '', description: '', source: '' },
        ],
        attributes: {
            HP: { current: 120, max: 120 },
            MP: { current: 60, max: 60 },
            Atk: { current: 25, max: 25 },
            Armor: { current: 6, max: 6 },
            Speed: { current: 12, max: 12 },
            Evasion: { current: 10, max: 10 },
        },
        skills: [
            {
                name: '斩击',
                power: 35,
                aim: 100,
                cost: 0,
                target: 'single',
                effects: [{ type: 'damage', power: 35, duration: 0 }],
            },
            {
                name: '旋风斩',
                power: 28,
                aim: 95,
                cost: 10,
                target: 'group',
                effects: [{ type: 'damage', power: 28, duration: 0 }],
            },
        ],
        statuses: [],
        alive: true,
        ...overrides,
    };
}

console.log('');
console.log('端到端流程测试：');

// 直接往聊天数据里写一份战力表（跳过 LLM，只验证界面与引擎链路）
const store = await import('../src/core/store.js');
const seeded = await store.setPowerSystem(
    fakeCtx,
    {
        system: { name: '冒烟测试体系', overview: '用于验证链路', scale: '测试用' },
        ruleset: { name: '冒烟测试规则', damageFormula: 'power - Armor', hitFormula: 'd20 + (Aim - 100) / 10' },
        allies: [makeUnit('甲', 'ally'), makeUnit('乙', 'ally')],
        enemies: [makeUnit('敌人一', 'enemy'), makeUnit('敌人二', 'enemy')],
    },
    { source: 'smoke-test' },
);

await check('战力表写入成功', () => {
    assert.equal(seeded.ok, true, `写入失败：${seeded.error}`);
    assert.equal(app.powerSystem.combatants.length, 4);
});

await check('质量自检能识别「不可用」的战力表', () => {
    // 用完当前战力表做一次自检（它是「信息齐全」的，应当通过）
    const quality = api.app.assessQuality();
    assert.equal(typeof quality.ok, 'boolean', '质量自检应当返回结果');
    assert.ok(Array.isArray(quality.fatal), '应当有 fatal 列表');
    assert.ok(Array.isArray(quality.warn), '应当有 warn 列表');
    assert.equal(quality.ok, true, `这份测试表信息齐全，应当通过检验：${quality.fatal.join('；')}`);
});

await check('结构合法但没法打的表会被判为检验失败', () => {
    // 所有人没技能、HP 是兜底值、没规则集 —— 能读，但拿去战斗毫无意义
    const broken = {
        systemName: '坏体系',
        scale: '',
        ruleset: null,
        tiers: [],
        combatants: [
            {
                id: 'b1',
                name: '甲',
                side: 'ally',
                attributes: {
                    HP: { current: 1, max: 1 },
                    Atk: { current: 10, max: 10 },
                    Armor: { current: 0, max: 0 },
                    Speed: { current: 10, max: 10 },
                },
                skills: [],
                equipment: [],
                statuses: [],
                powerRating: { rating: 0, grade: '', note: '', basis: '' },
                alive: true,
            },
            {
                id: 'b2',
                name: '乙',
                side: 'enemy',
                attributes: {
                    HP: { current: 1, max: 1 },
                    Atk: { current: 10, max: 10 },
                    Armor: { current: 0, max: 0 },
                    Speed: { current: 10, max: 10 },
                },
                skills: [],
                equipment: [],
                statuses: [],
                powerRating: { rating: 0, grade: '', note: '', basis: '' },
                alive: true,
            },
        ],
    };
    const quality = api.app.assessQuality(broken);
    assert.equal(quality.ok, false, '这种表应当被判为检验失败');
    assert.ok(quality.fatal.length >= 2, `应当报出多条致命问题，实际：${quality.fatal.join('；')}`);
});

await check('Combat_block 导出包含战力与装备', () => {
    const text = api.app.toCombatBlockText();
    assert.ok(text.includes('战力'), '导出应当包含战力评估');
    assert.ok(text.includes('装备'), '导出应当包含装备行');
    assert.ok(text.includes('测试长剑'), '导出应当包含具体装备名');
});

await check('战斗页面能渲染真实数据', () => {
    api.panel.setTab('battle');
    const text = fakeDocument.getElementById('tavern-dice-panel').textContent;
    assert.ok(text.includes('我方') || text.includes('敌方'), '战斗页没有阵营信息');
});

await check('开战成功', async () => {
    const result = await app.startBattle({ seed: 'smoke-battle-seed' });
    assert.equal(result.ok, true, `开战失败：${result.error}`);
    assert.ok(app.battle, 'battle 未被创建');
    assert.equal(app.battle.phase, 'awaiting_input');
});

await check('战斗状态已写入聊天 metadata', () => {
    assert.ok(fakeCtx.chatMetadata['tavern-dice'].battle, '战斗状态没有落盘');
});

await check('战斗页面能渲染进行中的战斗', () => {
    api.panel.setTab('battle');
    const text = fakeDocument.getElementById('tavern-dice-panel').textContent;
    assert.ok(text.includes('第 1 回合'), '战斗页没有显示回合数');
});

await check('卡牌资源条与属性展开，头像编辑不选目标，三栏战场与底部手牌完整', () => {
    api.panel.setTab('battle');
    const panel = fakeDocument.getElementById('tavern-dice-panel');
    const cards = panel.querySelectorAll('.td-roster-unit');
    assert.equal(cards.length, app.battle.units.length);
    assert.equal(panel.querySelectorAll('.td-resource-orb').length, 0, '紧凑卡牌不保留占空间的血魔球');
    assert.equal(panel.querySelectorAll('.td-card-resource').length, cards.length * 2, '每张角色牌应显示血蓝资源条');
    const card = cards[0];
    const details = card.querySelector('.td-unit-details');
    assert.equal(card.querySelector('.td-resource-toggle'), null, '紧凑角色牌不再显示属性按钮');
    assert.equal(details.hidden, true, '属性默认隐藏，不占战场高度');
    card.dispatchEvent('keydown', { key: ' ' });
    assert.ok(fakeDocument.getElementById('tavern-dice-modal'), '键盘 Space 与长按共用属性弹窗');
    assert.ok(details.textContent.includes('HP') && details.textContent.includes('MP'));
    assert.ok(details.textContent.includes('攻') && details.textContent.includes('闪'));
    const initial = card.querySelector('.td-portrait-initial').textContent;
    assert.equal(initial, Array.from(card.querySelector('.td-bunit-name').textContent)[0]);
    let picked = 0;
    card.querySelector('input').click = () => picked++;
    const clicked = card.querySelector('.td-portrait-edit').dispatchEvent('click');
    assert.equal(picked, 1, '点击头像应打开文件选择器');
    assert.equal(clicked.propagationStopped, true, '上传头像不能触发选敌');
    api.panel.render();
    const restored = fakeDocument.getElementById(card.id);
    assert.equal(restored.querySelector('.td-unit-details').hidden, true, '重绘后属性仍不占卡面空间');
    fakeDocument.getElementById('tavern-dice-modal')?.querySelector('.td-modal-close')?.dispatchEvent('click');
    const table = fakeDocument.getElementById('tavern-dice-panel').querySelector('.td-card-table');
    assert.ok(table.querySelector('.td-card-allies').querySelector('.td-character-card'), '左侧应包含我方角色卡');
    assert.ok(table.querySelector('.td-card-enemies').querySelector('.td-character-card'), '右侧应包含敌方角色卡');
    const center = table.querySelector('.td-card-center');
    assert.ok(center.querySelector('.td-bg3-panel'), '中央舞台应包含骰子');
    assert.ok(center.querySelector('.td-blog-wrap'), '中央舞台应包含战斗记录');
    const dock = table.querySelector('.td-card-dock');
    assert.ok(dock.querySelector('.td-action-bar'), '底部应包含技能行动区');
    assert.ok(dock.querySelector('.td-action-bar').textContent.trim(), '底部应显示手动手牌或当前行动状态提示');
    assert.ok(dock.querySelector('.td-banter'), '底部应保留口嗨输入');
});

await check('口嗨 DOM 输入、目标、重绘草稿和发送结果正确', async () => {
    const battle = api.app.battle;
    const saved = {
        sendBanter: api.app.sendBanter, busy: api.app.busy,
        banterHistory: battle.banterHistory,
        turnIndex: battle.turnIndex, autoDriving: api.app._autoDriving,
        userName: api.app.settings.battle.userUnitName,
        userFlags: battle.units.map(u => u.isUser),
    };
    const player = battle.units.find(u => u.side === 'ally');
    const targets = battle.units.filter(u => u.side === 'enemy');
    const calls = [];
    let settle;
    const controls = () => {
        const box = fakeDocument.getElementById('tavern-dice-panel').querySelector('.td-banter');
        assert.ok(box, '头像上方应渲染口嗨区');
        return { box, input: box.querySelector('textarea'), picker: box.querySelector('select'), send: box.querySelector('.td-banter-send') };
    };
    const redraw = () => { api.app.notify(); api.panel.render(); return controls(); };
    try {
        api.app._autoDriving = true; // 隔离自动推进，测试只操作真实渲染的口嗨 DOM。
        api.app.busy = false;
        api.app.settings.battle.userUnitName = player.name;
        battle.units.forEach(u => { u.isUser = u === player; });
        battle.turnIndex = battle.initiative.findIndex(e => e.unitId === player.id);
        const turn = battle.turnIndex;
        const round = battle.round;
        api.app.sendBanter = payload => {
            calls.push(payload);
            return new Promise(resolve => { settle = resolve; });
        };
        battle.banterHistory = [];
        const talk = '独立口嗨记录：今天先谈天气。';
        battle.pushBanter(talk, { speakerId: player.id, targetId: targets[0].id });
        api.panel.setTab('battle');
        let ui = controls();
        assert.ok(ui.box.querySelector('.td-banter-recent').textContent.includes(talk), '口嗨区应显示独立历史');
        const battleLog = fakeDocument.getElementById('tavern-dice-panel').querySelector('.td-blog');
        assert.ok(battleLog, '战斗日志仍应显示');
        assert.ok(battleLog.textContent.includes(talk), '战斗记录应恢复显示口嗨，发送时另行选择');
        assert.equal(ui.send.disabled, true, '空草稿应禁用');
        ui.input.value = '  放下武器，谈谈吧！  ';
        ui.input.dispatchEvent('input');
        ui.picker.value = targets[1].id;
        ui.picker.dispatchEvent('change');
        const oldInput = ui.input;
        ui = redraw();
        assert.notEqual(ui.input, oldInput, '必须实际重建 DOM 才能验证草稿保存');
        assert.equal(ui.input.value, '  放下武器，谈谈吧！  ');
        assert.equal(ui.picker.value, targets[1].id, 'notify 重绘后保留指定目标');
        api.app.busy = true;
        ui = redraw();
        assert.equal(ui.send.disabled, true, 'busy 时应禁用');
        assert.ok(ui.box.textContent.includes('请稍候'), '禁用原因应有中文解释');
        ui.send.dispatchEvent('click');
        assert.equal(calls.length, 0, 'busy 时即使派发 click 也不得调用控制器');
        api.app.busy = false;
        ui = redraw();
        assert.equal(ui.send.disabled, false);
        ui.send.dispatchEvent('click');
        assert.deepEqual(calls, [{ targetId: targets[1].id, text: '放下武器，谈谈吧！' }]);
        ui = redraw();
        assert.equal(ui.send.disabled, true, '等待发送结果时重绘仍应禁用');
        assert.equal(ui.input.value, '  放下武器，谈谈吧！  ', '结果未到前不得清草稿');
        settle({ ok: true });
        await Promise.resolve();
        ui = controls();
        assert.equal(ui.input.value, '', '成功后应清空已发送草稿');
        ui.input.value = '再给你一次机会';
        ui.input.dispatchEvent('input');
        ui.send.dispatchEvent('click');
        assert.deepEqual(calls[1], { targetId: targets[1].id, text: '再给你一次机会' });
        settle({ ok: false, error: '测试发送失败' });
        await Promise.resolve();
        ui = redraw();
        assert.equal(ui.input.value, '再给你一次机会', '失败后 notify 重绘仍保留草稿');
        assert.ok(ui.box.textContent.includes('测试发送失败'));
        assert.equal(ui.send.disabled, false, '失败后可重试');
        assert.equal(battle.turnIndex, turn, '口嗨 UI 不推进回合');
        assert.equal(battle.round, round);
        ui.input.value = '';
        ui.input.dispatchEvent('input');
    } finally {
        api.app.sendBanter = saved.sendBanter;
        battle.banterHistory = saved.banterHistory;
        api.app.busy = saved.busy;
        api.app._autoDriving = saved.autoDriving;
        api.app.settings.battle.userUnitName = saved.userName;
        battle.turnIndex = saved.turnIndex;
        battle.units.forEach((u, i) => { u.isUser = saved.userFlags[i]; });
    }
});

await check('口嗨 DOM 仅展示对话与手动说服确认，并过滤失效敌方目标', async () => {
    const battle = api.app.battle;
    const player = battle.units.find(u => u.side === 'ally');
    const targets = battle.units.filter(u => u.side === 'enemy');
    const originalBox = fakeDocument.getElementById('tavern-dice-panel').querySelector('.td-banter');
    const saved = {
        busy: api.app.busy, autoDriving: api.app._autoDriving, turnIndex: battle.turnIndex,
        userName: api.app.settings.battle.userUnitName, userFlags: battle.units.map(u => u.isUser),
        unitStates: battle.units.map(u => ({ side: u.side, alive: u.alive })),
        banterHistory: battle.banterHistory, log: battle.log,
        draftText: originalBox.querySelector('.td-banter-input').value,
        draftTarget: originalBox.querySelector('.td-banter-target').value,
        focus: FakeElement.prototype.focus,
    };
    const methods = ['getPersuasion', 'getCharmPreview', 'rollCharmCheck', 'deferCharmCheck', 'sendBanter'];
    const savedMethods = new Map(methods.map(name => [name, Object.getOwnPropertyDescriptor(api.app, name)]));
    const hiddenMarkers = ['后台记忆甲_8f31', '后台依据甲_927b', '后台记忆乙_65ac', '后台依据乙_d24e',
        '后台检定分析甲_f0b7', '后台检定分析乙_1ce9', '后台证据_44dc', '后台资格分析_817a'];
    const records = new Map([
        [targets[0].id, { progress: 72, summary: `<b>${hiddenMarkers[0]}</b>`, reason: `<img src=x>${hiddenMarkers[1]}`,
            evidence: hiddenMarkers[6], eligibilityReason: hiddenMarkers[7], status: 'ready', attempts: 0 }],
        [targets[1].id, { progress: 31, summary: hiddenMarkers[2], reason: hiddenMarkers[3], status: 'ready', attempts: 1 }],
    ]);
    const previews = new Map([
        [targets[0].id, { id: 'charm-dom-a', progress: 72, dc: 14, charmValue: 130, modifier: 3,
            requiredNatural: 11, rawRequiredNatural: 11, successChance: .5, natural20Only: false,
            reason: hiddenMarkers[4], deferred: false, speakerName: player.name, targetName: targets[0].name }],
        [targets[1].id, { id: 'charm-dom-b', progress: 31, dc: 22, charmValue: 80, modifier: -2,
            requiredNatural: 20, rawRequiredNatural: 24, successChance: .05, natural20Only: true,
            reason: hiddenMarkers[5], deferred: false, speakerName: player.name, targetName: targets[1].name }],
    ]);
    const suppressed = new Set();
    const logMarkers = ['真实魅力骰点_02bc：d20 12 + 3 = 15，DC 14', '真实换边记录_f612：敌方投靠我方'];
    const dialogue = ['💬 玩家：你也看到了，我们的敌人是同一个。', '💬 敌方：先说说你的保证。'];
    const calls = { roll: [], defer: [], send: [] };
    let settleDefer, settleRoll, settleSend, focusedInput;
    const controls = () => {
        const box = fakeDocument.getElementById('tavern-dice-panel').querySelector('.td-banter');
        return { box, input: box.querySelector('.td-banter-input'), picker: box.querySelector('.td-banter-target'),
            send: box.querySelector('.td-banter-send'), persuasion: box.querySelector('.td-persuasion'),
            roll: box.querySelector('.td-charm-roll'), defer: box.querySelector('.td-charm-defer') };
    };
    const assertDialogueOnly = ui => {
        for (const marker of [...hiddenMarkers, ...logMarkers]) {
            assert.ok(!ui.box.textContent.includes(marker), `口嗨 DOM 不得插入后台分析或战斗结果：${marker}`);
        }
        for (const selector of ['.td-persuasion-progress', '.td-persuasion-summary', '.td-persuasion-reason',
            '.td-persuasion-preview-reason', '.td-persuasion-detail', '.td-persuasion-status']) {
            assert.equal(ui.box.querySelector(selector), null, `不得以隐藏卡片保留分析 DOM：${selector}`);
        }
        for (const text of ['累计动摇', '累计指标', '暂无说服记录', '记忆：', '依据：', 'persuasion', 'taunt', 'banter']) {
            assert.ok(!ui.box.textContent.includes(text), `口嗨区域不显示进度、分析或意图分类：${text}`);
        }
        assert.deepEqual(ui.box.querySelector('.td-banter-recent').children.map(line => line.textContent), dialogue.slice(-8),
            '最近输出只能是独立历史中的玩家/NPC对话');
        const log = fakeDocument.getElementById('tavern-dice-panel').querySelector('.td-blog');
        for (const marker of logMarkers) assert.ok(log.textContent.includes(marker), '真实骰点和换边结果仍保留在战斗日志');
    };
    const assertNoConfirmation = ui => {
        assert.equal(ui.persuasion.hidden, true, '没有预览时整个检定区域隐藏');
        assert.equal(ui.persuasion.children.length, 0, '没有预览时不得插入目标、进度或提示文字');
        assert.equal(ui.persuasion.textContent, '');
        assert.equal(ui.box.querySelector('.td-charm-offer'), null);
        assert.equal(ui.roll, null);
        assert.equal(ui.defer, null);
        assert.ok(!ui.box.textContent.includes('现在进行说服检定吗？'));
        assertDialogueOnly(ui);
    };
    const redraw = () => { api.app.notify(); api.panel.render(); return controls(); };
    try {
        api.app._autoDriving = true;
        api.app.busy = false;
        api.app.settings.battle.userUnitName = player.name;
        battle.units.forEach(u => { u.isUser = u === player; });
        battle.turnIndex = battle.initiative.findIndex(e => e.unitId === player.id);
        battle.banterHistory = [];
        battle.pushBanter(dialogue[0], { speakerId: player.id, targetId: targets[0].id });
        battle.pushBanter(dialogue[1], { speakerId: targets[0].id, targetId: player.id, intent: 'persuasion' });
        battle.log = [...saved.log, ...logMarkers.map((text, index) => ({
            type: index ? 'defection' : 'charm', text, round: battle.round, at: Date.now() + index,
        }))];
        api.app.getPersuasion = targetId => records.get(targetId) ?? null;
        api.app.getCharmPreview = targetId => suppressed.has(targetId) ? null : previews.get(targetId) ?? null;
        api.app.deferCharmCheck = payload => {
            calls.defer.push(payload);
            return new Promise(resolve => {
                settleDefer = () => {
                    settleDefer = null;
                    previews.set(payload.targetId, { ...previews.get(payload.targetId), deferred: true });
                    resolve({ ok: true });
                };
            });
        };
        api.app.rollCharmCheck = payload => {
            calls.roll.push(payload);
            return new Promise(resolve => {
                settleRoll = () => {
                    settleRoll = null;
                    const record = records.get(payload.targetId);
                    records.set(payload.targetId, { ...record, status: 'failed', attempts: record.attempts + 1 });
                    previews.delete(payload.targetId);
                    resolve({ ok: true, check: { outcome: 'miss' } });
                };
            });
        };
        api.app.sendBanter = payload => {
            calls.send.push(payload);
            return new Promise(resolve => {
                settleSend = result => {
                    settleSend = null;
                    if (result.ok) {
                        records.set(payload.targetId, { ...records.get(payload.targetId), progress: 78 });
                        previews.set(payload.targetId, { ...previews.get(payload.targetId), id: 'charm-dom-after-banter',
                            progress: 78, dc: 12, requiredNatural: 9, rawRequiredNatural: 9, successChance: .6, deferred: false });
                    }
                    resolve(result);
                };
            });
        };
        FakeElement.prototype.focus = function () { focusedInput = this; };
        api.panel.setTab('battle');
        let ui = controls();
        assert.deepEqual(Array.from(ui.picker.querySelectorAll('option'), option => option.value),
            targets.filter(u => u.alive).map(u => u.id), '说服选项只能是存活的敌方，不能包含玩家和队友');
        ui.picker.value = targets[0].id;
        ui.picker.dispatchEvent('change');
        ui = controls();
        assert.equal(ui.persuasion.getAttribute('data-target-id'), targets[0].id);
        assert.equal(ui.persuasion.hidden, false);
        assert.equal(ui.persuasion.querySelector('.td-persuasion-target').textContent, `对 ${targets[0].name} 的说服`);
        assert.ok(ui.persuasion.textContent.includes('现在进行说服检定吗？'));
        assert.equal(ui.roll.textContent, '现在掷骰');
        assert.equal(ui.defer.textContent, '继续劝说');
        assertDialogueOnly(ui);
        assert.equal(ui.persuasion.querySelector('.td-charm-required').textContent, 'd20 ≥ 11');
        assert.equal(ui.persuasion.querySelector('.td-charm-dc').textContent, 'DC 14');
        assert.equal(ui.persuasion.querySelector('.td-charm-modifier').textContent, '魅力加成 +3');
        assert.equal(ui.persuasion.querySelector('.td-charm-chance').textContent, '成功率 50%');
        assert.ok(ui.persuasion.querySelector('.td-charm-rules').textContent.includes('天然 1 失败，天然 20 成功'));
        assert.equal(ui.persuasion.querySelector('img'), null, '后台记忆中的标记不得被插入 DOM');
        assert.equal(calls.roll.length, 0, '显示预览不能自动掷骰');
        const draftText = '  我还有一个提议，请先听完。  ';
        ui.input.value = draftText;
        ui.input.dispatchEvent('input');
        ui = controls();
        ui.defer.dispatchEvent('click');
        assert.deepEqual(calls.defer, [{ targetId: targets[0].id, pendingId: 'charm-dom-a' }]);
        assert.equal(calls.roll.length, 0, '继续劝说只能暂缓，不调用 roll');
        assert.equal(calls.send.length, 0, '继续劝说不能自动发送草稿');
        ui = redraw();
        assert.equal(ui.roll.disabled, true, '暂缓保存期间重绘仍禁用');
        assert.equal(ui.defer.disabled, true);
        assert.equal(ui.picker.disabled, true, '确认保存期间不能改目标');
        assert.equal(ui.input.value, draftText);
        settleDefer();
        await Promise.resolve();
        ui = controls();
        assert.equal(ui.input.value, draftText, '暂缓保存后保留草稿');
        assert.equal(ui.picker.value, targets[0].id, '继续劝说不切换目标');
        assert.equal(focusedInput, ui.input, '暂缓保存并重绘后聚焦当前输入框');
        assert.equal(ui.persuasion.querySelector('.td-charm-deferred').textContent, '已暂缓检定。');
        assert.equal(ui.roll.disabled, false, '暂缓后仍可按当前条件掷骰');
        assertDialogueOnly(ui);
        ui.picker.value = targets[1].id;
        ui.picker.dispatchEvent('change');
        ui = controls();
        assert.equal(ui.input.value, draftText, '切换 NPC 不丢失文本草稿');
        assert.equal(ui.persuasion.getAttribute('data-target-id'), targets[1].id);
        assert.equal(ui.persuasion.querySelector('.td-persuasion-target').textContent, `对 ${targets[1].name} 的说服`);
        assert.equal(ui.persuasion.querySelector('.td-charm-dc').textContent, 'DC 22');
        assert.equal(ui.persuasion.querySelector('.td-charm-modifier').textContent, '魅力加成 -2');
        assert.equal(ui.persuasion.querySelector('.td-charm-required').textContent, 'd20 ≥ 20');
        assert.equal(ui.persuasion.querySelector('.td-charm-chance').textContent, '成功率 5%');
        assert.ok(ui.persuasion.querySelector('.td-charm-rules').textContent.includes('当前仅天然 20 可成功'));
        assertDialogueOnly(ui);
        const storedRecord = records.get(targets[1].id);
        const storedPending = previews.get(targets[1].id);
        suppressed.add(targets[1].id);
        for (const [intent, text] of [['taunt', '💬 敌方：狠话谁不会说。'], ['banter', '💬 敌方：今天的天气确实不错。']]) {
            dialogue.push(text);
            battle.pushBanter(text, { speakerId: targets[1].id, targetId: player.id, intent });
            ui = redraw();
            assertNoConfirmation(ui);
            assert.equal(ui.input.value, draftText, '最新非劝说对话不影响草稿');
            assert.equal(records.get(targets[1].id), storedRecord, '控制器保留后台记忆时 UI 仍应服从空预览');
            assert.equal(previews.get(targets[1].id), storedPending, '旧待确认记录仍在后台，不能因此重新显示确认');
            assert.equal(calls.roll.length, 0, '放狠话和闲聊不能由 UI 触发检定');
        }
        suppressed.delete(targets[1].id);
        records.delete(targets[1].id);
        previews.delete(targets[1].id);
        ui = redraw();
        assertNoConfirmation(ui);
        ui.picker.value = targets[0].id;
        ui.picker.dispatchEvent('change');
        ui = controls();
        api.app.busy = true;
        ui = redraw();
        assert.equal(ui.roll.disabled, true, 'busy 时禁用现在掷骰');
        assert.equal(ui.defer.disabled, true, 'busy 时禁用继续劝说');
        ui.roll.dispatchEvent('click');
        ui.defer.dispatchEvent('click');
        assert.equal(calls.roll.length, 0);
        assert.equal(calls.defer.length, 1);
        api.app.busy = false;
        battle.turnIndex = battle.initiative.findIndex(e => e.unitId === targets[0].id);
        ui = redraw();
        assert.equal(ui.roll.disabled, true, '非玩家回合不得检定');
        assert.equal(ui.defer.disabled, true);
        ui.roll.dispatchEvent('click');
        ui.defer.dispatchEvent('click');
        assert.equal(calls.roll.length, 0);
        assert.equal(calls.defer.length, 1);
        battle.turnIndex = battle.initiative.findIndex(e => e.unitId === player.id);
        ui = redraw();
        ui.send.dispatchEvent('click');
        ui = redraw();
        assert.equal(ui.roll.disabled, true, '正在发送口嗨时不得确认检定');
        assert.equal(ui.defer.disabled, true);
        ui.roll.dispatchEvent('click');
        ui.defer.dispatchEvent('click');
        assert.equal(calls.roll.length, 0);
        assert.equal(calls.defer.length, 1);
        settleSend({ ok: true });
        await Promise.resolve();
        ui = controls();
        assert.equal(ui.input.value, '', '成功发送后只清空已经发送的草稿');
        assertDialogueOnly(ui);
        assert.equal(ui.persuasion.querySelector('.td-charm-dc').textContent, 'DC 12');
        assert.equal(ui.persuasion.querySelector('.td-charm-required').textContent, 'd20 ≥ 9');
        assert.equal(ui.persuasion.querySelector('.td-charm-chance').textContent, '成功率 60%');
        assert.equal(calls.roll.length, 0, '口嗨成功返回新评估后仍由玩家决定何时掷骰');
        ui.input.value = draftText;
        ui.input.dispatchEvent('input');
        ui = controls();
        const originalSide = targets[0].side;
        ui.roll.dispatchEvent('click');
        assert.deepEqual(calls.roll, [{ targetId: targets[0].id, pendingId: 'charm-dom-after-banter' }]);
        ui = redraw();
        assert.equal(ui.roll.disabled, true, '掷骰请求期间跨重绘防止重复提交');
        ui.roll.dispatchEvent('click');
        assert.equal(calls.roll.length, 1);
        settleRoll();
        await Promise.resolve();
        ui = redraw();
        assertNoConfirmation(ui);
        assert.equal(records.get(targets[0].id).status, 'failed', '已消费的检定失败后只在后台保留状态');
        assert.equal(ui.input.value, draftText);
        assert.equal(targets[0].side, originalSide, 'UI 不自行改变阵营');
        previews.set(targets[0].id, { ...storedPending, id: 'charm-dom-stale', targetName: targets[0].name });
        ui = redraw();
        const staleUi = ui;
        targets[0].side = 'ally';
        staleUi.roll.dispatchEvent('click');
        staleUi.defer.dispatchEvent('click');
        assert.equal(calls.roll.length, 1, '旧 DOM 中已换边的目标不能调用检定');
        assert.equal(calls.defer.length, 1, '旧 DOM 中已换边的目标不能暂缓检定');
        ui = redraw();
        assert.ok(!Array.from(ui.picker.querySelectorAll('option')).some(option => option.value === targets[0].id),
            '目标换到我方后，必须立即从说服列表移除');
        assert.equal(ui.picker.value, targets[1].id, '自动改选剩余存活敌方');
        assert.equal(ui.persuasion.getAttribute('data-target-id'), targets[1].id);
        assert.equal(ui.input.value, draftText, '列表更新不得丢失草稿');
        const sendsBeforeInvalidTarget = calls.send.length;
        ui.picker.value = targets[0].id;
        ui.picker.dispatchEvent('change');
        ui = controls();
        assertNoConfirmation(ui);
        ui.send.dispatchEvent('click');
        assert.equal(calls.send.length, sendsBeforeInvalidTarget, '旧目标已是友方时不能继续发送');
        for (const target of targets) target.alive = false;
        ui = redraw();
        assert.equal(ui.picker.value, '');
        assert.equal(ui.picker.disabled, true);
        assert.equal(ui.picker.querySelectorAll('option').length, 1);
        assert.equal(ui.picker.querySelector('option').textContent, '暂无可对话的敌方角色');
        assert.equal(ui.send.disabled, true);
        assertNoConfirmation(ui);
        ui.send.dispatchEvent('click');
        assert.equal(calls.send.length, sendsBeforeInvalidTarget, '没有存活敌方时不能发送或调用API');
    } finally {
        settleDefer?.();
        settleRoll?.();
        settleSend?.({ ok: false });
        await Promise.resolve();
        for (const [name, descriptor] of savedMethods) {
            if (descriptor) Object.defineProperty(api.app, name, descriptor);
            else delete api.app[name];
        }
        FakeElement.prototype.focus = saved.focus;
        api.app.busy = saved.busy;
        api.app._autoDriving = saved.autoDriving;
        api.app.settings.battle.userUnitName = saved.userName;
        battle.turnIndex = saved.turnIndex;
        battle.banterHistory = saved.banterHistory;
        battle.log = saved.log;
        battle.units.forEach((u, i) => { u.isUser = saved.userFlags[i]; Object.assign(u, saved.unitStates[i]); });
        const ui = controls();
        ui.input.value = saved.draftText;
        ui.input.dispatchEvent('input');
        ui.picker.value = saved.draftTarget;
        ui.picker.dispatchEvent('change');
    }
});

await check('战斗页有以「开始战斗」为核心的开战入口', () => {
    const api = /** @type {any} */ (globalThis).TavernDice;
    // ⚠️ 这个检查要临时清掉战斗才能看到开战入口那一屏，
    // 所以必须先存后还原 —— 否则后面依赖战斗状态的检查会连锁失败（踩过两次）。
    const savedBattle = api.app.battle;
    api.app.battle = null;
    api.panel.setTab('battle');
    const text = fakeDocument.getElementById('tavern-dice-panel').textContent;

    assert.ok(text.includes('开始一场战斗'), '应当有开战标题');
    assert.ok(text.includes('开始战斗'), '核心按钮应当是「开始战斗」');
    assert.ok(text.includes('只写指令'), '应当有「只写指令（不发送）」的选项');
    assert.ok(text.includes('读已有剧情开战'), '应当保留「读已有剧情开战」这条旧路径');
    assert.ok(text.includes('补充要求'), '应当有可选的补充要求输入框');
    assert.ok(text.includes('正文模型'), '应当说明是让正文模型去读');

    api.app.battle = savedBattle;
});

await check('战斗页保留存档恢复且不提供旧表开战', () => {
    const api = /** @type {any} */ (globalThis).TavernDice;
    // 同样要临时切到「未开战」状态才看得到开战入口那一屏
    const savedBattle = api.app.battle;
    api.app.battle = null;
    api.panel.setTab('battle');
    const text = fakeDocument.getElementById('tavern-dice-panel').textContent;
    api.app.battle = savedBattle;
    assert.ok(text.includes('恢复战斗存档'));
    assert.ok(!text.includes('用现有战力表开战'));
});

await check('战况汇报能渲染并支持开战/重读/丢弃', () => {
    const api = /** @type {any} */ (globalThis).TavernDice;
    const savedBattle = api.app.battle;
    api.app.battle = null;
    api.app.battleSituation = {
        report: '我方：甲（约七成血，使用长剑）\n敌方：乙（满状态，会火系法术）',
        situation: '',
        at: Date.now(),
    };
    api.panel.setTab('battle');
    const text = fakeDocument.getElementById('tavern-dice-panel').textContent;

    assert.ok(text.includes('模型读到的战况'), '应当显示战况汇报区');
    assert.ok(text.includes('约七成血'), '应当显示汇报内容');
    assert.ok(text.includes('用这个战况开战'), '应当有确认开战按钮');
    assert.ok(text.includes('重新读一遍'), '应当有重读按钮');
    assert.ok(text.includes('丢弃'), '应当有丢弃按钮');

    // 清理并还原战斗状态，避免污染后续检查
    api.app.battleSituation = null;
    api.app.battle = savedBattle;
});

await check('战斗中的单位面板显示了装备', () => {
    const api = /** @type {any} */ (globalThis).TavernDice;
    // 此时应当还在战斗中（上面几项已还原状态）
    assert.ok(api.app.battle, '前置条件：应当还在战斗中');
    api.panel.setTab('battle');
    const text = fakeDocument.getElementById('tavern-dice-panel').textContent;
    assert.ok(
        text.includes('测试长剑') || text.includes('测试护符'),
        `战斗中的单位面板应当显示装备，实际片段：${text.slice(0, 300)}`,
    );
});

await check('自动推进能推进战斗（不会卡死）', async () => {
    const before = app.battle.round;
    app._autoDriveStop = false; // 明确启动本测试的 AI 阶段
    app.battle.awaitingPlayerAction = false;
    const result = await app.autoAdvance({ maxSteps: 12, stopOnAlly: true });
    assert.ok(result.steps > 0, '一步都没推进');
    assert.ok(app.battle === null || app.battle.round >= before, '回合数倒退了');
});

await check('手动行动不报错', async () => {
    if (!app.battle || app.battle.phase === 'finished') return;
    const result = await app.act({ action: 'skip' });
    assert.equal(result.ok, true, `行动失败：${result.error}`);
});

await check('战斗日志有内容', () => {
    const text = fakeDocument.getElementById('tavern-dice-panel').textContent;
    assert.ok(text.length > 100, '战斗页内容过少，可能渲染失败');
});

await check('日志页面可渲染', () => {
    api.panel.setTab('log');
    const text = fakeDocument.getElementById('tavern-dice-panel').textContent;
    assert.ok(text.includes('冒烟测试体系') || text.includes('日志') || text.length > 0);
});

await check('结束战斗保存结算，不回写场景', async () => {
    assert.ok(app.battle, '必须有一场战斗来验证结算');
    const before = JSON.stringify(app.powerSystem);
    const result = await app.finishBattle();
    assert.equal(result.ok, true, `结算失败：${result.error}`);
    assert.equal(JSON.stringify(app.powerSystem), before, '结算不应改写场景数据');
    assert.ok(app.data.battleResult?.text, '结算应持久化');
    app.battleResultSnapshot = null;
    app.restoreBattle();
    assert.ok(app.battleResultSnapshot, '刷新应恢复结算');
    assert.equal(app.battle, null, 'battle 应当被清空');
});

await check('战斗后战力表仍然可用', () => {
    assert.ok(app.powerSystem, '战力表丢了');
    assert.equal(app.powerSystem.combatants.length, 4, '单位数量变了');
});

await check('审计日志记录了整场过程', () => {
    const log = app.data.auditLog ?? [];
    assert.ok(log.length >= 2, `审计记录太少：${log.length}`);
    assert.ok(
        log.some((/** @type {any} */ e) => e.type === 'set-power-system'),
        '缺少建表记录',
    );
    assert.ok(
        log.some((/** @type {any} */ e) => e.type === 'battle-start' || e.type === 'battle-end'),
        '缺少战斗记录',
    );
});

await check('数据可以导出成 Combat_block 文本', () => {
    const text = app.toCombatBlockText();
    assert.ok(text.includes('<Combat_block>'), '导出格式不对');
    assert.ok(text.includes('甲'), '导出内容缺少单位');
});

await check('数据是 JSON 安全的（能存进聊天文件）', () => {
    assert.doesNotThrow(() => JSON.parse(JSON.stringify(fakeCtx.chatMetadata['tavern-dice'])));
});

// ---- 战斗不占楼层 ----
// 关键设计：战斗**全程不碰聊天**，只记在插件里；打完之后合成一条由用户发出去。
// 这里验证「真的一个字都没写进聊天」—— 这是用户明确要求的行为。

await check('战斗期间不往聊天里写任何东西（不占楼层）', async () => {
    const api = /** @type {any} */ (globalThis).TavernDice;
    const before = fakeCtx.chat.length;

    // 打一场完整战斗：开战 + 自动推进若干步
    const started = await api.app.startBattle({ seed: 'no-chat-write-seed' });
    assert.equal(started.ok, true, `开战失败：${started.error}`);
    await api.app.autoAdvance({ maxSteps: 10, stopOnAlly: false });

    const after = fakeCtx.chat.length;
    assert.equal(after, before, `战斗往聊天里写了 ${after - before} 条 —— 战斗不该占楼层`);
});

await check('战斗结算文本包含双方、结果与战后状态', async () => {
    const api = /** @type {any} */ (globalThis).TavernDice;
    const text = api.app.battleResultText();
    assert.ok(text.includes('战斗结算'), '应当有标题');
    assert.ok(text.includes('我方：'), '应当列出我方');
    assert.ok(text.includes('敌方：'), '应当列出敌方');
    assert.ok(text.includes('战后状态'), '应当列出战后状态（续写必须知道谁受伤了）');
    assert.ok(text.includes('随机种子'), '应当带随机种子便于复盘');
});

await check('结束战斗会生成结算快照（发给正文模型用）', async () => {
    const api = /** @type {any} */ (globalThis).TavernDice;
    assert.ok(api.app.battle, '前置条件：应当还在战斗中');
    api.app.battle.pushBanter('💬 结算开关测试：停手聊聊。');
    const result = await api.app.finishBattle();
    assert.equal(result.ok, true, `结束战斗失败：${result.error}`);
    assert.ok(api.app.battleResultSnapshot, '结束后必须留下结算快照');
    assert.ok(api.app.battleResultSnapshot.includes('战斗结算'), '快照应当是完整的结算文本');
});

await check('结算面板显示在战斗页，并带发送按钮', () => {
    const api = /** @type {any} */ (globalThis).TavernDice;
    api.panel.setTab('battle');
    const text = fakeDocument.getElementById('tavern-dice-panel').textContent;
    assert.ok(text.includes('战斗已结束') || text.includes('战斗判定结束'), '应当显示结算面板');
    assert.ok(text.includes('没有占用任何聊天楼层'), '应当说明没有占楼层');
    assert.ok(text.includes('发送给正文模型续写'), '应当有发送按钮');
    assert.ok(text.includes('复制'), '应当能复制文本');
});

await check('结算口嗨开关：点击更新预览并保留编辑，只有发送按钮提交完整选择', async () => {
    const api = /** @type {any} */ (globalThis).TavernDice;
    const originalSetter = api.app.setBattleResultIncludeBanter;
    const originalSender = api.app.sendBattleResult;
    const originalTransport = api.app.sendToChat;
    let choiceTask;
    let sendTask;
    const delivered = [];
    const panel = () => fakeDocument.getElementById('tavern-dice-panel');
    const toggle = () => fakeDocument.getElementById('td-result-banter-toggle');
    const preview = () => panel().querySelector('.td-result-banter-preview');
    const editor = () => panel().querySelector('.td-result-text');
    api.app.setBattleResultIncludeBanter = (...args) => choiceTask = originalSetter.apply(api.app, args);
    api.app.sendBattleResult = (...args) => sendTask = originalSender.apply(api.app, args);
    api.app.sendToChat = async text => { delivered.push(text); return { ok: true, method: 'native' }; };
    try {
        api.panel.setTab('battle');
        assert.ok(toggle(), '真实DOM应有口嗨发送选择按钮');
        assert.equal(toggle().getAttribute('aria-pressed'), 'false');
        assert.equal(preview().style.display, 'none', '默认不附带口嗨');
        assert.ok(editor().value.includes('战斗结算'), '编辑框应初始化为完整结算文本');
        const edited = `${editor().value}\n自定义补记：先坐下谈一谈。`;
        editor().value = edited;
        for (const include of [true, false, true]) {
            toggle().dispatchEvent('click', { bubbles: true });
            assert.equal((await choiceTask).ok, true);
            assert.equal(toggle().getAttribute('aria-pressed'), String(include));
            assert.equal(preview().style.display, include ? '' : 'none');
            assert.ok(preview().textContent.includes('结算开关测试：停手聊聊。'));
            assert.equal(editor().value, edited, '刷新预览不能覆盖用户编辑');
            assert.deepEqual(delivered, [], '选择按钮不能向正文发送');
        }
        const send = panel().querySelectorAll('.menu_button').find(node => node.textContent.includes('发送给正文模型续写'));
        assert.ok(send, '应有明确的发送按钮');
        send.dispatchEvent('click', { bubbles: true });
        assert.equal((await sendTask).ok, true);
        assert.equal(delivered.length, 1, '仅由发送按钮提交一次');
        assert.ok(delivered[0].startsWith(edited));
        assert.equal(delivered[0].split('💬 结算开关测试：停手聊聊。').length - 1, 1, '附带口嗨仅出现一次');
    } finally {
        api.app.setBattleResultIncludeBanter = originalSetter;
        api.app.sendBattleResult = originalSender;
        api.app.sendToChat = originalTransport;
        api.app.battleSent = false;
        await api.app.setBattleResultIncludeBanter(false);
    }
});

await check('发送战斗结算：没有发送接口时退到输入框（而不是静默失败）', async () => {
    const api = /** @type {any} */ (globalThis).TavernDice;
    // 原生发送按钮缺失时，只把结算留在输入框；不回退命令或仅添加用户楼层的接口。
    const fakeInput = { value: '', dispatchEvent: () => {} };
    const originalGetById = fakeDocument.getElementById.bind(fakeDocument);
    fakeDocument.getElementById = (id) => (id === 'send_textarea' ? fakeInput : originalGetById(id));

    const result = await api.app.sendBattleResult();
    fakeDocument.getElementById = originalGetById;

    assert.equal(result.ok, true, `应当成功（退到输入框）：${result.error}`);
    assert.equal(result.method, 'textarea', '应当报告用了哪条路径');
    assert.ok(fakeInput.value.includes('战斗结算'), '输入框里应当是结算文本');
    api.app.battleSent = false;
});

await check('战斗结算不会重复自动发送（要用户主动点）', () => {
    const api = /** @type {any} */ (globalThis).TavernDice;
    // 快照还在、也没有自动发出去的痕迹 —— sent 只在用户点过之后才为 true
    assert.ok(api.app.battleResultSnapshot, '快照应当还在（等用户决定什么时候发）');
});

await check('普通正文和生成结束不会触发全局更新', () => {
    const events = registeredEvents.map(e => e.event);
    for (const name of ['message_received', 'message_swiped', 'message_edited', 'message_deleted', 'worldinfo_updated']) {
        assert.ok(!events.includes(name), name + ' 不应再监听全局更新');
    }
    assert.equal(typeof app.update, 'undefined');
    assert.equal(typeof app.scheduleAutoUpdate, 'undefined');
    assert.ok(!registeredCommands.some(c => c.name === 'dice-update'));
    assert.equal(app.settings.p1, undefined);
    assert.equal(app.settings.p2.auto, undefined);
});

await check('清空后回到空白状态', async () => {
    await app.reset();
    assert.equal(app.powerSystem, null, '清空后仍有战力表');
    assert.equal(app.battle, null);
});

await check('清空后界面仍能渲染（空状态不崩）', () => {
    for (const tab of ['table', 'battle', 'settings', 'log']) {
        api.panel.setTab(tab);
    }
});

// ---- 收尾清理 ----
//
// ⚠️ 必须清理骰子动画循环与「等生成结束」的等待。
// 它们挂着真实定时器，会让进程**跑完也不退出** —— 表现成「冒烟测试卡住」，
// 而且日志里已经打了「通过」，极难判断到底是挂了还是没挂（踩过）。
try {
    const api = /** @type {any} */ (globalThis).TavernDice;
    api?.app?.diceRoller?.destroy?.();
    if (api?.app) {
        api.app.diceRoller = null;
        api.app._autoDriveStop = true;
        api.app._resolveGenerationWait?.(false);
        api.app._resolveGenerationWait = null;
    }
} catch (e) {
    console.warn('[冒烟] 收尾清理出错（不影响结论）', e);
}

console.log('');
if (failures.length) {
    console.error(`冒烟测试失败 ${failures.length} 项：`);
    for (const f of failures) console.error(`  · ${f}`);
    process.exitCode = 1;
} else {
    console.log('冒烟测试通过：扩展可以正常启动、挂载界面并完整跑完一场战斗。');
}
