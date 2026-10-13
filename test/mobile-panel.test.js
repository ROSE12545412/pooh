import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { MainPanel, panelGeometry } from '../src/ui/panel.js';

const desktop = { x: 1800, y: 900, w: 900, h: 640 };
const within = (g, width, height, x = 0, y = 0) => {
    assert.ok(g.x >= x && g.y >= y);
    assert.ok(g.x + g.w <= x + width);
    assert.ok(g.y + g.h <= y + height);
};
function style() {
    const priorities = {};
    return { priorities, setProperty(key, value, priority) { this[key] = value; priorities[key] = priority; },
        removeProperty(key) { delete this[key]; delete priorities[key]; } };
}
function panel() {
    const node = { style: style(), dataset: {} };
    return { embedded: false, shell: node, app: { settings: { panelRect: { ...desktop } }, persistSettings() { throw Error('viewport must not persist'); } } };
}
describe('手机面板可用视口几何', () => {
    it('横屏矮视口不因桌面最小高度溢出', () => {
        const g = panelGeometry({ w: 880, h: 620 }, { width: 800, height: 280 });
        assert.equal(g.mobile, false); assert.equal(g.h, 260); within(g, 800, 280);
    });
    it('用户手机占屏比例居中生效并限制合法范围', () => {
        const full = panelGeometry({}, { width: 375, height: 700 });
        const small = panelGeometry({ mobileScale: 0.75 }, { width: 375, height: 700 });
        assert.equal(small.w, full.w * 0.75); assert.equal(small.h, full.h * 0.75);
        assert.equal(small.x, (375 - small.w) / 2); within(small, 375, 700);
        assert.equal(panelGeometry({ mobileScale: 2 }, { width: 375, height: 700 }).w, full.w);
        assert.equal(panelGeometry({ mobileScale: 0 }, { width: 375, height: 700 }).w, full.w * 0.6);
        assert.equal(panelGeometry({ w: 700, h: 500, mobileScale: 0.6 }, { width: 1200, height: 900 }).w, 700);
    });
    it('320/375/600手机不受桌面保存尺寸和坐标影响且留安全边距', () => {
        for (const width of [320, 375, 600]) {
            const g = panelGeometry(desktop, { width, height: 700 });
            assert.equal(g.mobile, true); within(g, width, 700);
            assert.equal(g.x, 8); assert.equal(g.y, 8); assert.equal(g.w, width - 16);
        }
        assert.deepEqual(desktop, { x: 1800, y: 900, w: 900, h: 640 });
    });
    it('键盘visualViewport高度和偏移缩小可用区域，关闭恢复而不改设置', () => {
        const original = globalThis.window;
        globalThis.window = { innerWidth: 390, innerHeight: 844, visualViewport: { width: 390, height: 320, offsetTop: 190, offsetLeft: 0 } };
        try {
            const p = panel();
            MainPanel.prototype.applyStoredGeometry.call(p);
            assert.equal(p.shell.style.top, '198px'); assert.equal(p.shell.style.height, '304px');
            assert.equal(p.shell.style.priorities.height, 'important');
            assert.equal(p.shell.style['min-width'], '0px');
            window.visualViewport.height = 844; window.visualViewport.offsetTop = 0;
            MainPanel.prototype.applyStoredGeometry.call(p);
            assert.equal(p.shell.style.height, '828px'); assert.equal(p.shell.style.top, '8px');
            assert.deepEqual(p.app.settings.panelRect, desktop);
        } finally { globalThis.window = original; }
    });
    it('视觉视口左右偏移、极小区域、无visualViewport均可用', () => {
        const g = panelGeometry({}, { width: 600, height: 700, visualViewport: { width: 300, height: 180, offsetLeft: 20, offsetTop: 150 } });
        within(g, 300, 180, 20, 150);
        within(panelGeometry({}, { width: 10, height: 9 }), 10, 9);
        within(panelGeometry({}, { width: 375, height: 500, visualViewport: { height: 0, width: NaN } }), 375, 500);
    });
    it('旋转和回到桌面重算并移除手机重要样式，桌面尺寸保持', () => {
        const original = globalThis.window;
        try {
            const p = panel();
            globalThis.window = { innerWidth: 375, innerHeight: 700 };
            MainPanel.prototype.applyStoredGeometry.call(p);
            window.innerWidth = 600; window.innerHeight = 375;
            MainPanel.prototype.applyStoredGeometry.call(p);
            assert.equal(p.shell.style.height, '359px');
            window.innerWidth = 1400; window.innerHeight = 1000;
            MainPanel.prototype.applyStoredGeometry.call(p);
            assert.equal(p.shell.style.width, '900px'); assert.equal(p.shell.style.height, '640px');
            assert.equal(p.shell.style.priorities.width, ''); assert.equal(p.shell.style['min-width'], undefined);
            assert.equal(p.shell.dataset.mobile, '0'); within(panelGeometry(desktop, { width: 1400, height: 1000 }), 1400, 1000);
        } finally { globalThis.window = original; }
    });
    it('resize/旋转/visualViewport事件重算且destroy清理监听', () => {
        const original = globalThis.window, originalBuild = MainPanel.prototype._build;
        const events = () => ({ listeners: new Map(), addEventListener(type, fn) { this.listeners.set(type, fn); }, removeEventListener(type, fn) { if (this.listeners.get(type) === fn) this.listeners.delete(type); } });
        const host = Object.assign(events(), { innerWidth: 375, innerHeight: 700, visualViewport: Object.assign(events(), { width: 375, height: 700, offsetTop: 0 }) });
        globalThis.window = host;
        MainPanel.prototype._build = function () { this.shell = { style: style(), dataset: {}, removeEventListener() {}, remove() {} }; return this.shell; };
        try {
            const p = new MainPanel({ settings: { panelRect: { ...desktop } }, on() { return () => {}; } });
            host.listeners.get('resize')(); assert.equal(p.shell.style.height, '684px');
            host.visualViewport.height = 250; host.visualViewport.offsetTop = 100;
            host.visualViewport.listeners.get('resize')(); assert.equal(p.shell.style.top, '108px');
            host.visualViewport.listeners.get('scroll')();
            host.innerWidth = 600; host.visualViewport.width = 600;
            host.listeners.get('orientationchange')(); assert.equal(p.shell.style.width, '584px');
            p.destroy(); assert.equal(host.listeners.size, 0); assert.equal(host.visualViewport.listeners.size, 0);
        } finally { globalThis.window = original; MainPanel.prototype._build = originalBuild; }
    });
    it('嵌入模式完全不应用浮窗几何', () => {
        const p = panel(); p.embedded = true;
        MainPanel.prototype.applyStoredGeometry.call(p);
        assert.equal(p.shell.style.width, undefined);
    });
});
