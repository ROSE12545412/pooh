import test from 'node:test';
import assert from 'node:assert/strict';
import { renderLoadout } from '../src/ui/loadout.js';

class Element {
    constructor(tag) {
        this.nodeType = 1; this.tagName = tag; this.children = []; this.attributes = {}; this.handlers = {};
        this.value = ''; this.checked = false; this.disabled = false;
        this.classList = { add: (...classes) => { this.classes = [...(this.classes || []), ...classes]; } };
    }
    setAttribute(key, value) { this.attributes[key] = value; if (key === 'id') this.id = value; }
    appendChild(child) { this.children.push(child); return child; }
    addEventListener(type, handler) { (this.handlers[type] ||= []).push(handler); }
    get textContent() { return this.children.map(child => child.textContent).join(''); }
    set textContent(value) { this.children = [{ textContent: value }]; }
    fire(type) { for (const handler of this.handlers[type] || []) handler({ preventDefault() {}, stopPropagation() {} }); }
}
function nodes(root) { return [root, ...(root.children || []).flatMap(nodes)]; }
function byId(root, id) { return nodes(root).find(node => node.id === id); }
function choices(root) { return nodes(root).filter(node => node.classes?.includes('td-loadout-refine-choice')); }
function carries(root) { return nodes(root).filter(node => node.classes?.includes('td-loadout-carry')); }
function action(root, text) { return nodes(root).find(node => node.attributes?.role === 'button' && node.textContent === text); }
async function settle() { await new Promise(resolve => setImmediate(resolve)); }

function harness(t) {
    const original = globalThis.document;
    globalThis.document = { createElement: tag => new Element(tag), createTextNode: text => ({ nodeType: 3, nodeName: '#text', textContent: text }) };
    t.after(() => { if (original === undefined) delete globalThis.document; else globalThis.document = original; });
    const calls = [];
    const app = {
        busy: false, settings: { loadout: { contextMessages: 10 } },
        loadoutEntries: [
            { id: 'a', kind: 'skill', name: '甲', description: '甲描述', enabled: false },
            { id: 'b', kind: 'weapon', name: '乙', description: '乙描述', enabled: true },
        ],
        refineLoadout: async ids => { calls.push(ids); return { ok: true }; },
        deleteLoadout: async id => { app.loadoutEntries = app.loadoutEntries.filter(entry => entry.id !== id); return { ok: true }; },
        setLoadoutEnabled: async () => { throw new Error('润色选择不应改变携带设置'); },
    };
    let root;
    const helpers = { rerender: () => { root = renderLoadout(app, helpers); } };
    helpers.rerender();
    return { app, calls, render: helpers.rerender, get root() { return root; } };
}

test('loadout UI: independent selection persists across renders and sends one or multiple IDs', async t => {
    const h = harness(t);
    assert.equal(byId(h.root, 'td-loadout-refine-selected').attributes['aria-disabled'], 'true');
    choices(h.root)[0].checked = true;
    choices(h.root)[0].fire('change');
    assert.equal(choices(h.root)[0].checked, true);
    assert.equal(carries(h.root)[0].checked, false);
    assert.equal(carries(h.root)[1].checked, true);
    assert.equal(byId(h.root, 'td-loadout-refine-selected').textContent, '发送所选给正文润色（1）');
    byId(h.root, 'td-loadout-refine-selected').fire('click');
    await settle();
    assert.deepEqual(h.calls, [['a']]);
    action(h.root, '正文润色并回填').fire('click');
    await settle();
    assert.equal(h.calls[1], 'a');
    byId(h.root, 'td-loadout-select-all').fire('click');
    byId(h.root, 'td-loadout-refine-selected').fire('click');
    await settle();
    assert.deepEqual(h.calls[2], ['a', 'b']);
    assert.ok(h.root.textContent.includes('成功回填后自动清理'));
    assert.ok(!h.root.textContent.includes('不占聊天楼层'));
    byId(h.root, 'td-loadout-select-clear').fire('click');
    assert.ok(choices(h.root).every(choice => !choice.checked));
    assert.equal(byId(h.root, 'td-loadout-refine-selected').attributes['aria-disabled'], 'true');
});

test('loadout UI: busy disables editor and selection, deleted IDs are pruned, sessions are isolated', async t => {
    const h = harness(t);
    byId(h.root, 'td-loadout-select-all').fire('click');
    h.app.busy = true; h.render();
    assert.ok(choices(h.root).every(choice => choice.disabled));
    for (const id of ['td-loadout-name', 'td-loadout-description', 'td-loadout-kind']) assert.equal(byId(h.root, id).disabled, true);
    for (const id of ['td-loadout-select-all', 'td-loadout-select-clear', 'td-loadout-refine-selected']) assert.equal(byId(h.root, id).attributes['aria-disabled'], 'true');
    byId(h.root, 'td-loadout-refine-selected').fire('click');
    assert.deepEqual(h.calls, []);
    h.app.busy = false; h.render();
    action(h.root, '删除').fire('click');
    await settle();
    assert.equal(byId(h.root, 'td-loadout-refine-selected').textContent, '发送所选给正文润色（1）');
    byId(h.root, 'td-loadout-refine-selected').fire('click');
    await settle();
    assert.deepEqual(h.calls, [['b']]);
    h.app.loadoutEntries = []; h.render();
    assert.equal(byId(h.root, 'td-loadout-refine-selected').textContent, '发送所选给正文润色（0）');
    const other = { ...h.app, loadoutEntries: [{ id: 'b', kind: 'skill', name: '乙', description: '', enabled: false }] };
    assert.equal(choices(renderLoadout(other, { rerender() {} }))[0].checked, false);
});
